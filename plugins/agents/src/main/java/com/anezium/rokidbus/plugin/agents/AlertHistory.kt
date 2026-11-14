package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class Outcome { PENDING, ACTED, DISMISSED, EXPIRED, WITHDRAWN }

/**
 * One alert as the phone showed it. [actionLabel] is the last thing the phone
 * wrote for it (`Allowed`, `Denied`, `Answered`, `Replied`), `Handled` once
 * agentd says it was acted on with nothing written from here, or `Read` for a
 * Done or error the wearer opened. [lastError] is a refused answer, while the
 * entry is still waiting.
 */
data class HistoryEntry(
    val alertId: String,
    val sessionKey: String,
    val provider: String,
    val kind: AlertKind,
    val heading: String,
    val firstShownAtMs: Long,
    val shownCount: Int,
    val outcome: Outcome,
    val actionLabel: String?,
    val endedAtMs: Long?,
    val lastError: String? = null,
)

/** What the History settings ask the history to keep. */
data class HistoryPolicy(val windowMs: Long, val keepAfterSession: Boolean) {
    companion object {
        val DEFAULT = HistoryPolicy(DEFAULT_HISTORY_WINDOW_HOURS * 60L * 60L * 1000L, keepAfterSession = false)
    }
}

/**
 * A short, in-memory record of the alerts shown, with how each ended. Lost on a
 * process restart by design. An answer written from the phone never ends an
 * entry: only agentd's `alert_closed`, a final dismissal of a Done or error, or
 * the session leaving does.
 */
class AlertHistory(private val clock: () -> Long) {
    private val list = ArrayList<HistoryEntry>()
    private val closedSessions = HashSet<String>()
    private val _entries = MutableStateFlow<List<HistoryEntry>>(emptyList())

    /** Newest first. */
    val entries: StateFlow<List<HistoryEntry>> = _entries.asStateFlow()

    fun now(): Long = clock()

    /**
     * A band for [alert] was taken. A fresh or reminder frame counts as one more
     * showing; a retry, resume or update of the same alert does not. An entry the
     * session's departure withdrew comes back to waiting when agentd shows it again.
     */
    @Synchronized
    fun onShown(alert: AgentdAction.Alert, heading: String) {
        closedSessions.remove(alert.sessionKey)
        val at = list.indexOfFirst { it.alertId == alert.id }
        if (at < 0) {
            list += HistoryEntry(
                alertId = alert.id,
                sessionKey = alert.sessionKey,
                provider = AlertNotices.providerLabel(alert),
                kind = alert.kind,
                heading = heading,
                firstShownAtMs = clock(),
                shownCount = 1,
                outcome = Outcome.PENDING,
                actionLabel = null,
                endedAtMs = null,
            )
            while (list.size > MAX_ENTRIES) list.removeAt(0)
        } else {
            val entry = list[at]
            val more = if (alert.reason == AlertReason.NEW || alert.reason == AlertReason.REMINDER) 1 else 0
            list[at] = when (entry.outcome) {
                Outcome.PENDING -> entry.copy(heading = heading, shownCount = entry.shownCount + more)
                Outcome.WITHDRAWN -> entry.copy(
                    heading = heading,
                    shownCount = entry.shownCount + more,
                    outcome = Outcome.PENDING,
                    endedAtMs = null,
                )
                else -> entry
            }
        }
        publish()
    }

    /** [label] was written to agentd for [id]: it is remembered, and the entry still waits for agentd's word. */
    @Synchronized
    fun onActionAttempted(id: String, label: String) = whilePending(id) {
        it.copy(actionLabel = label, lastError = null)
    }

    /** agentd refused what was written: the entry keeps waiting, and says why it was not sent. */
    @Synchronized
    fun onActionRejected(id: String, error: String) = whilePending(id) {
        it.copy(actionLabel = null, lastError = error)
    }

