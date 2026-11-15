package com.anezium.rokidbus.phone

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The host service's foreground promotion, under both microphone policies. */
class ForegroundPromotionTest {
    private val starts = mutableListOf<Boolean>()
    private val logged = mutableListOf<String>()
    private var refuseMicrophone: Throwable? = null

    private val start: (Boolean) -> Unit = { microphone ->
        starts += microphone
        if (microphone) refuseMicrophone?.let { throw it }
    }

    private fun promotion(hold: Boolean) = ForegroundPromotion(hold) { message, _ -> logged += message }

    @Test
    fun upstream_policy_still_drops_microphone_on_release() {
        val promotion = promotion(hold = false)

        assertNull(promotion.promote(true, start))
        assertTrue(promotion.microphoneHeld)
        // The session released it: the type goes again, as BusHubService.kt:4955-4959 does.
        assertNull(promotion.promote(false, start))
        assertFalse(promotion.microphoneHeld)
        // The next session asks for it again with a new start.
        assertNull(promotion.promote(true, start))

        assertEquals(listOf(true, false, true), starts)
        assertTrue(logged.isEmpty())
    }

    @Test
    fun a_refused_microphone_falls_back_to_connected_device_and_returns_the_failure() {
        val refusal = SecurityException("background")
        refuseMicrophone = refusal

        for (hold in listOf(false, true)) {
            starts.clear()
            logged.clear()
            val promotion = promotion(hold)

            assertSame(refusal, promotion.promote(true, start))
            assertEquals(listOf(true, false), starts)
            assertFalse(promotion.microphoneHeld)
            assertEquals(
                listOf("Hub foreground promotion failed microphone=true type=SecurityException"),
                logged,
            )
        }
    }

    @Test
    fun a_failed_fallback_is_logged_and_the_first_failure_returned() {
        val refusal = IllegalStateException("no")
        val promotion = promotion(hold = false)

        val failure = promotion.promote(true) { microphone ->
            starts += microphone
            throw if (microphone) refusal else SecurityException("fallback")
        }

        assertSame(refusal, failure)
        assertEquals(
            listOf(
                "Hub foreground promotion failed microphone=true type=IllegalStateException",
                "Connected-device foreground fallback failed type=SecurityException",
            ),
            logged,
        )
    }

    @Test
    fun a_held_microphone_is_kept_across_releases_until_reset() {
        val promotion = promotion(hold = true)

        assertNull(promotion.promote(true, start))
        // A session's release and the next session's request: no start at all, the type stays.
        repeat(3) {
            assertNull(promotion.promote(false, start))
            assertNull(promotion.promote(true, start))
        }
        assertEquals(listOf(true), starts)
        assertTrue(promotion.microphoneHeld)

        promotion.reset()
        assertFalse(promotion.microphoneHeld)
        assertNull(promotion.promote(false, start))
        assertEquals(listOf(true, false), starts)
    }

    @Test
    fun a_connected_device_start_does_not_hold_the_microphone() {
        val promotion = promotion(hold = true)

        assertNull(promotion.promote(false, start))
        assertFalse(promotion.microphoneHeld)
        assertNull(promotion.promote(true, start))
        assertTrue(promotion.microphoneHeld)
        assertEquals(listOf(false, true), starts)
    }
}
