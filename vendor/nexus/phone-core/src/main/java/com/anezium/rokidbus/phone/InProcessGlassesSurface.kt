package com.anezium.rokidbus.phone

import android.os.Handler
import android.os.Looper
import com.anezium.rokidbus.client.PluginRegistrationResult
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusPluginCallbacks
import com.anezium.rokidbus.client.plugin.NexusPluginClient
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechCallbacks
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechSession
import com.anezium.rokidbus.client.plugin.NexusSpeechState
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.client.plugin.NexusSurfaceSession
import com.anezium.rokidbus.client.plugin.NexusTtsCallbacks
import com.anezium.rokidbus.client.plugin.NexusTtsDoneReason
import com.anezium.rokidbus.client.plugin.NexusTtsSession
import com.anezium.rokidbus.client.plugin.speechSession
import com.anezium.rokidbus.client.plugin.surfaceSession
import com.anezium.rokidbus.client.plugin.ttsSession
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import com.anezium.rokidbus.shared.plugin.PluginOpenTypes
import org.json.JSONObject

/**
 * [GlassesSurface] over the SDK's own [NexusPluginClient], connected to the core through
 * [InProcessPluginTransport]. The notice, speech, TTS and preflight semantics are the SDK's.
 *
 * Every field is read and written on the main thread. Each posted callback carries the listener
 * generation (bumped by attach and detach) and the client epoch (bumped when start() makes a new
 * client), and is dropped if either changed before it runs.
 */
