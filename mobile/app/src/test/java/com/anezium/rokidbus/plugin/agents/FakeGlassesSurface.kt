package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.phone.GlassesDeviceInfo
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.phone.NoticeCallbacks
import com.anezium.rokidbus.phone.SpeechHandle
import com.anezium.rokidbus.phone.SpeechListener
import com.anezium.rokidbus.phone.SurfaceListener
import com.anezium.rokidbus.phone.SurfaceState
import com.anezium.rokidbus.phone.TtsCallbacks

/**
 * The glasses as the Agents code sees them, with no hub behind: every call is recorded and
 * answered with [result], and a test plays the hub's side through [listener] and [notices].
 */
internal class FakeGlassesSurface : GlassesSurface {
    sealed interface Call {
        data class ShowCard(val card: NexusCard) : Call
        data class UpdateCard(val card: NexusCard) : Call
        data class ShowReader(val reader: NexusReader) : Call
        data class UpdateReader(val reader: NexusReader) : Call
        data object Hide : Call
        data class ShowNotice(val notice: NexusNotice) : Call
        data class UpdateNotice(val update: NexusNoticeUpdate) : Call
        data object HideNotice : Call
        data class Speak(val text: String, val utteranceId: String) : Call
        data object StopSpeaking : Call
        data class StartSpeech(val language: String?) : Call
    }

    inner class Handle(override val result: NexusSdkResult, val listener: SpeechListener) : SpeechHandle {
        var stops = 0
        override fun stop() {
            stops += 1
        }
    }

    val calls = mutableListOf<Call>()
    var result: NexusSdkResult = NexusSdkResult.SENT
    var speechResult: NexusSdkResult = NexusSdkResult.SENT
    var listener: SurfaceListener? = null
        private set
    var notices: NoticeCallbacks? = null
        private set
    var attaches = 0
        private set
    val speech = mutableListOf<Handle>()
    val tts = mutableMapOf<String, TtsCallbacks>()

    override var state = SurfaceState(
        lifecycle = SurfaceState.Lifecycle.CLOSED,
        linkState = 0,
        noticeSupported = true,
        noticeShownAckSupported = true,
        editableSupported = true,
        ttsSupported = true,
    )
    override var deviceInfo: GlassesDeviceInfo? = null

    inline fun <reified T : Call> callsOf(): List<T> = calls.filterIsInstance<T>()

    override fun attach(listener: SurfaceListener, notices: NoticeCallbacks) {
        attaches += 1
        this.listener = listener
        this.notices = notices
    }

    override fun detach() {
        listener = null
        notices = null
    }

    override fun showCard(card: NexusCard) = record(Call.ShowCard(card))
    override fun updateCard(card: NexusCard) = record(Call.UpdateCard(card))
    override fun showReader(reader: NexusReader) = record(Call.ShowReader(reader))
    override fun updateReader(reader: NexusReader) = record(Call.UpdateReader(reader))
    override fun hide() = record(Call.Hide)
    override fun showNotice(notice: NexusNotice) = record(Call.ShowNotice(notice))
    override fun updateNotice(update: NexusNoticeUpdate) = record(Call.UpdateNotice(update))
    override fun hideNotice() = record(Call.HideNotice)

    override fun speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult {
        val answer = record(Call.Speak(text, utteranceId))
        if (answer == NexusSdkResult.SENT) tts[utteranceId] = callbacks
        return answer
    }

    override fun stopSpeaking() {
        calls += Call.StopSpeaking
    }

    override fun startSpeech(language: String?, listener: SpeechListener): SpeechHandle {
        calls += Call.StartSpeech(language)
        return Handle(speechResult, listener).also(speech::add)
    }

    /** The hub opened the surface, as it does for a launcher open or an adoption. */
    fun open(openType: String = "open") {
        state = state.copy(lifecycle = SurfaceState.Lifecycle.OPEN)
        listener!!.onOpen(openType)
    }

    fun close() {
        state = state.copy(lifecycle = SurfaceState.Lifecycle.CLOSED)
        listener!!.onClose()
    }

    private fun record(call: Call): NexusSdkResult {
        calls += call
        return result
    }
}
