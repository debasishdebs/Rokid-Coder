package com.anezium.rokidbus.plugin.agents.service

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultNetworkChangesTest {
    @Test
    fun the_network_already_in_use_is_not_a_change_but_the_one_that_replaces_it_is() = runTest {
        var changes = 0
        val watch = DefaultNetworkChanges(backgroundScope, debounceMs = 500) { changes += 1 }

        watch.onAvailable("wifi")
        advanceTimeBy(5_000)
        assertEquals(0, changes)

        watch.onAvailable("mobile")
        advanceTimeBy(499)
        assertEquals("not before the debounce", 0, changes)
        advanceTimeBy(2)
        assertEquals(1, changes)
    }

    @Test
    fun the_same_network_reported_again_is_not_a_change() = runTest {
        var changes = 0
        val watch = DefaultNetworkChanges(backgroundScope, debounceMs = 500) { changes += 1 }
        watch.onAvailable("wifi")
        watch.onAvailable("wifi")
        advanceTimeBy(5_000)
        assertEquals(0, changes)
    }

    @Test
    fun a_network_that_returns_after_the_default_was_lost_is_a_change() = runTest {
        var changes = 0
        val watch = DefaultNetworkChanges(backgroundScope, debounceMs = 500) { changes += 1 }
        watch.onAvailable("wifi")
        watch.onLost("wifi")
        watch.onAvailable("wifi")
        advanceTimeBy(501)
        assertEquals(1, changes)
    }

    @Test
    fun a_burst_of_changes_counts_once() = runTest {
        var changes = 0
        val watch = DefaultNetworkChanges(backgroundScope, debounceMs = 500) { changes += 1 }
        watch.onAvailable("wifi")
        watch.onAvailable("mobile")
        advanceTimeBy(200)
        watch.onAvailable("vpn")
        advanceTimeBy(200)
        watch.onAvailable("mobile")
        advanceTimeBy(5_000)
        assertEquals(1, changes)
    }

    @Test
    fun stop_drops_a_change_still_waiting() = runTest {
        var changes = 0
        val watch = DefaultNetworkChanges(backgroundScope, debounceMs = 500) { changes += 1 }
        watch.onAvailable("wifi")
        watch.onAvailable("mobile")
        watch.stop()
        advanceTimeBy(5_000)
        assertEquals(0, changes)
    }
}
