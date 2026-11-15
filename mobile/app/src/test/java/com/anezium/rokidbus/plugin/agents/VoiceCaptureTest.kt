package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.plugin.agents.VoiceCapture.State
import com.anezium.rokidbus.plugin.agents.service.VoiceAvailability
import com.anezium.rokidbus.plugin.agents.service.VoiceUnavailableException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
    fun a_microphone_refused_for_voice_off_shows_its_pointer_not_link_lost() {
        for (availability in listOf(VoiceAvailability.NEEDS_APP_OPEN, VoiceAvailability.PERMISSION_DENIED)) {
            // What CoderService.promote returns, as HubCore words it into the recognizer's
            // SOURCE_UNAVAILABLE error, which the session manager ends as LINK_LOST.
            val refusal = VoiceUnavailableException(availability)
            val error = NexusSpeechError(
                kind = "SOURCE_UNAVAILABLE",
                provider = "Android",
                detail = "Microphone foreground service is unavailable (${refusal.javaClass.simpleName}: ${refusal.message})",
            )
            for (capture in listOf(VoiceCapture(), listening())) {
                capture.onStopped(NexusSpeechStopReason.LINK_LOST, error)
                assertEquals(availability.name, State.Failed(availability.glassesLine!!), capture.state)
            }
        }
        assertEquals(VoiceAvailability.OPEN_APP, VoiceAvailability.NEEDS_APP_OPEN.glassesLine)

        // A real link loss still says so.
        val lost = listening()
        lost.onStopped(
            NexusSpeechStopReason.LINK_LOST,
            NexusSpeechError("SOURCE_UNAVAILABLE", null, "Glasses audio link was lost"),
        )
        assertEquals(State.Failed(VoiceCapture.LINK_LOST), lost.state)
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

    // ------------------------------------------------------------------ the card

    @Test
    fun a_heard_followup_offers_send_speak_again_and_cancel() {
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, State.Heard("run the tests"))
        assertEquals(listOf(VoiceAct.SEND, VoiceAct.SPEAK_AGAIN, VoiceAct.CANCEL), view.rows.map { it.act })
        assertEquals(listOf("Send", "Speak again", "Cancel"), view.rows.map { it.text })
        assertEquals("run the tests", view.body)
    }

    @Test
    fun a_long_reply_is_heard_whole_never_refused() {
        val said = (0 until 900).joinToString(" ") { "w$it" }
        val capture = listening()
        capture.onFinal(said)
        assertEquals(State.Heard(said), capture.state)
        assertEquals(said, capture.confirmedText())

        // One that only the last partial carried is kept whole too.
        val partial = listening()
        partial.onPartial(said)
        partial.onStopped(NexusSpeechStopReason.COMPLETED)
        assertEquals(State.Heard(said), partial.state)
    }

    @Test
    fun nothing_but_a_heard_card_offers_to_send() {
        for (state in listOf(State.Idle, State.Listening, State.Failed("Mic busy — try again"))) {
            for (kind in VoiceKind.entries) {
                val acts = VoiceCard.view(kind, state).rows.map { it.act }
                assertTrue("$kind $state", acts.none { it == VoiceAct.SEND || it == VoiceAct.USE || it == VoiceAct.CONFIRM })
            }
        }
        assertEquals("Mic busy — try again", VoiceCard.view(VoiceKind.FOLLOWUP, State.Failed("Mic busy — try again")).body)
    }

    @Test
    fun a_voice_approval_goes_through_its_own_confirm_card_that_opens_on_cancel() {
        val allow = VoiceCard.view(VoiceKind.APPROVAL, State.Heard("allow it"))
        assertEquals("Allow?", allow.title)
        assertEquals(ApprovalDecision.ALLOW, allow.decision)
        assertEquals(listOf("Confirm", "Cancel"), allow.rows.map { it.text })
        assertEquals(VoiceAct.CANCEL, allow.rows[allow.initial].act)

        val deny = VoiceCard.view(VoiceKind.APPROVAL, State.Heard("No"))
        assertEquals("Deny?", deny.title)
        assertEquals(ApprovalDecision.DENY, deny.decision)
    }

    @Test
    fun an_unmatched_voice_approval_asks_again_and_offers_no_confirm() {
        for (said in listOf("don't allow", "do not approve", "allow it please", "no allow", "what")) {
            val view = VoiceCard.view(VoiceKind.APPROVAL, State.Heard(said))
            assertEquals(said, "Say allow or deny", view.body)
            assertNull(said, view.decision)
            assertEquals(said, listOf(VoiceAct.SPEAK_AGAIN, VoiceAct.CANCEL), view.rows.map { it.act })
        }
    }

    @Test
    fun an_answer_by_voice_is_only_kept_not_sent() {
        val view = VoiceCard.view(VoiceKind.ANSWER, State.Heard("the blue one"))
        assertEquals(VoiceAct.USE, view.rows.first().act)
    }

    // ------------------------------------------------- a start that is still in flight (R105)

    private class FakeSession : SpeechStop {
        var stops = 0
        override fun stop() { stops++ }
    }

    @Test
    fun cancel_during_start_stops_when_active() {
        val capture = VoiceCapture()
        val session = FakeSession()
        capture.attach(session)
        // The wearer backs out while the hub is still answering the start.
        capture.invalidate()
        assertEquals(0, session.stops)
        capture.onStarted()
        assertEquals(1, session.stops)
        // Nothing the dropped session says is kept.
        capture.onPartial("approve everything")
        capture.onFinal("approve everything")
        assertEquals(State.Idle, capture.state)
        assertNull(capture.confirmedText())
        // A second report of the same start stops nothing more.
        capture.onStarted()
        assertEquals(1, session.stops)
    }

    @Test
    fun a_live_run_is_stopped_by_invalidate_once() {
        val capture = VoiceCapture()
        val session = FakeSession()
        capture.attach(session)
        capture.onStarted()
        capture.invalidate()
        assertEquals(1, session.stops)
        capture.onStarted()
        assertEquals(1, session.stops)
    }

    @Test
    fun not_granted_vs_still_stopping_copy() {
        val notGranted = VoiceCapture().also { it.onStartRefused(NexusSdkResult.CAPABILITY_NOT_GRANTED) }
        assertEquals(State.Failed("Voice unavailable"), notGranted.state)
        assertEquals("allow Speech to text in Nexus settings", VoiceCard.hint(notGranted.state))

        // The earlier session is still stopping: the SDK refuses a second one.
        val stopping = VoiceCapture().also { it.onStartRefused(NexusSdkResult.CAPABILITY_NOT_AVAILABLE) }
        assertEquals(State.Failed("Mic busy — try again"), stopping.state)
        assertNull(VoiceCard.hint(stopping.state))

        val unbound = VoiceCapture().also { it.onStartRefused(NexusSdkResult.NOT_REGISTERED) }
        assertEquals(State.Failed("Voice failed — try again"), unbound.state)
        assertNull(VoiceCard.hint(unbound.state))

        val sent = VoiceCapture().also { it.onStartRefused(NexusSdkResult.SENT) }
        assertEquals(State.Idle, sent.state)
    }
}
