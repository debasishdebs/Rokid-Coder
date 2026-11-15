package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.BufferedReader
import java.io.BufferedWriter
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.io.Reader
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import javax.net.ssl.SSLSocket

/**
 * Inbound link from the PC daemons.
 *
 * The phone listens and the computer dials, which is the only direction that
 * needs no setup: Android lets an app accept connections, Windows would demand
 * an administrator firewall rule for the reverse. Discovery follows the same
 * asymmetry — the daemon broadcasts, we answer by unicast, and Windows lets that
 * reply back in because it answers a broadcast the PC itself just sent.
 *
 * Every accepted connection is mutual TLS with [tlsIdentity] (R114). agentd
 * holds the phone to the certificate it pinned (R45) before it writes its
 * hello; the phone holds agentd to the client certificate it pinned for that
 * machine when it first trusted it. A token that arrives with any other
 * certificate is refused before hello_ack, so a replayed token never steers.
 * Every link bound here steers: one that would not is refused, and one whose
 * trust agentd revokes is closed (U8, no monitor-only link).
 */
class AgentdLinkServer internal constructor(
    private val store: AgentSessionStore,
    /** The hello, and the fingerprint of the client certificate it came with. */
    private val authorizeMachine: (AgentdAction.Hello, String?) -> MachineTrustResult,
    private val clientCertPinned: (machineId: String, fingerprint: String) -> Boolean,
    private val touchMachineSeen: (String) -> Unit,
    private val scope: CoroutineScope,
    private val onMachineTrusted: (String) -> Unit,
    private val tlsIdentity: PhoneTlsIdentity,
    /** A secure bind just happened: this connection's key, the computer's id and name, and its address. */
    private val onSecureConnected: (key: LinkKey, machineId: String, machineName: String, remoteAddress: String?) -> Unit =
        { _, _, _, _ -> },
    /** That bound connection ended, however it ended. */
    private val onSecureLinkClosed: (LinkKey) -> Unit = {},
    /** A link that was bound has ended: the service decides whether this listener still has a job. */
    private val onLinkEnded: () -> Unit = {},
    onEvent: (AgentdEvent) -> Unit,
    /**
     * Pairing on this link (Plan 6a T6): while the door is open, a computer that dials in and
     * opens with `sas_commit` gets a SAS session instead of a hello, and a computer that pinned
     * this phone only provisionally may ask for the commit proof before its hello.
     */
    private val door: SasDoor? = null,
) {
    constructor(
        store: AgentSessionStore,
        configStore: AgentsConfigStore,
        scope: CoroutineScope,
        tlsIdentity: PhoneTlsIdentity,
        onSecureConnected: (key: LinkKey, machineId: String, machineName: String, remoteAddress: String?) -> Unit =
            { _, _, _, _ -> },
        onSecureLinkClosed: (LinkKey) -> Unit = {},
        onLinkEnded: () -> Unit = {},
        onMachineTrusted: (String) -> Unit = {},
        door: SasDoor? = null,
    ) : this(
        store = store,
        authorizeMachine = { hello, clientCert ->
            configStore.authorizeMachine(
                machineId = hello.machineId,
                token = hello.token,
                machineName = hello.machineName,
                clientCert = clientCert,
            )
        },
        clientCertPinned = configStore::isClientCertPinned,
        touchMachineSeen = { machineId -> configStore.touchMachineSeen(machineId) },
        scope = scope,
        onMachineTrusted = onMachineTrusted,
        tlsIdentity = tlsIdentity,
        onSecureConnected = onSecureConnected,
        onSecureLinkClosed = onSecureLinkClosed,
        onLinkEnded = onLinkEnded,
        onEvent = AgentsRuntime::emitEvent,
        door = door,
    )

    private var acceptJob: Job? = null
    private var discoveryJob: Job? = null
    private var serverSocket: ServerSocket? = null
    private var discoverySocket: DatagramSocket? = null
    private val clientLock = Any()
    private val connectionIds = java.util.concurrent.atomic.AtomicLong()

    @Volatile private var client: LinkConnection? = null

    /**
     * Every connection still being served, the client included, so [stop] can end
     * the ones mid-hello too: one that finished its hello after a stop would bind a
     * second wire (R35). Both are guarded by [clientLock].
     */
    private val connections = HashSet<LinkConnection>()
    private var stopped = false

    /**
     * Callers are UI/service threads; Android forbids socket writes there, so the
     * line joins the connection's single writer. The wire holds its lock across
     * this call, and the client is only swapped after the old connection's link
     * ends, so a line always reaches the connection the wire was bound to.
     */
    private val wire = AgentdWire { line -> client?.enqueue(line) ?: false }
    private val link = AgentdLinkBinding(wire, onEvent)

    /** Whether this transport may carry steering frames right now. */
    val linkSecure: StateFlow<Boolean> get() = wire.secure

    /**
     * True while a dialled link (the outbound slot) is the one the store describes: this listener
     * is then only a door held open for a guided attempt, and must not repaint that link's state.
     */
    @Volatile internal var besideDialled = false

    /** [besideDialled] says an outbound slot is dialled alongside, so the store's state is left to it. */
    fun start(besideDialled: Boolean = false) {
        this.besideDialled = besideDialled
        if (acceptJob != null) return
        synchronized(clientLock) { stopped = false }
        if (!besideDialled) {
            store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING, "waiting for a computer")
        }
        acceptJob = scope.launch(Dispatchers.IO) { acceptLoop() }
        discoveryJob = scope.launch(Dispatchers.IO) { discoveryLoop() }
    }

    fun stop(clearSessions: Boolean, besideDialled: Boolean = false) {
        acceptJob?.cancel()
        acceptJob = null
        discoveryJob?.cancel()
        discoveryJob = null
        runCatching { serverSocket?.close() }
        serverSocket = null
        runCatching { discoverySocket?.close() }
        discoverySocket = null
        var hadLink = false
        val open = synchronized(clientLock) {
            stopped = true
            hadLink = client != null
            client?.let { link.end(it.linkOwner) }
            client = null
            connections.toList().also { connections.clear() }
        }
        open.forEach(LinkConnection::close)
        this.besideDialled = false
        store.setLinkMachine(null)
        // Beside a dialled link the door shuts and nothing else: its connection, approvals and sessions are the
        // slot's. A stop that ended a live inbound link did more than shut a door, and cleans up after it.
        if (besideDialled && !hadLink) return
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.DISCONNECTED)
        store.clearApprovals(AgentProvider.AGENTD_PROVIDERS)
        if (clearSessions) store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
    }

    fun openDetail(sessionId: String): AgentdWire.Result =
        write(AgentdProtocolCodec.detailOpen(sessionId))

    fun closeDetail(): AgentdWire.Result = write(AgentdProtocolCodec.DETAIL_CLOSE)

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

    private suspend fun acceptLoop() {
        while (scope.isActive) {
            try {
                val server = tlsServerSocket(tlsIdentity, LINK_PORT)
                serverSocket = server
                while (scope.isActive) {
                    val socket = server.accept()
                    // A candidate cannot displace the live client until hello succeeds.
                    val connection = LinkConnection(socket)
                    scope.launch(Dispatchers.IO) { serve(connection) }
                }
            } catch (_: SocketException) {
                // Socket closed on stop, or the port was momentarily taken.
            } catch (_: Throwable) {
                // Keep listening: a failed accept must never end the loop.
            }
            runCatching { serverSocket?.close() }
            serverSocket = null
            if (!scope.isActive) return
            kotlinx.coroutines.delay(RETRY_DELAY_MS)
        }
    }

    internal fun serve(connection: LinkConnection) {
        val admitted = synchronized(clientLock) { !stopped && connections.add(connection) }
        if (!admitted) {
            connection.close()
            return
        }
        val codec = AgentdProtocolCodec()
        val gate = AgentdInboundGate { hello -> authorizeMachine(hello, connection.clientCert) }
        codec.reset()
        var bound = false
        var first = true
        var sas: SasResponder? = null
        val key = LinkKey(LinkTransport.INBOUND, connectionIds.incrementAndGet())
        try {
            // Before the writer and the first line: nothing is read or written until TLS is up.
            connection.handshake()
            connection.startWriter(scope)
            connection.lines { line ->
                // A pairing session takes every line, and nothing else happens on it.
                sas?.let {
                    it.receive(line)
                    return@lines true
                }
                if (first) {
                    first = false
                    when (pairingOpening(line)) {
                        "sas_commit" -> {
                            sas = pairingSession(connection) ?: return@lines false
                            sas!!.receive(line)
                            return@lines true
                        }
                        "pair_commit_query" -> {
                            // Answered, and then the normal hello follows on this same session.
                            return@lines answerCommitQuery(connection, line)
                        }
                    }
                }
                when (val decision = gate.receive(codec.parse(line))) {
                    is AgentdInboundDecision.HelloAccepted -> {
                        connection.machineId = decision.hello.machineId
                        // Before activate, so a hello that cannot steer never displaces a working link.
                        if (!steers(connection)) {
                            connection.send(AgentdProtocolCodec.helloReject(AgentdProtocolCodec.REJECT_BAD_TOKEN))
                            return@lines false
                        }
                        if (!activate(connection)) return@lines false
                        if (decision.newlyTrusted) {
                            onMachineTrusted(decision.hello.machineName)
                        }
                        // The handshake precedes the binding, so it is written to this
                        // candidate directly; every later line goes through the wire.
                        if (!connection.send(HELLO_ACK)) return@lines false
                        if (!bind(connection)) return@lines false
                        bound = true
                        touchMachineSeen(decision.hello.machineId)
                        onSecureConnected(key, decision.hello.machineId, decision.hello.machineName, connection.remoteAddress)
                        announce(connection, decision.hello)
                    }
                    is AgentdInboundDecision.AuthRejected -> {
                        connection.send(AgentdProtocolCodec.helloReject(decision.reason))
                        // Anyone on the network can knock on this door, so a
                        // stranger being turned away must not repaint the state
                        // of a link that is working.
                        if (client == null && !besideDialled) {
                            store.setConnection(
                                AgentProvider.CLAUDE,
                                ConnectionState.AUTH_FAILED,
                                if (decision.certChanged) PairingCopy.CERT_CHANGED else "Machine authentication failed",
                            )
                        }
                        false
                    }
                    AgentdInboundDecision.ProtocolRejected -> false
                    is AgentdInboundDecision.Frame -> {
                        if (!isActive(connection)) return@lines false
                        handleAuthenticatedFrame(connection, decision.action)
                        true
                    }
                }
            }
        } catch (_: Throwable) {
            // Fall through: the connection is finished either way.
        } finally {
            sas?.disconnected()
            // The link ends before the socket closes, so no write is reported Sent onto it.
            val wasActive = synchronized(clientLock) {
                connections.remove(connection)
                link.end(connection.linkOwner)
                if (client !== connection) {
                    false
                } else {
                    client = null
                    true
                }
            }
            connection.close()
            if (bound) onSecureLinkClosed(key)
            if (wasActive) {
                // A connection refused at bind was never this machine's use of the link.
                if (bound) connection.machineId?.let(touchMachineSeen)
                store.setLinkMachine(null)
                // Beside a dialled slot, the slot's state is not "waiting for a computer".
                if (!besideDialled) {
                    store.setConnection(
                        AgentProvider.CLAUDE,
                        ConnectionState.CONNECTING,
                        "waiting for a computer",
                    )
                }
                store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
                store.clearApprovals(AgentProvider.AGENTD_PROVIDERS)
                if (bound) onLinkEnded()
            }
        }
    }

    /** The type of a connection's first line when it is a pairing frame, so the hello gate never sees it. */
    private fun pairingOpening(line: String): String? {
        if (door == null) return null
        val type = runCatching { JSONObject(line).optString("type") }.getOrNull()
        return type?.takeIf { it == "sas_commit" || it == "pair_commit_query" }
    }

    /**
     * Before any pin, a computer's cert is accepted for SAS frames only, and only while the door
     * is open. Null (the connection then closes) when it is shut.
     */
    private fun pairingSession(connection: LinkConnection): SasResponder? {
        val door = door ?: return null
        val agentdFp = connection.clientCert ?: return null
        if (!door.open()) return null
        return SasResponder(
            attempts = door.attempts,
            agentdFp = agentdFp,
            phoneFp = door.phoneFingerprint(),
            peerName = connection.remoteAddress ?: "computer",
            // The phone's confirm comes from the UI thread: every line goes through the writer.
            send = { line -> connection.enqueue(line) },
            store = door.commit,
            // Closed a moment later, so the last pairing frame is written before the socket goes.
            close = {
                scope.launch(Dispatchers.IO) {
                    kotlinx.coroutines.delay(SESSION_CLOSE_DRAIN_MS)
                    connection.close()
                }
            },
            onPaired = door.onPaired,
        )
    }

    /**
     * 6a-R4″: agentd pinned this phone only provisionally and asks, on the mutually pinned session,
     * whether the credentials were stored. The answer proves it with the steering secret from that
     * very attempt. A cert or attempt this phone holds no record of gets no answer: the link closes.
     */
    private fun answerCommitQuery(connection: LinkConnection, line: String): Boolean {
        val door = door ?: return false
        val agentdFp = connection.clientCert ?: return false
        val attempt = runCatching { JSONObject(line).optString("attempt") }.getOrNull() ?: return false
        val record = door.recordForCert(agentdFp)?.takeIf { it.attempt == attempt } ?: return false
        val proof = SasPairing.proof(record.steer, attempt, agentdFp, door.phoneFingerprint())
        return connection.send(
            JSONObject().put("type", "pair_committed").put("v", 2).put("attempt", attempt).put("proof", proof).toString(),
        )
    }

    /** The previous connection's trust ends before this one becomes the client. False once stopped. */
    private fun activate(connection: LinkConnection): Boolean {
        val previous = synchronized(clientLock) {
            if (stopped) return false
            client?.let { link.end(it.linkOwner) }
            client.also { client = connection }
        }
        if (previous !== connection) previous?.close()
        return true
    }

    /**
     * Both ends pinned: agentd found this phone's cert in its set before its
     * hello, and the cert agentd presented is the one pinned for its machine.
     */
    private fun steers(connection: LinkConnection): Boolean {
        val clientCert = connection.clientCert
        val machineId = connection.machineId
        return connection.tls && clientCert != null && machineId != null && clientCertPinned(machineId, clientCert)
    }

    /**
     * After hello_ack: binds the wire to this connection as secure and announces
     * the link, before the next line is read. False when the connection was
     * replaced while the acknowledgement was going out, or when it can no longer
     * steer (its pin went meanwhile): such a link is never bound.
     */
    private fun bind(connection: LinkConnection): Boolean = synchronized(clientLock) {
        if (client !== connection || !steers(connection)) return@synchronized false
        link.up(connection.linkOwner, secure = true) != null
    }

    /**
     * Publishes the bound link while [connection] is still the client, checked and written under
     * [clientLock]: a [stop] that ended it after [bind] has cleared the client first and publishes
     * its own state after, so that state is never repainted CONNECTED.
     */
    private fun announce(connection: LinkConnection, hello: AgentdAction.Hello): Boolean = synchronized(clientLock) {
        if (client !== connection) return@synchronized false
        store.setLinkMachine(
            LinkMachine(
                machineId = hello.machineId,
                machineName = hello.machineName,
                overTailnet = isTailnetAddress(connection.remoteAddress),
            ),
        )
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTED, hello.machineName)
        true
    }

    private fun isActive(connection: LinkConnection): Boolean =
        synchronized(clientLock) { client === connection }

    /**
     * An hourly tick: the machine bound to a secure link now is in use, so a computer that stays
     * connected for longer than the pairing TTL never signs out.
     */
    fun touchLive() {
        if (!wire.secure.value) return
        client?.machineId?.let(touchMachineSeen)
    }

    /** The wearer forgot this machine: a live link from it does not survive that. */
    fun dropMachine(machineId: String) {
        val current = synchronized(clientLock) { client }
        if (current?.machineId == machineId) current.close()
    }

    private fun handleAuthenticatedFrame(
        connection: LinkConnection,
        action: AgentdAction,
    ) {
        when (action) {
            is AgentdAction.Snapshot ->
                store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, action.sessions, connection.machineId)
            is AgentdAction.Upsert -> store.upsert(action.session, connection.machineId)
            is AgentdAction.Removed -> store.remove(action.provider, action.sessionId, connection.machineId)
            is AgentdAction.Detail ->
                store.setConversation(action.provider, action.sessionId, action.messages)
            is AgentdAction.DetailAppend ->
                store.appendConversation(action.provider, action.sessionId, action.message)
            is AgentdAction.ApprovalRequested -> store.upsertApproval(action.approval)
            is AgentdAction.ApprovalResolved -> store.resolveApproval(action.requestId)
            is AgentdAction.FolderListing -> store.setFsListing(action.listing)
            is AgentdAction.ThreadStarted -> store.setThreadStart(action.result)
            is AgentdAction.SessionInputAnswered -> store.setSessionInputResult(action.result)
            is AgentdAction.Send -> wire.write(action.text)
            is AgentdAction.Alert,
            is AgentdAction.AlertClosed,
            is AgentdAction.Ack,
            is AgentdAction.FollowupClosed,
            is AgentdAction.ModeReset,
            is AgentdAction.Models,
            is AgentdAction.DetailRejected,
            -> link.deliver(connection.linkOwner, action)
            is AgentdAction.LinkTrust -> if (!action.steering) dropUntrusted(connection)
            is AgentdAction.Hello,
            is AgentdAction.HelloAcknowledged,
            is AgentdAction.HelloRejected,
            AgentdAction.Ignore,
            -> Unit
        }
    }

    /**
     * agentd no longer trusts this phone (R126): the link ends now, before agentd
     * drops it, rather than staying bound without steering. [serve]'s cleanup
     * reports the link gone.
     */
    private fun dropUntrusted(connection: LinkConnection) {
        synchronized(clientLock) {
            if (client !== connection) return
            link.end(connection.linkOwner)
        }
        connection.close()
    }

    private suspend fun discoveryLoop() {
        while (scope.isActive) {
            try {
                val socket = DatagramSocket(null).apply {
                    reuseAddress = true
                    broadcast = true
                    bind(java.net.InetSocketAddress(DISCOVERY_PORT))
                }
                discoverySocket = socket
                val buffer = ByteArray(2048)
                while (scope.isActive) {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    if (isDaemonBeacon(packet)) {
                        replyTo(socket, packet.address, packet.port)
                    } else {
                        // agentd's window, waiting for a phone on its pairing screen to dial its wss.
                        PairReady.parse(String(packet.data, packet.offset, packet.length, Charsets.UTF_8))
                            ?.takeIf { ready -> door?.let { admitPairReady(it, ready) } == true }
                            ?.let { door?.onPairReady?.invoke(it) }
                    }
                }
            } catch (_: SocketException) {
                // Closed on stop.
            } catch (_: Throwable) {
                // Ignore and rebind.
            }
            runCatching { discoverySocket?.close() }
            discoverySocket = null
            if (!scope.isActive) return
            kotlinx.coroutines.delay(RETRY_DELAY_MS)
        }
    }

    /**
     * Into a window the wearer opened, or one the pairing screen on view opens for it (onboarding,
     * §13.5): nothing else lets an announcement open one. The pairing-screen, once-per-attempt and
     * spacing rules of [PairingAttemptsModel.acceptPairReady] hold either way.
     */
    private fun admitPairReady(door: SasDoor, ready: PairReady): Boolean {
        val opener = if (door.open()) null else door.pairReadyOpener() ?: return false
        if (!door.attempts.acceptPairReady(ready)) return false
        return opener?.invoke() ?: true
    }

    private fun isDaemonBeacon(packet: DatagramPacket): Boolean {
        val text = String(packet.data, packet.offset, packet.length, Charsets.UTF_8)
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return false
        return json.nullableString("nexus", MAX_WIRE_TYPE_CHARS) == "agentd" &&
            json.intOrNull("v") == 1
    }

    private fun replyTo(socket: DatagramSocket, address: InetAddress, port: Int) {
        val payload = discoveryReply(android.os.Build.MODEL ?: "phone", pairing = door?.open() == true)
            .toByteArray(Charsets.UTF_8)
        runCatching { socket.send(DatagramPacket(payload, payload.size, address, port)) }
    }

    companion object {
        const val LINK_PORT = 8792
        const val DISCOVERY_PORT = 8793
        private const val RETRY_DELAY_MS = 2000L
        private const val SESSION_CLOSE_DRAIN_MS = 300L

        /**
         * `tls: true` tells agentd to dial TLS; once it has pinned a phone it dials nothing else.
         * `pairing: true` says the door is open, so agentd inside its own window may pair by SAS.
         */
        internal fun discoveryReply(name: String, pairing: Boolean = false): String = JSONObject()
            .put("nexus", "agents-phone")
            .put("v", 1)
            .put("port", LINK_PORT)
            .put("name", name)
            .put("tls", true)
            .apply { if (pairing) put("pairing", true) }
            .toString()

        private val HELLO_ACK = JSONObject()
            .put("type", "hello_ack")
            .put("v", 1)
            .toString()
    }
}

