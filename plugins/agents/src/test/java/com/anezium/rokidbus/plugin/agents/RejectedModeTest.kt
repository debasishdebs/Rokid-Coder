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

    private fun approvalSub(): String? {
        val state = ControlMenu.open(session.key).copy(notApplied = store.notApplied(session.key))
        return ControlMenu.page(state, session, secure = true).rows.first { it.text.contains("pprov", ignoreCase = true) }.sub
    }

    @Test
    fun rejected_mode_change_shown_on_menu_until_next_upsert() {
        store.upsert(session)
        assertEquals("ask", approvalSub())

        store.noteNotApplied(session.key, "session is busy")
        // The real mode stays, and what agentd refused sits beside it.
        assertEquals("ask · Not applied: session is busy", approvalSub())

        // Another session's upsert leaves it alone.
        store.upsert(session.copy(id = "other"))
        assertTrue(approvalSub()!!.contains("Not applied"))

        store.upsert(session)
        assertNull(store.notApplied(session.key))
        assertEquals("ask", approvalSub())
    }

    @Test
    fun a_snapshot_or_a_removal_also_ends_it() {
        store.noteNotApplied(session.key, "x")
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session))
        assertNull(store.notApplied(session.key))

        store.noteNotApplied(session.key, "x")
        store.remove(session.provider, session.id)
        assertNull(store.notApplied(session.key))
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
    fun a_monitor_only_link_still_says_monitor_only_not_the_rejection() {
        store.noteReplyNotSent(session.key, "x")
        val state = ControlMenu.open(session.key).copy(replyNotSent = "x")
        val sub = ControlMenu.page(state, session, secure = false).rows.first { it.text == "Reply by voice" }.sub
        assertEquals(ControlMenu.MONITOR_ONLY, sub)
    }
}
