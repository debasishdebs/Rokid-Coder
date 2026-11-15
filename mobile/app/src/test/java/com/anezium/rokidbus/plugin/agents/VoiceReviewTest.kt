package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.phone.SpeechHandle
import com.anezium.rokidbus.phone.SpeechListener
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
            override fun startSpeech(listener: SpeechListener): SpeechHandle? = null
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

    /** The SDK's NexusCard row cap: a card with more rows throws as it is built. */
    private val cardMaxRows = 64

    private fun freeItem(text: String) = QuestionItem(text, emptyList(), multiSelect = false, allowFreeText = true)

    /** Moves the question card's selection to the row whose line reads [text]; fails if there is none. */
    private fun select(flow: QuestionFlow, text: String) {
        repeat(64) { index ->
            screen.questionRow = index
            if (wiring.questionCard(flow).richLines!!.any { it.selected && it.text == text }) return
        }
        error("no row reads $text")
    }

    @Test
    fun review_with_max_length_answers_renders_within_row_limit() {
        val items = (1..16).map { freeItem("Question $it?") }
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", items))
        val answers = (0 until 16).map { q -> (0 until 2_000).joinToString(" ") { "q${q}w$it" }.take(4_000).trimEnd() }
        answers.forEachIndexed { q, answer -> assertTrue(flow.setFreeText(q, answer)) }
        screen.openQuestion(flow)
        repeat(16) { assertTrue(screen.questionDeck!!.next()) }
        assertTrue(screen.questionDeck!!.onReview)

        // Every selection draws the card within the SDK's row cap, one condensed row per review entry.
        repeat(16 * 2 + 1) { index ->
            screen.questionRow = index
            val lines = wiring.questionCard(flow).richLines!!
            assertTrue("${lines.size} rows at selection $index", lines.size <= cardMaxRows)
            assertTrue(lines.none { it.tone == NexusRowTone.BODY })
            assertTrue(lines.all { it.text.length <= BoardCards.MENU_LINE_CHARS })
            lines.filter { it.text.startsWith("Q") }.forEach { line ->
                assertTrue(line.text, line.text.substringAfter(": ").split(' ').count { it.startsWith("q") } <= 12)
            }
        }

        // Each question's reader action opens its whole answer in the paged reader.
        select(flow, "Read Q3 answer")
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_ENTER))
        val reader = wiring.questionReader(flow)
        assertNotNull(reader)
        assertTrue(reader!!.segments.joinToString("") { it.text }.contains(answers[2]))
        // A tap or BACK closes the reader onto the review card, which is still up.
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_BACK))
        assertNull(wiring.questionReader(flow))
        assertTrue(screen.questionDeck!!.onReview)
        assertEquals(ActiveCard.Kind.QUESTION, screen.kind)
    }

    @Test
    fun use_then_reopen_reads_middle_and_tail_then_sends_full_text() {
        val flow = QuestionFlow("alert-1", "claude:s1", QuestionPayload("ref", "claude_tool", listOf(freeItem("What next?"))))
        screen.openQuestion(flow)
        val said = words(600)
        val run = heard(said, VoiceTarget.Answer("alert-1", 0))
        // Use answer: the card goes back to the question, holding the whole answer.
        wiring.onVoiceInput(run, key(KeyEvent.KEYCODE_ENTER))
        assertEquals(said, flow.freeText(0))

        // The stored answer can be read again: its condensed middle and end are in the reader.
        select(flow, "Read answer")
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_ENTER))
        val read = wiring.questionReader(flow)!!.segments.joinToString("") { it.text }
        assertEquals(VoiceCondense.condense(said, VoiceCondense.DEFAULT_WORD_LIMIT).display, read)
        assertTrue(read.contains(" … w275 "))
        assertTrue(read.endsWith(" w599"))
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_BACK))
        assertNull(wiring.questionReader(flow))

        // A tap on the box itself still records a new answer.
        select(flow, "Answer box (voice)")
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_ENTER))
        assertEquals(ActiveCard.Kind.VOICE, screen.kind)
        assertEquals(VoiceTarget.Answer("alert-1", 0), screen.voice?.target)
        screen.stopVoice()
        assertEquals(ActiveCard.Kind.QUESTION, screen.kind)

        // Send answer sends the whole transcript, not what the card showed.
        select(flow, "Send answer")
        assertEquals(mapOf<String, Any>("What next?" to said), flow.answers())
        wiring.onQuestionInput(flow, key(KeyEvent.KEYCODE_ENTER))
        assertNull(screen.questionFlow)
    }

    @Test
    fun read_all_offered_whenever_body_exceeds_one_row() {
        // No viewport is measured, so only one BODY row is sure to be seen whole: a second one offers the reader.
        val two = words(30)
        assertEquals(2, VoiceCard.bodyRows(two).size)
        val view = VoiceCard.view(VoiceKind.FOLLOWUP, VoiceCapture.State.Heard(two))
        assertNull(view.lead)
        assertTrue(view.rows.any { it.act == VoiceAct.READ_ALL })
        assertEquals(two, view.readAll)

        // A longer reply too, and what the card draws stays within its rows, each one within three HUD lines.
        val run = heard(words(100))
        assertEquals(words(100), VoiceCard.view(VoiceKind.FOLLOWUP, run.capture.state).readAll)
        val body = bodyText(run)
        assertTrue(body.size <= VoiceCard.BODY_ROWS)
        assertTrue(body.all { VoiceCard.bodyRows(it).size == 1 })
        assertTrue(body.last().endsWith("…"))

        // A reply that fits one row is all on the card, with no reader to open.
        val one = words(10)
        assertEquals(1, VoiceCard.bodyRows(one).size)
        val short = VoiceCard.view(VoiceKind.FOLLOWUP, VoiceCapture.State.Heard(one))
        assertNull(short.readAll)
        assertTrue(short.rows.none { it.act == VoiceAct.READ_ALL })
    }
}
