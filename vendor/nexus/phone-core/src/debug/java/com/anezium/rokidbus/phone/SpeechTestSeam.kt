package com.anezium.rokidbus.phone

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.anezium.rokidbus.phone.speech.AndroidRecognizerEnvironment
import com.anezium.rokidbus.phone.speech.AndroidRecognizerTarget
import com.anezium.rokidbus.phone.speech.AndroidSpeechRecognizer
import com.example.cxrglobal.CxrDefs
import com.example.cxrglobal.callbacks.IAudioStreamCbk
import com.example.cxrglobal.callbacks.ICXRLinkCbk
import com.example.cxrglobal.callbacks.ICustomCmdCbk
import com.example.cxrglobal.callbacks.IGlassAppCbk
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Debug builds only (`src/debug`): a [HubCore] whose glasses and Android recognizer are a test's,
 * so an on-device test runs whole speech sessions through the real session manager, the real
 * AndroidSttSession and the shell's microphone promotion, with no glasses and no speech service.
 * A release build has no way to reach [HubCoreSeams].
 */
object SpeechTestSeam {
    fun hubCore(context: Context, config: HubCoreConfig, glasses: Glasses, recognizer: Recognizer): HubCore =
        HubCore(context, config, HubCoreSeams(cxr = glasses.transport, recognizer = recognizer.environment))

    /** Glasses linked over CXR whose microphone streams exactly the 16 kHz mono PCM a test pushes. */
    class Glasses {
        @Volatile private var link: ICXRLinkCbk? = null
        @Volatile private var audio: IAudioStreamCbk? = null
        @Volatile private var connected = false

        /** True while the hub holds the glasses' audio stream open. */
        @Volatile var streaming = false
            private set

        @Volatile var streamStarts = 0
            private set

        /** The CXR service and the glasses' Bluetooth come up, as after a real connect. */
        fun linkUp() {
            connected = true
            link?.onCXRLConnected(true)
            link?.onGlassBtConnected(true)
        }

        /** Delivers [pcm] as the glasses' microphone would; false while no stream is open. */
        fun push(pcm: ByteArray): Boolean {
            val callback = audio?.takeIf { streaming } ?: return false
            callback.onAudioReceived(pcm, 0, pcm.size)
            return true
        }

        internal val transport: CxrTransport = object : CxrTransport {
            override fun configCXRSession(session: CxrDefs.CXRSession): Boolean = true
            override fun setCXRLinkCbk(cbk: ICXRLinkCbk?) { link = cbk }
            override fun setCXRCustomCmdCbk(cbk: ICustomCmdCbk?) = Unit
            override fun setCXRAudioCbk(cbk: IAudioStreamCbk?) { audio = cbk }
            override fun connect(token: String): Boolean {
                connected = true
                return true
            }
            override fun disconnect() { connected = false }
            override fun isServiceConnected(): Boolean = connected
            override fun sendCustomCmd(key: String, payload: ByteArray): Int? = 0
            override fun startAudioStream(codeType: Int): Boolean {
                streamStarts += 1
                streaming = true
                return true
            }
            override fun stopAudioStream(): Boolean {
                streaming = false
                return true
            }
            override fun setInterruptAiWake(interrupt: Boolean): Boolean = true
            override fun sendExit(playSound: Boolean): Boolean = true
            override fun setBrightness(level: Int): Boolean = true
            override fun setVolume(level: Int): Boolean = true
            override fun appStart(activityName: String, cbk: IGlassAppCbk) = Unit
            override fun appIsInstalled(cbk: IGlassAppCbk) = Unit
            override fun appUploadAndInstall(filePath: String, cbk: IGlassAppCbk) = Unit
        }
    }

    /**
     * The platform recognizer's stand-in: each session reads its injected audio to the end, the
     * way the real one does, then answers the next of [transcripts]. RECORD_AUDIO is the real grant.
     */
    class Recognizer(private val context: Context, transcripts: List<String>) {
        private val answers = ArrayDeque(transcripts)
        private val main = Handler(Looper.getMainLooper())

        /** The bytes each session read from the hub's pipe, in order. */
        val bytesHeard = CopyOnWriteArrayList<Long>()

        internal val environment: AndroidRecognizerEnvironment = object : AndroidRecognizerEnvironment {
            override val sdkInt: Int get() = Build.VERSION.SDK_INT
            override fun hasRecordAudioPermission(): Boolean =
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            override fun isRecognitionAvailable(): Boolean = true
            override fun recognitionTargets(): List<AndroidRecognizerTarget> = listOf(
                AndroidRecognizerTarget(id = "speech-test", reportName = "speech-test", segmentedSession = false) { Scripted() },
            )
        }

        private inner class Scripted : AndroidSpeechRecognizer {
            @Volatile private var listener: RecognitionListener? = null
            @Volatile private var ended = false

            override fun setRecognitionListener(listener: RecognitionListener) {
                this.listener = listener
            }

            override fun startListening(intent: Intent) {
                @Suppress("DEPRECATION")
                val source = intent.getParcelableExtra<ParcelFileDescriptor>(RecognizerIntent.EXTRA_AUDIO_SOURCE)
                    ?.let { runCatching { it.dup() }.getOrNull() }
                if (source == null) {
                    post { it.onError(SpeechRecognizer.ERROR_CLIENT) }
                    return
                }
                Thread({
                    var total = 0L
                    runCatching {
                        ParcelFileDescriptor.AutoCloseInputStream(source).use { input ->
                            val buffer = ByteArray(4096)
                            while (true) {
                                val read = input.read(buffer)
                                if (read < 0) break
                                total += read
                            }
                        }
                    }
                    bytesHeard += total
                    val text = synchronized(answers) { answers.removeFirstOrNull() }.orEmpty()
                    post { listener ->
                        listener.onResults(
                            Bundle().apply { putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf(text)) },
                        )
                    }
                }, "speech-test-recognizer").start()
            }

            override fun stopListening() = Unit

            override fun cancel() {
                ended = true
            }

            override fun destroy() {
                ended = true
            }

            private fun post(event: (RecognitionListener) -> Unit) {
                main.post { if (!ended) listener?.let(event) }
            }
        }
    }
}
