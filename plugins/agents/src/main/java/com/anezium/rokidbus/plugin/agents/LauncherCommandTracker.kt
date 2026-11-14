package com.anezium.rokidbus.plugin.agents

import java.util.UUID

/**
 * Correlates the launcher commands (`compact`, `model`) the wearer sends, so a
 * re-tap after a lost ack is deduped by agentd instead of typed twice (R152).
 *
 * A command is keyed by (session, command, arg). Its msgId is kept from the
 * moment it is sent until agentd frees it: an `applied` ack, or a `rejected`
 * ack that did not consume the id. Until then a re-tap re-sends the same id, so
 * agentd answers `duplicate` and never types the command again.
 *
 * agentd forgets an id after 24 h, so a kept id is reused only while it is
 * younger than [KEPT_ID_MAX_MS]; past that, the tap sends nothing and arms the
 * retry, because the command may or may not have run. The next tap is the
 * wearer's informed "send again". Pure and not thread-safe: the caller owns the
 * thread.
 */
internal class LauncherCommandTracker(private val newId: () -> String = { UUID.randomUUID().toString() }) {
    data class CommandKey(val sessionKey: String, val command: String, val arg: String?)

    enum class AckOutcome {
        /** Not a launcher command this tracker holds. */
        UNKNOWN,
        APPLIED,

        /** Rejected and freed by agentd: a re-tap is a new command. */
        FREED,

        /** Rejected after it was typed: the id is kept, and a re-tap is a duplicate. */
        KEPT_CONSUMED,

        /** agentd already had it; the retry is armed. */
        DUPLICATE,
    }

    /** [owner] is the machine that reported the session when the id was kept, or null when none did. */
    private class Kept(val msgId: String, val sentAt: Long, val owner: String?)

    private val kept = LinkedHashMap<CommandKey, Kept>()
    private val retryUntil = HashMap<CommandKey, Long>()

    /**
     * The id to send for this command now, or null when nothing may be sent:
     * the kept id is older than [KEPT_ID_MAX_MS], so the retry is armed and the
     * caller shows [ControlMenu.MAY_ALREADY_BE_SENT].
     */
    fun msgIdFor(sessionKey: String, command: String, arg: String?, now: Long, owner: String? = null): String? {
        val key = CommandKey(sessionKey, command, arg)
        if (retryArmed(key, now)) {
            // The wearer was told it may be sent already and tapped again.
            retryUntil.remove(key)
            return fresh(key, now, owner)
        }
        val held = kept[key] ?: return fresh(key, now, owner)
        if (now - held.sentAt >= KEPT_ID_MAX_MS) {
            retryUntil[key] = now + RETRY_WINDOW_MS
            return null
        }
        return held.msgId
    }

    fun onAck(msgId: String, result: String, consumed: Boolean, now: Long): AckOutcome {
        if (msgId.isEmpty()) return AckOutcome.UNKNOWN
        val key = kept.entries.firstOrNull { it.value.msgId == msgId }?.key ?: return AckOutcome.UNKNOWN
        return when {
            result == "applied" -> {
                forget(key)
                AckOutcome.APPLIED
            }
            result == "duplicate" -> {
                retryUntil[key] = now + RETRY_WINDOW_MS
                AckOutcome.DUPLICATE
            }
            result == "rejected" && consumed -> AckOutcome.KEPT_CONSUMED
            result == "rejected" -> {
                forget(key)
                AckOutcome.FREED
            }
            else -> AckOutcome.UNKNOWN
        }
    }

    /** True while the wearer's next tap on [key] sends a fresh id on purpose. */
    fun retryArmed(key: CommandKey, now: Long): Boolean {
        val until = retryUntil[key] ?: return false
        if (now < until) return true
        retryUntil.remove(key)
        return false
    }

    /** The launcher commands of [sessionKey] whose retry is armed, as the menu's commands. */
    fun armedCommands(sessionKey: String, now: Long): Set<ControlMenu.Command> =
        retryUntil.keys.toList().filter { it.sessionKey == sessionKey && retryArmed(it, now) }
            .mapNotNullTo(LinkedHashSet()) { key ->
                when (key.command) {
                    COMPACT -> ControlMenu.Command.LauncherCompact
                    MODEL -> key.arg?.let { ControlMenu.Command.LauncherModel(it) }
                    else -> null
                }
            }

