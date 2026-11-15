@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.Manifest
import android.app.Application
import android.os.Looper
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechState
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.client.plugin.NexusTtsDoneReason
import com.anezium.rokidbus.phone.speech.SpeechEngine
import com.anezium.rokidbus.phone.speech.SpeechPatience
import com.anezium.rokidbus.phone.speech.SpeechReadiness
import com.anezium.rokidbus.phone.speech.SpeechSttSessionFactory
import com.anezium.rokidbus.phone.speech.SttSession
import com.anezium.rokidbus.phone.speech.SttSessionListener
import com.anezium.rokidbus.phone.speech.TranscriptionLanguage
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.BusCapabilityBits
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.EditableSurfaceContract
import com.anezium.rokidbus.shared.GlassesHubCapabilitiesContract
import com.anezium.rokidbus.shared.NoticeSurfaceContract
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import com.anezium.rokidbus.shared.plugin.PluginCapability
import org.junit.Assert.fail
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import java.util.Locale
import java.util.concurrent.CopyOnWriteArrayList

/** The upstream shells' pair. */
internal val UPSTREAM_PAIR = AppIdentity("com.anezium.rokidbus.phone", "com.anezium.rokidbus.glasses")

/** Rokid Coder's pair. */
internal val ROKID_CODER_PAIR = AppIdentity("io.github.debasishdebs.rokidcoder", "io.github.debasishdebs.rokidcoder.glasses")

internal val AGENTS_APP = InProcessApp(
    pluginId = "agents",
    displayName = "Agents",
    iconKey = "terminal",
    capabilities = setOf(PluginCapability.SURFACES, PluginCapability.STT, PluginCapability.TTS),
    receivePrefixes = listOf("/plugin/agents", "/system/plugin", "/stt", "/tts/started", "/tts/done"),
)

/** A real HubCore with fake radios, a fake speaker and, optionally, a fake speech engine. */
internal class HubCoreHarness(
    app: InProcessApp? = AGENTS_APP,
    hooks: HubShellHooks = HubShellHooks.None,
    identity: AppIdentity = UPSTREAM_PAIR,
) {
    val context: Application = RuntimeEnvironment.getApplication()
    val cxr = FakeCxrTransport()
    val tts = FakeTtsOutput()
    val stt = FakeSttFactory()
    val host = RecordingHost()
    val logs = CopyOnWriteArrayList<String>()
    val journal = PluginBusJournal().apply { enabled.set(true) }
    @Volatile var sppUp = true

    val core: HubCore

    init {
        shadowOf(context).grantPermissions(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.RECORD_AUDIO)
        context.getSharedPreferences(HubPrefs.PREFS, 0).edit().clear().putString("cxrl_token", "test-token").commit()
        context.getSharedPreferences("nexus_speech_settings", 0).edit().clear().commit()
        core = HubCore(
            context,
            if (hooks === HubShellHooks.None) {
                HubCoreConfig(foreground = host, identity = identity, inProcessApp = app, journal = journal, log = { logs += it })
            } else {
                HubCoreConfig(foreground = host, identity = identity, hooks = hooks, journal = journal, log = { logs += it })
            },
            HubCoreSeams(
                cxr = cxr,
                ttsOutput = tts,
                ttsRoute = { PhoneTtsRoute.EXTERNAL_SINK },
                sppDataUp = { sppUp },
            ),
        )
        core.speech.register(SpeechEngine.ANDROID_RECOGNIZER, stt) { SpeechReadiness.READY }
    }

    /** start(), then the glasses come up over CXR and announce what they can draw. */
    fun startLinked(): HubCoreHarness {
        core.start()
        cxr.linkUp()
        announceGlasses()
        settle()
        return this
    }

    fun announceGlasses(versionName: String? = "1.0.0") {
        val capabilities = GlassesHubCapabilitiesContract.create(
            features = BusCapabilityBits.NOTICE_SURFACE or BusCapabilityBits.EDITABLE_SURFACE or
                BusCapabilityBits.NOTICE_SHOWN_ACK,
            imageSurfaceVersion = 0,
            noticeSurfaceVersion = NoticeSurfaceContract.VERSION,
            editableSurfaceVersion = EditableSurfaceContract.VERSION,
            maxImageBytes = 0,
            versionName = versionName,
        )
        cxr.inject(
            BusEnvelope(
                path = BusPaths.HUB_CAPABILITIES,
                payload = GlassesHubCapabilitiesContract.toJson(capabilities),
            ),
        )
    }

    /** Runs the main looper and lets the core's worker threads drain. */
    fun settle(rounds: Int = 15) {
        repeat(rounds) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(5)
        }
        shadowOf(Looper.getMainLooper()).idle()
    }

    // Generous: hosted CI runners are several times slower than a laptop; a pass returns early.
    fun await(what: String, timeoutMs: Long = 20_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            Thread.sleep(5)
        }
        shadowOf(Looper.getMainLooper()).idle()
        if (!condition()) fail("timed out waiting for $what")
    }

    /**
     * Speech sessions the hub has ended: each `/stt/session/ended` it delivered. The SDK reports a
     * stop's CANCELLED at once, but the hub ends the session later and answers a start BUSY until then.
     */
    fun speechSessionsEnded(): Int = journal.snapshot().count {
        it.direction == PluginBusJournal.Direction.HUB_TO_PLUGIN && it.path == SttWireProtocol.SESSION_ENDED_PATH
    }

    /** The glasses open the app from their launcher. */
    fun launcherOpen(pluginId: String = "agents") {
        cxr.inject(BusEnvelope(path = BusPaths.LAUNCHER_OPEN, payload = org.json.JSONObject().put("pluginId", pluginId)))
    }
}

