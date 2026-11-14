package com.anezium.rokidbus.plugin.agents

import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusPluginService
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechSession
import com.anezium.rokidbus.client.plugin.NexusSurfaceSession
import com.anezium.rokidbus.client.plugin.NexusTtsCallbacks
import com.anezium.rokidbus.client.plugin.NexusTtsDoneReason
import com.anezium.rokidbus.client.plugin.NexusTtsSession
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.EditableSurfaceField
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.util.UUID

@OptIn(ExperimentalCoroutinesApi::class)
class AgentsPluginService : NexusPluginService(), AlertGlasses {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val attention by lazy {
        AttentionDecisionEngine(
            readFingerprint = configStore::notificationFingerprint,
            writeFingerprint = configStore::saveNotificationFingerprint,
        )
    }
    private val dnd by lazy { InterruptionFilterReader(applicationContext) }
    private var surface: NexusSurfaceSession? = null
    private var surfaceShown = false

    /**
     * The spoken cue's session, made on the first cue. The hub releases it when
     * the surface closes, so a refused speak drops it and the next cue makes
     * a fresh one. [glassesVolume] and [glassesWorn] are what the hub last said
     * about the glasses; null until it says anything.
     */
    private var tts: NexusTtsSession? = null
    private var glassesVolume: Int? = null
    private var glassesWorn: Boolean? = null

    /**
     * The wearer's place in the list is a session, not a row number: the board
     * re-sorts itself under them as agents work, so a positional cursor would
     * quietly drift onto a different session between looking and pressing.
     */
    private var selectedKey: String? = null

    /** The session the last band was about, so a tap lands on it. */
    private var noticeTargetKey: String? = null

    private var ageTicker: Job? = null

    /**
     * Progress on the board is pushed once a minute rather than on every tool
     * call; what the wearer would act on goes at once (see [DigestGate]).
     * [lastPushedBoard] is the session list the glasses last showed, and
     * [boardSessions] is set by [sessionsCard] so [render] knows it just built
     * the board rather than some other screen.
     */
    private val digestGate = DigestGate(SystemClock::elapsedRealtime, AlertSettings.DEFAULT_DIGEST_MS)
    private var lastPushedBoard: List<AgentSession>? = null
    private var boardSessions: List<AgentSession>? = null
    private var digestFlush: Job? = null
    private var lastConnections: Map<AgentProvider, ProviderConnectionState>? = null
    private var lastConversation: AgentConversation? = null

    private val secureLink: Boolean get() = AgentsRuntime.link.value?.secure == true

    /** What is on the glasses screen, and where its input goes (R103, R104). */
    private val screen = GlassesScreen(
        clock = System::currentTimeMillis,
        guardMs = DECISION_GUARD_MS,
        host = object : GlassesScreen.Host {
            override val secure: Boolean get() = secureLink
            override fun render() = render(show = false)
            override fun menuCovered() {
                modelsTimeout?.cancel()
            }
            override fun voiceInput(run: VoiceRun, event: NexusInputEvent) = answers.onVoiceInput(run, event)
            override fun questionInput(flow: QuestionFlow, event: NexusInputEvent) =
                answers.onQuestionInput(flow, event)
            override fun menuInput(event: NexusInputEvent) = onMenuInput(event)
            override fun boardInput(event: NexusInputEvent) = onBoardInput(event)
            override fun startVoice(target: VoiceTarget) = answers.startVoice(target)
            override fun confirmAlert(alertId: String, action: String) {
                AgentsRuntime.alertDirector?.onCardConfirm(alertId, action)
            }
            override fun decideRequest(requestId: String, decision: ApprovalDecision): Boolean {
                if (AgentsRuntime.store.approvals.value.none { it.requestId == requestId }) return false
                AgentsMonitorService.decideApproval(applicationContext, requestId, decision)
                return true
            }
        },
    )

    /** The voice card and the question card. */
    private val answers: VoiceQuestionWiring by lazy {
        VoiceQuestionWiring(
            screen,
            object : VoiceQuestionWiring.Host {
                override val surfaceShown: Boolean get() = this@AgentsPluginService.surfaceShown
                override val secure: Boolean get() = secureLink
                override fun render() = render(show = false)
                override fun speechSession(callbacks: NexusSpeechCallbacks): NexusSpeechSession? =
                    nexusSpeechSession(callbacks)
                override fun sendFollowup(sessionKey: String, text: String) =
                    this@AgentsPluginService.sendFollowup(sessionKey, text)
                override fun brief(title: String, body: String, safety: Boolean) =
                    showBriefNotice(title, body, safety)
            },
        )
    }

    private val band by lazy { AlertBand({ nexusClient }, screen, attention) }

    /** The Done or error alert whose summary heads the open conversation. */
    private var outputAlert: AgentdAction.Alert? = null

    /**
     * The reply field is bound to an attempt counter because the board can
     * re-sort, or the session can finish, while the wearer is still composing —
     * a rejection or a stale send must not land on whatever the field happens to
     * mean by then.
     */
    private var replyAttempt = 0
    private var pendingReplyRequestId: String? = null

    /**
     * [controlMsgIds] are the steering frames the control menu sent, so an ack
     * is only reported for what the wearer asked there.
     */
    private var modelsTimeout: Job? = null
    private val controlMsgIds = ArrayDeque<String>()

    /** The mode_set frames among them, with their session: a rejection of one is shown on that session's menu. */
    private val modeSetMsgIds = LinkedHashMap<String, String>()

    /** The follow-ups this phone sent, by msgId, so a rejection lands on the session's menu (R106). */
    private val followupMsgIds = LinkedHashMap<String, String>()

    /**
     * Set the instant a reply is sent, cleared the instant something real says
     * so — the daemon's own "working" status, a failure notice, or simply
     * having waited long enough that lingering would be misleading. Without
     * this the wearer stares at an unchanged reader for however long it takes
     * agentd's hook to notice the prompt, which is exactly the gap that reads
     * as "did this do anything at all?"
     */
    private var awaitingReplyForKey: String? = null

    /**
     * The start-an-agent walk: computer, then project, then the project's
     * threads. These lists are stable while open, so a positional cursor is
     * safe here — unlike on the board.
     */
    private var launch: Launch? = null
    private var launchIndex = 0
    private var launchNote: String? = null
    private var launchRequestId: String? = null

    /**
     * Runs only while the open conversation's session is actually working, so
     * the wearer sees something moving instead of wondering whether a reply
     * they just sent landed at all. Off the rest of the time — cycling a verb
     * on a session nobody is reading would just be bus traffic nobody sees.
     */
    private var thinkingTicker: Job? = null
    private var thinkingVerbIndex = 0

