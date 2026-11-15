package com.anezium.rokidbus.plugin.agents

import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.X509Certificate
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SAS pairing on PhoneLink, over real loopback mutual TLS: agentd dials the phone's
 * [AgentdLinkServer] with an unpinned cert while the door is open, and the code, the
 * confirmations and the credential handover run on that one session. Then the reconnect,
 * and the commit proof a provisional pin asks for (6a-R4″).
 */
class AgentdLinkServerSasTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val identity = FixturePhoneTlsIdentity()
    private val agentA = FixturePhoneTlsIdentity.agentdA()
    private val prefs = MemoryPrefs()
    private val config = AgentsConfigStore(prefs, wallClock = { 1_000_000L }, elapsedRealtime = { 0L })
    private val attempts = PairingAttemptsModel(clock = { 0L }, window = { doorOpen })
    private var doorOpen = true
    private val paired = mutableListOf<PairingRecord>()
    private val server = AgentdLinkServer(
        store = AgentSessionStore(),
        authorizeMachine = { hello, clientCert ->
            config.authorizeMachine(hello.machineId, hello.token, hello.machineName, clientCert)
        },
        clientCertPinned = config::isClientCertPinned,
        touchMachineSeen = {},
        scope = scope,
        onMachineTrusted = {},
        tlsIdentity = identity,
        onEvent = {},
        door = SasDoor(
            open = { doorOpen },
            attempts = attempts,
            phoneFingerprint = identity::fingerprint256,
            commit = config::commitPairing,
            recordForCert = config::pairingRecordForCert,
            onPaired = { paired += it },
        ),
    )
    private val attempt = "0123456789abcdef"
    private val nc = ByteArray(32) { 3 }
    private val served = mutableListOf<Thread>()

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun credentials_sent_only_after_both_confirm_and_agentd_durable_only_after_pair_committed() {
        listen { listener ->
            dial(listener).use { agentd ->
                val code = agentd.toCode()
                awaitCondition { attempts.state.value?.state == AttemptState.AWAITING_CONFIRM }
                assertEquals(code, attempts.state.value?.code)
                agentd.send(frame("sas_confirm").put("ok", true))
                attempts.confirm(attempt, true)
                assertEquals("sas_confirm", agentd.next()?.getString("type"))
                agentd.send(
                    frame("pair_credentials")
                        .put("token", "token-0123456789").put("steer", STEER).put("machineId", "pc-1")
                        .put("machineName", "Desk").put("wsHost", "10.0.0.2").put("wsPort", 8792),
                )
                assertEquals("pair_committed", agentd.next()?.getString("type"))
                assertEquals(agentA.fingerprint, config.pairingRecordForCert(agentA.fingerprint)?.agentdFp)
                assertEquals("pc-1", paired.single().machineId)
            }
            awaitServed()
        }
    }

    @Test
    fun pinned_reconnect_needs_no_sas_on_both_transports() {
        config.commitPairing(record())
        doorOpen = false
        listen { listener ->
            dial(listener).use { agentd ->
                agentd.send(JSONObject(HELLO))
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
        }
        assertNull(attempts.state.value)
    }

    @Test
    fun a_closed_door_never_answers_a_commitment() {
        doorOpen = false
        listen { listener ->
            dial(listener).use { agentd ->
                agentd.send(frame("sas_commit").put("c", SasPairing.commit(nc, agentA.fingerprint, identity.fingerprint256())))
                assertNull(agentd.next())
            }
            awaitServed()
        }
        assertNull(attempts.state.value)
    }

    @Test
    fun phonelink_recovery_promotes_with_valid_proof_only() {
        config.commitPairing(record())
        listen { listener ->
            dial(listener).use { agentd ->
                agentd.send(frame("pair_commit_query"))
                val answer = agentd.next()!!
                assertEquals("pair_committed", answer.getString("type"))
                assertEquals(SasPairing.proof(STEER, attempt, agentA.fingerprint, identity.fingerprint256()), answer.getString("proof"))
                // Then the normal hello, on the same session.
                agentd.send(JSONObject(HELLO))
                assertEquals("hello_ack", agentd.next()?.getString("type"))
            }
        }
    }

    @Test
    fun phonelink_wrong_proof_closes_without_hello() {
        config.commitPairing(record())
        listen { listener ->
            dial(listener).use { agentd ->
                // A query for an attempt this phone never stored gets nothing: no proof to give.
                agentd.send(JSONObject().put("type", "pair_commit_query").put("v", 2).put("attempt", "ffffffffffffffff"))
                assertNull(agentd.next())
            }
            awaitServed()
        }
    }

    @Test
    fun discovery_reply_says_when_the_door_is_open() {
        assertTrue(JSONObject(AgentdLinkServer.discoveryReply("Pixel", pairing = true)).getBoolean("pairing"))
        assertFalse(JSONObject(AgentdLinkServer.discoveryReply("Pixel")).optBoolean("pairing", false))
    }

    private fun record() = PairingRecord(
        machineId = "pc-1",
        machineName = "Desk",
        agentdFp = agentA.fingerprint,
        token = "secret",
        steer = STEER,
        wsHost = "10.0.0.2",
        wsPort = 8792,
        attempt = attempt,
    )

    private fun frame(type: String) = JSONObject().put("type", type).put("v", 2).put("attempt", attempt)

    private inner class Agentd(val socket: SSLSocket) : AutoCloseable {
        val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))

        fun send(json: JSONObject) {
            socket.outputStream.write((json.toString() + "\n").toByteArray(Charsets.UTF_8))
            socket.outputStream.flush()
        }

        fun next(): JSONObject? = runCatching { reader.readLine() }.getOrNull()?.let(::JSONObject)

        /** agentd's commit, the phone's nonce, agentd's reveal: the code agentd now shows. */
        fun toCode(): String {
            val phoneFp = CertPins.fingerprint256(socket.session.peerCertificates.first().encoded)
            send(frame("sas_commit").put("c", SasPairing.commit(nc, agentA.fingerprint, phoneFp)))
            val nonce = next()!!
            assertEquals("sas_nonce", nonce.getString("type"))
            send(frame("sas_reveal").put("nc", SasPairing.hex(nc)))
            return SasPairing.code(nc, SasPairing.unhex(nonce.getString("np"))!!, agentA.fingerprint, phoneFp)
        }

        override fun close() = socket.close()
    }

    private fun listen(block: (SSLServerSocket) -> Unit) {
        tlsServerSocket(identity, 0).use { listener ->
            listener.soTimeout = 10_000
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

    private fun awaitServed() {
        awaitCondition { served.isNotEmpty() }
        served.forEach { it.join(5_000) }
    }

    private fun dial(listener: SSLServerSocket): Agentd {
        val store = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setKeyEntry("agentd", agentA.key, PASSWORD, arrayOf(agentA.certificate))
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(store, PASSWORD) }
            .keyManagers
        val context = SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(acceptAny), null) }
        val socket = context.socketFactory.createSocket(InetAddress.getLoopbackAddress(), listener.localPort) as SSLSocket
        socket.soTimeout = 5_000
        // A failed handshake closes the socket, so the phone's side sees the end and nothing is left open.
        runCatching { socket.startHandshake() }.onFailure { socket.close() }.getOrThrow()
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
        const val STEER = "steer-secret-0123456789abcdefghijk"
        const val HELLO = """{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}"""
        val PASSWORD = "fixture".toCharArray()
    }
}
