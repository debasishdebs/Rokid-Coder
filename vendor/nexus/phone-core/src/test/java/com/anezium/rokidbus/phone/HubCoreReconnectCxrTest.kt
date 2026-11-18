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
    fun no_stored_token_means_nothing_to_connect_with() {
        harness.context.getSharedPreferences(HubPrefs.PREFS, 0).edit().remove("cxrl_token").commit()
        core.start()

        assertFalse(core.reconnectCxr())

        assertEquals(0, cxr.connectTokens.size)
    }
}
