package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusRowTone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoardModelTest {
    private fun v2(
        mode: String = "plugin",
        tempMode: TempMode = TempMode.ASK,
        nativeMode: String? = null,
        heading: String = "Fix the login redirect",
        currentFile: String? = "src/auth/login.ts",
        step: String? = "running tests",
    ) = SessionV2(
        mode = mode,
        canCompact = false,
        canModel = false,
        followup = FollowupState.READY,
        tempMode = tempMode,
        nativeMode = nativeMode,
        heading = heading,
        currentFile = currentFile,
        step = step,
        contextUsed = null,
        contextWindow = null,
        pendingModel = null,
        pendingEffort = null,
        sandbox = null,
    )

    private fun session(
        provider: AgentProvider = AgentProvider.CLAUDE,
        status: AgentStatus = AgentStatus.WORKING,
        v2: SessionV2? = v2(),
        title: String? = "my-repo",
    ) = AgentSession(id = "s1", provider = provider, title = title, status = status, v2 = v2)

    private fun row(session: AgentSession, selected: Boolean = false) =
        BoardModel.row(session, selected, now = 1_000_000L)

    @Test
    fun row_shows_badge_heading_file_step_and_mode_tags() {
        val line = row(session(), selected = true)

        assertEquals("CLAUDE", line.badge)
        assertEquals("Fix the login redirect", line.text)
        assertEquals("src/auth/login.ts · running tests", line.sub)
        assertEquals(listOf("RUN", "PLUGIN", "ASK"), line.trail)
        assertTrue(line.selected)
        assertEquals(NexusRowTone.NORMAL, line.tone)
    }

    @Test
    fun codex_row_has_its_own_badge_and_permissive_native_mode_tag() {
        val line = row(
            session(
                provider = AgentProvider.CODEX,
                status = AgentStatus.NEEDS_YOU,
                v2 = v2(mode = "launcher", tempMode = TempMode.ACCEPT_EDITS, nativeMode = "never"),
            ),
        )

        assertEquals("CODEX", line.badge)
        assertEquals(listOf("ASK", "LAUNCHER", "EDITS", "never"), line.trail)
        assertEquals(NexusRowTone.ALERT, line.tone)
    }

    @Test
    fun restrictive_native_mode_is_not_tagged() {
        val line = row(session(v2 = v2(nativeMode = "on-request")))

        assertEquals(listOf("RUN", "PLUGIN", "ASK"), line.trail)
    }

    @Test
    fun approve_all_row_is_alert_tone_with_ALL_tag() {
        // Even a quiet session: the standing permission must never hide.
        val line = row(session(status = AgentStatus.IDLE, v2 = v2(tempMode = TempMode.APPROVE_ALL)))

        assertEquals(NexusRowTone.ALERT, line.tone)
        assertEquals(listOf("PLUGIN", "ALL"), line.trail)
    }

    @Test
    fun plugin_mode_claude_row_tag_PLUGIN() {
        val line = row(session(provider = AgentProvider.CLAUDE, v2 = v2(mode = "plugin")))

        assertEquals("CLAUDE", line.badge)
        assertTrue("PLUGIN" in line.trail)
        assertTrue("LAUNCHER" !in line.trail)
    }

    @Test
    fun state_tags_follow_status() {
        fun state(status: AgentStatus) = row(session(status = status)).trail.first()

        assertEquals("ASK", state(AgentStatus.NEEDS_YOU))
        assertEquals("RUN", state(AgentStatus.WORKING))
        assertEquals("ERR", state(AgentStatus.ERROR))
        assertEquals("done", state(AgentStatus.DONE))
        assertEquals("PLUGIN", state(AgentStatus.IDLE))
    }

    @Test
    fun sub_omits_the_part_that_is_absent() {
        assertEquals("login.ts", row(session(v2 = v2(currentFile = "login.ts", step = null))).sub)
        assertEquals("compiling", row(session(v2 = v2(currentFile = null, step = "compiling"))).sub)
        assertNull(row(session(v2 = v2(currentFile = null, step = null))).sub)
    }

    @Test
    fun a_blank_heading_falls_back_to_the_display_title() {
        assertEquals("my-repo", row(session(v2 = v2(heading = "  "))).text)
    }

    @Test
    fun a_session_without_v2_keeps_the_plain_row_and_the_caller_sub() {
        val line = BoardModel.row(
            session(v2 = null),
            selected = false,
            now = 1_000_000L,
            fallbackSub = "wants to run Bash",
        )

        assertEquals("my-repo", line.text)
        assertEquals("wants to run Bash", line.sub)
        assertEquals(listOf("RUN"), line.trail)
        assertEquals("CLAUDE", line.badge)
    }

    @Test
    fun the_caller_sub_is_only_a_fallback_for_a_v2_row_with_no_file_or_step() {
        val line = BoardModel.row(
            session(v2 = v2(currentFile = null, step = null)),
            selected = false,
            now = 0L,
            fallbackSub = "wants to run Bash",
        )
        assertEquals("wants to run Bash", line.sub)
        assertEquals(
            "a.kt · b",
            BoardModel.row(
                session(v2 = v2(currentFile = "a.kt", step = "b")),
                selected = false,
                now = 0L,
                    fallbackSub = "wants to run Bash",
            ).sub,
        )
    }

    @Test
    fun row_strings_capped_for_sdk() {
        val long = "x".repeat(600)
        val line = row(
            session(
                title = long,
                v2 = v2(
                    heading = long,
                    currentFile = long,
                    step = long,
                    mode = long,
                    nativeMode = "bypassPermissions",
                ),
            ),
        )

        assertEquals(120, line.text.length)
        assertEquals(240, line.sub!!.length)
        assertTrue(line.badge!!.length <= 24)
        // state, mode, temp mode and a permissive native mode: the longest row there is.
        assertEquals(4, line.trail.size)
        assertEquals(24, line.trail[1].length)
        assertEquals("bypassPermissions", line.trail[3])
        assertTrue(line.trail.all { it.length <= 24 })
        // A multi-line heading is one line on the glasses.
        assertEquals("a b", row(session(v2 = v2(heading = "a\n  b"))).text)
    }

    @Test
    fun a_long_display_title_is_capped_when_there_is_no_heading() {
        val long = "t".repeat(600)

        assertEquals(120, row(session(title = long, v2 = null)).text.length)
        assertEquals(120, row(session(title = long, v2 = v2(heading = " "))).text.length)
    }

    @Test
    fun long_path_keeps_file_name() {
        val path = "/Users/me/" + "deep/".repeat(80) + "src/foo.ts"
        val sub = row(session(v2 = v2(currentFile = path, step = null))).sub!!

        assertTrue(sub.startsWith("…/"))
        assertTrue(sub.endsWith("/src/foo.ts"))
        assertTrue(sub.length <= 240)
        assertEquals("src/foo.ts", row(session(v2 = v2(currentFile = "src/foo.ts", step = null))).sub)
    }

    @Test
    fun step_survives_long_path() {
        val path = "/" + "d".repeat(400) + "/foo.ts"
        val sub = row(session(v2 = v2(currentFile = path, step = "running tests"))).sub!!

        assertTrue(sub.endsWith("foo.ts · running tests"))
        assertTrue(sub.length <= 240)
        // A long step keeps its own budget and still leaves the file name room.
        val both = row(session(v2 = v2(currentFile = path, step = "s".repeat(500)))).sub!!
        assertTrue(both.contains("foo.ts · "))
        assertTrue(both.length <= 240)
    }

    @Test
    fun age_tick_refreshes_non_v2_rows() {
        val plain = session(v2 = null).copy(lastActivityAt = 0L)
        val tagged = session().copy(lastActivityAt = 0L)

        assertTrue(BoardModel.showsAge(plain))
        assertFalse(BoardModel.showsAge(tagged))
        assertFalse(BoardModel.showsAge(session(v2 = null)))
        // The age the tick has to redraw: it moves with the clock, the row is otherwise equal.
        assertEquals(listOf("RUN", "5m"), BoardModel.row(plain, false, now = 5 * 60_000L).trail)
        assertEquals(listOf("RUN", "6m"), BoardModel.row(plain, false, now = 6 * 60_000L).trail)
    }

    @Test
    fun waiting_row_shown_when_n_positive() {
        val line = BoardModel.waitingRow(2)!!

        assertEquals("+2 waiting", line.text)
        assertEquals(NexusRowTone.ALERT, line.tone)
        assertNull(BoardModel.waitingRow(0))
        assertNull(BoardModel.waitingRow(-1))
    }

    @Test
    fun quiet_row_says_the_toggle_state_and_follows_selection() {
        val on = BoardModel.quietRow(quiet = true, selected = false)
        val off = BoardModel.quietRow(quiet = false, selected = true)

        assertEquals("Quiet: on", on.text)
        assertFalse(on.selected)
        assertEquals("Quiet: off", off.text)
        assertTrue(off.selected)
    }

    @Test
    fun selection_ring_runs_quiet_sessions_start() {
        val keys = listOf("a", "b")
        // Nothing chosen yet counts as the first session; the ring wraps both ways.
        assertEquals("b", BoardModel.step(keys, null, +1))
        assertEquals(BoardModel.QUIET_KEY, BoardModel.step(keys, "a", -1))
        assertEquals(BoardModel.START_KEY, BoardModel.step(keys, BoardModel.QUIET_KEY, -1))
        assertEquals(BoardModel.QUIET_KEY, BoardModel.step(keys, BoardModel.START_KEY, +1))
        assertEquals("a", BoardModel.step(keys, BoardModel.QUIET_KEY, +1))
        // A session that left the board falls back to the first one; an empty board to Start.
        assertEquals("b", BoardModel.step(keys, "gone", +1))
        assertEquals(BoardModel.QUIET_KEY, BoardModel.step(emptyList(), null, +1))
        assertEquals(BoardModel.QUIET_KEY, BoardModel.step(emptyList(), BoardModel.START_KEY, +1))
    }

    @Test
    fun signed_out_row_is_a_problem_row_with_the_next_step() {
        val board = BoardCards.sessionsCard(
            sessions = emptyList(),
            connections = emptyMap(),
            config = AgentsConfig(agentdEnabled = true, agentd = null),
            selectedKey = null,
            waiting = 0,
            quiet = false,
            now = 0L,
            signedOut = listOf(SignedOut("Desk", 1L, 14), SignedOut("Laptop", 1L, 20), SignedOut("Third", 1L, 30)),
        )

        val rows = board.card.richLines.orEmpty().filter { it.text.startsWith("Signed out of ") }
        assertEquals(listOf("Signed out of Desk", "Signed out of Laptop"), rows.map { it.text })
        assertEquals(listOf("pair again: Add a computer"), rows.map { it.sub }.distinct())
        assertEquals(listOf(NexusRowTone.ALERT), rows.map { it.tone }.distinct())
    }

    private fun board(
        config: AgentsConfig,
        pairing: Boolean = false,
        sessions: List<AgentSession> = emptyList(),
        selectedKey: String? = null,
    ) = BoardCards.sessionsCard(
        sessions = sessions,
        connections = emptyMap(),
        config = config,
        selectedKey = selectedKey,
        waiting = 0,
        quiet = false,
        now = 0L,
        pairing = pairing,
    )

    private val monitoringOn = AgentsConfig(agentdEnabled = true, agentd = null)
    private val monitoringOff = AgentsConfig(agentdEnabled = false, agentd = null)

    @Test
    fun board_shows_pair_a_computer_when_none_trusted() {
        val board = board(monitoringOn, pairing = true)
        val rows = board.card.richLines.orEmpty()

        val pair = rows.single { it.text == "Pair a computer" }
        assertEquals("tap to start", pair.sub)
        // With nothing running the row is the one under the wearer's thumb, and Tap opens the guide.
        assertTrue(pair.selected)
        assertEquals(BoardModel.PAIR_KEY, board.selectedKey)
        assertTrue(rows.none { it.text == "Nothing running" || it.text == "Set up a provider in the phone app" })
        assertFalse(rows.single { it.text == "+ Start an agent" }.selected)
    }

    @Test
    fun board_shows_setup_provider_when_monitoring_off() {
        // Monitoring off outranks a missing computer: there is nothing to pair with yet.
        val rows = board(monitoringOff, pairing = true).card.richLines.orEmpty()

        assertTrue(rows.any { it.text == "Set up a provider in the phone app" })
        assertTrue(rows.none { it.text == "Pair a computer" })
    }

    @Test
    fun board_keeps_signed_out_rows_beside_the_pair_row() {
        val rows = BoardCards.sessionsCard(
            sessions = emptyList(),
            connections = emptyMap(),
            config = monitoringOn,
            selectedKey = null,
            waiting = 0,
            quiet = false,
            now = 0L,
            signedOut = listOf(SignedOut("Desk", 1L, 14)),
            pairing = true,
        ).card.richLines.orEmpty()

        assertTrue(rows.any { it.text == "Signed out of Desk" })
        assertTrue(rows.any { it.text == "Pair a computer" })
    }

    @Test
    fun board_pair_row_is_not_selected_over_a_session_the_wearer_chose() {
        val running = AgentSession(id = "s1", provider = AgentProvider.CLAUDE, status = AgentStatus.WORKING)
        val board = board(monitoringOn, pairing = true, sessions = listOf(running), selectedKey = running.key)

        assertEquals(running.key, board.selectedKey)
        assertFalse(board.card.richLines.orEmpty().single { it.text == "Pair a computer" }.selected)
    }

    @Test
    fun selection_ring_includes_the_pair_row_only_when_pairing_is_needed() {
        val keys = listOf("a")
        assertEquals(BoardModel.PAIR_KEY, BoardModel.step(keys, BoardModel.QUIET_KEY, +1, pair = true))
        assertEquals("a", BoardModel.step(keys, BoardModel.PAIR_KEY, +1, pair = true))
        assertEquals(BoardModel.QUIET_KEY, BoardModel.step(keys, BoardModel.PAIR_KEY, -1, pair = true))
        // An empty board with nothing chosen starts on the pair row.
        assertEquals(BoardModel.START_KEY, BoardModel.step(emptyList(), null, +1, pair = true))
        // Without it the ring is the one it always was, and a stale pair key falls back like any gone row.
        assertEquals("a", BoardModel.step(keys, BoardModel.QUIET_KEY, +1))
        assertEquals(BoardModel.START_KEY, BoardModel.step(keys, BoardModel.PAIR_KEY, +1))
    }

    @Test
    fun subagents_line_says_how_many_and_for_how_long() {
        val start = 1_000_000L
        assertEquals("1 subagent running · 0:45", BoardModel.subagentsLine(Subagents(1, start), start + 45_000L))
        assertEquals("2 subagents running · 3:12", BoardModel.subagentsLine(Subagents(2, start), start + 192_000L))
        assertEquals("3 subagents running", BoardModel.subagentsLine(Subagents(3, null), start))
    }

    @Test
    fun elapsed_runs_m_ss_then_h_mm_ss() {
        assertEquals("0:00", BoardModel.elapsed(0))
        assertEquals("0:59", BoardModel.elapsed(59_999))
        assertEquals("1:00", BoardModel.elapsed(60_000))
        assertEquals("59:59", BoardModel.elapsed(3_599_000))
        assertEquals("1:00:00", BoardModel.elapsed(3_600_000))
        assertEquals("2:05:09", BoardModel.elapsed(7_509_000))
        assertEquals("a start time ahead of this clock is 0:00", "0:00", BoardModel.elapsed(-5_000))
    }

    @Test
    fun a_board_row_shows_the_subagents_and_loses_them_when_the_field_goes() {
        val now = 500_000L
        val running = session().copy(subagents = Subagents(2, now - 192_000L))
        assertEquals("2 subagents running · 3:12 · src/auth/login.ts · running tests", BoardModel.row(running, false, now).sub)
        assertTrue(BoardModel.showsAge(running))

        val gone = running.copy(subagents = null)
        assertEquals("src/auth/login.ts · running tests", BoardModel.row(gone, false, now).sub)
        assertFalse(BoardModel.showsAge(gone))

        // A session that said nothing else still gets the line alone.
        val bare = session(v2 = null).copy(subagents = Subagents(1, now - 45_000L))
        assertEquals("1 subagent running · 0:45", BoardModel.row(bare, false, now).sub)
    }

    @Test
    fun a_session_with_a_hidden_pending_item_says_so_first_in_its_trail() {
        val plain = BoardModel.row(session(), false, now = 1_000_000L)
        val marked = BoardModel.row(session(), false, now = 1_000_000L, pending = true)
        assertEquals(listOf(BoardModel.PENDING_TAG) + plain.trail, marked.trail)
        assertEquals("1 waiting", BoardModel.PENDING_TAG)
    }
}
