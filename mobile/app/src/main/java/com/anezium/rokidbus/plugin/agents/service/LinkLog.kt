package com.anezium.rokidbus.plugin.agents.service

import android.util.Log
import com.anezium.rokidbus.shared.LinkStateBits
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The glasses link's field diagnostics, under one logcat tag. They stay in release builds: when the link
 * misbehaves on a phone nobody has a debugger on, `adb logcat -s RokidCoder-Link` is the whole story. The
 * last [MAX_LINES] lines are also kept in memory, for the Glass app screen's Link log (copied as text), since
 * a phone's logcat ring rotates before anyone looks. State changes and decisions only, never a poll.
 *
 * Nothing sensitive is meant to reach it, and [redact] is the second wall: whatever a line says, an address,
 * a long identifier or a token-looking run never gets past it, into logcat or into the copy.
 */
internal object LinkLog {
    const val TAG = "RokidCoder-Link"
    const val MAX_LINES = 300

    /** Where a line goes; tests replace it. */
    @Volatile internal var sink: (String) -> Unit = { line ->
        // A plain JVM test has no Log to call; a phone always does.
        runCatching { Log.i(TAG, line) }
    }

    private val ring = ArrayDeque<String>()

    fun i(message: String) {
        val line = redact(message)
        synchronized(ring) {
            if (ring.size >= MAX_LINES) ring.removeFirst()
            ring.addLast("${stamp()} $line")
        }
        sink(line)
    }

    /** The kept lines, oldest first, each with its time of day. */
    fun recent(): List<String> = synchronized(ring) { ring.toList() }

    /** The kept lines as the one text the Glass app screen copies. */
    fun recentText(): String = recent().joinToString("\n")

    /** Tests only. */
    internal fun clearRecent() = synchronized(ring) { ring.clear() }

    /**
     * What the hub says about itself that belongs here: the CXR link, Hi Rokid's session and the
     * Bluetooth data link coming and going. The hub also logs every frame it routes, which is not ours to keep.
     */
    fun hub(line: String) {
        if (HUB_PREFIXES.any(line::startsWith)) i("hub: $line")
    }

    /** The link bits in words, as every line that needs them says them. */
    fun bits(state: Int, closedByServer: Boolean): String =
        "cxr=${if (state and LinkStateBits.CXR_CONTROL_UP != 0) "up" else "down"} " +
            "spp=${if (state and LinkStateBits.SPP_DATA_UP != 0) "up" else "down"} " +
            "bonded=${state and LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED != 0} " +
            "worn=${state and LinkStateBits.GLASSES_WORN != 0} closedByServer=$closedByServer"

    /**
     * A line with nothing in it that names a place or a thing: IPv4 and IPv6 addresses, MAC addresses and
     * any run of 16 or more letters, digits and token characters that has a digit in it (a token, a serial, a
     * fingerprint) become a marker. The words of a log line have no digits in their long runs; an identifier does.
     */
    fun redact(line: String): String = line
        .replace(MAC, "<addr>")
        .replace(IPV4, "<addr>")
        .replace(IPV6, "<addr>")
        .replace(LONG_RUN, "<id>")

    private fun stamp(): String =
        synchronized(clock) { clock.format(Date()) }

    private val clock = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    private val MAC = Regex("(?i)\\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\\b")
    private val IPV4 = Regex("\\b\\d{1,3}(?:\\.\\d{1,3}){3}\\b")
    private val IPV6 = Regex("(?i)\\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\\b")
    // A run with a digit in it: our own words (closedByServer=true) are long and have none, a token or a serial does.
    private val LONG_RUN = Regex("(?=[A-Za-z0-9+/=_-]*\\d)[A-Za-z0-9+/=_-]{16,}")

    private val HUB_PREFIXES = listOf(
        "CXR-L ",
        "Hi Rokid glass BT",
        "SPP authenticated",
        "SPP link closed",
        "Hub stopped",
    )
}
