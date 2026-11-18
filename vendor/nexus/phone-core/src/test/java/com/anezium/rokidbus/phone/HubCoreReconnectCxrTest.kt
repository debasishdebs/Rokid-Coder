@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** [HubCore.reconnectCxr]: the one way a shell connects CXR again once the link has dropped. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class HubCoreReconnectCxrTest {
    private val harness = HubCoreHarness()
    private val core get() = harness.core
    private val cxr get() = harness.cxr

    @Test
    fun a_dropped_link_connects_again_with_the_stored_token() {
        harness.startLinked()
        assertEquals(listOf("test-token"), cxr.connectTokens.toList())
        cxr.linkDown()
        assertFalse(core.isCxrUp())

        assertTrue(core.reconnectCxr())

        assertEquals(listOf("test-token", "test-token"), cxr.connectTokens.toList())
    }

    @Test
    fun a_link_that_is_up_is_left_alone() {
        harness.startLinked()
        assertTrue(core.isCxrUp())

        assertFalse(core.reconnectCxr())

        assertEquals(1, cxr.connectTokens.size)
    }

    @Test
    fun a_stopped_hub_does_not_connect() {
        harness.startLinked()
        cxr.linkDown()
        core.stop()

        assertFalse(core.reconnectCxr())

        assertEquals(1, cxr.connectTokens.size)
    }

    @Test
    fun a_session_hi_rokid_closed_is_not_bound_again_automatically() {
        harness.startLinked()
        cxr.linkDown()
        cxr.linkCallback!!.onCXRLDisconnectedByServer()
        assertTrue(core.cxrClosedByServer)

        assertFalse(core.reconnectCxr())

        assertEquals(1, cxr.connectTokens.size)
        assertTrue(core.cxrClosedByServer)
    }

    @Test
    fun a_close_that_is_still_being_torn_down_when_the_attempt_starts_is_not_bound_over() {
        harness.startLinked()
        cxr.linkDown()
        // Hi Rokid closed the session on a binder thread: the library retired the bind, and its closure
        // reaches the hub only when `connect` finishes that teardown.
        cxr.beforeBind = {
            cxr.beforeBind = {}
            cxr.linkCallback!!.onCXRLDisconnectedByServer()
        }
        assertFalse(core.cxrClosedByServer)

        assertFalse(core.reconnectCxr())

        assertEquals("the bind it made is let go", 1, cxr.disconnects)
        assertTrue("the close still stands", core.cxrClosedByServer)
        assertFalse(core.reconnectCxr())
        assertEquals(2, cxr.connectTokens.size)
    }

    @Test
    fun the_wearer_starting_the_link_still_binds_after_a_close() {
        harness.startLinked()
        cxr.linkDown()
        cxr.linkCallback!!.onCXRLDisconnectedByServer()
        assertTrue(core.cxrClosedByServer)

        core.start()

        assertEquals(2, cxr.connectTokens.size)
        assertFalse(core.cxrClosedByServer)
    }

    @Test
    fun no_stored_token_means_nothing_to_connect_with() {
        harness.context.getSharedPreferences(HubPrefs.PREFS, 0).edit().remove("cxrl_token").commit()
        core.start()

        assertFalse(core.reconnectCxr())

        assertEquals(0, cxr.connectTokens.size)
    }
}
