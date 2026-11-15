package com.anezium.rokidbus.glasses.shell

import com.anezium.rokidbus.client.HubTarget
import com.anezium.rokidbus.glasses.GlassesCoreConfig
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.GlassesClasses
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class UpstreamGlassesShellTest {
    private val app = RuntimeEnvironment.getApplication()
    private val upstream = AppIdentity("com.anezium.rokidbus.phone", "com.anezium.rokidbus.glasses")

    @Test
    fun each_shell_targets_its_own_pair() {
        assertTrue(app is GlassesHubApplication)
        val config = GlassesCoreConfig.of(app)
        assertEquals(upstream, config.identity)
        assertEquals(HubTarget.GLASSES, config.hubTarget)
        assertEquals(
            "com.anezium.rokidbus.glasses/com.anezium.rokidbus.glasses.SetupEntryActivity",
            config.identity.glassesComponent(GlassesClasses.SETUP_ENTRY_ACTIVITY).flattenToString(),
        )
    }

    @Test
    fun every_built_component_resolves_to_a_real_class() {
        val identity = GlassesCoreConfig.of(app).identity
        val packageManager = app.packageManager
        assertEquals(identity.glassesApplicationId, app.packageName)
        for (activity in listOf(GlassesClasses.SETUP_ENTRY_ACTIVITY, GlassesClasses.MAIN_ACTIVITY)) {
            assertEquals(activity, packageManager.getActivityInfo(identity.glassesComponent(activity), 0).name)
            Class.forName(activity)
        }
        val hub = GlassesCoreConfig.of(app).hubTarget
        for (service in listOf(GlassesClasses.ACCESSIBILITY_SERVICE, hub.serviceClassName)) {
            assertEquals(service, packageManager.getServiceInfo(identity.glassesComponent(service), 0).name)
            Class.forName(service)
        }
        val selfArm = "${identity.glassesApplicationId}.permission.START_SELFARM_WIRELESS"
        assertEquals(selfArm, packageManager.getPermissionInfo(selfArm, 0).name)
    }

    @Test
    fun upstream_glasses_shell_keeps_upstream_application_id() {
        assertEquals("com.anezium.rokidbus.glasses", BuildConfig.APPLICATION_ID)
        assertEquals(upstream.glassesApplicationId, BuildConfig.GLASSES_APPLICATION_ID)
        assertEquals(upstream.phoneApplicationId, BuildConfig.PHONE_APPLICATION_ID)
        assertEquals(10801, BuildConfig.VERSION_CODE)
        assertEquals("1.8.1", BuildConfig.VERSION_NAME)
    }
}
