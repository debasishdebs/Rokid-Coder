package com.anezium.rokidbus.plugin.agents.service

import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The merged manifest, as the package manager reads it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CoderManifestTest {
    private val app = RuntimeEnvironment.getApplication()

    @Test
    fun merged_manifest_declares_one_service_without_special_use() {
        @Suppress("DEPRECATION")
        val info = app.packageManager.getPackageInfo(
            app.packageName,
            PackageManager.GET_SERVICES or PackageManager.GET_RECEIVERS or PackageManager.GET_PERMISSIONS,
        )
        val service = info.services.orEmpty().single()
        assertEquals(CoderService::class.java.name, service.name)
        assertFalse(service.exported)
        assertEquals(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            service.foregroundServiceType,
        )

        val permissions = info.requestedPermissions.orEmpty().toSet()
        assertFalse("android.permission.FOREGROUND_SERVICE_SPECIAL_USE" in permissions)
        assertTrue(
            permissions.containsAll(
                listOf(
                    "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
                    "android.permission.FOREGROUND_SERVICE_MICROPHONE",
                    "android.permission.RECORD_AUDIO",
                    "android.permission.RECEIVE_BOOT_COMPLETED",
                ),
            ),
        )

        val receiver = info.receivers.orEmpty().single { it.name == CoderBootReceiver::class.java.name }
        assertFalse(receiver.exported)
        assertTrue(info.receivers.orEmpty().none { it.name.endsWith("AgentsMonitorService") })
        assertTrue(app.applicationInfo.className.endsWith(".RokidCoderApp"))
    }

    @Test
    fun the_qr_scanner_is_zxings_screen_alone_and_only_this_app_starts_it() {
        @Suppress("DEPRECATION")
        val info = app.packageManager.getPackageInfo(
            app.packageName,
            PackageManager.GET_ACTIVITIES or PackageManager.GET_PERMISSIONS,
        )
        val scanner = info.activities.orEmpty().single { it.name == "com.journeyapps.barcodescanner.CaptureActivity" }
        assertFalse(scanner.exported)
        assertEquals(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT, scanner.screenOrientation)

        // The camera is the one thing it adds, and nothing that reports usage: no log transport. The app itself
        // declares ACCESS_NETWORK_STATE, for one thing: hearing that the default network changed so the link to
        // the computer is dialled again (AgentdLinks); the scanner brings none of its own.
        val permissions = info.requestedPermissions.orEmpty().toSet()
        assertTrue("android.permission.CAMERA" in permissions)
        assertTrue("android.permission.ACCESS_NETWORK_STATE" in permissions)
        val components = info.activities.orEmpty().map { it.name }
        assertTrue(components.none { it.startsWith("com.google.mlkit.") || it.startsWith("com.google.android.gms.") })
    }
}
