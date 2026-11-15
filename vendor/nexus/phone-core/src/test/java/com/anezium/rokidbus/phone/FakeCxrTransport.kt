package com.anezium.rokidbus.phone

import com.anezium.rokidbus.shared.BusConstants
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.FrameProtocol
import com.example.cxrglobal.CxrDefs
import com.example.cxrglobal.GlassInfo
import com.example.cxrglobal.callbacks.IAudioStreamCbk
import com.example.cxrglobal.callbacks.ICXRLinkCbk
import com.example.cxrglobal.callbacks.ICustomCmdCbk
import com.example.cxrglobal.callbacks.IGlassAppCbk
import com.rokid.cxr.Caps
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArrayList

/** Records what the core sends over CXR and drives the callbacks the vendor library would. */
internal class FakeCxrTransport : CxrTransport {
    @Volatile var linkCallback: ICXRLinkCbk? = null
    @Volatile var customCmdCallback: ICustomCmdCbk? = null
    @Volatile var audioCallback: IAudioStreamCbk? = null
    @Volatile var serviceConnected = false
    @Volatile var throwOnAppCall = false
    @Volatile var audioStreamStarts = 0

    /** Every bus frame sent to the glasses over CXR, decoded. */
    val frames = CopyOnWriteArrayList<BusEnvelope>()

    /** Every CXR app call: "start:<activity>", "query", "upload:<path>". */
    val appCalls = CopyOnWriteArrayList<String>()
    val appCallbacks = CopyOnWriteArrayList<IGlassAppCbk>()
    val brightness = CopyOnWriteArrayList<Int>()

    /** Every CXR session the core configured. */
    val sessions = CopyOnWriteArrayList<CxrDefs.CXRSession>()

    override fun configCXRSession(session: CxrDefs.CXRSession): Boolean = sessions.add(session)
    override fun setCXRLinkCbk(cbk: ICXRLinkCbk?) { linkCallback = cbk }
    override fun setCXRCustomCmdCbk(cbk: ICustomCmdCbk?) { customCmdCallback = cbk }
    override fun setCXRAudioCbk(cbk: IAudioStreamCbk?) { audioCallback = cbk }
    override fun connect(token: String): Boolean {
        serviceConnected = true
        return true
    }
    @Volatile var onDisconnect: () -> Unit = {}
    override fun disconnect() {
        onDisconnect()
        serviceConnected = false
    }
    override fun isServiceConnected(): Boolean = serviceConnected

    override fun sendCustomCmd(key: String, payload: ByteArray): Int? {
        if (key == BusConstants.CXR_KEY) {
            val caps = Caps.fromBytes(payload)
            frames += FrameProtocol.fromJson(JSONObject(caps.at(0).string))
        }
        return 0
    }

    override fun startAudioStream(codeType: Int): Boolean {
        audioStreamStarts += 1
        return true
    }
    override fun stopAudioStream(): Boolean = true
    override fun setInterruptAiWake(interrupt: Boolean): Boolean = true
    override fun sendExit(playSound: Boolean): Boolean = true
    override fun setBrightness(level: Int): Boolean { brightness += level; return true }
    override fun setVolume(level: Int): Boolean = true

    override fun appStart(activityName: String, cbk: IGlassAppCbk) = appCall("start:$activityName", cbk)
    override fun appIsInstalled(cbk: IGlassAppCbk) = appCall("query", cbk)
    override fun appUploadAndInstall(filePath: String, cbk: IGlassAppCbk) = appCall("upload:$filePath", cbk)

    private fun appCall(call: String, cbk: IGlassAppCbk) {
        if (throwOnAppCall) throw IllegalStateException("CXR app call failed")
        appCalls += call
        appCallbacks += cbk
    }

    // ---- the glasses' side ----

    fun linkUp() {
        serviceConnected = true
        linkCallback!!.onCXRLConnected(true)
        linkCallback!!.onGlassBtConnected(true)
    }

    fun linkDown() {
        linkCallback!!.onCXRLConnected(false)
    }

    fun deviceInfo(info: GlassInfo) = linkCallback!!.onGlassDeviceInfo(info)

    fun inject(envelope: BusEnvelope) {
        val bytes = Caps().apply { write(FrameProtocol.toJson(envelope).toString()) }.serialize()
        customCmdCallback!!.onCustomCmdResult(BusConstants.CXR_KEY, bytes)
    }

    fun framesOn(path: String): List<BusEnvelope> = frames.filter { it.path == path }
}
