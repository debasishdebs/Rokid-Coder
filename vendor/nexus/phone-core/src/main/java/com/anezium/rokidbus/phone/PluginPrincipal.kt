package com.anezium.rokidbus.phone

import android.content.ComponentName
import com.anezium.rokidbus.shared.plugin.PluginCapability
import com.anezium.rokidbus.shared.plugin.PluginDescriptor
import com.anezium.rokidbus.shared.skills.SkillCatalog

/** What discovery found of a plugin's skill catalog. An invalid catalog never invalidates the plugin. */
sealed interface PluginSkillsState {
    data object Absent : PluginSkillsState
    data class Invalid(val reason: String) : PluginSkillsState
    data class Valid(val catalog: SkillCatalog) : PluginSkillsState
}

data class PhonePluginPrincipal(
    val packageName: String,
    val serviceComponent: ComponentName,
    val uid: Int,
    val signingDigestSha256: String,
    val descriptor: PluginDescriptor,
    val guardianServiceComponent: ComponentName? = null,
    val skills: PluginSkillsState = PluginSkillsState.Absent,
    /** Changes with every install of the package; skill references and invocations are bound to it. */
    val packageRevision: Long = 0L,
) {
    val skillCatalog: SkillCatalog?
        get() = (skills as? PluginSkillsState.Valid)?.catalog
}

data class PluginGrantKey(
    val packageName: String,
    val pluginId: String,
    val signingDigestSha256: String,
)

sealed interface PluginGrantState {
    data object Pending : PluginGrantState
    data class Approved(val capabilities: Set<PluginCapability>) : PluginGrantState
    data object Denied : PluginGrantState
    data object Disabled : PluginGrantState
}

fun PhonePluginPrincipal.grantKey(): PluginGrantKey = PluginGrantKey(
    packageName = packageName,
    pluginId = descriptor.id,
    signingDigestSha256 = signingDigestSha256,
)
