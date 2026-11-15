package com.anezium.rokidbus.plugin.agents.onboarding

import android.Manifest
import android.os.Build

/** One permissions screen each, in this order (§2 step 2). */
enum class PermissionFeature(val label: String, val reason: String) {
    BLUETOOTH(
        "Nearby devices",
        "Rokid Coder talks to your glasses over Bluetooth. Android calls this \"Nearby devices\"; without it the glasses stay disconnected.",
    ),
    MICROPHONE(
        "Microphone",
        "Push-to-talk on the glasses turns your voice into replies and prompts. The microphone is used only while you hold the button.",
    ),
    NOTIFICATIONS(
        "Notifications",
        "One quiet notification shows that Rokid Coder is running, with Stop. Alerts go to your glasses, never to this phone.",
    ),
    BATTERY(
        "Battery",
        "Some phones freeze background apps to save battery, and the computer link drops. Allow Rokid Coder to run unrestricted.",
    ),
    ;

    /**
     * The runtime permissions this screen asks for on [sdkInt]: those of the merged manifest the
     * CXR link and the service need. Empty for the battery screen, which is the explained request.
     */
    fun permissions(sdkInt: Int): List<String> = when (this) {
        // BLUETOOTH_CONNECT is the merged manifest's only runtime Bluetooth permission (phone-core); before
        // API 31 Bluetooth is granted at install. A connectedDevice service needs it from API 34.
        BLUETOOTH -> if (sdkInt >= Build.VERSION_CODES.S) listOf(Manifest.permission.BLUETOOTH_CONNECT) else emptyList()
        MICROPHONE -> listOf(Manifest.permission.RECORD_AUDIO)
        NOTIFICATIONS -> if (sdkInt >= Build.VERSION_CODES.TIRAMISU) listOf(Manifest.permission.POST_NOTIFICATIONS) else emptyList()
        BATTERY -> emptyList()
    }

    /** Whether this phone has anything to ask for this feature at all. */
    fun applies(sdkInt: Int): Boolean = this == BATTERY || permissions(sdkInt).isNotEmpty()
}

internal data class PermissionScreen(val feature: PermissionFeature, val title: String, val reason: String, val allowLabel: String)

/** A feature's line after it was asked: on, or off with a pointer to grant it. */
internal data class PermissionLine(val feature: PermissionFeature, val on: Boolean) {
    val text: String get() = "${feature.label} — ${if (on) "on" else "off"}"
    val pointer: String? get() = if (on) null else "Grant"
}

/**
 * The PERMISSIONS step. Each screen is asked once, whatever the answer; a denial moves on, and the
 * feature shows as off with a "Grant" pointer. The step completes once every screen was asked.
 */
internal class PermissionsFlow(
    private val store: OnboardingStore,
    sdkInt: Int,
    private val isGranted: (PermissionFeature) -> Boolean,
) {
    val features: List<PermissionFeature> = PermissionFeature.values().filter { it.applies(sdkInt) }

    /** The next screen to show, or null when every one has been asked. */
    fun current(): PermissionScreen? = features.firstOrNull { !store.permissionAsked(it.name) }
        ?.let { PermissionScreen(it, it.label, it.reason, "Allow") }

    /** The user answered [feature]'s screen, whatever they chose. */
    fun answered(feature: PermissionFeature) {
        store.markPermissionAsked(feature.name)
        if (current() == null) store.complete(OnboardingStep.PERMISSIONS)
    }

    fun summary(): List<PermissionLine> = features.map { PermissionLine(it, isGranted(it)) }
}
