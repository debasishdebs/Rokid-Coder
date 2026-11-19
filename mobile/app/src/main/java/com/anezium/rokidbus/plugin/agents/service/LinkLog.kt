package com.anezium.rokidbus.plugin.agents.service

import android.util.Log

/**
 * The glasses link's field diagnostics, under one logcat tag. They stay in release builds: when the link
 * misbehaves on a phone nobody has a debugger on, `adb logcat -s RokidCoder-Link` is the whole story.
 * State changes and decisions only, never a poll, and never a token, an address or a device serial.
 */
internal object LinkLog {
    const val TAG = "RokidCoder-Link"

    /** Where a line goes; tests replace it. */
    @Volatile internal var sink: (String) -> Unit = { line ->
        // A plain JVM test has no Log to call; a phone always does.
        runCatching { Log.i(TAG, line) }
    }

    fun i(message: String) = sink(message)

    /**
     * What the hub says about itself that belongs here: the CXR link, Hi Rokid's session and the
     * Bluetooth data link coming and going. The hub also logs every frame it routes, which is not ours to keep.
     */
    fun hub(line: String) {
        if (HUB_PREFIXES.any(line::startsWith)) i("hub: $line")
    }

    private val HUB_PREFIXES = listOf(
        "CXR-L ",
        "Hi Rokid glass BT",
        "SPP authenticated",
        "SPP link closed",
        "Hub stopped",
    )
}