internal class RecordingHost : HubForegroundHost {
    val promotions = CopyOnWriteArrayList<Boolean>()
    val linkStates = CopyOnWriteArrayList<Int>()
    @Volatile var failure: Throwable? = null

    override fun promote(microphone: Boolean): Throwable? {
        promotions += microphone
        return failure
    }

    override fun onLinkStateChanged(linkState: Int) {
        linkStates += linkState
    }
}

internal class FakeTtsOutput : PhoneTtsOutput {
    @Volatile private var output: PhoneTtsOutput.Listener? = null
    val spoken = CopyOnWriteArrayList<String>()
    @Volatile var stops = 0

    override val isReady: Boolean = true
    override fun setListener(listener: PhoneTtsOutput.Listener) { output = listener }
    override fun initialize() = Unit
    override fun speak(utteranceId: String, text: String, locale: Locale): PhoneTtsSpeakResult {
        spoken += utteranceId
        return PhoneTtsSpeakResult.ACCEPTED
    }
    override fun prewarm(): Boolean = true
    override fun availableVoices(locale: Locale?): List<PhoneTtsVoiceOption> = emptyList()
    override fun speakSample(text: String, locale: Locale): Boolean = true
    override fun stop() { stops += 1 }
    override fun shutdown() = Unit

    fun started(index: Int = spoken.lastIndex) = output!!.onStart(spoken[index])
    fun finished(index: Int = spoken.lastIndex) = output!!.onDone(spoken[index])
}

/** A speech engine whose results the test types in. */
internal class FakeSttFactory : SpeechSttSessionFactory {
    val sessions = CopyOnWriteArrayList<FakeStt>()

    override fun create(
        engine: SpeechEngine,
        language: TranscriptionLanguage,
        phoneLanguageTag: String,
        patience: SpeechPatience,
        listener: SttSessionListener,
    ): SttSession = FakeStt(listener).also { sessions += it }

    class FakeStt(val listener: SttSessionListener) : SttSession {
        @Volatile var cancelled = false
        override fun start(): Boolean = true
        override fun acceptPcm(data: ByteArray, offset: Int, length: Int) = Unit
        override fun finishAudio() = Unit
        override fun cancel() { cancelled = true }
    }
}

/** Records every SurfaceListener and NoticeCallbacks callback, with the thread it ran on. */
internal class RecordingSurfaceListener : SurfaceListener {
    val events = CopyOnWriteArrayList<String>()
    val offMain = CopyOnWriteArrayList<String>()
    val states = CopyOnWriteArrayList<SurfaceState>()
    val inputs = CopyOnWriteArrayList<NexusInputEvent>()
    val devices = CopyOnWriteArrayList<GlassesDeviceInfo>()

    private fun record(event: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) offMain += event
        events += event
    }

    override fun onOpen(openType: String) = record("open:$openType")
    override fun onBackground() = record("background")
    override fun onClose() = record("close")
    override fun onStateChanged(state: SurfaceState) {
        states += state
        record("state")
    }
    override fun onDeviceInfo(info: GlassesDeviceInfo) {
        devices += info
        record("device")
    }
    override fun onSurfaceRejected(code: String) = record("rejected:$code")
    override fun onInput(event: NexusInputEvent) {
        inputs += event
        record("input:${event.keyCode}")
    }
    override fun onTextCommitted(surfaceId: String, text: String, cancelled: Boolean) =
        record("text:$surfaceId:$text:$cancelled")

    fun count(event: String): Int = events.count { it == event }
}

internal class RecordingNotices : NoticeCallbacks {
    val events = CopyOnWriteArrayList<String>()
    override fun onShown() { events += "shown" }
    override fun onInput(event: NexusInputEvent) { events += "input:${event.keyCode}" }
    override fun onAction(id: String) { events += "action:$id" }
    override fun onClosed(reason: NexusNoticeCloseReason) { events += "closed:$reason" }
}

internal class RecordingSpeech : SpeechListener {
    val events = CopyOnWriteArrayList<String>()
    val offMain = CopyOnWriteArrayList<String>()
    private fun record(event: String) {
        if (Looper.myLooper() != Looper.getMainLooper()) offMain += event
        events += event
    }
    override fun onStarted(realtime: Boolean) = record("started:$realtime")
    override fun onState(state: NexusSpeechState) = record("state:$state")
    override fun onPartial(text: String) = record("partial:$text")
    override fun onFinal(text: String) = record("final:$text")
    override fun onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?) = record("stopped:$reason")
    fun stops(): List<String> = events.filter { it.startsWith("stopped:") }
}

internal class RecordingTts : TtsCallbacks {
    val events = CopyOnWriteArrayList<String>()
    override fun onStarted(utteranceId: String) { events += "started:$utteranceId" }
    override fun onDone(utteranceId: String, reason: NexusTtsDoneReason) { events += "done:$utteranceId:$reason" }
}
