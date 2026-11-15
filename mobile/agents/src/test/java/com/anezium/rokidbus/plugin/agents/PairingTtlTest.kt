package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusRowTone
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.X509Certificate
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The usage-based pairing TTL (U7), on fake time: nothing here sleeps for a day, or an hour. */
class PairingTtlTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val prefs = MemoryPrefs()
    private var now = T0
    private val store = AgentsConfigStore(prefs, wallClock = { now }) { 0L }
    private val identity = FixturePhoneTlsIdentity()

    @After
    fun tearDown() {
        scope.cancel()
    }

    private fun days(n: Long) = n * DAY
    private fun advance(ms: Long) {
        now += ms
    }

    private val pairing = AgentdConfig(
        host = "100.1.2.3", port = 8792, token = "tok", name = "Desk", fp = FixturePhoneTlsIdentity.FINGERPRINT, steer = STEER,
    )

    // ------------------------------------------------------------------ the store

    @Test
    fun outbound_slot_unused_past_ttl_is_signed_out_keeps_host_and_name() {
        store.saveAgentd(pairing, enabled = true)
        assertEquals(now, prefs.map["agentd.last_used_at"])

        advance(days(14) - 1)
        assertTrue(store.expireUnused(now).isEmpty())
        assertEquals(pairing, store.load().agentd)

        advance(2)
        val out = store.expireUnused(now)

        assertEquals(listOf(SignedOut("Desk", now, 14)), out)
        assertNull(store.load().agentd)
        // The secrets go; the host and name stay for the re-pair hint.
        assertEquals("100.1.2.3", prefs.map["agentd.host"])
        assertEquals("Desk", prefs.map["agentd.name"])
        listOf("agentd.token", "agentd.fp", "agentd.steer", "agentd.last_used_at").forEach { assertFalse(it, it in prefs.map) }
        assertEquals(now, prefs.map["signed_out.Desk"])
        assertEquals(out, store.signedOut())
        // Monitoring stays as the wearer set it, so the phone goes back to listening.
        assertTrue(store.load().agentdEnabled)
        // Nothing left to sign out.
        assertTrue(store.expireUnused(now).isEmpty())
    }

    @Test
    fun inbound_machine_unused_past_ttl_is_forgotten() {
        store.trustMachine("pc-1", "secret", "Desk")
        store.trustMachine("pc-2", "other", "Laptop")
        advance(days(10))
        store.touchMachineSeen("pc-2")
        advance(days(5))

        val out = store.expireUnused(now)

        assertEquals(listOf(SignedOut("Desk", now, 15)), out)
        assertEquals(listOf("pc-2"), store.trustedMachines().map { it.machineId })
        assertFalse(prefs.map.keys.any { it.endsWith("pc-1") })
        assertEquals(out, store.signedOut())
    }

    @Test
    fun ttl_follows_the_setting_and_defaults_to_14() {
        assertEquals(14, store.pairingTtlDays())
        store.trustMachine("pc-1", "secret", "Desk")
        store.setPairingTtlDays(3)
        advance(days(3) + 1)

        assertEquals(listOf("Desk"), store.expireUnused(now).map { it.name })
    }

    @Test
    fun pairings_without_timestamps_migrate_to_now_once() {
        // What an install from before this change holds: pairings, no timestamps.
        prefs.map["agentd.host"] = "100.1.2.3"
        prefs.map["agentd.port"] = 8792
        prefs.map["agentd.token"] = "tok"
        prefs.map["agentd.name"] = "Desk"
        prefs.map["machine.token.pc-1"] = "secret"
        prefs.map["machine.name.pc-1"] = "Laptop"

        assertTrue(store.expireUnused(now).isEmpty())

        assertEquals(now, prefs.map["agentd.last_used_at"])
        assertEquals(now, prefs.map["machine.seen.pc-1"])
        assertEquals(true, prefs.map["security.ttl_migrated"])
        assertEquals("Desk", store.load().agentd?.name)

        // Once: a pairing that turns up without a timestamp later is not given one again.
        advance(days(1))
        prefs.map["machine.token.pc-2"] = "late"
        assertEquals(listOf("pc-2"), store.expireUnused(now).map { it.name })
        assertEquals(now - days(1), prefs.map["agentd.last_used_at"])
    }

    @Test
    fun future_last_used_is_clamped_on_phone() {
        prefs.map["security.ttl_migrated"] = true
        prefs.map["agentd.host"] = "100.1.2.3"
        prefs.map["agentd.token"] = "tok"
        prefs.map["agentd.name"] = "Desk"
        prefs.map["agentd.last_used_at"] = now + days(200)
        prefs.map["machine.token.pc-1"] = "secret"
        prefs.map["machine.name.pc-1"] = "Laptop"
        prefs.map["machine.seen.pc-1"] = now + days(200)

        // Not a reason to sign out ...
        assertTrue(store.expireUnused(now).isEmpty())
        // ... and clamped to now, so it does not hold the pairing open for 200 days either.
        assertEquals(now, prefs.map["agentd.last_used_at"])
        assertEquals(now, prefs.map["machine.seen.pc-1"])
        advance(days(15))
        assertEquals(listOf("Desk", "Laptop"), store.expireUnused(now).map { it.name }.sorted())
    }

    @Test
    fun ttl_is_synced_in_settings_sync() {
        assertEquals(listOf(3, 7, 14, 30, 90), PAIRING_TTL_CHOICES)
        assertEquals(14, JSONObject(AlertSettings().syncFrames(store.pairingTtlDays()).first()).getInt("pairingTtlDays"))

        store.setPairingTtlDays(30)
        store.setPairingTtlDays(5)

        assertEquals(30, store.pairingTtlDays())
        assertEquals("settings_sync", JSONObject(AlertSettings().syncFrames(store.pairingTtlDays()).first()).getString("type"))
        assertEquals(30, JSONObject(AlertSettings().syncFrames(store.pairingTtlDays()).first()).getInt("pairingTtlDays"))
        assertEquals(30, prefs.map["security.pairing_ttl_days"])
    }

    @Test
    fun adding_the_computer_again_clears_the_signed_out_line_and_the_switch_keeps_it() {
        store.saveAgentd(pairing, enabled = true)
        advance(days(15))
        store.expireUnused(now)

        // The Monitoring switch is not a re-pair: the hint survives it.
        store.setAgentdEnabled(false)
        assertEquals(listOf("Desk"), store.signedOut().map { it.name })
        assertEquals("100.1.2.3", prefs.map["agentd.host"])

        assertTrue(store.saveAgentd(pairing, enabled = true))
        assertTrue(store.signedOut().isEmpty())
        assertEquals(pairing, store.load().agentd)
        assertEquals(now, prefs.map["agentd.last_used_at"])
    }

    // ------------------------------------------------------------------ admission

    @Test
    fun stale_computer_reconnecting_before_sweep_is_refused() {
        // Inbound: the sweep has not run, and the computer comes back with its own token.
        store.trustMachine("pc-1", "secret", "Desk")
        advance(days(15))

        assertEquals(
            MachineTrustResult.REJECTED_NOT_INVITED,
            store.authorizeMachine("pc-1", "secret", "Desk", FixturePhoneTlsIdentity.FINGERPRINT),
        )
        assertTrue(store.trustedMachines().isEmpty())
        assertFalse(prefs.map.keys.any { it.startsWith("machine.seen.") })
        assertEquals(listOf("Desk"), store.signedOut().map { it.name })

        // Outbound: the dial itself asks the store, and a stale slot is signed out and not dialled.
        store.saveAgentd(pairing, enabled = true)
        advance(days(15))
        val http = FakeWebSocketClient()
        val sessions = AgentSessionStore()
        val client = AgentdClient(
            OkHttpClient(), sessions, scope, "test", identity, pinnedClient = { http },
            dialAllowed = store::outboundAdmitted, touchUsed = store::touchAgentdUsed,
        ) {}

        client.start(pairing)

        awaitCondition { sessions.connections.value.getValue(AgentProvider.CLAUDE).state == ConnectionState.AUTH_FAILED }
        assertEquals(PairingCopy.SIGNED_OUT, sessions.connections.value.getValue(AgentProvider.CLAUDE).detail)
        assertTrue(http.connections.isEmpty())
        assertNull(store.load().agentd)
        assertEquals("100.1.2.3", prefs.map["agentd.host"])
        assertFalse("agentd.last_used_at" in prefs.map)
        assertEquals(setOf("Desk"), store.signedOut().map { it.name }.toSet())
        client.stop(clearSessions = true)
    }

    @Test
    fun stale_machine_with_window_open_is_rejected_and_window_kept() {
        store.trustMachine("pc-1", "secret", "Desk")
        advance(days(15))
        store.armLinkWindow()

        // The stale attempt is signed out and refused: it does not use up the wearer's invitation.
        assertEquals(
            MachineTrustResult.REJECTED_NOT_INVITED,
            store.authorizeMachine("pc-1", "secret", "Desk", FixturePhoneTlsIdentity.FINGERPRINT),
        )
        assertTrue(store.trustedMachines().isEmpty())
        assertEquals(listOf("Desk"), store.signedOut().map { it.name })
        assertTrue(store.isLinkWindowOpen())

        // A fresh attempt is an unknown computer, which pairs only by SAS, never by its hello.
        assertEquals(
            MachineTrustResult.REJECTED_NOT_INVITED,
            store.authorizeMachine("pc-1", "secret", "Desk", FixturePhoneTlsIdentity.FINGERPRINT),
        )
        assertTrue(store.isLinkWindowOpen())
    }

    // ------------------------------------------------------------------ live links

    @Test
    fun connected_computer_never_signs_out() {
        outboundStaysPaired()
        inboundStaysPaired()
    }

    private fun outboundStaysPaired() {
        store.saveAgentd(pairing, enabled = true)
        val http = FakeWebSocketClient()
        val sessions = AgentSessionStore()
        val client = AgentdClient(
            OkHttpClient(), sessions, scope, "test", identity, pinnedClient = { http },
            dialAllowed = store::outboundAdmitted, touchUsed = store::touchAgentdUsed,
        ) {}
        client.start(pairing)
        awaitCondition { http.connections.isNotEmpty() }
        val wss = http.connections.single()
        wss.open()
        advance(days(1))
        wss.message(HELLO_ACK_STEERING)
        awaitCondition { client.linkSecure.value }
        // A secure hello_ack is a use.
        assertEquals(now, prefs.map["agentd.last_used_at"])

        // Twenty days, one tick an hour: the touch comes first, so the sweep finds nothing.
        repeat(20 * 24) {
            advance(HOUR)
            assertTrue(runPairingTtlTick(listOf(client::touchLive)) { store.expireUnused(now) }.isEmpty())
        }
        assertEquals(pairing, store.load().agentd)

        // Down, nothing touches it any more, and the TTL runs from here.
        client.stop(clearSessions = true)
        advance(days(15))
        assertEquals(listOf("Desk"), runPairingTtlTick(listOf(client::touchLive)) { store.expireUnused(now) }.map { it.name })
    }

    private fun inboundStaysPaired() {
        prefs.map.clear()
        val sessions = AgentSessionStore()
        val agentA = FixturePhoneTlsIdentity.agentdA()
        val events = CopyOnWriteArrayList<AgentdEvent>()
        val server = AgentdLinkServer(
            store = sessions,
            authorizeMachine = { hello, cert -> store.authorizeMachine(hello.machineId, hello.token, hello.machineName, cert) },
            clientCertPinned = store::isClientCertPinned,
            touchMachineSeen = { id -> store.touchMachineSeen(id) },
            scope = scope,
            onMachineTrusted = {},
            tlsIdentity = identity,
            onEvent = { events += it },
        )
        // Paired earlier, by SAS: one record, for both transports.
        store.commitPairing(
            PairingRecord("pc-1", "Desk", agentA.fingerprint, "secret", "steer-secret-0123456789abcdefghijk", "10.0.0.2", 8792, "0123456789abcdef"),
            now,
        )
        tlsServerSocket(identity, 0).use { listener ->
            val serving = thread(isDaemon = true) {
                server.serve(LinkConnection(listener.accept()))
            }
            val agentd = dial(listener, agentA)
            agentd.send("""{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}""")
            assertEquals("hello_ack", JSONObject(agentd.reader.readLine()).getString("type"))
            awaitCondition { server.linkSecure.value }

            repeat(20 * 24) {
                advance(HOUR)
                assertTrue(runPairingTtlTick(listOf(server::touchLive)) { store.expireUnused(now) }.isEmpty())
            }
            assertEquals(listOf("pc-1"), store.trustedMachines().map { it.machineId })
            assertEquals(now, prefs.map["machine.seen.pc-1"])

            // Hung up: the disconnect is the last use, and the TTL runs from there.
            agentd.socket.close()
            serving.join(5_000)
            listener.close()
        }
        advance(days(15))
        assertEquals(listOf("Desk"), runPairingTtlTick(listOf(server::touchLive)) { store.expireUnused(now) }.map { it.name })
    }

    // ------------------------------------------------------------------ what the wearer reads

    @Test
    fun signed_out_row_on_board_and_settings() {
        store.saveAgentd(pairing, enabled = true)
        advance(days(20))
        val signedOut = store.expireUnused(now)

        val board = BoardCards.sessionsCard(
            sessions = emptyList(),
            connections = emptyMap(),
            config = store.load(),
            selectedKey = null,
            waiting = 0,
            quiet = false,
            now = now,
            signedOut = store.signedOut(),
        )
        val row = board.card.richLines.orEmpty().single { it.text == "Signed out of Desk" }
        assertEquals("pair again: Add a computer", row.sub)
        assertEquals(NexusRowTone.ALERT, row.tone)

        // Twenty days unused is what Settings says, not the limit.
        assertEquals(20, signedOut.single().unusedDays)
        assertEquals(
            "Signed out of Desk — not used for 20 days. Add it again.",
            com.anezium.rokidbus.plugin.agents.ui.SettingsCopy.signedOut("Desk", signedOut.single().unusedDays),
        )
    }

    // ------------------------------------------------------------------ harness

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
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build(),
        )

        fun message(text: String) = listener.onMessage(socket, text)
    }

    private class FakeWebSocketClient : OkHttpClient() {
        val connections = CopyOnWriteArrayList<FakeConnection>()
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeConnection(listener, request).also(connections::add).socket
    }

    private class Agentd(val socket: SSLSocket) {
        val reader = BufferedReader(InputStreamReader(socket.inputStream, Charsets.UTF_8))
        fun send(line: String) {
            socket.outputStream.write((line + "\n").toByteArray(Charsets.UTF_8))
            socket.outputStream.flush()
        }
    }

    /** Dials as agentd does: any server cert, its own client cert. */
    private fun dial(listener: SSLServerSocket, client: Pkcs12Fixture): Agentd {
        val password = "fixture".toCharArray()
        val keys = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setKeyEntry("agentd", client.key, password, arrayOf(client.certificate))
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(keys, password) }.keyManagers
        val acceptAny = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(acceptAny), null) }
        val socket = context.socketFactory.createSocket(InetAddress.getLoopbackAddress(), listener.localPort) as SSLSocket
        socket.soTimeout = 5_000
        socket.startHandshake()
        return Agentd(socket)
    }

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(5)
        }
    }

    private companion object {
        const val T0 = 1_800_000_000_000L
        const val HOUR = 60L * 60L * 1000L
        const val DAY = 24L * HOUR
        const val STEER = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123"
        const val HELLO_ACK_STEERING = """{"type":"hello_ack","v":1,"steering":true,"server":{"machineName":"Desk"}}"""
    }
}
