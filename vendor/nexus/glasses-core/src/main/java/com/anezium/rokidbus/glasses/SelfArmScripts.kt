package com.anezium.rokidbus.glasses

import com.anezium.rokidbus.shared.AppIdentity

/**
 * Writes the app's identity into the shipped helper scripts. The assets keep upstream's values,
 * so an upstream bridge that updates itself from a newer APK still gets a working script; every
 * script the app installs is rendered here, and the bridge carries its rendered lines into each
 * self-update (`render_update_candidate`).
 */
internal object SelfArmScripts {
    fun renderWatchdog(asset: String, identity: AppIdentity): String = render(
        asset,
        "PKG" to identity.glassesApplicationId,
        "SVC" to identity.selfArmAccessibilityService,
        "SVC_SHORT" to identity.selfArmAccessibilityServiceShort,
    )

    fun renderBridgeIdentity(asset: String, identity: AppIdentity): String = render(
        asset,
        "CHANNEL" to "${identity.glassesExternalFilesPath}/cmd_bridge",
        "PACKAGE" to identity.glassesApplicationId,
    )

    private fun render(asset: String, vararg values: Pair<String, String>): String =
        values.fold(asset) { script, (name, value) ->
            val line = Regex("^$name=\"[^\"\\n]*\"$", RegexOption.MULTILINE)
            require(line.findAll(script).count() == 1) { "Script must assign $name exactly once" }
            line.replace(script, Regex.escapeReplacement("$name=\"$value\""))
        }
}
