package com.anezium.rokidbus.plugin.agents

import android.media.AudioDeviceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** The chime's pure parts: its waveform and every decision about where it may be heard. */
class ChimePlayerTest {
    private val rate = 44_100
    private val first = rate * 70 / 1000
    private val second = rate * 110 / 1000
    private val fade = rate * 15 / 1000

    private val speaker = AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
    private val a2dp = AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
    private val sco = AudioDeviceInfo.TYPE_BLUETOOTH_SCO
    private val wired = AudioDeviceInfo.TYPE_WIRED_HEADSET

    private fun crossings(pcm: ShortArray, from: Int, to: Int): Int {
        var n = 0
        for (i in from + 1 until to) if ((pcm[i - 1] < 0) != (pcm[i] < 0)) n++
        return n
    }

    @Test
    fun chime_tone_shape_and_fades() {
        val pcm = ChimeTone.pcm()
        assertEquals(first + second, pcm.size)
        assertTrue("peak stays at or under half scale", pcm.all { abs(it.toInt()) <= 16_383 })
        assertTrue("it is not silent", pcm.any { abs(it.toInt()) > 8_000 })
        // Each note fades in from nothing and out to nothing.
        assertEquals(0, pcm[0].toInt())
        assertTrue(abs(pcm[first - 1].toInt()) < 400)
        assertTrue(abs(pcm[first].toInt()) < 400)
        assertTrue(abs(pcm[pcm.lastIndex].toInt()) < 400)
        // A fade is linear: a third of the way in, the swing is well under the steady peak.
        val steady = (fade..first - fade).maxOf { abs(pcm[it].toInt()) }
        val early = (0 until fade / 3).maxOf { abs(pcm[it].toInt()) }
        assertTrue("early $early steady $steady", early < steady / 2)
        // 880 Hz for 70 ms is about 123 zero crossings, 1320 Hz for 110 ms about 290.
        assertEquals(123.0, crossings(pcm, 0, first).toDouble(), 6.0)
        assertEquals(290.0, crossings(pcm, first, pcm.size).toDouble(), 8.0)
    }

    @Test
    fun chime_tone_follows_the_sample_rate() {
        assertEquals(8_000 * 70 / 1000 + 8_000 * 110 / 1000, ChimeTone.pcm(8_000).size)
    }

    @Test
    fun chime_dropped_without_bt_output() {
        assertFalse(ChimeRoute.canPlay(emptyList()))
        assertFalse(ChimeRoute.canPlay(listOf(speaker)))
        assertFalse(ChimeRoute.canPlay(listOf(wired)))
        assertTrue(ChimeRoute.canPlay(listOf(a2dp)))
        assertTrue(ChimeRoute.canPlay(listOf(AudioDeviceInfo.TYPE_BLE_HEADSET)))
        assertTrue(ChimeRoute.canPlay(listOf(AudioDeviceInfo.TYPE_BLE_SPEAKER)))
        assertTrue(ChimeRoute.canPlay(listOf(sco, a2dp)))
        // No route at all, or one that includes the speaker, never starts a track.
        assertFalse(ChimeRoute.canStart(33, emptyList()))
        assertFalse(ChimeRoute.canStart(33, listOf(speaker)))
        assertFalse(ChimeRoute.canStart(33, listOf(a2dp, speaker)))
        assertTrue(ChimeRoute.canStart(33, listOf(a2dp)))
    }

    @Test
    fun chime_silent_below_api_33() {
        assertFalse(ChimeRoute.canStart(32, listOf(a2dp)))
        assertFalse(ChimeRoute.canStart(30, listOf(a2dp)))
        assertTrue(ChimeRoute.canStart(34, listOf(a2dp)))
    }

    @Test
    fun chime_route_check_stops_on_non_bt_routed_device() {
        assertTrue(ChimeRoute.keepPlaying(a2dp))
        assertTrue(ChimeRoute.keepPlaying(sco))
        assertFalse(ChimeRoute.keepPlaying(speaker))
        assertFalse(ChimeRoute.keepPlaying(wired))
        assertFalse(ChimeRoute.keepPlaying(null))
    }

    @Test
    fun chime_never_unmutes_unless_routed_bt() {
        // Routed to the speaker, or not routed yet: stays muted.
        assertFalse(ChimeRoute.mayUnmute(speaker))
        assertFalse(ChimeRoute.mayUnmute(null))
        // BT is connected, but the attributes route to the speaker: the pre-check refuses it before any track.
        assertFalse(ChimeRoute.canStart(33, listOf(speaker)))
        assertTrue(ChimeRoute.mayUnmute(a2dp))
        assertTrue(ChimeRoute.mayUnmute(AudioDeviceInfo.TYPE_BLE_HEADSET))
        assertTrue(ChimeRoute.mayUnmute(AudioDeviceInfo.TYPE_BLE_SPEAKER))
    }
}
