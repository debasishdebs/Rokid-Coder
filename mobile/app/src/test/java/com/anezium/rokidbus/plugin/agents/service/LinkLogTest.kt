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
            core, enabled = enabled, clockMs = { testScheduler.currentTime },
        ).also { core.onLinkState = it::onLinkState }

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
    fun a_wearer_bind_says_each_attempt_its_result_and_where_it_gave_up() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)

        healer.ensureLink { }
        runCurrent()
        healer.ensureLink { }
        advanceTimeBy(GlassesLinkHealer.TOTAL_WAIT_MS + 1)

        val failed = "voice tap: link NOT_REACHED after 14000ms (attempt 2 failed, " +
            "cxr=down spp=down bonded=true worn=false closedByServer=true)"
        assertEquals(
            listOf(
                "wearer link: down, binding (bind 1, closedByServer=true)",
                // The hub reports its state at the bind, and the closure still stands.
                "healer: not chasing the link (Hi Rokid closed the session)",
                "wearer link: bind 1 result CONNECTING",
                "wearer link: joins the attempt in flight",
                "wearer link: bind 1 still down after 6000ms",
                "wearer link: down, binding (bind 2, closedByServer=true)",
                "wearer link: bind 2 result CONNECTING",
                "wearer link: bind 2 still down after 8000ms",
                // One line per tap, each with its own time.
                failed,
                failed,
            ),
            lines,
        )

        lines.clear()
        core.state = bonded or LinkStateBits.CXR_CONTROL_UP
        healer.ensureLink { }
        assertEquals(listOf("wearer link: up, reused", "voice tap: link UP after 0ms (reused)"), lines)
    }

    @Test
    fun the_time_to_the_link_and_the_attempt_that_brought_it_are_logged_per_tap() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)

        healer.ensureLink { }
        runCurrent()
        advanceTimeBy(2_500)
        healer.ensureLink { }
        // The link comes up during the second wait: attempt 2, and each tap's own wait.
        advanceTimeBy(5_500)
        core.bringUp()

        assertTrue(lines.toString(), "voice tap: link UP after 8000ms (attempt 2)" in lines)
        assertTrue(lines.toString(), "voice tap: link UP after 5500ms (attempt 2)" in lines)

        lines.clear()
        val quick = FakeLinkCore().apply { state = bonded }
        newHealer(quick).ensureLink { }
        runCurrent()
        advanceTimeBy(1_200)
        quick.bringUp()
        assertTrue(lines.toString(), "voice tap: link UP after 1200ms (attempt 1)" in lines)
    }

    @Test
    fun the_lines_the_link_says_itself_are_never_touched_by_the_redaction() = runTest {
        LinkLog.clearRecent()
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        healer.ensureLink { }
        runCurrent()
        advanceTimeBy(GlassesLinkHealer.TOTAL_WAIT_MS + 1)
        core.bringUp()
        core.drop(byServer = false)
        advanceTimeBy(60_000)
        healer.stop()
        listOf(
            "CXR-L connected=false", "CXR-L session closed by Hi Rokid", "Hi Rokid glass BT connected=true",
            "CXR-L connect requested bound=true", "CXR-L closed-session flag stands until the link is seen up",
        ).forEach(LinkLog::hub)
        lines += LinkLog.bits(bonded, false)

        assertTrue(lines.isNotEmpty())
        // What the app wrote is what came out: no marker anywhere, so no line of ours looks like a secret.
        assertTrue(lines.toString(), lines.none { "<id>" in it || "<addr>" in it })
        LinkLog.clearRecent()
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
    fun a_wearers_bind_in_flight_holds_the_background_back_with_one_line_not_one_per_poll() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(9_000)

        // The wearer taps just before the first background attempt falls; the bind waits five seconds.
        healer.ensureLink { }
        runCurrent()
        advanceTimeBy(60_000)

        assertEquals(1, lines.count { it.startsWith("healer: attempt held back") })
        assertEquals(
            "one pause line per pause, none repeated for the hold-back",
            1, lines.count { it == "healer: next attempt in 10000ms" },
        )
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
