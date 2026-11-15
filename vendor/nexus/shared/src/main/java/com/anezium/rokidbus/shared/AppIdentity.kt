package com.anezium.rokidbus.shared

import android.content.ComponentName

/**
 * The application ids of one phone app and the glasses app it pairs with. Each app shell supplies
 * its own pair; the cores read it from their config and never from a constant. Class names stay in
 * the `com.anezium.rokidbus.*` namespaces whatever the application ids are, so a component is
 * always (application id, unchanged class name).
 */
data class AppIdentity(
    val phoneApplicationId: String,
    val glassesApplicationId: String,
) {
    init {
        // The ids are spliced into adb shell commands and scripts, so only plain package names pass.
        require(APPLICATION_ID.matches(phoneApplicationId)) { "Invalid phone application id" }
        require(APPLICATION_ID.matches(glassesApplicationId)) { "Invalid glasses application id" }
        require(phoneApplicationId != glassesApplicationId) { "The phone and glasses apps need distinct ids" }
    }

    fun phoneComponent(classFqn: String): ComponentName = ComponentName(phoneApplicationId, classFqn)

    fun glassesComponent(classFqn: String): ComponentName = ComponentName(glassesApplicationId, classFqn)

    /** `ComponentName.flattenToString()` of [glassesComponent], for scripts and plain JVM code. */
    fun flattenedGlassesComponent(classFqn: String): String = "$glassesApplicationId/$classFqn"

    /** `ComponentName.flattenToShortString()`: relative only when the class lies under the id. */
    fun shortGlassesComponent(classFqn: String): String =
        if (classFqn.startsWith("$glassesApplicationId.")) {
            "$glassesApplicationId/${classFqn.substring(glassesApplicationId.length)}"
        } else {
            flattenedGlassesComponent(classFqn)
        }

    /** The glasses app's external files directory, as adb shell sees it. */
    val glassesExternalFilesPath: String
        get() = "/sdcard/Android/data/$glassesApplicationId/files"

    private companion object {
        val APPLICATION_ID = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")
    }
}

/** Glasses classes the phone names across the link. Their namespace never follows the application id. */
object GlassesClasses {
    const val SETUP_ENTRY_ACTIVITY = "com.anezium.rokidbus.glasses.SetupEntryActivity"
    const val MAIN_ACTIVITY = "com.anezium.rokidbus.glasses.MainActivity"
    const val ACCESSIBILITY_SERVICE = "com.anezium.rokidbus.glasses.RokidBusAccessibilityService"
}
