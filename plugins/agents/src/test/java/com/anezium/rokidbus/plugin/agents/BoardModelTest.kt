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
}
