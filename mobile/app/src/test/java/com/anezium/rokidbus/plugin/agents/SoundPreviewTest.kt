package com.anezium.rokidbus.plugin.agents

import android.media.AudioAttributes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** What a preview of each sound choice plays, and on which audio stream. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SoundPreviewTest {
    @Test
    fun a_preview_says_the_alerts_own_words_or_plays_the_chime_or_nothing() {
        assertEquals(PreviewCue.Say("Claude needs approval"), SoundPreviewPolicy.cue(SoundSlot.APPROVAL, SoundChoice.SPEAK))
        assertEquals(PreviewCue.Say("Claude is done"), SoundPreviewPolicy.cue(SoundSlot.DONE, SoundChoice.SPEAK))
        assertEquals(PreviewCue.Tone, SoundPreviewPolicy.cue(SoundSlot.DONE, SoundChoice.CHIME))
        assertEquals(PreviewCue.Silence, SoundPreviewPolicy.cue(SoundSlot.ERROR, SoundChoice.SILENT))
        // The same words as the real alert.
        val alert = AlertSoundPolicy.sound(AlertKind.QUESTION, AgentProvider.CLAUDE, AlertReason.NEW, SoundPrefs())
        assertEquals(AlertSound.Speak((SoundPreviewPolicy.cue(SoundSlot.QUESTION, SoundChoice.SPEAK) as PreviewCue.Say).text), alert)
    }

    @Test
    fun a_preview_plays_on_the_media_stream_so_the_phones_volume_keys_hear_it() {
        assertEquals(AudioAttributes.USAGE_MEDIA, SoundPreviewPolicy.ATTRIBUTES.usage)
        assertEquals(AudioAttributes.USAGE_MEDIA, SoundPreviewPolicy.SPEECH_ATTRIBUTES.usage)
        assertNotEquals("not the alert chime's route", AudioAttributes.USAGE_ASSISTANCE_SONIFICATION, SoundPreviewPolicy.ATTRIBUTES.usage)
    }
}
