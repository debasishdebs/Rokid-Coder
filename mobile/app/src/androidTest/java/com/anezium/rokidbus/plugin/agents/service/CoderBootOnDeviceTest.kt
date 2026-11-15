package com.anezium.rokidbus.plugin.agents.service

import android.Manifest
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On a rooted emulator image (`adb root` first): BOOT_COMPLETED to our receiver starts the service
 * connected-device only, as `dumpsys activity services` reports it. The test runs in the app's
 * process, so it cannot reboot; a real reboot gives the same type (types=0x10, see the T4 report).
 */
@RunWith(AndroidJUnit4::class)
class CoderBootOnDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val pkg = context.packageName

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .use { it.readBytes().toString(Charsets.UTF_8) }

    /** The running service's foreground types, or null while it is not foreground. */
    private fun foregroundTypes(): Int? {
        val dump = shell("dumpsys activity services $pkg/${CoderService::class.java.name}")
        if (!dump.contains("isForeground=true")) return null
        val hex = Regex("\\btypes=(?:0x)?([0-9a-fA-F]+)").find(dump)?.groupValues?.get(1) ?: return null
        return hex.toLong(16).toInt()
    }

    @After
    fun tearDown() {
        runCatching { context.startService(Intent(context, CoderService::class.java).setAction(CoderService.ACTION_STOP)) }
    }

    @Test
    fun boot_receiver_starts_connected_device_only_on_device() {
        // connectedDevice needs a Bluetooth or network prerequisite on API 34+; onboarding grants it.
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.BLUETOOTH_CONNECT)
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.RECORD_AUDIO)
        ServicePrefs(context).recordForegroundStart()

        // The system's own BOOT_COMPLETED carries a temporary allowlist for a foreground start; one
        // sent from the shell does not, so the test grants the same allowlist first.
        shell("cmd deviceidle tempwhitelist -d 20000 $pkg")
        shell("am broadcast -a ${Intent.ACTION_BOOT_COMPLETED} -n $pkg/${CoderBootReceiver::class.java.name}")

        var types: Int? = null
        val deadline = System.currentTimeMillis() + 15_000
        while (types == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(250)
            types = foregroundTypes()
        }
        assertNotNull("the service never went foreground after BOOT_COMPLETED", types)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, types!! and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        assertEquals("no microphone type after boot", 0, types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }
}