    private sealed interface Launch {
        data object Computers : Launch
        data class Projects(val machineId: String, val machineName: String) : Launch
        data class Threads(
            val machineId: String,
            val machineName: String,
            val project: AgentProject,
        ) : Launch
    }

    override fun onCreate() {
        super.onCreate()
        AgentsRuntime.alertGlasses = this
        serviceScope.launch {
            combine(
                AgentsRuntime.store.sessions,
                AgentsRuntime.store.connections,
                AgentsRuntime.store.conversation,
            ) { _, connections, conversation -> connections to conversation }
                .collectLatest { (connections, conversation) ->
                    // A busy agent changes state on every tool call, and each
                    // change used to redraw the glasses immediately: watching
                    // one work made the board flicker continuously. Settling
                    // coalesces a burst into one redraw, and the digest gate
                    // then holds plain progress to one push a minute. A link
                    // or conversation change is not progress: it goes at once.
                    delay(RENDER_SETTLE_MS)
                    val sessionsOnly = connections == lastConnections && conversation == lastConversation
                    lastConnections = connections
                    lastConversation = conversation
                    if (surfaceShown) render(show = false, digest = sessionsOnly)
                    syncThinkingTicker()
                }
        }
        serviceScope.launch {
            // `+N waiting` is the coordinator's count, not the sessions', so it
            // redraws the board by itself as soon as the count moves.
            AgentsRuntime.alertDirectors
                .flatMapLatest { it?.waiting ?: flowOf(0) }
                .distinctUntilChanged()
                .collect { if (surfaceShown) render(show = false) }
        }
        serviceScope.launch {
            // Attention follows sessions alone. It used to ride the combined
            // flow above, so a computer that was simply unreachable — its
            // client cycling connecting/disconnected — re-raised the band on
            // every flip, which on the glasses reads as a screen that will not
            // stop blinking. Whether a session needs the wearer has nothing to
            // do with whether the daemon is currently answering.
            AgentsRuntime.store.sessions.collectLatest { raiseAttention() }
        }
        serviceScope.launch {
            // A reply for a session that left the board would send into nothing.
            AgentsRuntime.store.sessions.collect { sessions ->
                val target = screen.voice?.target as? VoiceTarget.Followup ?: return@collect
                if (sessions.none { it.key == target.sessionKey }) {
                    screen.stopVoice()
                    if (surfaceShown) render(show = false)
                }
            }
        }
        serviceScope.launch {
            AgentsRuntime.store.threadStart.collectLatest { result ->
                if (result != null && result.requestId == launchRequestId) {
                    launchRequestId = null
                    launchNote = if (result.ok) {
                        "started · it joins the list as it reports in"
                    } else {
                        result.error ?: "the computer could not start it"
                    }
                    if (surfaceShown) render(show = false)
                }
            }
        }
        serviceScope.launch {
            AgentsRuntime.events.collect(::onAgentdEvent)
        }
        serviceScope.launch {
            AgentsRuntime.store.sessionInputResult.collectLatest { result ->
                if (result == null || result.requestId != pendingReplyRequestId) return@collectLatest
                pendingReplyRequestId = null
                if (!result.ok) {
                    awaitingReplyForKey = null
                    syncThinkingTicker()
                    showBriefNotice("Reply not sent", result.error ?: "couldn't reach that session")
                }
            }
        }
        serviceScope.launch {
            AgentsRuntime.linkedMachines.collect { machineName ->
                showBriefNotice("Computer linked", "$machineName · its sessions appear here")
            }
        }
    }

    override fun onNexusOpen() {
        surface = nexusSurfaceSession(SURFACE_ID)
        surfaceShown = true
        AgentsRuntime.hudOpen = true
        screen.surfaceOpened()
        render(show = true)
        ageTicker?.cancel()
        ageTicker = serviceScope.launch {
            while (isActive) {
                delay(AGE_TICK_MS)
                // The minute tick also keeps a non-v2 row's age honest, which the gate would otherwise hold.
                if (surfaceShown) {
                    render(
                        show = false,
                        digest = AgentsRuntime.store.sessions.value.none(BoardModel::showsAge),
                    )
                }
            }
        }
        if (configStore.load().shouldMonitor) {
            AgentsMonitorService.reconcile(applicationContext)
        }
    }

    override fun onNexusLinkState(state: Int) {
        glassesWorn = AlertSoundPolicy.wornAfter(glassesWorn, state)
    }

    override fun onNexusMessage(path: String, id: String, payload: JSONObject) {
        if (path == BusPaths.GLASSES_DEVICE_INFO) {
            AlertSoundPolicy.volumeFrom(payload)?.let { glassesVolume = it }
        }
    }

    override fun onNexusClose() {
        tts = null
        ageTicker?.cancel()
        ageTicker = null
        digestFlush?.cancel()
        digestFlush = null
        lastPushedBoard = null
        thinkingTicker?.cancel()
        thinkingTicker = null
        awaitingReplyForKey = null
        surfaceShown = false
        AgentsRuntime.hudOpen = false
        screen.clear()
        leaveConversation()
        launch = null
        launchNote = null
        surface?.hide()
        surface = null
    }

    override fun onNexusInput(event: NexusInputEvent) = screen.onInput(event)

    /** The board, the launcher and an open conversation: no card of theirs is on screen. */
    private fun onBoardInput(event: NexusInputEvent) {
        val conversation = AgentsRuntime.store.conversation.value
        if (conversation == null && launch != null) {
            onLaunchInput(event)
            return
        }
        // A touchpad swipe arrives as LEFT/RIGHT, the ring as UP/DOWN: both
        // walk the same list, exactly as the other boards treat them. Inside a
        // conversation the hub owns the scroll and swipes never reach us.
        when {
            event.keyCode in GlassesKeys.BACKWARD -> if (conversation == null) moveSelection(-1)
            event.keyCode in GlassesKeys.FORWARD -> if (conversation == null) moveSelection(+1)
            GlassesKeys.isEnter(event) ->
                if (conversation == null) enterSelected() else onReplyRequested(conversation)
            event.keyCode == KeyEvent.KEYCODE_BACK ->
                if (conversation != null) {
                    leaveConversation()
                    render(show = false)
                } else {
                    surface?.hide()
                }
        }
    }

