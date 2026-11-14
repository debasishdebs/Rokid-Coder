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
import java.util.concurrent.atomic.AtomicReference

class AgentdClient(
    private val httpClient: OkHttpClient,
    private val store: AgentSessionStore,
    private val scope: CoroutineScope,
    private val versionName: String,
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
        val backoff = ReconnectBackoff()
        while (scope.isActive && sockets.isCurrent(generation)) {
            store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING)
            val result = try {
                connectOnce(config, generation, backoff)
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
        generation: Long,
        backoff: ReconnectBackoff,
    ): ConnectionOutcome = coroutineScope {
        val codec = AgentdProtocolCodec().also(AgentdProtocolCodec::reset)
        val ended = CompletableDeferred<ConnectionOutcome>()
        val connected = AtomicBoolean(false)
        val linkGeneration = AtomicReference<Long?>(null)
        lateinit var deadlines: ConnectionDeadlines

        fun isLive(): Boolean = sockets.isCurrent(generation) && !ended.isCompleted

        deadlines = ConnectionDeadlines(this) { detail ->
            if (sockets.isCurrent(generation)) {
                ended.complete(ConnectionOutcome.RetryWithDetail(detail))
            }
        }
        val request = Request.Builder()
            .url(webSocketUrl(config.host, config.port))
            .build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isLive()) {
                    webSocket.cancel()
                    return
                }
                // The handshake precedes the binding, so it is written to this
                // socket directly; every later line goes through the wire.
                if (!webSocket.send(codec.hello(config.token, versionName))) {
                    ended.complete(ConnectionOutcome.Retry)
                    return
                }
                deadlines.arm(DEADLINE_HELLO, "Daemon hello timed out")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isLive()) return
                when (val action = codec.parse(text)) {
                    is AgentdAction.HelloAcknowledged -> {
                        if (!connected.compareAndSet(false, true)) return
                        // Plaintext WebSocket: monitor-only until the link is TLS with a verified pin.
                        linkGeneration.set(link.up(secure = false, stillLive = ::isLive) ?: return)
                        deadlines.clear(DEADLINE_HELLO)
                        deadlines.arm(DEADLINE_SNAPSHOT, "Daemon snapshot timed out")
                        backoff.reset()
                        store.setConnection(
                            AgentProvider.CLAUDE,
                            ConnectionState.CONNECTED,
                            action.machineName,
                        )
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
                            ended.complete(ConnectionOutcome.Retry)
                        }
                    }
                    is AgentdAction.Alert,
                    is AgentdAction.AlertClosed,
                    is AgentdAction.Ack,
                    is AgentdAction.FollowupClosed,
                    is AgentdAction.ModeReset,
                    is AgentdAction.Models,
                    is AgentdAction.DetailRejected,
                    -> link.deliver(linkGeneration.get(), action)
                    // Only the LAN link sees a daemon hello: here we are the client.
                    is AgentdAction.Hello,
                    AgentdAction.Ignore,
                    -> Unit
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.isCurrent(generation)) return
                if (code == BAD_TOKEN_CLOSE_CODE) {
                    ended.complete(ConnectionOutcome.AuthFailed("Pairing invalid"))
                } else {
                    ended.complete(ConnectionOutcome.Retry)
                }
                webSocket.close(code, "")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.isCurrent(generation)) return
                if (code == BAD_TOKEN_CLOSE_CODE) {
                    ended.complete(ConnectionOutcome.AuthFailed("Pairing invalid"))
                } else {
                    ended.complete(
                        if (connected.get()) ConnectionOutcome.Retry
                        else ConnectionOutcome.RetryWithDetail("Connection closed"),
                    )
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (sockets.isCurrent(generation)) {
                    ended.complete(ConnectionOutcome.Retry)
                }
            }
        }
        val candidate = httpClient.newWebSocket(request, listener)
        if (!sockets.install(generation, candidate)) {
            candidate.cancel()
            ended.complete(ConnectionOutcome.Retry)
        }
        try {
            ended.await()
        } finally {
            // Unbound before the slot is cleared, so no write outlives this connection's trust.
            linkGeneration.get()?.let(link::down)
            deadlines.clearAll()
        }
    }

    private companion object {
        const val BAD_TOKEN_CLOSE_CODE = 4401
        const val DEADLINE_HELLO = "hello"
        const val DEADLINE_SNAPSHOT = "snapshot"
    }
}
