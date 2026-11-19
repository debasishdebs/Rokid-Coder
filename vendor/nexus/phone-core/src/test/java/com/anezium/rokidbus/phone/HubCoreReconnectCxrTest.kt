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

    // ---------------------------------------------------------------- the link, made sure of for the wearer

    @Test
    fun a_live_link_is_reused_and_nothing_is_bound() {
        harness.startLinked()
        assertTrue(core.isCxrUp())

        assertEquals(CxrEnsureResult.ALREADY_UP, core.ensureCxrLink())
        assertEquals(CxrEnsureResult.ALREADY_UP, core.ensureCxrLink())

        assertEquals("no extra bind", 1, cxr.connectTokens.size)
        assertEquals(0, cxr.disconnects)
    }

    @Test
    fun a_session_hi_rokid_closed_is_taken_back_for_the_wearer_and_the_closure_clears() {
        harness.startLinked()
        cxr.linkDown()
        cxr.linkCallback!!.onCXRLDisconnectedByServer()
        assertTrue(core.cxrClosedByServer)
        // The background retry still refuses.
        assertFalse(core.reconnectCxr())
        assertEquals(1, cxr.connectTokens.size)

        assertEquals(CxrEnsureResult.CONNECTING, core.ensureCxrLink())

        assertEquals(listOf("test-token", "test-token"), cxr.connectTokens.toList())
        assertFalse("the closure is cleared, as the Glass app screen does", core.cxrClosedByServer)
        assertEquals(0, cxr.disconnects)
    }

    @Test
    fun a_closure_delivered_while_the_wearers_bind_connects_does_not_stop_it() {
        harness.startLinked()
        cxr.linkDown()
        cxr.beforeBind = {
            cxr.beforeBind = {}
            cxr.linkCallback!!.onCXRLDisconnectedByServer()
        }

        assertEquals(CxrEnsureResult.CONNECTING, core.ensureCxrLink())

        assertEquals(0, cxr.disconnects)
        assertFalse(core.cxrClosedByServer)
    }

    @Test
    fun a_link_that_stays_down_is_bound_again_on_the_next_ask_with_no_sticky_refusal() {
        harness.startLinked()
        cxr.linkDown()
        cxr.linkCallback!!.onCXRLDisconnectedByServer()

        assertEquals(CxrEnsureResult.CONNECTING, core.ensureCxrLink())
        // The bind came up but the glasses did not report in: still down.
        assertFalse(core.isCxrUp())
        assertEquals(CxrEnsureResult.CONNECTING, core.ensureCxrLink())
        cxr.linkCallback!!.onCXRLDisconnectedByServer()
        assertEquals(CxrEnsureResult.CONNECTING, core.ensureCxrLink())

        assertEquals(4, cxr.connectTokens.size)
    }

    @Test
    fun a_bind_the_library_refuses_is_said_so() {
        harness.startLinked()
        cxr.linkDown()
        cxr.refuseBind = true

        assertEquals(CxrEnsureResult.NOT_BOUND, core.ensureCxrLink())
    }

    @Test
    fun a_stopped_hub_or_no_stored_token_binds_nothing_and_says_which() {
        harness.context.getSharedPreferences(HubPrefs.PREFS, 0).edit().remove("cxrl_token").commit()
        core.start()
        assertEquals(CxrEnsureResult.NO_TOKEN, core.ensureCxrLink())
        assertEquals(0, cxr.connectTokens.size)

        core.stop()
        assertEquals(CxrEnsureResult.HUB_STOPPED, core.ensureCxrLink())
        assertEquals(0, cxr.connectTokens.size)
    }

    @Test
    fun no_stored_token_means_nothing_to_connect_with() {
        harness.context.getSharedPreferences(HubPrefs.PREFS, 0).edit().remove("cxrl_token").commit()
        core.start()

        assertFalse(core.reconnectCxr())

        assertEquals(0, cxr.connectTokens.size)
    }
}
