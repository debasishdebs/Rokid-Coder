package com.anezium.rokidbus.plugin.agents

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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
        followupWhy: String? = null,
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
        followupWhy = followupWhy,
    )

    private fun session(
        provider: AgentProvider = AgentProvider.CLAUDE,
        v2: SessionV2? = v2(),
    ) = AgentSession(id = "s1", provider = provider, title = "repo", status = AgentStatus.IDLE, v2 = v2)

    private fun codex(v2: SessionV2 = v2(canModel = true, canCompact = true)) =
        session(AgentProvider.CODEX, v2)

    private fun items(session: AgentSession, secure: Boolean = true) = ControlMenu.items(session, secure)

    /** The index of [label] among the main menu's rows, so a new row cannot silently shift a test. */
    private fun at(session: AgentSession, label: String): Int =
        ControlMenu.items(session, secure = true).indexOfFirst { it.label == label }.also { check(it >= 0) }

    private fun main(session: AgentSession, label: String) =
        ControlMenu.open("${session.provider.wireValue}:s1").copy(index = at(session, label))

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
        var state = (ControlMenu.pick(main(session, "Approval mode"), session, secure = true) as ControlMenu.Step.Go).state
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
    fun an_unavailable_reply_says_why() {
        fun sub(why: String?) = items(
            session(v2 = v2(followup = FollowupState.UNAVAILABLE, followupWhy = why)),
        ).one<MenuItem.ReplyByVoice>().let { assertFalse(it.enabled); it.sub }
        assertEquals("Claude is working — try again when it is idle", sub("busy"))
        assertEquals("background work is running — wait for it, or reply at the laptop", sub("background"))
        assertEquals("text typed at the laptop prompt — clear it first", sub("draft"))
        assertEquals("start the session with rk claude", sub("not_launcher"))
        assertEquals("background replies are off — turn them on in Settings", sub("bg_off"))
        assertEquals("Background replies aren't supported in this mode", sub("mode_not_allowed"))
        assertEquals("session not waiting", sub("needs_auto_mode"))
        assertEquals("session not waiting", sub(null))
        assertEquals("session not waiting", sub("something_new"))
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
            assertEquals(item.label, "Computer not connected", item.sub)
        }
        // Reading is not steering.
        assertTrue(list.one<MenuItem.Context>().enabled)
        assertTrue(list.one<MenuItem.ReadOutput>().enabled)

        // A greyed row says why and sends nothing.
        val pick = ControlMenu.pick(main(codex(), "Approval mode"), codex(), secure = false)
        assertEquals(ControlMenu.Step.Say("Not sent", "Computer not connected"), pick)
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
        assertEquals("100% · 1000k/1000k", sub(1_000_000, 1_000_000))
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
        // The notice names the mode that was reset (R97).
        assertEquals(
            "Accept edits off — Fix login: revoked",
            ControlMenu.modeResetNotice(TempMode.ACCEPT_EDITS, "Fix login", "revoked"),
        )
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
        // A duplicate is no longer silent: the wearer is told it was already sent.
        assertEquals("Already sent — check laptop", ControlMenu.ackNotice(AgentdAction.Ack("m", "duplicate", null)))
        assertEquals(
            "Sent, but may not have finished — check laptop",
            ControlMenu.ackNotice(AgentdAction.Ack("m", "rejected", "typed_after_cancel", consumed = true)),
        )
    }

    @Test
    fun an_armed_retry_puts_tap_to_send_again_on_the_launcher_rows() {
        val launcher = session(v2 = v2(mode = "launcher", canCompact = true, canModel = true))
        val armed = setOf<ControlMenu.Command>(
            ControlMenu.Command.LauncherCompact,
            ControlMenu.Command.LauncherModel("sonnet"),
        )
        val base = ControlMenu.open("claude:s1").copy(retryArmed = armed)
        val main = ControlMenu.page(base, launcher, secure = true)
        assertEquals("Tap to send again", main.rows.single { it.text == "Compact" }.sub)
        assertNull(ControlMenu.page(ControlMenu.open("claude:s1"), launcher, secure = true).rows.single { it.text == "Compact" }.sub)

        val choose = base.copy(screen = ControlMenu.Screen.Choose(ControlMenu.Setting.MODEL))
        val chooser = ControlMenu.page(choose, launcher, secure = true)
        assertEquals(listOf(null, "Tap to send again", null), chooser.rows.map { it.sub })
    }

    @Test
    fun claude_launcher_ready_enables_reply_and_launcher_commands() {
        val launcher = session(v2 = v2(mode = "launcher", canCompact = true, canModel = true))
        val list = items(launcher)
        assertTrue(list.one<MenuItem.ReplyByVoice>().enabled)
        assertTrue(list.one<MenuItem.Model>().enabled)
        assertTrue(list.one<MenuItem.Compact>().enabled)

        // Compact: a confirm first, then launcher_command compact.
        val compactAsk = ControlMenu.pick(main(launcher, "Compact"), launcher, secure = true)
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
        val choose = (ControlMenu.pick(main(launcher, "Model"), launcher, secure = true)
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
        val ask = ControlMenu.pick(main(session, "Model"), session, secure = true)
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
        val effort = ControlMenu.pick(main(session, "Effort"), session, secure = true)
            as ControlMenu.Step.Send
        val ready = ControlMenu.withModels(
            effort.state,
            AgentdAction.Models("codex:s1", listOf("gpt-5"), listOf("low", "high"), null, null),
        )
        val pick = ControlMenu.pick(ready.copy(index = 1), session, secure = true) as ControlMenu.Step.Send
        assertEquals(ControlMenu.Command.CodexSettings(model = null, effort = "high"), pick.command)

        val ask = ControlMenu.pick(main(session, "Compact"), session, secure = true)
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
            ControlMenu.pick(main(session(), "Read output"), session(), secure = true),
        )
        assertEquals(ControlMenu.Step.Reply, ControlMenu.pick(main, session(), secure = true))
    }

    @Test
    fun move_wraps_over_selectable_rows_only() {
        val session = session()
        val main = ControlMenu.open("claude:s1")
        val last = items(session).lastIndex
        assertEquals(last, ControlMenu.move(main, -1, session, secure = true).index)
        assertEquals(0, ControlMenu.move(main.copy(index = last), 1, session, secure = true).index)
    }

    // ------------------------------------------------------- fix round 1

    private fun confirmAllState(session: AgentSession): ControlMenu.MenuState {
        val modes = (ControlMenu.pick(main(session, "Approval mode"), session, secure = true) as ControlMenu.Step.Go).state
        val confirm = (ControlMenu.pick(modes.copy(index = 2), session, secure = true) as ControlMenu.Step.Go).state
        // The wearer moved onto "Yes, approve all".
        return confirm.copy(index = 0)
    }

    @Test
    fun alert_preempting_confirm_resets_menu_to_main() {
        val session = session()
        val confirm = confirmAllState(session)
        assertTrue(confirm.screen is ControlMenu.Screen.Confirm)

        val covered = ControlMenu.covered(confirm)
        assertEquals(ControlMenu.Screen.Main, covered.screen)
        assertEquals(0, covered.index)
        assertTrue(covered.rearm)
        assertEquals(
            "Reply by voice",
            ControlMenu.page(covered, session, secure = true).let { it.rows[it.selected].text },
        )
    }

    @Test
    fun stray_tap_after_alert_never_sends_approve_all() {
        val session = session()
        val covered = ControlMenu.covered(confirmAllState(session))

        // The guard that starts when it is drawn again is the screen's (GlassesScreenTest).
        // Even past it, no row of the main menu sends approve-all.
        for (index in items(session).indices) {
            val step = ControlMenu.pick(covered.copy(index = index), session, secure = true)
            val sent = (step as? ControlMenu.Step.Send)?.command
            assertFalse("row $index", sent == ControlMenu.Command.ModeSet(TempMode.APPROVE_ALL, confirmed = true))
        }
    }

    @Test
    fun covering_the_main_screen_keeps_its_place() {
        val state = ControlMenu.open("claude:s1").copy(index = 3)
        val covered = ControlMenu.covered(state)
        assertEquals(3, covered.index)
        assertTrue(covered.rearm)
    }

    @Test
    fun codex_missing_capability_says_not_available() {
        val list = items(codex(v2(canModel = false, canCompact = false)))
        for (item in listOf(list.one<MenuItem.Model>(), list.one<MenuItem.Effort>(), list.one<MenuItem.Compact>())) {
            assertFalse(item.label, item.enabled)
            assertEquals(item.label, "not available", item.sub)
        }
        // Claude keeps the launcher copy.
        assertEquals("needs rk claude", items(session()).one<MenuItem.Model>().sub)
    }

    @Test
    fun models_request_timeout_shows_unavailable() {
        val session = codex()
        val ask = ControlMenu.pick(main(session, "Model"), session, secure = true, now = 1_000L)
            as ControlMenu.Step.Send

        fun rows(now: Long) = ControlMenu.page(ask.state, session, secure = true, now = now).rows.map { it.text }
        assertEquals(listOf("Loading…"), rows(1_000L))
        assertEquals(listOf("Loading…"), rows(10_999L))
        assertEquals(listOf("Models unavailable"), rows(11_000L))

        // A late frame still fills the list.
        val late = ControlMenu.withModels(ask.state, AgentdAction.Models("codex:s1", listOf("gpt-5"), emptyList(), null, null))
        assertEquals(
            listOf("gpt-5"),
            ControlMenu.page(late, session, secure = true, now = 99_000L).rows.map { it.text },
        )
    }

    @Test
    fun a_new_models_request_drops_the_list_of_the_last_one() {
        val session = codex()
        val old = ControlMenu.withModels(
            main(session, "Model"),
            AgentdAction.Models("codex:s1", listOf("stale"), emptyList(), null, null),
        )
        val ask = ControlMenu.pick(old, session, secure = true, now = 5L) as ControlMenu.Step.Send
        assertNull(ask.state.models)
    }

    @Test
    fun a_background_reply_agentd_did_not_type_says_to_try_again() {
        val hint = "Claude is busy with something else, wait a moment and try again"
        val ack = AgentdAction.Ack("m", "rejected", "not_sent")
        assertEquals(hint, ControlMenu.ackNotice(ack, followup = true))
        assertEquals(hint, ControlMenu.followupRejection("not_sent", 120))
        assertEquals("Not applied: not_sent", ControlMenu.ackNotice(ack))
    }

    @Test
    fun a_reply_agentd_could_not_read_the_screen_for_says_so_and_is_not_called_busy() {
        val hint = "Could not read Claude's screen, try again or reply at the laptop"
        val ack = AgentdAction.Ack("m", "rejected", "screen_unreadable")
        assertEquals(hint, ControlMenu.ackNotice(ack, followup = true))
        assertEquals(hint, ControlMenu.followupRejection("screen_unreadable", 120))
        assertEquals("Not applied: screen_unreadable", ControlMenu.ackNotice(ack))
        // The busy wording stays for not_sent, and the two never read alike.
        assertNotEquals(ControlMenu.followupRejection("not_sent", 120), hint)
        assertEquals("Claude is busy with something else, wait a moment and try again", ControlMenu.followupRejection("not_sent", 120))
        // Retryable and unconsumed: a rejection that spent its id reads as sent, this one does not.
        assertEquals(hint, ControlMenu.ackNotice(AgentdAction.Ack("m", "rejected", "screen_unreadable", consumed = false), followup = true))
    }

    @Test
    fun a_followup_refused_for_want_of_a_launcher_says_how_to_start_one() {
        val hint = "Start the session with rk claude to send prompts from the glasses."
        val ack = AgentdAction.Ack("m", "rejected", "not_launcher")
        assertEquals(hint, ControlMenu.ackNotice(ack, followup = true))
        assertEquals(hint, ControlMenu.followupRejection("not_launcher", 120))
        // Other refusals, and a command that is not a follow-up, keep their own words.
        assertEquals("Not applied: not_launcher", ControlMenu.ackNotice(ack))
        assertEquals("no_followup_window", ControlMenu.followupRejection("no_followup_window", 120))
        assertEquals("rejected", ControlMenu.followupRejection(null, 120))
        assertEquals("Not applied: bad_text", ControlMenu.ackNotice(AgentdAction.Ack("m", "rejected", "bad_text"), followup = true))
    }

    private fun pendingAlert(kind: AlertKind, body: String = "Pick one?") = AgentdAction.Alert(
        id = "P1",
        sessionKey = "claude:s1",
        kind = kind,
        title = "t",
        body = body,
        actions = emptyList(),
        question = null,
        waiting = 0,
        reason = AlertReason.NEW,
    )

    @Test
    fun a_hidden_question_or_approval_is_the_first_menu_line_with_its_text() {
        val question = ControlMenu.items(session(), secure = true, pending = pendingAlert(AlertKind.QUESTION))
        assertEquals("Answer question", question.first().label)
        assertEquals("Pick one?", question.first().sub)
        assertTrue(question.first().enabled)
        val approval = ControlMenu.items(session(), secure = true, pending = pendingAlert(AlertKind.APPROVAL, "Bash: npm test"))
        assertEquals("Answer approval", approval.first().label)
        assertEquals("Bash: npm test", approval.first().sub)
        // A session without v2 still offers it.
        assertEquals(
            listOf("Answer question", "Read output"),
            ControlMenu.items(session(v2 = null), secure = true, pending = pendingAlert(AlertKind.QUESTION)).map { it.label },
        )
    }

    @Test
    fun picking_the_pending_line_raises_that_card_and_it_is_gone_once_answered() {
        val state = ControlMenu.open("claude:s1")
        val pending = pendingAlert(AlertKind.QUESTION)
        assertEquals(ControlMenu.Step.Answer("P1"), ControlMenu.pick(state, session(), true, pending = pending))
        // Offline it still raises the card: the answer is gated by the link, not the way back.
        assertEquals(ControlMenu.Step.Answer("P1"), ControlMenu.pick(state, session(), false, pending = pending))
        // No pending item (answered, dismissed or expired): no such line.
        assertFalse(ControlMenu.items(session(), secure = true, pending = null).any { it is MenuItem.AnswerPending })
        assertEquals(ControlMenu.Step.Reply, ControlMenu.pick(state, session(), true))
    }
}
