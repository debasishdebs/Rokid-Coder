package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread
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
import okio.ByteString
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
        // A line whose type cannot be read is no more trusted than an unknown one.
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write("""{"v":2}"""))
        assertEquals(AgentdWire.Result.MonitorOnly, wire.write("not json"))
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
        assertEquals(lines, written)
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

    // ------------------------------------------------------- inbound order

    @Test
    fun link_up_event_precedes_first_action_on_both_transports() {
        linkServerOrder()
        agentdClientOrder()
    }

    /** The LAN link: the computer dials us, over a real local socket. */
    private fun linkServerOrder() {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val server = AgentdLinkServer(
            store = AgentSessionStore(),
            authorizeMachine = { MachineTrustResult.TRUSTED },
            touchMachineSeen = {},
            scope = scope,
            onMachineTrusted = {},
            onEvent = { events += it },
        )
        ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { listener ->
            Socket(listener.inetAddress, listener.localPort).use { dialer ->
                val connection = LinkConnection(listener.accept())
                val serving = thread { server.serve(connection) }
                val fromPhone = BufferedReader(InputStreamReader(dialer.getInputStream(), Charsets.UTF_8))
                val hello = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
                // agentd sends nothing before hello_ack, but even a pipelined frame must
                // reach the phone's alert state after the link is announced.
                dialer.getOutputStream().write("$hello\n$alertLine\n".toByteArray(Charsets.UTF_8))
                dialer.getOutputStream().flush()
                assertEquals("hello_ack", JSONObject(fromPhone.readLine()).getString("type"))

                awaitCondition { events.size >= 2 }
                val up = events[0] as AgentdEvent.LinkUp
                assertFalse(up.secure)
                assertTrue((events[1] as AgentdEvent.Action).action is AgentdAction.Alert)

                // The writes go through the gate: plaintext refuses steering, passes monitor frames.
                assertEquals(
                    AgentdWire.Result.MonitorOnly,
                    server.decideApproval("r1", ApprovalDecision.ALLOW),
                )
                assertEquals(AgentdWire.Result.Sent, server.openDetail("s1"))
                assertEquals("detail_open", JSONObject(fromPhone.readLine()).getString("type"))

                dialer.close()
                serving.join(5_000)
                assertEquals(
                    listOf(up, events[1], AgentdEvent.LinkDown(up.generation)),
                    events.toList(),
                )
                assertEquals(AgentdWire.Result.NoLink, server.openDetail("s1"))
            }
        }
    }

    /** The paired path: we dial agentd's WebSocket. The injected OkHttpClient is the seam. */
    private fun agentdClientOrder() {
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val http = FakeWebSocketClient()
        val client = AgentdClient(http, AgentSessionStore(), scope, "test", onEvent = { events += it })
        client.start(AgentdConfig(host = "127.0.0.1", port = 8790, token = "secret", name = "Desk"))
        awaitCondition { http.listener != null }
        val listener = http.listener!!
        val socket = http.socket

        listener.onOpen(socket, http.upgradeResponse())
        assertEquals("hello", JSONObject(http.sent.first()).getString("type"))
        // Nothing reaches the alert layer before the link is up.
        listener.onMessage(socket, alertLine)
        assertTrue(events.isEmpty())
        assertEquals(AgentdWire.Result.NoLink, client.decideApproval("r0", ApprovalDecision.ALLOW))

        listener.onMessage(socket, """{"type":"hello_ack","v":1,"server":{"machineName":"Desk"}}""")
        listener.onMessage(socket, alertLine)
        val up = events[0] as AgentdEvent.LinkUp
        assertFalse(up.secure)
        assertTrue((events[1] as AgentdEvent.Action).action is AgentdAction.Alert)
        assertEquals(2, events.size)

        val sentBefore = http.sent.size
        assertEquals(AgentdWire.Result.MonitorOnly, client.decideApproval("r1", ApprovalDecision.ALLOW))
        assertEquals(sentBefore, http.sent.size)

        client.stop(clearSessions = false)
        assertEquals(AgentdEvent.LinkDown(up.generation), events.last())
        // A frame still in flight from the closed connection is not delivered.
        listener.onMessage(socket, alertLine)
        assertEquals(3, events.size)
        assertEquals(AgentdWire.Result.NoLink, client.openDetail("s1"))
    }

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(5)
        }
    }

    private class FakeWebSocketClient : OkHttpClient() {
        @Volatile var listener: WebSocketListener? = null
        val sent = CopyOnWriteArrayList<String>()
        private val request = Request.Builder().url("http://127.0.0.1:8790/").build()

        val socket = object : WebSocket {
            override fun request(): Request = request
            override fun queueSize(): Long = 0L
            override fun send(text: String): Boolean = sent.add(text)
            override fun send(bytes: ByteString): Boolean = false
            override fun close(code: Int, reason: String?): Boolean = true
            override fun cancel() = Unit
        }

        fun upgradeResponse(): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(101)
            .message("Switching Protocols")
            .build()

        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket {
            this.listener = listener
            return socket
        }
    }
}