    /** A tap on the band means "show me": open the board on the session that rang. */
    override fun onNexusNoticeInput(event: NexusInputEvent) {
        if (event.action != KeyEvent.ACTION_DOWN) return
        if (!GlassesKeys.isEnter(event)) return
        screen.bandTouched()
        if (screen.v2BandUp) {
            AgentsRuntime.alertDirector?.onBandInput()
            return
        }
        noticeTargetKey?.let { selectedKey = it }
        if (!surfaceShown) attemptAdoption()
    }

    override fun onNexusNoticeAction(id: String) {
        screen.bandTouched()
        if (screen.v2BandUp)AgentsRuntime.alertDirector?.onBandAction(id)
    }

    /** Display evidence belongs to an alert's band; a brief or v1 attention band has no alert to credit. */
    override fun onNexusNoticeShown() {
        if (screen.v2BandUp) AgentsRuntime.alertDirector?.onBandShown()
    }

    override fun onNexusNoticeClosed(reason: NexusNoticeCloseReason) {
        val director = AgentsRuntime.alertDirector
        screen.noticeClosed(
            reason,
            band = { director?.onBandClosed(it) },
            // A brief's band ending: the next queued brief may show.
            brief = { director?.onBriefClosed(it) },
        )
    }

    override fun onDestroy() {
        tts?.close()
        tts = null
        if (AgentsRuntime.alertGlasses === this) AgentsRuntime.alertGlasses = null
        serviceScope.cancel()
        surfaceShown = false
        AgentsRuntime.hudOpen = false
        surface = null
        super.onDestroy()
    }

    // ----------------------------------------------------------------- alerts

    private fun raiseAttention() {
        band.raiseAttention()?.let { noticeTargetKey = it }
    }

    override fun showBand(notice: NexusNotice): Boolean = band.show(notice)

    override fun updateBand(update: NexusNoticeUpdate): Boolean = band.update(update)

    /**
     * The one sound Agents makes, and a nudge to look at the glasses, nothing
     * more: generic copy, never a session heading. The phone's Do Not Disturb is read
     * right here, right before the speech goes out, and an unreadable one counts as
     * quiet (R37). The coordinator only marks a fresh alert as a sound, so a retry
     * never speaks again. A refused speak is dropped silently: the band is up.
     */
    override fun speakCue(alert: AgentdAction.Alert) {
        val provider = AgentProvider.fromWire(alert.sessionKey.substringBefore(':')) ?: return
        val cue = AlertSoundPolicy.cue(alert.kind, provider) ?: return
        if (!AlertSoundPolicy.shouldSpeak(dnd.read(), configStore.isQuiet(), glassesVolume, glassesWorn)) return
        val session = tts ?: nexusTtsSession(
            object : NexusTtsCallbacks {
                override fun onTtsStarted(utteranceId: String) = Unit
                override fun onTtsDone(utteranceId: String, reason: NexusTtsDoneReason) = Unit
            },
        )?.also { tts = it } ?: return
        if (session.speak(cue) == NexusSdkResult.NOT_REGISTERED) tts = null
    }

    override fun hideBand() = band.hide()

    override fun brief(title: String, body: String) = band.briefNow(title, body)

    override fun briefLines(title: String, lines: List<String>) = band.briefLines(title, lines)

    /** What kept a v1 or OpenClaw attention waiting is gone: offer it again. */
    override fun slotFree() {
        serviceScope.launch { raiseAttention() }
    }

    override fun openOutput(alert: AgentdAction.Alert) {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
        if (session == null) {
            showBriefNotice(AlertCoordinator.NO_LONGER_WAITING, "that session is gone")
            return
        }
        outputAlert = alert
        showConversation(session)
    }

    override fun openDecision(alert: AgentdAction.Alert) {
        screen.openAlertDecision(alert)
        showBoard()
    }

    /** Answer opens the question card, one item per page, bound to the alert by id (R73). */
    override fun openQuestion(alert: AgentdAction.Alert) {
        val payload = alert.question
        if (payload == null) {
            showBriefNotice(AlertCoordinator.NO_LONGER_WAITING, AlertCoordinator.NO_LONGER_WAITING_BODY)
            return
        }
        // Never a card that would answer with altered or missing strings (R124).
        payload.refusal?.let { refusal ->
            showBriefNotice(QUESTION_REFUSED_TITLE, refusal, safety = true)
            return
        }
        screen.openQuestion(QuestionFlow(alert.id, alert.sessionKey, payload))
        showBoard()
    }

    /** What a card or an utterance was bound to is gone: close them, and stop listening for it. */
    override fun invalidate(alertId: String) {
        val voiceBound = when (val target = screen.voice?.target) {
            is VoiceTarget.Answer -> target.alertId == alertId
            is VoiceTarget.Approval -> target.alertId == alertId
            else -> false
        }
        val decisionBound = screen.decidingAlert?.id == alertId
        val questionBound = screen.questionFlow?.alertId == alertId
        if (!voiceBound && !decisionBound && !questionBound) return
        if (voiceBound) screen.stopVoice()
        if (decisionBound) screen.close(ActiveCard.Kind.ALERT_DECISION)
        if (questionBound) screen.close(ActiveCard.Kind.QUESTION)
        showBriefNotice(AlertCoordinator.NO_LONGER_WAITING, AlertCoordinator.NO_LONGER_WAITING_BODY)
        if (surfaceShown) render(show = false)
    }

    private fun showConversation(session: AgentSession) {
        // The reader takes the screen: no card under it may confirm (R104).
        screen.clear()
        selectedKey = session.key
        AgentsRuntime.store.openConversation(session)
        AgentsMonitorService.openDetail(applicationContext, session)
        showBoard()
    }

    /** Draws the board's current state, adopting the HUD first when it is idle. */
    private fun showBoard() {
        if (surfaceShown) render(show = false) else attemptAdoption()
    }

    // -------------------------------------------------------------- selection

    private fun moveSelection(delta: Int) {
        // Two virtual rows frame the sessions: the Quiet toggle above and the
        // start-an-agent door below. The ring walks a circle, so the door is
        // one tap UP from the Quiet row instead of the whole board away.
        selectedKey = BoardModel.step(
            AgentsRuntime.store.sessions.value.map { it.key },
            selectedKey,
            delta,
        )
        render(show = false)
    }

