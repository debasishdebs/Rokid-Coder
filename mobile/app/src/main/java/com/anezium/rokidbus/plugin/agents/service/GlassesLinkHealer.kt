package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.phone.CxrEnsureResult
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
 * Hi Rokid has not closed its session on purpose: the background never fights Hi Rokid for the glasses.
 *
 * A voice action of the wearer is a different thing. Before it starts, [ensureLink] makes sure the link is
 * there: a live one is reused and nothing is bound; a down one is bound once, over a session Hi Rokid closed
 * too (as the Glass app screen does), and waited for up to [waitMs]. Taps made while one attempt waits join
 * it, and the background retries stand aside while it runs. That needs monitoring on and the service running.
 *
 * Every decision is logged under [LinkLog], state changes and attempts only.
 *
 * Every state change and every callback runs on [scope]'s thread, the main one in the service. The
 * entry points may be called from any thread (the link state arrives on the Binder thread CXR reports
 * on) and hop there first, so the voice start that follows [ensureLink]'s answer is always made on it.
 */
internal class GlassesLinkHealer(
    private val scope: CoroutineScope,
    private val core: CoderCore,
    private val enabled: () -> Boolean = { true },
    private val retryDelaysMs: List<Long> = RETRY_DELAYS_MS,
    /** How long [ensureLink] waits for the link to come up after it bound. */
    private val waitMs: Long = ENSURE_WAIT_MS,
) {
    private var loop: Job? = null
    private var attempts = 0
    private var settling: Job? = null
    private val waiting = mutableListOf<(LinkEnsure) -> Unit>()

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
            if (loop?.isActive == true || attempts > 0) LinkLog.i("healer: link up, retries end")
            skipped = null
            attempts = 0
            loop?.cancel()
            loop = null
            resolve(LinkEnsure.UP)
            // Up before the wait ran out: the attempt is over, a later tap starts its own.
            settling?.cancel()
            settling = null
            return
        }
        val reason = skipReason(state)
        if (reason != null) {
            // Said once per reason, not at every link state.
            if (reason != skipped) LinkLog.i("healer: not chasing the link ($reason)")
            skipped = reason
            attempts = 0
            loop?.cancel()
            loop = null
            return
        }
        skipped = null
        if (loop?.isActive == true) return
        LinkLog.i("healer: link down, retries start")
        loop = scope.launch { retryLoop() }
    }

    /** Why the background is not chasing the link, as last logged; null while it is. */
    private var skipped: String? = null

    /**
     * The link, made sure of for a voice action the wearer just took, and [onResult] with how it went:
     * [LinkEnsure.UP] at once for a live link (nothing is bound), or once a bind brought it up within
     * [waitMs]; [LinkEnsure.NOT_REACHED] when it did not; and at once, binding nothing, a distinct reason
     * when monitoring is off, no token is stored or the service is stopping. One attempt at a time: taps
     * made while one waits join it. Never retried here.
     */
    fun ensureLink(onResult: (LinkEnsure) -> Unit) = onScope {
        if (stopped) {
            LinkLog.i("wearer link: skipped (service stopped)")
            return@onScope onResult(LinkEnsure.STOPPED)
        }
        if (core.linkState() and LinkStateBits.CXR_CONTROL_UP != 0) {
            LinkLog.i("wearer link: up, reused")
            return@onScope onResult(LinkEnsure.UP)
        }
        if (!enabled()) {
            LinkLog.i("wearer link: skipped (monitoring off)")
            return@onScope onResult(LinkEnsure.MONITORING_OFF)
        }
        waiting += onResult
        if (settling?.isActive == true) {
            LinkLog.i("wearer link: joins the attempt in flight")
            return@onScope
        }
        settling = scope.launch {
            LinkLog.i("wearer link: down, binding (closedByServer=${core.linkClosedByServer})")
            val bound = core.ensureLink()
            LinkLog.i("wearer link: bind result $bound")
            when (bound) {
                CxrEnsureResult.ALREADY_UP -> resolve(LinkEnsure.UP)
                CxrEnsureResult.NO_TOKEN -> resolve(LinkEnsure.NO_TOKEN)
                CxrEnsureResult.HUB_STOPPED -> resolve(LinkEnsure.STOPPED)
                CxrEnsureResult.NOT_BOUND -> resolve(LinkEnsure.NOT_REACHED)
                CxrEnsureResult.CONNECTING -> {
                    delay(waitMs)
                    val up = core.linkState() and LinkStateBits.CXR_CONTROL_UP != 0
                    LinkLog.i("wearer link: ${if (up) "up" else "still down"} after ${waitMs}ms")
                    resolve(if (up) LinkEnsure.UP else LinkEnsure.NOT_REACHED)
                }
            }
        }
    }

    /** The service is going down: no more tries, and nobody is left waiting. Final. */
    fun stop() = onScope {
        LinkLog.i("healer: stopped")
        stopped = true
        loop?.cancel()
        loop = null
        settling?.cancel()
        settling = null
        resolve(LinkEnsure.STOPPED)
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

    private fun resolve(result: LinkEnsure) {
        if (waiting.isEmpty()) return
        val callbacks = waiting.toList()
        waiting.clear()
        callbacks.forEach { it(result) }
    }

    /** Why the background must not chase the link now, or null when it may. */
    private fun skipReason(state: Int): String? = when {
        !enabled() -> "monitoring off"
        state and LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED == 0 -> "glasses not bonded"
        core.linkClosedByServer -> "Hi Rokid closed the session"
        else -> null
    }

    private suspend fun retryLoop() {
        while (scope.isActive) {
            val pause = retryDelaysMs[attempts.coerceAtMost(retryDelaysMs.lastIndex)]
            LinkLog.i("healer: next attempt in ${pause}ms")
            delay(pause)
            val state = core.linkState()
            if (state and LinkStateBits.CXR_CONTROL_UP != 0) return
            val reason = skipReason(state)
            if (reason != null) {
                // Monitoring went off, the glasses went away: whatever starts the tries again starts them over.
                LinkLog.i("healer: attempt skipped ($reason)")
                skipped = reason
                attempts = 0
                return
            }
            // The wearer's own bind is in flight: binding again would retire it half done.
            if (settling?.isActive == true) {
                LinkLog.i("healer: attempt skipped (the wearer's bind is in flight)")
                continue
            }
            // Nothing to connect with (no token, hub stopped): a later link state starts this again.
            if (!core.reconnectLink()) {
                LinkLog.i("healer: attempt ${attempts + 1} had nothing to connect with, retries end")
                return
            }
            attempts += 1
            LinkLog.i("healer: attempt $attempts made")
        }
    }

    companion object {
        /** The pause before each try, the last one repeating: long enough for one to finish, short of a battery cost. */
        val RETRY_DELAYS_MS = listOf(10_000L, 20_000L, 40_000L, 80_000L, 160_000L, 300_000L)

        /** How long a voice action waits for the glasses link to come up after it was bound again. */
        const val ENSURE_WAIT_MS = 5_000L
    }
}

/** How [GlassesLinkHealer.ensureLink] went, for the voice start that waits on it. */
internal enum class LinkEnsure {
    /** The link is up: a live one reused, or one a bind brought up in time. */
    UP,

    /** Monitoring is off, so the app does not take the glasses. */
    MONITORING_OFF,

    /** No CXR token is stored: the glasses were never set up. */
    NO_TOKEN,

    /** The bind was refused, or the link did not come up in time. */
    NOT_REACHED,

    /** The service is stopping. */
    STOPPED,
}