internal sealed interface AgentdInboundDecision {
    data class HelloAccepted(
        val hello: AgentdAction.Hello,
        val newlyTrusted: Boolean,
    ) : AgentdInboundDecision

    data class Frame(val action: AgentdAction) : AgentdInboundDecision
    data class AuthRejected(val reason: String, val certChanged: Boolean = false) : AgentdInboundDecision
    data object ProtocolRejected : AgentdInboundDecision
}

internal class AgentdInboundGate(
    private val authorize: (AgentdAction.Hello) -> MachineTrustResult,
) {
    private var authenticated = false

    fun receive(action: AgentdAction): AgentdInboundDecision {
        if (!authenticated) {
            if (action !is AgentdAction.Hello) return AgentdInboundDecision.ProtocolRejected
            return when (val result = authorize(action)) {
                MachineTrustResult.TRUSTED,
                MachineTrustResult.NEWLY_TRUSTED,
                -> {
                    authenticated = true
                    AgentdInboundDecision.HelloAccepted(
                        hello = action,
                        newlyTrusted = result == MachineTrustResult.NEWLY_TRUSTED,
                    )
                }
                MachineTrustResult.REJECTED_BAD_TOKEN,
                MachineTrustResult.REJECTED_NOT_INVITED,
                MachineTrustResult.REJECTED_CERT_CHANGED,
                -> AgentdInboundDecision.AuthRejected(
                    result.rejectionReason ?: AgentdProtocolCodec.REJECT_UNKNOWN_MACHINE,
                    certChanged = result == MachineTrustResult.REJECTED_CERT_CHANGED,
                )
            }
        }
        return if (action is AgentdAction.Hello) {
            AgentdInboundDecision.ProtocolRejected
        } else {
            AgentdInboundDecision.Frame(action)
        }
    }
}