    /** ENTER means "deal with this": answer what is waiting, or read the rest. */
    private fun enterSelected() {
        val sessions = AgentsRuntime.store.sessions.value
        if (selectedKey == BoardModel.QUIET_KEY) {
            configStore.setQuiet(!configStore.isQuiet())
            render(show = false)
            return
        }
        if (selectedKey == BoardModel.START_KEY || sessions.isEmpty()) {
            launch = Launch.Computers
            launchIndex = 0
            launchNote = null
            render(show = false)
            return
        }
        val session = sessions.getOrNull(BoardCards.selectedIndexIn(sessions, selectedKey)) ?: return
        val approval = AgentsRuntime.store.approvalFor(session.key)
        when {
            approval != null -> {
                screen.openRequestDecision(approval.requestId, allowOffered = BoardCards.requestShowsWhole(approval))
                render(show = false)
            }
            // A session that speaks v2 is steered from its menu, and its conversation is the
            // menu's "Read output" row; one that does not has nothing to steer.
            session.v2 != null -> openMenu(session)
            else -> openConversation(session)
        }
    }

    /** The conversation takes the screen from the board, the menu or the launcher, which wait under it. */
    private fun openConversation(session: AgentSession) {
        screen.open(ActiveCard.Kind.NONE)
        AgentsRuntime.store.openConversation(session)
        AgentsMonitorService.openDetail(applicationContext, session)
        render(show = false)
    }

    private fun leaveConversation() {
        outputAlert = null
        if (AgentsRuntime.store.conversation.value == null) return
        AgentsRuntime.store.closeConversation()
        AgentsMonitorService.closeDetail(applicationContext)
    }

    // -------------------------------------------------------------------- reply

    /**
     * ENTER inside a conversation offers to type into that session's terminal
     * — the same `screen`/`tmux` typing agentd already does for the computer's
     * own keyboard, just triggered from the glasses. A turn in progress is not
     * waiting for anything, so this mirrors agentd's own refusal rather than
     * waiting for the round-trip to say so.
     */
    private fun onReplyRequested(conversation: AgentConversation) {
        val session = AgentsRuntime.store.sessions.value
            .firstOrNull { it.key == conversation.sessionKey }
            ?: return
        if (session.status == AgentStatus.WORKING) {
            showBriefNotice("Still working", "wait for it to stop before typing")
            return
        }
        beginReply(session)
    }

    /** Opens the editable reply card for [session]: typed on the glasses, sent as `session_input`. */
    private fun beginReply(session: AgentSession) {
        val client = nexusClient
        if (client?.supportsEditableSurface != true) {
            showBriefNotice("Can't type here", "this glasses hub is too old")
            return
        }
        val activeSurface = surface ?: return
        screen.openReply(session.key, session.id)
        val attempt = ++replyAttempt
        activeSurface.onRejected = { code -> onReplyRejected(attempt, code) }
        render(show = false)
    }

    private fun replyCard(session: AgentSession): NexusCard = NexusCard(
        title = "Reply",
        subtitle = session.displayTitle.singleLine(120),
        lines = emptyList(),
        editable = EditableSurfaceField(placeholder = "Type a reply…", submitLabel = "Send"),
    )

    private fun onReplyRejected(attempt: Int, code: String) {
        if (attempt != replyAttempt) return
        screen.close(ActiveCard.Kind.REPLY)
        showBriefNotice(
            "Can't type here",
            if (code == "SURFACE_BUSY") "the screen is busy" else "couldn't open the reply field",
        )
        render(show = false)
    }

    override fun onNexusSurfaceTextCommitted(surfaceId: String, text: String, cancelled: Boolean) {
        val sessionKey = screen.replyTargetKey ?: return
        val sessionId = screen.replySessionId
        screen.close(ActiveCard.Kind.REPLY)
        render(show = false)
        if (cancelled || sessionId == null) return
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val requestId = UUID.randomUUID().toString()
        pendingReplyRequestId = requestId
        awaitingReplyForKey = sessionKey
        syncThinkingTicker()
        serviceScope.launch {
            delay(AWAITING_REPLY_TIMEOUT_MS)
            if (awaitingReplyForKey == sessionKey) {
                awaitingReplyForKey = null
                syncThinkingTicker()
            }
        }
        AgentsMonitorService.sendSessionInput(applicationContext, requestId, sessionId, trimmed)
    }

    // ------------------------------------------------------------------- menu

    private fun openMenu(session: AgentSession) {
        selectedKey = session.key
        screen.openMenu(ControlMenu.open(session.key))
        render(show = false)
    }

