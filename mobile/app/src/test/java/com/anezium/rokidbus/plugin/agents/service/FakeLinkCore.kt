package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.phone.CxrEnsureResult
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.shared.LinkStateBits

/** A [CoderCore] that is only a glasses link: a state the test sets and the reconnects it counts. */
internal class FakeLinkCore : CoderCore {
    var state = 0
    var closedByServer = false
    var canReconnect = true

    /** Background reconnects, which a session Hi Rokid closed stops. */
    var reconnects = 0

    /** Binds made for a wearer's voice action ([ensureLink] with the link down), which a closure does not stop. */
    var binds = 0

    /** Every [ensureLink] call, whether it bound or found the link up. */
    var ensures = 0

    /** What a bind of [ensureLink] reports when the link is down; the hub's usual answer by default. */
    var ensureResult = CxrEnsureResult.CONNECTING

    override val surface: GlassesSurface get() = error("not used")
    override val linkClosedByServer: Boolean get() = closedByServer
    override fun start() = Unit
    override fun close() = Unit
    override fun linkState(): Int = state

    override fun reconnectLink(): Boolean {
        if (!canReconnect || state and LinkStateBits.CXR_CONTROL_UP != 0) return false
        if (closedByServer) return false
        reconnects += 1
        return true
    }

    /**
     * What the hub does when its link state moves: tell the host, at once and on the caller's stack. A test
     * points it at the healer ([GlassesLinkHealer.onLinkState]), as the service does.
     */
    var onLinkState: (Int) -> Unit = {}

    override fun ensureLink(): CxrEnsureResult {
        ensures += 1
        if (state and LinkStateBits.CXR_CONTROL_UP != 0) return CxrEnsureResult.ALREADY_UP
        if (ensureResult == CxrEnsureResult.CONNECTING || ensureResult == CxrEnsureResult.NOT_BOUND) {
            binds += 1
            // The real hub reports a state at the bind (its status notification), re-entrantly, and leaves
            // Hi Rokid's closure standing: only the link coming up ([bringUp]) clears it.
            onLinkState(state)
        }
        return ensureResult
    }

    /** The glasses link comes up, as the hub's `onCXRLConnected(true)` does: the closure is put away and the host told. */
    fun bringUp() {
        state = state or LinkStateBits.CXR_CONTROL_UP
        closedByServer = false
        onLinkState(state)
    }

    /** The link drops, and Hi Rokid closed the session when [byServer]. */
    fun drop(byServer: Boolean) {
        state = state and LinkStateBits.CXR_CONTROL_UP.inv()
        closedByServer = byServer
        onLinkState(state)
    }
}
