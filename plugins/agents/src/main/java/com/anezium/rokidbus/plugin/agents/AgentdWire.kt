package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.atomic.AtomicLong

/**
 * The one way a line reaches agentd. Every frame is classified here, at the
 * final write, from its own `type`: no caller says whether it steers. A
 * steering frame leaves only over a link bound as secure, and the trust is
 * bound to one authenticated connection generation, so a reconnect over a
 * weaker link can never inherit what the previous connection was allowed.
 *
 * What leaves is the object that was classified, re-serialised: agentd splits
 * on newlines and reads the untrimmed `type`, so the caller's own bytes could
 * carry a second frame, or a type, that this gate never saw.
 */
class AgentdWire(private val raw: (String) -> Boolean) {
    private val lock = Any()
    private var boundGeneration: Long? = null
    private val _secure = MutableStateFlow(false)

    /** False whenever unbound. */
    val secure: StateFlow<Boolean> = _secure.asStateFlow()

    sealed interface Result {
        object Sent : Result
        object MonitorOnly : Result
        object NoLink : Result
    }

    /** Called once per authenticated connection, after hello_ack. */
    fun bind(generation: Long, secure: Boolean) = synchronized(lock) {
        boundGeneration = generation
        _secure.value = secure
    }

    /** On close, replacement or auth failure. A stale generation is ignored. */
    fun unbind(generation: Long) = synchronized(lock) {
        if (boundGeneration != generation) return@synchronized
        boundGeneration = null
        _secure.value = false
    }

    /**
     * [line] must be exactly one JSON object on one line; anything else is a
     * caller bug and throws [IllegalArgumentException] without writing.
     *
     * Writes under the lock, so an unbind can never land between the check
     * and the write. [raw] must not block: it hands the line to the transport.
     */
    fun write(line: String): Result {
        val frame = singleObject(line)
        // Untrimmed: " alert_shown" is not a monitor type, whatever it looks like.
        val steering = (frame.opt("type") as? String)?.let(FrameClass::isSteering) ?: true
        val bytes = frame.toString()
        return synchronized(lock) {
            when {
                boundGeneration == null -> Result.NoLink
                steering && !_secure.value -> Result.MonitorOnly
                raw(bytes) -> Result.Sent
                else -> Result.NoLink
            }
        }
    }

    companion object {
        private val generations = AtomicLong()

        /** Unique across both transports, so a generation names one connection. */
        fun nextGeneration(): Long = generations.incrementAndGet()

        private fun singleObject(line: String): JSONObject {
            require('\n' !in line && '\r' !in line) { "A frame is one line" }
            val tokener = JSONTokener(line)
            val value = runCatching { tokener.nextValue() }.getOrNull()
            require(value is JSONObject) { "A frame is one JSON object" }
            require(runCatching { tokener.nextClean() }.getOrNull() == END) {
                "Nothing may follow the frame"
            }
            return value
        }

        private const val END = '\u0000'
    }
}

sealed interface AgentdEvent {
    data class LinkUp(val generation: Long, val secure: Boolean) : AgentdEvent
    data class LinkDown(val generation: Long) : AgentdEvent
    data class Action(val action: AgentdAction) : AgentdEvent
}

/** The link as it is now; a collector that fell behind reads this to catch up. */
data class AgentdLinkState(val generation: Long, val secure: Boolean)

/**
 * Identifies one connection to [AgentdLinkBinding]. [ended] is guarded by the
 * binding's monitor, so binding and ending the same connection never interleave.
 */
internal class LinkOwner {
    var ended = false
}

/**
 * One transport's link, as the rest of the plugin sees it: binds the wire and
 * announces the link in one step, under one lock, so `LinkDown` of a connection
 * always precedes `LinkUp` of the next and no action of a closed connection is
 * delivered after its `LinkDown`.
 */
internal class AgentdLinkBinding(
    private val wire: AgentdWire,
    private val onEvent: (AgentdEvent) -> Unit,
) {
    private class Bound(val generation: Long, val owner: LinkOwner)

    private var current: Bound? = null

    /**
     * After hello_ack. Returns the new generation, or null when [owner] has
     * already ended or [stillLive] says the connection was replaced. The owner
     * is recorded with the binding, so an [end] racing this call always finds it.
     */
    @Synchronized
    fun up(owner: LinkOwner, secure: Boolean, stillLive: () -> Boolean = { true }): Long? {
        if (owner.ended || !stillLive()) return null
        current?.let(::release)
        val generation = AgentdWire.nextGeneration()
        current = Bound(generation, owner)
        wire.bind(generation, secure)
        onEvent(AgentdEvent.LinkUp(generation, secure))
        return generation
    }

    /** [owner]'s connection is over: it never binds again, and its binding goes now. */
    @Synchronized
    fun end(owner: LinkOwner) {
        owner.ended = true
        current?.takeIf { it.owner === owner }?.let(::release)
    }

    @Synchronized
    fun downCurrent() {
        current?.let(::release)
    }

    /** Delivers an inbound v2 action only while [owner] holds the live link. */
    @Synchronized
    fun deliver(owner: LinkOwner, action: AgentdAction) {
        if (current?.owner === owner) onEvent(AgentdEvent.Action(action))
    }

    private fun release(bound: Bound) {
        current = null
        wire.unbind(bound.generation)
        onEvent(AgentdEvent.LinkDown(bound.generation))
    }
}

/**
 * Carries events from the transport threads to a suspending [sink] in arrival
 * order, without ever suspending the transport. Link events are never dropped.
 * When more than [maxActions] actions are waiting, the oldest waiting action is
 * dropped and counted: agentd re-sends an alert the phone did not ack, while a
 * lost `LinkUp` would leave the phone holding alerts from a dead connection.
 */
internal class AgentdEventQueue(
    scope: CoroutineScope,
    private val maxActions: Int,
    private val sink: suspend (AgentdEvent) -> Unit,
    private val onDropped: (Long) -> Unit,
) {
    private val lock = Any()
    private val pending = ArrayDeque<AgentdEvent>()
    private var pendingActions = 0
    private var dropped = 0L
    private val wake = Channel<Unit>(Channel.CONFLATED)

    init {
        require(maxActions > 0)
        scope.launch {
            for (signal in wake) drain()
        }
    }

    val droppedCount: Long get() = synchronized(lock) { dropped }

    fun offer(event: AgentdEvent) {
        val droppedNow = synchronized(lock) {
            var total: Long? = null
            if (event is AgentdEvent.Action) {
                if (pendingActions >= maxActions) {
                    pending.removeAt(pending.indexOfFirst { it is AgentdEvent.Action })
                    pendingActions -= 1
                    dropped += 1
                    total = dropped
                }
                pendingActions += 1
            }
            pending.addLast(event)
            total
        }
        droppedNow?.let(onDropped)
        wake.trySend(Unit)
    }

    private suspend fun drain() {
        while (true) {
            val next = synchronized(lock) {
                pending.removeFirstOrNull()?.also { if (it is AgentdEvent.Action) pendingActions -= 1 }
            } ?: return
            sink(next)
        }
    }
}