internal class InProcessGlassesSurface(
    private val app: InProcessApp,
    private val hub: InProcessHub,
    private val main: Handler = Handler(Looper.getMainLooper()),
) : GlassesSurface {
    private enum class RunState { REQUESTED, ACCEPTED, STOP_LATCHED, ENDED }

    private var generation = 0L
    private var epoch = 0L
    private var listener: SurfaceListener? = null
    private var notices: NoticeCallbacks? = null
    private var client: NexusPluginClient? = null
    private var surfaceSession: NexusSurfaceSession? = null
    private var ttsSession: NexusTtsSession? = null
    private val utterances = linkedMapOf<String, TtsCallbacks>()
    private var speechRun: SpeechRun? = null
    private var lifecycle = SurfaceState.Lifecycle.CLOSED
    private var linkState = 0
    private var noticeUp = false

    @Volatile override var deviceInfo: GlassesDeviceInfo? = null
        private set

    override val state: SurfaceState
        get() {
            val current = client
            return SurfaceState(
                lifecycle = lifecycle,
                linkState = linkState,
                noticeSupported = current?.supportsNoticeSurface == true,
                noticeShownAckSupported = current?.supportsNoticeShownAck == true,
                editableSupported = current?.supportsEditableSurface == true,
                ttsSupported = current?.supportsTts == true,
            )
        }

    // ---- driven by HubCore, on the main thread ----

    fun onCoreStarted() {
        if (client != null) return
        epoch += 1
        val transport = InProcessPluginTransport(app, hub, main)
        val created = NexusPluginClient.createWithTransport(app.pluginId, SdkCallbacks(epoch), transport)
        client = created
        surfaceSession = created.surfaceSession(app.pluginId).also { session ->
            val sessionEpoch = epoch
            session.onRejected = { code ->
                if (sessionEpoch == epoch) postListener { it.onSurfaceRejected(code) }
            }
        }
        created.connect()
    }

    /**
     * Release before close: the listener hears CANCELLED and STOPPED, never the ERROR and
     * UNAVAILABLE that closing the SDK client would report, and then onClose.
     */
    fun onCoreStopping() {
        val current = client ?: return
        speechRun?.let { run ->
            if (run.state == RunState.REQUESTED || run.state == RunState.ACCEPTED) {
                postTerminal { run.listener.onStopped(NexusSpeechStopReason.CANCELLED, null) }
            }
            run.state = RunState.ENDED
        }
        speechRun = null
        val pending = utterances.toList()
        utterances.clear()
        pending.forEach { (id, callbacks) -> postTerminal { callbacks.onDone(id, NexusTtsDoneReason.STOPPED) } }
        if (lifecycle != SurfaceState.Lifecycle.CLOSED) {
            lifecycle = SurfaceState.Lifecycle.CLOSED
            listener?.let { target -> postTerminal { target.onClose() } }
        }
        noticeUp = false
        client = null
        surfaceSession = null
        ttsSession = null
        current.close()
    }

    // ---- lifecycle ----

    override fun attach(listener: SurfaceListener, notices: NoticeCallbacks) {
        checkMain()
        if (this.listener != null) detachOnMain()
        generation += 1
        this.listener = listener
        this.notices = notices
        val snapshot = state
        postListener { it.onStateChanged(snapshot) }
        deviceInfo?.let { info -> postListener { it.onDeviceInfo(info) } }
    }

    override fun detach() = onMain(::detachOnMain)

    private fun detachOnMain() {
        if (listener == null) return
        generation += 1
        listener = null
        notices = null
        speechRun?.let { run ->
            when (run.state) {
                RunState.REQUESTED -> run.state = RunState.STOP_LATCHED
                RunState.ACCEPTED -> {
                    run.state = RunState.ENDED
                    run.session.stop()
                }
                RunState.STOP_LATCHED, RunState.ENDED -> Unit
            }
        }
        utterances.clear()
        ttsSession?.close()
        ttsSession = null
        if (noticeUp) {
            client?.hideNotice()
            noticeUp = false
        }
        if (lifecycle == SurfaceState.Lifecycle.OPEN) surfaceSession?.hide()
        lifecycle = SurfaceState.Lifecycle.CLOSED
    }

    // ---- cards and readers ----

    override fun showCard(card: NexusCard): NexusSdkResult = withSurface { it.showCard(card) }

    override fun updateCard(card: NexusCard): NexusSdkResult = withSurface { it.updateCard(card) }

    override fun showReader(reader: NexusReader): NexusSdkResult = withSurface { it.showReader(reader) }

    override fun updateReader(reader: NexusReader): NexusSdkResult = withSurface { it.updateReader(reader) }

    override fun hide(): NexusSdkResult = withSurface { it.hide() }

    // ---- notices ----

    override fun showNotice(notice: NexusNotice): NexusSdkResult = withClient { current ->
        current.showNotice(notice).also { if (it == NexusSdkResult.SENT) noticeUp = true }
    }

    override fun updateNotice(update: NexusNoticeUpdate): NexusSdkResult =
        withClient { it.updateNotice(update) }

    override fun hideNotice(): NexusSdkResult = withClient { current ->
        current.hideNotice().also { if (it == NexusSdkResult.SENT) noticeUp = false }
    }

    // ---- TTS ----

    override fun speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult =
        withClient { current ->
            val session = ttsSession ?: current.ttsSession(TtsBridge(epoch)).also { ttsSession = it }
            session.speak(text, utteranceId).also { result ->
                if (result == NexusSdkResult.SENT) utterances[utteranceId] = callbacks
            }
        }

    override fun stopSpeaking() = onMain { ttsSession?.stop() }

    // ---- STT ----

    override fun startSpeech(language: String?, listener: SpeechListener): SpeechHandle {
        checkMain()
        if (this.listener == null) return EndedHandle(NexusSdkResult.NOT_REGISTERED)
        val current = client ?: return EndedHandle(NexusSdkResult.NOT_REGISTERED)
        val running = speechRun
        if (running != null && running.state != RunState.ENDED) {
            return EndedHandle(NexusSdkResult.CAPABILITY_NOT_AVAILABLE)
        }
        val run = SpeechRun(listener, epoch)
        run.session = current.speechSession(run)
        val result = run.session.start(language)
        run.result = result
        if (result != NexusSdkResult.SENT) {
            run.state = RunState.ENDED
            return run
        }
        run.state = RunState.REQUESTED
        speechRun = run
        return run
    }

    private inner class SpeechRun(
        val listener: SpeechListener,
        private val clientEpoch: Long,
    ) : NexusSpeechCallbacks, SpeechHandle {
        lateinit var session: NexusSpeechSession
        var state = RunState.REQUESTED
        override var result: NexusSdkResult = NexusSdkResult.SENT

        override fun stop() = onMain(::stopOnMain)

        private fun stopOnMain() {
            when (state) {
                // The SDK cannot stop a pending start; the stop frame goes out on acceptance.
                RunState.REQUESTED -> {
                    state = RunState.STOP_LATCHED
                    post { listener.onStopped(NexusSpeechStopReason.CANCELLED, null) }
                }
                // The SDK sends the stop frame and reports CANCELLED synchronously; that report
                // reaches onSpeechStopped below, which posts it.
                RunState.ACCEPTED -> session.stop()
                RunState.STOP_LATCHED, RunState.ENDED -> Unit
            }
        }

        private val live: Boolean get() = clientEpoch == epoch && client != null

        override fun onSpeechStarted(realtime: Boolean) {
            if (!live) return
            when (state) {
                RunState.REQUESTED -> {
                    state = RunState.ACCEPTED
                    post { listener.onStarted(realtime) }
                }
                RunState.STOP_LATCHED -> {
                    state = RunState.ENDED
                    session.stop()
                }
                RunState.ACCEPTED, RunState.ENDED -> Unit
            }
        }

        override fun onSpeechState(state: NexusSpeechState) {
            if (live && this.state == RunState.ACCEPTED) post { listener.onState(state) }
        }

        override fun onSpeechPartial(text: String) {
            if (live && state == RunState.ACCEPTED) post { listener.onPartial(text) }
        }

        override fun onSpeechFinal(text: String) {
            if (live && state == RunState.ACCEPTED) post { listener.onFinal(text) }
        }

        override fun onSpeechStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?) {
            when (state) {
                RunState.REQUESTED, RunState.ACCEPTED -> {
                    state = RunState.ENDED
                    if (live) post { listener.onStopped(reason, error) }
                }
                RunState.STOP_LATCHED -> state = RunState.ENDED
                RunState.ENDED -> Unit
            }
        }
    }

    private class EndedHandle(override val result: NexusSdkResult) : SpeechHandle {
        override fun stop() = Unit
    }

    private inner class TtsBridge(private val clientEpoch: Long) : NexusTtsCallbacks {
        override fun onTtsStarted(utteranceId: String) {
            if (clientEpoch != epoch) return
            val callbacks = utterances[utteranceId] ?: return
            post { callbacks.onStarted(utteranceId) }
        }

        override fun onTtsDone(utteranceId: String, reason: NexusTtsDoneReason) {
            if (clientEpoch != epoch) return
            val callbacks = utterances.remove(utteranceId) ?: return
            post { callbacks.onDone(utteranceId, reason) }
        }
    }

    private inner class SdkCallbacks(private val clientEpoch: Long) : NexusPluginCallbacks {
        private val live: Boolean get() = clientEpoch == epoch && client != null

        override fun onOpen() = onOpen(PluginOpenTypes.OPEN)

        override fun onOpen(openType: String) {
            if (!live) return
            if (listener == null) {
                // Nobody draws while detached, so the hub must not hold this open.
                surfaceSession?.hide()
                return
            }
            lifecycle = SurfaceState.Lifecycle.OPEN
            postListener { it.onOpen(openType) }
        }

        override fun onBackground() {
            if (!live) return
            lifecycle = SurfaceState.Lifecycle.BACKGROUND
            postListener { it.onBackground() }
        }

        override fun onClose() {
            if (!live) return
            val wasOpen = lifecycle != SurfaceState.Lifecycle.CLOSED
            lifecycle = SurfaceState.Lifecycle.CLOSED
            if (wasOpen) postListener { it.onClose() }
        }

        override fun onInput(event: NexusInputEvent) {
            if (live) postListener { it.onInput(event) }
        }

        override fun onLinkState(state: Int) {
            if (!live) return
            linkState = state
            val snapshot = this@InProcessGlassesSurface.state
            postListener { it.onStateChanged(snapshot) }
        }

        override fun onRegistrationState(result: Int) {
            if (!live || result != PluginRegistrationResult.APPROVED) return
            val snapshot = state
            postListener { it.onStateChanged(snapshot) }
        }

        override fun onNoticeClosed(reason: NexusNoticeCloseReason) {
            if (!live) return
            noticeUp = false
            postNotices { it.onClosed(reason) }
        }

        override fun onNoticeShown() {
            if (live) postNotices { it.onShown() }
        }

        override fun onNoticeInput(event: NexusInputEvent) {
            if (live) postNotices { it.onInput(event) }
        }

        override fun onNoticeAction(id: String) {
            if (live) postNotices { it.onAction(id) }
        }

        override fun onSurfaceTextCommitted(surfaceId: String, text: String, cancelled: Boolean) {
            if (live) postListener { it.onTextCommitted(surfaceId, text, cancelled) }
        }

        override fun onMessage(path: String, id: String, payload: JSONObject) {
            if (!live || path != BusPaths.GLASSES_DEVICE_INFO) return
            val info = GlassesDeviceInfo(
                deviceName = payload.optString("deviceName"),
                batteryLevel = payload.optInt("batteryLevel", -1).takeIf { it >= 0 },
                volume = payload.optInt("sound", -1).takeIf { it >= 0 },
                brightness = payload.optInt("brightness", -1).takeIf { it >= 0 },
                systemVersion = payload.optString("systemVersion"),
                isCharging = payload.optBoolean("isCharging", false),
                wearingStatus = payload.optString("wearingStatus"),
            )
            deviceInfo = info
            postListener { it.onDeviceInfo(info) }
        }
    }

    // ---- plumbing ----

    private fun withClient(call: (NexusPluginClient) -> NexusSdkResult): NexusSdkResult {
        checkMain()
        if (listener == null) return NexusSdkResult.NOT_REGISTERED
        val current = client ?: return NexusSdkResult.NOT_REGISTERED
        return call(current)
    }

    private fun withSurface(call: (NexusSurfaceSession) -> NexusSdkResult): NexusSdkResult =
        withClient { surfaceSession?.let(call) ?: NexusSdkResult.NOT_REGISTERED }

    /** Runs [action] for the current listener generation and client epoch only. */
    private fun post(action: () -> Unit) {
        val stampedGeneration = generation
        val stampedEpoch = epoch
        main.post {
            if (stampedGeneration == generation && stampedEpoch == epoch) action()
        }
    }

    /** A terminal callback of a client being closed: survives the next start(), not a detach. */
    private fun postTerminal(action: () -> Unit) {
        val stampedGeneration = generation
        main.post { if (stampedGeneration == generation) action() }
    }

    private fun postListener(action: (SurfaceListener) -> Unit) {
        val target = listener ?: return
        post { action(target) }
    }

    private fun postNotices(action: (NoticeCallbacks) -> Unit) {
        val target = notices ?: return
        post { action(target) }
    }

    private fun onMain(action: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) action() else main.post(action)
    }

    private fun checkMain() {
        check(Looper.myLooper() == Looper.getMainLooper()) { "GlassesSurface must be called on the main thread" }
    }
}
