package com.anezium.rokidbus.plugin.agents

import android.app.NotificationManager
import com.anezium.rokidbus.shared.LinkStateBits
import com.anezium.rokidbus.plugin.agents.service.CoderNotifications
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

    private fun sound(
        kind: AlertKind,
        provider: AgentProvider = AgentProvider.CLAUDE,
        reason: AlertReason = AlertReason.NEW,
    ) = AlertSoundPolicy.sound(kind, provider, reason)

    @Test
    fun done_chimes_approval_and_question_speak() {
        assertEquals(AlertSound.Chime, sound(AlertKind.DONE))
        assertEquals(AlertSound.Chime, sound(AlertKind.DONE, AgentProvider.CODEX))
        assertEquals(AlertSound.Speak("Claude needs approval"), sound(AlertKind.APPROVAL))
        assertEquals(AlertSound.Speak("Codex needs approval"), sound(AlertKind.APPROVAL, AgentProvider.CODEX))
        assertEquals(AlertSound.Speak("Claude has a question"), sound(AlertKind.QUESTION))
        assertEquals(AlertSound.Speak("Codex has a question"), sound(AlertKind.QUESTION, AgentProvider.CODEX))
        assertEquals(AlertSound.Speak("Claude hit an error"), sound(AlertKind.ERROR))
        AgentProvider.values().forEach { assertEquals(AlertSound.None, sound(AlertKind.NOTICE, it)) }
    }

    @Test
    fun reminder_retry_resume_are_silent() {
        val silent = listOf(AlertReason.REMINDER, AlertReason.RETRY, AlertReason.RESUME, AlertReason.UPDATE)
        for (kind in AlertKind.values()) {
            for (reason in silent) {
                assertEquals("$kind $reason", AlertSound.None, sound(kind, reason = reason))
            }
        }
    }

    private fun soundWith(
        kind: AlertKind,
        prefs: SoundPrefs,
        reason: AlertReason = AlertReason.NEW,
        provider: AgentProvider = AgentProvider.CLAUDE,
    ) = AlertSoundPolicy.sound(kind, provider, reason, prefs)

    @Test
    fun each_kind_follows_its_setting() {
        val kinds = mapOf(
            AlertKind.APPROVAL to (SoundSlot.APPROVAL to "Claude needs approval"),
            AlertKind.QUESTION to (SoundSlot.QUESTION to "Claude has a question"),
            AlertKind.ERROR to (SoundSlot.ERROR to "Claude hit an error"),
            AlertKind.DONE to (SoundSlot.DONE to "Claude is done"),
        )
        for ((kind, slotAndText) in kinds) {
            val (slot, text) = slotAndText
            val base = SoundPrefs()
            assertEquals("$kind speak", AlertSound.Speak(text), soundWith(kind, base.with(slot, SoundChoice.SPEAK)))
            assertEquals("$kind chime", AlertSound.Chime, soundWith(kind, base.with(slot, SoundChoice.CHIME)))
            assertEquals("$kind silent", AlertSound.None, soundWith(kind, base.with(slot, SoundChoice.SILENT)))
        }
        // The wording follows the tool.
        assertEquals(
            AlertSound.Speak("Codex needs approval"),
            soundWith(AlertKind.APPROVAL, SoundPrefs(), provider = AgentProvider.CODEX),
        )
        // A notice has no setting and never sounds.
        val loud = SoundPrefs(SoundChoice.SPEAK, SoundChoice.SPEAK, SoundChoice.SPEAK, SoundChoice.SPEAK, SoundChoice.SPEAK)
        assertEquals(AlertSound.None, soundWith(AlertKind.NOTICE, loud))
        assertEquals(AlertSound.None, soundWith(AlertKind.NOTICE, loud, reason = AlertReason.REMINDER))
    }

    @Test
    fun defaults_match_u3() {
        val prefs = SoundPrefs()
        assertEquals(SoundChoice.SPEAK, prefs.approval)
        assertEquals(SoundChoice.SPEAK, prefs.question)
        assertEquals(SoundChoice.SPEAK, prefs.error)
        assertEquals(SoundChoice.CHIME, prefs.done)
        assertEquals(SoundChoice.SILENT, prefs.reminder)
        assertEquals(
            listOf("sound.approval", "sound.question", "sound.error", "sound.done", "sound.reminder"),
            SoundSlot.values().map { it.key },
        )
        // Untouched settings sound exactly as the policy did before there was a setting.
        assertEquals(AlertSound.Speak("Claude needs approval"), sound(AlertKind.APPROVAL))
        assertEquals(AlertSound.Speak("Claude hit an error"), sound(AlertKind.ERROR))
        assertEquals(AlertSound.Chime, sound(AlertKind.DONE))
        assertEquals(AlertSound.None, sound(AlertKind.APPROVAL, reason = AlertReason.REMINDER))
    }

    @Test
    fun reminder_setting_applies_only_to_reminders() {
        val reminderLoud = SoundPrefs(reminder = SoundChoice.CHIME)
        for (kind in listOf(AlertKind.APPROVAL, AlertKind.QUESTION, AlertKind.ERROR, AlertKind.DONE)) {
            assertEquals("$kind reminder", AlertSound.Chime, soundWith(kind, reminderLoud, AlertReason.REMINDER))
        }
        // A fresh alert ignores it ...
        assertEquals(AlertSound.Speak("Claude needs approval"), soundWith(AlertKind.APPROVAL, reminderLoud))
        // ... and a reminder ignores the kind's own setting.
        val kindLoud = SoundPrefs(approval = SoundChoice.CHIME, done = SoundChoice.SPEAK)
        assertEquals(AlertSound.None, soundWith(AlertKind.APPROVAL, kindLoud, AlertReason.REMINDER))
        assertEquals(AlertSound.None, soundWith(AlertKind.DONE, kindLoud, AlertReason.REMINDER))
        assertEquals(
            AlertSound.Speak("Claude is still waiting"),
            soundWith(AlertKind.APPROVAL, SoundPrefs(reminder = SoundChoice.SPEAK), AlertReason.REMINDER),
        )
    }

    @Test
    fun retry_resume_update_always_silent() {
        val loud = SoundPrefs(SoundChoice.SPEAK, SoundChoice.CHIME, SoundChoice.SPEAK, SoundChoice.CHIME, SoundChoice.SPEAK)
        for (kind in AlertKind.values()) {
            for (reason in listOf(AlertReason.RETRY, AlertReason.RESUME, AlertReason.UPDATE)) {
                assertEquals("$kind $reason", AlertSound.None, soundWith(kind, loud, reason))
            }
        }
    }

    @Test
    fun a_chosen_sound_still_obeys_the_gates() {
        val chosen = soundWith(AlertKind.APPROVAL, SoundPrefs(approval = SoundChoice.CHIME))
        assertEquals(AlertSound.Chime, AlertSoundPolicy.allowed(chosen, DndState.OFF, false, 8, true))
        assertEquals(AlertSound.None, AlertSoundPolicy.allowed(chosen, DndState.ON, false, 8, true))
        assertEquals(AlertSound.None, AlertSoundPolicy.allowed(chosen, DndState.OFF, true, 8, true))
        assertEquals(AlertSound.None, AlertSoundPolicy.allowed(chosen, DndState.OFF, false, 0, true))
        assertEquals(AlertSound.None, AlertSoundPolicy.allowed(chosen, DndState.OFF, false, 8, false))
    }

    @Test
    fun chime_obeys_dnd_quiet_volume_worn() {
        fun gated(
            sound: AlertSound,
            dnd: DndState = DndState.OFF,
            quiet: Boolean = false,
            volume: Int? = 8,
            worn: Boolean? = true,
        ) = AlertSoundPolicy.allowed(sound, dnd, quiet, volume, worn)

        assertEquals(AlertSound.Chime, gated(AlertSound.Chime))
        assertEquals(AlertSound.Chime, gated(AlertSound.Chime, volume = null, worn = null))
        assertEquals(AlertSound.None, gated(AlertSound.Chime, dnd = DndState.ON))
        assertEquals(AlertSound.None, gated(AlertSound.Chime, dnd = DndState.UNKNOWN))
        assertEquals(AlertSound.None, gated(AlertSound.Chime, quiet = true))
        assertEquals(AlertSound.None, gated(AlertSound.Chime, volume = 0))
        assertEquals(AlertSound.None, gated(AlertSound.Chime, worn = false))
        val speak = AlertSound.Speak("Claude has a question")
        assertEquals(speak, gated(speak))
        assertEquals(AlertSound.None, gated(speak, quiet = true))
        assertEquals(AlertSound.None, gated(speak, dnd = DndState.ON))
        assertEquals(AlertSound.None, gated(AlertSound.None))
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
        assertEquals("Rokid Coder · 0 sessions", CoderNotifications.title(0))
        assertEquals("Rokid Coder · 1 session", CoderNotifications.title(1))
        assertEquals("Rokid Coder · 3 sessions", CoderNotifications.title(3))
    }
}
