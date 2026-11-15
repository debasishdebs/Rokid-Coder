package com.anezium.rokidbus.glasses

import android.content.Context
import android.content.ContextWrapper
import com.anezium.rokidbus.shared.GlassesClasses
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
class GlassesCoreIdentityTest {
    private val watchdogAsset = File("src/main/assets/${SelfArmConstants.WATCHDOG_ASSET}").readText()
    private val bridgeAsset = File("src/main/assets/${SelfArmConstants.BRIDGE_ASSET}").readText()
    private val ours = ROKID_CODER_PAIR
    private val oursService = "io.github.debasishdebs.rokidcoder.glasses/${GlassesClasses.ACCESSIBILITY_SERVICE}"

    @Test
    fun the_core_reads_identity_only_from_the_shell_config() {
        val config = GlassesCoreConfig.of(RuntimeEnvironment.getApplication())
        assertEquals(UPSTREAM_PAIR, config.identity)
        assertEquals("com.anezium.rokidbus.glasses", config.hubTarget.packageName)
        assertEquals(BusHubService::class.java.name, config.hubTarget.serviceClassName)
        assertEquals(ours.glassesApplicationId, GlassesCoreConfig(ours).hubTarget.packageName)
        assertEquals(GlassesClasses.ACCESSIBILITY_SERVICE, RokidBusAccessibilityService::class.java.name)
        assertEquals(GlassesClasses.SETUP_ENTRY_ACTIVITY, SetupEntryActivity::class.java.name)
        assertEquals(GlassesClasses.MAIN_ACTIVITY, MainActivity::class.java.name)
        val notAShell = object : ContextWrapper(RuntimeEnvironment.getApplication()) {
            override fun getApplicationContext(): Context = this
        }
        assertThrows(IllegalStateException::class.java) { GlassesCoreConfig.of(notAShell) }
    }

    @Test
    fun generated_scripts_and_commands_target_identity_ids() {
        // The upstream pair leaves the shipped assets exactly as they are.
        assertEquals(watchdogAsset, SelfArmScripts.renderWatchdog(watchdogAsset, UPSTREAM_PAIR))
        assertEquals(bridgeAsset, SelfArmScripts.renderBridgeIdentity(bridgeAsset, UPSTREAM_PAIR))

        val watchdog = SelfArmScripts.renderWatchdog(watchdogAsset, ours)
        assertTrue(watchdog.contains("\nPKG=\"io.github.debasishdebs.rokidcoder.glasses\"\n"))
        assertTrue(watchdog.contains("\nSVC=\"$oursService\"\n"))
        assertTrue(watchdog.contains("\nSVC_SHORT=\"$oursService\"\n"))
        val bridge = SelfArmScripts.renderBridgeIdentity(bridgeAsset, ours)
        assertTrue(
            bridge.contains("\nCHANNEL=\"/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files/cmd_bridge\"\n"),
        )
        assertTrue(bridge.contains("\nPACKAGE=\"io.github.debasishdebs.rokidcoder.glasses\"\n"))

        val commands = listOf(
            SelfArmSessionCommand.buildPrepare(ours, watchdog, bridge),
            SelfArmSessionCommand.buildArm(ours, restartWatchdog = false),
            SelfArmSessionCommand.buildArm(ours, restartWatchdog = true),
            SelfArmSessionCommand.buildHelperStatus(ours),
        )
        for (command in commands) {
            assertTrue(command.contains("PKG='io.github.debasishdebs.rokidcoder.glasses'\n"))
            assertTrue(command.contains("SVC='$oursService'\n"))
            assertTrue(command.contains("SVC_SHORT='$oursService'\n"))
        }
        for (generated in commands + listOf(watchdog, bridge)) assertNoUpstreamGlassesId(generated)

        assertEquals(oursService, SelfArmController.servicesWithNexusService(ours, null))
        assertFalse(SelfArmController.accessibilityRepairNeeded(ours, oursService, 1))
        assertTrue(
            SelfArmController.accessibilityRepairNeeded(
                ours,
                UPSTREAM_PAIR.flattenedGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE),
                1,
            ),
        )
        assertEquals(
            "/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files/cmd_bridge/manual_selfarm/watchdog.sh",
            SelfArmManualArmAssets.watchdogShellPath(ours),
        )
        assertEquals(
            "/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files/cmd_bridge/manual_selfarm/bridge.sh",
            SelfArmManualArmAssets.bridgeShellPath(ours),
        )
    }

    @Test
    fun rendering_refuses_an_asset_without_exactly_one_identity_line() {
        assertThrows(IllegalArgumentException::class.java) {
            SelfArmScripts.renderWatchdog(watchdogAsset.replace("\nSVC_SHORT=", "\nSVC_OTHER="), ours)
        }
        assertThrows(IllegalArgumentException::class.java) {
            SelfArmScripts.renderBridgeIdentity("$bridgeAsset\nPACKAGE=\"x.y\"\n", ours)
        }
    }

    /** The bridge's self-update from the APK must produce what the app itself renders. */
    @Test
    fun bridge_self_update_keeps_the_running_identity() {
        val secret = "ab".repeat(32)
        val installed = SelfArmCommandBridgeClient.renderBridgeScript(
            SelfArmScripts.renderBridgeIdentity(bridgeAsset, ours),
            secret,
        )
        val renderFunction = Regex("(?ms)^render_update_candidate\\(\\) \\{\n.*?^\\}\n").find(installed)?.value
            ?: error("The bridge has no render_update_candidate function")
        val variables = installed.lines().filter {
            it.startsWith("PLACEHOLDER=") || it.startsWith("SECRET=") ||
                it.startsWith("CHANNEL=") || it.startsWith("PACKAGE=")
        }
        val work = File.createTempFile("bridge-update", "").apply { delete(); mkdirs() }
        try {
            val candidate = File(work, "candidate").apply { writeText(bridgeAsset) }
            val harness = File(work, "harness.sh").apply {
                writeText(variables.joinToString("\n", postfix = "\n") + renderFunction + "render_update_candidate \"\$1\"\n")
            }
            val process = ProcessBuilder("sh", harness.path, candidate.path).redirectErrorStream(false).start()
            val output = process.inputStream.bufferedReader().readText()
            assertTrue(process.waitFor(30, TimeUnit.SECONDS))
            assertEquals(0, process.exitValue())
            assertEquals(installed, output)
        } finally {
            work.deleteRecursively()
        }
    }

    private fun assertNoUpstreamGlassesId(generated: String) {
        val bareId = Regex("com\\.anezium\\.rokidbus\\.glasses(?![.\\w])")
        assertFalse(generated, bareId.containsMatchIn(generated))
    }
}