    /**
     * agentd on [machineId] sent `session_removed` for [sessionKey]: the ids kept
     * for it on that machine go. Nothing else drops a kept id but its acks and
     * the [KEPT_ID_MAX_MS] rule. A cleared board or a snapshot, from this
     * machine or another, is not that: the session may come back, and a fresh
     * id there could type the command twice.
     */
    fun forgetRemoved(sessionKey: String, machineId: String) {
        val gone = kept.filter { (key, held) -> key.sessionKey == sessionKey && held.owner == machineId }.keys
        gone.forEach(::forget)
    }

    private fun fresh(key: CommandKey, now: Long, owner: String?): String {
        val id = newId()
        kept[key] = Kept(id, now, owner)
        return id
    }

    private fun forget(key: CommandKey) {
        kept.remove(key)
        retryUntil.remove(key)
    }

    companion object {
        const val COMPACT = "compact"
        const val MODEL = "model"

        /** One hour under agentd's 24 h AppliedIds memory (daemon.ts), so a reused id is always still known there. */
        const val KEPT_ID_MAX_MS = 23 * 60 * 60 * 1000L

        /** How long a duplicate keeps the next tap an informed resend. */
        const val RETRY_WINDOW_MS = 30_000L
    }
}

/**
 * The seam every control-menu send goes through. Launcher commands take their
 * msgId from the [LauncherCommandTracker]; every other command gets a fresh
 * one. It exists so the service's send and ack path can be tested with a fake
 * wire, since the Android service itself cannot be built in a unit test.
 */
internal class ControlSender(
    private val write: (String) -> Unit,
    /** The machine that reported a session; a kept id is bound to it. */
    private val ownerOf: (String) -> String? = { null },
    private val clock: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
) {
    sealed interface Sent {
        /** Written to the wire; [steers] is true when agentd answers it with an ack. */
        data class Written(val msgId: String, val steers: Boolean) : Sent

        /** A kept id too old to resend: nothing was sent, and the retry is armed. */
        data object Held : Sent

        /** The value could not be framed (blank or oversize). */
        data object Unframeable : Sent
    }

    private val tracker = LauncherCommandTracker(newId)

    @Synchronized
    fun send(command: ControlMenu.Command, sessionKey: String): Sent {
        val msgId = when (command) {
            ControlMenu.Command.LauncherCompact ->
                tracker.msgIdFor(sessionKey, LauncherCommandTracker.COMPACT, null, clock(), ownerOf(sessionKey))
                    ?: return Sent.Held
            is ControlMenu.Command.LauncherModel ->
                tracker.msgIdFor(sessionKey, LauncherCommandTracker.MODEL, command.model, clock(), ownerOf(sessionKey))
                    ?: return Sent.Held
            else -> newId()
        }
        val frame = try {
            ControlMenu.frame(command, sessionKey, msgId)
        } catch (_: IllegalArgumentException) {
            return Sent.Unframeable
        }
        write(frame)
        return Sent.Written(msgId, ControlMenu.steers(command))
    }

    /** Routes an ack to the tracker; anything that is not a launcher command's id is [LauncherCommandTracker.AckOutcome.UNKNOWN]. */
    @Synchronized
    fun onAck(ack: AgentdAction.Ack): LauncherCommandTracker.AckOutcome =
        tracker.onAck(ack.msgId, ack.result, ack.consumed, clock())

    /** The launcher commands of [sessionKey] the wearer may now send again on purpose. */
    @Synchronized
    fun armed(sessionKey: String): Set<ControlMenu.Command> = tracker.armedCommands(sessionKey, clock())

    /**
     * Drops a session's kept ids when its own machine sends `session_removed` (R152). Called on the
     * transport's thread, hence the lock. Returns the call that stops following.
     */
    fun follow(store: AgentSessionStore): () -> Unit = store.onSessionRemoved { removal ->
        synchronized(this) { tracker.forgetRemoved(removal.sessionKey, removal.machineId) }
    }
}
