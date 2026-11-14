package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.Socket
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneTlsServerTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val identity = FixturePhoneTlsIdentity()
    private val events = CopyOnWriteArrayList<AgentdEvent>()
    private val server = AgentdLinkServer(
        store = AgentSessionStore(),
        authorizeMachine = { MachineTrustResult.TRUSTED },
        touchMachineSeen = {},
        scope = scope,
        onMachineTrusted = {},
        tlsIdentity = identity,
        onEvent = { events += it },
    )

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun tls_server_accepts_tls_client_and_line_protocol_unchanged() {
        tlsServerSocket(identity, 0).use { listener ->
            val serving = thread { server.serve(LinkConnection(listener.accept())) }
            // agentd's dial: chain validation off, the pinned set is its identity check.
            val dialer = agentdContext().socketFactory
                .createSocket(InetAddress.getLoopbackAddress(), listener.localPort) as SSLSocket
            dialer.use { socket ->
                socket.startHandshake()
                assertEquals(
                    FixturePhoneTlsIdentity.FINGERPRINT,
                    CertPins.fingerprint256(socket.session.peerCertificates.first().encoded),
                )
                val fromPhone = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
                socket.outputStream.write((HELLO + "\n").toByteArray(Charsets.UTF_8))
                socket.outputStream.flush()
                assertEquals("hello_ack", JSONObject(fromPhone.readLine()).getString("type"))
                awaitCondition { events.isNotEmpty() }
                assertTrue((events.single() as AgentdEvent.LinkUp).secure)
                assertTrue(server.linkSecure.value)

                // Over TLS the phone may steer: the same newline-framed JSON, now encrypted.
                val revoke = AgentdProtocolCodec.modeRevokeAll(UUID.randomUUID().toString())
                assertEquals(AgentdWire.Result.Sent, server.write(revoke))
                assertEquals(JSONObject(revoke).toString(), fromPhone.readLine())
            }
            serving.join(5_000)
            assertFalse(serving.isAlive)
            assertFalse(server.linkSecure.value)
        }
    }

    @Test
    fun plaintext_dial_into_the_tls_server_gets_no_hello_ack() {
        tlsServerSocket(identity, 0).use { listener ->
            val serving = thread { server.serve(LinkConnection(listener.accept())) }
            Socket(InetAddress.getLoopbackAddress(), listener.localPort).use { plain ->
                plain.getOutputStream().write((HELLO + "\n").toByteArray(Charsets.UTF_8))
                plain.getOutputStream().flush()
                val reply = runCatching { plain.getInputStream().readBytes() }.getOrDefault(ByteArray(0))
                assertFalse(String(reply, Charsets.ISO_8859_1).contains("hello_ack"))
            }
            serving.join(5_000)
            assertFalse(serving.isAlive)
            assertTrue(events.isEmpty())
        }
    }

    @Test
    fun discovery_reply_has_tls_true() {
        val reply = JSONObject(AgentdLinkServer.discoveryReply("Pixel"))
        assertEquals("agents-phone", reply.getString("nexus"))
        assertEquals(1, reply.getInt("v"))
        assertEquals(AgentdLinkServer.LINK_PORT, reply.getInt("port"))
        assertEquals("Pixel", reply.getString("name"))
        assertEquals(true, reply.get("tls"))
    }

    private fun agentdContext(): SSLContext = SSLContext.getInstance("TLS").apply {
        val acceptAny = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        init(null, arrayOf(acceptAny), null)
    }

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(5)
        }
    }

    private companion object {
        const val HELLO = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
    }
}
