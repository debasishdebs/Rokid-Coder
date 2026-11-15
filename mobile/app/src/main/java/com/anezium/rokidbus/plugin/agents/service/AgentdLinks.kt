package com.anezium.rokidbus.plugin.agents.service

import android.content.Context
import android.util.Log
import androidx.annotation.MainThread
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.AgentdClient
import com.anezium.rokidbus.plugin.agents.AgentdConfig
import com.anezium.rokidbus.plugin.agents.AgentdEvent
import com.anezium.rokidbus.plugin.agents.AgentdLinkServer
import com.anezium.rokidbus.plugin.agents.AgentdWire
import com.anezium.rokidbus.plugin.agents.AgentsConfigStore
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.AlertCoordinator
import com.anezium.rokidbus.plugin.agents.AlertDirector
import com.anezium.rokidbus.plugin.agents.ApprovalDecision
import com.anezium.rokidbus.plugin.agents.BuildConfig.VERSION_NAME
import com.anezium.rokidbus.plugin.agents.KeystorePhoneTlsIdentity
import com.anezium.rokidbus.plugin.agents.ListenerPlan
import com.anezium.rokidbus.plugin.agents.PAIRING_TTL_TICK_MS
import com.anezium.rokidbus.plugin.agents.PairLineTarget
import com.anezium.rokidbus.plugin.agents.PairingAttempts
import com.anezium.rokidbus.plugin.agents.PairingRecord
import com.anezium.rokidbus.plugin.agents.SasDoor
import com.anezium.rokidbus.plugin.agents.SasWssDialer
import com.anezium.rokidbus.plugin.agents.historyHeading
import com.anezium.rokidbus.plugin.agents.inboundListenerPlan
import com.anezium.rokidbus.plugin.agents.onboarding.PairReadyWindow
import com.anezium.rokidbus.plugin.agents.runPairingTtlTick
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The connections to the agent providers, as the former monitor service ran them, now inside
 * [CoderService]: both agentd transports, the pairing door, the TTL tick, prune, the freeze-watch
 * heartbeat, settings sync, the test link and the one [AlertDirector].
 *
 * It says nothing about any session on the phone. Everything the wearer needs to know reaches
 * them on the glasses, raised by the Agents core. With monitoring off the transports stop and
 * the service stays up for the glasses; only the notification's Stop ends the service.
 */
