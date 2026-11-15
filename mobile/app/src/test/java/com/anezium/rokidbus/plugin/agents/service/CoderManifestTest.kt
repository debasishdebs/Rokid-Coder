package com.anezium.rokidbus.plugin.agents.service

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
}
