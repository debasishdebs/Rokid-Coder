package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.Socket
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The link agentd dials, over real loopback mutual TLS (R114): the production
 * listener and `serve()`, the real config store on in-memory prefs, and two
 * agentd-like client identities.
 */
class PhoneTlsServerTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val identity = FixturePhoneTlsIdentity()
    private val agentA = FixturePhoneTlsIdentity.agentdA()
    private val agentB = FixturePhoneTlsIdentity.agentdB()
    private val prefs = MemoryPrefs()
    private val config = AgentsConfigStore(prefs) { 0L }
    private val sessions = AgentSessionStore()
    private val events = CopyOnWriteArrayList<AgentdEvent>()
    private val server = AgentdLinkServer(
        store = sessions,
        authorizeMachine = { hello, clientCert ->
            config.authorizeMachine(hello.machineId, hello.token, hello.machineName, clientCert)
        },
        clientCertPinned = config::isClientCertPinned,
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
        // The wearer opened the door for this computer (R121).
        config.armLinkWindow()
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                // agentd's dial: chain validation off, its pinned set is the identity check.
                assertEquals(
                    FixturePhoneTlsIdentity.FINGERPRINT,
                    CertPins.fingerprint256(agentd.socket.session.peerCertificates.first().encoded),
                )
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
                awaitCondition { events.isNotEmpty() }
                assertTrue((events.single() as AgentdEvent.LinkUp).secure)
                assertTrue(server.linkSecure.value)

                // Over mutual TLS the phone may steer: the same newline-framed JSON, now encrypted.
                val revoke = AgentdProtocolCodec.modeRevokeAll(UUID.randomUUID().toString())
                assertEquals(AgentdWire.Result.Sent, server.write(revoke))
                assertEquals(JSONObject(revoke).toString(), agentd.reader.readLine())
            }
            awaitCondition { !server.linkSecure.value }
        }
    }

    @Test
    fun plaintext_dial_into_the_tls_server_gets_no_hello_ack() {
        listen { listener ->
            Socket(InetAddress.getLoopbackAddress(), listener.localPort).use { plain ->
                plain.getOutputStream().write((HELLO + "\n").toByteArray(Charsets.UTF_8))
                plain.getOutputStream().flush()
                val reply = runCatching { plain.getInputStream().readBytes() }.getOrDefault(ByteArray(0))
                assertFalse(String(reply, Charsets.ISO_8859_1).contains("hello_ack"))
            }
            awaitServed()
            assertTrue(events.isEmpty())
        }
    }

    @Test
    fun inbound_requires_client_cert() {
        listen { listener ->
            // TLS, but no certificate: the phone ends the handshake, so no hello is ever read.
            runCatching {
                dial(listener, client = null).use { agentd ->
                    agentd.hello()
                    assertNull(agentd.next())
                }
            }
            awaitServed()
            assertTrue(events.isEmpty())
            assertFalse(prefs.map.keys.any { it.startsWith("machine.") })
        }
    }

    @Test
    fun first_machine_without_window_refused() {
        // No computer is trusted yet, and the wearer has not opened the door: no first-use trust (R121).
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                val reply = agentd.next()
                assertEquals("hello_reject", reply?.getString("type"))
                assertEquals(AgentdProtocolCodec.REJECT_UNKNOWN_MACHINE, reply?.getString("reason"))
            }
            awaitServed()
            assertTrue(events.filterIsInstance<AgentdEvent.LinkUp>().isEmpty())
            assertFalse(server.linkSecure.value)
            assertFalse(prefs.map.keys.any { it.startsWith("machine.") })
        }
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, config.authorizeMachine("pc-9", "t", "Other", agentB.fingerprint))
    }

    @Test
    fun first_machine_inside_window_trusted() {
        config.armLinkWindow()
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
            awaitServed()
            assertEquals(agentA.fingerprint, prefs.map["machine.cert.pc-1"])
            assertTrue((events.first() as AgentdEvent.LinkUp).secure)
        }
        // The window closes with the trust it allowed: the next stranger needs the door again.
        assertFalse(config.isLinkWindowOpen())
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, config.authorizeMachine("pc-2", "t", "Laptop", agentB.fingerprint))
    }

    @Test
    fun inbound_pins_client_cert_on_first_trust() {
        // The wearer opened the door for this computer (R121).
        config.armLinkWindow()
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
            awaitServed()
            assertEquals(agentA.fingerprint, prefs.map["machine.cert.pc-1"])
            assertTrue((events.first() as AgentdEvent.LinkUp).secure)

            // The same computer again: the same pin, a secure link again.
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
            awaitServed(connections = 2)
            assertEquals(listOf(true, true), events.filterIsInstance<AgentdEvent.LinkUp>().map { it.secure })
        }
    }

    @Test
    fun inbound_pins_a_machine_trusted_before_pins_existed() {
        config.trustMachine("pc-1", "secret", "Desk")
        assertNull(prefs.map["machine.cert.pc-1"])
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
            awaitServed()
            assertEquals(agentA.fingerprint, prefs.map["machine.cert.pc-1"])
            assertTrue((events.first() as AgentdEvent.LinkUp).secure)
        }
    }

    @Test
    fun inbound_mismatched_client_cert_refused_before_hello_ack() {
        // The wearer opened the door for this computer (R121).
        config.armLinkWindow()
        listen { listener ->
            dial(listener, agentA).use { agentd ->
                agentd.hello()
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
            // The first link is fully over, so the refusal below is what the screen shows.
            awaitServed()
            assertEquals(2, events.size)

            dial(listener, agentB).use { other ->
                other.hello()
                val first = other.next()
                assertEquals("hello_reject", first?.getString("type"))
                assertEquals(AgentdProtocolCodec.REJECT_BAD_TOKEN, first?.getString("reason"))
                assertNull(other.next())
            }
            awaitServed(connections = 2)
            assertEquals(2, events.size)
            assertEquals(agentA.fingerprint, prefs.map["machine.cert.pc-1"])
            val state = sessions.connections.value.getValue(AgentProvider.CLAUDE)
            assertEquals(ConnectionState.AUTH_FAILED, state.state)
            assertEquals("Computer's certificate changed — re-pair", state.detail)
        }
    }

    @Test
    fun replayed_token_with_other_cert_never_secure() {
        // The wearer opened the door for this computer (R121).
        config.armLinkWindow()
        listen { listener ->
            dial(listener, agentA).use { live ->
                live.hello()
                assertEquals("hello_ack", live.next()?.getString("type"))
                awaitCondition { server.linkSecure.value }

                // The right machineId and token, sniffed, from another key: refused, and the live link stands.
                dial(listener, agentB).use { replay ->
                    replay.hello()
                    assertEquals("hello_reject", replay.next()?.getString("type"))
                }
                awaitCondition { served.size == 2 }
                served[1].join(5_000)
                assertTrue(server.linkSecure.value)
                assertEquals(1, events.filterIsInstance<AgentdEvent.LinkUp>().size)
                assertNotEquals(agentB.fingerprint, prefs.map["machine.cert.pc-1"])
            }
        }
    }

    @Test
    fun forget_machine_clears_client_pin() {
        config.armLinkWindow()
        assertEquals(MachineTrustResult.NEWLY_TRUSTED, config.authorizeMachine("pc-1", "secret", "Desk", agentA.fingerprint))
        assertTrue(config.isClientCertPinned("pc-1", agentA.fingerprint))
        config.forgetMachine("pc-1")
        assertNull(prefs.map["machine.cert.pc-1"])
        assertFalse(config.isClientCertPinned("pc-1", agentA.fingerprint))

        // Linked again inside the window, the pin is the new cert's.
        config.armLinkWindow()
        config.authorizeMachine("pc-2", "other", "Laptop", agentA.fingerprint)
        config.armLinkWindow()
        assertEquals(MachineTrustResult.NEWLY_TRUSTED, config.authorizeMachine("pc-1", "secret", "Desk", agentB.fingerprint))
        assertTrue(config.isClientCertPinned("pc-1", agentB.fingerprint))

        config.forgetMachines()
        assertFalse(prefs.map.keys.any { it.startsWith("machine.cert.") })
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

    // ------------------------------------------------------------ harness

    private val served = CopyOnWriteArrayList<Thread>()

    /** The production listener; every accepted connection is served on its own thread. */
    private fun listen(block: (SSLServerSocket) -> Unit) {
        tlsServerSocket(identity, 0).use { listener ->
            val acceptor = thread(isDaemon = true) {
                while (true) {
                    val socket = runCatching { listener.accept() }.getOrNull() ?: break
                    served += thread { server.serve(LinkConnection(socket)) }
                }
            }
            block(listener)
            listener.close()
            acceptor.join(5_000)
        }
    }

    private fun awaitServed(connections: Int = 1) {
        awaitCondition { served.size >= connections }
        served.take(connections).forEach { it.join(5_000) }
    }

    private class Agentd(val socket: SSLSocket) : AutoCloseable {
        val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))

        fun hello() {
            socket.outputStream.write((HELLO + "\n").toByteArray(Charsets.UTF_8))
            socket.outputStream.flush()
        }

        /** The next line, or null once the phone has closed the link. */
        fun next(): JSONObject? = runCatching { reader.readLine() }.getOrNull()?.let(::JSONObject)

        override fun close() = socket.close()
    }

    /** Dials like agentd: trusts any server cert, presents [client] when it has one. */
    private fun dial(listener: SSLServerSocket, client: Pkcs12Fixture?): Agentd {
        val keyManagers = client?.let {
            val store = KeyStore.getInstance("PKCS12").apply {
                load(null)
                setKeyEntry("agentd", it.key, PASSWORD, arrayOf(it.certificate))
            }
            KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
                .apply { init(store, PASSWORD) }
                .keyManagers
        }
        val context = SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(acceptAny), null) }
        val socket = context.socketFactory.createSocket(InetAddress.getLoopbackAddress(), listener.localPort) as SSLSocket
        socket.soTimeout = 5_000
        socket.startHandshake()
        return Agentd(socket)
    }

    private val acceptAny = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
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
        val PASSWORD = "fixture".toCharArray()
    }
}
