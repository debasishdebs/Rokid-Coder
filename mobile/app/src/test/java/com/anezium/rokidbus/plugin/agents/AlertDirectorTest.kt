package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.plugin.agents.ui.outcomeText
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertDirectorTest {
    private class Glasses : AlertGlasses {
        val log = mutableListOf<String>()
        val bands = mutableListOf<NexusNotice>()
        val updates = mutableListOf<NexusNoticeUpdate>()
        var takesBand = true
        var takesUpdate = true

        override fun showBand(notice: NexusNotice): Boolean {
            log += "show ${notice.title}"
            if (takesBand) bands += notice
            return takesBand
        }

        override fun updateBand(update: NexusNoticeUpdate): Boolean {
            log += "update ${update.footer}"
            if (takesUpdate) updates += update
            return takesUpdate
        }

        override fun hideBand() { log += "hide" }
        val briefs = mutableListOf<Pair<String, String>>()
        override fun brief(title: String, body: String) { log += "brief $title"; briefs += title to body }
        val merged = mutableListOf<List<String>>()
        override fun briefLines(title: String, lines: List<String>) { log += "brief $title"; merged += lines }
        override fun openOutput(alert: AgentdAction.Alert) { log += "output ${alert.id}" }
        override fun openDecision(alert: AgentdAction.Alert) { log += "decision ${alert.id}" }
        override fun openQuestion(alert: AgentdAction.Alert) { log += "question ${alert.id}" }
        override fun invalidate(alertId: String) { log += "invalidate $alertId" }
        val sounds = mutableListOf<AlertSound>()
        override fun playSound(sound: AlertSound) { sounds += sound }
    }

    private val glasses = Glasses()
    private val written = mutableListOf<JSONObject>()
    private var secure = true
    private var now = 0L
    private var writeResult: AgentdWire.Result = AgentdWire.Result.Sent
    private val history = AlertHistory(clock = { now })
    private var keepAfterSession = true
    private var soundPrefs = SoundPrefs()

    private class Timer(val delayMs: Long, val work: () -> Unit) {
        var cancelled = false
    }

    private val timers = mutableListOf<Timer>()

    /** Fires the brief's pending fallback, as the clock reaching it would. */
    private fun fireTimer() {
        val timer = timers.last { !it.cancelled }
        timer.cancelled = true
        timer.work()
    }

    private val director = AlertDirector(
        coordinator = AlertCoordinator(clock = { now }),
        write = { written += JSONObject(it); writeResult },
        secure = { secure },
        glasses = { glasses },
        post = { it() },
        schedule = { delayMs, work ->
            val timer = Timer(delayMs, work).also(timers::add)
            val cancel: () -> Unit = { timer.cancelled = true }
            cancel
        },
        history = history,
        historyPolicy = { HistoryPolicy(windowMs = 24 * 3_600_000L, keepAfterSession = keepAfterSession) },
        headingOf = { "my-repo" },
        soundPrefs = { soundPrefs },
    )

    private fun alert(
        id: String = "A",
        reason: String = "new",
        kind: String = "approval",
        waiting: Int = 0,
        sessionKey: String = "claude:s1",
    ): AgentdAction.Alert {
        val frame = JSONObject()
            .put("type", "alert").put("v", 2).put("id", id).put("sessionKey", sessionKey)
            .put("kind", kind).put("title", "t").put("body", "body $id")
            .put("waiting", waiting).put("reason", reason)
        if (kind == "approval") frame.put("actions", JSONArray(listOf("allow", "deny")))
        if (kind == "question") {
            frame.put(
                "question",
                JSONObject().put("requestRef", "ref-$id").put("source", "claude_tool").put(
                    "items",
                    JSONArray().put(
                        JSONObject().put("text", "Pick?").put("options", JSONArray())
                            .put("multiSelect", false).put("allowFreeText", true),
                    ),
                ),
            )
        }
        return AgentdProtocolCodec().parse(frame.toString()) as AgentdAction.Alert
    }

    private fun feed(alert: AgentdAction.Alert) = director.onEvent(AgentdEvent.Action(alert))
    private fun types() = written.map { it.getString("type") }

    private fun up() = director.onEvent(AgentdEvent.LinkUp(1L, secure))

    @Test
    fun a_rejected_answer_is_reported_to_the_wearer() {
        up()
        feed(alert(id = "A"))
        director.onBandAction(AlertCoordinator.ALLOW)
        val sent = written.single { it.getString("type") == "alert_action" }
        director.onEvent(
            AgentdEvent.Action(AgentdAction.Ack(sent.getString("msgId"), "rejected", "wrong_request")),
        )
        // Like every brief it waits for the alert's band, then says so.
        assertTrue(glasses.briefs.isEmpty())
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "withdrawn")))
        assertEquals(AlertCoordinator.NOT_SENT to "Answer on laptop · wrong_request", glasses.briefs.single())

        // An ack for a frame the coordinator never sent, or an applied one, says nothing.
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack("someone-else", "rejected", "x")))
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack(sent.getString("msgId"), "applied", null)))
        assertEquals(1, glasses.briefs.size)
    }

    @Test
    fun an_action_on_a_band_this_director_never_put_up_says_no_longer_waiting() {
        // A restarted monitor service: the band is still on the glasses, but not this director's.
        up()
        director.onBandAction(AlertCoordinator.ALLOW)
        assertEquals(AlertCoordinator.NO_LONGER_WAITING to AlertCoordinator.NO_LONGER_WAITING_BODY, glasses.briefs.single())
        assertTrue(types().none { it == "alert_action" })
    }

    @Test
    fun a_new_alert_shows_and_a_retry_refreshes_the_same_band_silently() {
        up()
        feed(alert(waiting = 2))
        feed(alert(reason = "retry", waiting = 1))

        assertEquals(listOf("hide", "show CLAUDE · approve", "update +1 waiting"), glasses.log)
        assertTrue(glasses.bands.single().wakeDisplay)
        assertEquals(emptyList<String>(), types())
    }

    @Test
    fun a_cue_is_asked_for_once_per_fresh_alert_and_never_on_a_retry_or_a_reshow() {
        up()
        feed(alert(id = "A"))
        feed(alert(id = "A", reason = "retry"))
        glasses.takesUpdate = false
        feed(alert(id = "A", reason = "update"))
        feed(alert(id = "B", reason = "new", kind = "done"))
        feed(alert(id = "B", reason = "reminder", kind = "done"))

        // The refused update re-shows A without a sound; a reminder wakes but never sounds.
        // A fresh approval speaks, a fresh Done chimes.
        assertEquals(listOf(AlertSound.Speak("Claude needs approval"), AlertSound.Chime), glasses.sounds)
    }

    @Test
    fun the_sound_follows_the_setting_read_when_the_band_goes_up() {
        up()
        soundPrefs = SoundPrefs(approval = SoundChoice.CHIME, question = SoundChoice.SILENT, reminder = SoundChoice.SPEAK)
        feed(alert(id = "A"))
        feed(alert(id = "Q", kind = "question"))
        // A reminder sounds only because the wearer chose it, and says it is still waiting.
        feed(alert(id = "A", reason = "reminder"))
        feed(alert(id = "A", reason = "retry"))

        assertEquals(listOf(AlertSound.Chime, AlertSound.Speak("Claude is still waiting")), glasses.sounds)
    }

    @Test
    fun a_band_the_hub_refused_makes_no_sound() {
        up()
        glasses.takesBand = false
        feed(alert())

        assertEquals(emptyList<AlertSound>(), glasses.sounds)
    }

    @Test
    fun a_refused_update_shows_the_band_again_without_a_wake() {
        up()
        feed(alert())
        glasses.takesUpdate = false
        feed(alert(reason = "retry"))

        assertEquals(listOf("hide", "show CLAUDE · approve", "update ", "show CLAUDE · approve"), glasses.log)
        assertFalse(glasses.bands.last().wakeDisplay)
    }

    @Test
    fun a_band_the_hub_did_not_take_is_shown_again_on_the_next_retry() {
        up()
        glasses.takesBand = false
        feed(alert())
        glasses.takesBand = true
        feed(alert(reason = "retry"))

        // No update was tried on a band that never appeared.
        assertEquals(listOf("hide", "show CLAUDE · approve", "show CLAUDE · approve"), glasses.log)
    }

    @Test
    fun band_presses_answer_the_alert_that_is_up() {
        up()
        feed(alert())
        director.onBandAction("allow")

        assertEquals(listOf("alert_shown", "alert_action"), types())
        assertEquals("A", written.last().getString("id"))
        assertEquals("allow", written.last().getString("action"))
    }

    @Test
    fun a_press_with_the_link_down_writes_nothing_and_says_not_sent() {
        up()
        feed(alert())
        director.onEvent(AgentdEvent.LinkDown(1L))
        secure = false
        director.onBandAction("deny")

        assertFalse("alert_action" in types())
        // The band is still up, so the brief waits for it.
        assertTrue(glasses.log.none { it.startsWith("brief") })
        director.onBandClosed(NexusNoticeCloseReason.TIMEOUT)
        assertEquals("brief Not sent", glasses.log.last())
    }

    @Test
    fun more_opens_the_decision_card_and_its_confirm_needs_it_to_be_live() {
        up()
        feed(alert())
        director.onBandAction("more")
        director.onCardConfirm("A", "allow")
        director.onBoard(setOf("claude:s1"))

        assertTrue("decision A" in glasses.log)
        assertEquals(listOf("alert_shown", "alert_action"), types())

        // The session leaves the board: the card is bound to it no longer.
        written.clear()
        feed(alert(id = "B", reason = "new", sessionKey = "claude:s2"))
        director.onBoard(setOf("claude:s1", "claude:s2"))
        director.onBandAction("more")
        director.onBoard(setOf("claude:s1"))
        director.onCardConfirm("B", "allow")

        assertTrue("invalidate B" in glasses.log)
        assertTrue(glasses.log.none { it.startsWith("brief") })
        director.onBandClosed(NexusNoticeCloseReason.TIMEOUT)
        assertEquals("brief No longer waiting", glasses.log.last())
        assertFalse("alert_action" in types())
    }

    @Test
    fun a_followup_closed_frame_invalidates_the_session_cards() {
        up()
        feed(alert())
        director.onBandAction("more")
        director.onEvent(AgentdEvent.Action(AgentdAction.FollowupClosed("claude:s1", "ended")))

        assertEquals("invalidate A", glasses.log.last())
    }

    @Test
    fun a_question_answer_goes_out_once_through_the_live_card_and_never_after_followup_closed() {
        val answers = mapOf<String, Any>("Pick?" to "Blue")
        up()
        feed(alert(id = "Q", kind = "question"))
        director.onBandAction("answer")
        director.onQuestionConfirm("Q", answers)

        assertTrue("question Q" in glasses.log)
        assertEquals(listOf("alert_shown", "question_answer"), types())
        assertEquals("Q", written.last().getString("alertId"))

        written.clear()
        director.onEvent(AgentdEvent.Action(AgentdAction.FollowupClosed("claude:s1", "ended")))
        director.onQuestionConfirm("Q", answers)
        assertEquals(emptyList<String>(), types())
        assertTrue("invalidate Q" in glasses.log)
    }

    @Test
    fun a_withdrawn_question_invalidates_its_open_deck() {
        up()
        feed(alert(id = "Q", kind = "question"))
        director.onBandAction("answer")
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("Q", "withdrawn")))

        // The service closes the deck and briefs "No longer waiting" on this.
        assertTrue("invalidate Q" in glasses.log)
    }

    @Test
    fun a_question_answer_over_a_plaintext_link_writes_nothing() {
        up()
        feed(alert(id = "Q", kind = "question"))
        director.onBandAction("answer")
        written.clear()
        secure = false
        director.onQuestionConfirm("Q", mapOf("Pick?" to "Blue"))
        assertEquals(emptyList<String>(), types())
    }

    @Test
    fun link_up_hides_the_band_and_forgets_the_alert() {
        up()
        feed(alert())
        up()
        director.onBandAction("allow")

        // A press that arrives for the band the link-up hid answers nothing, and says so.
        assertEquals(listOf("hide", "show CLAUDE · approve", "hide", "brief No longer waiting"), glasses.log)
        assertEquals(emptyList<String>(), types())
    }

    @Test
    fun a_user_close_is_evidence_and_dismisses_while_our_own_hide_is_not() {
        up()
        feed(alert())
        director.onBandClosed(NexusNoticeCloseReason.OWNER)
        assertEquals(emptyList<String>(), types())

        director.onBandClosed(NexusNoticeCloseReason.USER)
        assertEquals(listOf("alert_shown", "alert_dismissed"), types())

        // Nothing is up now, so a second close is not this alert's.
        director.onBandClosed(NexusNoticeCloseReason.USER)
        assertEquals(2, written.size)
    }

    @Test
    fun replaced_by_other_plugin_then_retry_reshows() {
        up()
        feed(alert(id = "A"))
        feed(alert(id = "B", sessionKey = "claude:s2"))
        // Another plugin takes the band right after our own show: no grace, it is a takeover.
        director.onBandClosed(NexusNoticeCloseReason.REPLACED)
        director.onBandAction("allow")
        assertEquals("a press on a band that is gone writes nothing", emptyList<String>(), types())

        feed(alert(id = "B", reason = "retry", sessionKey = "claude:s2"))

        assertEquals("show CLAUDE · approve", glasses.log.last())
        assertFalse("never an update to a band that is gone", glasses.log.last().startsWith("update"))
        assertFalse(glasses.bands.last().wakeDisplay)

        // The band is up again, so a press answers it.
        director.onBandAction("allow")
        assertEquals("B", written.last().getString("id"))
    }

    @Test
    fun a_timed_out_band_is_shown_again_even_for_an_update_frame() {
        up()
        feed(alert(waiting = 1))
        director.onBandClosed(NexusNoticeCloseReason.TIMEOUT)
        feed(alert(reason = "update", waiting = 2))

        assertEquals("show CLAUDE · approve", glasses.log.last())
        assertEquals("+2 waiting", glasses.bands.last().footer)
    }

    @Test
    fun brief_never_replaces_up_band() {
        up()
        feed(alert())
        director.onBrief("Not applied", "try again")
        director.onBandAction("allow")
        // The coordinator's own brief, from an answer it refuses, waits too.
        secure = false
        director.onBandAction("allow")

        assertEquals(listOf("hide", "show CLAUDE · approve"), glasses.log)
    }

    @Test
    fun queued_brief_shows_after_band_closes() {
        up()
        feed(alert())
        director.onBrief("Mode reset", "first")
        assertEquals(listOf("hide", "show CLAUDE · approve"), glasses.log)

        director.onBandClosed(NexusNoticeCloseReason.USER)

        assertEquals("brief Mode reset", glasses.log.last())
    }

    @Test
    fun briefs_shown_in_order_after_band_closes() {
        up()
        feed(alert())
        director.onBrief("One", "a")
        director.onBrief("Two", "b")
        director.onBrief("Three", "c")
        director.onBandClosed(NexusNoticeCloseReason.USER)

        // One at a time: the next waits for the brief on screen to close.
        assertEquals(listOf("brief One"), glasses.log.filter { it.startsWith("brief") })
        director.onBriefClosed()
        assertEquals(listOf("brief One", "brief Two"), glasses.log.filter { it.startsWith("brief") })
        director.onBriefClosed()
        director.onBriefClosed()
        assertEquals(listOf("brief One", "brief Two", "brief Three"), glasses.log.filter { it.startsWith("brief") })
    }

    @Test
    fun lost_brief_close_recovers_after_10s() {
        up()
        director.onBrief("One", "a")
        director.onBrief("Two", "b")
        assertEquals(listOf("hide", "brief One"), glasses.log)
        assertEquals(10_000L, timers.single().delayMs)

        // No close ever comes; the timer alone moves the queue on, with nothing else arriving.
        fireTimer()
        assertEquals(listOf("hide", "brief One", "brief Two"), glasses.log)
    }

    @Test
    fun a_brief_close_cancels_its_timer() {
        up()
        director.onBrief("One", "a")
        director.onBriefClosed()

        assertTrue(timers.single().cancelled)
    }

    @Test
    fun a_brief_taken_by_another_plugin_does_not_chain_the_next() {
        up()
        director.onBrief("One", "a")
        director.onBrief("Two", "b")
        director.onBriefClosed(NexusNoticeCloseReason.REPLACED)

        assertEquals(listOf("hide", "brief One"), glasses.log)
        // After its own 10 s the slot is ours again.
        fireTimer()
        assertEquals("brief Two", glasses.log.last())
    }

    @Test
    fun dedupe_against_brief_on_screen() {
        up()
        director.onBrief("Session control", "Not sent")
        director.onBrief("Session control", "Not sent")
        director.onBriefClosed()

        assertEquals(1, glasses.log.count { it.startsWith("brief") })
    }

    @Test
    fun duplicate_brief_not_queued_twice() {
        up()
        feed(alert())
        director.onBrief("Session control", "Not sent")
        director.onBrief("Session control", "Not sent")
        director.onBandClosed(NexusNoticeCloseReason.USER)
        director.onBriefClosed()

        assertEquals(1, glasses.log.count { it.startsWith("brief") })
    }

    @Test
    fun safety_brief_never_evicted() {
        up()
        feed(alert())
        director.onBrief("Session control", "Not applied: busy", safety = true)
        director.onBrief("Reply too long", "1")
        director.onBrief("Still working", "2")
        director.onBrief("Computer linked", "3")
        // Full: the oldest ordinary brief goes, never the refused change.
        director.onBrief("Can't type here", "4")
        director.onBandClosed(NexusNoticeCloseReason.USER)
        repeat(6) { director.onBriefClosed() }

        val shown = glasses.log.filter { it.startsWith("brief") }
        assertEquals(
            listOf("brief Session control", "brief Still working", "brief Computer linked", "brief Can't type here"),
            shown,
        )
    }

    @Test
    fun agentd_text_starting_with_not_applied_is_not_safety() {
        up()
        feed(alert())
        // agentd's own words (a reply error, a machine name) can say anything.
        director.onBrief("Reply not sent", "Not applied: from agentd")
        director.onBrief("Computer linked", "Monitor only — boss")
        director.onBrief("Still working", "1")
        director.onBrief("Reply too long", "2")
        director.onBrief("Can't type here", "3")
        director.onBandClosed(NexusNoticeCloseReason.USER)
        repeat(6) { director.onBriefClosed() }

        val shown = glasses.log.filter { it.startsWith("brief") }
        assertFalse("evicted like any ordinary brief", "brief Reply not sent" in shown)
        assertEquals(4, shown.size)
        assertTrue(glasses.merged.isEmpty())
    }

    @Test
    fun merged_safety_keeps_newest_six() {
        up()
        feed(alert())
        for (n in 1..12) director.onBrief("Session control", "Not applied: s$n", safety = true)
        director.onBandClosed(NexusNoticeCloseReason.USER)
        repeat(8) { director.onBriefClosed() }

        val lines = glasses.merged.flatten() + glasses.briefs.map { it.second }
        assertTrue(glasses.merged.isNotEmpty())
        assertTrue(glasses.merged.all { it.size <= 6 })
        for (n in 7..12) assertTrue("s$n is shown", lines.any { it.endsWith("s$n") })
        // The title is not repeated in front of each merged line.
        assertTrue(glasses.merged.flatten().none { it.startsWith("Session control") })
    }

    @Test
    fun a_safety_line_already_in_a_merged_band_is_not_queued_again() {
        up()
        feed(alert())
        for (n in 1..5) director.onBrief("Session control", "Not applied: s$n", safety = true)
        director.onBrief("Session control", "Not applied: s2", safety = true)
        director.onBandClosed(NexusNoticeCloseReason.USER)
        repeat(4) { director.onBriefClosed() }

        val lines = glasses.merged.flatten() + glasses.briefs.map { it.second }
        assertEquals(1, lines.count { it.endsWith("s2") })
    }

    @Test
    fun the_service_flag_is_cleared_before_the_director_hears_a_band_close() {
        val order = mutableListOf<String>()
        for (reason in listOf(NexusNoticeCloseReason.USER, NexusNoticeCloseReason.TIMEOUT, NexusNoticeCloseReason.REPLACED)) {
            order.clear()
            routeNoticeClose(
                reason, v2BandUp = true,
                clearV2 = { order += "clear" }, band = { order += "band" }, brief = { order += "brief" },
            )
            assertEquals("$reason", listOf("clear", "band"), order)
        }
        // Our own hide cleared it already; a brief's close goes to the brief queue.
        order.clear()
        routeNoticeClose(NexusNoticeCloseReason.OWNER, true, { order += "clear" }, { order += "band" }, { order += "brief" })
        assertEquals(listOf("band"), order)
        order.clear()
        routeNoticeClose(NexusNoticeCloseReason.TIMEOUT, false, { order += "clear" }, { order += "band" }, { order += "brief" })
        assertEquals(listOf("brief"), order)
    }

    @Test
    fun a_brief_with_no_band_up_shows_at_once() {
        up()
        director.onBrief("Not applied", "x")

        assertEquals("brief Not applied", glasses.log.last())
    }

    @Test
    fun a_brief_queued_behind_a_band_shows_when_agentd_closes_it() {
        up()
        feed(alert())
        director.onBrief("Followup closed", "x")
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "answered")))

        assertEquals(listOf("hide", "show CLAUDE · approve", "hide", "brief Followup closed"), glasses.log)
    }

    @Test
    fun a_done_tap_sends_evidence_and_opens_the_reader() {
        up()
        feed(alert(kind = "done"))
        director.onBandInput()

        assertEquals("output A", glasses.log.last())
        assertEquals(listOf("alert_shown"), types())
    }

    @Test
    fun the_hubs_shown_report_is_evidence_for_the_band_up_now() {
        up()
        director.onBandShown()
        assertEquals(emptyList<String>(), types())

        feed(alert())
        director.onBandShown()

        assertEquals(listOf("alert_shown"), types())
        assertEquals("A", written.single().getString("id"))
    }

    @Test
    fun a_shown_report_for_a_band_replaced_before_it_ran_is_not_evidence() {
        val queue = ArrayDeque<() -> Unit>()
        val queued = AlertDirector(
            coordinator = AlertCoordinator(clock = { now }),
            write = { written += JSONObject(it); AgentdWire.Result.Sent },
            secure = { true },
            glasses = { glasses },
            post = { queue.addLast(it) },
        )
        fun drain() { while (queue.isNotEmpty()) queue.removeFirst()() }
        queued.onEvent(AgentdEvent.LinkUp(1L, true))
        queued.onEvent(AgentdEvent.Action(alert(id = "A")))
        drain()

        // B's show is already queued when the hub's report for A's band lands.
        queued.onEvent(AgentdEvent.Action(alert(id = "B")))
        queued.onBandShown()
        drain()

        assertEquals(emptyList<String>(), types())
        queued.onBandShown()
        drain()
        assertEquals(listOf("alert_shown"), types())
        assertEquals("B", written.single().getString("id"))
    }

    @Test
    fun an_approval_with_no_glasses_is_not_left_for_a_refresh_to_find() {
        val absent = AlertDirector(
            coordinator = AlertCoordinator(clock = { now }),
            write = { written += JSONObject(it); AgentdWire.Result.Sent },
            secure = { true },
            glasses = { null },
            post = { it() },
        )
        absent.onEvent(AgentdEvent.LinkUp(1L, true))
        absent.onEvent(AgentdEvent.Action(alert()))
        absent.onBandAction("allow")

        assertEquals(emptyList<String>(), types())
    }

    @Test
    fun an_old_service_destroyed_late_never_clears_the_newer_directors_slot() {
        fun fresh() = AlertDirector(
            coordinator = AlertCoordinator(clock = { now }),
            write = { AgentdWire.Result.Sent },
            secure = { true },
            glasses = { glasses },
            post = { it() },
        )
        val older = fresh()
        val newer = fresh()
        AgentsRuntime.alertDirector = older
        AgentsRuntime.alertDirector = newer

        // The older service's onDestroy runs after the newer one started.
        assertFalse(AgentsRuntime.clearAlertDirector(older))
        assertTrue(AgentsRuntime.alertDirector === newer)

        assertTrue(AgentsRuntime.clearAlertDirector(newer))
        assertEquals(null, AgentsRuntime.alertDirector)
    }

    // ------------------------------------------------------------ alert history (U1)

    private fun entry(id: String = "A") = history.entries.value.single { it.alertId == id }

    @Test
    fun acted_on_glasses_records_label() {
        up()
        feed(alert(id = "A"))
        assertEquals("CLAUDE", entry().provider)
        assertEquals("my-repo", entry().heading)

        director.onBandAction(AlertCoordinator.ALLOW)
        // The frame is written, but only agentd's word ends the entry.
        assertEquals(Outcome.PENDING, entry().outcome)
        assertEquals("Allowed", entry().actionLabel)

        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "acted")))
        assertEquals(Outcome.ACTED, entry().outcome)
        assertEquals("Allowed", entry().actionLabel)
    }

    @Test
    fun send_without_link_records_nothing() {
        up()
        feed(alert(id = "A"))
        writeResult = AgentdWire.Result.NotSecure
        director.onBandAction(AlertCoordinator.DENY)
        assertEquals(null, entry().actionLabel)

        // A brief-only refusal never writes, so it records nothing either.
        secure = false
        director.onBandAction(AlertCoordinator.ALLOW)
        assertEquals(null, entry().actionLabel)
        assertEquals(Outcome.PENDING, entry().outcome)

        // The same alert closed with nothing attempted from here reads Handled.
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "acted")))
        assertEquals("Handled", entry().actionLabel)
    }

    @Test
    fun rejected_answer_stays_pending_with_error() {
        up()
        feed(alert(id = "A"))
        director.onBandAction(AlertCoordinator.ALLOW)
        val sent = written.single { it.getString("type") == "alert_action" }
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack(sent.getString("msgId"), "rejected", "wrong_request")))

        assertEquals(Outcome.PENDING, entry().outcome)
        assertEquals("wrong_request", entry().lastError)
        assertEquals(null, entry().actionLabel)
    }

    @Test
    fun answered_on_laptop_is_withdrawn() {
        up()
        feed(alert(id = "A"))
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "withdrawn")))
        assertEquals(Outcome.WITHDRAWN, entry().outcome)
    }

    @Test
    fun expired_is_ignored_timed_out() {
        up()
        feed(alert(id = "A"))
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("A", "expired")))
        assertEquals(Outcome.EXPIRED, entry().outcome)
    }

    @Test
    fun dismissed_approval_stays_pending_then_reminder_counts() {
        up()
        feed(alert(id = "A"))
        director.onBandAction(AlertCoordinator.LATER)
        assertEquals(Outcome.PENDING, entry().outcome)
        assertEquals(1, entry().shownCount)

        // A user close of the band is a dismissal too.
        feed(alert(id = "A", reason = "reminder"))
        director.onBandClosed(NexusNoticeCloseReason.USER)
        assertEquals(Outcome.PENDING, entry().outcome)
        assertEquals(2, entry().shownCount)

        // A retry of the same band is not another showing.
        feed(alert(id = "A", reason = "reminder"))
        feed(alert(id = "A", reason = "retry"))
        assertEquals(3, entry().shownCount)
    }

    @Test
    fun a_done_dismissed_or_read_is_final() {
        up()
        feed(alert(id = "D", kind = "done"))
        director.onBandClosed(NexusNoticeCloseReason.USER)
        assertEquals(Outcome.DISMISSED, entry("D").outcome)
        assertEquals(null, entry("D").actionLabel)

        feed(alert(id = "E", kind = "done"))
        director.onBandInput()
        assertEquals(Outcome.DISMISSED, entry("E").outcome)
        assertEquals("Read", entry("E").actionLabel)
    }

    @Test
    fun session_end_marks_pending_withdrawn() {
        up()
        feed(alert(id = "A"))
        // Only agentd's own word that the session ended counts.
        director.onSessionEnded("claude:s1")
        assertEquals(Outcome.WITHDRAWN, entry().outcome)

        // Without keep-after-session, the next change drops what a closed session left.
        keepAfterSession = false
        feed(alert(id = "B", sessionKey = "claude:s2"))
        assertEquals(listOf("B"), history.entries.value.map { it.alertId })
    }

    private val linkSession = AgentSession(id = "s1", provider = AgentProvider.CLAUDE, title = "s1", status = AgentStatus.NEEDS_YOU)

    /**
     * The monitor service's wiring of a real store into the director: an alert for s1 is pending,
     * then a transport clears the board and the link comes back with [reconnectSnapshot].
     */
    private fun pendingThenReconnect(vararg reconnectSnapshot: AgentSession) {
        val store = AgentSessionStore()
        store.onSessionDeparted(director::onSessionEnded)
        store.pinOwners(history::hasEntries)
        up()
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(linkSession), machineId = "A")
        director.onBoard(setOf("claude:s1"))
        feed(alert(id = "A"))

        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
        director.onEvent(AgentdEvent.LinkDown(1L))
        director.onBoard(emptySet())
        assertEquals("a transient clear ends nothing", Outcome.PENDING, entry("A").outcome)

        up()
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, reconnectSnapshot.toList(), machineId = "A")
        director.onBoard(reconnectSnapshot.mapTo(HashSet()) { it.key })
    }

    /** The monitor service's wiring of a real store into the director: departures are direct calls. */
    private class Linked(val store: AgentSessionStore)

    private fun linked(block: Linked.() -> Unit) {
        val store = AgentSessionStore()
        val stop = store.onSessionDeparted(director::onSessionEnded)
        // As AgentsRuntime pins them: a session's owner record lives while its history does.
        val unpin = store.pinOwners(history::hasEntries)
        Linked(store).block()
        unpin()
        stop()
    }

    private fun session(id: String, status: AgentStatus = AgentStatus.NEEDS_YOU, activity: Long? = null) =
        AgentSession(id = id, provider = AgentProvider.CLAUDE, title = id, status = status, lastActivityAt = activity)

    @Test
    fun snapshot_from_b_never_ends_a_sessions() = linked {
        keepAfterSession = true
        up()
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session("s1")), machineId = "A")
        feed(alert(id = "A", sessionKey = "claude:s1"))
        // A's link goes; B links with sessions of its own.
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session("b1")), machineId = "B")
        assertEquals("B says nothing of A's sessions", Outcome.PENDING, entry("A").outcome)

        // A's own snapshot omits s1: it was closed while A was away.
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList(), machineId = "A")
        assertEquals(Outcome.WITHDRAWN, entry("A").outcome)
    }

    @Test
    fun pruned_session_with_history_is_reconciled_on_its_machines_snapshot() = linked {
        keepAfterSession = true
        up()
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session("s1", AgentStatus.DONE, activity = 0L)), machineId = "A", nowMs = 0L)
        feed(alert(id = "D", kind = "done", sessionKey = "claude:s1"))
        // Done long enough to age off the board; its history entry still waits.
        assertEquals(setOf("claude:s1"), store.prune(nowMs = AgentSessionStore.DONE_RETENTION_MS + 1))
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)

        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList(), machineId = "A")
        assertEquals(Outcome.WITHDRAWN, entry("D").outcome)
    }

    @Test
    fun owner_records_with_history_are_never_evicted_by_cap() = linked {
        keepAfterSession = true
        up()
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, listOf(session("s1")), machineId = "A")
        feed(alert(id = "A", sessionKey = "claude:s1"))
        // A disconnects; B reports far more sessions than the owner cap holds, then goes too.
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, (0 until 2_000).map { session("b$it") }, machineId = "B")
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, (2_000 until 4_000).map { session("b$it") }, machineId = "B")
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)

        // A comes back without s1: its entry is still settled.
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList(), machineId = "A")
        assertEquals(Outcome.WITHDRAWN, entry("A").outcome)
    }

    @Test
    fun hundred_departures_all_delivered() = linked {
        keepAfterSession = true
        up()
        val sessions = (0 until 100).map { session("s$it") }
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, sessions, machineId = "A")
        sessions.forEach { feed(alert(id = "A${it.id}", sessionKey = it.key)) }
        store.clearLinkSessions(AgentProvider.AGENTD_PROVIDERS)

        // All hundred were closed while the link was down.
        store.replaceLinkSessions(AgentProvider.AGENTD_PROVIDERS, emptyList(), machineId = "A")
        assertEquals(100, history.entries.value.size)
        assertEquals(listOf(Outcome.WITHDRAWN), history.entries.value.map { it.outcome }.distinct())
    }

    @Test
    fun session_gone_in_reconnect_snapshot_ends_it_drop_mode() {
        keepAfterSession = false
        // The session was closed on the laptop while the link was down: the reconnect snapshot omits it.
        pendingThenReconnect()
        assertEquals(emptyList<String>(), history.entries.value.map { it.alertId })
    }

    @Test
    fun session_gone_in_reconnect_snapshot_ends_it_keep_mode() {
        keepAfterSession = true
        pendingThenReconnect()
        assertEquals(Outcome.WITHDRAWN, entry("A").outcome)
    }

    @Test
    fun transient_clear_then_same_session_in_snapshot_keeps_pending() {
        keepAfterSession = false
        pendingThenReconnect(linkSession)
        assertEquals(Outcome.PENDING, entry("A").outcome)
    }

    @Test
    fun monitoring_stop_keeps_history() {
        keepAfterSession = false
        up()
        director.onBoard(setOf("claude:s1"))
        feed(alert(id = "A"))
        // Monitoring stops: the transports clear the board, which says nothing of the laptop's sessions.
        director.onBoard(emptySet())
        feed(alert(id = "B", sessionKey = "claude:s2"))

        assertEquals(setOf("A", "B"), history.entries.value.map { it.alertId }.toSet())
        assertEquals(Outcome.PENDING, entry("A").outcome)
    }

    @Test
    fun reconnect_keeps_pending_entries_and_counts() {
        keepAfterSession = false
        up()
        director.onBoard(setOf("claude:s1"))
        feed(alert(id = "A"))
        director.onEvent(AgentdEvent.LinkDown(1L))
        director.onBoard(emptySet())
        up()
        director.onBoard(setOf("claude:s1"))
        feed(alert(id = "A", reason = "retry"))
        assertEquals(Outcome.PENDING, entry().outcome)
        assertEquals(1, entry().shownCount)

        feed(alert(id = "A", reason = "reminder"))
        assertEquals(1, history.entries.value.size)
        assertEquals(2, entry().shownCount)
    }

    @Test
    fun a_followup_written_marks_the_done_replied() {
        up()
        feed(alert(id = "D", kind = "done"))
        director.onFollowupWritten("claude:s1", "m1")
        assertEquals("Replied", entry("D").actionLabel)
        director.onEvent(AgentdEvent.Action(AgentdAction.AlertClosed("D", "acted")))
        assertEquals(Outcome.ACTED, entry("D").outcome)
        assertEquals("Replied", entry("D").actionLabel)
    }

    @Test
    fun rejected_followup_shows_not_sent() {
        up()
        feed(alert(id = "D", kind = "done"))
        director.onFollowupWritten("claude:s1", "m1")
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack("m1", "rejected", "no_followup_window")))

        assertEquals(Outcome.PENDING, entry("D").outcome)
        assertEquals("no_followup_window", entry("D").lastError)
        assertEquals(null, entry("D").actionLabel)
        assertEquals("Not sent: no_followup_window", outcomeText(entry("D")))

        // A new follow-up ends the old rejection; once agentd applied it, a stray refusal changes nothing.
        director.onFollowupWritten("claude:s1", "m2")
        assertEquals(null, entry("D").lastError)
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack("m2", "applied", null)))
        director.onEvent(AgentdEvent.Action(AgentdAction.Ack("m2", "rejected", "late")))
        assertEquals(null, entry("D").lastError)
        assertEquals("Replied", entry("D").actionLabel)
    }
}
