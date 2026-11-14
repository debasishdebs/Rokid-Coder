package com.anezium.rokidbus.plugin.agents

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ControlMenuTest {
    private fun v2(
        mode: String = "plugin",
        canCompact: Boolean = false,
        canModel: Boolean = false,
        followup: FollowupState = FollowupState.READY,
        tempMode: TempMode = TempMode.ASK,
        nativeMode: String? = null,
        heading: String = "Fix the login redirect",
        contextUsed: Long? = null,
        contextWindow: Long? = null,
        pendingModel: String? = null,
        pendingEffort: String? = null,
        sandbox: String? = null,
    ) = SessionV2(
        mode = mode,
        canCompact = canCompact,
        canModel = canModel,
        followup = followup,
        tempMode = tempMode,
        nativeMode = nativeMode,
        heading = heading,
        currentFile = null,
        step = null,
        contextUsed = contextUsed,
        contextWindow = contextWindow,
        pendingModel = pendingModel,
        pendingEffort = pendingEffort,
        sandbox = sandbox,
    )

    private fun session(
        provider: AgentProvider = AgentProvider.CLAUDE,
        v2: SessionV2? = v2(),
    ) = AgentSession(id = "s1", provider = provider, title = "repo", status = AgentStatus.IDLE, v2 = v2)

    private fun codex(v2: SessionV2 = v2(canModel = true, canCompact = true)) =
        session(AgentProvider.CODEX, v2)

    private fun items(session: AgentSession, secure: Boolean = true) = ControlMenu.items(session, secure)

    private inline fun <reified T : MenuItem> List<MenuItem>.one(): T = filterIsInstance<T>().single()

    @Test
    fun claude_plugin_mode_greys_model_and_compact_with_needs_rk_claude() {
        val list = items(session())

        assertEquals(
            listOf("Reply by voice", "Approval mode", "Model", "Compact", "Context", "Read output"),
            list.map { it.label },
        )
        val model = list.one<MenuItem.Model>()
        val compact = list.one<MenuItem.Compact>()
        assertFalse(model.enabled)
        assertEquals("needs rk claude", model.sub)
        assertFalse(compact.enabled)
        assertEquals("needs rk claude", compact.sub)
        assertTrue(list.one<MenuItem.ApprovalMode>().enabled)
    }

    @Test
    fun codex_enables_model_effort_compact() {
        val list = items(codex())

        assertEquals(
            listOf("Reply by voice", "Approval mode", "Model", "Effort", "Compact", "Context", "Read output"),
            list.map { it.label },
        )
        assertTrue(list.one<MenuItem.Model>().enabled)
        assertTrue(list.one<MenuItem.Effort>().enabled)
        assertTrue(list.one<MenuItem.Compact>().enabled)
        assertNull(list.one<MenuItem.Model>().sub)
    }

    @Test
    fun approve_all_requires_confirm_and_sends_confirmed_true() {
        val session = session()
        var state = ControlMenu.open("claude:s1")
        state = (ControlMenu.pick(state.copy(index = 1), session, secure = true) as ControlMenu.Step.Go).state
        assertEquals(ControlMenu.Screen.Modes, state.screen)

        // Modes: Ask, Accept edits, Approve all. Ask is the current one, so it sends nothing.
        val confirm = ControlMenu.pick(state.copy(index = 2), session, secure = true) as ControlMenu.Step.Go
        val screen = confirm.state.screen as ControlMenu.Screen.Confirm
        assertEquals("Approve everything in Fix the login redirect?", screen.prompt)
        assertEquals("Yes, approve all", screen.yes)
        // It opens on Cancel: a double tap must not confirm.
        val page = ControlMenu.page(confirm.state, session, secure = true)
        assertEquals("Cancel", page.rows[page.selected].text)

        val yes = ControlMenu.pick(confirm.state.copy(index = 0), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.ModeSet(TempMode.APPROVE_ALL, confirmed = true), yes.command)
        val line = JSONObject(ControlMenu.frame(yes.command, "claude:s1", "m1"))
        assertEquals("mode_set", line.getString("type"))
        assertEquals("approveAll", line.getString("mode"))
        assertTrue(line.getBoolean("confirmed"))

        val cancel = ControlMenu.pick(confirm.state.copy(index = 1), session, secure = true)
        assertEquals(ControlMenu.Screen.Modes, (cancel as ControlMenu.Step.Go).state.screen)

        val edits = ControlMenu.pick(state.copy(index = 1), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.ModeSet(TempMode.ACCEPT_EDITS, confirmed = false), edits.command)
        assertFalse(JSONObject(ControlMenu.frame(edits.command, "claude:s1", "m2")).getBoolean("confirmed"))
    }

    @Test
    fun both_tools_offer_the_same_three_modes() {
        val all = listOf(TempMode.ASK, TempMode.ACCEPT_EDITS, TempMode.APPROVE_ALL)
        assertEquals(all, ControlMenu.modeOptions(AgentProvider.CLAUDE))
        assertEquals(all, ControlMenu.modeOptions(AgentProvider.CODEX))
    }

    @Test
    fun followup_cap_reached_shows_continue_on_laptop() {
        val capped = items(session(v2 = v2(followup = FollowupState.CAP_REACHED))).one<MenuItem.ReplyByVoice>()
        assertFalse(capped.enabled)
        assertEquals("continue on laptop or rk claude", capped.sub)

        val unavailable = items(session(v2 = v2(followup = FollowupState.UNAVAILABLE))).one<MenuItem.ReplyByVoice>()
        assertFalse(unavailable.enabled)
        assertEquals("session not waiting", unavailable.sub)

        for (state in listOf(FollowupState.WAITING, FollowupState.READY)) {
            assertTrue(items(session(v2 = v2(followup = state))).one<MenuItem.ReplyByVoice>().enabled)
            assertTrue(items(codex(v2(followup = state))).one<MenuItem.ReplyByVoice>().enabled)
        }
    }

    @Test
    fun insecure_disables_all_steering_items() {
        val list = items(codex(), secure = false)
        val steering = list.filter {
            it is MenuItem.ReplyByVoice || it is MenuItem.ApprovalMode || it is MenuItem.Model ||
                it is MenuItem.Effort || it is MenuItem.Compact
        }
        assertEquals(5, steering.size)
        for (item in steering) {
            assertFalse(item.label, item.enabled)
            assertEquals(item.label, "Monitor only — approve on laptop", item.sub)
        }
        // Reading is not steering.
        assertTrue(list.one<MenuItem.Context>().enabled)
        assertTrue(list.one<MenuItem.ReadOutput>().enabled)

        // A greyed row says why and sends nothing.
        val pick = ControlMenu.pick(ControlMenu.open("codex:s1").copy(index = 1), codex(), secure = false)
        assertEquals(ControlMenu.Step.Say(ControlMenu.NOTICE_TITLE, "Monitor only — approve on laptop"), pick)
    }

    @Test
    fun a_confirm_left_open_when_the_link_stops_steering_sends_nothing() {
        val confirm = ControlMenu.MenuState(
            sessionKey = "claude:s1",
            screen = ControlMenu.Screen.Confirm(
                prompt = "p",
                warning = null,
                yes = "Yes",
                command = ControlMenu.Command.ModeSet(TempMode.APPROVE_ALL, confirmed = true),
                back = ControlMenu.Screen.Modes,
            ),
            index = 0,
        )
        val step = ControlMenu.pick(confirm, session(), secure = false)
        assertEquals(ControlMenu.Screen.Main, (step as ControlMenu.Step.Go).state.screen)
    }

    @Test
    fun context_sub_formats_percent_and_k() {
        fun sub(used: Long?, window: Long?) = items(session(v2 = v2(contextUsed = used, contextWindow = window)))
            .one<MenuItem.Context>().sub

        assertEquals("42% · 84k/200k", sub(84_000, 200_000))
        assertEquals("0% · 0/200k", sub(0, 200_000))
        assertEquals("100% · 1M/1M".replace("1M", "1000k"), sub(1_000_000, 1_000_000))
        assertEquals("50% · 500/1k", sub(500, 1_000))
        assertEquals("unknown", sub(null, null))
        assertEquals("unknown", sub(100, null))
    }

    @Test
    fun pending_model_shows_pending() {
        val list = items(codex(v2(canModel = true, canCompact = true, pendingModel = "gpt-5", pendingEffort = null)))
        assertEquals("pending", list.one<MenuItem.Model>().sub)
        assertNull(list.one<MenuItem.Effort>().sub)

        val effort = items(codex(v2(canModel = true, pendingEffort = "high")))
        assertEquals("pending", effort.one<MenuItem.Effort>().sub)
        assertNull(effort.one<MenuItem.Model>().sub)
    }

    @Test
    fun mode_reset_notice_copy_per_reason() {
        fun notice(reason: String) = ControlMenu.modeResetNotice(TempMode.APPROVE_ALL, "Fix login", reason)

        assertEquals("Approve-all off — Fix login: session ended", notice("session_ended"))
        assertEquals("Approve-all off — Fix login: helper restarted", notice("helper_restarted"))
        assertEquals("Approve-all off — Fix login: revoked", notice("revoked"))
        assertTrue(notice("x".repeat(500)).length <= 240)
    }

    @Test
    fun followup_closed_copy_per_reason() {
        assertEquals("Laptop took over", ControlMenu.followupClosedNotice("laptop"))
        assertEquals("Reply window closed", ControlMenu.followupClosedNotice("timeout"))
        assertEquals("Reply cancelled", ControlMenu.followupClosedNotice("cancelled"))
        assertNull(ControlMenu.followupClosedNotice("delivered"))
    }

    @Test
    fun a_rejected_ack_with_any_error_is_not_applied() {
        assertEquals(
            "Not applied: not_launcher",
            ControlMenu.ackNotice(AgentdAction.Ack("m", "rejected", "not_launcher")),
        )
        assertEquals("Not applied", ControlMenu.ackNotice(AgentdAction.Ack("m", "rejected", null)))
        assertNull(ControlMenu.ackNotice(AgentdAction.Ack("m", "applied", null)))
        assertNull(ControlMenu.ackNotice(AgentdAction.Ack("m", "duplicate", null)))
    }

    @Test
    fun claude_launcher_ready_enables_reply_and_launcher_commands() {
        val launcher = session(v2 = v2(mode = "launcher", canCompact = true, canModel = true))
        val list = items(launcher)
        assertTrue(list.one<MenuItem.ReplyByVoice>().enabled)
        assertTrue(list.one<MenuItem.Model>().enabled)
        assertTrue(list.one<MenuItem.Compact>().enabled)

        // Compact: a confirm first, then launcher_command compact.
        val compactAsk = ControlMenu.pick(ControlMenu.open("claude:s1").copy(index = 3), launcher, secure = true)
        val confirm = (compactAsk as ControlMenu.Step.Go).state
        val yes = ControlMenu.pick(confirm.copy(index = 0), launcher, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.LauncherCompact, yes.command)
        val line = JSONObject(ControlMenu.frame(yes.command, "claude:s1", "m1"))
        assertEquals("launcher_command", line.getString("type"))
        assertEquals("compact", line.getString("command"))
        assertFalse(line.has("model"))
    }

    @Test
    fun launcher_model_shows_default_change_warning() {
        val launcher = session(v2 = v2(mode = "launcher", canModel = true))
        val choose = (ControlMenu.pick(ControlMenu.open("claude:s1").copy(index = 2), launcher, secure = true)
            as ControlMenu.Step.Go).state
        val chooser = ControlMenu.page(choose, launcher, secure = true)
        assertEquals(listOf("opus", "sonnet", "haiku"), chooser.rows.map { it.text })

        val confirm = (ControlMenu.pick(choose.copy(index = 1), launcher, secure = true) as ControlMenu.Step.Go).state
        val page = ControlMenu.page(confirm, launcher, secure = true)
        assertTrue(page.rows.any { it.text == "This also changes the default for new sessions" })

        val yes = ControlMenu.pick(confirm.copy(index = 0), launcher, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.LauncherModel("sonnet"), yes.command)
        val line = JSONObject(ControlMenu.frame(yes.command, "claude:s1", "m1"))
        assertEquals("launcher_command", line.getString("type"))
        assertEquals("model", line.getString("command"))
        assertEquals("sonnet", line.getString("model"))
    }

    @Test
    fun sandbox_shown_read_only() {
        val approval = items(codex(v2(sandbox = "read-only", nativeMode = "on-request"))).one<MenuItem.ApprovalMode>()
        assertEquals("ask · native: on-request · sandbox: read-only", approval.sub)
        assertNull(items(session()).one<MenuItem.ApprovalMode>().sub?.takeIf { "sandbox" in it })
        // Read only: the modes screen offers no sandbox choice.
        val page = ControlMenu.page(
            ControlMenu.open("codex:s1").copy(screen = ControlMenu.Screen.Modes),
            codex(v2(sandbox = "read-only")),
            secure = true,
        )
        assertEquals(listOf("Ask", "Accept edits", "Approve all"), page.rows.map { it.text })
    }

    @Test
    fun codex_model_asks_agentd_for_the_list_then_sends_codex_settings() {
        val session = codex()
        val ask = ControlMenu.pick(ControlMenu.open("codex:s1").copy(index = 2), session, secure = true)
            as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.ModelsRequest, ask.command)
        assertFalse(ControlMenu.steers(ask.command))
        assertEquals("models_request", JSONObject(ControlMenu.frame(ask.command, "codex:s1", "unused")).getString("type"))

        val loading = ControlMenu.page(ask.state, session, secure = true)
        assertEquals(listOf("Loading…"), loading.rows.map { it.text })
        assertEquals(-1, loading.selected)

        val models = AgentdAction.Models("codex:s1", listOf("gpt-5", "gpt-5-mini"), listOf("low", "high"), "gpt-5", "low")
        val ready = ControlMenu.withModels(ask.state, models)
        val page = ControlMenu.page(ready, session, secure = true)
        assertEquals(listOf("gpt-5", "gpt-5-mini"), page.rows.map { it.text })
        assertEquals("current", page.rows[0].sub)

        val pick = ControlMenu.pick(ready.copy(index = 1), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.CodexSettings(model = "gpt-5-mini", effort = null), pick.command)
        val line = JSONObject(ControlMenu.frame(pick.command, "codex:s1", "m1"))
        assertEquals("codex_settings", line.getString("type"))
        assertEquals("gpt-5-mini", line.getString("model"))
        assertFalse(line.has("effort"))

        // Another session's models frame changes nothing.
        assertEquals(ask.state, ControlMenu.withModels(ask.state, models.copy(sessionKey = "codex:other")))
    }

    @Test
    fun codex_effort_uses_the_efforts_of_the_same_frame_and_compact_confirms() {
        val session = codex()
        val effort = ControlMenu.pick(ControlMenu.open("codex:s1").copy(index = 3), session, secure = true)
            as ControlMenu.Step.Send
        val ready = ControlMenu.withModels(
            effort.state,
            AgentdAction.Models("codex:s1", listOf("gpt-5"), listOf("low", "high"), null, null),
        )
        val pick = ControlMenu.pick(ready.copy(index = 1), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.CodexSettings(model = null, effort = "high"), pick.command)

        val ask = ControlMenu.pick(ControlMenu.open("codex:s1").copy(index = 4), session, secure = true)
            as ControlMenu.Step.Go
        val yes = ControlMenu.pick(ask.state.copy(index = 0), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.CodexCompact, yes.command)
        assertEquals("codex_compact", JSONObject(ControlMenu.frame(yes.command, "codex:s1", "m1")).getString("type"))
    }

    @Test
    fun an_overflowing_approval_row_offers_its_full_text_in_a_reader() {
        val session = codex(v2(sandbox = "x".repeat(150), nativeMode = "y".repeat(150)))
        val modes = ControlMenu.open("codex:s1").copy(screen = ControlMenu.Screen.Modes)
        val page = ControlMenu.page(modes, session, secure = true)
        assertTrue(page.rows.all { it.text.length <= 240 })
        val step = ControlMenu.pick(modes.copy(index = 0), session, secure = true)
        assertTrue(step is ControlMenu.Step.ReadText && step.text.length > 240)
    }

    @Test
    fun a_session_without_v2_offers_only_its_output_and_back_walks_up() {
        val legacy = items(session(v2 = null))
        assertEquals(listOf("Read output"), legacy.map { it.label })

        val main = ControlMenu.open("claude:s1")
        assertNull(ControlMenu.back(main))
        assertEquals(main, ControlMenu.back(main.copy(screen = ControlMenu.Screen.Modes, index = 2)))
        assertEquals(
            ControlMenu.Step.Read,
            ControlMenu.pick(main.copy(index = 5), session(), secure = true),
        )
        assertEquals(ControlMenu.Step.Reply, ControlMenu.pick(main, session(), secure = true))
    }

    @Test
    fun move_wraps_over_selectable_rows_only() {
        val session = session()
        val main = ControlMenu.open("claude:s1")
        assertEquals(5, ControlMenu.move(main, -1, session, secure = true).index)
        assertEquals(0, ControlMenu.move(main.copy(index = 5), 1, session, secure = true).index)
    }
}
