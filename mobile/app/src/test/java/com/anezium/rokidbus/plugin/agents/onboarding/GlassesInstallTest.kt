package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.phone.GlassesApkMetadata
import com.anezium.rokidbus.phone.GlassesAppInstaller
import com.anezium.rokidbus.phone.InstallResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/** The bundled glasses app: the copy, the pinned metadata, and what each answer of the core's installer shows. */
@OptIn(ExperimentalCoroutinesApi::class)
class GlassesInstallTest {
    @get:Rule val temp = TemporaryFolder()

    private val bytes = "a glasses APK".toByteArray()
    private val info = GlassesAssetInfo(
        packageName = "io.github.debasishdebs.rokidcoder.glasses",
        versionCode = 10000L,
        sha256 = "ab".repeat(32),
        signerSha256 = "cd".repeat(32),
    )
    private val asset = object : BundledGlassesAsset {
        override val info get() = this@GlassesInstallTest.info
        override fun copyTo(target: File) = target.writeBytes(bytes)
    }
    private val pin = "ef".repeat(32)

    private class FakeInstaller : GlassesAppInstaller {
        var installed: Long? = null
        var result: InstallResult = InstallResult.Installed
        var hold: CompletableDeferred<Unit>? = null
        val calls = mutableListOf<Pair<File, GlassesApkMetadata>>()
        var copyBytes: ByteArray? = null
        var cancels = 0

        override suspend fun install(apk: File, expected: GlassesApkMetadata, onProgress: (Int) -> Unit): InstallResult {
            calls += apk to expected
            copyBytes = apk.readBytes()
            onProgress(0)
            onProgress(50)
            hold?.await()
            return result
        }

        override suspend fun installedVersion(): Long? = installed

        override fun cancel() {
            cancels += 1
        }
    }

    private fun controller(installer: GlassesAppInstaller, release: Boolean = true, pinned: String = pin) = GlassesInstallController(
        installer = installer,
        asset = asset,
        copyDir = temp.root.resolve("no_backup/glasses"),
        expected = expectedGlassesMetadata(info, "io.github.debasishdebs.rokidcoder.glasses", pinned = pinned, release = release),
        io = kotlinx.coroutines.Dispatchers.Unconfined,
    )

    @Test
    fun glasses_step_installs_bundled_apk_after_verification() = runTest {
        val installer = FakeInstaller()
        val install = controller(installer)
        install.install()

        val (file, expected) = installer.calls.single()
        assertEquals(temp.root.resolve("no_backup/glasses").canonicalPath, file.parentFile!!.canonicalPath)
        assertArrayEquals("the core gets the copied asset", bytes, installer.copyBytes)
        assertEquals(GlassesApkMetadata("io.github.debasishdebs.rokidcoder.glasses", 10000L, "ab".repeat(32), pin), expected)
        assertFalse("the copy goes afterwards", file.exists())
        assertEquals(GlassesInstallState.UpToDate, install.state.value)
    }

    @Test
    fun release_variant_pins_signer_from_properties_not_asset() {
        val release = expectedGlassesMetadata(info, "io.example.glasses", pinned = pin, release = true)
        assertEquals("the release pin, never glasses.json's signer", pin, release.signerSha256)
        assertEquals("io.example.glasses", release.packageName)

        val debug = expectedGlassesMetadata(info, "io.example.glasses", pinned = "", release = false)
        assertEquals("a debug build takes the asset's signer, which is not a pin", info.signerSha256, debug.signerSha256)

        try {
            expectedGlassesMetadata(info, "io.example.glasses", pinned = "", release = true)
            fail("a release with no pin must not fall back to the asset")
        } catch (_: IllegalStateException) {
        }
    }

