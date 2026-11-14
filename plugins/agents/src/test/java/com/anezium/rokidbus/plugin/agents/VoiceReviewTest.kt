package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechSession
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** R123: what the wearer sends by voice is exactly what the card showed, all of it. */
class VoiceReviewTest {
    private val screen = GlassesScreen(
        clock = { 0L },
        guardMs = 600L,
        host = object : GlassesScreen.Host {
            override val secure = true
            override fun render() = Unit
            override fun voiceInput(run: VoiceRun, event: NexusInputEvent) = Unit
            override fun questionInput(flow: QuestionFlow, event: NexusInputEvent) = Unit
            override fun menuInput(event: NexusInputEvent) = Unit
            override fun boardInput(event: NexusInputEvent) = Unit
            override fun startVoice(target: VoiceTarget) = Unit
            override fun confirmAlert(alertId: String, action: String) = Unit
            override fun decideRequest(requestId: String, decision: ApprovalDecision) = false
        },
    )
    private val wiring = VoiceQuestionWiring(
        screen,
        object : VoiceQuestionWiring.Host {
            override val surfaceShown = false
            override val secure = true
            override fun render() = Unit
            override fun speechSession(callbacks: NexusSpeechCallbacks): NexusSpeechSession? = null
            override fun sendFollowup(sessionKey: String, text: String) = Unit
            override fun brief(title: String, body: String, safety: Boolean) = Unit
        },
    )

    /** A long dictation whose last words change what it asks for. */
    private fun transcript(chars: Int): String {
        val tail = " but don't delete the build folder"
        val words = StringBuilder()
        while (words.length < chars - tail.length) words.append("then run the tests ")
        return (words.toString().take(chars - tail.length).trimEnd() + tail).padEnd(chars, '.')
    }

    private fun heard(text: String): VoiceRun = VoiceRun(VoiceTarget.Followup("claude:s1")).also {
        it.capture.onStarted()
        it.capture.onFinal(text)
    }

    @Test
    fun heard_card_shows_entire_sent_text() {
        val said = transcript(VoiceCapture.MAX_REVIEW_CHARS)
        val run = heard(said)
        val sent = run.capture.confirmedText()
        assertEquals(said, sent)

        val body = wiring.voiceCard(run).richLines!!.filter { it.tone == NexusRowTone.BODY }
        assertEquals(sent, body.joinToString("") { it.text })
        assertTrue(body.all { it.text.length <= VoiceCard.ROW_CHARS })
        assertTrue(body.last().text.endsWith("don't delete the build folder"))

        // The question card's answer box shows the whole answer Send answer sends, the same way.
        val item = QuestionItem("What next?", emptyList(), multiSelect = false, allowFreeText = true)
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", listOf(item)))
        assertTrue(flow.setFreeText(0, said))
        screen.openQuestion(flow)
        val box = wiring.questionCard(flow).richLines!!
        val answerBox = box.indexOfFirst { it.text == "Answer box (voice)" }
        val shown = box[answerBox].sub + box.drop(answerBox + 1).takeWhile { it.tone == NexusRowTone.BODY }
            .joinToString("") { it.text }
        assertEquals(flow.answers()?.get("What next?"), shown)
    }

    @Test
    fun overlong_voice_reply_refused_not_cut() {
        val run = heard(transcript(VoiceCapture.MAX_REVIEW_CHARS + 1))
        assertEquals(VoiceCapture.State.Failed(VoiceCapture.TOO_LONG), run.capture.state)
        assertNull(run.capture.confirmedText())
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, run.capture.state)
        assertEquals("Too long to review — say a shorter reply", view.body)
        assertFalse(view.rows.any { it.act == VoiceAct.SEND || it.act == VoiceAct.USE })

        // The same for a transcript that only the last partial carried.
        val partial = VoiceRun(VoiceTarget.Followup("claude:s1")).also {
            it.capture.onStarted()
            it.capture.onPartial(transcript(VoiceCapture.MAX_REVIEW_CHARS + 50))
            it.capture.onStopped(com.anezium.rokidbus.client.plugin.NexusSpeechStopReason.COMPLETED)
        }
        assertEquals(VoiceCapture.State.Failed(VoiceCapture.TOO_LONG), partial.capture.state)

        // A free-text answer box takes no more than the card can show, and never a cut one.
        val item = QuestionItem("What next?", emptyList(), multiSelect = false, allowFreeText = true)
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", listOf(item)))
        assertFalse(flow.setFreeText(0, transcript(VoiceCapture.MAX_REVIEW_CHARS + 1)))
        assertNull(flow.freeText(0))
    }
}
