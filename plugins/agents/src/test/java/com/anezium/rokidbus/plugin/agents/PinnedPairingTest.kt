package com.anezium.rokidbus.plugin.agents

import java.net.InetAddress
import java.net.ServerSocket
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.logging.Level
import java.util.logging.Logger
import kotlin.concurrent.thread
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.internal.tls.OkHostnameVerifier
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.ByteString
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class PinnedPairingTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = MemoryPrefs()

    @After
    fun tearDown() {
        scope.cancel()
    }

    init {
        // A refused handshake is the point of several tests here, not news.
        Logger.getLogger(MockWebServer::class.java.name).level = Level.OFF
    }

    // ------------------------------------------------------ the pairing line and the store

    @Test
    fun malformed_fp_pairing_is_refused_not_legacy() {
        listOf<Any>("nope", FP.dropLast(3), 7, JSONObject.NULL, "").forEach { bad ->
            assertEquals(
                bad.toString(),
                AgentdPairingParseResult.Invalid("Pairing line has a bad fingerprint"),
                AgentdPairingParser.parse(line(fp = bad)),
            )
        }
        // A pin stored before it went bad is still a pin: the client refuses it and dials nothing.
        prefs.map["agentd.host"] = "127.0.0.1"
        prefs.map["agentd.port"] = 8790
        prefs.map["agentd.token"] = "tok"
        prefs.map["agentd.fp"] = "zz"
        val harness = Harness()
        harness.client.start(checkNotNull(store().load().agentd))
        harness.awaitState(ConnectionState.AUTH_FAILED, "Pairing line has a bad fingerprint")
        assertEquals(0, harness.plain.connections.size)
        assertEquals(0, harness.pinned.connections.size)
    }

    @Test
    fun fp_persists_across_store_reload() {
        val parsed = (AgentdPairingParser.parse(line(fp = FP.lowercase())) as AgentdPairingParseResult.Valid).config
        assertEquals(FP, parsed.fp)
        assertTrue(store().saveAgentd(parsed, enabled = true))
        assertEquals(FP, prefs.map["agentd.fp"])
        assertEquals(STEER, prefs.map["agentd.steer"])

        val reloaded = checkNotNull(AgentsConfigStore(prefs) { 0L }.load().agentd)
        assertEquals(parsed, reloaded)
        assertTrue(reloaded.canSteer)
        // Neither secret is part of the string the config becomes.
        assertFalse(reloaded.toString().contains(STEER))
        assertFalse(reloaded.toString().contains("tok"))

        // Forget is one of the two ways a pin goes.
        store().saveAgentd(null, enabled = true)
        assertNull(prefs.map["agentd.fp"])
        assertNull(prefs.map["agentd.steer"])

        // Without a pin the secret has no wss to travel on, so it is not kept.
        val legacy = (AgentdPairingParser.parse(line(fp = null)) as AgentdPairingParseResult.Valid).config
        assertNull(legacy.fp)
        assertNull(legacy.steer)
        assertFalse(legacy.canSteer)
    }

    @Test
    fun pinned_slot_refuses_line_without_fp() {
        val pinned = (AgentdPairingParser.parse(line()) as AgentdPairingParseResult.Valid).config
        val legacy = (AgentdPairingParser.parse(line(fp = null)) as AgentdPairingParseResult.Valid).config
        // A legacy slot is re-paired with a pinned line freely.
        assertTrue(store().saveAgentd(legacy, enabled = true))
        assertTrue(store().saveAgentd(pinned, enabled = true))

        assertEquals("Pairing line has no fingerprint — this computer is pinned", store().agentdPairingRefusal(legacy))
        assertFalse(store().saveAgentd(legacy, enabled = false))
        assertEquals(pinned, store().load().agentd)
        assertTrue(store().load().agentdEnabled)

        // Re-pairing with another pinned line replaces the pin.
        val repaired = pinned.copy(fp = CertPins.fingerprint256(HeldCertificate.Builder().build().certificate.encoded))
        assertTrue(store().saveAgentd(repaired, enabled = true))
        assertEquals(repaired.fp, store().load().agentd?.fp)
    }

    // ------------------------------------------------------ the hello and the binding

    @Test
    fun steer_sent_only_in_wss_hello_never_in_ws_hello() {
        val pinned = Harness()
        pinned.client.start(config(host = "ws://127.0.0.1"))
        val wss = pinned.pinnedConnection()
        // Whatever the host was written with, a pinned pairing dials TLS.
        assertEquals("https", wss.request.url.scheme)
        wss.open()
        val hello = JSONObject(wss.sent.single())
        assertEquals(STEER, hello.getString("steer"))
        assertEquals("tok", hello.getString("token"))
        assertEquals(0, pinned.plain.connections.size)

        // A config that somehow holds the secret but no pin still never sends it.
        val legacy = Harness()
        legacy.client.start(config(fp = null))
        val ws = legacy.plainConnection()
        assertEquals("http", ws.request.url.scheme)
        ws.open()
        assertFalse(JSONObject(ws.sent.single()).has("steer"))
        ws.message(HELLO_ACK)
        assertFalse((legacy.events.single() as AgentdEvent.LinkUp).secure)
        assertEquals(0, legacy.pinned.connections.size)
    }

    @Test
    fun fp_without_steer_is_monitor_only() {
        val harness = Harness()
        val config = config(steer = null)
        assertFalse(config.canSteer)
        harness.client.start(config)
        val wss = harness.pinnedConnection()
        wss.open()
        assertFalse(JSONObject(wss.sent.single()).has("steer"))
        wss.message(HELLO_ACK)
        assertFalse((harness.events.single() as AgentdEvent.LinkUp).secure)
        assertFalse(harness.client.linkSecure.value)
        assertEquals(
            AgentdWire.Result.MonitorOnly,
            harness.client.write(AgentdProtocolCodec.modeRevokeAll(UUID.randomUUID().toString())),
        )
    }

    @Test
    fun rotated_steer_shows_repair_and_keeps_v1_alerts() {
        // agentd's steer was rotated: the redial with the old one is accepted as a monitor client only.
        val harness = Harness()
        harness.client.start(config())
        val wss = harness.pinnedConnection()
        wss.open()
        assertEquals(STEER, JSONObject(wss.sent.single()).getString("steer"))
        wss.message(HELLO_ACK_MONITOR)
        assertFalse((harness.events.single() as AgentdEvent.LinkUp).secure)
        assertFalse(harness.client.linkSecure.value)
        harness.awaitState(ConnectionState.CONNECTED, "Re-pair to allow approvals")
        assertEquals(
            AgentdWire.Result.MonitorOnly,
            harness.client.write(AgentdProtocolCodec.modeRevokeAll(UUID.randomUUID().toString())),
        )
        // A hello_ack from an agentd that states no grant grants nothing either.
        val old = Harness()
        old.client.start(config())
        old.pinnedConnection().apply { open(); message(HELLO_ACK) }
        assertFalse(old.client.linkSecure.value)

        // This computer spoke v2 before, but its link is up and cannot steer: v1 attention speaks for it.
        val config = store()
        config.markV2Seen(null)
        val session = AgentSession(
            provider = AgentProvider.CLAUDE,
            id = "s1",
            title = "s1",
            status = AgentStatus.NEEDS_YOU,
        )
        assertFalse(config.v1AttentionSuppressed(session, linkSecure = false, monitorOnlyLinkUp = true))
        // While the link is down, R92 still keeps it off.
        assertTrue(config.v1AttentionSuppressed(session, linkSecure = false, monitorOnlyLinkUp = false))
    }

    @Test
    fun link_trust_revocation_stops_steering_at_once() {
        val harness = Harness()
        harness.client.start(config())
        val wss = harness.pinnedConnection()
        wss.open()
        wss.message(HELLO_ACK_STEERING)
        assertTrue(harness.client.linkSecure.value)

        wss.message("""{"type":"link_trust","v":2,"steering":false}""")
        assertFalse(harness.client.linkSecure.value)
        assertFalse((harness.events.last() as AgentdEvent.LinkUp).secure)
        harness.awaitState(ConnectionState.CONNECTED, "Re-pair to allow approvals")
        // It never comes back mid-link.
        wss.message("""{"type":"link_trust","v":2,"steering":true}""")
        assertFalse(harness.client.linkSecure.value)
    }

    @Test
    fun monitor_only_ack_never_sets_v2_seen() {
        val rejected = AgentdEvent.Action(AgentdAction.Ack("m1", "rejected", "monitor_only"))
        assertFalse(marksV2Seen(rejected, linkSecure = false))
        assertFalse(marksV2Seen(rejected, linkSecure = true))
        assertFalse(marksV2Seen(AgentdEvent.Action(AgentdAction.Ack("m2", "applied", null)), linkSecure = true))
        val alert = AgentdEvent.Action(
            AgentdAction.Alert("a1", "claude:s1", AlertKind.APPROVAL, "Bash", "ls", emptyList(), null, 0, AlertReason.NEW),
        )
        assertFalse(marksV2Seen(alert, linkSecure = false))
        assertTrue(marksV2Seen(alert, linkSecure = true))
    }

    // ------------------------------------------------------ a real TLS agentd

    @Test
    fun pinned_websocket_handshake_against_local_tls_server() {
        agentd { server, held, received ->
            val harness = Harness(real = true)
            harness.client.start(config(port = server.port, fp = CertPins.fingerprint256(held.certificate.encoded)))
            harness.awaitState(ConnectionState.CONNECTED, null)
            val hello = JSONObject(received.first())
            assertEquals("hello", hello.getString("type"))
            assertEquals("tok", hello.getString("token"))
            assertEquals(STEER, hello.getString("steer"))
            assertTrue((harness.events.single() as AgentdEvent.LinkUp).secure)
            assertTrue(harness.client.linkSecure.value)
            assertEquals(0, harness.plain.connections.size)
            harness.client.stop(clearSessions = true)
        }
    }

    @Test
    fun pinned_client_accepts_ip_host_without_san_only_with_matching_pin() {
        agentd { server, held, _ ->
            val base = OkHttpClient()
            val pin = CertPins.fingerprint256(held.certificate.encoded)
            val url = "wss://127.0.0.1:${server.port}/"

            // The cert names no host, so only the pin can vouch for 127.0.0.1.
            assertNull(open(pinnedOkHttpClient(base, pin), url))
            val trust = CertPins.trustManager(pin)
            val pinOnly = base.newBuilder()
                .sslSocketFactory(SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }.socketFactory, trust)
                .build()
            assertTrue(open(pinOnly, url) is SSLPeerUnverifiedException)
            // The relaxation lives on the pinned client only.
            assertSame(OkHostnameVerifier, base.hostnameVerifier)

            // Another pin: refused before any request, so no hello and no token, and no ws:// after it.
            val harness = Harness(real = true)
            harness.client.start(config(port = server.port))
            harness.awaitState(ConnectionState.AUTH_FAILED, "Computer's certificate changed — re-pair")
            Thread.sleep(300)
            assertEquals(1, server.requestCount)
            assertEquals(0, harness.plain.connections.size)
            assertTrue(harness.events.isEmpty())
        }
    }

    @Test
    fun tls_failure_on_a_pinned_link_retries_over_wss_only() {
        // A peer that answers in plaintext: the handshake fails, but not on the pin.
        ServerSocket(0, 8, InetAddress.getByName("127.0.0.1")).use { listener ->
            val accepts = AtomicInteger()
            thread(isDaemon = true) {
                while (true) {
                    val socket = runCatching { listener.accept() }.getOrNull() ?: break
                    accepts.incrementAndGet()
                    socket.use { it.getOutputStream().write("HTTP/1.1 400 Bad Request\r\n\r\n".toByteArray()) }
                }
            }
            val harness = Harness(real = true)
            harness.client.start(config(port = listener.localPort))
            harness.awaitState(ConnectionState.DISCONNECTED, "Secure link failed")
            // Still retrying, and still over TLS through the pinned client: never ws://.
            awaitCondition { accepts.get() >= 2 }
            assertEquals(0, harness.plain.connections.size)
            assertTrue(harness.events.isEmpty())
            harness.client.stop(clearSessions = true)
        }
    }

    // ------------------------------------------------------------ harnesses

    private fun store() = AgentsConfigStore(prefs) { 0L }

    private fun line(fp: Any? = FP, steer: Any? = STEER): String = JSONObject()
        .put("v", 1)
        .put("kind", "nexus-agentd")
        .put("name", "Desk")
        .put("host", "127.0.0.1")
        .put("port", 8790)
        .put("token", "tok")
        .apply {
            if (fp != null) put("fp", fp)
            if (steer != null) put("steer", steer)
        }
        .toString()

    private fun config(host: String = "127.0.0.1", port: Int = 8790, fp: String? = FP, steer: String? = STEER) =
        AgentdConfig(host = host, port = port, token = "tok", name = "Desk", fp = fp, steer = steer)

    /** One AgentdClient; [plain] and [pinned] record which client it dialled through. */
    private inner class Harness(real: Boolean = false) {
        val store = AgentSessionStore()
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val plain = FakeWebSocketClient()
        val pinned = FakeWebSocketClient()
        val client = AgentdClient(
            plain,
            store,
            scope,
            "test",
            pinnedClient = { pin -> if (real) pinnedOkHttpClient(OkHttpClient(), pin) else pinned },
        ) { events += it }

        fun pinnedConnection(): FakeConnection {
            awaitCondition { pinned.connections.isNotEmpty() }
            return pinned.connections.single()
        }

        fun plainConnection(): FakeConnection {
            awaitCondition { plain.connections.isNotEmpty() }
            return plain.connections.single()
        }

        fun awaitState(state: ConnectionState, detail: String?) = awaitCondition({ "${store.connections.value[AgentProvider.CLAUDE]}" }) {
            val now = store.connections.value.getValue(AgentProvider.CLAUDE)
            now.state == state && (detail == null || now.detail == detail)
        }
    }

    /** A TLS agentd on loopback whose cert has no subject alternative names; it answers hello. */
    private fun agentd(block: (MockWebServer, HeldCertificate, List<String>) -> Unit) {
        val held = HeldCertificate.Builder().commonName("rokid-coder-agentd").build()
        val received = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        server.useHttps(HandshakeCertificates.Builder().heldCertificate(held).build().sslSocketFactory(), false)
        repeat(4) {
            server.enqueue(
                MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                    override fun onMessage(webSocket: WebSocket, text: String) {
                        received += text
                        if (JSONObject(text).optString("type") == "hello") webSocket.send(HELLO_ACK_STEERING)
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                    }
                }),
            )
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
        try {
            block(server, held, received)
        } finally {
            server.shutdown()
        }
    }

    /** Null once the socket opened, else why it failed. */
    private fun open(client: OkHttpClient, url: String): Throwable? {
        val done = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>()
        client.newWebSocket(
            Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    webSocket.close(1000, null)
                    done.countDown()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    failure.set(t)
                    done.countDown()
                }
            },
        )
        assertTrue(done.await(5, TimeUnit.SECONDS))
        return failure.get()
    }

    private class FakeConnection(val listener: WebSocketListener, val request: Request) {
        val sent = CopyOnWriteArrayList<String>()

        val socket = object : WebSocket {
            override fun request(): Request = request
            override fun queueSize(): Long = 0L
            override fun send(text: String): Boolean = sent.add(text)
            override fun send(bytes: ByteString): Boolean = false
            override fun close(code: Int, reason: String?): Boolean = true
            override fun cancel() = Unit
        }

        fun open() = listener.onOpen(
            socket,
            Response.Builder()
                .request(request)
                .protocol(Protocol.HTTP_1_1)
                .code(101)
                .message("Switching Protocols")
                .build(),
        )

        fun message(text: String) = listener.onMessage(socket, text)
    }

    private class FakeWebSocketClient : OkHttpClient() {
        val connections = CopyOnWriteArrayList<FakeConnection>()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeConnection(listener, request).also(connections::add).socket
    }

    private fun awaitCondition(seen: () -> String = { "" }, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out ${seen()}" }
            Thread.sleep(5)
        }
    }

    private companion object {
        const val FP = FixturePhoneTlsIdentity.FINGERPRINT
        const val STEER = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123"
        const val HELLO_ACK = """{"type":"hello_ack","v":1,"server":{"machineName":"Desk"}}"""
        const val HELLO_ACK_STEERING = """{"type":"hello_ack","v":1,"steering":true,"server":{"machineName":"Desk"}}"""
        const val HELLO_ACK_MONITOR = """{"type":"hello_ack","v":1,"steering":false,"server":{"machineName":"Desk"}}"""
    }
}
