package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class QuestionDeckTest {
    private fun item(
        text: String,
        options: List<String> = listOf("Red", "Green"),
        multi: Boolean = false,
        free: Boolean = false,
    ) = QuestionItem(text, options.map(::QuestionOption), multi, free)

    private fun deck(vararg items: QuestionItem) =
        QuestionDeck(QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref-1", "claude_tool", items.toList())))

    @Test
    fun deck_next_works_unanswered() {
        val deck = deck(item("Colour?"), item("Size?"), item("Shape?"))
        assertEquals(0, deck.index)
        assertTrue(deck.next())
        assertEquals(1, deck.index)
        assertTrue(deck.next())
        assertEquals(2, deck.index)
        assertFalse(deck.onReview)
        // Past the last question there is the review card, still with nothing answered.
        assertTrue(deck.next())
        assertTrue(deck.onReview)
        assertFalse(deck.next())
    }

    @Test
    fun review_lists_unanswered_and_blocks_send() {
        val deck = deck(item("Colour?"), item("Size?", multi = true))
        deck.flow.toggle(0, 1)
        assertEquals("Q1 Colour?: Green", deck.reviewLine(0))
        assertEquals("Q2 Size?: — not answered", deck.reviewLine(1))
        assertFalse(deck.canSend)
        deck.flow.toggle(1, 0)
        deck.flow.toggle(1, 1)
        assertEquals("Q2 Size?: Red, Green", deck.reviewLine(1))
        assertTrue(deck.canSend)
    }

    @Test
    fun review_line_shows_free_text_whole() {
        val deck = deck(item("Why?", options = emptyList(), free = true))
        val said = "x".repeat(300)
        deck.flow.setFreeText(0, said)
        assertEquals("Q1 Why?: $said", deck.reviewLine(0))
    }

    @Test
    fun review_row_jumps_to_question() {
        val deck = deck(item("A?"), item("B?"), item("C?"))
        repeat(3) { deck.next() }
        assertTrue(deck.onReview)
        deck.jump(1)
        assertEquals(1, deck.index)
        assertFalse(deck.onReview)
        // A tap past the deck is ignored, never a crash.
        deck.jump(9)
        assertEquals(1, deck.index)
        deck.jump(-1)
        assertEquals(1, deck.index)
    }

    @Test
    fun back_from_q1_closes() {
        val deck = deck(item("A?"), item("B?"))
        // False tells the screen there is no earlier card: it closes the deck.
        assertFalse(deck.previous())
        assertEquals(0, deck.index)
        deck.next()
        assertTrue(deck.previous())
        assertEquals(0, deck.index)
    }

    @Test
    fun back_from_review_returns_to_the_last_question() {
        val deck = deck(item("A?"), item("B?"))
        deck.next()
        deck.next()
        assertTrue(deck.onReview)
        assertTrue(deck.previous())
        assertEquals(1, deck.index)
        assertFalse(deck.onReview)
    }

    @Test
    fun single_question_has_no_review_card() {
        val deck = deck(item("Colour?"))
        assertFalse(deck.hasReview)
        assertFalse(deck.next())
        assertEquals(0, deck.index)
        assertFalse(deck.onReview)
        assertFalse(deck.canSend)
        deck.flow.toggle(0, 0)
        assertTrue(deck.canSend)
        assertFalse(deck.previous())
    }

    @Test
    fun a_deck_of_several_has_a_review_card() {
        assertTrue(deck(item("A?"), item("B?")).hasReview)
    }
}