internal class AgentdLinks(context: Context) : CoderCommands {
    private val applicationContext = context.applicationContext
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val httpClient by lazy {
        OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
    // One identity for both links: agentd pins the same certificate on each (R168).
    private val tlsIdentity by lazy { KeystorePhoneTlsIdentity() }
    private val agentdClient by lazy {
        // The wss dial goes through its own client, built from this one (pinnedOkHttpClient).
        AgentdClient(
            httpClient, AgentsRuntime.store, serviceScope, VERSION_NAME, tlsIdentity,
            dialAllowed = {
                // A pairing the TTL just signed out is dropped from the monitor at once, not at the next tick.
                configStore.outboundAdmitted().also { admitted -> if (!admitted) alertScope.launch { reconcile() } }
            },
            touchUsed = configStore::touchAgentdUsed,
            // A refused slot is dialled again while a guided attempt's window is open (R198).
            repairRedial = configStore::isLinkWindowOpen,
            onSecureConnected = AgentsRuntime::announceSecureConnection,
            onSecureLinkClosed = AgentsRuntime::announceSecureLinkClosed,
        )
    }
    private val linkServer by lazy {
        AgentdLinkServer(
            AgentsRuntime.store, configStore, serviceScope, tlsIdentity,
            onSecureConnected = AgentsRuntime::announceSecureConnection,
            onSecureLinkClosed = AgentsRuntime::announceSecureLinkClosed,
            // A bound link ended: the listener may have been kept only for it.
            onLinkEnded = {
                // The shared connection state shows the inbound computer: the dialled slot's own state goes back.
                agentdClient.republishState()
                alertScope.launch { reconcile() }
            },
            onMachineTrusted = { machineName -> AgentsRuntime.announceLinkedMachine(machineName) },
            // A new computer pairs only by SAS: the door decides whether one may start here.
            door = SasDoor(
                open = configStore::isLinkWindowOpen,
                attempts = PairingAttempts,
                phoneFingerprint = tlsIdentity::fingerprint256,
                commit = configStore::commitPairing,
                recordForCert = configStore::pairingRecordForCert,
                onPaired = ::onPaired,
                onPairReady = { ready -> sasDialer.dial(ready.host, ready.wsPort, expectedFp = null, peerName = ready.machineName) },
                pairReadyOpener = { PairReadyWindow.opener },
            ),
        )
    }

    /** The phone dialling agentd's wss for a SAS session: from a pair-ready announcement or a v2 line. */
    private val sasDialer by lazy {
        SasWssDialer(httpClient, tlsIdentity, PairingAttempts, configStore::commitPairing, ::onPaired)
    }

    /** Set by a pasted pairing line, the wearer's own request to pair: it opens the window for that one dial. */
    private val lineArmed = AtomicBoolean(false)

    /** A SAS pairing stored its record: the computer is linked, and the monitor dials it as usual now. */
    private fun onPaired(record: PairingRecord) {
        AgentsRuntime.announceLinkedMachine(record.machineName)
        alertScope.launch { reconcile() }
    }
    private var runningAgentd: AgentdConfig? = null
    private var listenerBesideDialled = false
    private var windowWatch: Job? = null
    private var temporaryAgentd: Job? = null

    // The one AlertCoordinator lives here, behind the director, so no alert depends
    // on the glasses surface being open. The glasses side and the notice callbacks
    // run on the main thread, so the director's work does too, one piece at a time.
    private val alertScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val alertWork = Channel<() -> Unit>(Channel.UNLIMITED)
    private var stopFollowingDepartures: (() -> Unit)? = null
    private val alertDirector by lazy {
        AlertDirector(
            coordinator = AlertCoordinator(System::currentTimeMillis),
            write = { line -> writeToAgentd(line) },
            secure = { AgentsRuntime.link.value?.secure == true },
            glasses = { AgentsRuntime.alertGlasses },
            post = { work -> alertWork.trySend(work) },
            schedule = { delayMs, work ->
                val timer = alertScope.launch {
                    delay(delayMs)
                    work()
                }
                val cancel: () -> Unit = { timer.cancel() }
                cancel
            },
            history = AgentsRuntime.history,
            historyPolicy = { configStore.historyPolicy() },
            headingOf = { key -> AgentsRuntime.store.sessions.value.firstOrNull { it.key == key }?.historyHeading() },
            soundPrefs = { configStore.alertSettings().sounds },
        )
    }

    /** The monitor service's onCreate, without its notification: the service owns that now. */
    @MainThread
    fun start() {
        // The phone's one pairing window, for both transports: the first commitment spends the door and a pasted line's
        // arming together, and an attempt that ends leaves both shut until the wearer opens one again.
        PairingAttempts.window = {
            val door = configStore.consumeLinkWindow()
            val line = lineArmed.getAndSet(false)
            door || line
        }
        startAlerts()
        serviceScope.launch {
            combine(agentdClient.linkSecure, linkServer.linkSecure) { dialled, listened ->
                dialled || listened
            }.collect(AgentsRuntime::setLinkSecure)
        }
        serviceScope.launch {
            agentdClient.needsRepair.collect { refused ->
                AgentsRuntime.setNeedsRepair(refused)
                // A refusal acts on the whole pairing (6a-R3): its PhoneLink trust and its outbound slot both go,
                // so a restart has no credentials to retry, and both transports' links to it end now.
                if (refused) {
                    configStore.revokeRefusedPairing()?.let(linkServer::dropMachine)
                    withContext(Dispatchers.Main) { reconcile() }
                }
            }
        }
        configStore.clearRetiredKeys()
        // Before the first reconcile: whatever went unused while the service was down is signed out first.
        ttlTick()
        serviceScope.launch {
            while (true) {
                delay(PAIRING_TTL_TICK_MS)
                // The sweep drops links and restarts the monitor, which the main thread owns.
                withContext(Dispatchers.Main) { reconcile() }
            }
        }
        serviceScope.launch {
            while (true) {
                delay(PRUNE_INTERVAL_MS)
                AgentsRuntime.store.prune()
                // Expiry must not wait for another alert: the history ages out on this clock too.
                AgentsRuntime.history.pruneNow(configStore.historyPolicy())
                // This loop is the heartbeat: a tick that arrives far late is
                // the only evidence from inside the process that the system
                // stopped scheduling it. See AgentsFreezeWatch.
                configStore.recordMonitorHeartbeat(PRUNE_INTERVAL_MS)
            }
        }
    }

    /** The monitor service's onDestroy. */
    @MainThread
    fun close() {
        temporaryAgentd?.cancel()
        windowWatch?.cancel()
        agentdClient.stop(clearSessions = true)
        linkServer.stop(clearSessions = true)
        httpClient.dispatcher.executorService.shutdown()
        serviceScope.cancel()
        stopFollowingDepartures?.invoke()
        stopFollowingDepartures = null
        AgentsRuntime.clearAlertDirector(alertDirector)
        alertScope.cancel()
        alertWork.close()
        AgentsRuntime.setLinkSecure(false)
        AgentsRuntime.setNeedsRepair(false)
    }

    /** The director, for a brief the service raises on the glasses itself. */
    fun brief(title: String, body: String) = alertDirector.onBrief(title, body)

    // ------------------------------------------------------------- commands

    override fun reconcile() {
        ttlTick()
        val config = configStore.load()
        if (!config.shouldMonitor) {
            stopLinks()
            return
        }
        // Pairing data is the away-from-home path (we dial the daemon over the
        // tailnet). With none configured we simply listen: the daemon finds us.
        val wantedAgentd = config.agentd?.takeIf { config.agentdEnabled && it.configured }
        // A test started while the provider was off installs a timer that stops
        // it again. Enabling the provider in the meantime must disarm that timer,
        // or it fires later and kills a connection nobody asked it to touch.
        if (config.agentdEnabled) {
            temporaryAgentd?.cancel()
            temporaryAgentd = null
        }
        if (wantedAgentd != runningAgentd) {
            if (wantedAgentd == null) {
                agentdClient.stop(clearSessions = true)
            } else {
                agentdClient.start(wantedAgentd)
            }
            runningAgentd = wantedAgentd
        }
        // The door always has a listener: while a window is open the inbound server runs beside a dialled slot too,
        // and a computer paired through it stays connected after the window ends, until its own link does.
        val windowOpen = configStore.isLinkWindowOpen()
        val dialled = wantedAgentd != null
        when (
            inboundListenerPlan(
                config.agentdEnabled, outboundSlot = dialled, windowOpen = windowOpen,
                besideMode = listenerBesideDialled, boundLink = linkServer.linkSecure.value,
            )
        ) {
            ListenerPlan.RUN_ALONE -> {
                linkServer.start(besideDialled = false)
                listenerBesideDialled = false
            }
            ListenerPlan.RUN_BESIDE, ListenerPlan.KEEP_BESIDE -> {
                linkServer.start(besideDialled = true)
                listenerBesideDialled = true
            }
            ListenerPlan.STOP -> {
                if (wantedAgentd == null || listenerBesideDialled) {
                    linkServer.stop(clearSessions = wantedAgentd == null, besideDialled = listenerBesideDialled)
                }
                listenerBesideDialled = false
            }
        }
        // A slot refused before the door opened is dialled again for as long as it stays open.
        if (windowOpen && config.agentdEnabled && wantedAgentd != null) agentdClient.retryRefused(wantedAgentd)
        watchWindow(windowOpen)
    }

    override fun openDetail(session: AgentSession) {
        if (session.provider !in AgentProvider.AGENTD_PROVIDERS) return
        agentdClient.openDetail(session.id)
        linkServer.openDetail(session.id)
    }

    override fun closeDetail() {
        agentdClient.closeDetail()
        linkServer.closeDetail()
    }

    override fun decideApproval(requestId: String, decision: ApprovalDecision) {
        val results = listOf(
            agentdClient.decideApproval(requestId, decision),
            linkServer.decideApproval(requestId, decision),
        )
        // The wearer answered: the question is gone from the board
        // whether or not the daemon's acknowledgement makes it back.
        // A decision the wire refused never left, so it stays.
        if (combined(results) == AgentdWire.Result.Sent) {
            AgentsRuntime.store.resolveApproval(requestId)
        }
    }

    override fun sendSessionInput(requestId: String, sessionId: String, text: String) {
        agentdClient.sendSessionInput(requestId, sessionId, text)
        linkServer.sendSessionInput(requestId, sessionId, text)
    }

    override fun sendV2(frame: String) {
        // A line that is not one JSON object comes back Refused, unsent.
        if (writeToAgentd(frame) == AgentdWire.Result.Sent) followupOf(frame)?.let { (key, msgId) ->
            AgentsRuntime.alertDirector?.onFollowupWritten(key, msgId)
        }
    }

    override fun requestFolders(requestId: String, path: String?) {
        agentdClient.requestFolders(requestId, path)
        linkServer.requestFolders(requestId, path)
    }

    override fun requestThreadStart(requestId: String, provider: AgentProvider, path: String, prompt: String) {
        agentdClient.requestThreadStart(requestId, provider, path, prompt)
        linkServer.requestThreadStart(requestId, provider, path, prompt)
    }

    /**
     * Forgetting a machine is a preference write plus, when its link is
     * live right now, a disconnect — the trust is gone, so the connection
     * that rode on it goes too.
     */
    override fun forgetMachine(machineId: String) {
        // One pairing, both transports (6a-R3): its outbound slot goes with its PhoneLink trust.
        configStore.forgetPairing(machineId)
        if (!configStore.load().shouldMonitor) return
        linkServer.dropMachine(machineId)
        // Its outbound slot went with the pairing: the dialled link stops too.
        reconcile()
    }

    /** Pairing is an explicit request to monitor, as opening the door is. */
    override fun pairWithLine(target: PairLineTarget) {
        if (!configStore.load().agentdEnabled) configStore.setAgentdEnabled(true)
        if (target.port !in 1..65535) return
        lineArmed.set(true)
        sasDialer.dial(target.host, target.port, target.fp, peerName = target.host)
    }

    /** With nothing monitored there is no link, and the next secure link up sends the saved settings instead. */
    override fun pushSettings() {
        if (!configStore.load().shouldMonitor) return
        syncSettings()
    }

    override fun testLink(provider: AgentProvider) {
        when (provider) {
            // Codex arrives over the daemon's link, so testing it is testing
            // the daemon: there is no second connection to prove.
            AgentProvider.CLAUDE, AgentProvider.CODEX -> {
                if (configStore.load().shouldMonitor) reconcile()
                testAgentd()
            }
        }
    }

    // --------------------------------------------------------------- alerts

    private fun startAlerts() {
        AgentsRuntime.alertDirector = alertDirector
        alertScope.launch {
            for (work in alertWork) {
                // One failing effect must not end the consumer, and with it every alert after it.
                // Only the class is logged: a message could carry agent text.
                runCatching { work() }.onFailure { Log.w(TAG, "alert work failed: ${it.javaClass.simpleName}") }
            }
        }
        // Launched on Main.immediate, so each collector is subscribed before this returns.
        alertScope.launch {
            AgentsRuntime.events.collect { event ->
                alertDirector.onEvent(event)
                // Every secure link up carries the phone's settings; one not bound as secure cannot steer, so sends none.
                if (event is AgentdEvent.LinkUp && event.secure) syncSettings()
            }
        }
        alertScope.launch {
            AgentsRuntime.store.sessions
                .map { sessions -> sessions.mapTo(HashSet()) { it.key } as Set<String> }
                .distinctUntilChanged()
                .collect(alertDirector::onBoard)
        }
        // A direct call, so no departure is ever lost to a full buffer; the director posts it to its own thread.
        stopFollowingDepartures?.invoke()
        stopFollowingDepartures = AgentsRuntime.store.onSessionDeparted(alertDirector::onSessionEnded)
    }

    /**
     * `settings_sync` and `defaults_set`, both steering (R61): sent through the wire only,
     * which refuses them on a link not bound as secure. Not sent here when the link is not secure,
     * since the next secure link up sends them.
     */
    private fun syncSettings() {
        if (AgentsRuntime.link.value?.secure != true) return
        configStore.alertSettings().syncFrames(configStore.pairingTtlDays()).forEach { writeToAgentd(it) }
    }

    /**
     * A prebuilt frame line to whichever transport holds the link. The wire of
     * each one classifies it; a steering frame over a link not bound as secure
     * comes back NotSecure, unsent.
     */
    private fun writeToAgentd(line: String): AgentdWire.Result =
        combined(listOf(agentdClient.write(line), linkServer.write(line)))

    /** The session and msgId of a `followup` frame, or null for any other frame. */
    private fun followupOf(frame: String): Pair<String, String>? = runCatching {
        val json = JSONObject(frame).takeIf { it.optString("type") == "followup" } ?: return@runCatching null
        val key = json.optString("sessionKey").takeIf(String::isNotBlank) ?: return@runCatching null
        val msgId = json.optString("msgId").takeIf(String::isNotBlank) ?: return@runCatching null
        key to msgId
    }.getOrNull()

    private fun combined(results: List<AgentdWire.Result>): AgentdWire.Result = when {
        AgentdWire.Result.Sent in results -> AgentdWire.Result.Sent
        AgentdWire.Result.Refused in results -> AgentdWire.Result.Refused
        AgentdWire.Result.NotSecure in results -> AgentdWire.Result.NotSecure
        else -> AgentdWire.Result.NoLink
    }

    // ---------------------------------------------------------------- links

    /**
     * Touches the live links, then signs out what has gone unused past the TTL. An inbound
     * computer that was signed out has its link dropped; the outbound slot is stopped by [reconcile].
     */
    private fun ttlTick(): Boolean {
        val before = configStore.trustedMachines().mapTo(HashSet()) { it.machineId }
        val signedOut = runPairingTtlTick(
            touchLive = listOf(agentdClient::touchLive, linkServer::touchLive),
            sweep = { configStore.expireUnused() },
        )
        if (signedOut.isEmpty()) return false
        val after = configStore.trustedMachines().mapTo(HashSet()) { it.machineId }
        (before - after).forEach(linkServer::dropMachine)
        return true
    }

    /** The window's end is a change nobody else announces: reconcile again then, and the listener goes back to the normal rule. */
    private fun watchWindow(open: Boolean) {
        windowWatch?.cancel()
        windowWatch = null
        if (!open) return
        val left = configStore.linkWindowRemainingMs()
        windowWatch = alertScope.launch {
            delay(left + WINDOW_END_SLACK_MS)
            reconcile()
        }
    }

    private fun testAgentd() {
        val config = configStore.load()
        val pairing = config.agentd ?: return stopIfNoConfiguredProvider()
        agentdClient.start(pairing)
        runningAgentd = if (config.agentdEnabled) pairing else null
        temporaryAgentd?.cancel()
        temporaryAgentd = null
        if (!config.agentdEnabled) {
            temporaryAgentd = serviceScope.launch {
                delay(TEST_WINDOW_MS)
                // Enabled during the window: the permanent client owns it now.
                if (configStore.load().agentdEnabled) return@launch
                agentdClient.stop(clearSessions = true)
                temporaryAgentd = null
                stopIfNoConfiguredProvider()
            }
        }
    }

    private fun stopIfNoConfiguredProvider() {
        if (!configStore.load().shouldMonitor && temporaryAgentd?.isActive != true) {
            stopLinks()
        }
    }

    /** Monitoring off: the transports stop, and the service stays up for the glasses. */
    private fun stopLinks() {
        windowWatch?.cancel()
        windowWatch = null
        listenerBesideDialled = false
        agentdClient.stop(clearSessions = true)
        linkServer.stop(clearSessions = true)
        runningAgentd = null
    }

    private companion object {
        const val TAG = "AgentdLinks"
        const val TEST_WINDOW_MS = 15_000L
        const val WINDOW_END_SLACK_MS = 250L
        const val PRUNE_INTERVAL_MS = 60_000L
    }
}
