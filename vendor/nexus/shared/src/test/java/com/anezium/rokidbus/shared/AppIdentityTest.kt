package com.anezium.rokidbus.shared

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AppIdentityTest {
    private val ours = AppIdentity(
        phoneApplicationId = "io.github.debasishdebs.rokidcoder",
        glassesApplicationId = "io.github.debasishdebs.rokidcoder.glasses",
    )
    private val upstream = AppIdentity(
        phoneApplicationId = "com.anezium.rokidbus.phone",
        glassesApplicationId = "com.anezium.rokidbus.glasses",
    )

    @Test
    fun components_pair_the_application_id_with_the_unchanged_class_name() {
        val setup = ours.glassesComponent(GlassesClasses.SETUP_ENTRY_ACTIVITY)
        assertEquals("io.github.debasishdebs.rokidcoder.glasses", setup.packageName)
        assertEquals("com.anezium.rokidbus.glasses.SetupEntryActivity", setup.className)
        assertEquals(
            "io.github.debasishdebs.rokidcoder/com.anezium.rokidbus.phone.BusHubService",
            ours.phoneComponent("com.anezium.rokidbus.phone.BusHubService").flattenToString(),
        )
    }

    @Test
    fun flattened_strings_match_component_name_for_both_pairs() {
        for (identity in listOf(ours, upstream)) {
            val component = identity.glassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE)
            assertEquals(component.flattenToString(), identity.flattenedGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE))
            assertEquals(component.flattenToShortString(), identity.shortGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE))
        }
        // The short form is relative only when the class lies under the application id.
        assertEquals(
            "io.github.debasishdebs.rokidcoder.glasses/com.anezium.rokidbus.glasses.RokidBusAccessibilityService",
            ours.shortGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE),
        )
        assertEquals(
            "com.anezium.rokidbus.glasses/.RokidBusAccessibilityService",
            upstream.shortGlassesComponent(GlassesClasses.ACCESSIBILITY_SERVICE),
        )
    }

    @Test
    fun glasses_shared_storage_is_under_the_glasses_application_id() {
        assertEquals(
            "/sdcard/Android/data/io.github.debasishdebs.rokidcoder.glasses/files",
            ours.glassesExternalFilesPath,
        )
    }

    @Test
    fun rejects_malformed_or_shared_application_ids() {
        assertThrows(IllegalArgumentException::class.java) { AppIdentity("", "a.b") }
        assertThrows(IllegalArgumentException::class.java) { AppIdentity("a.b", "a b") }
        assertThrows(IllegalArgumentException::class.java) { AppIdentity("a.b", "a.b") }
        assertThrows(IllegalArgumentException::class.java) { AppIdentity("a.b'; rm -rf /", "a.c") }
    }
}
