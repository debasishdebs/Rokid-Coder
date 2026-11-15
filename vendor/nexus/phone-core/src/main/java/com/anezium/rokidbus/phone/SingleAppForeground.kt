@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.EditableSurfaceContract
import com.anezium.rokidbus.shared.ForegroundSurfacePathPolicy
import com.anezium.rokidbus.shared.plugin.PluginCloseTypes
import com.anezium.rokidbus.shared.plugin.PluginOpenTypes
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The foreground for a hub with one in-process app and no plugin runtime: the app is the
 * launcher's only entry, adopts an idle HUD with its first show, and nothing can take it over.
 * There is no open-ack watchdog, because there is no binder to rebind.
 */
internal class SingleAppForeground(
    private val app: InProcessApp,
    private val port: Port,
) : HubForegroundPolicy {
    /** What the policy needs from the core. */
    interface Port {
        fun deliver(path: String, id: String, payload: JSONObject): Boolean
        fun sendRemote(envelope: BusEnvelope): String?
        fun hideSurfaces(pluginId: String)
        fun hideNotice(pluginId: String, reason: String)
    }

    private val lock = Any()
    private var active = false
    private var background = false

    override fun handleRemote(envelope: BusEnvelope): Boolean {
        when (envelope.path) {
            BusPaths.LAUNCHER_OPEN -> {
                val pluginId = envelope.payload.optString("pluginId")
                    .ifBlank { envelope.payload.optString("id") }
                if (pluginId != app.pluginId) return false
                val type = synchronized(lock) {
                    val resumed = background
                    active = true
                    background = false
                    if (resumed) PluginOpenTypes.RESUME else PluginOpenTypes.OPEN
                }
                return deliverLifecycle(BusPaths.PLUGIN_OPEN, type)
            }
            BusPaths.SURFACE_INPUT -> {
                val payload = envelope.payload
                val surfaceId = payload.optString("surfaceId")
                val owner = payload.optString("ownerPluginId")
                    .ifBlank { surfaceId.substringBefore(':').takeIf { ':' in surfaceId }.orEmpty() }
                val localSurfaceId = payload.optString("localSurfaceId")
                    .ifBlank { surfaceId.substringAfter(':', surfaceId) }
                if (owner == app.pluginId && isActive()) {
                    deliverLifecycle(
                        BusPaths.PLUGIN_INPUT,
                        "input",
                        JSONObject()
                            .put("localSurfaceId", localSurfaceId)
                            .put("keyCode", payload.optInt("keyCode"))
                            .put("action", payload.optInt("action")),
                    )
                }
                return true
            }
            BusPaths.SURFACE_TEXT_COMMITTED -> {
                val committed = EditableSurfaceContract.parseCommitted(envelope.payload) ?: return true
                val owner = envelope.payload.optString("ownerPluginId")
                    .ifBlank {
                        committed.surfaceId.substringBefore(':')
                            .takeIf { ':' in committed.surfaceId }
                            .orEmpty()
                    }
                    .ifBlank { activeId().orEmpty() }
                if (owner == app.pluginId && isActive()) {
                    port.deliver(
                        BusPaths.SURFACE_TEXT_COMMITTED,
                        "text-committed",
                        EditableSurfaceContract.committedPayload(
                            committed.surfaceId,
                            committed.text,
                            committed.cancelled,
                        ).put("pluginId", app.pluginId),
                    )
                }
                return true
            }
        }
        return false
    }

    override fun allowSurface(principal: PhonePluginPrincipal, path: String): Boolean {
        if (principal.descriptor.id != app.pluginId) return false
        val adopted = synchronized(lock) {
            if (active) return true
            if (background || !ForegroundSurfacePathPolicy.isShow(path)) return false
            active = true
            true
        }
        if (adopted) deliverLifecycle(BusPaths.PLUGIN_OPEN, PluginOpenTypes.ADOPTED)
        return adopted
    }

    override fun onSurfaceTraffic(pluginId: String) = Unit

    override fun onSelfHid(pluginId: String, detach: Boolean, hasActiveAudioLease: Boolean) {
        if (pluginId != app.pluginId) return
        val toBackground = synchronized(lock) {
            if (!active) return
            active = false
            background = detach && hasActiveAudioLease
            background
        }
        if (toBackground) {
            deliverLifecycle(BusPaths.PLUGIN_CLOSE, PluginCloseTypes.BACKGROUND)
        } else {
            deliverLifecycle(BusPaths.PLUGIN_CLOSE, "self_hidden")
        }
    }

    override fun onAudioLeaseEnded(pluginId: String, reason: String) {
        if (pluginId != app.pluginId) return
        synchronized(lock) {
            if (!background) return
            background = false
        }
        deliverLifecycle(BusPaths.PLUGIN_CLOSE, PluginCloseTypes.CLOSED)
    }

    override fun activeId(): String? = if (isActive()) app.pluginId else null

    override fun syncLauncherList() {
        port.sendRemote(
            BusEnvelope(
                path = BusPaths.LAUNCHER_LIST,
                payload = JSONObject().put(
                    "plugins",
                    JSONArray().put(
                        JSONObject()
                            .put("id", app.pluginId)
                            .put("displayName", app.displayName)
                            .apply { app.iconKey?.let { put("iconKey", it) } },
                    ),
                ),
            ),
        )
    }

    /** Hides the app's surface and band on the glasses. Delivers nothing: the client is closed. */
    override fun closeAll(reason: String) {
        synchronized(lock) {
            active = false
            background = false
        }
        port.hideSurfaces(app.pluginId)
        port.hideNotice(app.pluginId, reason)
    }

    private fun isActive(): Boolean = synchronized(lock) { active }

    private fun deliverLifecycle(path: String, type: String, extra: JSONObject = JSONObject()): Boolean {
        val id = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("version", 1)
            .put("type", type)
            .put("id", id)
            .put("pluginId", app.pluginId)
        extra.keys().forEach { key -> payload.put(key, extra.get(key)) }
        return port.deliver(path, id, payload)
    }

    /** A hub with neither an in-process app nor a plugin runtime: nothing ever owns the HUD. */
    object None : HubForegroundPolicy {
        override fun handleRemote(envelope: BusEnvelope): Boolean = false
        override fun allowSurface(principal: PhonePluginPrincipal, path: String): Boolean = false
        override fun onSurfaceTraffic(pluginId: String) = Unit
        override fun onSelfHid(pluginId: String, detach: Boolean, hasActiveAudioLease: Boolean) = Unit
        override fun onAudioLeaseEnded(pluginId: String, reason: String) = Unit
        override fun activeId(): String? = null
        override fun syncLauncherList() = Unit
        override fun closeAll(reason: String) = Unit
    }
}
