package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.plugin.agents.VoiceCapture.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VoiceCaptureTest {
    private fun listening() = VoiceCapture().also { it.onStarted() }

    @Test
    fun a_final_is_heard_and_confirmed() {
        val capture = listening()
        capture.onPartial("reply to")
        capture.onFinal("reply to the review")
        capture.onStopped(NexusSpeechStopReason.COMPLETED)
        assertEquals(State.Heard("reply to the review"), capture.state)
        assertEquals("reply to the review", capture.confirmedText())
    }

    @Test
    fun null_final_falls_back_to_last_partial() {
        val capture = listening()
        capture.onPartial("ship it")
        capture.onPartial("ship it now")
        capture.onPartial("   ")
        capture.onFinal(null)
        assertEquals(State.Heard("ship it now"), capture.state)
    }

    @Test
    fun blank_final_falls_back_to_last_partial_too() {
        val capture = listening()
        capture.onPartial("go ahead")
        capture.onFinal("  ")
        assertEquals(State.Heard("go ahead"), capture.state)
    }

    @Test
    fun blank_final_and_no_partial_is_failed_didnt_catch() {
        val capture = listening()
        capture.onFinal("")
        assertEquals(State.Failed("Didn't catch that"), capture.state)
        // The session ending after it keeps the card as it is.
        capture.onStopped(NexusSpeechStopReason.COMPLETED)
        assertEquals(State.Failed("Didn't catch that"), capture.state)
        assertNull(capture.confirmedText())
    }

    @Test
    fun a_session_that_ends_with_only_a_partial_uses_it() {
        val capture = listening()
        capture.onPartial("hello there")
        capture.onStopped(NexusSpeechStopReason.COMPLETED)
        assertEquals(State.Heard("hello there"), capture.state)
    }

    @Test
    fun denied_busy_is_mic_busy() {
        val capture = VoiceCapture()
        capture.onStopped(NexusSpeechStopReason.DENIED_BUSY)
        assertEquals(State.Failed("Mic busy — try again"), capture.state)
        assertNull(capture.confirmedText())
    }

    @Test
    fun link_loss_and_no_speech_have_their_own_copy() {
        for (reason in listOf(NexusSpeechStopReason.DENIED_NO_LINK, NexusSpeechStopReason.LINK_LOST)) {
            val capture = listening()
            capture.onStopped(reason)
            assertEquals(State.Failed("Glasses link lost"), capture.state)
        }
        val quiet = listening()
        quiet.onStopped(NexusSpeechStopReason.NO_SPEECH)
        assertEquals(State.Failed("Didn't catch that"), quiet.state)
    }

    @Test
    fun a_link_lost_after_the_final_keeps_what_was_heard() {
        val capture = listening()
        capture.onFinal("allow it")
        capture.onStopped(NexusSpeechStopReason.LINK_LOST)
        assertEquals(State.Heard("allow it"), capture.state)
    }

    @Test
    fun cancelling_goes_idle() {
        val capture = listening()
        capture.onPartial("half a sentence")
        capture.onStopped(NexusSpeechStopReason.CANCELLED)
        assertEquals(State.Idle, capture.state)
        assertNull(capture.confirmedText())
    }

    @Test
    fun confirmed_text_only_after_heard() {
        val capture = VoiceCapture()
        assertNull(capture.confirmedText())
        capture.onStarted()
        assertNull(capture.confirmedText())
        capture.onPartial("not yet")
        assertNull(capture.confirmedText())
        capture.onFinal("now")
        assertEquals("now", capture.confirmedText())
    }

    @Test
    fun late_final_after_invalidate_is_dropped() {
        val capture = listening()
        capture.onPartial("approve everything")
        capture.invalidate()
        capture.onFinal("approve everything")
        capture.onStopped(NexusSpeechStopReason.COMPLETED)
        assertEquals(State.Idle, capture.state)
        assertNull(capture.confirmedText())
        // Not even a restart brings it back: one instance serves one utterance.
        capture.onStarted()
        capture.onFinal("yes")
        assertNull(capture.confirmedText())
    }

    @Test
    fun invalidate_drops_a_heard_text() {
        val capture = listening()
        capture.onFinal("send this")
        capture.invalidate()
        assertNull(capture.confirmedText())
    }

    @Test
    fun voice_approval_matches_allow_and_deny_words() {
        for (word in listOf("allow", "approve", "yes", "ok", "okay", "allow it", "approve it", "yes allow", "yes approve")) {
            assertEquals(word, ApprovalDecision.ALLOW, VoiceApproval.match(word))
        }
        for (word in listOf("deny", "no", "reject", "deny it", "reject it", "no deny")) {
            assertEquals(word, ApprovalDecision.DENY, VoiceApproval.match(word))
        }
    }

    @Test
    fun voice_approval_normalises_case_punctuation_and_spaces() {
        assertEquals(ApprovalDecision.ALLOW, VoiceApproval.match("  Allow.  "))
        assertEquals(ApprovalDecision.ALLOW, VoiceApproval.match("Yes,   APPROVE!"))
        assertEquals(ApprovalDecision.DENY, VoiceApproval.match("Deny it?"))
        assertEquals(ApprovalDecision.ALLOW, VoiceApproval.match("Okay."))
    }

    @Test
    fun voice_approval_ambiguous_or_unknown_is_null() {
        for (said in listOf("", "   ", "...", "maybe", "sure", "go ahead", "yes deny", "allow deny", "approve deny", "yeah", "nope")) {
            assertNull(said, VoiceApproval.match(said))
        }
    }

    @Test
    fun voice_approval_negated_or_extra_words_is_null() {
        for (said in listOf(
            "don't allow", "do not approve", "allow it please", "no allow", "never allow", "not approved",
            "dont deny", "please allow", "allow it now", "yes please", "allow everything", "no don't deny",
        )) {
            assertNull(said, VoiceApproval.match(said))
        }
    }
}
