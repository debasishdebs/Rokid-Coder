package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.phone.CxrEnsureResult
import com.anezium.rokidbus.shared.LinkStateBits
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The CXR link is connected again by the phone, with a growing pause, and only while it should be. */
@OptIn(ExperimentalCoroutinesApi::class)
class GlassesLinkHealerTest {
    private val bonded = LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED
    private val up = LinkStateBits.CXR_CONTROL_UP

    /**
     * On virtual time and, like the main thread's immediate dispatcher, running a call made on it at once.
     * A background scope, so the test's end does not wait for a retry loop that never ends.
     */
    private fun TestScope.newHealer(core: FakeLinkCore, enabled: () -> Boolean = { true }) =
        GlassesLinkHealer(
            CoroutineScope(backgroundScope.coroutineContext + UnconfinedTestDispatcher(testScheduler)),
            core, enabled = enabled,
        )

    @Test
    fun a_dropped_link_is_connected_again_with_a_growing_pause() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)

        healer.onLinkState(core.state)
        advanceTimeBy(9_999)
        assertEquals("not before the first pause", 0, core.reconnects)
        advanceTimeBy(2)
        assertEquals(1, core.reconnects)
        advanceTimeBy(19_000)
        assertEquals("the second pause is longer", 1, core.reconnects)
        advanceTimeBy(1_100)
        assertEquals(2, core.reconnects)
        advanceTimeBy(40_000)
        assertEquals(3, core.reconnects)
    }

    @Test
    fun the_pause_stops_growing_so_a_link_that_never_returns_costs_one_try_in_five_minutes() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)

        advanceTimeBy(10_000 + 20_000 + 40_000 + 80_000 + 160_000 + 1)
        assertEquals(5, core.reconnects)
        advanceTimeBy(300_000)
        assertEquals(6, core.reconnects)
        advanceTimeBy(300_000)
        assertEquals(7, core.reconnects)
    }

    @Test
    fun the_link_coming_up_ends_the_tries_and_the_next_drop_starts_over_at_the_short_pause() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(10_001)
        advanceTimeBy(20_001)
        assertEquals(2, core.reconnects)

        core.state = bonded or up
        healer.onLinkState(core.state)
        advanceTimeBy(600_000)
        assertEquals("nothing while it is up", 2, core.reconnects)

        core.state = bonded
        healer.onLinkState(core.state)
        advanceTimeBy(10_001)
        assertEquals(3, core.reconnects)
    }

    @Test
    fun a_link_that_comes_up_by_itself_during_the_pause_is_not_connected_over() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(5_000)
        // The hub's own callback came late and the state was not announced to us yet.
        core.state = bonded or up
        advanceTimeBy(60_000)

        assertEquals(0, core.reconnects)
    }

    @Test
    fun glasses_that_are_not_bonded_are_not_chased() = runTest {
        val core = FakeLinkCore().apply { state = 0 }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)

        // Bonded again (Bluetooth back on): the tries start.
        core.state = bonded
        healer.onLinkState(core.state)
        advanceTimeBy(10_001)
        assertEquals(1, core.reconnects)

        // Unbonded in the middle of a pause ends them.
        core.state = 0
        healer.onLinkState(core.state)
        advanceTimeBy(900_000)
        assertEquals(1, core.reconnects)
    }

    @Test
    fun a_session_hi_rokid_closed_is_not_rebound_into() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)
    }

    @Test
    fun monitoring_off_means_no_tries_even_for_a_pause_already_running() = runTest {
        var monitoring = true
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core) { monitoring }
        healer.onLinkState(core.state)
        advanceTimeBy(5_000)
        monitoring = false
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)
    }

    @Test
    fun nothing_to_connect_with_ends_the_tries_until_the_next_link_state() = runTest {
        val core = FakeLinkCore().apply { state = bonded; canReconnect = false }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)

        core.canReconnect = true
        healer.onLinkState(core.state)
        advanceTimeBy(10_001)
        assertEquals(1, core.reconnects)
    }

    @Test
    fun stop_ends_the_tries() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(5_000)
        healer.stop()
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)
    }

    // ------------------------------------------------------------------ the link, made sure of for a voice action

    @Test
    fun a_live_link_is_reused_without_binding_anything() = runTest {
        val core = FakeLinkCore().apply { state = bonded or up }
        var answer: LinkEnsure? = null

        newHealer(core).ensureLink { answer = it }

        assertEquals(LinkEnsure.UP, answer)
        assertEquals("not even asked of the hub", 0, core.ensures)
        assertEquals(0, core.binds)
    }

    @Test
    fun a_down_link_is_bound_at_once_and_the_voice_start_hears_it_come_up() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var answer: LinkEnsure? = null

        healer.ensureLink { answer = it }
        runCurrent()
        assertEquals("no waiting for a pause", 1, core.binds)
        assertEquals("not the background's reconnect", 0, core.reconnects)
        assertNull(answer)

        core.state = bonded or up
        healer.onLinkState(core.state)
        assertEquals(LinkEnsure.UP, answer)
    }

    @Test
    fun a_link_that_does_not_come_up_within_the_wait_is_not_reached() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var answer: LinkEnsure? = null

        healer.ensureLink { answer = it }
        runCurrent()
        advanceTimeBy(GlassesLinkHealer.ENSURE_WAIT_MS - 1)
        assertNull(answer)
        advanceTimeBy(2)
        assertEquals(LinkEnsure.NOT_REACHED, answer)
    }

    @Test
    fun the_wait_is_a_named_bounded_constant() {
        assertTrue(GlassesLinkHealer.ENSURE_WAIT_MS in 3_000L..5_000L)
    }

    @Test
    fun a_refused_bind_a_missing_token_and_a_stopped_hub_each_say_which() = runTest {
        fun answerFor(result: CxrEnsureResult): LinkEnsure? {
            val core = FakeLinkCore().apply { state = bonded; ensureResult = result }
            var answer: LinkEnsure? = null
            newHealer(core).ensureLink { answer = it }
            runCurrent()
            return answer
        }
        assertEquals(LinkEnsure.NOT_REACHED, answerFor(CxrEnsureResult.NOT_BOUND))
        assertEquals(LinkEnsure.NO_TOKEN, answerFor(CxrEnsureResult.NO_TOKEN))
        assertEquals(LinkEnsure.STOPPED, answerFor(CxrEnsureResult.HUB_STOPPED))
    }

    @Test
    fun a_tap_takes_the_link_back_from_a_session_hi_rokid_closed_and_the_closure_clears() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)
        var answer: LinkEnsure? = null

        // The background holds back while the closure stands.
        healer.onLinkState(core.state)
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)

        healer.ensureLink { answer = it }
        runCurrent()

        assertEquals("the wearer's own tap binds", 1, core.binds)
        assertFalse("and the closure is cleared when it does", core.closedByServer)
        core.state = bonded or up
        healer.onLinkState(core.state)
        assertEquals(LinkEnsure.UP, answer)
    }

    @Test
    fun the_background_alone_still_refuses_while_the_closure_stands() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        healer.onMonitoringChanged()
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)
        assertEquals(0, core.binds)
        assertTrue(core.closedByServer)
    }

    @Test
    fun two_quick_taps_make_one_bind_and_both_hear_the_answer() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        val answers = mutableListOf<LinkEnsure>()

        healer.ensureLink { answers += it }
        healer.ensureLink { answers += it }
        runCurrent()
        advanceTimeBy(GlassesLinkHealer.ENSURE_WAIT_MS + 1)

        assertEquals("one bind, not two", 1, core.binds)
        assertEquals(listOf(LinkEnsure.NOT_REACHED, LinkEnsure.NOT_REACHED), answers)
    }

    @Test
    fun a_tap_after_an_attempt_ended_makes_an_attempt_of_its_own() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core)
        val answers = mutableListOf<LinkEnsure>()

        healer.ensureLink { answers += it }
        runCurrent()
        advanceTimeBy(GlassesLinkHealer.ENSURE_WAIT_MS + 1)
        // Closed again by Hi Rokid, and the wearer taps Speak again: no sticky refusal.
        core.closedByServer = true
        healer.ensureLink { answers += it }
        runCurrent()
        advanceTimeBy(GlassesLinkHealer.ENSURE_WAIT_MS + 1)

        assertEquals(2, core.binds)
        assertEquals(listOf(LinkEnsure.NOT_REACHED, LinkEnsure.NOT_REACHED), answers)
    }

    @Test
    fun the_link_coming_up_early_ends_the_attempt_and_the_next_tap_finds_it_up_or_binds_afresh() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.ensureLink { }
        runCurrent()
        core.state = bonded or up
        healer.onLinkState(core.state)

        // It drops again before the old wait would have ended: a new tap binds again, not joins a dead attempt.
        core.state = bonded
        healer.onLinkState(core.state)
        healer.ensureLink { }
        runCurrent()

        assertEquals(2, core.binds)
    }

    @Test
    fun the_background_stands_aside_while_a_wearers_bind_is_in_flight() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        advanceTimeBy(9_000)
        // The wearer taps just before the first background attempt would fall.
        healer.ensureLink { }
        runCurrent()
        advanceTimeBy(2_000)

        assertEquals(1, core.binds)
        assertEquals("the background did not bind over the wearer's bind", 0, core.reconnects)
    }

    @Test
    fun a_tap_is_not_honoured_with_monitoring_off() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core) { false }
        var answer: LinkEnsure? = null

        healer.ensureLink { answer = it }
        runCurrent()

        assertEquals(LinkEnsure.MONITORING_OFF, answer)
        assertEquals(0, core.binds)
        assertEquals(0, core.reconnects)
    }

    @Test
    fun stop_answers_whoever_is_waiting() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var answer: LinkEnsure? = null
        healer.ensureLink { answer = it }
        runCurrent()
        healer.stop()
        assertEquals(LinkEnsure.STOPPED, answer)
        assertEquals(1, core.binds)
    }

    // ------------------------------------------------------------------ threads

    @Test
    fun a_link_state_from_another_thread_answers_a_waiting_request_on_the_main_one() {
        val executor = Executors.newSingleThreadExecutor { Thread(it, "healer-main") }
        try {
            val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
            val core = FakeLinkCore().apply { state = bonded }
            val healer = GlassesLinkHealer(scope, core, waitMs = 60_000)
            val answered = CountDownLatch(1)
            var answeredOn: String? = null
            var answer: LinkEnsure? = null

            healer.ensureLink {
                answeredOn = Thread.currentThread().name
                answer = it
                answered.countDown()
            }
            // CXR reports the glasses' Bluetooth on its own Binder thread, here the test's.
            val reconnected = System.currentTimeMillis() + 5_000
            while (core.binds == 0 && System.currentTimeMillis() < reconnected) Thread.sleep(5)
            assertEquals(1, core.binds)
            core.state = bonded or up
            healer.onLinkState(core.state)

            assertTrue(answered.await(5, TimeUnit.SECONDS))
            assertEquals(LinkEnsure.UP, answer)
            // The coroutine debug agent appends " @coroutine#n" to the name of a thread running one.
            assertTrue("the voice retry is made on the main thread, not on $answeredOn", answeredOn!!.startsWith("healer-main"))
        } finally {
            executor.shutdownNow()
        }
    }

    @Test
    fun the_retries_run_on_the_main_thread_whichever_thread_reports_the_state() {
        val executor = Executors.newSingleThreadExecutor { Thread(it, "healer-main") }
        try {
            val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
            val threads = CopyOnWriteArrayList<String>()
            val core = object : CoderCore by FakeLinkCore() {
                override fun linkState(): Int = bonded
                override fun reconnectLink(): Boolean {
                    threads += Thread.currentThread().name
                    return true
                }
            }
            val healer = GlassesLinkHealer(scope, core, retryDelaysMs = listOf(10L))

            healer.onLinkState(bonded)
            val deadline = System.currentTimeMillis() + 5_000
            while (threads.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(5)

            assertTrue(threads.isNotEmpty())
            assertTrue(threads.toString(), threads.all { it.startsWith("healer-main") })
            healer.stop()
        } finally {
            executor.shutdownNow()
        }
    }

    // ------------------------------------------------------------------ monitoring switched on and off

    @Test
    fun monitoring_turned_off_and_on_again_starts_the_tries_again_with_the_link_state_unchanged() = runTest {
        var monitoring = true
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core) { monitoring }
        healer.onLinkState(core.state)
        advanceTimeBy(10_001)
        assertEquals(1, core.reconnects)

        // Off, and the loop wakes, finds monitoring off and ends on its own. Nobody reports a link state.
        monitoring = false
        advanceTimeBy(900_000)
        assertEquals("nothing while off", 1, core.reconnects)

        monitoring = true
        advanceTimeBy(900_000)
        assertEquals("on its own the link state is unchanged and nothing starts it", 1, core.reconnects)
        healer.onMonitoringChanged()
        advanceTimeBy(9_999)
        assertEquals(1, core.reconnects)
        advanceTimeBy(2)
        assertEquals("tries again, from the short pause", 2, core.reconnects)
    }

    @Test
    fun monitoring_turned_off_ends_a_pause_already_running_at_once() = runTest {
        var monitoring = true
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core) { monitoring }
        healer.onLinkState(core.state)
        advanceTimeBy(5_000)

        monitoring = false
        healer.onMonitoringChanged()
        monitoring = true
        // Back on before the old pause would have ended: the new tries start from their own first pause.
        advanceTimeBy(5_001)
        assertEquals(0, core.reconnects)
        healer.onMonitoringChanged()
        advanceTimeBy(10_001)
        assertEquals(1, core.reconnects)
    }

    @Test
    fun monitoring_turned_on_with_the_link_up_or_the_glasses_gone_does_nothing() = runTest {
        val core = FakeLinkCore().apply { state = bonded or up }
        val healer = newHealer(core)
        healer.onMonitoringChanged()
        advanceTimeBy(900_000)
        core.state = 0
        healer.onMonitoringChanged()
        advanceTimeBy(900_000)
        assertEquals(0, core.reconnects)
    }

    // ------------------------------------------------------------------ Stop

    @Test
    fun after_stop_nothing_reconnects_whatever_is_reported_or_asked() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        healer.onLinkState(core.state)
        healer.stop()

        healer.onLinkState(core.state)
        healer.onMonitoringChanged()
        var answer: LinkEnsure? = null
        healer.ensureLink { answer = it }
        advanceTimeBy(900_000)

        assertEquals(0, core.reconnects)
        assertEquals("Stop also ends the wearer's binds", 0, core.binds)
        assertEquals(LinkEnsure.STOPPED, answer)
    }
}
