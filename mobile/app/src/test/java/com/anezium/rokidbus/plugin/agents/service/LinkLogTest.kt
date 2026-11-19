package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.shared.LinkStateBits
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The field diagnostics: what is said under one tag, and what is kept out of it. */
@OptIn(ExperimentalCoroutinesApi::class)
class LinkLogTest {
    private val lines = mutableListOf<String>()
    private val original = LinkLog.sink
    private val bonded = LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED

    @Before
    fun capture() {
        LinkLog.sink = { lines += it }
    }

    @After
    fun restore() {
        LinkLog.sink = original
    }

    private fun TestScope.newHealer(core: FakeLinkCore, enabled: () -> Boolean = { true }) =
        GlassesLinkHealer(
            CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
            core, enabled = enabled,
        )

    @Test
    fun the_tag_is_the_one_the_user_is_told_to_filter_on() {
        assertEquals("RokidCoder-Link", LinkLog.TAG)
    }

    @Test
    fun only_the_hubs_link_lines_are_kept_not_its_traffic() {
        listOf(
            "CXR-L connected=false",
            "CXR-L session closed by Hi Rokid",
            "CXR-L ensure: link down, binding for the wearer closedByServer=true",
            "CXR-L connect requested bound=true",
            "CXR-L closed-session flag cleared by a wearer start",
            "Hi Rokid glass BT connected=false",
            "SPP authenticated",
            "SPP link closed",
        ).forEach(LinkLog::hub)
        assertEquals(8, lines.size)
        assertTrue(lines.all { it.startsWith("hub: ") })

        lines.clear()
        listOf(
            "CXR RX /plugin/agents/x id=abc",
            "CXR TX /plugin/agents/x id=abc result=0",
            "SPP RX /plugin/agents/x id=abc",
            "SPP TX /plugin/agents/x id=abc",
            "No bonded glasses device found; SPP loop waiting",
            "SPP connecting to bonded glasses",
        ).forEach(LinkLog::hub)
        assertEquals(emptyList<String>(), lines)
    }

    @Test
    fun each_background_decision_is_said_once_with_its_reason() = runTest {
        var monitoring = true
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core) { monitoring }

        healer.onLinkState(core.state)
        assertTrue(lines.toString(), "healer: link down, retries start" in lines)
        assertTrue("healer: next attempt in 10000ms" in lines)
        advanceTimeBy(10_001)
        assertTrue("healer: attempt 1 made" in lines)
        assertTrue("healer: next attempt in 20000ms" in lines)

        core.state = bonded or LinkStateBits.CXR_CONTROL_UP
        healer.onLinkState(core.state)
        assertTrue("healer: link up, retries end" in lines)

        lines.clear()
        core.state = 0
        healer.onLinkState(core.state)
        healer.onLinkState(core.state)
        healer.onLinkState(core.state)
        assertEquals("one line, not one per link state", listOf("healer: not chasing the link (glasses not bonded)"), lines)

        lines.clear()
        core.state = bonded
        core.closedByServer = true
        healer.onLinkState(core.state)
        assertEquals(listOf("healer: not chasing the link (Hi Rokid closed the session)"), lines)

        lines.clear()
        core.closedByServer = false
        monitoring = false
        healer.onMonitoringChanged()
        assertEquals(listOf("healer: not chasing the link (monitoring off)"), lines)
    }

    @Test
    fun a_wearer_bind_says_its_attempt_and_its_result() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)

        healer.ensureLink { }
        runCurrent()
        healer.ensureLink { }
        advanceTimeBy(GlassesLinkHealer.ENSURE_WAIT_MS + 1)

        assertEquals(
            listOf(
                "wearer link: down, binding (closedByServer=true)",
                "wearer link: bind result CONNECTING",
                "wearer link: joins the attempt in flight",
                "wearer link: still down after 5000ms",
            ),
            lines,
        )

        lines.clear()
        core.state = bonded or LinkStateBits.CXR_CONTROL_UP
        healer.ensureLink { }
        assertEquals(listOf("wearer link: up, reused"), lines)
    }

    @Test
    fun a_refused_wearer_bind_says_why() = runTest {
        newHealer(FakeLinkCore().apply { state = bonded }) { false }.ensureLink { }
        assertEquals(listOf("wearer link: skipped (monitoring off)"), lines)

        lines.clear()
        val stopped = newHealer(FakeLinkCore().apply { state = bonded })
        stopped.stop()
        lines.clear()
        stopped.ensureLink { }
        assertEquals(listOf("wearer link: skipped (service stopped)"), lines)
    }

    @Test
    fun a_polling_loop_stays_quiet_while_the_link_does_not_change() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        repeat(50) { healer.onLinkState(core.state) }
        assertEquals("one start line for fifty identical link states", 1, lines.count { it == "healer: link down, retries start" })
    }

    @Test
    fun nothing_that_names_a_secret_or_a_device_is_ever_said() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(60_000)
        healer.ensureLink { }
        runCurrent()
        advanceTimeBy(6_000)
        healer.stop()

        assertFalse(lines.isEmpty())
        val forbidden = listOf("token", "secret", "steer", "serial", "address", "mac", "fingerprint")
        assertTrue(lines.toString(), lines.none { line -> forbidden.any { line.lowercase().contains(it) } })
    }
}
