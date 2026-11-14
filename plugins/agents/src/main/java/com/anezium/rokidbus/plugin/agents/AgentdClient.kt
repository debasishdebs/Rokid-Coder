package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The paired path: the phone dials agentd's WebSocket, `wss://` through
 * [pinnedClient] only, presenting [identity] as its client certificate. A
 * pairing without the pin (`fp`) and the steering secret is never dialled:
 * agentd admits nothing less, and there is no plaintext link (U8). Every link
 * agentd accepts steers; anything short of that is a pairing to make again.
 */
class AgentdClient(
    httpClient: OkHttpClient,
    private val store: AgentSessionStore,
    private val scope: CoroutineScope,
    private val versionName: String,
    identity: PhoneTlsIdentity,
    private val pinnedClient: (pin: String) -> OkHttpClient = { pin -> pinnedOkHttpClient(httpClient, pin, identity) },
    /** Asked before every dial: false once the pairing went unused past the TTL, which signs it out (U7). */
    private val dialAllowed: () -> Boolean = { true },
    /** The pairing was just used: a secure hello_ack, or a link still up. */
    private val touchUsed: () -> Unit = {},
    /**
     * True while a guided attempt's window is open: a pairing refused (AUTH_FAILED) is then dialled
     * again every [REPAIR_REDIAL_MS], so agentd's own allow-next window can pin this phone on it.
     * Outside an attempt, AUTH_FAILED stays final.
     */
    private val repairRedial: () -> Boolean = { false },
    /** A secure hello_ack bound the link: the pairing's stable id ([GuidedPairing.dialledId]) and the name shown. */
    private val onSecureConnected: (machineId: String, machineName: String) -> Unit = { _, _ -> },
    onEvent: (AgentdEvent) -> Unit = AgentsRuntime::emitEvent,
) {
    private var loopJob: Job? = null
    private val sockets = GenerationSlot<WebSocket>()

    /** OkHttp only enqueues, so this never blocks the caller's thread. */
    private val wire = AgentdWire { line -> sockets.current()?.send(line) ?: false }
    private val link = AgentdLinkBinding(wire, onEvent)

    /** Whether this transport may carry steering frames right now. */
    val linkSecure: StateFlow<Boolean> get() = wire.secure

    private val _needsRepair = MutableStateFlow(false)

    /**
     * True once this pairing stopped at AUTH_FAILED: refused, distrusted or
     * never dialled. Only a new pairing line connects again; [start] clears it.
     */
    val needsRepair: StateFlow<Boolean> = _needsRepair.asStateFlow()

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

    /** An hourly tick while the link is bound secure: a computer that stays connected never expires. */
    fun touchLive() {
        if (wire.secure.value) touchUsed()
    }

    /**
     * A guided attempt began while this pairing sat refused: dial it again now, and keep saying it
     * needs repair until a hello_ack is accepted. A pairing that is not refused, or is already being
     * redialled, is left alone.
     */
    @Synchronized
    fun retryRefused(config: AgentdConfig) {
        if (!_needsRepair.value || loopJob?.isActive == true) return
        begin(config, keepRepair = true)
    }

    @Synchronized
    fun start(config: AgentdConfig) = begin(config, keepRepair = false)

    private fun begin(config: AgentdConfig, keepRepair: Boolean) {
        loopJob?.cancel()
        val advance = sockets.advance()
        if (!keepRepair) _needsRepair.value = false
        // After the advance, so a hello_ack still in flight cannot bind behind us.
        link.downCurrent()
        advance.previous?.cancel()
        val job = scope.launch(start = CoroutineStart.LAZY) {
            runConnectionLoop(config, advance.generation, redialing = keepRepair)
        }
        loopJob = job
        job.start()
    }

    @Synchronized
    fun stop(clearSessions: Boolean) {
        loopJob?.cancel()
        loopJob = null
        val advance = sockets.advance()
        _needsRepair.value = false
        link.downCurrent()
        advance.previous?.cancel()
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.DISCONNECTED)
        store.clearApprovals(AgentProvider.AGENTD_PROVIDERS)
        if (clearSessions) {
            store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList())
        }
    }

    private suspend fun runConnectionLoop(config: AgentdConfig, generation: Long, redialing: Boolean = false) {
        val pin = when (val parsed = CertPins.parse(config.fp)) {
            is PinParse.Valid -> parsed.fp
            // A stored pin that no longer reads is still a pin: refused, never dialled.
            PinParse.Malformed -> return authFailed(generation, PairingCopy.BAD_FINGERPRINT)
            PinParse.Absent -> return authFailed(generation, PairingCopy.OLDER_AGENTD)
        }
        val steer = config.steer ?: return authFailed(generation, PairingCopy.OLDER_AGENTD)
        val http = pinnedClient(pin)
        val backoff = ReconnectBackoff()
        var redialing = redialing
        while (scope.isActive && sockets.isCurrent(generation)) {
            // Every dial, redials included: a pairing that went stale since the last one is not dialled.
            if (!dialAllowed()) return authFailed(generation, PairingCopy.SIGNED_OUT)
            // A refused pairing being tried again keeps saying so, rather than flickering to Connecting.
            if (!redialing) store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING)
            redialing = false
            val result = try {
                connectOnce(config, steer, http, generation, backoff)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                ConnectionOutcome.Retry
            } finally {
                sockets.clear(generation)?.cancel()
            }
            if (!sockets.isCurrent(generation)) return
            when (result) {
                // Final: no backoff, no redial, until a new pairing restarts the client.
                is ConnectionOutcome.AuthFailed -> {
                    authFailed(generation, result.detail)
                    // Final, except inside a guided attempt: agentd's pair window pins this phone on a redial.
                    if (!repairRedial()) return
                    delay(REPAIR_REDIAL_MS)
                    if (!repairRedial() || !sockets.isCurrent(generation)) return
                    redialing = true
                    continue
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

    private fun authFailed(generation: Long, detail: String) {
        if (!sockets.isCurrent(generation)) return
        _needsRepair.value = true
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.AUTH_FAILED, detail)
    }

    private suspend fun connectOnce(
        config: AgentdConfig,
        steer: String,
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
            .url(webSocketUrl(config.host, config.port, secure = true))
            .build()
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isLive()) {
                    webSocket.cancel()
                    return
                }
                // The handshake precedes the binding, so it is written to this
                // socket directly; every later line goes through the wire. OkHttp
                // opens only after the pinned trust manager and hostname check
                // passed on the TLS session itself, so neither the token nor the
                // secret leaves before the pin is verified.
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
                        // agentd grants steering on every hello it accepts (R169). An ack
                        // without the grant is an agentd from before Plan 4, which would take
                        // this phone as a monitor client: no such link exists any more.
                        if (action.steering != true) {
                            finish(ConnectionOutcome.AuthFailed(REPAIR_TO_STEER))
                            return
                        }
                        if (!connected.compareAndSet(false, true)) return
                        link.up(owner, secure = true, stillLive = ::isLive) ?: return
                        touchUsed()
                        _needsRepair.value = false
                        onSecureConnected(
                            GuidedPairing.dialledId(config.fp.orEmpty()),
                            action.machineName?.takeIf(String::isNotBlank) ?: config.name,
                        )
                        deadlines.clear(DEADLINE_HELLO)
                        deadlines.arm(DEADLINE_SNAPSHOT, "Daemon snapshot timed out")
                        backoff.reset()
                        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTED, action.machineName)
                    }
                    // The token, the secret or this phone's certificate is not agentd's any more.
                    is AgentdAction.HelloRejected -> finish(ConnectionOutcome.AuthFailed(REPAIR_TO_STEER))
                    is AgentdAction.LinkTrust -> {
                        // A trust that went ends the link now, before agentd's 4403 arrives.
                        if (!connected.get() || action.steering) return
                        finish(ConnectionOutcome.AuthFailed(REPAIR_TO_STEER))
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
                finish(refusal(code) ?: ConnectionOutcome.Retry)
                webSocket.close(code, "")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!sockets.isCurrent(generation)) return
                finish(
                    refusal(code) ?: if (connected.get()) ConnectionOutcome.Retry
                    else ConnectionOutcome.RetryWithDetail("Connection closed"),
                )
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (sockets.isCurrent(generation)) {
                    finish(
                        when {
                            // Final until re-paired: another certificate is another computer, or someone in between.
                            CertPins.isPinMismatch(t) -> ConnectionOutcome.AuthFailed(PairingCopy.CERT_CHANGED)
                            // Retried over wss again, and said so.
                            CertPins.isTlsFailure(t) -> ConnectionOutcome.RetryWithDetail(SECURE_LINK_FAILED)
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
        /** agentd refused or dropped this phone's pairing: its pin, token or secret is no longer trusted. */
        const val REPAIR_TO_STEER = PairingCopy.REPAIR_TO_STEER

        /** The pause between redials of a refused pairing while a guided attempt's window is open. */
        const val REPAIR_REDIAL_MS = 5_000L
        private const val BAD_TOKEN_CLOSE_CODE = 4401

        /** agentd's close after a `hello_reject`, and after a live link loses its trust. */
        private const val UNTRUSTED_CLOSE_CODE = 4403

        private fun refusal(code: Int): ConnectionOutcome.AuthFailed? = when (code) {
            BAD_TOKEN_CLOSE_CODE -> ConnectionOutcome.AuthFailed("Pairing invalid")
            UNTRUSTED_CLOSE_CODE -> ConnectionOutcome.AuthFailed(REPAIR_TO_STEER)
            else -> null
        }
        private const val SECURE_LINK_FAILED = "Secure link failed"
        private const val DEADLINE_HELLO = "hello"
        private const val DEADLINE_SNAPSHOT = "snapshot"
    }
}
