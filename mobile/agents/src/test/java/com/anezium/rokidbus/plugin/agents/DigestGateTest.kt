package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DigestGateTest {
    private var now = 1_000L

    private fun gate(periodMs: Long = 60_000L) = DigestGate({ now }, periodMs)

    private fun session(
        id: String = "s1",
        status: AgentStatus = AgentStatus.WORKING,
        tempMode: TempMode = TempMode.ASK,
        step: String? = "a",
    ) = AgentSession(
        id = id,
        provider = AgentProvider.CLAUDE,
        status = status,
        v2 = SessionV2(
            mode = "plugin",
            canCompact = false,
            canModel = false,
            followup = FollowupState.READY,
            tempMode = tempMode,
            nativeMode = null,
            heading = "h",
            currentFile = null,
            step = step,
            contextUsed = null,
            contextWindow = null,
            pendingModel = null,
            pendingEffort = null,
            sandbox = null,
        ),
    )

    /** The first push, so a period is running. */
    private fun DigestGate.primed(sessions: List<AgentSession>): DigestGate {
        assertTrue(shouldPush(null, sessions))
        return this
    }

    @Test
    fun the_first_board_is_always_pushed() {
        assertTrue(gate().shouldPush(null, listOf(session())))
    }

    @Test
    fun digest_holds_progress_updates_for_period() {
        val first = listOf(session(step = "a"))
        val gate = gate().primed(first)

        now += 10_000L
        assertFalse(gate.shouldPush(first, listOf(session(step = "b"))))
        now += 49_000L
        assertFalse(gate.shouldPush(first, listOf(session(step = "c"))))
        now += 1_000L
        assertTrue(gate.shouldPush(first, listOf(session(step = "d"))))
    }

    @Test
    fun an_unchanged_board_is_never_pushed() {
        val first = listOf(session())
        val gate = gate().primed(first)

        now += 120_000L
        assertFalse(gate.shouldPush(first, listOf(session())))
        assertNull(gate.nextFlushAt())
    }

    @Test
    fun digest_pushes_status_change_to_done_immediately() {
        val first = listOf(session(status = AgentStatus.WORKING))
        val gate = gate().primed(first)

        now += 1_000L
        assertTrue(gate.shouldPush(first, listOf(session(status = AgentStatus.DONE))))
    }

    @Test
    fun a_status_change_into_or_out_of_needs_you_or_error_is_immediate() {
        listOf(AgentStatus.NEEDS_YOU, AgentStatus.ERROR).forEach { urgent ->
            val working = listOf(session(status = AgentStatus.WORKING))
            val into = gate().primed(working)
            now += 1_000L
            assertTrue("into $urgent", into.shouldPush(working, listOf(session(status = urgent))))

            val waiting = listOf(session(status = urgent))
            val out = gate().primed(waiting)
            now += 1_000L
            assertTrue("out of $urgent", out.shouldPush(waiting, listOf(session(status = AgentStatus.WORKING))))
        }
    }

    @Test
    fun working_to_idle_is_just_progress() {
        val first = listOf(session(status = AgentStatus.WORKING))
        val gate = gate().primed(first)

        now += 1_000L
        assertFalse(gate.shouldPush(first, listOf(session(status = AgentStatus.IDLE))))
    }

    @Test
    fun a_session_added_or_removed_is_immediate() {
        val one = listOf(session("s1"))
        val two = listOf(session("s1"), session("s2"))
        val gate = gate().primed(one)

        now += 1_000L
        assertTrue(gate.shouldPush(one, two))
        now += 1_000L
        assertTrue(gate.shouldPush(two, one))
    }

    @Test
    fun a_temp_mode_change_is_immediate() {
        val first = listOf(session(tempMode = TempMode.ASK))
        val gate = gate().primed(first)

        now += 1_000L
        assertTrue(gate.shouldPush(first, listOf(session(tempMode = TempMode.APPROVE_ALL))))
    }

    @Test
    fun an_immediate_push_carries_the_held_progress_and_restarts_the_period() {
        val first = listOf(session(step = "a"))
        val gate = gate().primed(first)

        now += 5_000L
        assertFalse(gate.shouldPush(first, listOf(session(step = "b"))))
        assertEquals(1_000L + 60_000L, gate.nextFlushAt())
        now += 5_000L
        val done = listOf(session(status = AgentStatus.DONE, step = "b"))
        assertTrue(gate.shouldPush(first, done))
        assertNull(gate.nextFlushAt())

        now += 30_000L
        assertFalse(gate.shouldPush(done, listOf(session(status = AgentStatus.DONE, step = "c"))))
        assertEquals(11_000L + 60_000L, gate.nextFlushAt())
    }

    @Test
    fun live_mode_pushes_everything() {
        val first = listOf(session(step = "a"))
        val gate = gate(periodMs = 0L).primed(first)

        assertTrue(gate.shouldPush(first, listOf(session(step = "b"))))
        assertTrue(gate.shouldPush(first, listOf(session(step = "c"))))
        assertTrue(gate.shouldPush(first, first))
        assertNull(gate.nextFlushAt())
    }

    @Test
    fun switching_to_live_releases_a_held_change() {
        val first = listOf(session(step = "a"))
        val gate = gate().primed(first)
        now += 1_000L
        assertFalse(gate.shouldPush(first, listOf(session(step = "b"))))

        gate.periodMs = 0L
        assertNull(gate.nextFlushAt())
        assertTrue(gate.shouldPush(first, listOf(session(step = "b"))))
    }

    @Test
    fun held_change_is_flushed_at_period_end_even_without_new_traffic() {
        val first = listOf(session(step = "a"))
        val next = listOf(session(step = "b"))
        val gate = gate().primed(first)
        assertNull(gate.nextFlushAt())

        now += 20_000L
        assertFalse(gate.shouldPush(first, next))
        val flushAt = gate.nextFlushAt()
        assertEquals(1_000L + 60_000L, flushAt)

        // No other traffic: the service wakes at flushAt and asks again.
        now = flushAt!! - 1L
        assertFalse(gate.shouldPush(first, next))
        assertEquals(flushAt, gate.nextFlushAt())
        now = flushAt
        assertTrue(gate.shouldPush(first, next))
        assertNull(gate.nextFlushAt())
    }

    @Test
    fun a_held_change_that_reverts_before_the_flush_is_dropped() {
        val first = listOf(session(step = "a"))
        val gate = gate().primed(first)
        now += 1_000L
        assertFalse(gate.shouldPush(first, listOf(session(step = "b"))))

        assertFalse(gate.shouldPush(first, first))
        assertNull(gate.nextFlushAt())
    }

    @Test
    fun a_board_drawn_for_another_reason_restarts_the_period() {
        val first = listOf(session(step = "a"))
        val gate = gate().primed(first)
        now += 50_000L
        // The wearer moved the selection: the board was redrawn with everything.
        gate.markPushed()

        now += 20_000L
        assertFalse(gate.shouldPush(listOf(session(step = "b")), listOf(session(step = "c"))))
    }
}
