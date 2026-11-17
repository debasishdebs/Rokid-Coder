package com.anezium.rokidbus.plugin.agents.service

import android.content.Context
import com.anezium.rokidbus.phone.GlassesAppInstaller
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.phone.HubCore
import com.anezium.rokidbus.phone.HubCoreConfig
import com.anezium.rokidbus.phone.HubForegroundHost
import com.anezium.rokidbus.phone.HubShellApi
import com.anezium.rokidbus.phone.InProcessApp
import com.anezium.rokidbus.plugin.agents.BuildConfig
import com.anezium.rokidbus.plugin.agents.PRODUCT_TITLE
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.plugin.PluginCapability

/** The glasses link [CoderService] hosts: the hub core, or a test's stand-in for it. Main thread. */
internal interface CoderCore {
    /** The Agents app's surface on the glasses. */
    val surface: GlassesSurface

    /** The core's glasses-app install over CXR; it verifies every APK itself [FR 5]. */
    val glassesInstaller: GlassesAppInstaller? get() = null

    fun start()

    /** The Rokid authorization's token: persisted by the core, which then connects CXR with it. */
    fun startWithToken(token: String) = Unit

    /** Terminal: stops the hub and releases the radios. */
    fun close()
}

/** One [HubCore], with Agents as its in-process app. */
internal class HubCoderCore(private val hub: HubCore) : CoderCore {
    constructor(context: Context, host: HubForegroundHost) : this(HubCore(context, config(host)))

    override val surface: GlassesSurface get() = hub.surface()

    override val glassesInstaller: GlassesAppInstaller get() = hub.glassesInstaller

    override fun start() = hub.start()

    // The one shell entry point the app uses: the core has no other way in for the CXR token, and
    // it reaches no part of the plugin bus.
    @OptIn(HubShellApi::class)
    override fun startWithToken(token: String) = hub.startWithToken(token)

    override fun close() = hub.close()

    companion object {
        /** The core's configuration: this service promotes, and the Rokid Coder app is the one in-process app. */
        fun config(host: HubForegroundHost) = HubCoreConfig(
            foreground = host,
            identity = AppIdentity(BuildConfig.PHONE_APPLICATION_ID, BuildConfig.GLASSES_APPLICATION_ID),
            inProcessApp = AGENTS_APP,
        )

        /** What the hub knows the Agents app as: the grants and prefixes its plugin manifest declared. */
        val AGENTS_APP = InProcessApp(
            pluginId = "agents",
            displayName = PRODUCT_TITLE,
            iconKey = "terminal",
            capabilities = setOf(PluginCapability.SURFACES, PluginCapability.STT, PluginCapability.TTS),
            receivePrefixes = listOf("/plugin/agents", "/system/plugin", "/stt", "/tts/started", "/tts/done"),
        )
    }
}
