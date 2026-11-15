package com.anezium.rokidbus.phone

import android.os.Handler
import com.anezium.rokidbus.client.IBusCallback
import com.anezium.rokidbus.client.PluginRegistrationResult
import com.anezium.rokidbus.client.plugin.NexusPluginTransport
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.plugin.PluginCapability
import org.json.JSONObject

/** What the in-process transport needs from the core. */
internal interface InProcessHub {
    fun addRegistration(callback: IBusCallback): Boolean
    fun announceRegistration(callback: IBusCallback)
    fun removeRegistration(callback: IBusCallback)
    fun route(envelope: BusEnvelope, callback: IBusCallback): Boolean
    fun capabilities(): Int
}

/**
 * The SDK's plugin transport, over a local callback instead of AIDL. Inbound messages decode
 * exactly as BusClient decodes them and reach the client on the main looper; outbound calls are
 * routed on the core's local-ingress executor and return once enqueued, like oneway calls.
 */
internal class InProcessPluginTransport(
    private val app: InProcessApp,
    private val hub: InProcessHub,
    private val main: Handler,
) : NexusPluginTransport {
    @Volatile private var listener: NexusPluginTransport.Listener? = null

    private val callback = object : IBusCallback.Stub() {
        override fun onMessage(path: String, id: String, payload: ByteArray) {
            val json = runCatching { JSONObject(String(payload, Charsets.UTF_8)) }
                .getOrElse { JSONObject().put("raw", String(payload, Charsets.UTF_8)) }
            post { it.onMessage(path, id, json) }
        }

        override fun onLinkState(state: Int) {
            post { it.onLinkState(state) }
        }

        override fun onBinaryMessage(path: String, id: String, meta: ByteArray, data: ByteArray) {
            val json = runCatching { JSONObject(String(meta, Charsets.UTF_8)) }
                .getOrElse { JSONObject().put("raw", String(meta, Charsets.UTF_8)) }
            post { it.onBinary(path, id, json, data) }
        }

        override fun onGlassesAiButton(active: Boolean) {
            post { it.onGlassesAiButton(active) }
        }
    }

    override fun connect(listener: NexusPluginTransport.Listener) {
        this.listener = listener
        if (!hub.addRegistration(callback)) {
            post { it.onRegistrationState(PluginRegistrationResult.REGISTRATION_FAILED) }
            return
        }
        // registerPlugin answers APPROVED before the registration message follows; keep that order.
        post { it.onRegistrationState(PluginRegistrationResult.APPROVED) }
        hub.announceRegistration(callback)
    }

    override fun send(path: String, id: String, payload: JSONObject): Boolean {
        if (listener == null) return false
        return hub.route(BusEnvelope(path = path, id = id, payload = payload), callback)
    }

    override fun sendBinary(path: String, id: String, payload: JSONObject, data: ByteArray): Boolean {
        if (listener == null) return false
        return hub.route(BusEnvelope(path = path, id = id, payload = payload, binary = data), callback)
    }

    override fun capabilities(): Int = hub.capabilities()

    override fun approvedCapabilities(): String = PluginCapability.serialize(app.capabilities)

    override fun close() {
        if (listener == null) return
        listener = null
        hub.removeRegistration(callback)
    }

    private fun post(action: (NexusPluginTransport.Listener) -> Unit) {
        main.post { listener?.let(action) }
    }
}
