package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicLong

/**
 * The one way a line reaches agentd. Every frame is classified here, at the
 * final write, from its own `type`: no caller says whether it steers. A
 * steering frame leaves only over a link bound as secure, and the trust is
 * bound to one authenticated connection generation, so a reconnect over a
 * weaker link can never inherit what the previous connection was allowed.
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
     * Writes under the lock, so an unbind can never land between the check
     * and the write. [raw] must not block: it hands the line to the transport.
     */
    fun write(line: String): Result = synchronized(lock) {
        if (boundGeneration == null) return@synchronized Result.NoLink
        // A line whose type cannot be read is treated like an unknown type: steering.
        val steering = frameType(line)?.let(FrameClass::isSteering) ?: true
        when {
            steering && !_secure.value -> Result.MonitorOnly
            raw(line) -> Result.Sent
            else -> Result.NoLink
        }
    }

    companion object {
        private val generations = AtomicLong()

        /** Unique across both transports, so a generation names one connection. */
        fun nextGeneration(): Long = generations.incrementAndGet()

        private fun frameType(line: String): String? =
            runCatching { JSONObject(line) }.getOrNull()?.nullableString("type", MAX_WIRE_TYPE_CHARS)
    }
}

sealed interface AgentdEvent {
    data class LinkUp(val generation: Long, val secure: Boolean) : AgentdEvent
    data class LinkDown(val generation: Long) : AgentdEvent
    data class Action(val action: AgentdAction) : AgentdEvent
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
    private var current: Long? = null

    /**
     * After hello_ack. Returns the new generation, or null when [stillLive]
     * says the connection was already replaced.
     */
    @Synchronized
    fun up(secure: Boolean, stillLive: () -> Boolean = { true }): Long? {
        if (!stillLive()) return null
        current?.let(::release)
        val generation = AgentdWire.nextGeneration()
        current = generation
        wire.bind(generation, secure)
        onEvent(AgentdEvent.LinkUp(generation, secure))
        return generation
    }

    /** Ignored unless [generation] is the bound one. */
    @Synchronized
    fun down(generation: Long) {
        if (current == generation) release(generation)
    }

    @Synchronized
    fun downCurrent() {
        current?.let(::release)
    }

    /** Delivers an inbound v2 action only while [generation] is the live link. */
    @Synchronized
    fun deliver(generation: Long?, action: AgentdAction) {
        if (generation != null && current == generation) onEvent(AgentdEvent.Action(action))
    }

    private fun release(generation: Long) {
        current = null
        wire.unbind(generation)
        onEvent(AgentdEvent.LinkDown(generation))
    }
}
