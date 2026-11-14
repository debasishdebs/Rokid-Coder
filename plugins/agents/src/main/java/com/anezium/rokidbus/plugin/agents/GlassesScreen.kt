package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.shared.plugin.NexusInputEvent

/**
 * The one owner of what is on the glasses screen (R103, R104): the [ActiveCard],
 * the data of every card that may be open, the input router and whether the band
 * up now is a v2 alert's. Input goes to the card [ActiveCard] says is on screen,
 * never to whichever card happens to hold data, and an ENTER only reaches a card
 * once its guard has run out. Helpers build cards and ask this to open them; none
 * keeps a guard of its own.
 */
internal class GlassesScreen(
    private val clock: () -> Long,
    guardMs: Long,
    private val host: Host,
) {
    /** What the screen needs from the service: the link, a redraw, and where each card's input and confirm go. */
    interface Host {
        val secure: Boolean
        fun render()

        /** A card or an alert took the screen from the menu: whatever the menu was waiting for ends. */
        fun menuCovered() = Unit
        fun voiceInput(run: VoiceRun, event: NexusInputEvent)
        fun questionInput(flow: QuestionFlow, event: NexusInputEvent)
        fun menuInput(event: NexusInputEvent)

        /** The board, the launcher or an open conversation: the screens with no confirm of their own. */
        fun boardInput(event: NexusInputEvent)
        fun startVoice(target: VoiceTarget)

        /** The alert decision card's answer; the coordinator only lets a card that is still bound answer. */
        fun confirmAlert(alertId: String, action: String)

        /** Sends the decision for a held tool call; false when the call is gone and nothing was sent. */
        fun decideRequest(requestId: String, decision: ApprovalDecision): Boolean
    }

    private val active = ActiveCard(guardMs)

    val kind: ActiveCard.Kind get() = active.kind

    /**
     * True while the band this plugin last put up is a v2 alert's. The notice
     * callbacks carry no identity, so a band of any other kind (the v1 status
     * band, a brief) clears it, and the callbacks then mean what they always did.
     */
    var v2BandUp = false
        private set

    /** The alert whose decision card is open, bound by id so a late confirm cannot answer another. */
    var decidingAlert: AgentdAction.Alert? = null
        private set

    /** The row of the alert decision card: 0 Allow, 1 Deny, 2 Say allow or deny. */
    var alertRow = 0
        private set

    /** The held tool call the wearer is answering, if they are answering one. */
    var decidingRequestId: String? = null
        private set
    var decisionChoice = ApprovalDecision.ALLOW
        private set

    /**
     * The one utterance in flight or on screen, if any: a follow-up reply, a free-text
     * answer of the question card, or a voice approval. It is dropped, and its speech
     * session stopped, the moment the thing it was for stops being answerable.
     */
    var voice: VoiceRun? = null
        private set

    /** The question card's state: answers per item, one item per page, bound to its alert by id. */
    var questionFlow: QuestionFlow? = null
        private set
    var questionPage = 0
    var questionRow = 0

    /**
     * The session key the wearer is typing a reply for, if they opened the
     * field, and the session id the reply goes to.
     */
    var replyTargetKey: String? = null
        private set
    var replySessionId: String? = null
        private set

    /**
     * The per-session control menu behind ENTER on a board row. It stays under
     * any card that covers it and comes back on Main when that card closes (R96);
     * [menuReading] is the reader a long row opens.
     */
    var menu: ControlMenu.MenuState? = null
    var menuReading: Pair<String, String>? = null

    // ---------------------------------------------------------------- cards

    /**
     * Puts [kind] on the glasses screen and clears every other card's data and
     * confirm state (R104). A card that is the parent of a [child] stays bound,
     * hidden under it, and gets the screen back when the child closes.
     */
    fun open(kind: ActiveCard.Kind, child: Boolean = false) {
        val parent = if (child) active.kind else ActiveCard.Kind.NONE
        if (kind != ActiveCard.Kind.VOICE) stopVoice()
        if (kind != ActiveCard.Kind.QUESTION && parent != ActiveCard.Kind.QUESTION) questionFlow = null
        if (kind != ActiveCard.Kind.ALERT_DECISION && parent != ActiveCard.Kind.ALERT_DECISION) decidingAlert = null
        if (kind != ActiveCard.Kind.REQUEST_DECISION && parent != ActiveCard.Kind.REQUEST_DECISION) {
            decidingRequestId = null
        }
        if (kind != ActiveCard.Kind.REPLY) {
            replyTargetKey = null
            replySessionId = null
        }
        coverMenu()
        val now = clock()
        if (child) active.openChild(kind, now) else active.open(kind, now)
    }

    /** Closes one card and its data; the screen goes to the card under it, if it was a child. */
    fun close(kind: ActiveCard.Kind) {
        when (kind) {
            ActiveCard.Kind.QUESTION -> questionFlow = null
            ActiveCard.Kind.ALERT_DECISION -> decidingAlert = null
            ActiveCard.Kind.REQUEST_DECISION -> decidingRequestId = null
            ActiveCard.Kind.REPLY -> {
                replyTargetKey = null
                replySessionId = null
            }
            ActiveCard.Kind.MENU -> {
                menu = null
                menuReading = null
            }
            ActiveCard.Kind.VOICE, ActiveCard.Kind.NONE -> Unit
        }
        active.close(kind, clock())
    }

    /** Nothing is on the screen any more: every card, the menu under them included, is gone. */
    fun clear() {
        open(ActiveCard.Kind.NONE)
        close(ActiveCard.Kind.MENU)
    }

    /** The card changed what it shows: a tap aimed at the old picture must not land on the new one. */
    fun rearm() = active.rearm(clock())

    fun openAlertDecision(alert: AgentdAction.Alert) {
        open(ActiveCard.Kind.ALERT_DECISION)
        decidingAlert = alert
        alertRow = 0
    }

    fun openRequestDecision(requestId: String) {
        open(ActiveCard.Kind.REQUEST_DECISION)
        decidingRequestId = requestId
        decisionChoice = ApprovalDecision.ALLOW
    }

    fun openQuestion(flow: QuestionFlow) {
        open(ActiveCard.Kind.QUESTION)
        questionFlow = flow
        questionPage = 0
        questionRow = 0
    }

    fun openReply(sessionKey: String, sessionId: String) {
        open(ActiveCard.Kind.REPLY)
        replyTargetKey = sessionKey
        replySessionId = sessionId
    }

    fun openMenu(state: ControlMenu.MenuState) {
        open(ActiveCard.Kind.MENU)
        menu = state
    }

    /** A new screen of the menu: ENTER waits out the guard again. */
    fun showMenu(state: ControlMenu.MenuState) {
        menu = state
        rearm()
    }

    /**
     * The menu is being drawn. One that a card or an alert covered starts its
     * guard now that it is on screen again, as the menu card once more.
     */
    fun menuDrawn(state: ControlMenu.MenuState): ControlMenu.MenuState {
        if (active.kind == ActiveCard.Kind.NONE) {
            active.open(ActiveCard.Kind.MENU, clock())
        } else if (state.rearm) {
            rearm()
        }
        if (!state.rearm) return state
        return state.copy(rearm = false).also { menu = it }
    }

    /** One tap-to-talk utterance over the card that asked for it. */
    fun openVoice(run: VoiceRun) {
        open(ActiveCard.Kind.VOICE, child = true)
        voice = run
    }

    /** Ends the utterance for good: whatever the hub still delivers for it is dropped. */
    fun stopVoice() {
        val run = voice ?: return
        voice = null
        // Invalidating also stops the session, now if it is live and on its start if it is not.
        run.capture.invalidate()
        active.close(ActiveCard.Kind.VOICE, clock())
    }

    /**
     * A decision, reply, question or reader card, or an alert, takes the screen
     * (R96): the menu forgets any confirm and any reader, and its guard starts
     * over when it is drawn again.
     */
    private fun coverMenu() {
        menuReading = null
        host.menuCovered()
        menu = menu?.let(ControlMenu::covered)
    }

    // ----------------------------------------------------------------- band

    /** A v2 alert's band ([v2]) or any other band was taken by the hub. */
    fun bandTaken(v2: Boolean) {
        v2BandUp = v2
        // An alert took the screen's attention: no confirm survives it (R96).
        if (v2) coverMenu()
    }

    /** This plugin hid its own v2 band. */
    fun bandHidden() {
        v2BandUp = false
    }

    fun noticeClosed(
        reason: NexusNoticeCloseReason,
        band: (NexusNoticeCloseReason) -> Unit,
        brief: (NexusNoticeCloseReason) -> Unit,
    ) {
        routeNoticeClose(reason, v2BandUp, clearV2 = { v2BandUp = false }, band = band, brief = brief)
    }

    // ---------------------------------------------------------------- input

    /** Every key the glasses send this plugin's screen goes to the card on it, and only to it. */
    fun onInput(event: NexusInputEvent) {
        if (event.action != KeyEvent.ACTION_DOWN) return
        val kind = active.kind
        // The tail of a double tap aimed at something else never confirms on the card on screen.
        if (GlassesKeys.isEnter(event) && kind in GUARDED && !active.accepts(kind, clock())) return
        when (kind) {
            ActiveCard.Kind.VOICE -> voice?.let { host.voiceInput(it, event) }
            ActiveCard.Kind.QUESTION -> questionFlow?.let { host.questionInput(it, event) }
            ActiveCard.Kind.ALERT_DECISION -> decidingAlert?.let { onAlertDecisionInput(it, event) }
            ActiveCard.Kind.REQUEST_DECISION -> decidingRequestId?.let { onRequestDecisionInput(it, event) }
            ActiveCard.Kind.REPLY -> Unit
            ActiveCard.Kind.MENU -> host.menuInput(event)
            ActiveCard.Kind.NONE -> host.boardInput(event)
        }
    }

    private fun onRequestDecisionInput(requestId: String, event: NexusInputEvent) {
        when {
            event.keyCode in GlassesKeys.BACKWARD || event.keyCode in GlassesKeys.FORWARD -> {
                decisionChoice = when (decisionChoice) {
                    ApprovalDecision.ALLOW -> ApprovalDecision.DENY
                    ApprovalDecision.DENY -> ApprovalDecision.ALLOW
                }
                host.render()
            }
            GlassesKeys.isEnter(event) -> {
                if (!host.decideRequest(requestId, decisionChoice)) return
                close(ActiveCard.Kind.REQUEST_DECISION)
                host.render()
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                close(ActiveCard.Kind.REQUEST_DECISION)
                host.render()
            }
        }
    }

    /** The alert's decision card walks three rows: Allow, Deny and, on a steering link, the voice row. */
    private fun onAlertDecisionInput(alert: AgentdAction.Alert, event: NexusInputEvent) {
        val rows = if (host.secure) ALERT_DECISION_ROWS else 2
        when {
            event.keyCode in GlassesKeys.BACKWARD -> {
                alertRow = (alertRow - 1 + rows) % rows
                host.render()
            }
            event.keyCode in GlassesKeys.FORWARD -> {
                alertRow = (alertRow + 1) % rows
                host.render()
            }
            GlassesKeys.isEnter(event) -> {
                if (alertRow == VOICE_ROW) {
                    // Hearing is not deciding: the utterance still needs its own confirm card.
                    if (host.secure) host.startVoice(VoiceTarget.Approval(alert.id))
                    return
                }
                close(ActiveCard.Kind.ALERT_DECISION)
                host.render()
                host.confirmAlert(alert.id, if (alertRow == 0) AlertCoordinator.ALLOW else AlertCoordinator.DENY)
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                close(ActiveCard.Kind.ALERT_DECISION)
                host.render()
            }
        }
    }

    companion object {
        const val ALERT_DECISION_ROWS = 3
        const val VOICE_ROW = 2

        /** The cards whose ENTER confirms or picks something, and so waits out the guard. */
        private val GUARDED = setOf(
            ActiveCard.Kind.VOICE,
            ActiveCard.Kind.QUESTION,
            ActiveCard.Kind.ALERT_DECISION,
            ActiveCard.Kind.REQUEST_DECISION,
            ActiveCard.Kind.MENU,
        )
    }
}

/** Touchpad swipes come in as LEFT/RIGHT, the ring as UP/DOWN. */
internal object GlassesKeys {
    val FORWARD = setOf(
        KeyEvent.KEYCODE_DPAD_RIGHT,
        KeyEvent.KEYCODE_DPAD_DOWN,
        KeyEvent.KEYCODE_MEDIA_NEXT,
    )
    val BACKWARD = setOf(
        KeyEvent.KEYCODE_DPAD_LEFT,
        KeyEvent.KEYCODE_DPAD_UP,
        KeyEvent.KEYCODE_MEDIA_PREVIOUS,
    )

    fun isEnter(event: NexusInputEvent): Boolean =
        event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
}
