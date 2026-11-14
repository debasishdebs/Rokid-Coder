package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The paired path: the phone dials agentd's WebSocket. A pairing with a pin
 * (`fp`) dials `wss://` through [pinnedClient] only, and never anything else;
 * one without is the legacy `ws://` link, monitor-only. Steering needs the pin
 * and the steering secret together, which only a pinned hello carries.
 */
class AgentdClient(
    private val httpClient: OkHttpClient,
    private val store: AgentSessionStore,
    private val scope: CoroutineScope,
    private val versionName: String,
    private val pinnedClient: (pin: String) -> OkHttpClient = { pin -> pinnedOkHttpClient(httpClient, pin) },
    onEvent: (AgentdEvent) -> Unit = AgentsRuntime::emitEvent,
) {
    private var loopJob: Job? = null
    private val sockets = GenerationSlot<WebSocket>()

    /** OkHttp only enqueues, so this never blocks the caller's thread. */
    private val wire = AgentdWire { line -> sockets.current()?.send(line) ?: false }
    private val link = AgentdLinkBinding(wire, onEvent)

    /** Whether this transport may carry steering frames right now. */
    val linkSecure: StateFlow<Boolean> get() = wire.secure

    /** Survives reconnects: the daemon forgets, the wearer should not. */
    @Volatile private var openSessionId: String? = null

    fun openDetail(sessionId: String): AgentdWire.Result {
        openSessionId = sessionId
        return write(AgentdProtocolCodec.detailOpen(sessionId))
    }

    fun closeDetail(): AgentdWire.Result {
        openSessionId = null
        return write(AgentdProtocolCodec.DETAIL_CLOSE)
    }

    fun decideApproval(requestId: String, decision: ApprovalDecision): AgentdWire.Result =
        write(AgentdProtocolCodec.approvalDecision(requestId, decision))

    fun sendSessionInput(requestId: String, sessionId: String, text: String): AgentdWire.Result =
        write(AgentdProtocolCodec.sessionInput(requestId, sessionId, text))

    fun requestFolders(requestId: String, path: String?): AgentdWire.Result =
        write(AgentdProtocolCodec.fsList(requestId, path))

    fun requestThreadStart(
        requestId: String,
        provider: AgentProvider,
        path: String,
        prompt: String,
    ): AgentdWire.Result = write(AgentdProtocolCodec.threadStart(requestId, provider, path, prompt))

    /** Any prebuilt frame line, v2 or v1; the wire decides whether it may leave. */
    fun write(line: String): AgentdWire.Result = wire.write(line)

    @Synchronized
    fun start(config: AgentdConfig) {
        loopJob?.cancel()
        val advance = sockets.advance()
        // After the advance, so a hello_ack still in flight cannot bind behind us.
        link.downCurrent()
        advance.previous?.cancel()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            runConnectionLoop(config, advance.generation)
        }
        loopJob = job
        job.start()
    }

    @Synchronized
    fun stop(clearSessions: Boolean) {
        loopJob?.cancel()
        loopJob = null
        val advance = sockets.advance()
        link.downCurrent()
        advance.previous?.cancel()
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.DISCONNECTED)
        store.clearApprovals(AgentProvider.AGENTD_PROVIDERS)
        if (clearSessions) {
            store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList())
        }
    }

    private suspend fun runConnectionLoop(config: AgentdConfig, generation: Long) {
        val pin = when (val parsed = CertPins.parse(config.fp)) {
            PinParse.Absent -> null
            is PinParse.Valid -> parsed.fp
            // A stored pin that no longer reads is still a pin: refused, never dialled as ws://.
            PinParse.Malformed -> {
                if (sockets.isCurrent(generation)) {
                    store.setConnection(AgentProvider.CLAUDE, ConnectionState.AUTH_FAILED, PairingCopy.BAD_FINGERPRINT)
                }
                return
            }
        }
        val http = if (pin == null) httpClient else pinnedClient(pin)
        val backoff = ReconnectBackoff()
        while (scope.isActive && sockets.isCurrent(generation)) {
            store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING)
            val result = try {
                connectOnce(config, pin, http, generation, backoff)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                ConnectionOutcome.Retry
            } finally {
                sockets.clear(generation)?.cancel()
            }
            if (!sockets.isCurrent(generation)) return
            when (result) {
                is ConnectionOutcome.AuthFailed -> {
                    store.setConnection(
                        AgentProvider.CLAUDE,
                        ConnectionState.AUTH_FAILED,
                        result.detail,
                    )
                    return
                }
                is ConnectionOutcome.RetryWithDetail -> {
                    store.setConnection(
                        AgentProvider.CLAUDE,
                        ConnectionState.DISCONNECTED,
                        result.detail,
                    )
                }
                ConnectionOutcome.Retry -> {
                    store.setConnection(
                        AgentProvider.CLAUDE,
                        ConnectionState.DISCONNECTED,
                        "Connection lost",
                    )
                }
            }
            delay(backoff.nextDelayMs())
        }
    }

    private suspend fun connectOnce(
        config: AgentdConfig,
        pin: String?,
        http: OkHttpClient,
        generation: Long,
        backoff: ReconnectBackoff,
    ): ConnectionOutcome = coroutineScope {
        val codec = AgentdProtocolCodec().also(AgentdProtocolCodec::reset)
        val ended = CompletableDeferred<ConnectionOutcome>()
        val connected = AtomicBoolean(false)
        val owner = LinkOwner()
        lateinit var deadlines: ConnectionDeadlines

        fun isLive(): Boolean = sockets.isCurrent(generation) && !ended.isCompleted

        // Every end of this connection ends its link at once, by owner: whether
        // or not a hello_ack is binding on another thread right now.
        fun finish(outcome: ConnectionOutcome) {
            ended.complete(outcome)
            link.end(owner)
        }

        deadlines = ConnectionDeadlines(this) { detail ->
            if (sockets.isCurrent(generation)) {
                finish(ConnectionOutcome.RetryWithDetail(detail))
            }
        }
        val request = Request.Builder()
            .url(webSocketUrl(config.host, config.port, secure = pin != null))
            .build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isLive()) {
                    webSocket.cancel()
                    return
                }
                // The handshake precedes the binding, so it is written to this
                // socket directly; every later line goes through the wire. On a
                // pinned link OkHttp opens only after the pinned trust manager and
                // hostname check passed on the TLS session itself, so neither the
                // token nor the secret leaves before the pin is verified.
                val steer = config.steer.takeIf { pin != null }
                if (!webSocket.send(codec.hello(config.token, versionName, steer))) {
                    finish(ConnectionOutcome.Retry)
                    return
                }
                deadlines.arm(DEADLINE_HELLO, "Daemon hello timed out")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isLive()) return
                when (val action = codec.parse(text)) {
                    is AgentdAction.HelloAcknowledged -> {
                        if (!connected.compareAndSet(false, true)) return
                        // Steering only over the pinned wss whose hello carried the secret, and
                        // only when agentd says it granted it (R126): a rotated or stale secret
                        // is accepted as a monitor client, so the phone's own config is not proof.
                        val steering = pin != null && config.steer != null && action.steering == true
                        link.up(owner, secure = steering, stillLive = ::isLive) ?: return
                        deadlines.clear(DEADLINE_HELLO)
                        deadlines.arm(DEADLINE_SNAPSHOT, "Daemon snapshot timed out")
                        backoff.reset()
                        store.setConnection(
                            AgentProvider.CLAUDE,
                            ConnectionState.CONNECTED,
                            if (pin != null && !steering) REPAIR_TO_STEER else action.machineName,
                        )
                    }
                    is AgentdAction.LinkTrust -> {
                        // A trust that went is final for this connection; one never comes back mid-link.
                        if (!connected.get() || action.steering) return
                        link.up(owner, secure = false, stillLive = ::isLive) ?: return
                        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTED, REPAIR_TO_STEER)
                    }
                    is AgentdAction.Snapshot -> {
                        if (!connected.get()) return
                        deadlines.clear(DEADLINE_SNAPSHOT)
                        store.replaceLinkSessions(
                            AgentProvider.AGENTD_PROVIDERS,
                            action.sessions,
                        )
                        // A fresh connection knows nothing of the open conversation.
                        openSessionId?.let { write(AgentdProtocolCodec.detailOpen(it)) }
                    }
                    is AgentdAction.Upsert -> {
                        if (connected.get()) store.upsert(action.session)
                    }
                    is AgentdAction.Removed -> {
                        if (connected.get()) {
                            store.remove(action.provider, action.sessionId)
                        }
                    }
                    is AgentdAction.Detail -> {
                        if (connected.get()) {
                            store.setConversation(
                                action.provider,
                                action.sessionId,
                                action.messages,
                            )
                        }
                    }
                    is AgentdAction.DetailAppend -> {
                        if (connected.get()) {
                            store.appendConversation(
                                action.provider,
                                action.sessionId,
                                action.message,
                            )
                        }
                    }
                    is AgentdAction.ApprovalRequested -> {
                        if (connected.get()) store.upsertApproval(action.approval)
                    }
                    is AgentdAction.ApprovalResolved -> {
                        if (connected.get()) store.resolveApproval(action.requestId)
                    }
                    is AgentdAction.FolderListing -> {
                        if (connected.get()) store.setFsListing(action.listing)
                    }
                    is AgentdAction.ThreadStarted -> {
                        if (connected.get()) store.setThreadStart(action.result)
                    }
                    is AgentdAction.SessionInputAnswered -> {
                        if (connected.get()) store.setSessionInputResult(action.result)
                    }
                    is AgentdAction.Send -> {
                        // Nothing but the handshake is written before the link is bound.
                        if (!connected.get()) return
                        if (action.text == AgentdProtocolCodec.REFRESH) {
                            deadlines.arm(DEADLINE_SNAPSHOT, "Daemon refresh timed out")
                        }
                        if (write(action.text) != AgentdWire.Result.Sent) {
                            finish(ConnectionOutcome.Retry)
                        }
                    }
                    is AgentdAction.Alert,
                    is AgentdAction.AlertClosed,
                    is AgentdAction.Ack,
                    is AgentdAction.FollowupClosed,
                    is AgentdAction.ModeReset,
                    is AgentdAction.Models,
                    is AgentdAction.DetailRejected,
                    -> link.deliver(owner, action)
                    // Only the LAN link sees a daemon hello: here we are the client.
                    is AgentdAction.Hello,
                    AgentdAction.Ignore,
                    -> Unit
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.isCurrent(generation)) return
                if (code == BAD_TOKEN_CLOSE_CODE) {
                    finish(ConnectionOutcome.AuthFailed("Pairing invalid"))
                } else {
                    finish(ConnectionOutcome.Retry)
                }
                webSocket.close(code, "")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.isCurrent(generation)) return
                if (code == BAD_TOKEN_CLOSE_CODE) {
                    finish(ConnectionOutcome.AuthFailed("Pairing invalid"))
                } else {
                    finish(
                        if (connected.get()) ConnectionOutcome.Retry
                        else ConnectionOutcome.RetryWithDetail("Connection closed"),
                    )
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (sockets.isCurrent(generation)) {
                    finish(
                        when {
                            // Final until re-paired: another certificate is another computer, or someone in between.
                            pin != null && CertPins.isPinMismatch(t) -> ConnectionOutcome.AuthFailed(PairingCopy.CERT_CHANGED)
                            // Retried over wss again, and said so; never over ws://.
                            pin != null && CertPins.isTlsFailure(t) -> ConnectionOutcome.RetryWithDetail(SECURE_LINK_FAILED)
                            else -> ConnectionOutcome.Retry
                        },
                    )
                } else {
                    link.end(owner)
                }
            }
        }
        val candidate = http.newWebSocket(request, listener)
        if (!sockets.install(generation, candidate)) {
            candidate.cancel()
            finish(ConnectionOutcome.Retry)
        }
        try {
            ended.await()
        } finally {
            // Unbound before the slot is cleared, so no write outlives this connection's trust.
            link.end(owner)
            deadlines.clearAll()
        }
    }

    companion object {
        /** A pinned link agentd does not let steer: the pairing line's secret is stale (R126). */
        const val REPAIR_TO_STEER = "Re-pair to allow approvals"
        private const val BAD_TOKEN_CLOSE_CODE = 4401
        private const val SECURE_LINK_FAILED = "Secure link failed"
        private const val DEADLINE_HELLO = "hello"
        private const val DEADLINE_SNAPSHOT = "snapshot"
    }
}
