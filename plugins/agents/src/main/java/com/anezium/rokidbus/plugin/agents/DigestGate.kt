package com.anezium.rokidbus.plugin.agents

/**
 * Decides when a changed board is pushed to the glasses. Progress (a step, a
 * file, a heading) is held to one push per [periodMs]; anything the wearer
 * would act on goes at once. `0` is live. It never touches alerts, which are
 * not digested. Not thread-safe: the service calls it from the main thread.
 *
 * [shouldPush] compares against what was last put on the glasses (`previous`),
 * so held changes accumulate rather than being judged one at a time, and a push
 * always carries the latest. A hold needs a way out when nothing else changes:
 * [nextFlushAt] says when the service must ask again.
 */
class DigestGate(
    private val clock: () -> Long,
    var periodMs: Long,
) {
    private var lastPushAt: Long? = null
    private var held = false

    fun shouldPush(previous: List<AgentSession>?, next: List<AgentSession>): Boolean {
        if (periodMs <= 0L || previous == null || urgent(previous, next)) return push()
        if (previous == next) {
            held = false
            return false
        }
        val last = lastPushAt
        if (last == null || clock() - last >= periodMs) return push()
        held = true
        return false
    }

    /** The board went out for another reason (the wearer moved, a screen changed): the period starts over. */
    fun markPushed() {
        push()
    }

    /** When held changes are due, so the service can wake and push them; null when nothing is held. */
    fun nextFlushAt(): Long? {
        val last = lastPushAt ?: return null
        return if (held && periodMs > 0L) last + periodMs else null
    }

    private fun push(): Boolean {
        lastPushAt = clock()
        held = false
        return true
    }

    private fun urgent(previous: List<AgentSession>, next: List<AgentSession>): Boolean {
        val before = previous.associateBy { it.key }
        val after = next.associateBy { it.key }
        if (before.keys != after.keys) return true
        return after.any { (key, now) ->
            val was = before.getValue(key)
            now.v2?.tempMode != was.v2?.tempMode ||
                now.status != was.status && (now.status.needsAction() || was.status.needsAction())
        }
    }

    private fun AgentStatus.needsAction() =
        this == AgentStatus.NEEDS_YOU || this == AgentStatus.DONE || this == AgentStatus.ERROR
}
