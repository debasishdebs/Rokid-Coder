package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertHistoryTest {
    private var now = 1_000_000L
    private val history = AlertHistory(clock = { now })
    private val hour = 3_600_000L

    private fun alert(
        id: String = "A",
        kind: String = "approval",
        reason: String = "new",
        sessionKey: String = "claude:s1",
    ) = AgentdAction.Alert(
        id = id,
        sessionKey = sessionKey,
        kind = AlertKind.fromWire(kind)!!,
        title = "t",
        body = "b",
        actions = emptyList(),
        question = null,
        waiting = 0,
        reason = AlertReason.fromWire(reason),
    )

    private fun only() = history.entries.value.single()

    @Test
    fun first_show_records_provider_kind_and_heading() {
        history.onShown(alert(sessionKey = "codex:s9", kind = "question"), "my-repo")
        val entry = only()
        assertEquals("CODEX", entry.provider)
        assertEquals(AlertKind.QUESTION, entry.kind)
        assertEquals("my-repo", entry.heading)
        assertEquals(1, entry.shownCount)
        assertEquals(Outcome.PENDING, entry.outcome)
        assertEquals(1_000_000L, entry.firstShownAtMs)
    }

    @Test
    fun entries_are_newest_first() {
        history.onShown(alert(id = "A"), "h")
        now += 1
        history.onShown(alert(id = "B"), "h")
        assertEquals(listOf("B", "A"), history.entries.value.map { it.alertId })
    }

    @Test
    fun acted_with_no_attempt_is_handled_and_with_one_keeps_the_label() {
        history.onShown(alert(id = "A"), "h")
        history.onShown(alert(id = "B"), "h")
        history.onActionAttempted("B", AlertHistory.DENIED)
        history.onClosed("A", "acted")
        history.onClosed("B", "acted")
        val byId = history.entries.value.associateBy { it.alertId }
        assertEquals("Handled", byId.getValue("A").actionLabel)
        assertEquals("Denied", byId.getValue("B").actionLabel)
        assertEquals(Outcome.ACTED, byId.getValue("B").outcome)
    }

    @Test
    fun an_attempt_never_finalises_and_a_later_close_for_it_expires() {
        history.onShown(alert(), "h")
        history.onActionAttempted("A", AlertHistory.ALLOWED)
        assertEquals(Outcome.PENDING, only().outcome)
        history.onClosed("A", "expired")
        assertEquals(Outcome.EXPIRED, only().outcome)
        // An ended entry takes no further word.
        history.onClosed("A", "acted")
        history.onActionRejected("A", "late")
        assertEquals(Outcome.EXPIRED, only().outcome)
        assertEquals(null, only().lastError)
    }

    @Test
    fun a_new_attempt_clears_an_earlier_rejection() {
        history.onShown(alert(), "h")
        history.onActionRejected("A", "monitor_only")
        assertEquals("monitor_only", only().lastError)
        history.onActionAttempted("A", AlertHistory.ALLOWED)
        assertEquals(null, only().lastError)
    }

    @Test
    fun dismissing_a_done_or_error_is_final_but_an_approval_only_parks() {
        history.onShown(alert(id = "D", kind = "done"), "h")
        history.onShown(alert(id = "E", kind = "error"), "h")
        history.onShown(alert(id = "Q", kind = "question"), "h")
        history.onShown(alert(id = "P", kind = "approval"), "h")
        history.onDismissed("D")
        history.onDismissed("E", read = true)
        history.onDismissed("Q")
        history.onDismissed("P")
        val byId = history.entries.value.associateBy { it.alertId }
        assertEquals(Outcome.DISMISSED, byId.getValue("D").outcome)
        assertEquals(Outcome.DISMISSED, byId.getValue("E").outcome)
        assertEquals("Read", byId.getValue("E").actionLabel)
        assertEquals(Outcome.PENDING, byId.getValue("Q").outcome)
        assertEquals(Outcome.PENDING, byId.getValue("P").outcome)
    }

    @Test
    fun a_withdrawn_entry_comes_back_when_agentd_shows_it_again() {
        history.onShown(alert(), "h")
        history.onSessionGone("claude:s1")
        assertEquals(Outcome.WITHDRAWN, only().outcome)
        history.onShown(alert(reason = "retry"), "h")
        assertEquals(Outcome.PENDING, only().outcome)
        assertEquals(1, only().shownCount)
    }

    @Test
    fun closed_session_entries_dropped_unless_keep() {
        history.onShown(alert(id = "A", sessionKey = "claude:s1"), "h")
        history.onShown(alert(id = "B", sessionKey = "claude:s2"), "h")
        history.onSessionGone("claude:s1")

        history.prune(now, hour, keepAfterSession = true)
        assertEquals(setOf("A", "B"), history.entries.value.map { it.alertId }.toSet())
        assertEquals(Outcome.WITHDRAWN, history.entries.value.single { it.alertId == "A" }.outcome)

        history.prune(now, hour, keepAfterSession = false)
        assertEquals(listOf("B"), history.entries.value.map { it.alertId })
    }

    @Test
    fun window_prunes_old_entries() {
        history.onShown(alert(id = "old"), "h")
        now += 2 * hour
        history.onShown(alert(id = "new"), "h")
        history.prune(now, hour, keepAfterSession = true)
        assertEquals(listOf("new"), history.entries.value.map { it.alertId })
    }

    @Test
    fun cap_is_200() {
        for (i in 0 until 205) {
            now += 1
            history.onShown(alert(id = "id$i"), "h")
        }
        val ids = history.entries.value.map { it.alertId }
        assertEquals(200, ids.size)
        assertEquals("id204", ids.first())
        assertEquals("id5", ids.last())
    }

    @Test
    fun clear_empties_the_list() {
        history.onShown(alert(), "h")
        history.clear()
        assertTrue(history.entries.value.isEmpty())
    }

    @Test
    fun heading_is_the_v2_heading_else_the_title() {
        val plain = AgentSession(id = "s1", provider = AgentProvider.CLAUDE, title = "my  repo", status = AgentStatus.IDLE)
        assertEquals("my repo", plain.historyHeading())
        val v2 = plain.copy(
            v2 = SessionV2(
                mode = "plugin", canCompact = false, canModel = false, followup = FollowupState.READY,
                tempMode = TempMode.ASK, nativeMode = null, heading = "Fixing the build", currentFile = null, step = null,
                contextUsed = null, contextWindow = null, pendingModel = null, pendingEffort = null, sandbox = null,
            ),
        )
        assertEquals("Fixing the build", v2.historyHeading())
    }

    @Test
    fun late_close_does_not_extend_window() {
        history.onShown(alert(id = "A"), "h")
        now += 23 * hour
        history.onClosed("A", "acted")
        now += 2 * hour
        // Shown 25 hours ago: gone under a 24 hour window, however late it ended.
        history.prune(now, 24 * hour, keepAfterSession = true)
        assertTrue(history.entries.value.isEmpty())
    }

    @Test
    fun idle_clock_advance_prunes_on_open() {
        val policy = HistoryPolicy(windowMs = hour, keepAfterSession = true)
        history.onShown(alert(id = "A"), "h")
        now += 2 * hour
        // Nothing happened meanwhile, so the list still holds it.
        assertEquals(1, history.entries.value.size)
        // Opening the screen reads through the policy.
        assertTrue(history.entriesFor(policy).isEmpty())
        assertTrue(history.entries.value.isEmpty())
    }

    @Test
    fun a_reply_rejection_reaches_its_entry() {
        history.onShown(alert(id = "D", kind = "done"), "h")
        assertEquals("D", history.onReplied("claude:s1"))
        assertEquals(null, history.onReplied("claude:other"))
    }
}
