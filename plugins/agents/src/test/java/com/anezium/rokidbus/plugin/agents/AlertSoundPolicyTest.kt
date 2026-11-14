package com.anezium.rokidbus.plugin.agents

import android.app.NotificationManager
import com.anezium.rokidbus.shared.LinkStateBits
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertSoundPolicyTest {
    private fun speaks(
        dnd: DndState = DndState.OFF,
        quiet: Boolean = false,
        volume: Int? = 8,
        worn: Boolean? = true,
    ) = AlertSoundPolicy.shouldSpeak(dnd, quiet, volume, worn)

    @Test
    fun dnd_on_is_silent() = assertFalse(speaks(dnd = DndState.ON))

    @Test
    fun dnd_unknown_is_silent() = assertFalse(speaks(dnd = DndState.UNKNOWN))

    @Test
    fun quiet_is_silent() = assertFalse(speaks(quiet = true))

    @Test
    fun volume_zero_is_silent() = assertFalse(speaks(volume = 0))

    @Test
    fun not_worn_is_silent() = assertFalse(speaks(worn = false))

    @Test
    fun all_clear_speaks() {
        assertTrue(speaks())
        // Nothing reported yet is not "known off the head" and not "muted".
        assertTrue(speaks(volume = null, worn = null))
    }

    @Test
    fun cue_copy_per_kind_and_provider() {
        assertEquals("Claude needs approval", AlertSoundPolicy.cue(AlertKind.APPROVAL, AgentProvider.CLAUDE))
        assertEquals("Codex needs approval", AlertSoundPolicy.cue(AlertKind.APPROVAL, AgentProvider.CODEX))
        assertEquals("Claude has a question", AlertSoundPolicy.cue(AlertKind.QUESTION, AgentProvider.CLAUDE))
        assertEquals("Codex is done", AlertSoundPolicy.cue(AlertKind.DONE, AgentProvider.CODEX))
        assertEquals("Claude is done", AlertSoundPolicy.cue(AlertKind.DONE, AgentProvider.CLAUDE))
        assertEquals("Claude hit an error", AlertSoundPolicy.cue(AlertKind.ERROR, AgentProvider.CLAUDE))
    }

    @Test
    fun notice_kind_has_no_cue() {
        AgentProvider.values().forEach { assertNull(AlertSoundPolicy.cue(AlertKind.NOTICE, it)) }
    }

    @Test
    fun interruption_filter_maps_to_dnd_state() {
        assertEquals(DndState.OFF, InterruptionFilterReader.classify(NotificationManager.INTERRUPTION_FILTER_ALL))
        assertEquals(DndState.ON, InterruptionFilterReader.classify(NotificationManager.INTERRUPTION_FILTER_NONE))
        assertEquals(DndState.ON, InterruptionFilterReader.classify(NotificationManager.INTERRUPTION_FILTER_PRIORITY))
        assertEquals(DndState.ON, InterruptionFilterReader.classify(NotificationManager.INTERRUPTION_FILTER_ALARMS))
        assertEquals(DndState.UNKNOWN, InterruptionFilterReader.classify(NotificationManager.INTERRUPTION_FILTER_UNKNOWN))
        assertEquals(DndState.UNKNOWN, InterruptionFilterReader.classify(99))
    }

    @Test
    fun worn_follows_the_link_bit_and_a_cleared_bit_alone_is_not_off_head() {
        val worn = LinkStateBits.CXR_CONTROL_UP or LinkStateBits.GLASSES_WORN
        assertEquals(true, AlertSoundPolicy.wornAfter(null, worn))
        // The hub reports the bit false until it hears otherwise: that is unknown, not "off".
        assertNull(AlertSoundPolicy.wornAfter(null, LinkStateBits.CXR_CONTROL_UP))
        // Once it was seen set, clearing it is the glasses coming off (or the link dropping).
        assertEquals(false, AlertSoundPolicy.wornAfter(true, LinkStateBits.CXR_CONTROL_UP))
        assertEquals(false, AlertSoundPolicy.wornAfter(false, LinkStateBits.CXR_CONTROL_UP))
        assertEquals(true, AlertSoundPolicy.wornAfter(false, worn))
    }

    @Test
    fun volume_is_read_from_device_info_only_when_present() {
        assertEquals(0, AlertSoundPolicy.volumeFrom(JSONObject().put("sound", 0)))
        assertEquals(9, AlertSoundPolicy.volumeFrom(JSONObject().put("sound", 9)))
        assertNull(AlertSoundPolicy.volumeFrom(JSONObject()))
        assertNull(AlertSoundPolicy.volumeFrom(JSONObject().put("sound", JSONObject.NULL)))
        assertNull(AlertSoundPolicy.volumeFrom(JSONObject().put("sound", -1)))
    }

    @Test
    fun monitor_notification_title_counts_sessions() {
        assertEquals("Agents monitoring · 0 sessions", AgentNotifications.monitorTitle(0))
        assertEquals("Agents monitoring · 1 session", AgentNotifications.monitorTitle(1))
        assertEquals("Agents monitoring · 3 sessions", AgentNotifications.monitorTitle(3))
    }
}