internal fun isTailnetAddress(address: String?): Boolean {
    val parts = address?.split(".") ?: return false
    if (parts.size != 4) return false
    val octets = parts.map { it.toIntOrNull() ?: return false }
    return octets[0] == 100 && octets[1] in 64..127
}

internal class LinkConnection(private val socket: Socket) {
    /** Set once hello is accepted; identifies who holds this connection. */
    @Volatile var machineId: String? = null

    /** This connection's claim on the link binding. */
    val linkOwner = LinkOwner()

    /** True once a TLS handshake has completed on this connection. */
    @Volatile var tls = false
        private set

    /** The fingerprint of the client certificate agentd presented; set with [tls]. */
    @Volatile var clientCert: String? = null
        private set

    /** Every line after the handshake, written in order by one coroutine. */
    private val outbound = Channel<String>(Channel.UNLIMITED)

    val remoteAddress: String? get() = socket.inetAddress?.hostAddress

    // Taken on first use, after [handshake]: Conscrypt's (Android's) TLS socket blocks in getOutputStream
    // and getInputStream until the handshake completes, which here would be on the accept loop and with
    // no deadline yet.
    private val writer: BufferedWriter by lazy {
        BufferedWriter(OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8))
    }
    private val reader: BufferedReader by lazy {
        BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
    }

    init {
        socket.tcpNoDelay = true
        socket.keepAlive = true
        // agentd pings every 30 seconds; 90 seconds tolerates two missed intervals.
        socket.soTimeout = LINK_IDLE_TIMEOUT_MS
    }

    /**
     * Completes the TLS handshake under its own short deadline, so a peer that
     * opens TCP and never speaks TLS is let go quickly. A plain socket is left
     * as it is, and stays [tls] false.
     */
    fun handshake() {
        if (socket !is SSLSocket) return
        socket.soTimeout = TLS_HANDSHAKE_TIMEOUT_MS
        socket.startHandshake()
        socket.soTimeout = LINK_IDLE_TIMEOUT_MS
        // needClientAuth: a handshake that completed has a client certificate.
        clientCert = CertPins.fingerprint256(socket.session.peerCertificates.first().encoded)
        tls = true
    }

    fun lines(onLine: (String) -> Boolean) {
        while (true) {
            val line = reader.readBoundedLine(MAX_LINK_LINE_CHARS) ?: return
            if (line.isNotBlank() && !onLine(line)) return
        }
    }

    @Synchronized
    fun send(payload: String): Boolean = runCatching {
        writer.write(payload)
        writer.write("\n")
        writer.flush()
        true
    }.getOrElse { false }

    /** Queues [line] for the writer; false once the connection is closed. */
    fun enqueue(line: String): Boolean = outbound.trySend(line).isSuccess

    fun startWriter(scope: CoroutineScope) {
        scope.launch(Dispatchers.IO) {
            for (line in outbound) {
                // A failed write ends the connection, so its link goes down rather
                // than reporting later lines Sent into a dead socket.
                if (!send(line)) {
                    close()
                    break
                }
            }
        }
    }

    fun close() {
        outbound.close()
        runCatching { socket.close() }
    }
}

internal fun Reader.readBoundedLine(maxChars: Int): String? {
    require(maxChars > 0)
    val result = StringBuilder(minOf(maxChars, 256))
    while (true) {
        when (val next = read()) {
            -1 -> return result.takeIf(StringBuilder::isNotEmpty)?.toString()
            '\n'.code -> {
                if (result.endsWith('\r')) result.setLength(result.length - 1)
                return result.toString()
            }
            else -> {
                if (result.length >= maxChars) throw LineTooLongException()
                result.append(next.toChar())
            }
        }
    }
}

internal class LineTooLongException : IOException("LAN link frame exceeds 64 KiB")

internal const val MAX_LINK_LINE_CHARS = 64 * 1024
internal const val LINK_IDLE_TIMEOUT_MS = 90_000
internal const val TLS_HANDSHAKE_TIMEOUT_MS = 10_000
