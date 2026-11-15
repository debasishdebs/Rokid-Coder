package com.anezium.rokidbus.glasses.app

import com.anezium.rokidbus.glasses.GlassesCoreConfig
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.GlassesClasses
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File

@RunWith(RobolectricTestRunner::class)
class RokidCoderGlassesAppTest {
    private val app = RuntimeEnvironment.getApplication()
    private val ours = AppIdentity("io.github.debasishdebs.rokidcoder", "io.github.debasishdebs.rokidcoder.glasses")

    @Test
    fun each_shell_targets_its_own_pair() {
        assertTrue(app is RokidCoderGlassesApplication)
        val config = GlassesCoreConfig.of(app)
        assertEquals(ours, config.identity)
        assertEquals("io.github.debasishdebs.rokidcoder.glasses", config.hubTarget.packageName)
        assertEquals("com.anezium.rokidbus.glasses.BusHubService", config.hubTarget.serviceClassName)
        assertEquals(
            "io.github.debasishdebs.rokidcoder.glasses/com.anezium.rokidbus.glasses.SetupEntryActivity",
            config.identity.glassesComponent(GlassesClasses.SETUP_ENTRY_ACTIVITY).flattenToString(),
        )
        assertEquals(
            "io.github.debasishdebs.rokidcoder.glasses/com.anezium.rokidbus.glasses.RokidBusAccessibilityService",
            config.identity.shortGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE),
        )
    }

    @Test
    fun every_built_component_resolves_to_a_real_class() {
        val identity = GlassesCoreConfig.of(app).identity
        val packageManager = app.packageManager
        assertEquals(identity.glassesApplicationId, app.packageName)
        // What the phone opens over CXR, and the launcher entry, under our id with unchanged classes.
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
    fun glasses_app_application_id_is_ours_and_upstream_shell_unchanged() {
        assertEquals("io.github.debasishdebs.rokidcoder.glasses", BuildConfig.APPLICATION_ID)
        assertEquals("io.github.debasishdebs.rokidcoder", BuildConfig.PHONE_APPLICATION_ID)
        assertEquals(BuildConfig.APPLICATION_ID, BuildConfig.GLASSES_APPLICATION_ID)
        // The upstream shells keep upstream's ids; their own suites check their BuildConfig.
        val upstreamGlasses = File("../../vendor/nexus/glasses-hub/build.gradle.kts").readText()
        assertTrue(upstreamGlasses.contains("applicationId = \"com.anezium.rokidbus.glasses\""))
        val upstreamPhone = File("../../vendor/nexus/phone-hub/build.gradle.kts").readText()
        assertTrue(upstreamPhone.contains("applicationId = \"com.anezium.rokidbus.phone\""))
    }

    /** R205: the phone turns the announced versionName into a code the APK must carry. */
    @Test
    fun version_code_follows_the_version_name() {
        assertEquals("1.0.0", BuildConfig.VERSION_NAME)
        assertEquals(10000, BuildConfig.VERSION_CODE)
        val (major, minor, patch) = BuildConfig.VERSION_NAME.split('.').map(String::toInt)
        assertEquals(major * 10000 + minor * 100 + patch, BuildConfig.VERSION_CODE)
    }
}
