package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechSession
import com.anezium.rokidbus.client.plugin.NexusSpeechState
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.shared.plugin.NexusInputEvent

internal sealed interface VoiceTarget {
    data class Followup(val sessionKey: String) : VoiceTarget
    data class Answer(val alertId: String, val itemIndex: Int) : VoiceTarget
    /** [allowRefused]: the approval's command was cut (R128), so a heard "allow" proposes nothing. */
    data class Approval(val alertId: String, val allowRefused: Boolean = false) : VoiceTarget
}

/** One utterance: its target, the state machine over the hub's callbacks, and where the card's selection is. */
internal class VoiceRun(val target: VoiceTarget) {
    val capture = VoiceCapture()
    var row = 0

    /** True while Read all's reader is up over the heard card. */
    var reading = false

    val kind: VoiceKind
        get() = when (target) {
            is VoiceTarget.Followup -> VoiceKind.FOLLOWUP
            is VoiceTarget.Answer -> VoiceKind.ANSWER
            is VoiceTarget.Approval -> VoiceKind.APPROVAL
        }
}

/**
 * The voice card and the question card: their input, what their picks do, and
 * how they are drawn. Both open and close through [GlassesScreen], which routes
 * their input here only while they are on screen.
 */
internal class VoiceQuestionWiring(
    private val screen: GlassesScreen,
    private val host: Host,
) {
    interface Host {
        val surfaceShown: Boolean
        val secure: Boolean
        fun render()
        fun speechSession(callbacks: NexusSpeechCallbacks): NexusSpeechSession?
        fun sendFollowup(sessionKey: String, text: String)
        fun brief(title: String, body: String, safety: Boolean = false)

        /** Words of a long voice reply the glasses show before condensing it (U4/U13). */
        val voiceWordLimit: Int get() = VoiceCondense.DEFAULT_WORD_LIMIT
    }

    // ------------------------------------------------------------------ voice

    /**
     * Starts one tap-to-talk utterance for [target], replacing any before it. The
     * speech callbacks run on the main thread; each is tied to its own run, so one
     * that arrives after the card was closed or restarted is dropped. Nothing the
     * wearer says is logged, and nothing is sent until ENTER on the heard card.
     */
    fun startVoice(target: VoiceTarget) {
        // A restart gives the screen back to the card that asked, then covers it again.
        screen.stopVoice()
        val run = VoiceRun(target)
        screen.openVoice(run)
        val session = host.speechSession(object : NexusSpeechCallbacks {
            // A start the wearer gave up on is stopped by the capture itself, once the hub accepts it (R105).
            override fun onSpeechStarted(realtime: Boolean) = onVoiceEvent(run) { it.onStarted() }
            override fun onSpeechState(state: NexusSpeechState) = Unit
            override fun onSpeechPartial(text: String) {
                if (screen.voice === run) run.capture.onPartial(text)
            }
            override fun onSpeechFinal(text: String) = onVoiceEvent(run) { it.onFinal(text) }
            override fun onSpeechStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?) {
                onVoiceEvent(run) { it.onStopped(reason) }
            }
        })
        if (session == null) {
            run.capture.onStartRefused(NexusSdkResult.NOT_REGISTERED)
        } else {
            run.capture.attach { session.stop() }
            run.capture.onStartRefused(session.start("auto"))
        }
        voiceChanged(run)
    }

    private fun onVoiceEvent(run: VoiceRun, event: (VoiceCapture) -> Unit) {
        // A run the wearer left is not shown, but its capture still has to hear that the start landed.
        if (screen.voice !== run) {
            event(run.capture)
            return
        }
        event(run.capture)
        voiceChanged(run)
    }

    /** A new card state: the selection starts over, and a tap aimed at the old one cannot land on it. */
    private fun view(run: VoiceRun): VoiceView =
        VoiceCard.view(
            run.kind,
            run.capture.state,
            allowRefused = (run.target as? VoiceTarget.Approval)?.allowRefused == true,
            wordLimit = host.voiceWordLimit,
        )

    private fun voiceChanged(run: VoiceRun) {
        run.row = view(run).initial
        run.reading = false
        screen.rearm()
        if (host.surfaceShown) host.render()
    }

    fun onVoiceInput(run: VoiceRun, event: NexusInputEvent) {
        val view = view(run)
        if (run.reading) {
            // The hub scrolls the reader; a tap or BACK returns to the heard card, which still holds the reply.
            if (GlassesKeys.isEnter(event) || event.keyCode == KeyEvent.KEYCODE_BACK) {
                run.reading = false
                screen.rearm()
                host.render()
            }
            return
        }
        when {
            event.keyCode in GlassesKeys.BACKWARD -> {
                run.row = (run.row - 1 + view.rows.size) % view.rows.size
                host.render()
            }
            event.keyCode in GlassesKeys.FORWARD -> {
                run.row = (run.row + 1) % view.rows.size
                host.render()
            }
            GlassesKeys.isEnter(event) -> {
                val act = view.rows.getOrNull(run.row)?.act ?: return
                onVoiceAct(run, act, view)
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                screen.stopVoice()
                host.render()
            }
        }
    }

    private fun onVoiceAct(run: VoiceRun, act: VoiceAct, view: VoiceView) {
        when (act) {
            VoiceAct.CANCEL -> {
                screen.stopVoice()
                host.render()
            }
            VoiceAct.SPEAK_AGAIN -> startVoice(run.target)
            VoiceAct.READ_ALL -> {
                run.reading = view.readAll != null
                screen.rearm()
                host.render()
            }
            VoiceAct.SEND -> {
                val text = run.capture.confirmedText() ?: return
                val target = run.target as? VoiceTarget.Followup ?: return
                screen.stopVoice()
                host.render()
                host.sendFollowup(target.sessionKey, text)
            }
            VoiceAct.USE -> {
                val text = run.capture.confirmedText() ?: return
                val target = run.target as? VoiceTarget.Answer ?: return
                val kept = screen.questionFlow?.takeIf { it.alertId == target.alertId }
                    ?.setFreeText(target.itemIndex, text)
                screen.stopVoice()
                host.render()
                // An answer agentd would refuse for its length says so here, and where to give it instead.
                if (kept == false) host.brief(QuestionFlow.TOO_LONG, "")
            }
            VoiceAct.CONFIRM -> {
                val decision = view.decision ?: return
                val target = run.target as? VoiceTarget.Approval ?: return
                screen.stopVoice()
                screen.close(ActiveCard.Kind.ALERT_DECISION)
                host.render()
                // The coordinator only lets a card that is still bound answer.
                AgentsRuntime.alertDirector?.onCardConfirm(
                    target.alertId,
                    if (decision == ApprovalDecision.ALLOW) AlertCoordinator.ALLOW else AlertCoordinator.DENY,
                )
            }
        }
    }

    fun voiceCard(run: VoiceRun): NexusCard {
        val state = run.capture.state
        val view = view(run)
        val rows = buildList {
            view.lead?.let { add(NexusCardLine(text = it, tone = NexusRowTone.BODY)) }
            view.body?.let { body ->
                val parts = VoiceCard.bodyRows(body)
                parts.forEachIndexed { index, part ->
                    val last = index == parts.lastIndex
                    add(NexusCardLine(text = part, sub = if (last) VoiceCard.hint(state) else null, tone = NexusRowTone.BODY))
                }
            }
            view.rows.forEachIndexed { index, row ->
                add(
                    NexusCardLine(
                        text = row.text,
                        sub = row.sub,
                        selected = index == run.row,
                        tone = if (index == run.row) NexusRowTone.ALERT else NexusRowTone.DIM,
                    ),
                )
            }
        }
        val subtitle = when (val target = run.target) {
            is VoiceTarget.Followup -> AgentsRuntime.store.sessions.value
                .firstOrNull { it.key == target.sessionKey }?.displayTitle.orEmpty()
            is VoiceTarget.Answer -> screen.questionFlow?.payload?.items?.getOrNull(target.itemIndex)?.text.orEmpty()
            is VoiceTarget.Approval -> screen.decidingAlert?.title.orEmpty()
        }
        return BoardCards.card(
            title = view.title.singleLine(110),
            subtitle = subtitle.singleLine(120),
            rows = rows,
            footer = "swipe choose · tap select · 2-tap cancel",
        )
    }

    /** What Read all opens: the reply as the card shows it, whole, in the paged reader; null unless it is open. */
    fun voiceReader(run: VoiceRun): NexusReader? {
        if (!run.reading) return null
        val view = view(run)
        return BoardCards.menuReader(view.title, view.readAll ?: return null)
    }

    // --------------------------------------------------------------- question

    private sealed interface QuestionRow {
        data class Option(val index: Int) : QuestionRow
        data object AnswerBox : QuestionRow
        data object Next : QuestionRow
        data object Previous : QuestionRow

        /** The send row of a one-question alert, on its only card. */
        data object Send : QuestionRow

        /** A review row: a tap opens that question's card. */
        data class Review(val question: Int) : QuestionRow

        /** The send row of the review card. */
        data object SendAll : QuestionRow
    }

    private fun questionRows(deck: QuestionDeck): List<QuestionRow> {
        if (deck.onReview) {
            return buildList {
                (0 until deck.questionCount).forEach { add(QuestionRow.Review(it)) }
                add(QuestionRow.SendAll)
            }
        }
        val item = deck.flow.payload.items[deck.index]
        return buildList {
            item.options.indices.forEach { add(QuestionRow.Option(it)) }
            if (item.allowFreeText) add(QuestionRow.AnswerBox)
            if (deck.hasReview) add(QuestionRow.Next) else add(QuestionRow.Send)
            if (deck.index > 0) add(QuestionRow.Previous)
        }
    }

    fun questionCard(flow: QuestionFlow): NexusCard {
        val deck = screen.questionDeck?.takeIf { it.flow === flow } ?: QuestionDeck(flow)
        val rows = questionRows(deck)
        val selected = screen.questionRow.coerceIn(0, rows.lastIndex)
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == flow.sessionKey }
        val heading = session?.displayTitle?.singleLine(100) ?: flow.payload.source
        return if (deck.onReview) {
            reviewCard(deck, rows, selected, heading)
        } else {
            questionPageCard(deck, rows, selected, heading)
        }
    }

    private fun questionPageCard(deck: QuestionDeck, rows: List<QuestionRow>, selected: Int, heading: String): NexusCard {
        val flow = deck.flow
        val page = deck.index
        val item = flow.payload.items[page]
        val lines = BoardCards.windowedRowGroups(rows, selected) { row, isSelected ->
            if (row == QuestionRow.AnswerBox) return@windowedRowGroups answerBoxLines(flow.freeText(page), isSelected)
            listOf(
                when (row) {
                    is QuestionRow.Option -> {
                        val picked = flow.isPicked(page, row.index)
                        val mark = when {
                            item.multiSelect -> if (picked) "[x] " else "[ ] "
                            else -> if (picked) "(x) " else "( ) "
                        }
                        val option = item.options[row.index]
                        NexusCardLine(
                            text = (mark + option.label).singleLine(BoardCards.MENU_LINE_CHARS),
                            sub = option.description?.singleLine(BoardCards.MENU_LINE_CHARS),
                            tone = if (picked) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                            selected = isSelected,
                        )
                    }
                    QuestionRow.Next -> NexusCardLine(text = NEXT_QUESTION, selected = isSelected)
                    QuestionRow.Previous ->
                        NexusCardLine(text = PREVIOUS_QUESTION, tone = NexusRowTone.DIM, selected = isSelected)
                    QuestionRow.Send -> sendLine(SEND_ANSWER, deck.canSend, isSelected)
                    else -> error("not on a question card: $row")
                },
            )
        }
        return BoardCards.card(
            title = if (flow.itemCount > 1) "Q${page + 1}/${flow.itemCount} · $heading" else heading,
            subtitle = item.text.singleLine(BoardCards.MENU_LINE_CHARS),
            rows = lines,
            footer = if (page > 0) "swipe move · tap pick · 2-tap previous" else "swipe move · tap pick · 2-tap close",
        )
    }

    /** One row per question, its whole answer (R123), then Send answers. */
    private fun reviewCard(deck: QuestionDeck, rows: List<QuestionRow>, selected: Int, heading: String): NexusCard {
        val lines = BoardCards.windowedRowGroups(rows, selected) { row, isSelected ->
            when (row) {
                is QuestionRow.Review -> {
                    val parts = VoiceCard.bodyRows(deck.reviewLine(row.question))
                    val answered = deck.flow.isAnswered(row.question)
                    buildList {
                        add(
                            NexusCardLine(
                                text = parts.first(),
                                tone = if (answered) NexusRowTone.NORMAL else NexusRowTone.ALERT,
                                selected = isSelected,
                            ),
                        )
                        parts.drop(1).forEach { add(NexusCardLine(text = it, tone = NexusRowTone.BODY)) }
                    }
                }
                QuestionRow.SendAll -> listOf(sendLine(SEND_ANSWERS, deck.canSend, isSelected))
                else -> error("not on the review card: $row")
            }
        }
        return BoardCards.card(
            title = REVIEW_ANSWERS,
            subtitle = heading,
            rows = lines,
            footer = "swipe move · tap open · 2-tap previous",
        )
    }

    private fun sendLine(text: String, answered: Boolean, selected: Boolean): NexusCardLine {
        val ready = host.secure && answered
        return NexusCardLine(
            text = text,
            sub = when {
                !host.secure -> AlertCoordinator.NOT_CONNECTED
                !answered -> "answer every question first"
                else -> null
            },
            tone = if (ready) NexusRowTone.NORMAL else NexusRowTone.DIM,
            selected = selected,
        )
    }

    /** The answer box shows the answer condensed as the heard card did; Send answer sends all of it. */
    private fun answerBoxLines(text: String?, selected: Boolean): List<NexusCardLine> {
        val review = text?.let { VoiceCard.review(it, host.voiceWordLimit) }
        val parts = review?.let { VoiceCard.bodyRows(it.body) }.orEmpty()
        return buildList {
            add(
                NexusCardLine(
                    text = "Answer box (voice)",
                    sub = review?.lead ?: parts.firstOrNull() ?: "tap to speak",
                    tone = if (text != null) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                    selected = selected,
                ),
            )
            parts.drop(if (review?.lead != null) 0 else 1).forEach { add(NexusCardLine(text = it, tone = NexusRowTone.BODY)) }
        }
    }

    fun onQuestionInput(flow: QuestionFlow, event: NexusInputEvent) {
        val deck = screen.questionDeck?.takeIf { it.flow === flow } ?: return
        val rows = questionRows(deck)
        when {
            event.keyCode in GlassesKeys.BACKWARD -> {
                screen.questionRow = (screen.questionRow.coerceIn(0, rows.lastIndex) - 1 + rows.size) % rows.size
                host.render()
            }
            event.keyCode in GlassesKeys.FORWARD -> {
                screen.questionRow = (screen.questionRow.coerceIn(0, rows.lastIndex) + 1) % rows.size
                host.render()
            }
            GlassesKeys.isEnter(event) ->
                onQuestionPick(deck, rows[screen.questionRow.coerceIn(0, rows.lastIndex)])
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                if (deck.previous()) {
                    openCard()
                } else {
                    screen.close(ActiveCard.Kind.QUESTION)
                    host.render()
                }
            }
        }
    }

    /** A new card of the deck: the selection starts at its top, and a tap aimed at the old one cannot land on it. */
    private fun openCard() {
        screen.questionRow = 0
        screen.rearm()
        host.render()
    }

    private fun onQuestionPick(deck: QuestionDeck, row: QuestionRow) {
        val flow = deck.flow
        when (row) {
            is QuestionRow.Option -> {
                flow.toggle(deck.index, row.index)
                host.render()
            }
            QuestionRow.AnswerBox -> startVoice(VoiceTarget.Answer(flow.alertId, deck.index))
            QuestionRow.Next -> if (deck.next()) openCard()
            QuestionRow.Previous -> if (deck.previous()) openCard()
            is QuestionRow.Review -> {
                deck.jump(row.question)
                openCard()
            }
            QuestionRow.Send, QuestionRow.SendAll -> {
                if (!host.secure) {
                    host.brief(AlertCoordinator.NOT_SENT, AlertCoordinator.NOT_CONNECTED, safety = true)
                    return
                }
                val answers = flow.answers() ?: return
                screen.close(ActiveCard.Kind.QUESTION)
                host.render()
                // The coordinator only lets a card that is still bound answer.
                AgentsRuntime.alertDirector?.onQuestionConfirm(flow.alertId, answers)
            }
        }
    }

    private companion object {
        const val NEXT_QUESTION = "Next question ›"
        const val PREVIOUS_QUESTION = "‹ Previous question"
        const val REVIEW_ANSWERS = "Review answers"
        const val SEND_ANSWER = "Send answer"
        const val SEND_ANSWERS = "Send answers"
    }
}
