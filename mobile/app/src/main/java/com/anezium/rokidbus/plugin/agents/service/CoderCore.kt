package com.anezium.rokidbus.plugin.agents.service

import android.content.Context
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.phone.HubCore
import com.anezium.rokidbus.phone.HubCoreConfig
import com.anezium.rokidbus.phone.HubForegroundHost
import com.anezium.rokidbus.phone.InProcessApp
import com.anezium.rokidbus.plugin.agents.BuildConfig
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.plugin.PluginCapability

/** The glasses link [CoderService] hosts: the hub core, or a test's stand-in for it. Main thread. */
internal interface CoderCore {
    /** The Agents app's surface on the glasses. */
    val surface: GlassesSurface

    fun start()

    /** Terminal: stops the hub and releases the radios. */
    fun close()
}

/** One [HubCore], with Agents as its in-process app. */
internal class HubCoderCore(context: Context, host: HubForegroundHost) : CoderCore {
    private val hub = HubCore(
        context,
        HubCoreConfig(
            foreground = host,
            identity = AppIdentity(BuildConfig.PHONE_APPLICATION_ID, BuildConfig.GLASSES_APPLICATION_ID),
            inProcessApp = AGENTS_APP,
        ),
    )

    override val surface: GlassesSurface get() = hub.surface()

    override fun start() = hub.start()

    override fun close() = hub.close()

    companion object {
        /** What the hub knows the Agents app as: the grants and prefixes its plugin manifest declared. */
        val AGENTS_APP = InProcessApp(
            pluginId = "agents",
            displayName = "Agents",
            iconKey = "terminal",
            capabilities = setOf(PluginCapability.SURFACES, PluginCapability.STT, PluginCapability.TTS),
            receivePrefixes = listOf("/plugin/agents", "/system/plugin", "/stt", "/tts/started", "/tts/done"),
        )
    }
}
