package com.anezium.rokidbus.plugin.agents

import android.content.pm.PackageManager
import com.anezium.rokidbus.plugin.agents.service.CoderService
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * The JVM stand-in for :mobile:caller-test's emulator check: the merged manifest, as the package
 * manager reads it, exports no service, so no other app can bind or start one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class ServiceExposureTest {
    @Test
    fun no_service_is_exported_to_another_app() {
        val app = RuntimeEnvironment.getApplication()
        val services = app.packageManager.getPackageInfo(app.packageName, PackageManager.GET_SERVICES).services.orEmpty()

        assertTrue(services.any { it.name == CoderService::class.java.name })
        assertEquals(emptyList<String>(), services.filter { it.exported }.map { it.name })
    }
}
