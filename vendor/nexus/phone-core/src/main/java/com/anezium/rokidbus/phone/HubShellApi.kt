package com.anezium.rokidbus.phone

import android.os.IBinder
import com.anezium.rokidbus.client.PluginRegistrationResult
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.PhoneHubCapabilities
import com.anezium.rokidbus.shared.plugin.PluginCapability
import org.json.JSONObject
import java.util.Locale

/**
 * Entry points that exist for the upstream Nexus shell's plugin runtime. An app hosting its own
 * code in-process never opts in, so it cannot reach the plugin bus.
 */
@RequiresOptIn("Only the upstream Nexus shell may use this", RequiresOptIn.Level.ERROR)
@Retention(AnnotationRetention.BINARY)
annotation class HubShellApi

/**
 * Where the core hands control to the upstream shell. Every member defaults to the behaviour of a
 * hub with no plugin runtime. The core never calls one while holding a lock of its own.
 */
@HubShellApi
interface HubShellHooks {
    fun admitPlugin(packageName: String, pluginId: String, uid: Int): PluginAdmission =
        PluginAdmission.Rejected(PluginRegistrationResult.DENIED, "NO_PLUGIN_RUNTIME")
    fun onPluginRegistered(principal: PhonePluginPrincipal) {}
    fun grantFor(principal: PhonePluginPrincipal): PluginGrantState = PluginGrantState.Denied
    fun onRegistrationRemoved(principal: PhonePluginPrincipal?, reason: String, ownerStillConnected: Boolean) {}
    fun onPrincipalRevoking(key: PluginGrantKey) {}
    fun onAuthorizationChanged(key: PluginGrantKey) {}
    fun foreground(): HubForegroundPolicy? = null
    fun onRemote(envelope: BusEnvelope): Boolean = false
    fun onLocal(envelope: BusEnvelope, sender: AuthorizedSender): Boolean = false
    fun leaseRestriction(principal: PhonePluginPrincipal, path: String): String? = null
    fun enqueueUndelivered(envelope: BusEnvelope, excludeUid: Int?): Boolean = false
    fun extraCapabilities(base: Int): Int = base
    fun onLinkState(state: Int, previous: Int) {}
    fun onGlassesCapabilities(payload: JSONObject) {}
    fun onAssistGesture(session: Int, press: Int): Boolean = false

    /** Whether the assist press may be taken over at all; false leaves it with Rokid. */
    fun assistTakeoverEnabled(): Boolean = false

    /** A client registered; a shell that queues messages for absent clients flushes them here. */
    fun onClientRegistered(prefixes: List<String>, key: PluginGrantKey?) {}

    /** A message reached a local client. */
    fun onLocalDelivered() {}

    /** The phone capabilities announced to the glasses, before they are sent. */
    fun announcement(base: PhoneHubCapabilities): PhoneHubCapabilities = base

    companion object {
        val None: HubShellHooks = object : HubShellHooks {}
    }
}

@HubShellApi
sealed interface PluginAdmission {
    data class Approved(val principal: PhonePluginPrincipal, val capabilities: Set<PluginCapability>) : PluginAdmission
    data class Rejected(val result: Int, val reason: String) : PluginAdmission
}

@HubShellApi
data class AuthorizedSender(
    val caller: PluginRouteCaller,
    val replyBinder: IBinder?,
    val principal: PhonePluginPrincipal? = null,
)

/**
 * Who owns the glasses' foreground surface. The core uses the shell's plugin registry when it
 * supplies one, otherwise a policy for its single in-process app.
 */
@HubShellApi
interface HubForegroundPolicy {
    /** LAUNCHER_OPEN, SURFACE_INPUT, SURFACE_TEXT_COMMITTED and any subscription paths. */
    fun handleRemote(envelope: BusEnvelope): Boolean
    fun allowSurface(principal: PhonePluginPrincipal, path: String): Boolean
    fun onSurfaceTraffic(pluginId: String)
    fun onSelfHid(pluginId: String, detach: Boolean, hasActiveAudioLease: Boolean)
    fun onAudioLeaseEnded(pluginId: String, reason: String)
    fun activeId(): String?
    fun syncLauncherList()
    fun closeAll(reason: String)
}

/** The phone's own text-to-speech, for the settings screen. */
@HubShellApi
interface PhoneTtsPort {
    val isReady: Boolean
    fun availableVoices(locale: Locale?): List<PhoneTtsVoiceOption>
    fun speakSample(text: String, locale: Locale): Boolean
}

/** The SPP pairing key's state when it is not plainly usable. */
enum class SppKeyState { UNAVAILABLE, RECOVERING, RECOVERED }

/** What [HubCore.ensureCxrLink] found and did. */
enum class CxrEnsureResult {
    /** The CXR link was up: nothing was bound. */
    ALREADY_UP,

    /** The link was down and is being bound; the link state says when it is up. */
    CONNECTING,

    /** The link was down and the library refused the bind (Hi Rokid missing or not authorized). */
    NOT_BOUND,

    /** No CXR token is stored: the glasses were never authorized. */
    NO_TOKEN,

    /** The hub is stopped or closed. */
    HUB_STOPPED,
}
