package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.shared.LinkStateBits
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The CXR link is connected again by the phone, with a growing pause, and only while it should be. */
@OptIn(ExperimentalCoroutinesApi::class)
class GlassesLinkHealerTest {
    private val bonded = LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED
    private val up = LinkStateBits.CXR_CONTROL_UP

    private fun TestScope.newHealer(core: FakeLinkCore, enabled: () -> Boolean = { true }) =
        GlassesLinkHealer(backgroundScope, core, enabled = enabled, settleMs = 3_000)

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

    // ------------------------------------------------------------------ a request that was denied for want of the link

    @Test
    fun a_denied_request_reconnects_at_once_and_hears_the_link_come_up() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var result: Boolean? = null

        healer.healNow { result = it }
        runCurrent()
        assertEquals("no waiting for a pause", 1, core.reconnects)
        assertNull(result)

        core.state = bonded or up
        healer.onLinkState(core.state)
        assertEquals(true, result)
    }

    @Test
    fun a_link_that_does_not_come_up_within_the_wait_is_reported_down() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var result: Boolean? = null

        healer.healNow { result = it }
        runCurrent()
        advanceTimeBy(2_999)
        assertNull(result)
        advanceTimeBy(2)
        assertEquals(false, result)
    }

    @Test
    fun an_up_link_answers_at_once_and_a_core_with_nothing_to_connect_says_down_at_once() = runTest {
        val up = FakeLinkCore().apply { state = bonded or this@GlassesLinkHealerTest.up }
        var answer: Boolean? = null
        newHealer(up).healNow { answer = it }
        assertEquals(true, answer)
        assertEquals(0, up.reconnects)

        val bare = FakeLinkCore().apply { state = bonded; canReconnect = false }
        answer = null
        newHealer(bare).healNow { answer = it }
        runCurrent()
        assertEquals(false, answer)
    }

    @Test
    fun a_denied_request_tries_even_when_hi_rokid_closed_the_session_or_monitoring_is_off() = runTest {
        val core = FakeLinkCore().apply { state = bonded; closedByServer = true }
        val healer = newHealer(core) { false }
        healer.healNow { }
        runCurrent()
        // The wearer is waiting on it; the background tries are the ones that hold back.
        assertEquals(1, core.reconnects)
    }

    @Test
    fun requests_that_arrive_while_one_is_waiting_share_it() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        val results = mutableListOf<Boolean>()
        healer.healNow { results += it }
        healer.healNow { results += it }
        runCurrent()
        advanceTimeBy(3_001)

        assertEquals(1, core.reconnects)
        assertEquals(listOf(false, false), results)
    }

    @Test
    fun stop_answers_whoever_is_waiting() = runTest {
        val core = FakeLinkCore().apply { state = bonded }
        val healer = newHealer(core)
        var answer: Boolean? = null
        healer.healNow { answer = it }
        runCurrent()
        healer.stop()
        assertEquals(false, answer)
        assertFalse(answer == true)
        assertTrue(core.reconnects == 1)
    }
}
