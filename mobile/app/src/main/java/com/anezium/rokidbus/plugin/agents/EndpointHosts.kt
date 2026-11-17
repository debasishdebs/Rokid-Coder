package com.anezium.rokidbus.plugin.agents

import org.json.JSONArray
import org.json.JSONObject

/**
 * The addresses a computer can be dialled at, as a pairing line, `pair_credentials` or an `endpoint`
 * frame lists them. They say only where to dial: the TLS pin decides who answers, so a wrong or
 * hostile entry costs a failed connect and nothing more. Still, every entry is checked, because it
 * ends up in a URL and on a screen.
 */
internal object EndpointHosts {
    /** What one list keeps; a computer has a LAN address, a tailnet one and a spare or two. */
    const val MAX_HOSTS = 4
    const val MAX_HOST_CHARS = 253

    private val IPV4 = Regex("(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})")
    private val IPV6 = Regex("[0-9A-Fa-f:.]{2,45}")
    private val LABEL = "[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?"
    private val DNS = Regex("$LABEL(\\.$LABEL)*")

    /** [raw] entries that are valid hosts, in order, without repeats, at most [MAX_HOSTS]. Anything else is dropped. */
    fun clean(raw: List<Any?>?): List<String> {
        val kept = LinkedHashMap<String, String>()
        for (entry in raw.orEmpty()) {
            val host = (entry as? String)?.trim()?.takeIf(::isValid) ?: continue
            kept.putIfAbsent(host.lowercase(), host)
            if (kept.size == MAX_HOSTS) break
        }
        return kept.values.toList()
    }

    fun clean(raw: JSONArray?): List<String> =
        clean(raw?.let { array -> List(array.length()) { array.opt(it) } })

    /** An IPv4 or IPv6 literal, or a DNS name; no scheme, port, path, brackets, zone or whitespace. */
    fun isValid(host: String): Boolean = when {
        host.isEmpty() || host.length > MAX_HOST_CHARS -> false
        host.contains(':') -> host.length <= 45 && IPV6.matches(host) && host.count { it == ':' } >= 2
        host.all { it.isDigit() || it == '.' } -> IPV4.matchEntire(host)?.groupValues?.drop(1)?.all { it.toInt() <= 255 } == true
        else -> DNS.matches(host)
    }

    /** [hosts] without [primary], which is dialled first anyway. */
    fun without(hosts: List<String>, primary: String): List<String> = hosts.filterNot { it.equals(primary, ignoreCase = true) }

    /** The stored form: a JSON array, or null for none. */
    fun encode(hosts: List<String>): String? = hosts.takeIf { it.isNotEmpty() }?.let { JSONArray(it).toString() }

    /** What [encode] wrote, checked again; a save from before alternate hosts has none. */
    fun decode(stored: String?): List<String> =
        clean(stored?.let { runCatching { JSONArray(it) }.getOrNull() })
}

/**
 * The computer telling an authenticated link where else it can be reached:
 * `{type:"endpoint", v:2, hosts:[…], port}`. The one place that reads the frame, so the computer
 * side renaming it is a change here and nowhere else.
 */
internal data class EndpointFrame(val hosts: List<String>, val port: Int?) {
    companion object {
        const val TYPE = "endpoint"

        /** Null for anything but a v2 frame with at least one valid host; an invalid port reads as none. */
        fun parse(json: JSONObject): EndpointFrame? {
            if (json.intOrNull("v") != 2) return null
            val hosts = EndpointHosts.clean(json.optJSONArray("hosts")).takeIf { it.isNotEmpty() } ?: return null
            return EndpointFrame(hosts, json.intOrNull("port")?.takeIf { it in 1..65535 })
        }
    }
}
