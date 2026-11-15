package com.anezium.rokidbus.plugin.agents

/**
 * One pass of the pairing TTL (U7): every live link is touched first, then the sweep runs. A
 * computer connected right now therefore reads as used this tick, whatever the clock jumped by.
 */
internal fun runPairingTtlTick(touchLive: List<() -> Unit>, sweep: () -> List<SignedOut>): List<SignedOut> {
    touchLive.forEach { it() }
    return sweep()
}

internal const val PAIRING_TTL_TICK_MS = 60L * 60L * 1000L
