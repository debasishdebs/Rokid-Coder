package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.File
import java.io.IOException
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
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
    fun steering_types_on_insecure_binding_return_MonitorOnly_and_write_nothing() {
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
            assertEquals(type, AgentdWire.Result.MonitorOnly, wire.write(frameOf(type)))
        }
        // The v1 builders the transports already used are classified the same way.
        listOf(
            AgentdProtocolCodec.approvalDecision("r1", ApprovalDecision.ALLOW),
            AgentdProtocolCodec.sessionInput("r2", "s1", "ls"),
            AgentdProtocolCodec.threadStart("r3", AgentProvider.CLAUDE, "/tmp", "hi"),
        ).forEach { line -> assertEquals(line, AgentdWire.Result.MonitorOnly, wire.write(line)) }
        assertTrue(written.isEmpty())
        assertFalse(wire.secure.value)
    }

    @Test
    fun unknown_type_is_steering() {
        assertTrue(FrameClass.isSteering("not_a_frame"))
        wire.bind(1L, secure = false)
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write("""{"type":"not_a_frame"}"""))
        // A frame whose type cannot be read is no more trusted than an unknown one.
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write("""{"v":2}"""))
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write("""{"type":7,"v":2}"""))
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
    fun unbind_then_write_steering_is_NoLink_or_MonitorOnly_never_Sent() {
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
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write(frameOf("alert_action")))
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
            assertThrows(IllegalArgumentException::class.java) { wire.write(line) }
        }
        wire.bind(2L, secure = true)
        assertThrows(IllegalArgumentException::class.java) { wire.write("$shown\n$action") }
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
            assertThrows(line, IllegalArgumentException::class.java) { wire.write(line) }
        }
        assertTrue(written.isEmpty())
        // Whitespace around the one object is not content.
        assertEquals(AgentdWire.Result.Sent, wire.write("  $shown  "))
    }

    @Test
    fun padded_type_classified_as_steering_or_refused() {
        wire.bind(1L, secure = false)
        listOf(" alert_shown", "alert_shown ", "\talert_shown", "ALERT_SHOWN").forEach { type ->
            val line = JSONObject().put("type", type).put("v", 2).put("id", "a").toString()
            assertEquals(type, AgentdWire.Result.MonitorOnly, wire.write(line))
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
            assertFalse(up.secure)
            awaitCondition { lan.events.size >= 2 }
            assertTrue((lan.events[1] as AgentdEvent.Action).action is AgentdAction.Alert)

            // The writes go through the gate: plaintext refuses steering, passes monitor frames.
            assertEquals(
                AgentdWire.Result.MonitorOnly,
                lan.server.decideApproval("r1", ApprovalDecision.ALLOW),
            )
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
        assertFalse(up.secure)
        assertTrue((harness.events[1] as AgentdEvent.Action).action is AgentdAction.Alert)
        assertEquals(2, harness.events.size)

        val sentBefore = conn.sent.size
        assertEquals(AgentdWire.Result.MonitorOnly, harness.client.decideApproval("r1", ApprovalDecision.ALLOW))
        assertEquals(sentBefore, conn.sent.size)

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
    private inner class LanLink(listener: ServerSocket) {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val server = AgentdLinkServer(
            store = AgentSessionStore(),
            authorizeMachine = { MachineTrustResult.TRUSTED },
            touchMachineSeen = {},
            scope = scope,
            onMachineTrusted = {},
            onEvent = { events += it },
        )
        val dialer = Socket(listener.inetAddress, listener.localPort)
        private val connection = LinkConnection(listener.accept())
        private val serving = thread { server.serve(connection) }
        val fromPhone = BufferedReader(InputStreamReader(dialer.getInputStream(), Charsets.UTF_8))
        private val toPhone: OutputStream = dialer.getOutputStream()

        fun handshake(pipelined: String? = null) {
            val hello = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
            toPhone.write((listOfNotNull(hello, pipelined).joinToString("\n") + "\n").toByteArray(Charsets.UTF_8))
            toPhone.flush()
            assertEquals("hello_ack", JSONObject(fromPhone.readLine()).getString("type"))
            awaitCondition { events.isNotEmpty() }
        }

        fun hangUp() {
            dialer.close()
            serving.join(5_000)
            assertFalse(serving.isAlive)
        }
    }

    private fun lanLink(block: (LanLink) -> Unit) {
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            val lan = LanLink(listener)
            try {
                block(lan)
            } finally {
                lan.dialer.close()
            }
        }
    }

    /** The paired path: we dial agentd's WebSocket. The injected OkHttpClient is the seam. */
    private inner class ClientHarness {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        @Volatile var onEvent: (AgentdEvent) -> Unit = {}
        private val http = FakeWebSocketClient()
        val client = AgentdClient(http, AgentSessionStore(), scope, "test") { event ->
            events += event
            onEvent(event)
        }

        init {
            client.start(AgentdConfig(host = "127.0.0.1", port = 8790, token = "secret", name = "Desk"))
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
        const val HELLO_ACK = """{"type":"hello_ack","v":1,"server":{"machineName":"Desk"}}"""
    }
}
