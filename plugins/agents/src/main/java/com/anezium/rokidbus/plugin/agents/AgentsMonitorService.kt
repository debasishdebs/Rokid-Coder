package com.anezium.rokidbus.plugin.agents

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import androidx.core.content.ContextCompat
import com.anezium.rokidbus.plugin.agents.BuildConfig.VERSION_NAME
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
import okhttp3.OkHttpClient
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Holds the connections to the agent providers while the HUD is closed.
 *
 * This service says nothing. It posts no alert, no summary, no progress: the
 * only notification it builds is the one `startForeground` requires, and the app
 * holds no notification permission, so Android never shows it. Everything the
 * wearer needs to know reaches them on the glasses, raised by
 * [AgentsPluginService].
 */
class AgentsMonitorService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val notifications by lazy { AgentNotifications(applicationContext) }
    private val httpClient by lazy {
        OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
    private val agentdClient by lazy {
        AgentdClient(httpClient, AgentsRuntime.store, serviceScope, VERSION_NAME)
    }
    private val openClawClient by lazy {
        OpenClawClient(httpClient, AgentsRuntime.store, configStore, serviceScope, VERSION_NAME)
    }
    private val linkServer by lazy {
        AgentdLinkServer(AgentsRuntime.store, configStore, serviceScope) { machineName ->
            AgentsRuntime.announceLinkedMachine(machineName)
        }
    }
    private var runningAgentd: AgentdConfig? = null
    private var runningOpenClaw: OpenClawConfig? = null
    private var temporaryAgentd: Job? = null
    private var temporaryOpenClaw: Job? = null

    // The one AlertCoordinator lives here, behind the director, so no alert depends
    // on the plugin service being alive. The glasses side and the notice callbacks
    // run on the main thread, so the director's work does too, one piece at a time.
    private val alertScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val alertWork = Channel<() -> Unit>(Channel.UNLIMITED)
    private val alertDirector by lazy {
        AlertDirector(
            coordinator = AlertCoordinator(System::currentTimeMillis),
            write = { line -> writeToAgentd(line) },
            secure = { AgentsRuntime.link.value?.secure == true },
            glasses = { AgentsRuntime.alertGlasses },
            post = { work -> alertWork.trySend(work) },
        )
    }

    override fun onCreate() {
        super.onCreate()
        notifications.createChannels()
        startForeground(MONITOR_NOTIFICATION_ID, notifications.monitorNotification())
        startAlerts()
        serviceScope.launch {
            combine(agentdClient.linkSecure, linkServer.linkSecure) { dialled, listened ->
                dialled || listened
            }.collect(AgentsRuntime::setLinkSecure)
        }
        serviceScope.launch {
            while (true) {
                delay(PRUNE_INTERVAL_MS)
                configStore.forgetNotificationFingerprints(AgentsRuntime.store.prune())
                // This loop is the heartbeat: a tick that arrives far late is
                // the only evidence from inside the process that the system
                // stopped scheduling it. See AgentsFreezeWatch.
                configStore.recordMonitorHeartbeat(PRUNE_INTERVAL_MS)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TEST_AGENTD -> {
                if (configStore.load().shouldMonitor) reconcile()
                testAgentd()
            }
            ACTION_TEST_OPENCLAW -> {
                if (configStore.load().shouldMonitor) reconcile()
                testOpenClaw()
            }
            ACTION_OPEN_DETAIL -> {
                intent.getStringExtra(EXTRA_SESSION_ID)?.let { sessionId ->
                    agentdClient.openDetail(sessionId)
                    linkServer.openDetail(sessionId)
                }
            }
            ACTION_CLOSE_DETAIL -> {
                agentdClient.closeDetail()
                linkServer.closeDetail()
            }
            ACTION_DROP_MACHINE -> {
                intent.getStringExtra(EXTRA_MACHINE_ID)?.let(linkServer::dropMachine)
            }
            ACTION_FS_LIST -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
                if (requestId != null) {
                    val path = intent.getStringExtra(EXTRA_PATH)
                    agentdClient.requestFolders(requestId, path)
                    linkServer.requestFolders(requestId, path)
                }
            }
            ACTION_THREAD_START -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
                val provider = AgentProvider.fromWire(intent.getStringExtra(EXTRA_PROVIDER))
                val path = intent.getStringExtra(EXTRA_PATH)
                val prompt = intent.getStringExtra(EXTRA_PROMPT).orEmpty()
                if (requestId != null && provider != null && path != null) {
                    agentdClient.requestThreadStart(requestId, provider, path, prompt)
                    linkServer.requestThreadStart(requestId, provider, path, prompt)
                }
            }
            ACTION_DECIDE_APPROVAL -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
                val decision = ApprovalDecision.values()
                    .firstOrNull { it.wireValue == intent.getStringExtra(EXTRA_DECISION) }
                if (requestId != null && decision != null) {
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
            }
            ACTION_SEND_SESSION_INPUT -> {
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID)
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                val text = intent.getStringExtra(EXTRA_TEXT)
                if (requestId != null && sessionId != null && text != null) {
                    agentdClient.sendSessionInput(requestId, sessionId, text)
                    linkServer.sendSessionInput(requestId, sessionId, text)
                }
            }
            ACTION_SEND_V2 -> {
                // A line that is not one JSON object comes back Refused, unsent.
                intent.getStringExtra(EXTRA_FRAME)?.let(::writeToAgentd)
            }
            else -> reconcile()
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /** Any v2 frame over a link that steers means v1 attention stays off for that computer for good (R92). */
    private fun noteV2(event: AgentdEvent) {
        val v2 = event is AgentdEvent.Action && when (event.action) {
            is AgentdAction.Alert, is AgentdAction.AlertClosed, is AgentdAction.FollowupClosed,
            is AgentdAction.ModeReset, is AgentdAction.Models, is AgentdAction.Ack,
            -> true
            else -> false
        }
        if (v2 && AgentsRuntime.link.value?.secure == true) {
            configStore.markV2Seen(AgentsRuntime.store.linkMachine.value?.machineId)
        }
    }

    private fun startAlerts() {
        AgentsRuntime.alertDirector = alertDirector
        alertScope.launch { for (work in alertWork) work() }
        // Launched on Main.immediate, so each collector is subscribed before this returns.
        alertScope.launch {
            AgentsRuntime.events.collect { event ->
                noteV2(event)
                alertDirector.onEvent(event)
            }
        }
        alertScope.launch {
            AgentsRuntime.store.sessions
                .map { sessions -> sessions.mapTo(HashSet()) { it.key } as Set<String> }
                .distinctUntilChanged()
                .collect(alertDirector::onBoard)
        }
    }

    /**
     * A prebuilt frame line to whichever transport holds the link. The wire of
     * each one classifies it; a steering frame over plaintext is MonitorOnly.
     */
    private fun writeToAgentd(line: String): AgentdWire.Result =
        combined(listOf(agentdClient.write(line), linkServer.write(line)))

    private fun combined(results: List<AgentdWire.Result>): AgentdWire.Result = when {
        AgentdWire.Result.Sent in results -> AgentdWire.Result.Sent
        AgentdWire.Result.Refused in results -> AgentdWire.Result.Refused
        AgentdWire.Result.MonitorOnly in results -> AgentdWire.Result.MonitorOnly
        else -> AgentdWire.Result.NoLink
    }

    override fun onDestroy() {
        temporaryAgentd?.cancel()
        temporaryOpenClaw?.cancel()
        agentdClient.stop(clearSessions = true)
        linkServer.stop(clearSessions = true)
        openClawClient.stop(clearSessions = true)
        releasePluginService()
        httpClient.dispatcher.executorService.shutdown()
        serviceScope.cancel()
        AgentsRuntime.alertDirector = null
        alertScope.cancel()
        alertWork.close()
        AgentsRuntime.setLinkSecure(false)
        super.onDestroy()
    }

    private fun reconcile() {
        val config = configStore.load()
        if (!config.shouldMonitor) {
            stopMonitoring()
            return
        }
        startService(
            Intent(this, AgentsPluginService::class.java)
                .setAction(AgentsPluginService.ACTION_MONITOR_ACTIVE),
        )
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
        if (config.agentdEnabled && wantedAgentd == null) {
            linkServer.start()
        } else {
            linkServer.stop(clearSessions = wantedAgentd == null)
        }
        if (config.openClawEnabled) {
            temporaryOpenClaw?.cancel()
            temporaryOpenClaw = null
        }
        val wantedOpenClaw = config.openClaw?.takeIf { config.openClawEnabled && it.configured }
        if (wantedOpenClaw != runningOpenClaw) {
            if (wantedOpenClaw == null) {
                openClawClient.stop(clearSessions = true)
            } else {
                openClawClient.start(wantedOpenClaw)
            }
            runningOpenClaw = wantedOpenClaw
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

    private fun testOpenClaw() {
        val config = configStore.load()
        val gateway = config.openClaw ?: return stopIfNoConfiguredProvider()
        openClawClient.start(gateway)
        runningOpenClaw = if (config.openClawEnabled) gateway else null
        temporaryOpenClaw?.cancel()
        temporaryOpenClaw = null
        if (!config.openClawEnabled) {
            temporaryOpenClaw = serviceScope.launch {
                delay(TEST_WINDOW_MS)
                if (configStore.load().openClawEnabled) return@launch
                openClawClient.stop(clearSessions = true)
                temporaryOpenClaw = null
                stopIfNoConfiguredProvider()
            }
        }
    }

    private fun stopIfNoConfiguredProvider() {
        if (!configStore.load().shouldMonitor &&
            temporaryAgentd?.isActive != true &&
            temporaryOpenClaw?.isActive != true
        ) {
            stopMonitoring()
        }
    }

    private fun stopMonitoring() {
        agentdClient.stop(clearSessions = true)
        linkServer.stop(clearSessions = true)
        openClawClient.stop(clearSessions = true)
        runningAgentd = null
        runningOpenClaw = null
        releasePluginService()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /**
     * The plugin service is the hub's to own while a surface is up. We only
     * started it to keep a bus client alive for alerts, so we only take that
     * back when the wearer is not actually looking at it.
     */
    private fun releasePluginService() {
        if (AgentsRuntime.hudOpen) return
        stopService(Intent(this, AgentsPluginService::class.java))
    }

    companion object {
        const val ACTION_RECONCILE =
            "com.anezium.rokidbus.plugin.agents.action.RECONCILE"
        const val ACTION_TEST_AGENTD =
            "com.anezium.rokidbus.plugin.agents.action.TEST_AGENTD"
        const val ACTION_TEST_OPENCLAW =
            "com.anezium.rokidbus.plugin.agents.action.TEST_OPENCLAW"
        const val ACTION_OPEN_DETAIL =
            "com.anezium.rokidbus.plugin.agents.action.OPEN_DETAIL"
        const val ACTION_CLOSE_DETAIL =
            "com.anezium.rokidbus.plugin.agents.action.CLOSE_DETAIL"
        const val ACTION_DECIDE_APPROVAL =
            "com.anezium.rokidbus.plugin.agents.action.DECIDE_APPROVAL"
        const val ACTION_DROP_MACHINE =
            "com.anezium.rokidbus.plugin.agents.action.DROP_MACHINE"
        const val ACTION_FS_LIST =
            "com.anezium.rokidbus.plugin.agents.action.FS_LIST"
        const val ACTION_THREAD_START =
            "com.anezium.rokidbus.plugin.agents.action.THREAD_START"
        const val ACTION_SEND_SESSION_INPUT =
            "com.anezium.rokidbus.plugin.agents.action.SEND_SESSION_INPUT"
        const val ACTION_SEND_V2 =
            "com.anezium.rokidbus.plugin.agents.action.SEND_V2"
        const val EXTRA_SESSION_ID = "sessionId"
        const val EXTRA_MACHINE_ID = "machineId"
        const val EXTRA_PATH = "path"
        const val EXTRA_PROVIDER = "provider"
        const val EXTRA_PROMPT = "prompt"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_TEXT = "text"
        const val EXTRA_FRAME = "frame"
        private const val MONITOR_NOTIFICATION_ID = 3101
        private const val TEST_WINDOW_MS = 15_000L
        private const val PRUNE_INTERVAL_MS = 60_000L

        fun reconcile(context: Context) {
            val config = AgentsConfigStore(context).load()
            val intent = Intent(context, AgentsMonitorService::class.java)
                .setAction(ACTION_RECONCILE)
            if (config.shouldMonitor) {
                ContextCompat.startForegroundService(context, intent)
            } else {
                context.stopService(intent)
                if (!AgentsRuntime.hudOpen) {
                    context.stopService(Intent(context, AgentsPluginService::class.java))
                }
            }
        }

        /** The wearer opened a conversation on the HUD: ask the daemon for it. */
        fun openDetail(context: Context, session: AgentSession) {
            if (session.provider !in AgentProvider.AGENTD_PROVIDERS) return
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_OPEN_DETAIL)
                    .putExtra(EXTRA_SESSION_ID, session.id),
            )
        }

        /** The wearer answered a held tool call on the glasses. */
        fun decideApproval(context: Context, requestId: String, decision: ApprovalDecision) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_DECIDE_APPROVAL)
                    .putExtra(EXTRA_REQUEST_ID, requestId)
                    .putExtra(EXTRA_DECISION, decision.wireValue),
            )
        }

        /** The wearer typed a reply into a session's terminal on the glasses. */
        fun sendSessionInput(context: Context, requestId: String, sessionId: String, text: String) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_SEND_SESSION_INPUT)
                    .putExtra(EXTRA_REQUEST_ID, requestId)
                    .putExtra(EXTRA_SESSION_ID, sessionId)
                    .putExtra(EXTRA_TEXT, text),
            )
        }

        /** A prebuilt protocol v2 frame line, from the AgentdProtocolCodec builders. */
        fun sendV2(context: Context, frame: String) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_SEND_V2)
                    .putExtra(EXTRA_FRAME, frame),
            )
        }

        fun closeDetail(context: Context) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_CLOSE_DETAIL),
            )
        }

        /**
         * Forgetting a machine is a preference write plus, when its link is
         * live right now, a disconnect — the trust is gone, so the connection
         * that rode on it goes too.
         */
        fun forgetMachine(context: Context, machineId: String) {
            AgentsConfigStore(context).forgetMachine(machineId)
            if (AgentsConfigStore(context).load().shouldMonitor) {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, AgentsMonitorService::class.java)
                        .setAction(ACTION_DROP_MACHINE)
                        .putExtra(EXTRA_MACHINE_ID, machineId),
                )
            }
        }

        /** The wearer asked for a new session inside an anchored project. */
        fun requestThreadStart(
            context: Context,
            requestId: String,
            provider: AgentProvider,
            path: String,
            prompt: String,
        ) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_THREAD_START)
                    .putExtra(EXTRA_REQUEST_ID, requestId)
                    .putExtra(EXTRA_PROVIDER, provider.wireValue)
                    .putExtra(EXTRA_PATH, path)
                    .putExtra(EXTRA_PROMPT, prompt),
            )
        }

        /** The wearer is browsing a linked computer's folders in the picker. */
        fun requestFolders(context: Context, requestId: String, path: String?) {
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java)
                    .setAction(ACTION_FS_LIST)
                    .putExtra(EXTRA_REQUEST_ID, requestId)
                    .putExtra(EXTRA_PATH, path),
            )
        }

        fun test(context: Context, provider: AgentProvider) {
            val action = when (provider) {
                // Codex arrives over the daemon's link, so testing it is testing
                // the daemon: there is no second connection to prove.
                AgentProvider.CLAUDE, AgentProvider.CODEX -> ACTION_TEST_AGENTD
                AgentProvider.OPENCLAW -> ACTION_TEST_OPENCLAW
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentsMonitorService::class.java).setAction(action),
            )
        }
    }
}
