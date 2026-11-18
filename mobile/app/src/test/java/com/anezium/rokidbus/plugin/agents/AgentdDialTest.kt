package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.delay
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which saved address is dialled first: the one that answers a bare connect, not the one saved first. */
class AgentdDialTest {
    private val lan = "192.168.68.104"
    private val tailnet = "100.78.52.6"

    @Test
    fun the_address_that_answers_first_goes_first_and_does_not_wait_for_the_stale_one() = runTest {
        val order = reachableFirst(listOf(lan, tailnet), timeoutMs = 1_500) { host ->
            // The stale LAN address answers only after the probe's whole time; the tailnet one at once.
            if (host == lan) delay(60_000).let { true } else delay(30).let { true }
        }
        assertEquals(listOf(tailnet, lan), order)
        assertEquals("the stale address was not waited for", 30L, currentTime)
    }

    @Test
    fun an_address_that_refuses_is_passed_over_for_one_that_answers_later() = runTest {
        val order = reachableFirst(listOf(lan, tailnet, "10.0.0.5")) { host ->
            when (host) {
                lan -> false
                tailnet -> delay(200).let { false }
                else -> delay(400).let { true }
            }
        }
        assertEquals(listOf("10.0.0.5", lan, tailnet), order)
    }

    @Test
    fun the_saved_order_stands_when_nothing_answers() = runTest {
        val refused = reachableFirst(listOf(lan, tailnet)) { false }
        assertEquals(listOf(lan, tailnet), refused)

        val silent = reachableFirst(listOf(lan, tailnet), timeoutMs = 1_500) { delay(60_000).let { true } }
        assertEquals(listOf(lan, tailnet), silent)
        assertEquals(1_500L, currentTime)
    }

    @Test
    fun a_probe_that_throws_is_a_miss_not_a_failure_of_the_round() = runTest {
        val order = reachableFirst(listOf(lan, tailnet)) { host ->
            if (host == lan) throw IllegalStateException("no route") else true
        }
        assertEquals(listOf(tailnet, lan), order)
    }

    @Test
    fun one_address_is_not_probed_at_all() = runTest {
        var probed = false
        assertEquals(listOf(lan), reachableFirst(listOf(lan)) { probed = true; true })
        assertEquals(emptyList<String>(), reachableFirst(emptyList()) { probed = true; true })
        assertEquals(false, probed)
    }

    @Test
    fun the_probe_dials_the_host_and_port_the_wss_dial_would() {
        assertEquals(lan to 8792, dialTarget(lan, 8792))
        assertEquals("fd7a:115c::1" to 8792, dialTarget("fd7a:115c::1", 8792))
        assertEquals("mac.tail1234.ts.net" to 9000, dialTarget("wss://mac.tail1234.ts.net/x", 9000))
        assertNull(dialTarget("::::", 8792))
    }
}
