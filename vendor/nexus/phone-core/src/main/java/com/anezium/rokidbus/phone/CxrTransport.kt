package com.anezium.rokidbus.phone

import com.example.cxrglobal.CXRLink
import com.example.cxrglobal.CxrDefs
import com.example.cxrglobal.callbacks.IAudioStreamCbk
import com.example.cxrglobal.callbacks.ICXRLinkCbk
import com.example.cxrglobal.callbacks.ICustomCmdCbk
import com.example.cxrglobal.callbacks.IGlassAppCbk

/** The [CXRLink] members the core calls, signature for signature, so tests can stand in for it. */
internal interface CxrTransport {
    fun configCXRSession(session: CxrDefs.CXRSession): Boolean
    fun setCXRLinkCbk(cbk: ICXRLinkCbk?)
    fun setCXRCustomCmdCbk(cbk: ICustomCmdCbk?)
    fun setCXRAudioCbk(cbk: IAudioStreamCbk?)
    fun connect(token: String): Boolean
    fun disconnect()
    fun isServiceConnected(): Boolean
    fun sendCustomCmd(key: String, payload: ByteArray): Int?
    fun startAudioStream(codeType: Int): Boolean
    fun stopAudioStream(): Boolean
    fun setInterruptAiWake(interrupt: Boolean): Boolean
    fun sendExit(playSound: Boolean): Boolean
    fun setBrightness(level: Int): Boolean
    fun setVolume(level: Int): Boolean
    fun appStart(activityName: String, cbk: IGlassAppCbk)
    fun appIsInstalled(cbk: IGlassAppCbk)
    fun appUploadAndInstall(filePath: String, cbk: IGlassAppCbk)
}

internal class CxrLinkTransport(val link: CXRLink) : CxrTransport {
    override fun configCXRSession(session: CxrDefs.CXRSession): Boolean = link.configCXRSession(session)
    override fun setCXRLinkCbk(cbk: ICXRLinkCbk?) = link.setCXRLinkCbk(cbk)
    override fun setCXRCustomCmdCbk(cbk: ICustomCmdCbk?) = link.setCXRCustomCmdCbk(cbk)
    override fun setCXRAudioCbk(cbk: IAudioStreamCbk?) = link.setCXRAudioCbk(cbk)
    override fun connect(token: String): Boolean = link.connect(token)
    override fun disconnect() = link.disconnect()
    override fun isServiceConnected(): Boolean = link.isServiceConnected()
    override fun sendCustomCmd(key: String, payload: ByteArray): Int? = link.sendCustomCmd(key, payload)
    override fun startAudioStream(codeType: Int): Boolean = link.startAudioStream(codeType)
    override fun stopAudioStream(): Boolean = link.stopAudioStream()
    override fun setInterruptAiWake(interrupt: Boolean): Boolean = link.setInterruptAiWake(interrupt)
    override fun sendExit(playSound: Boolean): Boolean = link.sendExit(playSound)
    override fun setBrightness(level: Int): Boolean = link.setBrightness(level)
    override fun setVolume(level: Int): Boolean = link.setVolume(level)
    override fun appStart(activityName: String, cbk: IGlassAppCbk) = link.appStart(activityName, cbk)
    override fun appIsInstalled(cbk: IGlassAppCbk) = link.appIsInstalled(cbk)
    override fun appUploadAndInstall(filePath: String, cbk: IGlassAppCbk) = link.appUploadAndInstall(filePath, cbk)
}
