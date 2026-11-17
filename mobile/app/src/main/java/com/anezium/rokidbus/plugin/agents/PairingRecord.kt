package com.anezium.rokidbus.plugin.agents

import org.json.JSONArray
import org.json.JSONObject

/**
 * One logical pairing with one computer (6a-R3), keyed by agentd's machine id and the agentd
 * certificate pinned during the SAS session. It is what `pair_credentials` hands over, and it
 * holds both directions: the outbound wss slot (token, steering secret, pin, host and port) and
 * the PhoneLink machine trust (token and the pinned client certificate). Forget, the TTL and a
 * refusal act on all of it at once.
 */
data class PairingRecord(
    val machineId: String,
    val machineName: String,
    /** agentd's certificate fingerprint, from the SAS session's own TLS handshake. */
    val agentdFp: String,
    val token: String,
    val steer: String,
    val wsHost: String,
    val wsPort: Int,
    /** The SAS attempt that made it: a PhoneLink commit proof is bound to it (6a-R4″). */
    val attempt: String,
    /** The computer's other addresses (LAN first, Tailscale last) when it listed them; empty from an older one. */
    val wsHosts: List<String> = emptyList(),
) {
    internal fun toJson(): String = JSONObject()
        .put("machineId", machineId)
        .put("machineName", machineName)
        .put("agentdFp", agentdFp)
        .put("token", token)
        .put("steer", steer)
        .put("wsHost", wsHost)
        .put("wsPort", wsPort)
        .apply { EndpointHosts.encode(wsHosts)?.let { put("wsHosts", JSONArray(it)) } }
        .put("attempt", attempt)
        .toString()

    /** The outbound slot this record dials. */
    internal fun outbound(): AgentdConfig =
        AgentdConfig(
            host = wsHost, port = wsPort, token = token, name = machineName, fp = agentdFp, steer = steer,
            altHosts = EndpointHosts.without(wsHosts, wsHost),
        )

    // The secrets, and the whole pin, stay out of every string this record becomes.
    override fun toString(): String = "PairingRecord(machineId=$machineId, name=$machineName, ws=$wsHost:$wsPort)"

    internal companion object {
        private val MACHINE_ID = Regex("[A-Za-z0-9._:-]{1,128}")
        private val STEER = Regex("[A-Za-z0-9_-]{32,128}")

        fun fromJson(raw: String?): PairingRecord? {
            val json = raw?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return null
            return parse(json, json.optString("agentdFp"), json.optString("attempt"))
        }

        /**
         * The record a `pair_credentials` frame describes, with the pin taken from the TLS session
         * itself, never from the frame. Null when any field is missing or malformed.
         */
        fun fromCredentials(frame: JSONObject, agentdFp: String, attempt: String): PairingRecord? =
            parse(frame, agentdFp, attempt)

        private fun parse(json: JSONObject, agentdFp: String, attempt: String): PairingRecord? {
            val fp = (CertPins.parse(agentdFp) as? PinParse.Valid)?.fp ?: return null
            val machineId = json.optString("machineId").takeIf(MACHINE_ID::matches) ?: return null
            val token = json.optString("token").takeIf { it.isNotBlank() && it.length <= MAX_AUTH_TOKEN_CHARS } ?: return null
            val steer = json.optString("steer").takeIf(STEER::matches) ?: return null
            val host = json.optString("wsHost").takeIf { it.isNotBlank() && it.length <= MAX_HOST_CHARS } ?: return null
            val port = json.optInt("wsPort", -1).takeIf { it in 1..65535 } ?: return null
            val name = json.optString("machineName").take(MAX_HUD_LABEL_CHARS).ifBlank { machineId }
            if (attempt.isBlank()) return null
            // Optional and additive: a computer from before alternate hosts sends none.
            val hosts = EndpointHosts.clean(json.optJSONArray("wsHosts"))
            return PairingRecord(machineId, name, fp, token, steer, host, port, attempt, hosts)
        }
    }
}
