package com.anezium.rokidbus.plugin.agents

import android.content.Intent
import android.os.SystemClock
import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusPluginClient
import com.anezium.rokidbus.client.plugin.NexusPluginService
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import com.anezium.rokidbus.client.plugin.NexusRowTone
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechState
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
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
import java.security.MessageDigest
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

    /**
     * True while the band this plugin last put up is a v2 alert's. The notice
     * callbacks carry no identity, so a band of any other kind (the v1 status
     * band, a brief) clears it, and the callbacks then mean what they always did.
     */
    private var v2BandUp = false

    /**
     * Which card is on the glasses screen (R104). The card fields below are only
     * the data of cards that may be open; [openCard] clears the others whenever a
     * card opens, and a confirm is only taken from the card [active] says is on screen.
     */
    private val active = ActiveCard(DECISION_GUARD_MS)

    /** The alert whose decision card is open, bound by id so a late confirm cannot answer another. */
    private var decidingAlert: AgentdAction.Alert? = null

    /** The Done or error alert whose summary heads the open conversation. */
    private var outputAlert: AgentdAction.Alert? = null

    /** The row of the alert decision card: 0 Allow, 1 Deny, 2 Say allow or deny. */
    private var alertRow = 0

    /**
     * The one utterance in flight or on screen, if any: a follow-up reply, a free-text
     * answer of the question card, or a voice approval. It is dropped, and its speech
     * session stopped, the moment the thing it was for stops being answerable.
     */
    private var voice: VoiceRun? = null

    /** The question card's state: answers per item, one item per page, bound to its alert by id. */
    private var questionFlow: QuestionFlow? = null
    private var questionPage = 0
    private var questionRow = 0

    /** The held tool call the wearer is answering, if they are answering one. */
    private var decidingRequestId: String? = null
    private var decisionChoice = ApprovalDecision.ALLOW

    /**
     * The session key the wearer is typing a reply for, if they opened the
     * field. Bound to an attempt counter because the board can re-sort, or the
     * session can finish, while the wearer is still composing — a rejection or
     * a stale send must not land on whatever the field happens to mean by then.
     */
    private var replyTargetKey: String? = null
    private var replySessionId: String? = null
    private var replyAttempt = 0
    private var pendingReplyRequestId: String? = null

    /**
     * The per-session control menu behind ENTER on a board row. It is a card of
     * its own, so its state carries a guard against the second tap of a double
     * tap on the screen it just opened, and [menuReading] is the reader a long row
     * opens. [controlMsgIds] are the steering frames this menu sent, so an ack
     * is only reported for what the wearer asked here.
     */
    private var menu: ControlMenu.MenuState? = null
    private var modelsTimeout: Job? = null
    private var menuReading: Pair<String, String>? = null
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
                val target = voice?.target as? VoiceTarget.Followup ?: return@collect
                if (sessions.none { it.key == target.sessionKey }) {
                    stopVoice()
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
        openCard(ActiveCard.Kind.NONE)
        menu = null
        menuReading = null
        leaveConversation()
        launch = null
        launchNote = null
        surface?.hide()
        surface = null
    }

    override fun onNexusInput(event: NexusInputEvent) {
        if (event.action != KeyEvent.ACTION_DOWN) return
        voice?.let { run ->
            onVoiceInput(run, event)
            return
        }
        questionFlow?.let { flow ->
            onQuestionInput(flow, event)
            return
        }
        if (decidingRequestId != null || decidingAlert != null) {
            onDecisionInput(event)
            return
        }
        val conversation = AgentsRuntime.store.conversation.value
        if (conversation == null && launch != null) {
            onLaunchInput(event)
            return
        }
        if (replyTargetKey != null) return
        if (conversation == null && (menu != null || menuReading != null)) {
            onMenuInput(event)
            return
        }
        // A touchpad swipe arrives as LEFT/RIGHT, the ring as UP/DOWN: both
        // walk the same list, exactly as the other boards treat them. Inside a
        // conversation the hub owns the scroll and swipes never reach us.
        when {
            event.keyCode in BACKWARD_KEYS -> if (conversation == null) moveSelection(-1)
            event.keyCode in FORWARD_KEYS -> if (conversation == null) moveSelection(+1)
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> if (conversation == null) enterSelected() else onReplyRequested(conversation)
            event.keyCode == KeyEvent.KEYCODE_BACK ->
                if (conversation != null) {
                    leaveConversation()
                    render(show = false)
                } else {
                    surface?.hide()
                }
        }
    }

    private fun onDecisionInput(event: NexusInputEvent) {
        if (decidingAlert != null) {
            onAlertDecisionInput(event)
            return
        }
        when {
            event.keyCode in BACKWARD_KEYS || event.keyCode in FORWARD_KEYS -> {
                decisionChoice = when (decisionChoice) {
                    ApprovalDecision.ALLOW -> ApprovalDecision.DENY
                    ApprovalDecision.DENY -> ApprovalDecision.ALLOW
                }
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> confirmDecision()
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                closeCard(ActiveCard.Kind.REQUEST_DECISION)
                render(show = false)
            }
        }
    }

    /** The alert's decision card walks three rows: Allow, Deny and, on a steering link, the voice row. */
    private fun onAlertDecisionInput(event: NexusInputEvent) {
        val rows = if (AgentsRuntime.link.value?.secure == true) ALERT_DECISION_ROWS else 2
        when {
            event.keyCode in BACKWARD_KEYS -> {
                alertRow = (alertRow - 1 + rows) % rows
                render(show = false)
            }
            event.keyCode in FORWARD_KEYS -> {
                alertRow = (alertRow + 1) % rows
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> confirmDecision()
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                closeCard(ActiveCard.Kind.ALERT_DECISION)
                render(show = false)
            }
        }
    }

    /** A tap on the band means "show me": open the board on the session that rang. */
    override fun onNexusNoticeInput(event: NexusInputEvent) {
        if (event.action != KeyEvent.ACTION_DOWN) return
        if (event.keyCode != KeyEvent.KEYCODE_ENTER &&
            event.keyCode != KeyEvent.KEYCODE_DPAD_CENTER
        ) {
            return
        }
        if (v2BandUp) {
            AgentsRuntime.alertDirector?.onBandInput()
            return
        }
        noticeTargetKey?.let { selectedKey = it }
        if (!surfaceShown) attemptAdoption()
    }

    override fun onNexusNoticeAction(id: String) {
        if (v2BandUp) AgentsRuntime.alertDirector?.onBandAction(id)
    }

    /** Display evidence belongs to an alert's band; a brief or v1 attention band has no alert to credit. */
    override fun onNexusNoticeShown() {
        if (v2BandUp) AgentsRuntime.alertDirector?.onBandShown()
    }

    override fun onNexusNoticeClosed(reason: NexusNoticeCloseReason) {
        val director = AgentsRuntime.alertDirector
        routeNoticeClose(
            reason,
            v2BandUp,
            clearV2 = { v2BandUp = false },
            // A brief's band ending: the next queued brief may show.
            band = { director?.onBandClosed(it) },
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

    /**
     * The phone stays silent by design, so this band is the only interruption
     * Agents ever makes. It is raised at most one at a time — several sessions
     * asking at once become one line, because a queue of bands is not an alert,
     * it is a nuisance — and the fingerprint is only committed once the hub has
     * actually taken the notice, so an alert that could not be delivered is
     * offered again on the next update instead of being lost.
     */
    private fun raiseAttention() {
        val client = nexusClient ?: return
        if (!client.supportsNoticeSurface) return
        // On a secure link agentd's own alerts speak for its providers (R40); the
        // status path stays for OpenClaw, and for a link that cannot steer.
        // An approval's band is never replaced by this one; the wearer's answer comes first.
        if (v2BandUp || AgentsRuntime.alertDirector?.slotBusy == true) return
        // A computer that has spoken v2 stays off this path even while its link is down (R92).
        val steering = AgentsRuntime.link.value?.secure == true
        val director = AgentsRuntime.alertDirector
        val pending = attention.pending(AgentsRuntime.store.sessions.value) { session ->
            // A session that had a v2 alert on this link is the alerts' to announce, not v1's.
            configStore.v1AttentionSuppressed(session, steering) || director?.hadAlert(session.key) == true
        }
        if (pending.isEmpty()) return
        val notice = if (pending.size == 1) singleNotice(pending.single()) else groupNotice(pending)
        if (showOtherNotice(client, notice) != NexusSdkResult.SENT) return
        noticeTargetKey = pending.first().session.key
        pending.forEach(attention::commit)
    }

    private fun singleNotice(item: AgentAttention): NexusNotice {
        val session = item.session
        // Only a secure link steers, and this path runs for agentd's providers
        // only when the link is not secure: the wearer decides on the laptop.
        return AlertNotices.statusNotice(
            session,
            summary = pendingSummary(session),
            monitorOnly = session.provider in AgentProvider.AGENTD_PROVIDERS,
        )
    }

    /** Every band that is not a v2 alert's goes through here, so the callbacks know whose band is up. */
    private fun showOtherNotice(client: NexusPluginClient, notice: NexusNotice): NexusSdkResult {
        val result = client.showNotice(notice)
        if (result == NexusSdkResult.SENT) v2BandUp = false
        return result
    }

    private fun groupNotice(items: List<AgentAttention>): NexusNotice {
        val waiting = items.count { it.session.status == AgentStatus.NEEDS_YOU }
        val failed = items.count { it.session.status == AgentStatus.ERROR }
        val parts = listOfNotNull(
            waiting.takeIf { it > 0 }?.let { "$it waiting for you" },
            failed.takeIf { it > 0 }?.let { "$it failed" },
        )
        return NexusNotice(
            title = "Agents",
            body = parts.joinToString(" · ").singleLine(NOTICE_BODY_CHARS),
            footer = "TAP open",
            interactive = true,
            ttlMs = ATTENTION_TTL_MS,
        )
    }

    // ------------------------------------------------------- alert glasses

    override fun showBand(notice: NexusNotice): Boolean {
        val client = nexusClient ?: return false
        if (!client.supportsNoticeSurface) return false
        val taken = client.showNotice(notice) == NexusSdkResult.SENT
        if (taken) {
            v2BandUp = true
            // An alert took the screen's attention: no confirm survives it (R96).
            coverMenu()
        }
        return taken
    }

    override fun updateBand(update: NexusNoticeUpdate): Boolean {
        val client = nexusClient ?: return false
        // A brief or status band took the slot since: the update would rewrite that one.
        return v2BandUp && client.updateNotice(update) == NexusSdkResult.SENT
    }

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

    override fun hideBand() {
        if (!v2BandUp) return
        v2BandUp = false
        nexusClient?.hideNotice()
    }

    override fun brief(title: String, body: String) = showBriefNow(title, body)

    override fun briefLines(title: String, lines: List<String>) {
        val client = nexusClient
        val shown = client != null && client.supportsNoticeSurface &&
            showOtherNotice(client, AlertNotices.briefLines(title, lines)) == NexusSdkResult.SENT
        if (!shown) AgentsRuntime.alertDirector?.onBriefClosed(NexusNoticeCloseReason.OWNER)
    }

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
        openCard(ActiveCard.Kind.ALERT_DECISION)
        decidingAlert = alert
        alertRow = 0
        showBoard()
    }

    /** Answer opens the question card, one item per page, bound to the alert by id (R73). */
    override fun openQuestion(alert: AgentdAction.Alert) {
        val payload = alert.question
        if (payload == null) {
            showBriefNotice(AlertCoordinator.NO_LONGER_WAITING, AlertCoordinator.NO_LONGER_WAITING_BODY)
            return
        }
        openCard(ActiveCard.Kind.QUESTION)
        questionFlow = QuestionFlow(alert.id, alert.sessionKey, payload)
        questionPage = 0
        questionRow = 0
        showBoard()
    }

    /** What a card or an utterance was bound to is gone: close them, and stop listening for it. */
    override fun invalidate(alertId: String) {
        val voiceBound = when (val target = voice?.target) {
            is VoiceTarget.Answer -> target.alertId == alertId
            is VoiceTarget.Approval -> target.alertId == alertId
            else -> false
        }
        val decisionBound = decidingAlert?.id == alertId
        val questionBound = questionFlow?.alertId == alertId
        if (!voiceBound && !decisionBound && !questionBound) return
        if (voiceBound) stopVoice()
        if (decisionBound) closeCard(ActiveCard.Kind.ALERT_DECISION)
        if (questionBound) closeCard(ActiveCard.Kind.QUESTION)
        showBriefNotice(AlertCoordinator.NO_LONGER_WAITING, AlertCoordinator.NO_LONGER_WAITING_BODY)
        if (surfaceShown) render(show = false)
    }

    private fun showConversation(session: AgentSession) {
        // The reader takes the screen: no card under it may confirm (R104).
        openCard(ActiveCard.Kind.NONE)
        menu = null
        menuReading = null
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

    private fun selectedIndexIn(sessions: List<AgentSession>): Int =
        sessions.indexOfFirst { it.key == selectedKey }.takeIf { it >= 0 } ?: 0

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
        val session = sessions.getOrNull(selectedIndexIn(sessions)) ?: return
        val approval = AgentsRuntime.store.approvalFor(session.key)
        when {
            approval != null -> openDecision(approval)
            // A session that speaks v2 is steered from its menu, and its conversation is the
            // menu's "Read output" row; one that does not has nothing to steer.
            session.v2 != null -> openMenu(session)
            else -> openConversation(session)
        }
    }

    private fun openConversation(session: AgentSession) {
        AgentsRuntime.store.openConversation(session)
        AgentsMonitorService.openDetail(applicationContext, session)
        render(show = false)
    }

    private fun openDecision(approval: AgentApproval) {
        openCard(ActiveCard.Kind.REQUEST_DECISION)
        decidingRequestId = approval.requestId
        decisionChoice = ApprovalDecision.ALLOW
        render(show = false)
    }

    /**
     * The touchpad's double tap is two ENTER downs a few dozen milliseconds
     * apart, and the second one would land on a freshly opened decision. Nothing
     * an agent asked for gets approved by a gesture aimed at opening it.
     */
    private fun confirmDecision() {
        decidingAlert?.let { alert ->
            // Only the card on screen confirms, and not on the tail of the tap that opened it.
            if (!active.accepts(ActiveCard.Kind.ALERT_DECISION, System.currentTimeMillis())) return
            if (alertRow == VOICE_ROW) {
                // Hearing is not deciding: the utterance still needs its own confirm card.
                if (AgentsRuntime.link.value?.secure == true) startVoice(VoiceTarget.Approval(alert.id))
                return
            }
            closeCard(ActiveCard.Kind.ALERT_DECISION)
            render(show = false)
            // The coordinator only lets a card that is still bound answer.
            AgentsRuntime.alertDirector?.onCardConfirm(
                alert.id,
                if (alertRow == 0) AlertCoordinator.ALLOW else AlertCoordinator.DENY,
            )
            return
        }
        val requestId = decidingRequestId ?: return
        if (!active.accepts(ActiveCard.Kind.REQUEST_DECISION, System.currentTimeMillis())) return
        if (AgentsRuntime.store.approvals.value.none { it.requestId == requestId }) return
        AgentsMonitorService.decideApproval(applicationContext, requestId, decisionChoice)
        closeCard(ActiveCard.Kind.REQUEST_DECISION)
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
        openCard(ActiveCard.Kind.REPLY)
        replyTargetKey = session.key
        replySessionId = session.id
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
        closeCard(ActiveCard.Kind.REPLY)
        showBriefNotice(
            "Can't type here",
            if (code == "SURFACE_BUSY") "the screen is busy" else "couldn't open the reply field",
        )
        render(show = false)
    }

    override fun onNexusSurfaceTextCommitted(surfaceId: String, text: String, cancelled: Boolean) {
        val sessionKey = replyTargetKey ?: return
        val sessionId = replySessionId
        closeCard(ActiveCard.Kind.REPLY)
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

    // ---------------------------------------------------------------- one card

    /**
     * Puts [kind] on the glasses screen and clears every other card's data and
     * confirm state (R104). A card that is the parent of a [child] stays bound,
     * hidden under it, and gets the screen back when the child closes.
     */
    private fun openCard(kind: ActiveCard.Kind, child: Boolean = false) {
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
        val now = System.currentTimeMillis()
        if (child) active.openChild(kind, now) else active.open(kind, now)
    }

    /** Closes one card and its data; the screen goes to the card under it, if it was a child. */
    private fun closeCard(kind: ActiveCard.Kind) {
        when (kind) {
            ActiveCard.Kind.QUESTION -> questionFlow = null
            ActiveCard.Kind.ALERT_DECISION -> decidingAlert = null
            ActiveCard.Kind.REQUEST_DECISION -> decidingRequestId = null
            ActiveCard.Kind.REPLY -> {
                replyTargetKey = null
                replySessionId = null
            }
            ActiveCard.Kind.VOICE, ActiveCard.Kind.NONE -> Unit
        }
        active.close(kind, System.currentTimeMillis())
    }

    // ------------------------------------------------------------------ voice

    private sealed interface VoiceTarget {
        data class Followup(val sessionKey: String) : VoiceTarget
        data class Answer(val alertId: String, val itemIndex: Int) : VoiceTarget
        data class Approval(val alertId: String) : VoiceTarget
    }

    /** One utterance: its target, the state machine over the hub's callbacks, and where the card's selection is. */
    private class VoiceRun(val target: VoiceTarget) {
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
     * Starts one tap-to-talk utterance for [target], replacing any before it. The
     * speech callbacks run on the main thread; each is tied to its own run, so one
     * that arrives after the card was closed or restarted is dropped. Nothing the
     * wearer says is logged, and nothing is sent until ENTER on the heard card.
     */
    private fun startVoice(target: VoiceTarget) {
        // A restart gives the screen back to the card that asked, then covers it again.
        stopVoice()
        val run = VoiceRun(target)
        openCard(ActiveCard.Kind.VOICE, child = true)
        voice = run
        val session = nexusSpeechSession(object : NexusSpeechCallbacks {
            // A start the wearer gave up on is stopped by the capture itself, once the hub accepts it (R105).
            override fun onSpeechStarted(realtime: Boolean) = onVoiceEvent(run) { it.onStarted() }
            override fun onSpeechState(state: NexusSpeechState) = Unit
            override fun onSpeechPartial(text: String) {
                if (voice === run) run.capture.onPartial(text)
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
        if (voice !== run) {
            event(run.capture)
            return
        }
        event(run.capture)
        voiceChanged(run)
    }

    /** A new card state: the selection starts over, and a tap aimed at the old one cannot land on it. */
    private fun voiceChanged(run: VoiceRun) {
        run.row = VoiceCard.view(run.kind, run.capture.state).initial
        active.rearm(System.currentTimeMillis())
        if (surfaceShown) render(show = false)
    }

    /** Ends the utterance for good: whatever the hub still delivers for it is dropped. */
    private fun stopVoice() {
        val run = voice ?: return
        voice = null
        // Invalidating also stops the session, now if it is live and on its start if it is not.
        run.capture.invalidate()
        active.close(ActiveCard.Kind.VOICE, System.currentTimeMillis())
    }

    private fun onVoiceInput(run: VoiceRun, event: NexusInputEvent) {
        val view = VoiceCard.view(run.kind, run.capture.state)
        when {
            event.keyCode in BACKWARD_KEYS -> {
                run.row = (run.row - 1 + view.rows.size) % view.rows.size
                render(show = false)
            }
            event.keyCode in FORWARD_KEYS -> {
                run.row = (run.row + 1) % view.rows.size
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> {
                if (!active.accepts(ActiveCard.Kind.VOICE, System.currentTimeMillis())) return
                val act = view.rows.getOrNull(run.row)?.act ?: return
                onVoiceAct(run, act, view)
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                stopVoice()
                render(show = false)
            }
        }
    }

    private fun onVoiceAct(run: VoiceRun, act: VoiceAct, view: VoiceView) {
        when (act) {
            VoiceAct.CANCEL -> {
                stopVoice()
                render(show = false)
            }
            VoiceAct.SPEAK_AGAIN -> startVoice(run.target)
            VoiceAct.SEND -> {
                val text = run.capture.confirmedText() ?: return
                val target = run.target as? VoiceTarget.Followup ?: return
                stopVoice()
                render(show = false)
                sendFollowup(target.sessionKey, text)
            }
            VoiceAct.USE -> {
                val text = run.capture.confirmedText() ?: return
                val target = run.target as? VoiceTarget.Answer ?: return
                questionFlow?.takeIf { it.alertId == target.alertId }?.setFreeText(target.itemIndex, text)
                stopVoice()
                render(show = false)
            }
            VoiceAct.CONFIRM -> {
                val decision = view.decision ?: return
                val target = run.target as? VoiceTarget.Approval ?: return
                stopVoice()
                closeCard(ActiveCard.Kind.ALERT_DECISION)
                render(show = false)
                // The coordinator only lets a card that is still bound answer.
                AgentsRuntime.alertDirector?.onCardConfirm(
                    target.alertId,
                    if (decision == ApprovalDecision.ALLOW) AlertCoordinator.ALLOW else AlertCoordinator.DENY,
                )
            }
        }
    }

    private fun voiceCard(run: VoiceRun): NexusCard {
        val state = run.capture.state
        val view = VoiceCard.view(run.kind, state)
        val rows = buildList {
            view.body?.let { add(NexusCardLine(text = it, sub = VoiceCard.hint(state), tone = NexusRowTone.BODY)) }
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
            is VoiceTarget.Answer -> questionFlow?.payload?.items?.getOrNull(target.itemIndex)?.text.orEmpty()
            is VoiceTarget.Approval -> decidingAlert?.title.orEmpty()
        }
        return card(
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

    private fun questionCard(flow: QuestionFlow): NexusCard {
        val page = questionPage.coerceIn(0, flow.itemCount - 1)
        val item = flow.payload.items[page]
        val secure = AgentsRuntime.link.value?.secure == true
        val rows = questionRows(flow, page)
        val selected = questionRow.coerceIn(0, rows.lastIndex)
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == flow.sessionKey }
        val lines = windowedRows(rows, selected) { row, isSelected ->
            when (row) {
                is QuestionRow.Option -> {
                    val picked = flow.isPicked(page, row.index)
                    val mark = when {
                        item.multiSelect -> if (picked) "[x] " else "[ ] "
                        else -> if (picked) "(x) " else "( ) "
                    }
                    val option = item.options[row.index]
                    NexusCardLine(
                        text = (mark + option.label).singleLine(MENU_LINE_CHARS),
                        sub = option.description?.singleLine(MENU_LINE_CHARS),
                        tone = if (picked) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                        selected = isSelected,
                    )
                }
                QuestionRow.AnswerBox -> NexusCardLine(
                    text = "Answer box (voice)",
                    sub = flow.freeText(page)?.singleLine(MENU_LINE_CHARS) ?: "tap to speak",
                    tone = if (flow.freeText(page) != null) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                    selected = isSelected,
                )
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
        }
        val heading = session?.displayTitle?.singleLine(100) ?: flow.payload.source
        return card(
            title = if (flow.itemCount > 1) "Q${page + 1}/${flow.itemCount} · $heading" else heading,
            subtitle = item.text.singleLine(MENU_LINE_CHARS),
            rows = lines,
            footer = if (page > 0) "swipe move · tap pick · 2-tap previous" else "swipe move · tap pick · 2-tap close",
        )
    }

    private fun onQuestionInput(flow: QuestionFlow, event: NexusInputEvent) {
        val page = questionPage.coerceIn(0, flow.itemCount - 1)
        val rows = questionRows(flow, page)
        when {
            event.keyCode in BACKWARD_KEYS -> {
                questionRow = (questionRow.coerceIn(0, rows.lastIndex) - 1 + rows.size) % rows.size
                render(show = false)
            }
            event.keyCode in FORWARD_KEYS -> {
                questionRow = (questionRow.coerceIn(0, rows.lastIndex) + 1) % rows.size
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> {
                // The second tap of the double tap that opened this card must not pick on it.
                if (!active.accepts(ActiveCard.Kind.QUESTION, System.currentTimeMillis())) return
                onQuestionPick(flow, page, rows[questionRow.coerceIn(0, rows.lastIndex)])
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                if (page > 0) {
                    questionPage = page - 1
                    questionRow = 0
                    active.rearm(System.currentTimeMillis())
                } else {
                    closeCard(ActiveCard.Kind.QUESTION)
                }
                render(show = false)
            }
        }
    }

    private fun onQuestionPick(flow: QuestionFlow, page: Int, row: QuestionRow) {
        when (row) {
            is QuestionRow.Option -> {
                flow.toggle(page, row.index)
                render(show = false)
            }
            QuestionRow.AnswerBox -> startVoice(VoiceTarget.Answer(flow.alertId, page))
            QuestionRow.Next -> if (flow.isAnswered(page)) {
                questionPage = page + 1
                questionRow = 0
                active.rearm(System.currentTimeMillis())
                render(show = false)
            }
            QuestionRow.Send -> {
                if (AgentsRuntime.link.value?.secure != true) {
                    showBriefNotice(AlertCoordinator.MONITOR_ONLY_TITLE, AlertCoordinator.MONITOR_ONLY_BODY, safety = true)
                    return
                }
                val answers = flow.answers() ?: return
                closeCard(ActiveCard.Kind.QUESTION)
                render(show = false)
                // The coordinator only lets a card that is still bound answer.
                AgentsRuntime.alertDirector?.onQuestionConfirm(flow.alertId, answers)
            }
        }
    }

    // ------------------------------------------------------------------- menu

    private fun openMenu(session: AgentSession) {
        selectedKey = session.key
        menu = ControlMenu.guarded(ControlMenu.open(session.key), System.currentTimeMillis())
        render(show = false)
    }

    /**
     * A decision, reply, question or reader card, or an alert, takes the screen
     * (R96): the menu forgets any confirm and any reader, and its guard starts
     * over when it is drawn again.
     */
    private fun coverMenu() {
        menuReading = null
        modelsTimeout?.cancel()
        menu = menu?.let(ControlMenu::covered)
    }

    /** The menu as a card, or null (and no menu) when its session has left the board. */
    private fun menuCard(state: ControlMenu.MenuState): NexusCard? {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == state.sessionKey }
        if (session == null) {
            menu = null
            return null
        }
        val now = System.currentTimeMillis()
        // A menu that was covered starts its tap guard now that it is on screen again.
        val shown = ControlMenu.shown(state, now)
        if (shown !== state) menu = shown
        // What agentd refused stays beside the real mode until the session's next upsert (R101).
        val withNotice = shown.copy(
            notApplied = AgentsRuntime.store.notApplied(state.sessionKey),
            replyNotSent = AgentsRuntime.store.replyNotSent(state.sessionKey),
        )
        val page = ControlMenu.page(withNotice, session, secure = AgentsRuntime.link.value?.secure == true, now = now)
        val rows = windowedRows(page.rows, page.selected) { row, selected ->
            NexusCardLine(
                text = row.text.take(MENU_LINE_CHARS),
                sub = row.sub?.take(MENU_LINE_CHARS),
                tone = row.tone,
                selected = selected,
            )
        }
        return card(title = page.title, subtitle = page.subtitle, rows = rows, footer = page.footer)
    }

    private fun onMenuInput(event: NexusInputEvent) {
        if (menuReading != null) {
            if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                menuReading = null
                render(show = false)
            }
            return
        }
        val state = menu ?: return
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == state.sessionKey }
        if (session == null) {
            menu = null
            render(show = false)
            return
        }
        val secure = AgentsRuntime.link.value?.secure == true
        when {
            event.keyCode in BACKWARD_KEYS -> {
                menu = ControlMenu.move(state, -1, session, secure)
                render(show = false)
            }
            event.keyCode in FORWARD_KEYS -> {
                menu = ControlMenu.move(state, +1, session, secure)
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> {
                // The second tap of the double tap that opened this screen must not pick on it.
                if (!ControlMenu.accepts(state, System.currentTimeMillis())) return
                onMenuPick(state, session, secure)
            }
            event.keyCode == KeyEvent.KEYCODE_BACK -> {
                menu = ControlMenu.back(state)?.let { ControlMenu.guarded(it, System.currentTimeMillis()) }
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
                menuReading = step.title to step.text
                render(show = false)
            }
            ControlMenu.Step.Reply -> startVoice(VoiceTarget.Followup(session.key))
            ControlMenu.Step.Read -> openConversation(session)
            ControlMenu.Step.Close -> {
                menu = null
                render(show = false)
            }
        }
    }

    private fun showMenu(state: ControlMenu.MenuState) {
        menu = ControlMenu.guarded(state, System.currentTimeMillis())
        render(show = false)
    }

    /**
     * Every write leaves through the monitor service, which hands it to
     * [AgentdWire.write]: a steering frame over a link that cannot steer comes
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
        if (AgentsRuntime.link.value?.secure != true) {
            showBriefNotice(ControlMenu.NOTICE_TITLE, ControlMenu.MONITOR_ONLY, safety = true)
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
            if (surfaceShown && menu?.screen is ControlMenu.Screen.Choose) render(show = false)
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
                stopVoice()
                if (surfaceShown && (menu != null || questionFlow != null || decidingAlert != null)) {
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
                    if (surfaceShown && menu?.sessionKey == followupSession) render(show = false)
                }
                val modeSession = modeSetMsgIds.remove(action.msgId)
                if (modeSession != null && action.result == "rejected") {
                    // The durable answer is on the menu until the session's next upsert; the brief is an extra.
                    AgentsRuntime.store.noteNotApplied(modeSession, notApplied(action))
                    if (surfaceShown && menu?.sessionKey == modeSession) render(show = false)
                }
                ControlMenu.ackNotice(action)?.let { showBriefNotice(ControlMenu.NOTICE_TITLE, it, safety = true) }
            }
            is AgentdAction.FollowupClosed -> {
                // A closed window ends any rejection shown for it, and a reply for it would send into nothing.
                AgentsRuntime.store.clearReplyNotSent(action.sessionKey)
                val target = voice?.target
                if (target is VoiceTarget.Followup && target.sessionKey == action.sessionKey) {
                    stopVoice()
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
                val current = menu ?: return
                menu = ControlMenu.withModels(current, action)
                if (surfaceShown) render(show = false)
            }
            else -> Unit
        }
    }

    private fun notApplied(ack: AgentdAction.Ack): String =
        ack.error?.singleLine(NOT_APPLIED_CHARS)?.takeIf(String::isNotBlank) ?: "rejected"

    /** What a menu row too long for a line opens: its full text, to scroll. */
    private fun menuReader(title: String, text: String): NexusReader {
        val segments = text.chunked(READER_SEGMENT_CHARS)
            .filter { it.isNotBlank() }
            .take(READER_MAX_SEGMENTS)
            .map { NexusReaderSegment(NexusReaderSegmentKind.PROSE, it) }
            .ifEmpty { listOf(NexusReaderSegment(NexusReaderSegmentKind.PROSE, "…")) }
        return NexusReader(
            title = title.singleLine(110).ifBlank { "Agents" },
            footer = "swipe scroll · 2-tap back",
            handlesBack = true,
            contentKey = "menu:${text.hashCode()}",
            segments = segments,
        )
    }

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
        if (director != null) director.onBrief(title, body, safety) else showBriefNow(title, body)
    }

    private fun showBriefNow(title: String, body: String) {
        val client = nexusClient
        val shown = client != null && client.supportsNoticeSurface &&
            showOtherNotice(client, AlertNotices.brief(title, body)) == NexusSdkResult.SENT
        // A brief that never reached the glasses has no close coming: free its turn.
        if (!shown) AgentsRuntime.alertDirector?.onBriefClosed(NexusNoticeCloseReason.OWNER)
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
        if (voice != null || questionFlow != null) return null
        if (decidingRequestId != null || decidingAlert != null || replyTargetKey != null) return null
        menuReading?.let { (title, text) -> return menuReader(title, text) }
        val conversation = AgentsRuntime.store.conversation.value ?: return null
        // A Done or error tap reads summary first, and shows what it has while the rest loads.
        outputAlert?.takeIf { it.sessionKey == conversation.sessionKey }?.let { alert ->
            return outputReader(alert, conversation)
        }
        if (conversation.loading || conversation.messages.isEmpty()) return null
        return conversationReader(conversation)
    }

    private fun buildCard(): NexusCard {
        voice?.let { return voiceCard(it) }
        questionFlow?.let { return questionCard(it) }
        decidingAlert?.let { return alertDecisionCard(it) }
        decidingRequestId?.let { return decisionCard(it) }
        replyTargetKey?.let { key ->
            val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == key }
            if (session != null) return replyCard(session)
            // The session vanished mid-type: nothing left to send this to.
            closeCard(ActiveCard.Kind.REPLY)
        }
        AgentsRuntime.store.conversation.value?.let { return conversationCard(it) }
        menu?.let { state -> menuCard(state)?.let { return it } }
        launch?.let { return launchCard(it) }
        return sessionsCard()
    }

    // ----------------------------------------------------------------- decide

    /**
     * The one screen in this product that does something rather than show
     * something. It says what will run, in the agent's own words, and offers
     * exactly two answers — no third path, no "always allow", nothing that turns
     * a glance into a standing permission.
     */
    private fun decisionCard(requestId: String): NexusCard {
        val approval = AgentsRuntime.store.approvals.value
            .firstOrNull { it.requestId == requestId }
            ?: return expiredDecisionCard()
        val session = AgentsRuntime.store.sessions.value
            .firstOrNull { it.key == approval.sessionKey }
        val rows = buildList {
            add(
                NexusCardLine(
                    text = approval.summary.singleLine(238),
                    badge = approval.tool.take(6).ifBlank { "ASK" },
                    tone = NexusRowTone.BODY,
                ),
            )
            approval.detail
                ?.takeIf { it.isNotBlank() && it != approval.summary }
                ?.let { add(NexusCardLine(text = it.singleLine(238), tone = NexusRowTone.BODY)) }
            add(choiceRow("Allow", "let it run", ApprovalDecision.ALLOW))
            add(choiceRow("Deny", "tell the agent no", ApprovalDecision.DENY))
        }
        return card(
            title = session?.displayTitle?.singleLine(110) ?: "Permission",
            subtitle = listOfNotNull(
                approval.tool.takeIf(String::isNotBlank),
                session?.project?.takeIf(String::isNotBlank),
                "waiting for you",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = "swipe choose · tap confirm · 2-tap later",
        )
    }

    /** The card behind a band's More: the same two answers, bound to the alert it was opened for. */
    private fun alertDecisionCard(alert: AgentdAction.Alert): NexusCard {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
        val rows = buildList {
            add(
                NexusCardLine(
                    text = alert.body.ifBlank { alert.title }.singleLine(238),
                    badge = AlertNotices.providerLabel(alert).take(6),
                    tone = NexusRowTone.BODY,
                ),
            )
            if (AgentsRuntime.link.value?.secure == true) {
                add(alertChoiceRow("Allow", "let it run", 0))
                add(alertChoiceRow("Deny", "tell the agent no", 1))
                add(alertChoiceRow(VoiceApproval.PROMPT, "asks you to confirm", VOICE_ROW))
            } else {
                add(NexusCardLine(text = AlertNotices.MONITOR_ONLY_BODY, tone = NexusRowTone.DIM))
            }
        }
        return card(
            title = session?.displayTitle?.singleLine(110) ?: alert.title.singleLine(110).ifEmpty { "Permission" },
            subtitle = listOfNotNull(
                session?.project?.takeIf(String::isNotBlank),
                "waiting for you",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = if (AgentsRuntime.link.value?.secure == true) "swipe choose · tap confirm · 2-tap later" else "2-tap back",
        )
    }

    private fun outputReader(alert: AgentdAction.Alert, conversation: AgentConversation): NexusReader {
        val session = AgentsRuntime.store.sessions.value.firstOrNull { it.key == alert.sessionKey }
        val working = session?.status == AgentStatus.WORKING
        val segments = if (conversation.loading) emptyList() else readerSegments(conversation, working)
        return AlertNotices.outputReader(alert, session, segments)
    }

    private fun alertChoiceRow(label: String, sub: String, row: Int): NexusCardLine {
        val picked = alertRow == row
        return NexusCardLine(
            text = label,
            sub = sub,
            selected = picked,
            tone = if (picked) NexusRowTone.ALERT else NexusRowTone.DIM,
        )
    }

    private fun choiceRow(label: String, sub: String, choice: ApprovalDecision): NexusCardLine {
        val picked = decisionChoice == choice
        return NexusCardLine(
            text = label,
            sub = sub,
            selected = picked,
            tone = if (picked) NexusRowTone.ALERT else NexusRowTone.DIM,
        )
    }

    private fun expiredDecisionCard(): NexusCard = card(
        title = "Too late",
        subtitle = "the agent stopped waiting",
        rows = listOf(
            NexusCardLine(
                text = "This request is gone",
                sub = "it timed out, or it was answered on the computer",
                tone = NexusRowTone.DIM,
            ),
        ),
        footer = "2-tap back",
    )

    // ---------------------------------------------------------------- sessions

    private fun sessionsCard(): NexusCard {
        val now = System.currentTimeMillis()
        val sessions = AgentsRuntime.store.sessions.value
        val connections = AgentsRuntime.store.connections.value
        val config = configStore.load()
        boardSessions = sessions
        val waitingRow = BoardModel.waitingRow(AgentsRuntime.alertDirector?.waiting?.value ?: 0)
        val quiet = configStore.isQuiet()
        val quietSelected = selectedKey == BoardModel.QUIET_KEY
        val startSelected = !quietSelected && (selectedKey == BoardModel.START_KEY || sessions.isEmpty())
        val onSession = !quietSelected && !startSelected
        val selectedIndex = if (onSession) selectedIndexIn(sessions) else -1
        if (onSession) selectedKey = sessions.getOrNull(selectedIndex)?.key

        val alerts = buildList {
            waitingRow?.let(::add)
            if (config.agentdEnabled &&
                connections[AgentProvider.CLAUDE]?.state == ConnectionState.AUTH_FAILED
            ) {
                add(problemRow("Claude pairing rejected", "re-pair in the phone app"))
            }
            if (config.openClawEnabled &&
                connections[AgentProvider.OPENCLAW]?.state == ConnectionState.AUTH_FAILED
            ) {
                add(problemRow("OpenClaw auth failed", "check the token in the phone app"))
            }
        }

        // The HUD does not scroll: keep a window around the selection.
        val windowSize = (VISIBLE_SESSION_ROWS - alerts.size - 1).coerceAtLeast(MIN_SESSION_ROWS)
        val anchor = when {
            startSelected -> sessions.lastIndex.coerceAtLeast(0)
            quietSelected -> 0
            else -> selectedIndex
        }
        val windowStart = (anchor - windowSize / 2)
            .coerceIn(0, (sessions.size - windowSize).coerceAtLeast(0))

        val rows = buildList {
            addAll(alerts)
            add(BoardModel.quietRow(quiet, quietSelected))
            if (sessions.isEmpty()) {
                add(emptyRow(config))
            } else {
                sessions.drop(windowStart).take(windowSize).forEachIndexed { offset, session ->
                    add(sessionRow(session, windowStart + offset == selectedIndex, now))
                }
            }
            add(
                NexusCardLine(
                    text = "+ Start an agent",
                    sub = "a new thread in one of your projects",
                    tone = NexusRowTone.DIM,
                    selected = startSelected,
                ),
            )
        }

        return card(
            title = "Agents",
            subtitle = sessionsSubtitle(sessions, connections, config),
            rows = rows,
            footer = if (sessions.isEmpty()) {
                "tap start an agent · 2-tap exit"
            } else {
                "swipe move · tap open · 2-tap exit"
            },
        )
    }

    private fun sessionRow(session: AgentSession, selected: Boolean, now: Long): NexusCardLine =
        BoardModel.row(
            session,
            selected,
            now,
            fallbackSub = sessionSub(session),
        )

    /** The line that says what this session is actually doing to you, or for you. */
    private fun sessionSub(session: AgentSession): String? = when (session.status) {
        AgentStatus.NEEDS_YOU -> pendingSummary(session)
        AgentStatus.ERROR -> session.statusDetail ?: "stopped with an error"
        AgentStatus.WORKING -> session.turn?.lastTool?.let { "running $it" }
            ?: session.lastAssistantText
        // Quiet sessions: where they live is the only thing worth a second line.
        AgentStatus.IDLE, AgentStatus.DONE -> session.project?.takeIf(String::isNotBlank)
    }

    /**
     * Rewrites the stock Claude notification wording into a board-sized phrase.
     * A live approval outranks it: that one is the agent's actual question,
     * where the other is what monitoring inferred about the session.
     */
    private fun pendingSummary(session: AgentSession): String {
        AgentsRuntime.store.approvalFor(session.key)?.let { return it.summary.singleLine(160) }
        val raw = session.pendingRequest?.summary?.singleLine(160) ?: return "needs you"
        PERMISSION_PATTERN.find(raw)?.let { return "wants to run ${it.groupValues[1]}" }
        if (raw.contains("waiting for your input", ignoreCase = true)) return "waiting for you"
        return raw
    }

    private fun sessionsSubtitle(
        sessions: List<AgentSession>,
        connections: Map<AgentProvider, ProviderConnectionState>,
        config: AgentsConfig,
    ): String {
        val counts = listOfNotNull(
            sessions.count { it.status == AgentStatus.NEEDS_YOU }
                .takeIf { it > 0 }?.let { "$it waiting" },
            sessions.count { it.status == AgentStatus.WORKING }
                .takeIf { it > 0 }?.let { "$it running" },
            sessions.count { it.status == AgentStatus.ERROR }
                .takeIf { it > 0 }?.let { "$it failed" },
            sessions.count { it.status == AgentStatus.IDLE }
                .takeIf { it > 0 }?.let { "$it idle" },
        )
        if (counts.isNotEmpty()) {
            return counts.joinToString(" · ").take(120)
        }
        val connecting = AgentProvider.values().any { provider ->
            provider.enabledIn(config) &&
                connections[provider]?.state == ConnectionState.CONNECTING
        }
        return if (connecting) "connecting…" else "no sessions"
    }

    private fun emptyRow(config: AgentsConfig): NexusCardLine = NexusCardLine(
        text = if (config.agentdEnabled || config.openClawEnabled) {
            "Nothing running"
        } else {
            "Set up a provider in the phone app"
        },
        sub = if (config.agentdEnabled || config.openClawEnabled) {
            "sessions appear here as soon as an agent starts"
        } else {
            null
        },
        tone = NexusRowTone.DIM,
    )

    private fun problemRow(text: String, sub: String): NexusCardLine =
        NexusCardLine(text = text, sub = sub, tone = NexusRowTone.ALERT, trail = listOf("!"))

    // -------------------------------------------------------------- launcher

    private fun onLaunchInput(event: NexusInputEvent) {
        when {
            event.keyCode in BACKWARD_KEYS -> {
                launchIndex -= 1
                render(show = false)
            }
            event.keyCode in FORWARD_KEYS -> {
                launchIndex += 1
                render(show = false)
            }
            event.keyCode == KeyEvent.KEYCODE_ENTER ||
                event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER
            -> launchEnter()
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
            windowedRows(machines, launchIndex) { machine, selected ->
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
        return card(
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
            windowedRows(projects, launchIndex) { project, selected ->
                NexusCardLine(
                    text = project.name.singleLine(120),
                    sub = project.path.singleLine(120),
                    tone = NexusRowTone.NORMAL,
                    selected = selected,
                )
            }
        }
        return card(
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
                windowedRows(threads, launchIndex - 1) { session, selected ->
                    sessionRow(session, selected, now)
                },
            )
        }
        return card(
            title = step.project.name.singleLine(110),
            subtitle = listOfNotNull(
                step.machineName,
                if (threads.isEmpty()) "no threads yet" else "${threads.size} threads",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = "swipe move · tap open or start · 2-tap projects",
        )
    }

    private fun <T> windowedRows(
        items: List<T>,
        selected: Int,
        row: (T, Boolean) -> NexusCardLine,
    ): List<NexusCardLine> {
        val start = (selected - VISIBLE_SESSION_ROWS / 2)
            .coerceIn(0, (items.size - VISIBLE_SESSION_ROWS).coerceAtLeast(0))
        return items.drop(start).take(VISIBLE_SESSION_ROWS).mapIndexed { offset, item ->
            row(item, start + offset == selected)
        }
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
        return card(
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
        AgentStatus.NEEDS_YOU -> pendingSummary(session)
        AgentStatus.WORKING -> "working"
        AgentStatus.IDLE -> "idle"
        AgentStatus.ERROR -> "error"
        AgentStatus.DONE -> "finished"
    }

    // ------------------------------------------------------------------ common

    private fun card(
        title: String,
        subtitle: String,
        rows: List<NexusCardLine>,
        footer: String,
    ): NexusCard {
        val keySource = buildString {
            append(title).append('\n').append(subtitle).append('\n').append(footer).append('\n')
            rows.forEach { row ->
                append(row.badge).append('|').append(row.text).append('|')
                append(row.sub).append('|').append(row.tone.wireValue).append('|')
                append(row.selected).append('|').append(row.trail.joinToString(",")).append('\n')
            }
        }
        return NexusCard(
            title = title,
            lines = emptyList(),
            subtitle = subtitle,
            footer = footer,
            contentKey = MessageDigest.getInstance("SHA-256")
                .digest(keySource.toByteArray())
                .joinToString("") { "%02x".format(it) },
            richLines = rows,
            handlesBack = true,
        )
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
        private const val VISIBLE_SESSION_ROWS = 6
        private const val MIN_SESSION_ROWS = 4
        /**
         * Under the reader surface caps, and sized for the transport: past
         * 3 KiB a surface rides the CXR data plane, whose image contract is
         * 64 KiB — ~24k chars of text stays a ~30 KB frame, a ~90 ms push.
         */
        private const val READER_SEGMENT_CHARS = 4_000
        private const val READER_TOTAL_CHARS = 24_000
        private const val READER_MAX_SEGMENTS = 236
        private const val AGE_TICK_MS = 60_000L

        /** How often plain progress reaches the glasses board; the phone setting (0 = live) comes later. */
        private const val NOTICE_TITLE_CHARS = 32
        private const val NOTICE_BODY_CHARS = 240
        private const val ATTENTION_TTL_MS = 12_000L
        private const val SHORT_TTL_MS = 8_000L

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
        private const val MENU_LINE_CHARS = 240
        private const val CONTROL_MSG_IDS = 32
        private const val NOT_APPLIED_CHARS = 120
        private const val ALERT_DECISION_ROWS = 3
        private const val VOICE_ROW = 2

        /** Touchpad swipes come in as LEFT/RIGHT, the ring as UP/DOWN. */
        private val FORWARD_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_RIGHT,
            KeyEvent.KEYCODE_DPAD_DOWN,
            KeyEvent.KEYCODE_MEDIA_NEXT,
        )
        private val BACKWARD_KEYS = setOf(
            KeyEvent.KEYCODE_DPAD_LEFT,
            KeyEvent.KEYCODE_DPAD_UP,
            KeyEvent.KEYCODE_MEDIA_PREVIOUS,
        )
        private val PERMISSION_PATTERN =
            Regex("permission to use ([\\w.-]+)", RegexOption.IGNORE_CASE)
    }
}

private fun AgentProvider.enabledIn(config: AgentsConfig): Boolean = when (this) {
    // Codex rides the daemon link rather than a connection of its own, so it is
    // on exactly when the daemon is. It gets its own switch when the settings
    // screen learns to offer a choice of harness.
    AgentProvider.CLAUDE, AgentProvider.CODEX -> config.agentdEnabled
    AgentProvider.OPENCLAW -> config.openClawEnabled
}
