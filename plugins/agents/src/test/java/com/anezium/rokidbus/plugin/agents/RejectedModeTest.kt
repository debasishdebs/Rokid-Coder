package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RejectedModeTest {
    private val store = AgentSessionStore()
    private val session = AgentSession(
        id = "s1",
        provider = AgentProvider.CLAUDE,
        status = AgentStatus.WORKING,
        v2 = SessionV2(
            mode = "plugin", canCompact = false, canModel = false, followup = FollowupState.READY,
            tempMode = TempMode.ASK, nativeMode = null, heading = "h", currentFile = null, step = null,
            contextUsed = null, contextWindow = null, pendingModel = null, pendingEffort = null, sandbox = null,
        ),
    )

    private fun approvalSub(nowMs: Long = 0L, shown: AgentSession = session): String? {
        val state = ControlMenu.open(session.key).copy(notApplied = store.notApplied(session.key, nowMs))
        return ControlMenu.page(state, shown, secure = true).rows.first { it.text.contains("pprov", ignoreCase = true) }.sub
    }

    private val edits = session.copy(v2 = session.v2!!.copy(tempMode = TempMode.ACCEPT_EDITS))

    @Test
    fun rejected_mode_change_shown_on_menu_until_the_mode_changes() {
        store.upsert(session)
        assertEquals("ask", approvalSub())

        store.noteNotApplied(session.key, "session is busy", nowMs = 0L)
        // The real mode stays, and what agentd refused sits beside it.
        assertEquals("ask · Not applied: session is busy", approvalSub())

        // Another session's upsert leaves it alone.
        store.upsert(session.copy(id = "other"))
        assertTrue(approvalSub()!!.contains("Not applied"))

        // A mode that did change ends it.
        store.upsert(edits)
        assertNull(store.notApplied(session.key, 0L))
        assertEquals("accept edits", approvalSub(shown = edits))
    }

    @Test
    fun not_applied_survives_same_mode_upsert() {
        store.upsert(session)
        store.noteNotApplied(session.key, "session is busy", nowMs = 1_000L)
        // A busy session upserts on every tool call; its mode is still the one shown.
        repeat(20) { store.upsert(session.copy(status = AgentStatus.WORKING, lastActivityAt = it.toLong())) }
        assertEquals("ask · Not applied: session is busy", approvalSub(nowMs = 30_999L))
        // Thirty seconds on, it has said its piece.
        assertNull(store.notApplied(session.key, nowMs = 31_000L))
        assertEquals("ask", approvalSub(nowMs = 31_000L))
    }

    @Test
    fun a_snapshot_or_a_removal_also_ends_it() {
        store.noteNotApplied(session.key, "x", nowMs = 0L)
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session))
        assertNull(store.notApplied(session.key, 0L))

        store.noteNotApplied(session.key, "x", nowMs = 0L)
        store.remove(session.provider, session.id)
        assertNull(store.notApplied(session.key, 0L))
    }

    private fun replySub(): String? {
        val state = ControlMenu.open(session.key).copy(replyNotSent = store.replyNotSent(session.key))
        return ControlMenu.page(state, session, secure = true).rows.first { it.text == "Reply by voice" }.sub
    }

    @Test
    fun rejected_followup_shown_on_menu() {
        store.upsert(session)
        assertNull(replySub())

        store.noteReplyNotSent(session.key, "session not waiting")
        assertEquals("Reply not sent: session not waiting", replySub())

        // Unlike a refused mode, an upsert of the session does not end it.
        store.upsert(session)
        assertEquals("Reply not sent: session not waiting", replySub())

        // The next follow-up (or a followup_closed) clears it.
        store.clearReplyNotSent(session.key)
        assertNull(replySub())
    }

    @Test
    fun no_secure_link_says_computer_not_connected_not_the_rejection() {
        store.noteReplyNotSent(session.key, "x")
        val state = ControlMenu.open(session.key).copy(replyNotSent = "x")
        val sub = ControlMenu.page(state, session, secure = false).rows.first { it.text == "Reply by voice" }.sub
        assertEquals("Computer not connected", sub)
    }
}
