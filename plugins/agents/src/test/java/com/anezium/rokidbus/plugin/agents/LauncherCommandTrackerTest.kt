package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LauncherCommandTrackerTest {
    private val session = "claude:s1"
    private var counter = 0
    private val tracker = LauncherCommandTracker(newId = { "id-${++counter}" })

    private fun id(now: Long, command: String = "compact", arg: String? = null, key: String = session): String =
        tracker.msgIdFor(key, command, arg, now) ?: error("held")

    private fun ack(msgId: String, result: String, consumed: Boolean = false, now: Long) =
        tracker.onAck(msgId, result, consumed, now)

    private val compactKey = LauncherCommandTracker.CommandKey(session, "compact", null)

    @Test
    fun retap_after_lost_ack_reuses_msg_id() {
        val first = id(0)
        // No ack ever came: the same command, tapped again, carries the same id.
        assertEquals(first, id(5_000))
        // A different command or argument is its own key.
        assertNotEquals(first, id(5_000, "model", "opus"))
        assertNotEquals(id(5_000, "model", "opus"), id(5_000, "model", "sonnet"))
    }

    @Test
    fun lost_ack_retap_after_10_minutes_reuses_id() {
        val first = id(0)
        assertEquals(first, id(10 * 60_000L))
    }

    @Test
    fun duplicate_ack_shows_already_sent_and_arms_retry() {
        val first = id(0)
        assertEquals(LauncherCommandTracker.AckOutcome.DUPLICATE, ack(first, "duplicate", now = 1_000))
        assertTrue(tracker.retryArmed(compactKey, 1_000))
        assertEquals(ControlMenu.Command.LauncherCompact, tracker.armedCommands(session, 2_000).single())
        assertTrue(tracker.retryArmed(compactKey, 30_999))
        assertFalse(tracker.retryArmed(compactKey, 31_000))
        assertTrue(tracker.armedCommands(session, 31_000).isEmpty())
        // The brief copy for it.
        assertEquals("Already sent — check laptop", ControlMenu.ackNotice(AgentdAction.Ack(first, "duplicate", null)))
    }

    @Test
    fun tap_within_30s_of_duplicate_uses_fresh_id_then_disarms() {
        val first = id(0)
        ack(first, "duplicate", now = 1_000)
        val fresh = id(20_000)
        assertNotEquals(first, fresh)
        assertFalse(tracker.retryArmed(compactKey, 20_001))
        // The fresh id is now the kept one.
        assertEquals(fresh, id(21_000))
        // An ack for the id that was replaced is unknown.
        assertEquals(LauncherCommandTracker.AckOutcome.UNKNOWN, ack(first, "duplicate", now = 22_000))
        assertFalse(tracker.retryArmed(compactKey, 22_000))
    }

    @Test
    fun tap_after_30s_reuses_kept_id() {
        val first = id(0)
        ack(first, "duplicate", now = 1_000)
        assertEquals(first, id(31_001))
    }

    @Test
    fun kept_id_older_than_23h_never_resends_without_informed_tap() {
        val hour = 3_600_000L
        // A lost ack at 25 h: nothing is sent, the retry is armed.
        val lost = id(0)
        assertEquals(lost, id(22 * hour))
        assertNull(tracker.msgIdFor(session, "compact", null, 25 * hour))
        assertTrue(tracker.retryArmed(compactKey, 25 * hour + 1))
        // The informed tap sends a fresh id.
        val informed = id(25 * hour + 5_000)
        assertNotEquals(lost, informed)
        assertFalse(tracker.retryArmed(compactKey, 25 * hour + 5_001))

        // A consumed rejection kept for 25 h behaves the same.
        val consumed = id(0, "model", "opus")
        assertEquals(LauncherCommandTracker.AckOutcome.KEPT_CONSUMED, ack(consumed, "rejected", consumed = true, now = 1_000))
        assertNull(tracker.msgIdFor(session, "model", "opus", 25 * hour))
        val again = id(25 * hour + 2_000, "model", "opus")
        assertNotEquals(consumed, again)
        assertEquals("May already have been sent — tap again to send", ControlMenu.MAY_ALREADY_BE_SENT)
    }

    @Test
    fun consumed_rejection_keeps_id_so_retap_is_duplicate() {
        val first = id(0)
        assertEquals(LauncherCommandTracker.AckOutcome.KEPT_CONSUMED, ack(first, "rejected", consumed = true, now = 1_000))
        // The retap sends the same id, which agentd answers `duplicate`.
        assertEquals(first, id(2_000))
        assertEquals(LauncherCommandTracker.AckOutcome.DUPLICATE, ack(first, "duplicate", now = 2_500))
        assertTrue(tracker.retryArmed(compactKey, 2_500))
        assertEquals(
            "Sent, but may not have finished — check laptop",
            ControlMenu.ackNotice(AgentdAction.Ack(first, "rejected", "typed_after_cancel", consumed = true)),
        )
    }

    @Test
    fun unconsumed_rejection_frees_id() {
        val first = id(0)
        assertEquals(LauncherCommandTracker.AckOutcome.FREED, ack(first, "rejected", consumed = false, now = 1_000))
        assertNotEquals(first, id(2_000))
    }

    @Test
    fun applied_ack_clears_kept_id() {
        val first = id(0)
        assertEquals(LauncherCommandTracker.AckOutcome.APPLIED, ack(first, "applied", now = 1_000))
        assertNotEquals(first, id(2_000))
    }

    @Test
    fun an_unknown_msg_id_is_ignored_and_kept_ids_go_with_their_session() {
        assertEquals(LauncherCommandTracker.AckOutcome.UNKNOWN, ack("nobody", "duplicate", now = 0))
        val kept = id(0)
        val other = id(0, key = "claude:s2")
        tracker.forgetSession(session)
        assertNotEquals(kept, id(1_000))
        assertEquals(other, id(1_000, key = "claude:s2"))
        assertEquals(LauncherCommandTracker.AckOutcome.UNKNOWN, ack(kept, "duplicate", now = 1_500))
    }

    @Test
    fun service_send_and_ack_path_uses_tracker() {
        var ids = 0
        val wire = mutableListOf<String>()
        var now = 0L
        val sender = ControlSender(write = { wire += it }, clock = { now }, newId = { "m${++ids}" })
        fun msgIdOf(index: Int) = JSONObject(wire[index]).getString("msgId")

        val sent = sender.send(ControlMenu.Command.LauncherCompact, session) as ControlSender.Sent.Written
        assertTrue(sent.steers)
        assertEquals("launcher_command", JSONObject(wire[0]).getString("type"))
        // The ack is lost; the wearer taps again and the same id goes out.
        now = 60_000
        sender.send(ControlMenu.Command.LauncherCompact, session)
        assertEquals(msgIdOf(0), msgIdOf(1))
        // agentd says duplicate: the menu shows the retry, and the next tap is an informed resend.
        assertEquals(
            LauncherCommandTracker.AckOutcome.DUPLICATE,
            sender.onAck(AgentdAction.Ack(msgIdOf(1), "duplicate", null)),
        )
        assertEquals(setOf<ControlMenu.Command>(ControlMenu.Command.LauncherCompact), sender.armed(session))
        now = 70_000
        sender.send(ControlMenu.Command.LauncherCompact, session)
        assertNotEquals(msgIdOf(1), msgIdOf(2))
        assertEquals(emptySet<ControlMenu.Command>(), sender.armed(session))
        // Applied frees it; the next command is a new one.
        assertEquals(LauncherCommandTracker.AckOutcome.APPLIED, sender.onAck(AgentdAction.Ack(msgIdOf(2), "applied", null)))
        sender.send(ControlMenu.Command.LauncherCompact, session)
        assertNotEquals(msgIdOf(2), msgIdOf(3))
        // Other control commands never go through the tracker: a fresh id each time.
        sender.send(ControlMenu.Command.CodexCompact, "codex:s9")
        sender.send(ControlMenu.Command.CodexCompact, "codex:s9")
        assertNotEquals(msgIdOf(4), msgIdOf(5))
        // A kept id past 23 h is held, never written.
        val before = wire.size
        sender.send(ControlMenu.Command.LauncherModel("opus"), session)
        now += 24 * 3_600_000L
        assertEquals(ControlSender.Sent.Held, sender.send(ControlMenu.Command.LauncherModel("opus"), session))
        assertEquals(before + 1, wire.size)
        assertNotNull(sender.armed(session).firstOrNull { it == ControlMenu.Command.LauncherModel("opus") })
    }

    /** The service's wiring: a real store, a [ControlSender] following it, and the frames it wrote. */
    private class Wired(scope: CoroutineScope) {
        var ids = 0
        val wire = mutableListOf<String>()
        val store = AgentSessionStore()
        val sender = ControlSender(write = { wire += it }, clock = { 0L }, newId = { "m${++ids}" })
        val board = AgentSession(id = "s1", provider = AgentProvider.CLAUDE, title = "s1", status = AgentStatus.WORKING)

        init {
            sender.follow(store, scope)
        }

        fun msgIdOf(index: Int): String = JSONObject(wire[index]).getString("msgId")

        fun tap() = sender.send(ControlMenu.Command.LauncherCompact, board.key) as ControlSender.Sent.Written

        /** agentd's snapshot over a fresh link. */
        fun snapshot(vararg sessions: AgentSession) =
            store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, sessions.toList())

        /** An inbound disconnect, a monitoring stop or a link drop: the transport empties the board. */
        fun transportClear() = store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList())
    }

    @Test
    fun consumed_rejection_survives_disconnect_reconnect_retap_is_duplicate() = runBlocking {
        val w = Wired(this)
        w.snapshot(w.board)
        yield()
        val sent = w.tap()
        assertEquals(
            LauncherCommandTracker.AckOutcome.KEPT_CONSUMED,
            w.sender.onAck(AgentdAction.Ack(sent.msgId, "rejected", "typed_after_cancel", consumed = true)),
        )
        // The link drops and comes back with the same session: the kept id was never agentd's to free.
        w.transportClear()
        yield()
        w.snapshot(w.board)
        yield()
        w.tap()
        assertEquals("a re-tap must carry the consumed id, so agentd answers duplicate", w.msgIdOf(0), w.msgIdOf(1))

        // agentd itself reports the session removed: now the id goes with it.
        w.store.remove(AgentProvider.CLAUDE, "s1")
        yield()
        w.snapshot(w.board)
        yield()
        w.tap()
        assertNotEquals(w.msgIdOf(1), w.msgIdOf(2))
        coroutineContext.cancelChildren()
    }

    @Test
    fun lost_ack_survives_disconnect_reconnect_retap_reuses_id() = runBlocking {
        val w = Wired(this)
        w.snapshot(w.board)
        yield()
        w.tap()
        // No ack: the link drops before it lands, and comes back.
        w.transportClear()
        yield()
        w.snapshot(w.board)
        yield()
        w.tap()
        assertEquals("a re-tap after a lost ack must reuse the id, never compact twice", w.msgIdOf(0), w.msgIdOf(1))
        coroutineContext.cancelChildren()
    }
}
