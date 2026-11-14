package com.anezium.rokidbus.plugin.agents

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.job
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The connection loop's generation check and its CONNECTING publish are one step under the state lock. */
class AgentdClientStopRaceTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    @After
    fun tearDown() {
        scope.cancel()
    }

    @Test
    fun stop_during_connect_never_leaves_connecting() {
        val inDial = CountDownLatch(1)
        val release = CountDownLatch(1)
        val sessions = AgentSessionStore()
        val client = AgentdClient(
            OkHttpClient(), sessions, scope, "test", FixturePhoneTlsIdentity(),
            pinnedClient = { OkHttpClient() },
            // The loop has passed its generation check and sits just before its CONNECTING publish.
            dialAllowed = {
                inDial.countDown()
                release.await(5, TimeUnit.SECONDS)
                true
            },
        ) {}
        val pairing = AgentdConfig(
            host = "100.1.2.3", port = 8792, token = "tok", name = "Desk",
            fp = FixturePhoneTlsIdentity.FINGERPRINT, steer = "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJ-0123",
        )

        client.start(pairing)
        assertTrue(inDial.await(5, TimeUnit.SECONDS))
        client.stop(clearSessions = false)
        release.countDown()
        // The stale loop runs to its end, so whatever it would publish over the stop has landed.
        runBlocking { withTimeout(5_000) { scope.coroutineContext.job.children.toList().joinAll() } }

        assertEquals(ConnectionState.DISCONNECTED, sessions.connections.value.getValue(AgentProvider.CLAUDE).state)
    }
}
