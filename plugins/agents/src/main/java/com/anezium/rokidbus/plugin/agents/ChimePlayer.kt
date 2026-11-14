package com.anezium.rokidbus.plugin.agents

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRouting
import android.media.AudioTrack
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import kotlin.math.PI
import kotlin.math.sin

/** The Done chime's waveform: two short notes, rising. Pure, so its shape is tested. */
object ChimeTone {
    private const val FIRST_HZ = 880.0
    private const val FIRST_MS = 70
    private const val SECOND_HZ = 1320.0
    private const val SECOND_MS = 110
    private const val FADE_MS = 15

    /** Half of full scale is the loudest the chime ever gets; a nudge, never a startle. */
    private const val PEAK = 0.45

    fun pcm(sampleRate: Int = 44_100): ShortArray {
        val first = note(FIRST_HZ, FIRST_MS, sampleRate)
        val second = note(SECOND_HZ, SECOND_MS, sampleRate)
        return first + second
    }

    private fun note(hz: Double, ms: Int, sampleRate: Int): ShortArray {
        val count = sampleRate * ms / 1000
        val fade = sampleRate * FADE_MS / 1000
        return ShortArray(count) { i ->
            val gain = minOf(1.0, i.toDouble() / fade, (count - 1 - i).toDouble() / fade)
            (sin(2.0 * PI * hz * i / sampleRate) * PEAK * gain * Short.MAX_VALUE).toInt().toShort()
        }
    }
}

/**
 * Where the chime may be heard: only on a Bluetooth output, never the phone's
 * speaker. Every decision is here as a pure function of what Android reports, so
 * the player only has to ask.
 */
object ChimeRoute {
    private const val FIRST_API_WITH_ATTRIBUTE_ROUTES = 33

    private val BLUETOOTH_TYPES = setOf(
        AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        AudioDeviceInfo.TYPE_BLE_HEADSET,
        AudioDeviceInfo.TYPE_BLE_SPEAKER,
    )

    /** True when there is an output and every one of [outputs] (device types) is Bluetooth. */
    fun canPlay(outputs: List<Int>): Boolean = outputs.isNotEmpty() && outputs.all { it in BLUETOOTH_TYPES }

    /** The first Bluetooth output among [outputs], the device the chime is pinned to. */
    fun pick(outputs: List<AudioDeviceInfo>): AudioDeviceInfo? = outputs.firstOrNull { it.type in BLUETOOTH_TYPES }

    /**
     * A track may be built only when Android already routes a sonification stream to
     * Bluetooth alone. Below API 33 there is no way to ask, so there is no chime.
     */
    fun canStart(sdkInt: Int, devicesForAttributes: List<Int>): Boolean =
        sdkInt >= FIRST_API_WITH_ATTRIBUTE_ROUTES && canPlay(devicesForAttributes)

    /** The track plays muted until its routed device is Bluetooth; a missing one keeps it muted. */
    fun mayUnmute(routedType: Int?): Boolean = routedType != null && routedType in BLUETOOTH_TYPES

    /** The moment the route is anything but Bluetooth, or unknown, the chime stops. */
    fun keepPlaying(routedType: Int?): Boolean = mayUnmute(routedType)
}

/**
 * Plays the Done chime through the phone, to the glasses' Bluetooth audio, and
 * fails closed: if the sound could land on the phone's speaker it is dropped, so
 * a chime is never heard in a room that is not the wearer's ear. The track starts
 * muted and is unmuted only once its routed device is seen to be Bluetooth; a
 * route that changes to anything else mutes, stops and releases it at once, and so
 * does the system's "becoming noisy" broadcast, which comes before audio falls
 * back to the speaker. What is left is a Bluetooth drop inside the chime's 180 ms
 * with no broadcast, a device-checklist item (R191). Where the chime cannot play,
 * Done is display-only.
 */
class ChimePlayer(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var active: Playing? = null

    fun play() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(::play)
            return
        }
        active?.stop()
        active = null
        if (Build.VERSION.SDK_INT < 33) {
            Log.i(TAG, "chime_silent_below_api_33")
            return
        }
        val audio = context.getSystemService(AudioManager::class.java) ?: return
        val routed = audio.getAudioDevicesForAttributes(ATTRIBUTES)
        if (!ChimeRoute.canStart(Build.VERSION.SDK_INT, routed.map { it.type })) {
            Log.i(TAG, "chime_dropped_no_bt_output")
            return
        }
        val device = ChimeRoute.pick(routed) ?: run {
            Log.i(TAG, "chime_dropped_no_bt_output")
            return
        }
        val playing = Playing(device)
        active = playing
        runCatching { playing.start() }.onFailure {
            Log.w(TAG, "chime_failed ${it.javaClass.simpleName}")
            playing.stop()
        }
    }

    fun close() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            main.post(::close)
            return
        }
        active?.stop()
        active = null
    }

    private inner class Playing(private val device: AudioDeviceInfo) {
        private val pcm = ChimeTone.pcm(SAMPLE_RATE)
        private var track: AudioTrack? = null
        private var unmuted = false
        private var done = false
        private var noisy: BroadcastReceiver? = null
        private val timeout = Runnable { stop() }

        private val onRouting = AudioRouting.OnRoutingChangedListener { router -> onRoute(router.routedDevice, strict = true) }

        fun start() {
            val format = AudioFormat.Builder()
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .setSampleRate(SAMPLE_RATE)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .build()
            val built = AudioTrack.Builder()
                .setAudioAttributes(ATTRIBUTES)
                .setAudioFormat(format)
                .setTransferMode(AudioTrack.MODE_STATIC)
                .setBufferSizeInBytes(pcm.size * 2)
                .build()
            track = built
            built.write(pcm, 0, pcm.size)
            // Muted and pinned to the Bluetooth device before a single sample can sound.
            built.setVolume(0f)
            built.setPreferredDevice(device)
            built.addOnRoutingChangedListener(onRouting, main)
            noisy = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) {
                    Log.i(TAG, "chime_dropped_route noisy")
                    stop()
                }
            }.also {
                context.registerReceiver(
                    it,
                    IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                    Context.RECEIVER_NOT_EXPORTED,
                )
            }
            main.postDelayed(timeout, pcm.size * 1000L / SAMPLE_RATE + TAIL_MS)
            built.play()
            onRoute(built.routedDevice, strict = false)
        }

        /** [strict]: a routing change reported by Android, where no device is a drop; right after play() it may just not be routed yet. */
        private fun onRoute(routed: AudioDeviceInfo?, strict: Boolean) {
            if (done) return
            val type = routed?.type
            if (type == null && !strict) return // Not routed yet: stay muted until the listener says where.
            if (!ChimeRoute.keepPlaying(type)) {
                Log.i(TAG, "chime_dropped_route ${type ?: "none"}")
                stop()
                return
            }
            if (!unmuted && ChimeRoute.mayUnmute(type)) {
                unmuted = true
                track?.setVolume(1f)
            }
        }

        fun stop() {
            if (done) return
            done = true
            main.removeCallbacks(timeout)
            noisy?.let { runCatching { context.unregisterReceiver(it) } }
            noisy = null
            track?.let {
                runCatching {
                    it.setVolume(0f)
                    it.removeOnRoutingChangedListener(onRouting)
                    it.stop()
                }
                runCatching { it.release() }
            }
            track = null
            if (active === this) active = null
        }
    }

    private companion object {
        const val TAG = "AgentsChime"
        const val SAMPLE_RATE = 44_100
        const val TAIL_MS = 120L
        val ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }
}
