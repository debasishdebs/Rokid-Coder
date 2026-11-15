package com.anezium.rokidbus.plugin.agents

internal fun String.singleLine(maxChars: Int): String =
    replace(Regex("\\s+"), " ").trim().take(maxChars)
