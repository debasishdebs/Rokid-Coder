package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.X509TrustManager
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import org.junit.After
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentdWireTest {
    private val fixtures = JSONObject(File("../../contracts/rokid-coder-v2.fixtures.json").readText())
    private val toAgent = fixtures.getJSONObject("phone_to_agent")
    private val alertLine = fixtures.getJSONObject("agent_to_phone").getJSONObject("alert").toString()

    private val written = mutableListOf<String>()
    private val wire = AgentdWire { line -> written += line; true }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() {
        scope.cancel()
    }

    private val steeringTypes = FrameClass.listedTypes.filter(FrameClass::isSteering)
    private val monitorTypes = FrameClass.listedTypes.filterNot(FrameClass::isSteering)

    /** The real frame when the fixtures have one, otherwise a bare frame of that type. */
    private fun frameOf(type: String): String =
        toAgent.optJSONObject(type)?.toString() ?: JSONObject().put("type", type).put("v", 2).toString()

    /** What the wire really sends for [line]: the parsed object, serialised again. */
    private fun reserialised(line: String): String = JSONObject(line).toString()

    // ------------------------------------------------------------ the gate

    @Test
    fun steering_types_on_insecure_binding_return_NotSecure_and_write_nothing() {
        assertEquals(
            setOf(
                "approval_decision", "session_input", "thread_start", "alert_action", "followup",
                "question_answer", "mode_set", "mode_revoke_all", "codex_settings", "codex_compact",
                "launcher_command", "defaults_set", "settings_sync",
            ),
            steeringTypes.toSet(),
        )
        wire.bind(1L, secure = false)

        steeringTypes.forEach { type ->
            assertEquals(type, AgentdWire.Result.NotSecure, wire.write(frameOf(type)))
        }
        // The v1 builders the transports already used are classified the same way.
        listOf(
            AgentdProtocolCodec.approvalDecision("r1", ApprovalDecision.ALLOW),
            AgentdProtocolCodec.sessionInput("r2", "s1", "ls"),
            AgentdProtocolCodec.threadStart("r3", AgentProvider.CLAUDE, "/tmp", "hi"),
        ).forEach { line -> assertEquals(line, AgentdWire.Result.NotSecure, wire.write(line)) }
        assertTrue(written.isEmpty())
        assertFalse(wire.secure.value)
    }

    @Test
    fun unknown_type_is_steering() {
        assertTrue(FrameClass.isSteering("not_a_frame"))
        wire.bind(1L, secure = false)
        assertEquals(AgentdWire.Result.NotSecure, wire.write("""{"type":"not_a_frame"}"""))
        // A frame whose type cannot be read is no more trusted than an unknown one.
        assertEquals(AgentdWire.Result.NotSecure, wire.write("""{"v":2}"""))
        assertEquals(AgentdWire.Result.NotSecure, wire.write("""{"type":7,"v":2}"""))
        assertTrue(written.isEmpty())

        wire.bind(2L, secure = true)
        assertEquals(AgentdWire.Result.Sent, wire.write("""{"type":"not_a_frame"}"""))
    }

    @Test
    fun monitor_frames_write_on_insecure_binding() {
        wire.bind(1L, secure = false)
        val lines = monitorTypes.map(::frameOf) +
            listOf(AgentdProtocolCodec.detailOpen("s1"), AgentdProtocolCodec.DETAIL_CLOSE, AgentdProtocolCodec.fsList("r1", null))

        lines.forEach { line -> assertEquals(line, AgentdWire.Result.Sent, wire.write(line)) }
        assertEquals(lines.map(::reserialised), written)
    }

    @Test
    fun unbind_then_write_steering_is_NoLink_or_NotSecure_never_Sent() {
        assertEquals(AgentdWire.Result.NoLink, wire.write(frameOf("alert_action")))
        assertEquals(AgentdWire.Result.NoLink, wire.write(frameOf("alert_shown")))

        wire.bind(1L, secure = true)
        assertTrue(wire.secure.value)
        assertEquals(AgentdWire.Result.Sent, wire.write(frameOf("alert_action")))
        wire.unbind(1L)

        assertFalse(wire.secure.value)
        steeringTypes.forEach { type ->
            assertNotEquals(type, AgentdWire.Result.Sent, wire.write(frameOf(type)))
        }
        assertEquals(AgentdWire.Result.NoLink, wire.write(frameOf("alert_shown")))
        assertEquals(1, written.size)
    }

    @Test
    fun stale_generation_unbind_does_not_clear_new_binding() {
        wire.bind(1L, secure = true)
        wire.bind(2L, secure = true)
        wire.unbind(1L)

        assertTrue(wire.secure.value)
        assertEquals(AgentdWire.Result.Sent, wire.write(frameOf("alert_action")))

        wire.unbind(2L)
        assertEquals(AgentdWire.Result.NoLink, wire.write(frameOf("alert_shown")))
    }

    @Test
    fun secure_to_plaintext_reconnect_blocks_steering() {
        wire.bind(1L, secure = true)
        wire.unbind(1L)
        wire.bind(2L, secure = false)

        assertFalse(wire.secure.value)
        assertEquals(AgentdWire.Result.NotSecure, wire.write(frameOf("alert_action")))
        assertTrue(written.isEmpty())
    }

    @Test
    fun a_raw_write_that_fails_is_not_reported_as_sent() {
        val dead = AgentdWire { false }
        dead.bind(1L, secure = false)
        assertEquals(AgentdWire.Result.NoLink, dead.write(frameOf("alert_shown")))
    }

    // ------------------------------------------ what is classified is what leaves

    @Test
    fun two_frames_in_one_line_refused() {
        wire.bind(1L, secure = false)
        val shown = AgentdProtocolCodec.alertShown("a")
        val action = frameOf("alert_action")
        // agentd splits on newlines: a monitor frame must not carry a steering one past the gate.
        listOf("$shown\n$action", "$shown\r\n$action", "$shown\r$action", "$shown\n").forEach { line ->
            assertEquals(AgentdWire.Result.Refused, wire.write(line))
        }
        wire.bind(2L, secure = true)
        assertEquals(AgentdWire.Result.Refused, wire.write("$shown\n$action"))
        assertTrue(written.isEmpty())
    }

    @Test
    fun trailing_garbage_refused() {
        wire.bind(1L, secure = true)
        val shown = AgentdProtocolCodec.alertShown("a")
        listOf(
            "$shown$shown",
            "$shown x",
            "$shown,",
            "[$shown]",
            "\"alert_shown\"",
            "not json",
            "",
        ).forEach { line ->
            assertEquals(line, AgentdWire.Result.Refused, wire.write(line))
        }
        assertTrue(written.isEmpty())
        // Whitespace around the one object is not content.
        assertEquals(AgentdWire.Result.Sent, wire.write("  $shown  "))
    }

    @Test
    fun malformed_line_returns_refused_not_throws() {
        val shown = AgentdProtocolCodec.alertShown("a")
        val malformed = listOf("not json", "$shown\n$shown", "$shown\r", "$shown trailing", "[$shown]")
        // Refused whatever the link: unbound, plaintext, trusted.
        malformed.forEach { line -> assertEquals(line, AgentdWire.Result.Refused, wire.write(line)) }
        wire.bind(1L, secure = false)
        malformed.forEach { line -> assertEquals(line, AgentdWire.Result.Refused, wire.write(line)) }
        wire.bind(2L, secure = true)
        malformed.forEach { line -> assertEquals(line, AgentdWire.Result.Refused, wire.write(line)) }
        assertTrue(written.isEmpty())
        assertEquals(AgentdWire.Result.Sent, wire.write(shown))
    }

    @Test
    fun padded_type_classified_as_steering_or_refused() {
        wire.bind(1L, secure = false)
        listOf(" alert_shown", "alert_shown ", "\talert_shown", "ALERT_SHOWN").forEach { type ->
            val line = JSONObject().put("type", type).put("v", 2).put("id", "a").toString()
            assertEquals(type, AgentdWire.Result.NotSecure, wire.write(line))
        }
        assertTrue(written.isEmpty())

        // On a trusted link it leaves as it is, untrimmed, for agentd to refuse.
        wire.bind(2L, secure = true)
        wire.write(JSONObject().put("type", " alert_shown").put("v", 2).put("id", "a").toString())
        assertEquals(" alert_shown", JSONObject(written.single()).getString("type"))
    }

    @Test
    fun sent_bytes_equal_reserialised_object() {
        wire.bind(1L, secure = false)
        val spaced = """ { "type" : "alert_shown" , "v" : 2 , "id" : "a" } """
        assertEquals(AgentdWire.Result.Sent, wire.write(spaced))
        assertEquals(listOf(reserialised(spaced)), written)
        assertNotEquals(spaced, written.single())

        // A newline inside a string value is escaped by the serialiser, never sent raw.
        wire.bind(2L, secure = true)
        val followup = AgentdProtocolCodec.followup("claude:s1", "line one\nline two", "m1")
        assertEquals(AgentdWire.Result.Sent, wire.write(followup))
        assertFalse('\n' in written.last())
        assertEquals("line one\nline two", JSONObject(written.last()).getString("text"))
    }

    // ------------------------------------------------------- inbound order

    @Test
    fun link_up_event_precedes_first_action_on_both_transports() {
        lanLink { lan ->
            // agentd sends nothing before hello_ack, but even a pipelined frame must
            // reach the phone's alert state after the link is announced.
            lan.handshake(pipelined = alertLine)

            val up = lan.events[0] as AgentdEvent.LinkUp
            // Mutual TLS with both pins: the only inbound link there is, and it steers.
            assertTrue(up.secure)
            awaitCondition { lan.events.size >= 2 }
            assertTrue((lan.events[1] as AgentdEvent.Action).action is AgentdAction.Alert)

            assertEquals(AgentdWire.Result.Sent, lan.server.decideApproval("r1", ApprovalDecision.ALLOW))
            assertEquals("approval_decision", JSONObject(lan.fromPhone.readLine()).getString("type"))
            assertEquals(AgentdWire.Result.Sent, lan.server.openDetail("s1"))
            assertEquals("detail_open", JSONObject(lan.fromPhone.readLine()).getString("type"))

            lan.hangUp()
            assertEquals(
                listOf(up, lan.events[1], AgentdEvent.LinkDown(up.generation)),
                lan.events.toList(),
            )
            assertEquals(AgentdWire.Result.NoLink, lan.server.openDetail("s1"))
        }

        val harness = ClientHarness()
        val conn = harness.connection(0)
        conn.open()
        assertEquals("hello", JSONObject(conn.sent.first()).getString("type"))
        // Nothing reaches the alert layer before the link is up.
        conn.message(alertLine)
        assertTrue(harness.events.isEmpty())
        assertEquals(AgentdWire.Result.NoLink, harness.client.decideApproval("r0", ApprovalDecision.ALLOW))

        conn.message(HELLO_ACK)
        conn.message(alertLine)
        val up = harness.events[0] as AgentdEvent.LinkUp
        // The dialled link is wss only, so once bound it steers.
        assertTrue(up.secure)
        assertTrue((harness.events[1] as AgentdEvent.Action).action is AgentdAction.Alert)
        assertEquals(2, harness.events.size)

        val sentBefore = conn.sent.size
        assertEquals(AgentdWire.Result.Sent, harness.client.decideApproval("r1", ApprovalDecision.ALLOW))
        assertEquals(sentBefore + 1, conn.sent.size)

        harness.client.stop(clearSessions = false)
        assertEquals(AgentdEvent.LinkDown(up.generation), harness.events.last())
        // A frame still in flight from the closed connection is not delivered.
        conn.message(alertLine)
        assertEquals(3, harness.events.size)
        assertEquals(AgentdWire.Result.NoLink, harness.client.openDetail("s1"))
    }

    // ---------------------------------------- the paired client's bind and end

    @Test
    fun hello_ack_after_end_does_not_bind() {
        val binding = AgentdLinkBinding(wire) { written += it.toString() }
        val owner = LinkOwner()
        binding.end(owner)
        assertNull(binding.up(owner, secure = true))
        assertFalse(wire.secure.value)
        assertTrue(written.isEmpty())

        val harness = ClientHarness()
        val conn = harness.connection(0)
        conn.open()
        conn.fail()
        conn.message(HELLO_ACK)
        conn.message(alertLine)
        assertTrue(harness.events.isEmpty())
        assertEquals(AgentdWire.Result.NoLink, harness.client.openDetail("s1"))
        assertFalse(harness.client.linkSecure.value)
    }

    @Test
    fun end_between_bind_and_generation_set_still_unbinds() {
        val harness = ClientHarness()
        val conn = harness.connection(0)
        conn.open()
        // The connection dies while its hello_ack is still being bound, before `up` returns.
        harness.onEvent = { event -> if (event is AgentdEvent.LinkUp) conn.fail() }
        conn.message(HELLO_ACK)

        val up = harness.events[0] as AgentdEvent.LinkUp
        assertEquals(listOf(up, AgentdEvent.LinkDown(up.generation)), harness.events.toList())
        assertEquals(AgentdWire.Result.NoLink, harness.client.openDetail("s1"))
        assertFalse(harness.client.linkSecure.value)
        conn.message(alertLine)
        assertEquals(2, harness.events.size)
    }

    @Test
    fun replacement_connection_never_writes_through_old_binding() {
        val harness = ClientHarness()
        val first = harness.connection(0)
        first.open()
        first.message(HELLO_ACK)
        val up = harness.events.single() as AgentdEvent.LinkUp

        first.fail()
        assertEquals(AgentdEvent.LinkDown(up.generation), harness.events.last())
        val sentByFirst = first.sent.toList()
        assertEquals(AgentdWire.Result.NoLink, harness.client.openDetail("s1"))

        // The loop reconnects into the same slot generation after its backoff.
        val second = harness.connection(1)
        assertEquals(AgentdWire.Result.NoLink, harness.client.openDetail("s1"))
        assertTrue(second.sent.isEmpty())
        second.open()
        assertEquals(AgentdWire.Result.NoLink, harness.client.requestFolders("r1", null))
        assertEquals(listOf("hello"), second.sent.map { JSONObject(it).getString("type") })
        assertEquals(sentByFirst, first.sent.toList())

        second.message(HELLO_ACK)
        val next = harness.events.last() as AgentdEvent.LinkUp
        assertNotEquals(up.generation, next.generation)
        assertEquals(listOf(up, AgentdEvent.LinkDown(up.generation), next), harness.events.toList())
    }

    // ------------------------------------------------ event delivery and order

    @Test
    fun link_events_never_dropped_under_backpressure() {
        val testScope = TestScope(StandardTestDispatcher())
        val delivered = mutableListOf<AgentdEvent>()
        var droppedTotal = 0L
        val queue = AgentdEventQueue(
            scope = testScope,
            maxActions = 256,
            sink = { delivered += it },
            onDropped = { droppedTotal = it },
        )
        fun action(n: Int) = AgentdEvent.Action(AgentdAction.AlertClosed("a$n", "expired"))

        // Nothing is drained until the scheduler runs: a collector that has fallen far behind.
        queue.offer(AgentdEvent.LinkUp(1L, secure = false))
        (1..1000).forEach { queue.offer(action(it)) }
        queue.offer(AgentdEvent.LinkDown(1L))
        queue.offer(AgentdEvent.LinkUp(2L, secure = false))
        (1001..1010).forEach { queue.offer(action(it)) }
        testScope.testScheduler.advanceUntilIdle()

        val expected = listOf(AgentdEvent.LinkUp(1L, false)) +
            (755..1000).map(::action) +
            listOf(AgentdEvent.LinkDown(1L), AgentdEvent.LinkUp(2L, false)) +
            (1001..1010).map(::action)
        assertEquals(expected, delivered)
        assertEquals(754L, droppedTotal)
        assertEquals(754L, queue.droppedCount)
        testScope.cancel()
    }

    @Test
    fun link_state_mirror_follows_the_live_link() {
        AgentsRuntime.emitEvent(AgentdEvent.LinkUp(9_001L, secure = false))
        assertEquals(AgentdLinkState(9_001L, secure = false), AgentsRuntime.link.value)
        // A stale LinkDown does not clear a newer link.
        AgentsRuntime.emitEvent(AgentdEvent.LinkDown(9_000L))
        assertEquals(AgentdLinkState(9_001L, secure = false), AgentsRuntime.link.value)
        AgentsRuntime.emitEvent(AgentdEvent.LinkDown(9_001L))
        assertNull(AgentsRuntime.link.value)
    }

    @Test
    fun lan_link_writes_keep_order() {
        lanLink { lan ->
            lan.handshake()
            val ids = (0 until 300).map { "a$it" }
            ids.forEach { id ->
                assertEquals(AgentdWire.Result.Sent, lan.server.write(AgentdProtocolCodec.alertShown(id)))
            }
            assertEquals(ids, ids.map { JSONObject(lan.fromPhone.readLine()).getString("id") })
            lan.hangUp()
        }
    }

    // ------------------------------------------------------------ harnesses

    /** The LAN link: the computer dials us, over a real loopback socket. */
    /** The inbound link as agentd dials it: mutual TLS, its client cert taken as the machine's pin. */
    private inner class LanLink(
        listener: SSLServerSocket,
        val store: AgentSessionStore = AgentSessionStore(),
        val linkEnds: AtomicInteger = AtomicInteger(),
        besideDialled: Boolean = false,
        onLinkEnded: () -> Unit = {},
        onSecureConnected: (LinkKey, String, String, String?) -> Unit = { _, _, _, _ -> },
    ) {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val server = AgentdLinkServer(
            store = store,
            authorizeMachine = { _, _ -> MachineTrustResult.TRUSTED },
            clientCertPinned = { _, _ -> true },
            touchMachineSeen = {},
            scope = scope,
            onMachineTrusted = {},
            tlsIdentity = FixturePhoneTlsIdentity(),
            onSecureConnected = onSecureConnected,
            onLinkEnded = {
                onLinkEnded()
                linkEnds.incrementAndGet()
            },
            onEvent = { events += it },
        ).also { it.besideDialled = besideDialled }
        val dialer: Socket = agentdContext().socketFactory.createSocket(InetAddress.getLoopbackAddress(), listener.localPort)
        private val connection = LinkConnection(listener.accept())
        private val serving = thread { server.serve(connection) }
        val fromPhone = BufferedReader(InputStreamReader(dialer.getInputStream(), Charsets.UTF_8))
        private val toPhone: OutputStream = dialer.getOutputStream()

        /** Hello sent and hello_ack read; the link may not be bound yet. */
        fun hello(pipelined: String? = null) {
            val hello = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
            toPhone.write((listOfNotNull(hello, pipelined).joinToString("\n") + "\n").toByteArray(Charsets.UTF_8))
            toPhone.flush()
            assertEquals("hello_ack", JSONObject(fromPhone.readLine()).getString("type"))
        }

        /** Bound and announced: LinkUp is raised before the CONNECTED state is written. */
        fun handshake(pipelined: String? = null) {
            hello(pipelined)
            awaitCondition {
                events.isNotEmpty() &&
                    store.connections.value[AgentProvider.CLAUDE] ==
                    ProviderConnectionState(ConnectionState.CONNECTED, "Desk")
            }
        }

        fun hangUp() {
            dialer.close()
            serving.join(5_000)
            assertFalse(serving.isAlive)
        }
    }

    private fun lanLink(
        store: AgentSessionStore = AgentSessionStore(),
        linkEnds: AtomicInteger = AtomicInteger(),
        besideDialled: Boolean = false,
        onLinkEnded: () -> Unit = {},
        onSecureConnected: (LinkKey, String, String, String?) -> Unit = { _, _, _, _ -> },
        block: (LanLink) -> Unit,
    ) {
        tlsServerSocket(FixturePhoneTlsIdentity(), 0).use { listener ->
            val lan = LanLink(listener, store, linkEnds, besideDialled, onLinkEnded, onSecureConnected)
            try {
                block(lan)
            } finally {
                lan.dialer.close()
            }
        }
    }

    @Test
    fun listener_stops_after_that_link_ends() {
        val store = AgentSessionStore()
        val ends = AtomicInteger()
        lanLink(store, ends, besideDialled = true) { lan ->
            lan.handshake()
            assertTrue(lan.server.linkSecure.value)
            assertEquals(0, ends.get())

            lan.hangUp()
            // The service is told, and reconciles: with the link gone and the window shut, the listener goes.
            awaitCondition { ends.get() == 1 }
            assertFalse(lan.server.linkSecure.value)
            // Beside a dialled slot the link's end writes nothing of its own: no "waiting for a computer".
            // Putting the slot's own state back is the slot's job (republishState), covered below.
            assertEquals(
                ProviderConnectionState(ConnectionState.CONNECTED, "Desk"),
                store.connections.value.getValue(AgentProvider.CLAUDE),
            )
        }
    }

    @Test
    fun inbound_link_ending_beside_refused_slot_restores_slot_state() {
        val store = AgentSessionStore()
        val http = FakeWebSocketClient()
        val client = AgentdClient(
            OkHttpClient(), store, scope, "test", FixturePhoneTlsIdentity(),
            pinnedClient = { http },
        ) {}
        client.start(
            AgentdConfig(
                host = "127.0.0.1", port = 8790, token = "secret", name = "Home",
                fp = FixturePhoneTlsIdentity.FINGERPRINT, steer = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123",
            ),
        )
        awaitCondition { http.connections.isNotEmpty() }
        http.connections.single().apply {
            open()
            message("""{"type":"hello_reject","v":2,"reason":"repair_needed"}""")
        }
        awaitCondition { store.connections.value.getValue(AgentProvider.CLAUDE).state == ConnectionState.AUTH_FAILED }
        val slot = store.connections.value.getValue(AgentProvider.CLAUDE)
        assertEquals(ProviderConnectionState(ConnectionState.AUTH_FAILED, PairingCopy.REPAIR_TO_STEER), slot)

        val ends = AtomicInteger()
        lanLink(store, ends, besideDialled = true, onLinkEnded = client::republishState) { lan ->
            // A second computer pairs inbound beside the refused slot and takes over the store's state...
            lan.handshake()
            assertEquals(
                ProviderConnectionState(ConnectionState.CONNECTED, "Desk"),
                store.connections.value.getValue(AgentProvider.CLAUDE),
            )

            // ...and when its link ends, the slot's own state is back: refused, not connected to "Desk".
            lan.hangUp()
            awaitCondition { ends.get() == 1 }
            assertEquals(slot, store.connections.value.getValue(AgentProvider.CLAUDE))
            assertTrue(client.needsRepair.value)
        }
        client.stop(clearSessions = true)
    }

    @Test
    fun republish_never_overwrites_a_newer_state_or_a_stop() {
        val store = GatedStore()
        val http = FakeWebSocketClient()
        val client = AgentdClient(
            OkHttpClient(), store, scope, "test", FixturePhoneTlsIdentity(),
            pinnedClient = { http },
        ) {}
        client.start(
            AgentdConfig(
                host = "127.0.0.1", port = 8790, token = "secret", name = "Home",
                fp = FixturePhoneTlsIdentity.FINGERPRINT, steer = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123",
            ),
        )
        // The dial is out, so the slot has published CONNECTING.
        awaitCondition { http.connections.isNotEmpty() }
        val connection = http.connections.single().apply { open() }
        assertEquals(ConnectionState.CONNECTING, store.connections.value.getValue(AgentProvider.CLAUDE).state)

        // A restore has read CONNECTING and is held inside its store write...
        val staleRestore = store.holdWriteOf(client::republishState)
        // ...while the hello_ack publishes the newer CONNECTED, then the restore lands.
        val ack = thread { connection.message(HELLO_ACK) }
        awaitFinishedOrBlocked(ack)
        staleRestore.release()
        ack.join(5_000)
        assertEquals(
            ProviderConnectionState(ConnectionState.CONNECTED, "Desk"),
            store.connections.value.getValue(AgentProvider.CLAUDE),
        )

        // A restore has read CONNECTED and is held inside its store write, while stop() clears the slot.
        val restoreBeforeStop = store.holdWriteOf(client::republishState)
        val stop = thread { client.stop(clearSessions = true) }
        awaitFinishedOrBlocked(stop)
        restoreBeforeStop.release()
        stop.join(5_000)
        assertEquals(
            ProviderConnectionState(ConnectionState.DISCONNECTED),
            store.connections.value.getValue(AgentProvider.CLAUDE),
        )

        // And a restore after the stop writes nothing.
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING, "waiting for a computer")
        client.republishState()
        assertEquals(
            ProviderConnectionState(ConnectionState.CONNECTING, "waiting for a computer"),
            store.connections.value.getValue(AgentProvider.CLAUDE),
        )
    }

    /** Ran to the end, or is waiting on a monitor: either way it has gone as far as it can on its own. */
    private fun awaitFinishedOrBlocked(worker: Thread) =
        awaitCondition { !worker.isAlive || worker.state == Thread.State.BLOCKED }

    /** A store whose chosen thread stops inside its next connection write, until released. */
    private class GatedStore : AgentSessionStore() {
        @Volatile private var heldThread: Thread? = null
        @Volatile private var reached = CountDownLatch(1)
        @Volatile private var gate = CountDownLatch(1)

        inner class Held(private val worker: Thread, private val opened: CountDownLatch) {
            fun release() {
                opened.countDown()
                worker.join(5_000)
                check(!worker.isAlive) { "held write never finished" }
            }
        }

        /** Runs [block] on its own thread and returns once that thread is inside its connection write. */
        fun holdWriteOf(block: () -> Unit): Held {
            reached = CountDownLatch(1)
            gate = CountDownLatch(1)
            val opened = gate
            val worker = thread(start = false) { block() }
            heldThread = worker
            worker.start()
            check(reached.await(5, TimeUnit.SECONDS)) { "write never reached the store" }
            return Held(worker, opened)
        }

        override fun setConnection(provider: AgentProvider, state: ConnectionState, detail: String?) {
            if (Thread.currentThread() === heldThread) {
                heldThread = null
                reached.countDown()
                gate.await()
            }
            super.setConnection(provider, state, detail)
        }
    }

    @Test
    fun a_client_that_never_published_a_state_repaints_nothing() {
        val store = AgentSessionStore()
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTING, "waiting for a computer")
        val client = AgentdClient(OkHttpClient(), store, scope, "test", FixturePhoneTlsIdentity()) {}

        client.republishState()

        assertEquals(
            ProviderConnectionState(ConnectionState.CONNECTING, "waiting for a computer"),
            store.connections.value.getValue(AgentProvider.CLAUDE),
        )
    }

    @Test
    fun stop_beside_dialled_cleans_up_when_it_ends_a_live_link() {
        val store = AgentSessionStore()
        lanLink(store, besideDialled = true) { lan ->
            lan.handshake()
            assertEquals(ConnectionState.CONNECTED, store.connections.value.getValue(AgentProvider.CLAUDE).state)

            lan.server.stop(clearSessions = false, besideDialled = true)

            assertEquals(ConnectionState.DISCONNECTED, store.connections.value.getValue(AgentProvider.CLAUDE).state)
            assertFalse(lan.server.linkSecure.value)
        }
    }

    @Test
    fun stop_right_after_bind_is_never_followed_by_the_bound_state() {
        val store = AgentSessionStore()
        val bound = CountDownLatch(1)
        val release = CountDownLatch(1)
        // The serving thread is held after its bind, before it announces the link.
        val gate: (LinkKey, String, String, String?) -> Unit = { _, _, _, _ ->
            bound.countDown()
            release.await(5, TimeUnit.SECONDS)
        }
        lanLink(store, onSecureConnected = gate) { lan ->
            lan.hello()
            assertTrue(bound.await(5, TimeUnit.SECONDS))
            // agentd hangs up on the phone's close_notify, which the stop's TLS close waits for.
            val agentd = thread {
                runCatching { while (lan.fromPhone.readLine() != null) Unit }
                lan.dialer.close()
            }

            lan.server.stop(clearSessions = false)
            agentd.join(5_000)
            release.countDown()
            lan.hangUp()

            assertEquals(
                ProviderConnectionState(ConnectionState.DISCONNECTED),
                store.connections.value.getValue(AgentProvider.CLAUDE),
            )
            assertNull(store.linkMachine.value)
        }
    }

    @Test
    fun stop_beside_dialled_with_no_link_leaves_the_slots_state() {
        val store = AgentSessionStore()
        store.setConnection(AgentProvider.CLAUDE, ConnectionState.CONNECTED, "Home")
        val server = AgentdLinkServer(
            store = store,
            authorizeMachine = { _, _ -> MachineTrustResult.TRUSTED },
            clientCertPinned = { _, _ -> true },
            touchMachineSeen = {},
            scope = scope,
            onMachineTrusted = {},
            tlsIdentity = FixturePhoneTlsIdentity(),
            onEvent = {},
        )
        server.stop(clearSessions = false, besideDialled = true)
        assertEquals(ConnectionState.CONNECTED, store.connections.value.getValue(AgentProvider.CLAUDE).state)
    }

    @Test
    fun plaintext_lan_link_is_refused_not_bound() {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            val events = CopyOnWriteArrayList<AgentdEvent>()
            val server = AgentdLinkServer(
                store = AgentSessionStore(),
                authorizeMachine = { _, _ -> MachineTrustResult.TRUSTED },
                clientCertPinned = { _, _ -> true },
                touchMachineSeen = {},
                scope = scope,
                onMachineTrusted = {},
                tlsIdentity = FixturePhoneTlsIdentity(),
                onEvent = { events += it },
            )
            Socket(listener.inetAddress, listener.localPort).use { dialer ->
                val serving = thread { server.serve(LinkConnection(listener.accept())) }
                val hello = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
                dialer.getOutputStream().write("$hello\n".toByteArray(Charsets.UTF_8))
                val fromPhone = BufferedReader(InputStreamReader(dialer.getInputStream(), Charsets.UTF_8))
                // Whatever the token says, a link without TLS is never acknowledged, let alone bound.
                assertEquals("hello_reject", JSONObject(fromPhone.readLine()).getString("type"))
                serving.join(5_000)
                assertFalse(serving.isAlive)
            }
            assertTrue(events.isEmpty())
            assertEquals(AgentdWire.Result.NoLink, server.openDetail("s1"))
        }
    }

    /** agentd's side of the inbound link: its fixture client cert, and any phone cert (the pin is checked elsewhere). */
    private fun agentdContext(): SSLContext {
        val agentd = FixturePhoneTlsIdentity.agentdA()
        val password = "fixture".toCharArray()
        val keys = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setKeyEntry("agentd", agentd.key, password, arrayOf(agentd.certificate))
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(keys, password) }
            .keyManagers
        val anyServer = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(anyServer), null) }
    }

    /** The paired path: we dial agentd's WebSocket. The injected OkHttpClient is the seam. */
    private inner class ClientHarness {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        @Volatile var onEvent: (AgentdEvent) -> Unit = {}
        private val http = FakeWebSocketClient()
        val client = AgentdClient(
            OkHttpClient(),
            AgentSessionStore(),
            scope,
            "test",
            FixturePhoneTlsIdentity(),
            pinnedClient = { http },
        ) { event ->
            events += event
            onEvent(event)
        }

        init {
            client.start(
                AgentdConfig(
                    host = "127.0.0.1",
                    port = 8790,
                    token = "secret",
                    name = "Desk",
                    fp = FixturePhoneTlsIdentity.FINGERPRINT,
                    steer = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123",
                ),
            )
        }

        fun connection(index: Int): FakeConnection {
            awaitCondition { http.connections.size > index }
            return http.connections[index]
        }
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

        fun fail() = listener.onFailure(socket, IOException("connection reset"), null)
    }

    private class FakeWebSocketClient : OkHttpClient() {
        val connections = CopyOnWriteArrayList<FakeConnection>()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeConnection(listener, request).also(connections::add).socket
    }

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(5)
        }
    }

    private companion object {
        const val HELLO_ACK = """{"type":"hello_ack","v":1,"steering":true,"server":{"machineName":"Desk"}}"""
    }
}
