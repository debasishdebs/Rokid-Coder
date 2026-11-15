@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.plugin.PluginCapability

data class HubCoreConfig(
    val foreground: HubForegroundHost,
    /** Our app: the one in-process app. The upstream shell: null. */
    val inProcessApp: InProcessApp? = null,
    /** The upstream shell's plugin runtime and extras. Our app: the default. */
    val hooks: HubShellHooks = HubShellHooks.None,
    val journal: PluginBusJournal = PluginBusJournal(),
    /** Never receives a token, steer, fingerprint, SAS nonce, payload text or device serial [6a-R8]. */
    val log: (String) -> Unit = {},
) {
    init {
        require(inProcessApp == null || hooks.foreground() == null) {
            "An in-process app and a plugin-runtime foreground policy are exclusive"
        }
    }
}

/** The single app the core hosts in its own process, with the grants its manifest would carry. */
data class InProcessApp(
    val pluginId: String,
    val displayName: String,
    val iconKey: String?,
    val capabilities: Set<PluginCapability>,
    val receivePrefixes: List<String>,
)

/** The shell's Service. Called on the main thread. */
interface HubForegroundHost {
    /** Re-promotes the host service, adding the microphone type when asked. Returns the failure, or null. */
    fun promote(microphone: Boolean): Throwable?

    /** The link changed; the shell redraws its status notification. */
    fun onLinkStateChanged(linkState: Int)
}

/** Test doubles for the radios and the speaker; production leaves every field at its default. */
internal data class HubCoreSeams(
    val cxr: CxrTransport? = null,
    val ttsOutput: PhoneTtsOutput? = null,
    val sppDataUp: () -> Boolean = { false },
)