    @Test
    fun install_states_follow_installed_version_and_results() = runTest {
        val installer = FakeInstaller()
        val install = controller(installer)

        val byVersion = listOf(null to GlassesInstallState.NotInstalled, 9999L to GlassesInstallState.UpdateAvailable,
            10000L to GlassesInstallState.UpToDate, 10001L to GlassesInstallState.NewerOnGlasses)
        for ((version, state) in byVersion) {
            installer.installed = version
            install.refresh()
            assertEquals("installedVersion $version", state, install.state.value)
        }

        val byResult = listOf(
            InstallResult.Installed to GlassesInstallState.UpToDate,
            InstallResult.AlreadyCurrent to GlassesInstallState.UpToDate,
            InstallResult.NewerOnGlasses to GlassesInstallState.NewerOnGlasses,
            InstallResult.Failed("The glasses did not install the app.") to GlassesInstallState.Failed("The glasses did not install the app."),
        )
        for ((result, state) in byResult) {
            installer.installed = 9999L
            install.refresh()
            installer.result = result
            install.install()
            assertEquals("$result", state, install.state.value)
        }

        // Cancelled is the state before the install.
        installer.installed = null
        install.refresh()
        installer.result = InstallResult.Cancelled
        install.install()
        assertEquals(GlassesInstallState.NotInstalled, install.state.value)

        assertTrue(GlassesInstallState.UpToDate.completesStep)
        assertTrue(GlassesInstallState.NewerOnGlasses.completesStep)
        assertFalse(GlassesInstallState.UpdateAvailable.completesStep)
    }

    @Test
    fun newer_on_glasses_is_left_with_warning() = runTest {
        val installer = FakeInstaller().apply { installed = 20000L }
        val install = controller(installer)
        install.refresh()
        assertEquals(GlassesInstallState.NewerOnGlasses, install.state.value)
        val view = OnboardingCopy.glassesApp(install.state.value)
        assertTrue(view.lines.any { "newer" in it })
        assertEquals("no install is offered over a newer app", null, view.action)
        assertTrue(installer.calls.isEmpty())
    }

    @Test
    fun failed_install_shows_error_and_retry() = runTest {
        val installer = FakeInstaller().apply { result = InstallResult.Failed("Connection to the glasses was lost.") }
        val install = controller(installer)
        install.install()
        val view = OnboardingCopy.glassesApp(install.state.value)
        assertTrue(view.lines.contains("Connection to the glasses was lost."))
        assertEquals("Retry", view.action)

        installer.result = InstallResult.Installed
        install.install()
        assertEquals(GlassesInstallState.UpToDate, install.state.value)
        assertEquals(2, installer.calls.size)
    }

    @Test
    fun leaving_mid_install_cancels() = runTest(UnconfinedTestDispatcher()) {
        val installer = FakeInstaller().apply { hold = CompletableDeferred() }
        val install = controller(installer)
        val job = launch { install.install() }
        assertEquals(GlassesInstallState.Installing(50), install.state.value)
        install.leave()
        assertEquals(1, installer.cancels)
        installer.result = InstallResult.Cancelled
        installer.hold!!.complete(Unit)
        job.join()
        assertEquals(GlassesInstallState.Checking, install.state.value)

        install.leave()
        assertEquals("leaving outside an install cancels nothing", 1, installer.cancels)
    }

    @Test
    fun onboarding_never_verifies_apks_itself() {
        val sources = File("src/main/java/com/anezium/rokidbus/plugin/agents/onboarding")
        assertTrue("the source tree is where this test thinks", sources.resolve("GlassesInstallController.kt").isFile)
        val banned = listOf("apksig", "ApkVerifier", "MessageDigest", "signingInfo", "GET_SIGNING_CERTIFICATES", "PackageInstaller")
        val offenders = sources.walkTopDown().filter { it.isFile && it.extension == "kt" }
            .flatMap { file -> banned.filter { it in file.readText() }.map { "${file.name}: $it" } }
            .toList()
        assertEquals(emptyList<String>(), offenders)
        val build = File("build.gradle.kts").readText()
        assertFalse("the app does not depend on apksig itself", Regex("""implementation\("com\.android\.tools\.build:apksig""").containsMatchIn(build))
    }
}
