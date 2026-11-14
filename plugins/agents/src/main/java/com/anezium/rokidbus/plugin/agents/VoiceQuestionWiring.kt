package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
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
    data class Approval(val alertId: String) : VoiceTarget
}

/** One utterance: its target, the state machine over the hub's callbacks, and where the card's selection is. */
internal class VoiceRun(val target: VoiceTarget) {
    val capture = VoiceCapture()
    var row = 0

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
    private fun voiceChanged(run: VoiceRun) {
        run.row = VoiceCard.view(run.kind, run.capture.state).initial
        screen.rearm()
        if (host.surfaceShown) host.render()
    }

    fun onVoiceInput(run: VoiceRun, event: NexusInputEvent) {
        val view = VoiceCard.view(run.kind, run.capture.state)
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
                screen.questionFlow?.takeIf { it.alertId == target.alertId }?.setFreeText(target.itemIndex, text)
                screen.stopVoice()
                host.render()
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
        val view = VoiceCard.view(run.kind, state)
        val rows = buildList {
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

    // --------------------------------------------------------------- question

    private sealed interface QuestionRow {
        data class Option(val index: Int) : QuestionRow
        data object AnswerBox : QuestionRow
        data object Next : QuestionRow
        data object Send : QuestionRow
    }

    private fun questionRows(flow: QuestionFlow, page: Int): List<QuestionRow> {
        val item = flow.payload.items[page]
        return buildList {
            item.options.indices.forEach { add(QuestionRow.Option(it)) }
            if (item.allowFreeText) add(QuestionRow.AnswerBox)
            add(if (page == flow.itemCount - 1) QuestionRow.Send else QuestionRow.Next)
        }
    }

    fun questionCard(flow: QuestionFlow): NexusCard {
        val page = screen.questionPage.coerceIn(0, flow.itemCount - 1)
        val item = flow.payload.items[page]
        val secure = host.secure
        val rows = questionRows(flow, page)
        val selected = screen.questionRow.coerceIn(0, rows.lastIndex)
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == flow.sessionKey }
        val lines = BoardCards.windowedRowGroups(rows, selected) { row, isSelected ->
            if (row == QuestionRow.AnswerBox) return@windowedRowGroups answerBoxLines(flow.freeText(page), isSelected)
            val line = when (row) {
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
                QuestionRow.AnswerBox -> error("drawn by answerBoxLines")
                QuestionRow.Next -> NexusCardLine(
                    text = "Next question",
                    sub = if (flow.isAnswered(page)) null else "answer this one first",
                    tone = if (flow.isAnswered(page)) NexusRowTone.NORMAL else NexusRowTone.DIM,
                    selected = isSelected,
                )
                QuestionRow.Send -> NexusCardLine(
                    text = "Send answer",
                    sub = when {
                        !secure -> AlertNotices.MONITOR_ONLY_BODY
                        flow.answers() == null -> "answer every question first"
                        else -> null
                    },
                    tone = if (secure && flow.answers() != null) NexusRowTone.NORMAL else NexusRowTone.DIM,
                    selected = isSelected,
                )
            }
            listOf(line)
        }
        val heading = session?.displayTitle?.singleLine(100) ?: flow.payload.source
        return BoardCards.card(
            title = if (flow.itemCount > 1) "Q${page + 1}/${flow.itemCount} · $heading" else heading,
            subtitle = item.text.singleLine(BoardCards.MENU_LINE_CHARS),
            rows = lines,
            footer = if (page > 0) "swipe move · tap pick · 2-tap previous" else "swipe move · tap pick · 2-tap close",
        )
    }

    /** The answer box shows the whole answer that Send answer sends, over as many BODY rows as it takes (R123). */
    private fun answerBoxLines(text: String?, selected: Boolean): List<NexusCardLine> {
        val parts = text?.let(VoiceCard::bodyRows).orEmpty()
        return buildList {
            add(
                NexusCardLine(
                    text = "Answer box (voice)",
                    sub = parts.firstOrNull() ?: "tap to speak",
                    tone = if (text != null) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                    selected = selected,
                ),
            )
            parts.drop(1).forEach { add(NexusCardLine(text = it, tone = NexusRowTone.BODY)) }
        }
    }

    fun onQuestionInput(flow: QuestionFlow, event: NexusInputEvent) {
        val page = screen.questionPage.coerceIn(0, flow.itemCount - 1)
        val rows = questionRows(flow, page)
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
                onQuestionPick(flow, page, rows[screen.questionRow.coerceIn(0, rows.lastIndex)])
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                if (page > 0) {
                    screen.questionPage = page - 1
                    screen.questionRow = 0
                    screen.rearm()
                } else {
                    screen.close(ActiveCard.Kind.QUESTION)
                }
                host.render()
            }
        }
    }

    private fun onQuestionPick(flow: QuestionFlow, page: Int, row: QuestionRow) {
        when (row) {
            is QuestionRow.Option -> {
                flow.toggle(page, row.index)
                host.render()
            }
            QuestionRow.AnswerBox -> startVoice(VoiceTarget.Answer(flow.alertId, page))
            QuestionRow.Next -> if (flow.isAnswered(page)) {
                screen.questionPage = page + 1
                screen.questionRow = 0
                screen.rearm()
                host.render()
            }
            QuestionRow.Send -> {
                if (!host.secure) {
                    host.brief(AlertCoordinator.MONITOR_ONLY_TITLE, AlertCoordinator.MONITOR_ONLY_BODY, safety = true)
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
}
