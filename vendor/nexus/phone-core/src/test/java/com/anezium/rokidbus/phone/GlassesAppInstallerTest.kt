@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.android.apksig.ApkSigner
import com.example.cxrglobal.callbacks.IGlassAppCbk
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.GlobalScope
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/** The CXR installer and the one app slot it shares (adr-cores.md §3.6). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], manifest = Config.NONE, shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class GlassesAppInstallerTest {
    @get:Rule val temporaryFolder = TemporaryFolder()

    private val keyStore = KeyStore.getInstance("PKCS12").apply {
        resource("test-signers.p12").use { load(it, PASSWORD.toCharArray()) }
    }
    private val cxr = FakeCxrTransport().apply { serviceConnected = true }
    private val slot = GlassesAppSlot { cxr }
    @Volatile private var linkUp = true
    @Volatile private var wifi: () -> Boolean = { true }
    @Volatile private var announced: String? = null
    private val workDirectory by lazy { temporaryFolder.newFolder("work") }
    private val installer by lazy {
        CxrGlassesAppInstaller(
            slot = slot,
            link = { cxr },
            linkUp = { linkUp },
            wifiEnabled = { wifi() },
            sessionPackage = PACKAGE,
            workDirectory = { workDirectory },
            announcedVersionName = { announced },
        )
    }
    private val progress = CopyOnWriteArrayList<Int>()
    private val progressThreads = CopyOnWriteArrayList<String>()

    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    private fun installAsync(apk: File, expected: GlassesApkMetadata): Deferred<InstallResult> =
        GlobalScope.async(Dispatchers.IO, start = CoroutineStart.DEFAULT) {
            installer.install(apk, expected) { value ->
                progress += value
                progressThreads += Thread.currentThread().name
            }
        }

    private fun <T> await(deferred: Deferred<T>): T = runBlocking { withTimeout(10_000) { deferred.await() } }

    /** Waits for the [index]th CXR app call to be [call], then answers it. */
    private fun answer(index: Int, call: String, value: Boolean) {
        val callback = awaitCall(index, call)
        when {
            call == "query" -> callback.onQueryAppResult(value)
            call.startsWith("upload") -> callback.onInstallAppResult(value)
            else -> callback.onOpenAppResult(value)
        }
    }

    private fun awaitCall(index: Int, call: String): IGlassAppCbk {
        val deadline = System.currentTimeMillis() + 10_000
        while (cxr.appCalls.size <= index) {
            if (System.currentTimeMillis() > deadline) fail("no CXR app call #$index ($call); saw ${cxr.appCalls}")
            Thread.sleep(5)
        }
        assertTrue("call #$index was ${cxr.appCalls[index]}", cxr.appCalls[index].startsWith(call))
        return cxr.appCallbacks[index]
    }

    private fun uploads(): Int = cxr.appCalls.count { it.startsWith("upload") }

    private fun waitUntil(what: String, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) fail("timed out: $what")
            Thread.sleep(5)
        }
    }

    // ---- installer_verifies_before_every_push_and_reports_each_result ----

    @Test
    fun installer_verifies_before_every_push_and_reports_each_result() {
        val apk = signedApk()
        val expected = metadata(apk)

        // Installed: absent on the glasses, pushed, confirmed.
        val installed = installAsync(apk, expected)
        answer(0, "query", false)
        answer(1, "upload", true)
        assertEquals(InstallResult.Installed, await(installed))
        assertEquals(listOf(0, 25, 50, 100), progress.toList())

        // AlreadyCurrent and NewerOnGlasses: decided from the announced version, nothing pushed.
        announced = "1.5.0"
        val current = installAsync(apk, expected)
        answer(2, "query", true)
        assertEquals(InstallResult.AlreadyCurrent, await(current))
        announced = "1.6.0"
        val newer = installAsync(apk, expected)
        answer(3, "query", true)
        assertEquals(InstallResult.NewerOnGlasses, await(newer))
        assertEquals(1, uploads())

        // Refused by the glasses.
        announced = null
        val refused = installAsync(apk, expected)
        answer(4, "query", false)
        answer(5, "upload", false)
        assertEquals(InstallResult.Failed("The glasses did not install the app."), await(refused))

        // Every refusal before the push: no CXR call at all.
        val calls = cxr.appCalls.size
        val wrongSigner = await(installAsync(apk, expected.copy(signerSha256 = "ab".repeat(32))))
        assertEquals(InstallResult.Failed("Glasses APK signer does not match this phone build."), wrongSigner)
        val wrongPackage = await(installAsync(apk, expected.copy(packageName = "com.example.other")))
        assertEquals(InstallResult.Failed("Glasses APK package does not match this hub."), wrongPackage)
        val wrongVersion = await(installAsync(apk, expected.copy(versionCode = 10501)))
        assertEquals(InstallResult.Failed("Glasses APK version does not match the release."), wrongVersion)
        assertEquals(calls, cxr.appCalls.size)

        // The same file, changed after a successful install, is re-verified and refused.
        apk.appendBytes(byteArrayOf(0))
        val changed = await(installAsync(apk, expected))
        assertEquals(InstallResult.Failed("Glasses APK SHA-256 verification failed."), changed)
        assertEquals(calls, cxr.appCalls.size)
        assertEquals(2, uploads())

        // No Wi-Fi, or no CXR: refused after the query, before the push.
        wifi = { false }
        val fresh = signedApk()
        val noWifi = installAsync(fresh, metadata(fresh))
        answer(calls, "query", false)
        assertTrue((await(noWifi) as InstallResult.Failed).reason.startsWith("Turn on Wi-Fi first"))
        assertEquals(2, uploads())
        assertTrue(workDirectory.listFiles().orEmpty().isEmpty())
    }

    // ---- installer_cancel_stops_push ----

    @Test
    fun installer_cancel_stops_push() {
        val apk = signedApk()
        val expected = metadata(apk)

        val cancelled = installAsync(apk, expected)
        awaitCall(0, "query")
        installer.cancel()
        answer(0, "query", false)
        assertEquals(InstallResult.Cancelled, await(cancelled))
        assertEquals(0, uploads())

        val abandoned = installAsync(apk, expected)
        awaitCall(1, "query")
        abandoned.cancel()
        answer(1, "query", false)
        try {
            await(abandoned)
            fail("expected cancellation")
        } catch (_: CancellationException) {
        }
        assertEquals(0, uploads())

        // Once pushing, cancel() is ignored and the CXR result wins.
        val pushed = installAsync(apk, expected)
        answer(2, "query", false)
        awaitCall(3, "upload")
        installer.cancel()
        answer(3, "upload", true)
        assertEquals(InstallResult.Installed, await(pushed))
    }

    // ---- The CXR app slot (§3.6.1) ----

    @Test
    fun dispatch_completion_keeps_the_slot_for_the_next_dispatch() {
        val apk = signedApk()
        val install = installAsync(apk, metadata(apk))
        answer(0, "query", false)
        awaitCall(1, "upload")
        // The query's answer left the install holding the slot: a version query has to wait.
        val version = installedVersionAsync()
        Thread.sleep(100)
        assertFalse(version.isCompleted)
        assertEquals(1, workDirectory.listFiles().orEmpty().size)
        assertEquals(2, cxr.appCalls.size)
        answer(1, "upload", true)
        assertEquals(InstallResult.Installed, await(install))
        answer(2, "query", true)
        assertNull(await(version))
    }

    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    private fun installedVersionAsync(): Deferred<Long?> = GlobalScope.async(Dispatchers.IO) { installer.installedVersion() }

    @Test
    fun finish_during_dispatch_is_deferred_until_the_answer() {
        val apk = signedApk()
        val install = installAsync(apk, metadata(apk))
        answer(0, "query", false)
        awaitCall(1, "upload")
        install.cancel()
        Thread.sleep(100)
        assertNull("the slot outlives the cancelled waiter", slot.tryAcquire(GlassesAppSlot.Kind.QUERY))
        assertEquals(1, workDirectory.listFiles().orEmpty().size)
        answer(1, "upload", true)
        waitUntil("copy deleted") { workDirectory.listFiles().orEmpty().isEmpty() }
        val op = assertNotNullAndGet { slot.tryAcquire(GlassesAppSlot.Kind.QUERY) }
        op.finish()
    }

    @Test
    fun link_loss_completes_the_dispatch_and_the_owner_finishes_with_failed() {
        val apk = signedApk()
        val install = installAsync(apk, metadata(apk))
        answer(0, "query", false)
        awaitCall(1, "upload")
        assertEquals(1, workDirectory.listFiles().orEmpty().size)
        slot.failDispatched()
        assertEquals(InstallResult.Failed("Connection to the glasses was lost."), await(install))
        assertTrue(workDirectory.listFiles().orEmpty().isEmpty())
        assertNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY)?.also { it.finish() })
    }

    @Test
    fun finish_is_idempotent_and_cleanup_runs_once() {
        val runs = AtomicInteger()
        val op = requireNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY))
        op.onComplete { runs.incrementAndGet() }
        op.finish()
        op.finish()
        assertEquals(1, runs.get())
        assertNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY)?.also { it.finish() })
    }

    @Test
    fun stale_callback_of_a_completed_dispatch_is_dropped() {
        val op = requireNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY))
        val results = CopyOnWriteArrayList<GlassesAppSlot.DispatchResult<GlassesAppSlot.AppAnswer>>()
        slot.dispatchAsync(op, call = { cbk -> cxr.appIsInstalled(cbk) }) { results += it }
        slot.failDispatched()
        cxr.appCallbacks[0].onQueryAppResult(true)
        assertEquals(listOf<Any>(GlassesAppSlot.DispatchResult.LinkLost), results.toList())
        slot.dispatchAsync(op, call = { cbk -> cxr.appIsInstalled(cbk) }) { results += it }
        cxr.appCallbacks[0].onQueryAppResult(true)
        cxr.appCallbacks[1].onQueryAppResult(false)
        assertEquals(GlassesAppSlot.DispatchResult.Answered(GlassesAppSlot.AppAnswer(false)), results.last())
        assertEquals(2, results.size)
        op.finish()
    }

    @OptIn(kotlinx.coroutines.DelicateCoroutinesApi::class)
    @Test
    fun query_launch_and_third_party_upload_share_the_slot_fifo() {
        val query = requireNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY))
        val order = CopyOnWriteArrayList<String>()
        val acquired = CopyOnWriteArrayList<GlassesAppSlot.Op>()
        val waiters = mutableListOf<Deferred<GlassesAppSlot.Op>>()
        try {
            // UNDISPATCHED runs each coroutine on this thread up to the point where
            // acquire() enqueues its waiter and suspends, so the queue order is
            // launch, install by construction, with no timing involved.
            waiters += GlobalScope.async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
                slot.acquire(GlassesAppSlot.Kind.LAUNCH).also { acquired += it; order += "launch" }
            }
            waiters += GlobalScope.async(Dispatchers.IO, start = CoroutineStart.UNDISPATCHED) {
                slot.acquire(GlassesAppSlot.Kind.INSTALL).also { acquired += it; order += "install" }
            }
            assertNull(slot.tryAcquire(GlassesAppSlot.Kind.THIRD_PARTY_UPLOAD))
            query.finish()
            await(waiters[0]).finish()
            await(waiters[1]).finish()
            assertEquals(listOf("launch", "install"), order.toList())
        } finally {
            // Release whatever was acquired so a failed assertion cannot leave the
            // slot held; finish() is idempotent. Cancel waiters still queued.
            query.finish()
            acquired.forEach { it.finish() }
            waiters.forEach { it.cancel() }
        }
    }

    @Test
    fun third_party_upload_busy_returns_false() {
        val harness = HubCoreHarness()
        harness.core.start()
        harness.cxr.linkUp()
        val slotOfCore = HubCore::class.java.getDeclaredField("glassesAppSlot")
            .apply { isAccessible = true }.get(harness.core) as GlassesAppSlot
        val held = requireNotNull(slotOfCore.tryAcquire(GlassesAppSlot.Kind.QUERY))
        var answered = 0
        assertFalse(harness.core.uploadThirdPartyApk(temporaryFolder.newFile()) { answered++ })
        held.finish()
        assertTrue(harness.core.uploadThirdPartyApk(temporaryFolder.newFile()) { answered++ })
        harness.cxr.appCallbacks.last().onInstallAppResult(true)
        assertEquals(1, answered)
        harness.core.close()
    }

    @Test
    fun exception_while_acquired_finishes_the_operation_and_deletes_copy() {
        val apk = signedApk()
        wifi = { throw IllegalStateException("wifi probe failed") }
        val install = installAsync(apk, metadata(apk))
        answer(0, "query", false)
        try {
            await(install)
            fail("expected the failure to propagate")
        } catch (_: IllegalStateException) {
        }
        assertTrue(workDirectory.listFiles().orEmpty().isEmpty())
        assertNotNull(slot.tryAcquire(GlassesAppSlot.Kind.QUERY)?.also { it.finish() })
    }

    @Test
    fun progress_is_inline_monotonic_and_never_after_return() {
        val apk = signedApk()
        val install = installAsync(apk, metadata(apk))
        answer(0, "query", false)
        answer(1, "upload", true)
        await(install)
        val seen = progress.toList()
        assertEquals(listOf(0, 25, 50, 100), seen)
        Thread.sleep(50)
        assertEquals(seen, progress.toList())
    }

    // ---- fixtures ----

    private fun <T : Any> assertNotNullAndGet(get: () -> T?): T = requireNotNull(get())

    private fun metadata(apk: File) = GlassesApkMetadata(
        packageName = PACKAGE,
        versionCode = 10500,
        sha256 = MessageDigest.getInstance("SHA-256").digest(apk.readBytes())
            .joinToString("") { "%02x".format(it.toInt() and 0xff) },
        signerSha256 = signingCertificateSha256(certificate("current").encoded),
    )

    private fun signedApk(): File {
        val output = temporaryFolder.newFile()
        ApkSigner.Builder(listOf(ApkSigner.SignerConfig.Builder("current", key("current"), listOf(certificate("current"))).build()))
            .setInputApk(unsignedApk()).setOutputApk(output)
            .setV1SigningEnabled(false).setV2SigningEnabled(true)
            .setV3SigningEnabled(false).setV4SigningEnabled(false)
            .build().sign()
        return output
    }

    private fun unsignedApk() = temporaryFolder.newFile().apply {
        resource("unsigned.apk").use { input -> outputStream().use(input::copyTo) }
    }

    private fun resource(name: String) = requireNotNull(javaClass.getResourceAsStream("/glasses-apk/$name"))
    private fun key(alias: String) = keyStore.getKey(alias, PASSWORD.toCharArray()) as PrivateKey
    private fun certificate(alias: String) = keyStore.getCertificate(alias) as X509Certificate

    private companion object {
        const val PASSWORD = "test-only"
        const val PACKAGE = "com.anezium.rokidbus.glasses"
    }
}
