package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.shared.LinkStateBits
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.coroutines.ContinuationInterceptor

/**
 * Keeps the CXR control link to the glasses up. The hub reconnects its Bluetooth data link on its own
 * but connects CXR only when it starts, so a CXR link that dropped (Bluetooth or Wi-Fi contention, Hi
 * Rokid taking the glasses for a moment) stayed down until the wearer reopened the Glass app screen,
 * which connects again with the stored token. This does that call itself, with a growing pause between
 * tries so a pair of glasses that are away costs next to nothing.
 *
 * It tries only while [enabled] (monitoring is on), the glasses are bonded (the link state says so), and
 * Hi Rokid has not closed its session on purpose. A voice request denied for want of the link
 * asks for one attempt at once through [healNow], whatever the pause, because the wearer is waiting.
 *
 * Every state change and every callback runs on [scope]'s thread, the main one in the service. The
 * entry points may be called from any thread (the link state arrives on the Binder thread CXR reports
 * on) and hop there first, so a voice start retried from [healNow]'s answer is always made on it.
 */
internal class GlassesLinkHealer(
    private val scope: CoroutineScope,
    private val core: CoderCore,
    private val enabled: () -> Boolean = { true },
    private val retryDelaysMs: List<Long> = RETRY_DELAYS_MS,
    /** How long [healNow] waits for the link to come up after its attempt. */
    private val settleMs: Long = SETTLE_MS,
) {
    private var loop: Job? = null
    private var attempts = 0
    private var settling: Job? = null
    private val waiting = mutableListOf<(Boolean) -> Unit>()

    /** The core's link state changed (or the service just started): start, keep or end the background retries. */
    fun onLinkState(state: Int) = onScope { evaluate(state) }

    /**
     * Monitoring was turned on or off. The link state need not have changed with it, so nothing else
     * would start the retries again after they ended, or end the ones running.
     */
    fun onMonitoringChanged() = onScope { evaluate(core.linkState()) }

    private fun evaluate(state: Int) {
        if (stopped) return
        if (state and LinkStateBits.CXR_CONTROL_UP != 0) {
            attempts = 0
            loop?.cancel()
            loop = null
            resolve(true)
            return
        }
        if (!wantsHeal(state)) {
            attempts = 0
            loop?.cancel()
            loop = null
            return
        }
        if (loop?.isActive == true) return
        loop = scope.launch { retryLoop() }
    }

    /**
     * One reconnect now, and [onResult] with whether the link was up within [settleMs] of it (at once when
     * it already is, or when there is nothing to connect with). Calls made while one is waiting share it.
     */
    fun healNow(onResult: (Boolean) -> Unit) = onScope {
        if (stopped) return@onScope onResult(false)
        if (core.linkState() and LinkStateBits.CXR_CONTROL_UP != 0) return@onScope onResult(true)
        waiting += onResult
        if (settling?.isActive == true) return@onScope
        settling = scope.launch {
            if (!core.reconnectLink()) return@launch resolve(false)
            delay(settleMs)
            resolve(core.linkState() and LinkStateBits.CXR_CONTROL_UP != 0)
        }
    }

    /** The service is going down: no more tries, and nobody is left waiting. Final. */
    fun stop() = onScope {
        stopped = true
        loop?.cancel()
        loop = null
        settling?.cancel()
        settling = null
        resolve(false)
    }

    /** Set by [stop]: a link state or a request that arrives afterwards connects nothing. */
    private var stopped = false

    /** Runs [block] on [scope]'s thread: at once when already there, else posted to it. */
    private fun onScope(block: () -> Unit) {
        val dispatcher = scope.coroutineContext[ContinuationInterceptor] as? CoroutineDispatcher
        if (dispatcher == null || !dispatcher.isDispatchNeeded(scope.coroutineContext)) {
            block()
        } else {
            scope.launch { block() }
        }
    }

    private fun resolve(up: Boolean) {
        if (waiting.isEmpty()) return
        val callbacks = waiting.toList()
        waiting.clear()
        callbacks.forEach { it(up) }
    }

    private fun wantsHeal(state: Int): Boolean =
        enabled() &&
            state and LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED != 0 &&
            !core.linkClosedByServer

    private suspend fun retryLoop() {
        while (scope.isActive) {
            delay(retryDelaysMs[attempts.coerceAtMost(retryDelaysMs.lastIndex)])
            val state = core.linkState()
            if (state and LinkStateBits.CXR_CONTROL_UP != 0) return
            if (!wantsHeal(state)) {
                // Monitoring went off, the glasses went away: whatever starts the tries again starts them over.
                attempts = 0
                return
            }
            // Nothing to connect with (no token, hub stopped): a later link state starts this again.
            if (!core.reconnectLink()) return
            attempts += 1
        }
    }

    companion object {
        /** The pause before each try, the last one repeating: long enough for one to finish, short of a battery cost. */
        val RETRY_DELAYS_MS = listOf(10_000L, 20_000L, 40_000L, 80_000L, 160_000L, 300_000L)
        const val SETTLE_MS = 3_000L
    }
}
