package com.anezium.rokidbus.phone

import com.example.cxrglobal.callbacks.IGlassAppCbk
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The one CXR app callback. CXRLink keeps a single IGlassAppCbk and every app call replaces it,
 * so a second call before the first answers would hand the first's answer to the second. Every
 * CXR app call goes through this arbiter: one operation holds the slot at a time, FIFO.
 *
 * A dispatch is one CXR call; the operation (an install: query, upload, result) may make several
 * and keeps the slot between them. The slot is freed, and the operation's cleanup runs, only at
 * operation completion, through [Op.finish]. Once a call is dispatched its answer is awaited even
 * if the owner gives up: a finish during a dispatch takes effect when that dispatch completes.
 *
 * The lock is never held while calling CXR, a callback or a cleanup action.
 */
internal class GlassesAppSlot(private val cxr: () -> CxrTransport?) {
    enum class Kind { INSTALL, QUERY, LAUNCH, THIRD_PARTY_UPLOAD }

    /** IGlassAppCbk carries only booleans: install succeeded, app opened, app installed. */
    data class AppAnswer(val success: Boolean)

    sealed interface DispatchResult<out T> {
        data class Answered<T>(val value: T) : DispatchResult<T>

        /** The link dropped or the hub stopped before the glasses answered. */
        data object LinkLost : DispatchResult<Nothing>

        /** The CXR call threw before it was sent. */
        data object Threw : DispatchResult<Nothing>
    }

    internal enum class State { ACQUIRED, DISPATCHED, DONE }

    private class Waiter(val kind: Kind, val continuation: CancellableContinuation<Op>)

    internal class InFlight(
        val op: Op,
        val number: Int,
        val done: (DispatchResult<AppAnswer>) -> Unit,
    )

    private val lock = Any()
    private var holder: Op? = null
    private val waiters = ArrayDeque<Waiter>()
    private var nextId = 0L

    inner class Op internal constructor(val id: Long, val kind: Kind) {
        internal var state = State.ACQUIRED
        internal var finishPending = false
        internal var dispatches = 0
        internal var inFlight: InFlight? = null
        internal val cleanup = mutableListOf<() -> Unit>()

        /** Runs once, at operation completion. */
        fun onComplete(action: () -> Unit) {
            val runNow = synchronized(lock) {
                if (state == State.DONE) {
                    true
                } else {
                    cleanup += action
                    false
                }
            }
            if (runNow) runCatching(action)
        }

        /**
         * Operation completion: frees the slot and runs the cleanup, once. From ACQUIRED it happens
         * now; from DISPATCHED it is deferred to that dispatch's completion. Idempotent.
         */
        fun finish() {
            val release = synchronized(lock) {
                when (state) {
                    State.DONE -> null
                    State.DISPATCHED -> {
                        finishPending = true
                        null
                    }
                    State.ACQUIRED -> completeLocked(this)
                }
            }
            release?.invoke()
        }
    }

    /** FIFO; cancellable only while waiting. */
    suspend fun acquire(kind: Kind): Op {
        synchronized(lock) {
            if (holder == null && waiters.isEmpty()) return newOpLocked(kind)
        }
        return suspendCancellableCoroutine { continuation ->
            val waiter = Waiter(kind, continuation)
            val granted = synchronized(lock) {
                if (holder == null && waiters.isEmpty()) {
                    newOpLocked(kind)
                } else {
                    waiters.addLast(waiter)
                    null
                }
            }
            if (granted != null) {
                grant(continuation, granted)
            } else {
                continuation.invokeOnCancellation {
                    synchronized(lock) { waiters.remove(waiter) }
                }
            }
        }
    }

    /** Non-suspending: null while the slot is held or waited for. */
    fun tryAcquire(kind: Kind): Op? = synchronized(lock) {
        if (holder == null && waiters.isEmpty()) newOpLocked(kind) else null
    }

    /**
     * One CXR app call on [op]. Returns at dispatch completion with the answer, [DispatchResult.LinkLost]
     * or [DispatchResult.Threw]; the op still holds the slot. Cancelling the caller does nothing to
     * the call itself: the caller's finish() then waits for this dispatch to complete.
     */
    suspend fun <T> dispatch(
        op: Op,
        call: (IGlassAppCbk) -> Unit,
        answer: (AppAnswer) -> T,
    ): DispatchResult<T> = suspendCancellableCoroutine { continuation ->
        dispatchAsync(op, call) { result ->
            val mapped: DispatchResult<T> = when (result) {
                is DispatchResult.Answered -> DispatchResult.Answered(answer(result.value))
                DispatchResult.LinkLost -> DispatchResult.LinkLost
                DispatchResult.Threw -> DispatchResult.Threw
            }
            if (continuation.isActive) continuation.resume(mapped)
        }
    }

    /** The same, for a non-suspending caller: [done] runs at dispatch completion, on the CXR thread. */
    fun dispatchAsync(
        op: Op,
        call: (IGlassAppCbk) -> Unit,
        done: (DispatchResult<AppAnswer>) -> Unit,
    ) {
        val flight = synchronized(lock) {
            check(holder === op && op.state == State.ACQUIRED) { "The op does not hold the slot idle" }
            op.dispatches += 1
            op.state = State.DISPATCHED
            InFlight(op, op.dispatches, done).also { op.inFlight = it }
        }
        if (cxr() == null) {
            complete(flight, DispatchResult.LinkLost)
            return
        }
        val callback = object : IGlassAppCbk {
            override fun onInstallAppResult(success: Boolean) = answered(success)
            override fun onOpenAppResult(success: Boolean) = answered(success)
            override fun onQueryAppResult(installed: Boolean) = answered(installed)

            private fun answered(success: Boolean) {
                complete(flight, DispatchResult.Answered(AppAnswer(success)))
            }
        }
        val sent = runCatching { call(callback) }.isSuccess
        if (!sent) complete(flight, DispatchResult.Threw)
    }

    /** Completes the dispatch in flight, if any, as [DispatchResult.LinkLost]. */
    fun failDispatched() {
        val flight = synchronized(lock) { holder?.inFlight } ?: return
        complete(flight, DispatchResult.LinkLost)
    }

    private fun complete(flight: InFlight, result: DispatchResult<AppAnswer>) {
        val release = synchronized(lock) {
            val op = flight.op
            // A callback that is not the dispatch in flight is stale: dropped.
            if (op.inFlight !== flight || op.dispatches != flight.number) return
            op.inFlight = null
            op.state = State.ACQUIRED
            if (op.finishPending) completeLocked(op) else null
        }
        runCatching { flight.done(result) }
        release?.invoke()
    }

    private fun newOpLocked(kind: Kind): Op {
        nextId += 1
        return Op(nextId, kind).also { holder = it }
    }

    /** Marks [op] done and frees the slot; returns the cleanup and the next grant, to run unlocked. */
    private fun completeLocked(op: Op): () -> Unit {
        op.state = State.DONE
        if (holder === op) holder = null
        val actions = op.cleanup.toList()
        op.cleanup.clear()
        var next: Pair<Waiter, Op>? = null
        while (next == null) {
            val waiter = waiters.removeFirstOrNull() ?: break
            if (waiter.continuation.isActive) next = waiter to newOpLocked(waiter.kind)
        }
        return {
            actions.forEach { action -> runCatching(action) }
            next?.let { (waiter, granted) -> grant(waiter.continuation, granted) }
        }
    }

    private fun grant(continuation: CancellableContinuation<Op>, op: Op) {
        // A waiter cancelled after it was granted the slot hands it straight back.
        continuation.resume(op) { _, granted, _ -> granted.finish() }
    }
}