    /** The menu as a card, or null (and no menu) when its session has left the board. */
    private fun menuCard(state: ControlMenu.MenuState): NexusCard? {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == state.sessionKey }
        if (session == null) {
            screen.close(ActiveCard.Kind.MENU)
            return null
        }
        // A menu that was covered starts its tap guard now that it is on screen again.
        val shown = screen.menuDrawn(state)
        // What agentd refused stays beside the real mode until the mode changes, or 30 s (R101, R107).
        val withNotice = shown.copy(
            notApplied = AgentsRuntime.store.notApplied(state.sessionKey),
            replyNotSent = AgentsRuntime.store.replyNotSent(state.sessionKey),
        )
        return BoardCards.menuCard(
            ControlMenu.page(withNotice, session, secure = secureLink, now = System.currentTimeMillis()),
        )
    }

    private fun onMenuInput(event: NexusInputEvent) {
        if (screen.menuReading != null) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                screen.menuReading = null
                render(show = false)
            }
            return
        }
        val state = screen.menu ?: return
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == state.sessionKey }
        if (session == null) {
            screen.close(ActiveCard.Kind.MENU)
            render(show = false)
            return
        }
        val secure = secureLink
        when {
            event.keyCode in GlassesKeys.BACKWARD -> {
                screen.menu = ControlMenu.move(state, -1, session, secure)
                render(show = false)
            }
            event.keyCode in GlassesKeys.FORWARD -> {
                screen.menu = ControlMenu.move(state, +1, session, secure)
                render(show = false)
            }
            GlassesKeys.isEnter(event) -> onMenuPick(state, session, secure)
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                val back = ControlMenu.back(state)
                if (back == null) screen.close(ActiveCard.Kind.MENU) else screen.showMenu(back)
                render(show = false)
            }
        }
    }

    private fun onMenuPick(state: ControlMenu.MenuState, session: AgentSession, secure: Boolean) {
        when (val step = ControlMenu.pick(state, session, secure)) {
            is ControlMenu.Step.Go -> showMenu(step.state)
            is ControlMenu.Step.Send -> {
                sendControl(step.command, session.key)
                showMenu(step.state)
            }
            is ControlMenu.Step.Say -> showBriefNotice(step.title, step.body)
            is ControlMenu.Step.ReadText -> {
                screen.menuReading = step.title to step.text
                render(show = false)
            }
            ControlMenu.Step.Reply -> answers.startVoice(VoiceTarget.Followup(session.key))
            ControlMenu.Step.Read -> openConversation(session)
            ControlMenu.Step.Close -> {
                screen.close(ActiveCard.Kind.MENU)
                render(show = false)
            }
        }
    }

    private fun showMenu(state: ControlMenu.MenuState) {
        screen.showMenu(state)
        render(show = false)
    }

    /**
     * Every write leaves through the monitor service, which hands it to
     * [AgentdWire.write]: a steering frame over a link not bound as secure comes
     * back MonitorOnly and is never sent. The menu has already greyed those
     * rows, so this is the second lock, not the first.
     */
    private fun sendControl(command: ControlMenu.Command, sessionKey: String) {
        val msgId = UUID.randomUUID().toString()
        val frame = try {
            ControlMenu.frame(command, sessionKey, msgId)
        } catch (_: IllegalArgumentException) {
            showBriefNotice(ControlMenu.NOTICE_TITLE, "Not sent")
            return
        }
        if (ControlMenu.steers(command)) rememberControlMsgId(msgId) else scheduleModelsTimeout()
        if (command is ControlMenu.Command.ModeSet) {
            modeSetMsgIds[msgId] = sessionKey
            while (modeSetMsgIds.size > CONTROL_MSG_IDS) modeSetMsgIds.remove(modeSetMsgIds.keys.first())
        }
        AgentsMonitorService.sendV2(applicationContext, frame)
    }

    /** The reply card's text, as a v2 `followup`. Nothing about the text is logged. */
    private fun sendFollowup(sessionKey: String, text: String) {
        if (!secureLink) {
            showBriefNotice(AlertCoordinator.NOT_SENT, AlertCoordinator.NOT_CONNECTED, safety = true)
            return
        }
        val msgId = UUID.randomUUID().toString()
        val frame = try {
            AgentdProtocolCodec.followup(sessionKey, text, msgId)
        } catch (_: IllegalArgumentException) {
            showBriefNotice("Reply too long", "keep it under 16 KB")
            return
        }
        rememberControlMsgId(msgId)
        // A new follow-up ends the last one's rejection.
        AgentsRuntime.store.clearReplyNotSent(sessionKey)
        followupMsgIds[msgId] = sessionKey
        while (followupMsgIds.size > CONTROL_MSG_IDS) followupMsgIds.remove(followupMsgIds.keys.first())
        AgentsMonitorService.sendV2(applicationContext, frame)
    }

    /** The chooser says "Models unavailable" once agentd has been silent that long (R98). */
    private fun scheduleModelsTimeout() {
        modelsTimeout?.cancel()
        modelsTimeout = serviceScope.launch {
            delay(ControlMenu.MODELS_TIMEOUT_MS + 50L)
            if (surfaceShown && screen.menu?.screen is ControlMenu.Screen.Choose) render(show = false)
        }
    }

    private fun rememberControlMsgId(msgId: String) {
        controlMsgIds.addLast(msgId)
        while (controlMsgIds.size > CONTROL_MSG_IDS) controlMsgIds.removeFirst()
    }

    private fun onAgentdEvent(event: AgentdEvent) {
        when (event) {
            // The menu's rows follow the link: a link that stopped steering greys them.
            is AgentdEvent.LinkUp, is AgentdEvent.LinkDown -> {
                // An utterance for a link that came or went answers nothing: stop listening.
                screen.stopVoice()
                if (surfaceShown &&
                    (screen.menu != null || screen.questionFlow != null || screen.decidingAlert != null)
                ) {
                    render(show = false)
                }
            }
            is AgentdEvent.Action -> onControlAction(event.action)
        }
    }

    private fun onControlAction(action: AgentdAction) {
        when (action) {
            is AgentdAction.Ack -> {
                if (!controlMsgIds.remove(action.msgId)) return
                val followupSession = followupMsgIds.remove(action.msgId)
                if (followupSession != null && action.result == "rejected") {
                    // Durable on the menu until the next follow-up or followup_closed; the brief is an extra.
                    AgentsRuntime.store.noteReplyNotSent(followupSession, notApplied(action))
                    if (surfaceShown && screen.menu?.sessionKey == followupSession) render(show = false)
                }
                val modeSession = modeSetMsgIds.remove(action.msgId)
                if (modeSession != null && action.result == "rejected") {
                    // The durable answer is on the menu until the mode changes, or 30 s; the brief is an extra.
                    AgentsRuntime.store.noteNotApplied(modeSession, notApplied(action))
                    if (surfaceShown && screen.menu?.sessionKey == modeSession) render(show = false)
                }
                ControlMenu.ackNotice(action)?.let { showBriefNotice(ControlMenu.NOTICE_TITLE, it, safety = true) }
            }
            is AgentdAction.FollowupClosed -> {
                // A closed window ends any rejection shown for it, and a reply for it would send into nothing.
                AgentsRuntime.store.clearReplyNotSent(action.sessionKey)
                val target = screen.voice?.target
                if (target is VoiceTarget.Followup && target.sessionKey == action.sessionKey) {
                    screen.stopVoice()
                    if (surfaceShown) render(show = false)
                }
                ControlMenu.followupClosedNotice(action.reason)
                    ?.let { showBriefNotice(ControlMenu.NOTICE_TITLE, it) }
            }
            is AgentdAction.ModeReset -> {
                val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == action.sessionKey }
                val heading = session?.v2?.heading?.takeIf(String::isNotBlank)
                    ?: session?.displayTitle
                    ?: "session"
                showBriefNotice(
                    ControlMenu.NOTICE_TITLE,
                    ControlMenu.modeResetNotice(action.from, heading, action.reason),
                    safety = true,
                )
            }
            is AgentdAction.Models -> {
                val current = screen.menu ?: return
                screen.menu = ControlMenu.withModels(current, action)
                if (surfaceShown) render(show = false)
            }
            else -> Unit
        }
    }

    private fun notApplied(ack: AgentdAction.Ack): String =
        ack.error?.singleLine(NOT_APPLIED_CHARS)?.takeIf(String::isNotBlank) ?: "rejected"

    /** Starts or stops the reader's "thinking" line to match reality, no more. */
    private fun syncThinkingTicker() {
        val conversation = AgentsRuntime.store.conversation.value
        val working = conversation != null && (
            AgentsRuntime.store.sessions.value
                .firstOrNull { it.key == conversation.sessionKey }
                ?.status == AgentStatus.WORKING ||
                conversation.sessionKey == awaitingReplyForKey
            )
        if (working == (thinkingTicker != null)) return
        if (!working) {
            thinkingTicker?.cancel()
            thinkingTicker = null
            return
        }
        thinkingVerbIndex = 0
        thinkingTicker = serviceScope.launch {
            while (isActive) {
                delay(THINKING_TICK_MS)
                thinkingVerbIndex += 1
                if (surfaceShown) render(show = false)
            }
        }
    }

    private fun thinkingVerb(): String = THINKING_VERBS[thinkingVerbIndex % THINKING_VERBS.size]

    /** Every brief goes through the director, which holds it back while an alert band is up (R94). */
    private fun showBriefNotice(title: String, body: String, safety: Boolean = false) {
        val director = AgentsRuntime.alertDirector
        if (director != null) director.onBrief(title, body, safety) else band.briefNow(title, body)
    }

    private fun attemptAdoption() {
        surface = surface ?: nexusSurfaceSession(SURFACE_ID) ?: return
        render(show = true)
    }

    /**
     * [digest] marks a redraw nobody asked for (a session moved, the minute
     * ticked): when it would only redraw the board with progress, the gate may
     * hold it. Anything else — opening, a keypress, another screen — is drawn.
     */
    private fun render(show: Boolean, digest: Boolean = false) {
        val activeSurface = surface ?: return
        activeReader()?.let { reader ->
            if (show) activeSurface.showReader(reader) else activeSurface.updateReader(reader)
            return
        }
        boardSessions = null
        val card = buildCard()
        boardSessions?.let { board ->
            // The wearer's cadence (Every minute or Live), read each time so a change applies at once.
            digestGate.periodMs = configStore.alertSettings().digestPeriodMs
            if (digest && !show && !digestGate.shouldPush(lastPushedBoard, board)) {
                scheduleDigestFlush()
                return
            }
            // Every draw of the board is a push, so the next hold is judged against this one.
            digestGate.markPushed()
            lastPushedBoard = board
        }
        if (show) activeSurface.showCard(card) else activeSurface.updateCard(card)
    }

    /** A held change must still reach the glasses when no other traffic comes to carry it. */
    private fun scheduleDigestFlush() {
        val at = digestGate.nextFlushAt() ?: return
        digestFlush?.cancel()
        digestFlush = serviceScope.launch {
            delay((at - SystemClock.elapsedRealtime()).coerceAtLeast(0L))
            if (surfaceShown) render(show = false, digest = true)
        }
    }

    /** An open conversation with something to read is the one reader screen. */
    private fun activeReader(): NexusReader? {
        if (screen.kind == ActiveCard.Kind.ALERT_DECISION && screen.alertReading) {
            val alert = screen.decidingAlert ?: return null
            val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
            return AlertNotices.approvalReader(alert, session, AgentsRuntime.store.approvalFor(alert.sessionKey))
        }
        if (screen.kind != ActiveCard.Kind.NONE && screen.kind != ActiveCard.Kind.MENU) return null
        screen.menuReading?.let { (title, text) -> return BoardCards.menuReader(title, text) }
        val conversation = AgentsRuntime.store.conversation.value ?: return null
        // A Done or error tap reads summary first, and shows what it has while the rest loads.
        outputAlert?.takeIf { it.sessionKey == conversation.sessionKey }?.let { alert ->
            return outputReader(alert, conversation)
        }
        if (conversation.loading || conversation.messages.isEmpty()) return null
        return conversationReader(conversation)
    }

    /** The card [GlassesScreen] says is on screen, or the board, menu or launcher under the cards. */
    private fun buildCard(): NexusCard {
        when (screen.kind) {
            ActiveCard.Kind.VOICE -> screen.voice?.let { return answers.voiceCard(it) }
            ActiveCard.Kind.QUESTION -> screen.questionFlow?.let { return answers.questionCard(it) }
            ActiveCard.Kind.ALERT_DECISION -> screen.decidingAlert?.let { alert ->
                val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
                return BoardCards.alertDecisionCard(alert, session, screen.alertRows(alert), screen.alertRow)
            }
            ActiveCard.Kind.REQUEST_DECISION -> screen.decidingRequestId?.let { requestId ->
                val approval = AgentsRuntime.store.approvals.value.firstOrNull { it.requestId == requestId }
                val session = approval?.let { a -> AgentsRuntime.store.sessions.value.firstOrNull { it.key == a.sessionKey } }
                return BoardCards.decisionCard(approval, session, screen.decisionChoice)
            }
            ActiveCard.Kind.REPLY -> screen.replyTargetKey?.let { key ->
                val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == key }
                if (session != null) return replyCard(session)
                // The session vanished mid-type: nothing left to send this to.
                screen.close(ActiveCard.Kind.REPLY)
            }
            ActiveCard.Kind.MENU, ActiveCard.Kind.NONE -> Unit
        }
        AgentsRuntime.store.conversation.value?.let { return conversationCard(it) }
        screen.menu?.let { state -> menuCard(state)?.let { return it } }
        launch?.let { return launchCard(it) }
        return sessionsCard()
    }

    private fun outputReader(alert: AgentdAction.Alert, conversation: AgentConversation): NexusReader {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
        val working = session?.status == AgentStatus.WORKING
        val segments = if (conversation.loading) emptyList() else readerSegments(conversation, working)
        return AlertNotices.outputReader(alert, session, segments)
    }

    private fun sessionsCard(): NexusCard {
        val sessions = AgentsRuntime.store.sessions.value
        boardSessions = sessions
        val board = BoardCards.sessionsCard(
            sessions = sessions,
            connections = AgentsRuntime.store.connections.value,
            config = configStore.load(),
            selectedKey = selectedKey,
            waiting = AgentsRuntime.alertDirector?.waiting?.value ?: 0,
            quiet = configStore.isQuiet(),
            now = System.currentTimeMillis(),
            signedOut = configStore.signedOut(),
        )
        selectedKey = board.selectedKey
        return board.card
    }

    // -------------------------------------------------------------- launcher

    private fun onLaunchInput(event: NexusInputEvent) {
        when {
            event.keyCode in GlassesKeys.BACKWARD -> {
                launchIndex -= 1
                render(show = false)
            }
            event.keyCode in GlassesKeys.FORWARD -> {
                launchIndex += 1
                render(show = false)
            }
            GlassesKeys.isEnter(event) -> launchEnter()
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                launch = when (val step = launch) {
                    is Launch.Threads -> Launch.Projects(step.machineId, step.machineName)
                    is Launch.Projects -> Launch.Computers
                    else -> null
                }
                launchIndex = 0
                launchNote = null
                render(show = false)
            }
        }
    }

    private fun launchEnter() {
        when (val step = launch) {
            Launch.Computers -> {
                val machines = configStore.trustedMachines()
                val machine = machines.getOrNull(launchIndex) ?: return
                launch = Launch.Projects(machine.machineId, machine.name)
                launchIndex = 0
                launchNote = null
                render(show = false)
            }
            is Launch.Projects -> {
                val project = configStore.projects(step.machineId).getOrNull(launchIndex) ?: return
                launch = Launch.Threads(step.machineId, step.machineName, project)
                launchIndex = 0
                launchNote = null
                render(show = false)
            }
            is Launch.Threads -> {
                if (launchIndex <= 0) {
                    startCodexThread(step)
                } else {
                    val session = projectThreads(step.project).getOrNull(launchIndex - 1) ?: return
                    launch = null
                    openConversation(session)
                }
            }
            null -> Unit
        }
    }

    /**
     * The glasses have no keyboard, so the thread starts empty: Codex sits
     * ready in the project until the wearer's first words reach it. Claude
     * Code cannot start without a prompt — that road stays on the phone until
     * the voice work lands.
     */
    private fun startCodexThread(step: Launch.Threads) {
        if (launchRequestId != null) return
        if (AgentsRuntime.store.linkMachine.value?.machineId != step.machineId) {
            launchNote = "${step.machineName} is not connected"
            render(show = false)
            return
        }
        val requestId = UUID.randomUUID().toString()
        launchRequestId = requestId
        launchNote = "starting on ${step.machineName}…"
        AgentsMonitorService.requestThreadStart(
            applicationContext,
            requestId,
            AgentProvider.CODEX,
            step.project.path,
            prompt = "",
        )
        render(show = false)
        serviceScope.launch {
            delay(LAUNCH_VERDICT_TIMEOUT_MS)
            if (launchRequestId == requestId) {
                launchRequestId = null
                launchNote = "no answer from ${step.machineName}"
                if (surfaceShown) render(show = false)
            }
        }
    }

    private fun projectThreads(project: AgentProject): List<AgentSession> =
        AgentsRuntime.store.sessions.value.filter { session ->
            session.provider in AgentProvider.AGENTD_PROVIDERS &&
                cwdInProject(session.cwd, project.path)
        }

    private fun launchCard(step: Launch): NexusCard = when (step) {
        Launch.Computers -> computersCard()
        is Launch.Projects -> projectsCard(step)
        is Launch.Threads -> threadsCard(step)
    }

    private fun computersCard(): NexusCard {
        val machines = configStore.trustedMachines()
        launchIndex = launchIndex.coerceIn(0, (machines.size - 1).coerceAtLeast(0))
        val link = AgentsRuntime.store.linkMachine.value
        val rows = if (machines.isEmpty()) {
            listOf(
                NexusCardLine(
                    text = "No computer linked yet",
                    sub = "link one in the phone app first",
                    tone = NexusRowTone.DIM,
                ),
            )
        } else {
            BoardCards.windowedRows(machines, launchIndex) { machine, selected ->
                val connected = link?.machineId == machine.machineId
                NexusCardLine(
                    text = machine.name.singleLine(120),
                    sub = when {
                        connected && link?.overTailnet == true -> "connected · over Tailscale"
                        connected -> "connected · same Wi-Fi"
                        else -> lastSeenText(machine.lastSeenAtMs).lowercase()
                    },
                    tone = if (connected) NexusRowTone.NORMAL else NexusRowTone.DIM,
                    selected = selected,
                )
            }
        }
        return BoardCards.card(
            title = "Start an agent",
            subtitle = "pick a computer",
            rows = rows,
            footer = "swipe move · tap pick · 2-tap board",
        )
    }

    private fun projectsCard(step: Launch.Projects): NexusCard {
        val projects = configStore.projects(step.machineId)
        launchIndex = launchIndex.coerceIn(0, (projects.size - 1).coerceAtLeast(0))
        val rows = if (projects.isEmpty()) {
            listOf(
                NexusCardLine(
                    text = "No project on ${step.machineName}".singleLine(120),
                    sub = "anchor a folder in the phone app first",
                    tone = NexusRowTone.DIM,
                ),
            )
        } else {
            BoardCards.windowedRows(projects, launchIndex) { project, selected ->
                NexusCardLine(
                    text = project.name.singleLine(120),
                    sub = project.path.singleLine(120),
                    tone = NexusRowTone.NORMAL,
                    selected = selected,
                )
            }
        }
        return BoardCards.card(
            title = "Start an agent",
            subtitle = "${step.machineName} · pick a project".take(120),
            rows = rows,
            footer = "swipe move · tap pick · 2-tap computers",
        )
    }

    private fun threadsCard(step: Launch.Threads): NexusCard {
        val now = System.currentTimeMillis()
        val threads = projectThreads(step.project)
        launchIndex = launchIndex.coerceIn(0, threads.size)
        val rows = buildList {
            add(
                NexusCardLine(
                    text = "+ New Codex thread",
                    sub = (
                        launchNote
                            ?: "starts empty here · Claude Code needs a prompt, use the phone"
                        ).singleLine(120),
                    badge = "CX",
                    tone = if (launchIndex == 0) NexusRowTone.NORMAL else NexusRowTone.DIM,
                    selected = launchIndex == 0,
                ),
            )
            addAll(
                BoardCards.windowedRows(threads, launchIndex - 1) { session, selected ->
                    BoardCards.sessionRow(session, selected, now)
                },
            )
        }
        return BoardCards.card(
            title = step.project.name.singleLine(110),
            subtitle = listOfNotNull(
                step.machineName,
                if (threads.isEmpty()) "no threads yet" else "${threads.size} threads",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = "swipe move · tap open or start · 2-tap projects",
        )
    }

    private fun cwdInProject(cwd: String?, projectPath: String): Boolean {
        val where = cwd?.replace('\\', '/')?.trimEnd('/')?.lowercase() ?: return false
        val root = projectPath.replace('\\', '/').trimEnd('/').lowercase()
        return where == root || where.startsWith("$root/")
    }

    // ------------------------------------------------------------ conversation

    /** Loading and empty states only; a readable conversation goes to the reader. */
    private fun conversationCard(conversation: AgentConversation): NexusCard {
        val session = AgentsRuntime.store.sessions.value
            .firstOrNull { it.key == conversation.sessionKey }
        val rows = if (conversation.loading) {
            listOf(NexusCardLine(text = "Reading the conversation…", tone = NexusRowTone.DIM))
        } else {
            listOf(
                NexusCardLine(
                    text = "Nothing to show yet",
                    sub = "this session has no readable messages",
                    tone = NexusRowTone.DIM,
                ),
            )
        }
        return BoardCards.card(
            title = session?.displayTitle?.singleLine(110) ?: "Conversation",
            subtitle = conversationSubtitle(session, conversation),
            rows = rows,
            footer = "2-tap back",
        )
    }

    /**
     * The conversation as a document: a quiet header line where a turn starts,
     * the message itself as full prose the hub wraps and scrolls, and a train
     * of consecutive tool calls collapsed to one dim aside — the wearer sees
     * "Edit ×4 · Bash" and moves on.
     */
    private fun conversationReader(conversation: AgentConversation): NexusReader {
        val session = AgentsRuntime.store.sessions.value
            .firstOrNull { it.key == conversation.sessionKey }
        val last = conversation.messages.last()
        val working = session?.status == AgentStatus.WORKING ||
            conversation.sessionKey == awaitingReplyForKey
        return NexusReader(
            title = session?.displayTitle?.singleLine(110) ?: "Conversation",
            subtitle = conversationSubtitle(session, conversation),
            footer = "swipe scroll · 2-tap back",
            handlesBack = true,
            contentKey = listOf(
                conversation.sessionKey,
                conversation.messages.size,
                last.at ?: 0L,
                last.text.length,
                if (working) thinkingVerbIndex else -1,
            ).joinToString(":").hashCode().toString(),
            segments = readerSegments(conversation, working),
        )
    }

    private fun readerSegments(
        conversation: AgentConversation,
        working: Boolean,
    ): List<NexusReaderSegment> {
        val now = System.currentTimeMillis()
        val groups = mutableListOf<List<NexusReaderSegment>>()
        val toolRun = mutableListOf<AgentMessage>()
        fun flushTools() {
            if (toolRun.isNotEmpty()) {
                groups += listOf(
                    NexusReaderSegment(
                        kind = NexusReaderSegmentKind.ASIDE,
                        text = "⋯ ${toolRunLabel(toolRun)}".take(READER_SEGMENT_CHARS),
                    ),
                )
                toolRun.clear()
            }
        }
        for (message in conversation.messages) {
            if (message.role == MessageRole.TOOL) {
                toolRun += message
                continue
            }
            flushTools()
            val who =
                if (message.role == MessageRole.USER) MessageRole.USER.label
                else conversation.provider.marker
            groups += listOf(
                NexusReaderSegment(
                    kind = NexusReaderSegmentKind.HEADER,
                    text = listOfNotNull(who, BoardModel.age(now, message.at)).joinToString(" · "),
                    emphasis = message.role == MessageRole.USER,
                ),
                NexusReaderSegment(
                    kind = NexusReaderSegmentKind.PROSE,
                    text = message.text.take(READER_SEGMENT_CHARS),
                ),
            )
        }
        flushTools()
        // Newest turns win the budget; a session's deep past lives on the phone.
        val kept = ArrayDeque<List<NexusReaderSegment>>()
        var chars = 0
        var count = 0
        for (group in groups.asReversed()) {
            val groupChars = group.sumOf { it.text.length }
            if (kept.isNotEmpty() &&
                (chars + groupChars > READER_TOTAL_CHARS || count + group.size > READER_MAX_SEGMENTS)
            ) {
                break
            }
            kept.addFirst(group)
            chars += groupChars
            count += group.size
        }
        val segments = kept.flatten()
        return if (working) {
            segments + NexusReaderSegment(kind = NexusReaderSegmentKind.ASIDE, text = "⋯ ${thinkingVerb()}…")
        } else {
            segments
        }
    }

    private fun toolRunLabel(run: List<AgentMessage>): String {
        if (run.size == 1) return run.single().text.singleLine(160)
        val counts = LinkedHashMap<String, Int>()
        for (message in run) {
            val name = message.tool?.takeIf(String::isNotBlank)
                ?: message.text.substringBefore(" · ").ifBlank { "tool" }
            counts[name] = (counts[name] ?: 0) + 1
        }
        return counts.entries.joinToString(" · ") { (name, times) ->
            if (times > 1) "$name ×$times" else name
        }
    }

    private fun conversationSubtitle(
        session: AgentSession?,
        conversation: AgentConversation,
    ): String {
        val parts = listOfNotNull(
            session?.let { statusPhrase(it) },
            session?.project?.takeIf(String::isNotBlank),
            session?.machineName?.takeIf(String::isNotBlank),
            conversation.messages.size.takeIf { it > 0 }?.let { "$it messages" },
        )
        return parts.joinToString(" · ").take(120).ifBlank { "conversation" }
    }

    private fun statusPhrase(session: AgentSession): String = when (session.status) {
        AgentStatus.NEEDS_YOU -> BoardCards.pendingSummary(session)
        AgentStatus.WORKING -> "working"
        AgentStatus.IDLE -> "idle"
        AgentStatus.ERROR -> "error"
        AgentStatus.DONE -> "finished"
    }

    companion object {
        const val ACTION_MONITOR_ACTIVE =
            "com.anezium.rokidbus.plugin.agents.action.MONITOR_ACTIVE"
        private const val SURFACE_ID = "agents"
        private const val THINKING_TICK_MS = 2_500L
        /** How long an optimistic "thinking" cue outlives a send with no daemon word yet. */
        private const val AWAITING_REPLY_TIMEOUT_MS = 20_000L
        private val THINKING_VERBS = listOf(
            "Thinking",
            "Pondering",
            "Noodling",
            "Percolating",
            "Mulling",
            "Ruminating",
            "Cogitating",
            "Working",
        )
        /**
         * Under the reader surface caps, and sized for the transport: past
         * 3 KiB a surface rides the CXR data plane, whose image contract is
         * 64 KiB — ~24k chars of text stays a ~30 KB frame, a ~90 ms push.
         */
        private const val READER_SEGMENT_CHARS = 4_000
        private const val READER_TOTAL_CHARS = 24_000
        private const val READER_MAX_SEGMENTS = 236
        private const val AGE_TICK_MS = 60_000L

        /** Long enough to swallow a double tap, short enough to never be felt. */
        private const val DECISION_GUARD_MS = 600L

        /**
         * Long enough to swallow the burst of state a single tool call makes,
         * short enough that the board still reads as live. collectLatest
         * cancels this wait when another change lands, so a stream of them
         * costs one redraw at the end rather than one apiece.
         */
        private const val RENDER_SETTLE_MS = 300L
        private const val LAUNCH_VERDICT_TIMEOUT_MS = 35_000L
        private const val CONTROL_MSG_IDS = 32
        private const val QUESTION_REFUSED_TITLE = "Can't answer here"
        private const val NOT_APPLIED_CHARS = 120
    }
}