    /**
     * The wearer dismissed or opened the alert. For a Done, error or notice that is
     * final ([read] says it was opened); an approval or a question is only parked,
     * and agentd brings it back as a reminder.
     */
    @Synchronized
    fun onDismissed(id: String, read: Boolean = false) = whilePending(id) {
        if (it.kind == AlertKind.APPROVAL || it.kind == AlertKind.QUESTION) {
            it
        } else {
            it.copy(outcome = Outcome.DISMISSED, actionLabel = if (read) READ else null, endedAtMs = clock())
        }
    }

    /**
     * A follow-up written for [sessionKey] answers its newest waiting Done or error.
     * Returns that alert's id, so a refusal of the follow-up can find its entry again.
     */
    @Synchronized
    fun onReplied(sessionKey: String): String? {
        val at = list.indexOfLast {
            it.sessionKey == sessionKey && it.outcome == Outcome.PENDING &&
                (it.kind == AlertKind.DONE || it.kind == AlertKind.ERROR)
        }
        if (at < 0) return null
        list[at] = list[at].copy(actionLabel = REPLIED, lastError = null)
        publish()
        return list[at].alertId
    }

    /** agentd closed the alert for [reason]: `acted`, `expired`, `withdrawn` (or `dismissed`). */
    @Synchronized
    fun onClosed(id: String, reason: String) = whilePending(id) {
        when (reason) {
            "acted" -> it.copy(outcome = Outcome.ACTED, actionLabel = it.actionLabel ?: HANDLED, endedAtMs = clock())
            "expired" -> it.copy(outcome = Outcome.EXPIRED, endedAtMs = clock())
            "dismissed" -> it.copy(outcome = Outcome.DISMISSED, endedAtMs = clock())
            else -> it.copy(outcome = Outcome.WITHDRAWN, endedAtMs = clock())
        }
    }

    /** The session left the board: what it still waited on is gone with it. */
    @Synchronized
    fun onSessionGone(sessionKey: String) {
        closedSessions += sessionKey
        for (i in list.indices) {
            val entry = list[i]
            if (entry.sessionKey == sessionKey && entry.outcome == Outcome.PENDING) {
                list[i] = entry.copy(outcome = Outcome.WITHDRAWN, endedAtMs = clock())
            }
        }
        publish()
    }

    /** [prune] as of now, under the settings' [policy]. */
    fun pruneNow(policy: HistoryPolicy) = prune(clock(), policy.windowMs, policy.keepAfterSession)

    /** What the history screen shows: expiry is applied first, so it never depends on other activity. */
    fun entriesFor(policy: HistoryPolicy): List<HistoryEntry> {
        pruneNow(policy)
        return entries.value
    }

    /** Drops every entry shown more than [windowMs] ago, and those of a closed session unless [keepAfterSession]. */
    @Synchronized
    fun prune(now: Long, windowMs: Long, keepAfterSession: Boolean) {
        val removed = list.removeAll { entry ->
            now - entry.firstShownAtMs > windowMs ||
                (!keepAfterSession && entry.sessionKey in closedSessions)
        }
        closedSessions.retainAll(list.mapTo(HashSet()) { it.sessionKey })
        if (removed) publish()
    }

    @Synchronized
    fun clear() {
        list.clear()
        closedSessions.clear()
        publish()
    }

    private inline fun whilePending(id: String, change: (HistoryEntry) -> HistoryEntry) {
        val at = list.indexOfFirst { it.alertId == id && it.outcome == Outcome.PENDING }
        if (at < 0) return
        val next = change(list[at])
        if (next == list[at]) return
        list[at] = next
        publish()
    }

    private fun publish() {
        _entries.value = list.asReversed().toList()
    }

    companion object {
        const val MAX_ENTRIES = 200
        const val ALLOWED = "Allowed"
        const val DENIED = "Denied"
        const val ANSWERED = "Answered"
        const val REPLIED = "Replied"
        const val HANDLED = "Handled"
        const val READ = "Read"
    }
}

/** A session's heading as the board draws it: agentd's own heading, else the session's title. */
internal fun AgentSession.historyHeading(): String =
    (v2?.heading?.takeIf(String::isNotBlank) ?: displayTitle).replace(Regex("\\s+"), " ").trim().take(60)
