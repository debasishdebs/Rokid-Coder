package com.anezium.rokidbus.phone

import androidx.annotation.AnyThread
import androidx.annotation.MainThread
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechState
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.client.plugin.NexusTtsDoneReason
import com.anezium.rokidbus.shared.LinkStateBits
import com.anezium.rokidbus.shared.plugin.NexusInputEvent

/**
 * The in-process app's view of the glasses: the SDK's surface, notice, speech and TTS semantics,
 * without the plugin lifecycle. Calls are main-thread-confined except [detach], [stopSpeaking]
 * and [SpeechHandle.stop]; every callback is posted to the main thread, in order.
 */
interface GlassesSurface {
    val state: SurfaceState
    val deviceInfo: GlassesDeviceInfo?

    @MainThread fun attach(listener: SurfaceListener, notices: NoticeCallbacks)
    @AnyThread fun detach()

    @MainThread fun showCard(card: NexusCard): NexusSdkResult
    @MainThread fun updateCard(card: NexusCard): NexusSdkResult
    @MainThread fun showReader(reader: NexusReader): NexusSdkResult
    @MainThread fun updateReader(reader: NexusReader): NexusSdkResult
    @MainThread fun hide(): NexusSdkResult

    @MainThread fun showNotice(notice: NexusNotice): NexusSdkResult
    @MainThread fun updateNotice(update: NexusNoticeUpdate): NexusSdkResult
    @MainThread fun hideNotice(): NexusSdkResult

    @MainThread fun speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult
    @AnyThread fun stopSpeaking()

    @MainThread fun startSpeech(language: String?, listener: SpeechListener): SpeechHandle
}

interface SurfaceListener {
    fun onOpen(openType: String)
    fun onBackground() {}
    fun onClose()
    fun onStateChanged(state: SurfaceState) {}
    fun onDeviceInfo(info: GlassesDeviceInfo) {}
    fun onSurfaceRejected(code: String) {}
    fun onInput(event: NexusInputEvent)
    fun onTextCommitted(surfaceId: String, text: String, cancelled: Boolean) {}
}

interface NoticeCallbacks {
    fun onShown() {}
    fun onInput(event: NexusInputEvent) {}
    fun onAction(id: String) {}
    fun onClosed(reason: NexusNoticeCloseReason) {}
}

interface TtsCallbacks {
    fun onStarted(utteranceId: String) {}
    fun onDone(utteranceId: String, reason: NexusTtsDoneReason) {}
}

interface SpeechListener {
    fun onStarted(realtime: Boolean)
    fun onState(state: NexusSpeechState) {}
    fun onPartial(text: String)
    fun onFinal(text: String)
    fun onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?)
}

interface SpeechHandle {
    /** SENT, NOT_REGISTERED, CAPABILITY_NOT_GRANTED or CAPABILITY_NOT_AVAILABLE. */
    val result: NexusSdkResult

    @AnyThread fun stop()
}

data class SurfaceState(
    val lifecycle: Lifecycle,
    val linkState: Int,
    val noticeSupported: Boolean,
    val noticeShownAckSupported: Boolean,
    val editableSupported: Boolean,
    val ttsSupported: Boolean,
) {
    enum class Lifecycle { CLOSED, OPEN, BACKGROUND }

    val glassesWorn: Boolean get() = linkState and LinkStateBits.GLASSES_WORN != 0
}

/** From /glasses/device-info; -1 becomes null. Never carries the serial number. */
data class GlassesDeviceInfo(
    val deviceName: String,
    val batteryLevel: Int?,
    val volume: Int?,
    val brightness: Int?,
    val systemVersion: String,
    val isCharging: Boolean,
    val wearingStatus: String,
)
