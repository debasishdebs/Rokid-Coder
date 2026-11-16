package com.anezium.rokidbus.plugin.agents

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.util.Log
import java.util.UUID

/** What a tap on one sound choice lets the user hear. */
sealed interface PreviewCue {
    data class Say(val text: String) : PreviewCue
    data object Tone : PreviewCue
    data object Silence : PreviewCue
}

/**
 * The preview of a sound, played on this phone on the user's own tap. An alert's chime is held
 * to a Bluetooth output ([ChimePlayer]) and its spoken line goes out through the glasses, so
 * neither would be heard from the phone while someone is choosing; this is the way to hear the sound.
 */
object SoundPreviewPolicy {
    /** Media volume, the one the phone's own volume keys set while a sound is previewed. */
    val ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    val SPEECH_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

    /** The spoken line is the alert's own, with Claude as the tool's name. */
    fun cue(slot: SoundSlot, choice: SoundChoice): PreviewCue = when (choice) {
        SoundChoice.SPEAK -> PreviewCue.Say("Claude ${AlertSoundPolicy.phrase(slot)}")
        SoundChoice.CHIME -> PreviewCue.Tone
        SoundChoice.SILENT -> PreviewCue.Silence
    }
}

class SoundPreview(private val context: Context, private val onUnavailable: (String) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var track: AudioTrack? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var waiting: String? = null
    private val release = Runnable { stopTrack() }

    fun play(slot: SoundSlot, choice: SoundChoice) {
        stop()
        when (val cue = SoundPreviewPolicy.cue(slot, choice)) {
            is PreviewCue.Say -> say(cue.text)
            PreviewCue.Tone -> tone()
            PreviewCue.Silence -> Unit
        }
    }

    fun close() {
        stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
    }

    private fun stop() {
        waiting = null
        tts?.stop()
        stopTrack()
    }

    private fun tone() {
        val pcm = ChimeTone.pcm(SAMPLE_RATE)
        runCatching {
            val built = AudioTrack.Builder()
                .setAudioAttributes(SoundPreviewPolicy.ATTRIBUTES)
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(SAMPLE_RATE)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track = built
            built.write(pcm, 0, pcm.size)
            built.play()
            main.postDelayed(release, pcm.size * 1000L / SAMPLE_RATE + TAIL_MS)
        }.onFailure {
            Log.w(TAG, "preview_tone_failed ${it.javaClass.simpleName}")
            stopTrack()
            onUnavailable(NO_SOUND)
        }
    }

    private fun stopTrack() {
        main.removeCallbacks(release)
        track?.let {
            runCatching { it.stop() }
            runCatching { it.release() }
        }
        track = null
    }

    private fun say(text: String) {
        if (ttsReady) return speakNow(text)
        waiting = text
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { status ->
            main.post {
                if (status != TextToSpeech.SUCCESS) {
                    tts = null
                    waiting = null
                    onUnavailable(NO_SPEECH)
                    return@post
                }
                ttsReady = true
                tts?.setAudioAttributes(SoundPreviewPolicy.SPEECH_ATTRIBUTES)
                waiting?.let(::speakNow)
                waiting = null
            }
        }
    }

    private fun speakNow(text: String) {
        val engine = tts ?: return
        if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, UUID.randomUUID().toString()) != TextToSpeech.SUCCESS) onUnavailable(NO_SPEECH)
    }

    companion object {
        const val NO_SOUND = "Couldn't play the sound on this phone."
        const val NO_SPEECH = "This phone has no text-to-speech voice to preview with."
        private const val TAG = "AgentsPreview"
        private const val SAMPLE_RATE = 44_100
        private const val TAIL_MS = 150L
    }
}
