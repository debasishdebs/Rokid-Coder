package com.anezium.rokidbus.plugin.agents.connectors

import android.app.Application
import android.content.Intent
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.plugin.agents.AgentSessionStore
import com.anezium.rokidbus.plugin.agents.AgentdClient
import com.anezium.rokidbus.plugin.agents.AgentdConfig
import com.anezium.rokidbus.plugin.agents.AgentdLinkServer
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.FakeGlassesSurface
import com.anezium.rokidbus.plugin.agents.FixturePhoneTlsIdentity
import com.anezium.rokidbus.plugin.agents.GuidedPairing
import com.anezium.rokidbus.plugin.agents.LinkConnection
import com.anezium.rokidbus.plugin.agents.LinkKey
import com.anezium.rokidbus.plugin.agents.LinkTransport
import com.anezium.rokidbus.plugin.agents.MachineTrustResult
import com.anezium.rokidbus.plugin.agents.SecureLink
import com.anezium.rokidbus.plugin.agents.service.CoderCore
import com.anezium.rokidbus.plugin.agents.service.CoderRuntime
import com.anezium.rokidbus.plugin.agents.service.CoderService
import com.anezium.rokidbus.plugin.agents.service.ForegroundStarter
import com.anezium.rokidbus.plugin.agents.tlsServerSocket
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.security.KeyStore
import java.security.cert.X509Certificate
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The Tailscale connector (U38, §13.2) and the secure-link state it reads. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class TailscaleConnectorTest {
    private val app: Application = RuntimeEnvironment.getApplication()
    private val lan = LinkKey(LinkTransport.INBOUND, 1L)
    private val tailnet = LinkKey(LinkTransport.OUTBOUND, 2L)

    @Before
    fun setUp() = AgentsRuntime.clearSecureLinks()

    @After
    fun tearDown() {
        AgentsRuntime.clearSecureLinks()
        CoderService.resetSeams()
        CoderRuntime.reset()
    }

    @Test
    fun active_secure_links_track_open_links() {
        AgentsRuntime.announceSecureConnection(lan, "desk", "Desk", "192.168.1.20")
        AgentsRuntime.announceSecureConnection(tailnet, "dialled:laptop", "Laptop", "100.101.102.103")
        // A late subscriber reads the current links.
        assertEquals(setOf(lan, tailnet), AgentsRuntime.activeSecureLinks.value.keys)
        assertEquals(SecureLink("desk", "Desk", "192.168.1.20"), AgentsRuntime.activeSecureLinks.value[lan])

        AgentsRuntime.announceSecureLinkClosed(lan)
        assertEquals(setOf(tailnet), AgentsRuntime.activeSecureLinks.value.keys)
        val again = LinkKey(LinkTransport.INBOUND, 3L)
        AgentsRuntime.announceSecureConnection(again, "desk", "Desk", "192.168.1.20")
        assertEquals(setOf(tailnet, again), AgentsRuntime.activeSecureLinks.value.keys)
        AgentsRuntime.announceSecureLinkClosed(lan)
        assertEquals("a stale close changes nothing", setOf(tailnet, again), AgentsRuntime.activeSecureLinks.value.keys)

        // Stop clears them.
        CoderService.processStarted = { true }
        CoderService.starterFactory = { ForegroundStarter { _, _, _ -> } }
        CoderService.coreFactory = { _, _ ->
            object : CoderCore {
                override val surface: GlassesSurface = FakeGlassesSurface()
                override fun start() = Unit
                override fun close() = Unit
            }
        }
        val service = Robolectric.buildService(CoderService::class.java, Intent().setAction("com.anezium.rokidbus.plugin.agents.action.START_FROM_FOREGROUND")).create().startCommand(0, 1).get()
        assertEquals(2, AgentsRuntime.activeSecureLinks.value.size)
        service.onStartCommand(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_STOP), 0, 2)
        assertTrue(AgentsRuntime.activeSecureLinks.value.isEmpty())
    }

    private class FakeConnection(val listener: WebSocketListener, val request: Request) {
        val socket = object : WebSocket {
            override fun request(): Request = request
            override fun queueSize(): Long = 0L
            override fun send(text: String): Boolean = true
            override fun send(bytes: ByteString): Boolean = false
            override fun close(code: Int, reason: String?): Boolean = true
            override fun cancel() = Unit
        }

        fun open() = listener.onOpen(
            socket,
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(101).message("Switching Protocols").build(),
        )

        fun ack() = listener.onMessage(socket, """{"type":"hello_ack","v":1,"steering":true,"server":{"machineName":"Laptop"}}""")

        fun close() {
            listener.onClosing(socket, 1000, "")
            listener.onClosed(socket, 1000, "")
        }
    }

    private class FakeWebSocketClient : OkHttpClient() {
        val connections = CopyOnWriteArrayList<FakeConnection>()
        override fun newWebSocket(request: Request, listener: WebSocketListener): WebSocket =
            FakeConnection(listener, request).also(connections::add).socket
    }

    @Test
    fun the_outbound_transport_announces_each_secure_link_and_its_close() {
        val test = TestScope()
        val pinned = FakeWebSocketClient()
        val client = AgentdClient(
            OkHttpClient(), AgentSessionStore(), test, "test", FixturePhoneTlsIdentity(),
            pinnedClient = { pinned },
            onSecureConnected = AgentsRuntime::announceSecureConnection,
            onSecureLinkClosed = AgentsRuntime::announceSecureLinkClosed,
        ) {}
        val config = AgentdConfig(host = "100.101.102.103", port = 8792, token = "tok", name = "Laptop", fp = FixturePhoneTlsIdentity.FINGERPRINT, steer = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123")
        client.start(config)
        test.testScheduler.runCurrent()
        pinned.connections.last().apply { open(); ack() }
        val first = AgentsRuntime.activeSecureLinks.value.entries.single()
        assertEquals(LinkTransport.OUTBOUND, first.key.transport)
        assertEquals(SecureLink(GuidedPairing.dialledId(FixturePhoneTlsIdentity.FINGERPRINT), "Laptop", "100.101.102.103"), first.value)

        pinned.connections.last().close()
        test.testScheduler.runCurrent()
        assertTrue("a disconnect removes its entry", AgentsRuntime.activeSecureLinks.value.isEmpty())

        test.testScheduler.advanceTimeBy(60_000L)
        test.testScheduler.runCurrent()
        pinned.connections.last().apply { open(); ack() }
        val second = AgentsRuntime.activeSecureLinks.value.keys.single()
        assertTrue("a reconnect is a new link", second != first.key)
        client.stop(clearSessions = true)
        test.testScheduler.runCurrent()
        assertTrue(AgentsRuntime.activeSecureLinks.value.isEmpty())
    }

    @Test
    fun the_inbound_transport_announces_each_secure_link_and_its_close() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        tlsServerSocket(FixturePhoneTlsIdentity(), 0).use { listener ->
            val server = AgentdLinkServer(
                store = AgentSessionStore(),
                authorizeMachine = { _, _ -> MachineTrustResult.TRUSTED },
                clientCertPinned = { _, _ -> true },
                touchMachineSeen = {},
                scope = scope,
                onMachineTrusted = {},
                tlsIdentity = FixturePhoneTlsIdentity(),
                onSecureConnected = AgentsRuntime::announceSecureConnection,
                onSecureLinkClosed = AgentsRuntime::announceSecureLinkClosed,
                onEvent = {},
            )
            val dialer = agentdContext().socketFactory.createSocket(InetAddress.getLoopbackAddress(), listener.localPort)
            val connection = LinkConnection(listener.accept())
            val serving = thread { server.serve(connection) }
            val fromPhone = BufferedReader(InputStreamReader(dialer.getInputStream(), Charsets.UTF_8))
            dialer.getOutputStream().apply {
                write("""{"type":"hello","v":1,"machineId":"pc-1","machineName":"Desk","token":"secret"}""".toByteArray() + '\n'.code.toByte())
                flush()
            }
            assertEquals("hello_ack", JSONObject(fromPhone.readLine()).getString("type"))
            awaitCondition { AgentsRuntime.activeSecureLinks.value.isNotEmpty() }
            val (key, link) = AgentsRuntime.activeSecureLinks.value.entries.single().toPair()
            assertEquals(LinkTransport.INBOUND, key.transport)
            assertEquals(SecureLink("pc-1", "Desk", "127.0.0.1"), link)

            dialer.close()
            serving.join(5_000)
            assertTrue("the end of the connection removes it", AgentsRuntime.activeSecureLinks.value.isEmpty())
        }
        scope.cancel()
    }

    private fun awaitCondition(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition()) {
            check(System.currentTimeMillis() < deadline) { "timed out" }
            Thread.sleep(5)
        }
    }

    /** agentd's side of the inbound link: its fixture client cert, and any phone cert. */
    private fun agentdContext(): SSLContext {
        val agentd = FixturePhoneTlsIdentity.agentdA()
        val password = "fixture".toCharArray()
        val keys = KeyStore.getInstance("PKCS12").apply {
            load(null)
            setKeyEntry("agentd", agentd.key, password, arrayOf(agentd.certificate))
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(keys, password) }.keyManagers
        val anyServer = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return SSLContext.getInstance("TLS").apply { init(keyManagers, arrayOf(anyServer), null) }
    }

    @Test
    fun tailscale_status_never_claims_connected_without_a_tailnet_link() {
        assertEquals("Not installed", tailscaleStatus(installed = false, links = emptyMap()).text)
        assertEquals("Installed — open Tailscale to check it's connected", tailscaleStatus(true, emptyMap()).text)
        assertEquals(
            "Installed — open Tailscale to check it's connected",
            tailscaleStatus(true, mapOf(lan to SecureLink("desk", "Desk", "192.168.1.20"))).text,
        )
        assertEquals("Connected", tailscaleStatus(true, mapOf(tailnet to SecureLink("l", "Laptop", "100.64.0.1"))).text)
        assertEquals("Connected", tailscaleStatus(true, mapOf(tailnet to SecureLink("l", "Laptop", "fd7a:115c:a1e0::53"))).text)
        assertEquals("Connected", tailscaleStatus(true, mapOf(tailnet to SecureLink("l", "Laptop", "100.127.255.254"))).text)
        assertFalse(isTailnetAddress("100.128.0.1"))
        assertFalse(isTailnetAddress("100.63.255.255"))
        assertFalse(isTailnetAddress("fd7a:115c:a1e1::1"))
        assertFalse(isTailnetAddress(null))
        assertFalse(isTailnetAddress("laptop.tail-scale.ts.net"))

        // A tailnet link that closed is not a connection.
        AgentsRuntime.announceSecureConnection(tailnet, "l", "Laptop", "100.100.1.1")
        assertEquals("Connected", tailscaleStatus(true, AgentsRuntime.activeSecureLinks.value).text)
        AgentsRuntime.announceSecureLinkClosed(tailnet)
        assertEquals("Installed — open Tailscale to check it's connected", tailscaleStatus(true, AgentsRuntime.activeSecureLinks.value).text)
        assertEquals("Not installed", tailscaleStatus(false, AgentsRuntime.activeSecureLinks.value).text)

        assertEquals(listOf("Get Tailscale", "Sign in with the same account on your computer"), TailscaleConnector.STEPS)
        assertEquals("market://details?id=com.tailscale.ipn", TailscaleConnector.MARKET_URL)
        assertEquals("https://play.google.com/store/apps/details?id=com.tailscale.ipn", TailscaleConnector.WEB_URL)
    }
}
