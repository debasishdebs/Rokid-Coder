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
    private val IPV6_GROUP = Regex("[0-9A-Fa-f]{1,4}")
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
        host.contains(':') -> isIpv6(host)
        host.all { it.isDigit() || it == '.' } -> isIpv4(host)
        else -> DNS.matches(host)
    }

    private fun isIpv4(host: String): Boolean =
        IPV4.matchEntire(host)?.groupValues?.drop(1)?.all { it.toInt() <= 255 } == true

    /**
     * Structurally an IPv6 literal, because one that is not makes the request for it throw: eight groups
     * of one to four hex digits, or fewer around a single `::`, with an IPv4 tail allowed last. A zone id is not.
     */
    private fun isIpv6(host: String): Boolean {
        if (host.length > 45) return false
        val gap = host.indexOf("::")
        if (gap != host.lastIndexOf("::")) return false
        val head = if (gap < 0) host else host.substring(0, gap)
        val tail = if (gap < 0) "" else host.substring(gap + 2)
        val first = groupCount(head, ipv4Tail = gap < 0) ?: return false
        val second = groupCount(tail, ipv4Tail = true) ?: return false
        return if (gap < 0) first == 8 else first + second <= 7
    }

    /** How many 16-bit groups [part] spells, or null when it is not groups at all. */
    private fun groupCount(part: String, ipv4Tail: Boolean): Int? {
        if (part.isEmpty()) return 0
        val items = part.split(':')
        var count = 0
        for ((index, item) in items.withIndex()) {
            when {
                ipv4Tail && index == items.lastIndex && item.contains('.') -> {
                    if (!isIpv4(item)) return null
                    count += 2
                }
                IPV6_GROUP.matches(item) -> count += 1
                else -> return null
            }
        }
        return count
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
