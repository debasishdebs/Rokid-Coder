package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.plugin.agents.ActiveCard.Kind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** R104: the glasses screen has one active card, and only that card can confirm. */
class ActiveCardTest {
    private val card = ActiveCard(guardMs = 600L)

    @Test
    fun approval_opened_over_question_replaces_it_and_hidden_card_never_confirms() {
        card.open(Kind.QUESTION, now = 0L)
        assertTrue(card.accepts(Kind.QUESTION, now = 1_000L))

        card.open(Kind.ALERT_DECISION, now = 2_000L)

        assertEquals(Kind.ALERT_DECISION, card.kind)
        // The question card is gone: nothing it holds can confirm, however late the tap.
        assertFalse(card.accepts(Kind.QUESTION, now = 9_000L))
        assertTrue(card.accepts(Kind.ALERT_DECISION, now = 9_000L))
    }

    @Test
    fun double_tap_send_answer_never_confirms_an_unseen_approval() {
        card.open(Kind.QUESTION, now = 0L)
        // The first tap of the double tap sends the answer and the approval takes the screen.
        card.open(Kind.ALERT_DECISION, now = 5_000L)
        // The second tap lands 80 ms later, inside the new card's guard.
        assertFalse(card.accepts(Kind.ALERT_DECISION, now = 5_080L))
        assertFalse(card.accepts(Kind.QUESTION, now = 5_080L))
        assertTrue(card.accepts(Kind.ALERT_DECISION, now = 5_600L))
    }

    @Test
    fun back_then_enter_cannot_reach_a_replaced_card() {
        card.open(Kind.QUESTION, now = 0L)
        card.open(Kind.ALERT_DECISION, now = 1_000L)
        card.close(Kind.ALERT_DECISION, now = 2_000L)

        assertEquals(Kind.NONE, card.kind)
        assertFalse(card.accepts(Kind.QUESTION, now = 10_000L))
        assertFalse(card.accepts(Kind.ALERT_DECISION, now = 10_000L))
    }

    @Test
    fun a_child_card_gives_the_screen_back_to_its_parent_with_a_fresh_guard() {
        card.open(Kind.QUESTION, now = 0L)
        card.openChild(Kind.VOICE, now = 1_000L)
        assertEquals(Kind.VOICE, card.kind)
        assertFalse(card.accepts(Kind.QUESTION, now = 5_000L))

        card.close(Kind.VOICE, now = 6_000L)

        assertEquals(Kind.QUESTION, card.kind)
        // The tap that closed the child must not land on the parent.
        assertFalse(card.accepts(Kind.QUESTION, now = 6_100L))
        assertTrue(card.accepts(Kind.QUESTION, now = 6_600L))
    }

    @Test
    fun opening_another_card_over_a_child_drops_the_parent_too() {
        card.open(Kind.QUESTION, now = 0L)
        card.openChild(Kind.VOICE, now = 1_000L)
        card.open(Kind.ALERT_DECISION, now = 2_000L)
        card.close(Kind.ALERT_DECISION, now = 3_000L)
        assertEquals(Kind.NONE, card.kind)
    }

    @Test
    fun closing_a_hidden_parent_leaves_the_child_on_screen_and_nothing_under_it() {
        card.open(Kind.ALERT_DECISION, now = 0L)
        card.openChild(Kind.VOICE, now = 1_000L)
        card.close(Kind.ALERT_DECISION, now = 2_000L)
        assertEquals(Kind.VOICE, card.kind)
        card.close(Kind.VOICE, now = 3_000L)
        assertEquals(Kind.NONE, card.kind)
    }

    @Test
    fun a_close_for_a_card_that_is_not_there_changes_nothing() {
        card.open(Kind.QUESTION, now = 0L)
        card.close(Kind.REPLY, now = 1_000L)
        assertEquals(Kind.QUESTION, card.kind)
        assertTrue(card.accepts(Kind.QUESTION, now = 700L))
    }

    @Test
    fun rearm_restarts_the_guard_on_the_same_card() {
        card.open(Kind.VOICE, now = 0L)
        card.rearm(now = 5_000L)
        assertFalse(card.accepts(Kind.VOICE, now = 5_300L))
        assertTrue(card.accepts(Kind.VOICE, now = 5_600L))
    }
}
