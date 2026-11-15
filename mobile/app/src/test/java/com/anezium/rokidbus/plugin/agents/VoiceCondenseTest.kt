package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** U4/U13: a long reply is shown condensed, and nothing about showing it changes what is sent. */
class VoiceCondenseTest {
    private fun words(count: Int) = (0 until count).joinToString(" ") { "w$it" }

    @Test
    fun short_reply_shown_whole() {
        val said = "  run   the\ttests\nthen  stop "
        val result = VoiceCondense.condense(said, 250)
        assertEquals(Condensed("run the tests then stop", totalWords = 5, shownWords = 5, condensed = false), result)

        // Exactly at the limit is still whole.
        val atLimit = VoiceCondense.condense(words(250), 250)
        assertFalse(atLimit.condensed)
        assertEquals(words(250), atLimit.display)
        assertEquals(250, atLimit.shownWords)
    }

    @Test
    fun long_reply_head_middle_tail_with_ellipses() {
        val result = VoiceCondense.condense(words(600), 250)
        val parts = result.display.split(" … ")
        assertEquals(3, parts.size)
        assertEquals(2, Regex(" … ").findAll(result.display).count())
        assertEquals((0 until 100).map { "w$it" }, parts[0].split(" "))
        assertEquals((275 until 325).map { "w$it" }, parts[1].split(" "))
        assertEquals((500 until 600).map { "w$it" }, parts[2].split(" "))
        assertTrue(result.condensed)
        assertEquals(600, result.totalWords)
        assertEquals(250, result.shownWords)
    }

    @Test
    fun the_split_follows_the_limit() {
        // 100 -> 40 / 20 / 40; 150 -> 60 / 30 / 60; 500 -> 200 / 100 / 200.
        for ((limit, head) in listOf(100 to 40, 150 to 60, 500 to 200)) {
            val parts = VoiceCondense.condense(words(900), limit).display.split(" … ")
            assertEquals("head of $limit", head, parts[0].split(" ").size)
            assertEquals("middle of $limit", limit / 5, parts[1].split(" ").size)
            assertEquals("tail of $limit", head, parts[2].split(" ").size)
        }
    }

    @Test
    fun one_giant_token_is_capped_in_display_only() {
        val giant = "x".repeat(300)
        val said = "see $giant now"
        val result = VoiceCondense.condense(said, 250)
        assertEquals("see ${"x".repeat(39)}… now", result.display)
        assertEquals(3, result.totalWords)
        // A token of exactly 40 is left alone, and a giant in a condensed reply is capped too.
        assertEquals("y".repeat(40), VoiceCondense.condense("y".repeat(40), 250).display)
        val long = VoiceCondense.condense(words(600) + " " + giant, 250)
        assertTrue(long.display.endsWith("x".repeat(39) + "…"))
        assertTrue(long.display.length < 2_000)
        // The input is untouched: capping is a property of the display.
        assertEquals("see $giant now", said)
    }

    @Test
    fun word_limit_setting_clamped_to_500() {
        val prefs = MemoryPrefs()
        val store = AgentsConfigStore(prefs, wallClock = { 0L }) { 0L }
        assertEquals(250, store.voiceWordLimit())
        assertEquals(listOf(100, 150, 250, 500), VOICE_WORD_LIMIT_CHOICES)

        store.setVoiceWordLimit(150)
        assertEquals(150, store.voiceWordLimit())
        assertEquals(150, prefs.map["voice.word_limit"])
        store.setVoiceWordLimit(9_000)
        assertEquals(500, store.voiceWordLimit())
        store.setVoiceWordLimit(3)
        assertEquals(50, store.voiceWordLimit())
        // A value written by something else is clamped on the way out too.
        prefs.map["voice.word_limit"] = 100_000
        assertEquals(500, store.voiceWordLimit())
    }
}
