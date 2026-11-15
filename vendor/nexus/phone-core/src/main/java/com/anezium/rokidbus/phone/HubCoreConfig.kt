@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.plugin.PluginCapability

/**
 * How a shell sets up its core. An app with its own code in-process passes [inProcessApp] and
 * never sees [HubShellHooks]; the upstream shell uses the opt-in constructor that takes them.
 */
class HubCoreConfig private constructor(
    val foreground: HubForegroundHost,
    /** Our app: the one in-process app. The upstream shell: null. */
    val inProcessApp: InProcessApp?,
    /** The upstream shell's plugin runtime and extras. Our app: none. */
    internal val hooks: HubShellHooks,
    val journal: PluginBusJournal,
    /** Never receives a token, steer, fingerprint, SAS nonce, payload text or device serial [6a-R8]. */
    val log: (String) -> Unit,
) {
    constructor(
        foreground: HubForegroundHost,
        inProcessApp: InProcessApp? = null,
        journal: PluginBusJournal = PluginBusJournal(),
        log: (String) -> Unit = {},
    ) : this(foreground, inProcessApp, HubShellHooks.None, journal, log)

    @HubShellApi
    constructor(
        foreground: HubForegroundHost,
        hooks: HubShellHooks,
        journal: PluginBusJournal = PluginBusJournal(),
        log: (String) -> Unit = {},
    ) : this(foreground, null, hooks, journal, log)

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
    val ttsRoute: (() -> PhoneTtsRoute)? = null,
    val sppDataUp: () -> Boolean = { false },
)
