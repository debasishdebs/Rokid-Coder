package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.shared.LinkStateBits

/** A [CoderCore] that is only a glasses link: a state the test sets and a reconnect it counts. */
internal class FakeLinkCore : CoderCore {
    var state = 0
    var closedByServer = false
    var canReconnect = true
    var reconnects = 0

    override val surface: GlassesSurface get() = error("not used")
    override val linkClosedByServer: Boolean get() = closedByServer
    override fun start() = Unit
    override fun close() = Unit
    override fun linkState(): Int = state

    override fun reconnectLink(): Boolean {
        if (!canReconnect || state and LinkStateBits.CXR_CONTROL_UP != 0) return false
        reconnects += 1
        return true
    }
}
