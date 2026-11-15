package com.anezium.rokidbus.plugin.agents

/**
 * What the glasses show of a voice reply: [display] is for the eye only. The
 * reply itself is never cut, so [totalWords] says how much of it was said and
 * [shownWords] how much of it [display] holds.
 */
data class Condensed(val display: String, val totalWords: Int, val shownWords: Int, val condensed: Boolean)

/** A long reply as its beginning, a slice of its middle and its end, so it can be judged at a glance (U4/U13). */
object VoiceCondense {
    const val DEFAULT_WORD_LIMIT = 250
    const val MIN_WORD_LIMIT = 50
    const val MAX_WORD_LIMIT = 500

    /** A displayed word longer than this is cut, so one unbroken token cannot fill the card. */
    private const val MAX_TOKEN_CHARS = 40
    private const val GAP = " … "
    private val WHITESPACE = Regex("\\s+")

    fun condense(text: String, limitWords: Int): Condensed {
        val words = text.trim().split(WHITESPACE).filter { it.isNotEmpty() }
        val total = words.size
        val limit = limitWords.coerceAtLeast(1)
        if (total <= limit) {
            return Condensed(words.joinToString(" ", transform = ::capped), total, total, condensed = false)
        }
        val head = Math.round(limit * 0.4).toInt()
        val middle = Math.round(limit * 0.2).toInt()
        val tail = limit - head - middle
        val middleStart = (total - middle) / 2
        val display = listOf(
            words.take(head),
            words.subList(middleStart, middleStart + middle),
            words.takeLast(tail),
        ).joinToString(GAP) { part -> part.joinToString(" ", transform = ::capped) }
        return Condensed(display, total, limit, condensed = true)
    }

    private fun capped(word: String): String =
        if (word.length > MAX_TOKEN_CHARS) word.take(MAX_TOKEN_CHARS - 1) + "…" else word
}
