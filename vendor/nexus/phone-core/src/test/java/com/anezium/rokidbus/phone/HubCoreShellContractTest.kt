@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.content.ComponentName
import android.os.Process
import com.anezium.rokidbus.client.IBusCallback
import com.anezium.rokidbus.shared.BusConstants
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.plugin.PluginCapability
import com.anezium.rokidbus.shared.plugin.PluginDescriptor
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

/** The enabled gate, the revocation order and the hook contract (adr-cores.md §3.1.1, §3.5). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class HubCoreShellContractTest {
    private val events = CopyOnWriteArrayList<String>()
    private val threads = CopyOnWriteArrayList<String>()
    private val lockViolations = CopyOnWriteArrayList<String>()
    private var reenter = false
    private lateinit var harness: HubCoreHarness
    private val core get() = harness.core

    private val principal = PhonePluginPrincipal(
        packageName = "com.example.plugin",
        serviceComponent = ComponentName("com.example.plugin", "Plugin"),
        uid = Process.myUid(),
        signingDigestSha256 = "ab".repeat(32),
        descriptor = PluginDescriptor(
            id = "sample",
            displayName = "Sample",
            apiVersion = BusConstants.API_VERSION,
            requestedCapabilities = setOf(PluginCapability.SURFACES),
            receivePrefixes = listOf("/plugin/sample"),
            settingsActivity = null,
            launchable = true,
        ),
    )

    private val hooks = object : HubShellHooks {
        override fun admitPlugin(packageName: String, pluginId: String, uid: Int): PluginAdmission =
            PluginAdmission.Approved(principal, setOf(PluginCapability.SURFACES))

        override fun grantFor(principal: PhonePluginPrincipal): PluginGrantState =
            PluginGrantState.Approved(setOf(PluginCapability.SURFACES))

        override fun onPrincipalRevoking(key: PluginGrantKey) {
            record("revoking registered=${core.isPrincipalRegistered(principal)}")
        }

        override fun onRegistrationRemoved(principal: PhonePluginPrincipal?, reason: String, ownerStillConnected: Boolean) {
            record("removed:$reason:still=$ownerStillConnected")
            if (reenter) core.deliverLocal(BusEnvelope("/plugin/sample/ping"))
        }

        override fun onAuthorizationChanged(key: PluginGrantKey) = record("authorizationChanged")

        override fun onLinkState(state: Int, previous: Int) {
            record("linkState")
            if (reenter) core.sendRemote(BusEnvelope("/hub/probe-from-hook"))
        }

        override fun onRemote(envelope: BusEnvelope): Boolean {
            if (envelope.path != "/shell/remote") return false
            record("remote")
            if (reenter) {
                core.sendRemote(BusEnvelope("/hub/echo"))
                core.deliverLocal(BusEnvelope("/plugin/sample/echo"))
            }
            return true
        }

        override fun onLocal(envelope: BusEnvelope, sender: AuthorizedSender): Boolean {
            if (envelope.path != "/plugin/sample/shell") return false
            record("local")
            return true
        }
    }

    private fun record(event: String) {
        events += event
        threads += "$event@${Thread.currentThread().name}"
        for (name in listOf("sppLock", "speechBusLock")) {
            val lock = HubCore::class.java.getDeclaredField(name).apply { isAccessible = true }.get(core)
            if (Thread.holdsLock(lock)) lockViolations += "$event holds $name"
        }
    }

    private fun shellCore(): HubCoreHarness = HubCoreHarness(app = null, hooks = hooks).also { harness = it }

    private fun register(callback: IBusCallback = Callback()): IBusCallback {
        core.busBinder().registerPlugin("com.example.plugin", "sample", callback)
        return callback
    }

    private class Callback : IBusCallback.Stub() {
        val paths = CopyOnWriteArrayList<String>()
        override fun onMessage(path: String, id: String, payload: ByteArray) { paths += path }
        override fun onLinkState(state: Int) = Unit
        override fun onBinaryMessage(path: String, id: String, meta: ByteArray, data: ByteArray) { paths += path }
        override fun onGlassesAiButton(active: Boolean) = Unit
    }

    private fun sppThreads(): Set<Thread> = Thread.getAllStackTraces().keys.filter { it.name == "rokidbus-spp" }.toSet()

    // ---- Enabled gate (§3.1.1) ----

    @Test
    fun stop_turns_the_gate_off_before_releasing_the_radios() {
        HubCoreHarness().also { harness = it }.startLinked()
        var gateAtRelease: Boolean? = null
        harness.cxr.onDisconnect = { gateAtRelease = core.isEnabled }
        core.stop()
        assertEquals(false, gateAtRelease)
        assertFalse(core.isEnabled)
        // No key is offered once the gate is off, whatever the CXR identity says.
        val offer = HubCore::class.java.getDeclaredMethod("offerSppKeyForCurrentCxr", Long::class.javaPrimitiveType)
            .apply { isAccessible = true }
        val before = harness.cxr.frames.size
        offer.invoke(core, 1L)
        harness.settle()
        assertEquals(before, harness.cxr.frames.size)
    }

    @Test
    fun start_after_stop_reenables_the_same_spp_loop() {
        val existing = sppThreads()
        HubCoreHarness().also { harness = it }
        core.start()
        val loop = (sppThreads() - existing).single()
        core.stop()
        assertFalse(core.isEnabled)
        core.start()
        assertTrue(core.isEnabled)
        assertEquals(setOf(loop), sppThreads() - existing)
        assertTrue(loop.isAlive)
        core.close()
    }

    @Test
    fun close_ends_the_spp_loop_and_is_terminal() {
        val existing = sppThreads()
        HubCoreHarness().also { harness = it }
        core.start()
        val loop = (sppThreads() - existing).single()
        core.close()
        loop.join(5_000)
        assertFalse(loop.isAlive)
        assertThrows(IllegalStateException::class.java) { core.start() }
        core.close()
    }

    // ---- Revocation order (§3.5.3) ----

    @Test
    fun revoke_runs_shell_hook_then_core_clears_then_removes_registrations() {
        shellCore()
        register()
        events.clear()
        core.revokePrincipal(principal.grantKey())
        assertEquals(listOf("revoking registered=true", "removed:authorizationChanged:still=false"), events.toList())
        assertFalse(core.isPrincipalRegistered(principal))
    }

    @Test
    fun authorization_changed_notifies_link_state_after_shell_side_effects() {
        shellCore()
        register()
        events.clear()
        core.authorizationChanged(principal.grantKey())
        assertEquals(
            listOf(
                "revoking registered=true",
                "removed:authorizationChanged:still=false",
                "authorizationChanged",
                "linkState",
            ),
            events.toList(),
        )
    }

    @Test
    fun registration_removed_hook_runs_last_with_owner_still_connected() {
        shellCore()
        val first = register()
        val second = register()
        events.clear()
        core.busBinder().unregister(first)
        assertEquals(listOf("removed:unregister:still=true"), events.toList())
        assertTrue(core.isPrincipalRegistered(principal))
        core.busBinder().unregister(second)
        assertEquals("removed:unregister:still=false", events.last())
        assertFalse(core.isPrincipalRegistered(principal))
    }

    // ---- Hook threads and locks (§3.5.1) ----

    @Test
    fun hooks_run_on_their_documented_threads() {
        shellCore()
        core.start()
        Thread({ harness.cxr.linkUp() }, "cxr-callback").apply { start(); join() }
        Thread({ harness.cxr.inject(BusEnvelope("/shell/remote")) }, "reader").apply { start(); join() }
        register()
        Thread({ core.busBinder().send("/plugin/sample/shell", "id", "{}".toByteArray()) }, "binder")
            .apply { start(); join() }
        core.revokePrincipal(principal.grantKey())
        assertTrue(threads.any { it == "linkState@cxr-callback" })
        assertTrue("remote@reader" in threads)
        assertTrue("local@binder" in threads)
        assertTrue(threads.any { it.startsWith("revoking") && it.endsWith("@${Thread.currentThread().name}") })
    }

    @Test
    fun hooks_run_without_core_locks_and_may_reenter_routing() {
        shellCore()
        reenter = true
        core.start()
        val worker = Thread({
            harness.cxr.linkUp()
            harness.cxr.inject(BusEnvelope("/shell/remote"))
            val callback = Callback()
            core.busBinder().registerPlugin("com.example.plugin", "sample", callback)
            core.busBinder().unregister(callback)
        }, "reentry")
        worker.start()
        worker.join(5_000)
        assertFalse("a hook re-entering routing must not deadlock", worker.isAlive)
        assertTrue(events.containsAll(listOf("linkState", "remote", "removed:unregister:still=false")))
        assertTrue(lockViolations.isEmpty())
        assertTrue(harness.cxr.frames.any { it.path == "/hub/echo" })
    }
}
