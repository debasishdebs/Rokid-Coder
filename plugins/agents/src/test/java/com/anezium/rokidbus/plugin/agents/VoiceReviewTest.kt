package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechSession
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** U4/U13: a long reply is shown condensed on the card and sent in full, with every shown word reachable. */
class VoiceReviewTest {
    private val sent = mutableListOf<Pair<String, String>>()
    private val briefs = mutableListOf<Pair<String, String>>()
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
            override fun sendFollowup(sessionKey: String, text: String) {
                sent += sessionKey to text
            }
            override fun brief(title: String, body: String, safety: Boolean) {
                briefs += title to body
            }
        },
    )

    private fun words(count: Int) = (0 until count).joinToString(" ") { "w$it" }

    private fun key(code: Int) = NexusInputEvent("agents", code, KeyEvent.ACTION_DOWN)

    private fun heard(text: String, target: VoiceTarget = VoiceTarget.Followup("claude:s1")): VoiceRun =
        VoiceRun(target).also {
            it.capture.onStarted()
            it.capture.onFinal(text)
        }

    private fun bodyText(run: VoiceRun) =
        wiring.voiceCard(run).richLines!!.filter { it.tone == NexusRowTone.BODY }.map { it.text }

    @Test
    fun sent_text_is_the_full_transcript() {
        val said = words(600)
        val run = heard(said)
        assertEquals(VoiceCapture.State.Heard(said), run.capture.state)
        assertEquals(said, run.capture.confirmedText())

        // Send sends all of it, whatever the card showed.
        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_ENTER))
        assertEquals(listOf("claude:s1" to said), sent)
    }

    @Test
    fun heard_card_shows_condensed_header() {
        val run = heard(words(600))
        val body = bodyText(run)
        assertEquals("Showing 250 of 600 words · the full reply is sent", body.first())
        assertTrue(body.size <= VoiceCard.BODY_ROWS)
        assertTrue(body.all { it.length <= VoiceCard.ROW_CHARS })
        assertTrue(body.drop(1).joinToString("").startsWith("w0 w1 w2"))

        // The pure view says the same, for the answer card too.
        val view = VoiceCard.view(VoiceKind.ANSWER, run.capture.state)
        assertEquals("Showing 250 of 600 words · the full reply is sent", view.lead)
        assertEquals(VoiceAct.USE, view.rows.first().act)

        // A reply within the limit has no header, and a lower limit condenses sooner.
        assertNull(VoiceCard.view(VoiceKind.FOLLOWUP, VoiceCapture.State.Heard(words(40))).lead)
        assertEquals(
            "Showing 100 of 120 words · the full reply is sent",
            VoiceCard.view(VoiceKind.FOLLOWUP, VoiceCapture.State.Heard(words(120)), wordLimit = 100).lead,
        )
    }

    @Test
    fun a_short_reply_has_no_read_all_row() {
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, VoiceCapture.State.Heard("run the tests"))
        assertEquals(listOf("Send", "Speak again", "Cancel"), view.rows.map { it.text })
        assertNull(view.lead)
        assertEquals("run the tests", view.body)
        assertNull(view.readAll)
    }

    @Test
    fun every_displayed_word_is_reachable_through_read_all() {
        val run = heard(words(600))
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, run.capture.state)
        assertEquals(listOf("Send", "Read all", "Speak again", "Cancel"), view.rows.map { it.text })
        assertEquals(VoiceAct.SEND, view.rows[view.initial].act)

        // The card holds a preview; the reader holds the whole display.
        val display = VoiceCondense.condense(words(600), 250).display
        assertEquals(display, view.readAll)
        assertNull(wiring.voiceReader(run))
        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_DPAD_RIGHT))
        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_ENTER))
        val reader = wiring.voiceReader(run)
        assertNotNull(reader)
        assertEquals(display, reader!!.segments.joinToString("") { it.text })
        assertTrue(sent.isEmpty())

        // Back returns to the card, and nothing was sent or cancelled.
        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_BACK))
        assertNull(wiring.voiceReader(run))
        assertEquals(run.capture.confirmedText(), words(600))
    }

    @Test
    fun the_biggest_reply_is_still_whole_in_the_reader() {
        // 500 words, each at the 40-char cap: far more than the card's rows can hold.
        val said = (0 until 500).joinToString(" ") { "k".repeat(60) + it }
        val run = heard(said)
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, run.capture.state, wordLimit = 500)
        assertTrue(view.rows.any { it.act == VoiceAct.READ_ALL })
        assertEquals(VoiceCondense.condense(said, 500).display, view.readAll)
        assertEquals(said, run.capture.confirmedText())
    }

    @Test
    fun free_text_over_4000_chars_refused_visibly() {
        val item = QuestionItem("What next?", emptyList(), multiSelect = false, allowFreeText = true)
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", listOf(item)))
        screen.openQuestion(flow)
        val tooLong = "a".repeat(4_001)
        val run = heard(tooLong, VoiceTarget.Answer("alert-1", 0))

        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_ENTER))

        assertNull(flow.freeText(0))
        assertEquals(listOf(QuestionFlow.TOO_LONG to ""), briefs)
        assertEquals("Answer too long — answer on laptop", QuestionFlow.TOO_LONG)
    }

    @Test
    fun a_long_free_text_answer_is_kept_whole_and_shown_condensed() {
        val item = QuestionItem("What next?", emptyList(), multiSelect = false, allowFreeText = true)
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", listOf(item)))
        screen.openQuestion(flow)
        val said = words(600)
        assertTrue(flow.setFreeText(0, said))
        assertEquals(said, flow.answers()?.get("What next?"))

        val box = wiring.questionCard(flow).richLines!!
        val head = box.first { it.text == "Answer box (voice)" }
        assertEquals("Showing 250 of 600 words · the full reply is sent", head.sub)
        assertTrue(box.all { it.text.length <= VoiceCard.ROW_CHARS })
    }
}
