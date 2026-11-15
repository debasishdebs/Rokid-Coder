package com.anezium.rokidbus.glasses

import java.security.PrivateKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SelfArmControllerTest {
    private val testKey = AdbKeyMaterial(
        privateKey = object : PrivateKey {
            override fun getAlgorithm(): String = "RSA"
            override fun getFormat(): String = "PKCS#8"
            override fun getEncoded(): ByteArray = byteArrayOf()
        },
        publicKey = "test",
    )

    @Test
    fun nexusServiceIsOnlyAddedWhenMissing() {
        assertEquals(
            UPSTREAM_PAIR.selfArmAccessibilityService,
            SelfArmController.servicesWithNexusService(UPSTREAM_PAIR, null),
        )
        assertEquals(
            "other.service/.A:${UPSTREAM_PAIR.selfArmAccessibilityService}",
            SelfArmController.servicesWithNexusService(UPSTREAM_PAIR, "other.service/.A"),
        )
        assertEquals(
            "other.service/.A:${UPSTREAM_PAIR.selfArmAccessibilityService}",
            SelfArmController.servicesWithNexusService(
            UPSTREAM_PAIR,
                "other.service/.A:${UPSTREAM_PAIR.selfArmAccessibilityService}",
            ),
        )
        assertEquals(
            "other.service/.A:${UPSTREAM_PAIR.selfArmAccessibilityServiceShort}",
            SelfArmController.servicesWithNexusService(
            UPSTREAM_PAIR,
                "other.service/.A:${UPSTREAM_PAIR.selfArmAccessibilityServiceShort}",
            ),
        )
    }

    @Test
    fun repairIsOnlyNeededWhenNexusAccessibilitySettingsAreBroken() {
        assertFalse(SelfArmController.accessibilityRepairNeeded(UPSTREAM_PAIR, UPSTREAM_PAIR.selfArmAccessibilityService, 1))
        assertFalse(SelfArmController.accessibilityRepairNeeded(UPSTREAM_PAIR, UPSTREAM_PAIR.selfArmAccessibilityServiceShort, 1))
        assertTrue(SelfArmController.accessibilityRepairNeeded(UPSTREAM_PAIR, "other.service/.A", 1))
        assertTrue(SelfArmController.accessibilityRepairNeeded(UPSTREAM_PAIR, UPSTREAM_PAIR.selfArmAccessibilityService, 0))
    }

    @Test
    fun selfArmCommandsKeepPreparationAndArmSeparate() {
        val prepare = SelfArmController.buildPrepareCommand(
            UPSTREAM_PAIR,
            watchdogScript = "#!/system/bin/sh\necho watchdog\n",
            bridgeScript = "#!/system/bin/sh\necho bridge\n",
        )
        val arm = SelfArmController.buildArmCommand(UPSTREAM_PAIR, restartWatchdog = false)

        assertTrue(prepare.contains("pm grant \"\$PKG\" android.permission.WRITE_SECURE_SETTINGS"))
        assertTrue(prepare.contains("settings put secure enabled_accessibility_services"))
        assertTrue(prepare.contains("base64 -d > \"\$WATCHDOG\""))
        assertTrue(prepare.contains("base64 -d > \"\$BRIDGE\""))
        assertTrue(prepare.contains("setprop persist.adb.tcp.port -1"))
        assertFalse(prepare.contains("sh \"\$WATCHDOG\" start"))
        assertFalse(prepare.contains("setprop ctl.restart adbd"))
        assertTrue(arm.contains("sh \"\$WATCHDOG\" start"))
        assertTrue(arm.contains("sh \"\$BRIDGE\" start"))
        assertTrue(arm.contains("sh \"\$WATCHDOG\" repair"))
        assertFalse(arm.contains("setprop ctl.restart adbd"))
    }

    @Test
    fun stopRequiresVerifiedSentinel() {
        assertTrue(SelfArmController.stopCommandSucceeded("ROKID_NEXUS_STOP_RESULT watchdog=1\n"))
        assertFalse(SelfArmController.stopCommandSucceeded("ROKID_NEXUS_STOP_RESULT watchdog=0\n"))
    }

    @Test
    fun wifiCommandSelectionUsesOnlyFixedSvcLiterals() {
        val commands = mutableListOf<String>()
        val seam = WifiControlSeam(
            loadKey = { testKey },
            loopbackListening = { true },
            runShell = { command, _ ->
                commands += command
                AdbLoopbackClient.ShellResult(true, true, true, "")
            },
        )

        assertTrue(SelfArmController.setWifiEnabled(enabled = true, seam = seam))
        assertTrue(SelfArmController.setWifiEnabled(enabled = false, seam = seam))

        assertEquals(listOf("svc wifi enable", "svc wifi disable"), commands)
    }

    @Test
    fun wifiRequestGracefullyFailsWithoutKeyOrLoopback() {
        var shellCalls = 0
        val unavailableKey = WifiControlSeam(
            loadKey = { null },
            loopbackListening = { true },
            log = {},
            runShell = { _, _ ->
                shellCalls += 1
                AdbLoopbackClient.ShellResult(true, true, true, "")
            },
        )
        val unavailableLoopback = unavailableKey.copy(
            loadKey = { testKey },
            loopbackListening = { false },
        )

        assertFalse(SelfArmController.setWifiEnabled(enabled = true, seam = unavailableKey))
        assertFalse(SelfArmController.setWifiEnabled(enabled = false, seam = unavailableLoopback))
        assertEquals(0, shellCalls)
    }
}
