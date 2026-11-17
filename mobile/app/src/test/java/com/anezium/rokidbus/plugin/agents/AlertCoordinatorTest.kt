package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.plugin.agents.AlertCoordinator.Effect
import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The coordinator against agentd's real alert queue. The scenarios in
 * `contracts/alert-sequences.json` were recorded by
 * `agentd/test/record-alert-sequences.js`: what agentd sent (`agentd`), what
 * the glasses did (`glasses`), and what the phone wrote back to agentd
 * (`phone`). [replay] feeds the first two to the coordinator and requires its
 * writes to be exactly the third, in order, so agentd and the phone agree on
 * every recorded step before any test looks at the details.
 */
class AlertCoordinatorTest {
    private val scenarios: JSONObject = JSONObject(
        File("../../contracts/alert-sequences.json").readText(),
    ).getJSONObject("scenarios")

    private class Clock(var now: Long = 0L)

    private class Replay(val steps: List<Pair<JSONObject, List<Effect>>>) {
        val effects: List<Effect> get() = steps.flatMap { it.second }
        val shows: List<Effect.Show> get() = effects.filterIsInstance<Effect.Show>()
        val updates: List<Effect.Update> get() = effects.filterIsInstance<Effect.Update>()

        /** The effects of the `agentd` frame with this id and reason, the [nth] of them. */
        fun onFrame(id: String, reason: String, nth: Int = 0): List<Effect> = steps.filter { (step, _) ->
            step.optJSONObject("agentd")?.let { it.optString("id") == id && it.optString("reason") == reason } == true
        }[nth].second
    }

    private fun replay(name: String, secure: Boolean = true): Replay {
        val steps = scenarios.getJSONObject(name).getJSONArray("steps")
        val clock = Clock()
        val coordinator = AlertCoordinator(clock = { clock.now })
        val codec = AgentdProtocolCodec()
        val unmatched = ArrayDeque<String>()
        val recorded = mutableListOf<Pair<JSONObject, List<Effect>>>()
        for (index in 0 until steps.length()) {
            val step = steps.getJSONObject(index)
            clock.now = step.getLong("t")
            val effects = when {
                step.has("agentd") -> when (val action = codec.parse(step.getJSONObject("agentd").toString())) {
                    is AgentdAction.Alert -> coordinator.onAlert(action)
                    is AgentdAction.AlertClosed -> coordinator.onAlertClosed(action.id, action.reason)
                    else -> fail("$name step $index: the codec did not take ${step.getJSONObject("agentd")}") as Nothing
                }
                step.has("glasses") -> glasses(coordinator, step.getJSONObject("glasses"), secure)
                step.has("link") -> if (step.getString("link") == "up") coordinator.onLinkUp() else coordinator.onLinkDown()
                step.has("phone") -> {
                    val written = unmatched.removeFirstOrNull()
                        ?: fail("$name step $index: agentd heard ${step.getJSONObject("phone")}, the phone wrote nothing") as Nothing
                    assertFrame("$name step $index", step.getJSONObject("phone"), JSONObject(written))
                    emptyList()
                }
                else -> emptyList() // agentd's own operations; their frames are the next steps
            }
            unmatched += effects.filterIsInstance<Effect.Send>().map { it.line }
            recorded += step to effects
        }
        assertTrue("$name: the phone wrote frames agentd never heard: $unmatched", unmatched.isEmpty())
        return Replay(recorded)
    }

    private fun glasses(coordinator: AlertCoordinator, event: JSONObject, secure: Boolean): List<Effect> {
        val id = event.getString("id")
        return when (event.getString("event")) {
            "shown" -> coordinator.onShownEvidence(id)
            "closed" -> coordinator.onBandClosed(id, NexusNoticeCloseReason.valueOf(event.getString("reason")))
            "action" -> coordinator.onAction(id, event.getString("action"), secure)
            else -> fail("unknown glasses event $event") as Nothing
        }
    }

    /** Field for field; a recorded msgId of `*` only says the phone's own msgId is there. */
    private fun assertFrame(where: String, expected: JSONObject, actual: JSONObject) {
        val keys = expected.keys().asSequence().toSet()
        assertEquals(where, keys, actual.keys().asSequence().toSet())
        for (key in keys) {
            if (key == "msgId" && expected.getString(key) == "*") {
                assertTrue(where, actual.getString(key).isNotBlank())
            } else {
                assertEquals("$where: $key", expected.get(key), actual.get(key))
            }
        }
    }

    // ------------------------------------------------------------ synthetic alerts

    private fun alert(
        id: String = "A",
        reason: AlertReason = AlertReason.NEW,
        kind: AlertKind = AlertKind.APPROVAL,
        waiting: Int = 0,
        sessionKey: String = "claude:s1",
    ): AgentdAction.Alert {
        val frame = JSONObject()
            .put("type", "alert").put("v", 2).put("id", id).put("sessionKey", sessionKey)
            .put("kind", kind.wire).put("title", "${kind.wire} $id").put("body", "body $id")
            .put("waiting", waiting).put("reason", reason.wire)
        if (kind == AlertKind.APPROVAL) frame.put("actions", JSONArray(listOf("allow", "deny")))
        if (kind == AlertKind.QUESTION) {
            frame.put(
                "question",
                JSONObject().put("requestRef", "ref-$id").put("source", "claude_tool").put(
                    "items",
                    JSONArray().put(JSONObject().put("text", "Pick?").put("options", JSONArray()).put("multiSelect", false).put("allowFreeText", true)),
                ),
            )
        }
        return AgentdProtocolCodec().parse(frame.toString()) as AgentdAction.Alert
    }

    private val NO_LONGER_WAITING = Effect.Brief("No longer waiting", "Answer on laptop if still needed")

    private fun sends(effects: List<Effect>): List<JSONObject> =
        effects.filterIsInstance<Effect.Send>().map { JSONObject(it.line) }

    private fun types(effects: List<Effect>): List<String> = sends(effects).map { it.getString("type") }

    // ------------------------------------------------------------ the recorded queue

    @Test
    fun new_shows_with_sound_retry_updates_silently() {
        val burst = replay("burst")
        // Every new alert sounds exactly once, whatever comes after it.
        val sounding = burst.shows.filter { it.sound }.map { it.alert.id }
        assertEquals(listOf("A", "D", "B", "C"), sounding)
        assertTrue(burst.shows.filter { it.sound }.all { it.wake })
        // B's retry refreshes its own band: no new band, no sound.
        assertEquals(listOf(Effect.Update::class), burst.onFrame("B", "retry").map { it::class })
        // The question stays through two arrivals that do not preempt it, counting them.
        assertEquals(listOf<Effect>(), burst.onFrame("A", "update", 0).filterIsInstance<Effect.Show>())
        assertEquals("+2 waiting", AlertCoordinator.footer(burst.onFrame("A", "update", 1).filterIsInstance<Effect.Update>().single().alert))
        // The approval takes the band from the question at once.
        val approval = burst.onFrame("D", "new").filterIsInstance<Effect.Show>().single()
        assertEquals("+3 waiting", AlertCoordinator.footer(approval.alert))
    }

    @Test
    fun reminder_shows_and_wakes_but_never_sounds() {
        val reminder = replay("reminder")
        val timeout = reminder.steps.single { it.first.optJSONObject("glasses")?.optString("event") == "closed" }
        assertEquals(emptyList<Effect>(), timeout.second)
        val show = reminder.onFrame("A", "reminder", 0).single() as Effect.Show
        assertTrue(show.wake)
        assertFalse(show.sound)
    }

    @Test
    fun lost_shown_ack_is_resent_on_retry() {
        val lost = replay("lost_ack")
        // The replay already matched both re-sent acks to agentd's log; each retry carries one.
        for (nth in 0..1) {
            val effects = lost.onFrame("A", "retry", nth)
            assertEquals(Effect.Update::class, effects.first()::class)
            assertEquals(listOf("alert_shown"), types(effects))
        }
        assertTrue(lost.shows.single().sound)
    }

    @Test
    fun update_reason_refreshes_waiting_without_sound() {
        val burst = replay("burst")
        val counts = (0..1).map { burst.onFrame("A", "update", it).single() as Effect.Update }
            .map { AlertCoordinator.footer(it.alert) }
        assertEquals(listOf("+1 waiting", "+2 waiting"), counts)
        assertNull(AlertCoordinator.footer(alert(waiting = 0)))

        // An update for a band that is not up is ignored.
        val clock = Clock()
        val coordinator = AlertCoordinator(clock = { clock.now })
        coordinator.onAlert(alert())
        coordinator.onBandClosed("A", NexusNoticeCloseReason.TIMEOUT)
        assertEquals(emptyList<Effect>(), coordinator.onAlert(alert(reason = AlertReason.UPDATE, waiting = 1)))
        assertEquals(emptyList<Effect>(), coordinator.onAlert(alert(id = "Z", reason = AlertReason.UPDATE, waiting = 1)))
    }

    @Test
    fun preempted_alert_resumes_without_sound() {
        val preemption = replay("preemption")
        val closed = preemption.steps.single { it.first.optJSONObject("agentd")?.optString("type") == "alert_closed" }.second
        // The reason agentd gave is passed on for the history; the band comes down.
        assertEquals(listOf(Effect.Hide), closed.filterNot { it is Effect.Closed })
        assertEquals(1, closed.count { it is Effect.Closed })
        val resume = preemption.onFrame("A", "resume").single() as Effect.Show
        assertFalse(resume.sound)
        // The notice was seen before the approval took its band, so it does not wake the glasses again.
        assertFalse(resume.wake)
    }

    @Test
    fun user_close_sends_shown_then_dismissed_and_reminder_shows_again() {
        val park = replay("park_reminder")
        val close = park.steps.single { it.first.optJSONObject("glasses")?.optString("event") == "closed" }.second
        assertEquals(listOf("alert_shown", "alert_dismissed"), types(close))
        val again = park.onFrame("A", "reminder").single() as Effect.Show
        assertFalse(again.sound)
        assertTrue(again.wake)
        assertEquals("A", again.alert.id)
    }

    @Test
    fun link_up_forgets_and_hides_then_higher_priority_alert_may_come_first() {
        val link = replay("link_up")
        val up = link.steps.single { it.first.optString("link") == "up" }.second
        assertEquals(listOf(Effect.Hide), up)
        // The question queued behind the error goes first; the error, agentd's former occupant, resumes after it.
        assertEquals(listOf("A", "B", "A"), link.shows.map { it.alert.id })
        val question = link.onFrame("B", "new").single() as Effect.Show
        assertTrue(question.sound)
        val resumed = link.onFrame("A", "resume").single() as Effect.Show
        assertFalse(resumed.sound)
        // Forgotten at link up: the error has no evidence and no wake on record any more.
        assertTrue(resumed.wake)
        // The notice that came and went while the link was down never appears.
        assertTrue(link.effects.none { it is Effect.Show && it.alert.id == "C" })
    }

    // ------------------------------------------------------------ display episodes

    @Test
    fun timeout_close_is_not_evidence_and_next_retry_shows_new_band() {
        val clock = Clock()
        val coordinator = AlertCoordinator(clock = { clock.now })
        coordinator.onAlert(alert())
        assertEquals(emptyList<Effect>(), coordinator.onBandClosed("A", NexusNoticeCloseReason.TIMEOUT))
        assertNull(coordinator.current)
        clock.now = 5_000
        val retry = coordinator.onAlert(alert(reason = AlertReason.RETRY))
        val show = retry.single() as Effect.Show
        assertFalse(show.sound)
        // Never confirmed, but woken five seconds ago.
        assertFalse(show.wake)
        assertEquals("A", coordinator.current?.id)
    }

    @Test
    fun failed_first_wake_then_retry_wakes_once_within_60s() {
        val clock = Clock()
        val coordinator = AlertCoordinator(clock = { clock.now })
        fun retryAt(at: Long): Effect.Show {
            coordinator.onBandClosed("A", NexusNoticeCloseReason.TIMEOUT)
            clock.now = at
            return coordinator.onAlert(alert(reason = AlertReason.RETRY)).single() as Effect.Show
        }
        assertTrue((coordinator.onAlert(alert()).single() as Effect.Show).wake)
        assertEquals(
            listOf(false, false, true, false, false, true),
            listOf(5_000L, 59_999L, 60_000L, 75_000L, 119_999L, 120_000L).map { retryAt(it).wake },
        )
        assertTrue(listOf(5_000L, 60_000L).map { retryAt(it + 200_000L) }.none { it.sound })

        // Once the glasses showed it, a retry never wakes them again.
        coordinator.onShownEvidence("A")
        assertFalse(retryAt(400_000L).wake)
    }

    @Test
    fun evidence_survives_retry_update_of_same_band_and_reacks() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        assertEquals(listOf("alert_shown"), types(coordinator.onShownEvidence("A")))
        // More evidence for the same band says nothing new.
        assertEquals(emptyList<Effect>(), coordinator.onShownEvidence("A"))
        repeat(2) {
            val retry = coordinator.onAlert(alert(reason = AlertReason.RETRY))
            assertEquals(Effect.Update::class, retry.first()::class)
            assertEquals(listOf("alert_shown"), types(retry))
        }
        // A resume of the same band refreshes it, keeps its evidence and re-acks (R84):
        // agentd's requeue put the alert back to `sent`, and the hub reports no new shown.
        val resume = coordinator.onAlert(alert(reason = AlertReason.RESUME))
        assertEquals(Effect.Update::class, resume.first()::class)
        assertEquals(listOf("alert_shown"), types(resume))
        assertEquals(emptyList<Effect>(), coordinator.onShownEvidence("A"))
    }

    @Test
    fun reminder_while_band_up_reshows_silently_and_resets_evidence() {
        val reminder = replay("reminder")
        // The second reminder lands while the first reminder's band is still up.
        val reshow = reminder.onFrame("A", "reminder", 1).single() as Effect.Show
        assertFalse(reshow.sound)
        assertTrue(reshow.wake)
        // Its evidence was reset: the replay matched a third alert_shown to agentd's log.
        assertEquals(3, reminder.effects.count { it is Effect.Send })

        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        coordinator.onAlert(alert(reason = AlertReason.REMINDER))
        assertEquals(emptyList<String>(), types(coordinator.onAlert(alert(reason = AlertReason.RETRY))))
        assertEquals(listOf("alert_shown"), types(coordinator.onShownEvidence("A")))
    }

    @Test
    fun replaced_owner_disconnect_close_never_count() {
        for (reason in listOf(
            NexusNoticeCloseReason.TIMEOUT,
            NexusNoticeCloseReason.REPLACED,
            NexusNoticeCloseReason.OWNER,
            NexusNoticeCloseReason.DISCONNECT,
        )) {
            val clock = Clock()
            val coordinator = AlertCoordinator(clock = { clock.now })
            coordinator.onAlert(alert())
            assertEquals("$reason", emptyList<Effect>(), coordinator.onBandClosed("A", reason))
            clock.now = 5_000
            val retry = coordinator.onAlert(alert(reason = AlertReason.RETRY))
            assertEquals("$reason: a new band, and no ack", listOf(Effect.Show::class), retry.map { it::class })
        }
        // A close of a band that is not this alert's says nothing about it.
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        assertEquals(emptyList<Effect>(), coordinator.onBandClosed("Z", NexusNoticeCloseReason.USER))
        assertEquals(emptyList<Effect>(), coordinator.onShownEvidence("Z"))
        assertEquals("A", coordinator.current?.id)
    }

    // ------------------------------------------------------------ actions

    @Test
    fun allow_on_secure_sends_alert_action_once_with_reused_msgId() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        val first = coordinator.onAction("A", "allow", secure = true)
        // The press is evidence too, acked before the answer.
        assertEquals(listOf("alert_shown", "alert_action"), types(first))
        val action = sends(first).last()
        assertEquals("A", action.getString("id"))
        assertEquals("allow", action.getString("action"))
        assertEquals(2, action.getInt("v"))

        val again = sends(coordinator.onAction("A", "allow", secure = true))
        assertEquals(listOf("alert_action"), again.map { it.getString("type") })
        assertEquals(action.getString("msgId"), again.single().getString("msgId"))

        val deny = sends(coordinator.onAction("A", "deny", secure = true)).single()
        assertNotEquals(action.getString("msgId"), deny.getString("msgId"))
    }

    @Test
    fun more_answer_later_are_local_never_alert_action() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        val more = coordinator.onAction("A", "more", secure = true)
        assertEquals(listOf(Effect.OpenDecision(coordinator.current!!)), more)
        // A card of the wrong kind is never opened.
        assertEquals(emptyList<Effect>(), coordinator.onAction("A", "answer", secure = true))

        coordinator.onAlert(alert(id = "Q", kind = AlertKind.QUESTION))
        coordinator.onShownEvidence("Q")
        val answer = coordinator.onAction("Q", "answer", secure = true)
        assertEquals(listOf(Effect.OpenQuestion(coordinator.current!!)), answer)

        // Later is the wearer's own dismiss: the band goes and agentd parks the question.
        val later = coordinator.onAction("Q", "later", secure = true)
        assertEquals(listOf("alert_dismissed"), types(later))
        assertTrue(Effect.Hide in later)
        assertNull(coordinator.current)
        for (effects in listOf(more, answer, later)) {
            assertTrue(sends(effects).none { it.getString("type") == "alert_action" })
        }
    }

    @Test
    fun no_secure_link_press_shows_computer_not_connected() {
        // On a fresh band the press is still display evidence; only that monitor ack goes out.
        val fresh = AlertCoordinator(clock = { 0L })
        fresh.onAlert(alert())
        val first = fresh.onAction("A", "allow", secure = false)
        assertEquals(listOf("alert_shown"), types(first))
        assertTrue(Effect.Brief("Not sent", "Computer not connected") in first)

        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        assertEquals(
            listOf(Effect.Brief("Not sent", "Computer not connected")),
            coordinator.onAction("A", "allow", secure = false),
        )
        assertEquals(
            listOf(Effect.Brief("Not sent", "Computer not connected")),
            coordinator.onAction("A", "deny", secure = false),
        )
    }

    // ------------------------------------------------------------ invalidation

    @Test
    fun alert_closed_invalidates_bound_card_and_late_confirm_sends_nothing() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        coordinator.onAction("A", "more", secure = true)
        // Another alert takes the band: the decision card stays bound and answerable.
        coordinator.onAlert(alert(id = "B", kind = AlertKind.NOTICE))
        assertEquals(listOf("alert_action"), types(coordinator.onCardConfirm("A", "deny", secure = true)))

        assertEquals(
            listOf(Effect.Closed("A", "withdrawn"), Effect.Invalidate("A")),
            coordinator.onAlertClosed("A", "withdrawn"),
        )
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onCardConfirm("A", "allow", secure = true))
        // Closing the alert on the band takes the band down as well.
        assertEquals(listOf(Effect.Closed("B", "expired"), Effect.Hide), coordinator.onAlertClosed("B", "expired"))
        assertNull(coordinator.current)
    }

    @Test
    fun link_down_session_gone_and_followup_closed_invalidate_bound_cards() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert(id = "A"))
        coordinator.onAction("A", "more", secure = true)
        coordinator.onAlert(alert(id = "Q", kind = AlertKind.QUESTION, sessionKey = "codex:s2"))
        coordinator.onAction("Q", "answer", secure = true)

        assertEquals(listOf(Effect.Invalidate("Q")), coordinator.invalidateSession("codex:s2"))
        assertEquals(emptyList<Effect>(), coordinator.invalidateSession("codex:s2"))
        assertEquals(listOf(Effect.Invalidate("A")), coordinator.onLinkDown())
        // The band itself stays until the link is back.
        assertEquals("Q", coordinator.current?.id)

        coordinator.onAction("Q", "answer", secure = true)
        assertEquals(listOf(Effect.Hide, Effect.Invalidate("Q")), coordinator.onLinkUp())
        assertNull(coordinator.current)
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onAction("Q", "answer", secure = true))
    }

    @Test
    fun late_card_confirm_after_invalidate_session_sends_nothing() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onAction("A", "more", secure = true)
        assertEquals(listOf(Effect.Invalidate("A")), coordinator.invalidateSession("claude:s1"))
        // The band still shows A, but the card was invalidated.
        assertEquals("A", coordinator.current?.id)
        for (action in listOf("allow", "deny", "later")) {
            assertEquals(action, listOf(NO_LONGER_WAITING), coordinator.onCardConfirm("A", action, secure = true))
        }
    }

    @Test
    fun late_card_confirm_after_link_down_sends_nothing() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert(id = "Q", kind = AlertKind.QUESTION))
        coordinator.onAction("Q", "answer", secure = true)
        assertEquals(listOf(Effect.Invalidate("Q")), coordinator.onLinkDown())
        assertEquals("Q", coordinator.current?.id)
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onCardConfirm("Q", "later", secure = true))
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onCardConfirm("Q", "allow", secure = true))
    }

    @Test
    fun card_confirm_is_not_band_evidence() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        coordinator.onAction("A", "more", secure = true)
        // A reminder reshows A on a fresh band the card never saw.
        coordinator.onAlert(alert(reason = AlertReason.REMINDER))
        assertEquals(listOf("alert_action"), types(coordinator.onCardConfirm("A", "allow", secure = true)))
        // The band's own evidence still sends the ack once.
        assertEquals(listOf("alert_shown"), types(coordinator.onShownEvidence("A")))
    }

    @Test
    fun later_from_a_card_dismisses_once_and_unbinds() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onAction("A", "more", secure = true)
        coordinator.onAlert(alert(id = "B", kind = AlertKind.NOTICE))
        assertEquals(listOf("alert_dismissed"), types(coordinator.onCardConfirm("A", "later", secure = true)))
        assertEquals("B", coordinator.current?.id)
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onCardConfirm("A", "allow", secure = true))
    }

    @Test
    fun user_close_after_ack_sends_only_dismissed() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        coordinator.onShownEvidence("A")
        assertEquals(listOf("alert_dismissed"), types(coordinator.onBandClosed("A", NexusNoticeCloseReason.USER)))
        assertNull(coordinator.current)
    }

    // ------------------------------------------------- the question card's answer (Task 7)

    private val answers = mapOf<String, Any>("Pick?" to "Blue")

    private fun openQuestion(coordinator: AlertCoordinator, id: String = "Q") {
        coordinator.onAlert(alert(id = id, kind = AlertKind.QUESTION))
        coordinator.onAction(id, "answer", secure = true)
    }

    @Test
    fun question_confirm_sends_one_question_answer_for_the_bound_alert() {
        val coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        val sent = sends(coordinator.onQuestionConfirm("Q", answers, secure = true)).single()
        assertEquals("question_answer", sent.getString("type"))
        assertEquals("Q", sent.getString("alertId"))
        assertEquals("ref-Q", sent.getString("requestRef"))
        assertEquals("claude:s1", sent.getString("sessionKey"))
        assertEquals("Blue", sent.getJSONObject("answers").getString("Pick?"))
        // A second press reuses the msgId, so agentd applies it once.
        val again = sends(coordinator.onQuestionConfirm("Q", answers, secure = true)).single()
        assertEquals(sent.getString("msgId"), again.getString("msgId"))
    }

    @Test
    fun stale_question_card_sends_nothing_after_each_invalidation() {
        // alert_closed
        var coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        coordinator.onAlertClosed("Q", "answered")
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("Q", answers, secure = true))
        // LinkDown, with the band still up
        coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        coordinator.onLinkDown()
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("Q", answers, secure = true))
        // LinkUp
        coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        coordinator.onLinkUp()
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("Q", answers, secure = true))
        // the session left the board, or its follow-up closed
        coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        coordinator.invalidateSession("claude:s1")
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("Q", answers, secure = true))
    }

    @Test
    fun question_confirm_needs_a_card_opened_for_a_question() {
        val coordinator = AlertCoordinator(clock = { 0L })
        // Never opened.
        coordinator.onAlert(alert(id = "Q", kind = AlertKind.QUESTION))
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("Q", answers, secure = true))
        // An approval's card cannot carry an answer.
        coordinator.onAlert(alert(id = "A"))
        coordinator.onAction("A", "more", secure = true)
        assertEquals(listOf(NO_LONGER_WAITING), coordinator.onQuestionConfirm("A", answers, secure = true))
    }

    @Test
    fun corrected_answer_new_msgid_identical_resend_same() {
        val coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        val first = sends(coordinator.onQuestionConfirm("Q", answers, secure = true)).single()
        val same = sends(coordinator.onQuestionConfirm("Q", mapOf<String, Any>("Pick?" to "Blue"), secure = true)).single()
        val corrected = sends(coordinator.onQuestionConfirm("Q", mapOf<String, Any>("Pick?" to "Red"), secure = true)).single()
        assertEquals(first.getString("msgId"), same.getString("msgId"))
        assertNotEquals(first.getString("msgId"), corrected.getString("msgId"))
        // Sending the first content again after the correction still reuses its own msgId.
        val back = sends(coordinator.onQuestionConfirm("Q", answers, secure = true)).single()
        assertEquals(first.getString("msgId"), back.getString("msgId"))
    }

    @Test
    fun question_confirm_with_no_secure_link_briefs_computer_not_connected() {
        val coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        assertEquals(
            listOf(Effect.Brief("Not sent", "Computer not connected")),
            coordinator.onQuestionConfirm("Q", answers, secure = false),
        )
    }

    @Test
    fun an_answer_over_the_wire_limits_is_refused_not_sent() {
        val coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        val tooLong = mapOf<String, Any>("Pick?" to "x".repeat(4_001))
        assertEquals(
            listOf(Effect.Brief("Not sent", "Answer on laptop")),
            coordinator.onQuestionConfirm("Q", tooLong, secure = true),
        )
    }

    @Test
    fun question_confirm_is_not_band_evidence() {
        val coordinator = AlertCoordinator(clock = { 0L })
        openQuestion(coordinator)
        // The answer button was pressed on the band (evidence, alert_shown); the card's send adds none.
        assertEquals(listOf("question_answer"), types(coordinator.onQuestionConfirm("Q", answers, secure = true)))
    }

    @Test
    fun approval_queued_while_unlinked_arrives_new_with_sound() {
        // R83: it took agentd's empty slot while no link took the frame, so link up sends it as new.
        val emptySlot = replay("empty_slot_link_up")
        val show = emptySlot.shows.single()
        assertEquals(AlertReason.NEW, show.alert.reason)
        assertTrue(show.sound)
        assertTrue(show.wake)
    }

    @Test
    fun an_answer_carries_its_label_for_the_history_and_a_dismissal_says_so() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        val allow = coordinator.onAction("A", "allow", secure = true).filterIsInstance<Effect.Send>().single { it.attempt != null }
        assertEquals(Effect.Attempt("A", "Allowed"), allow.attempt)
        val deny = coordinator.onAction("A", "deny", secure = true).filterIsInstance<Effect.Send>().single { it.attempt != null }
        assertEquals(Effect.Attempt("A", "Denied"), deny.attempt)
        // A refused press has no frame, so nothing to record.
        assertEquals(emptyList<Effect.Send>(), coordinator.onAction("A", "allow", secure = false).filterIsInstance<Effect.Send>().filter { it.attempt != null })
        assertTrue(Effect.Dismissed("A") in coordinator.onAction("A", "later", secure = true))
    }

    @Test
    fun a_rejected_ack_names_the_alert_it_was_for() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        val frame = sends(coordinator.onAction("A", "allow", secure = true)).single { it.getString("type") == "alert_action" }
        val effects = coordinator.onAck(AgentdAction.Ack(frame.getString("msgId"), "rejected", "wrong_request"))
        assertEquals(Effect.Rejected("A", "wrong_request"), effects.first())
        assertEquals(emptyList<Effect>(), coordinator.onAck(AgentdAction.Ack("elsewhere", "rejected", "x")))
    }

    @Test
    fun duplicate_alert_ack_shows_already_answered() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(alert())
        val frame = sends(coordinator.onAction("A", "allow", secure = true)).single { it.getString("type") == "alert_action" }
        assertEquals(
            listOf<Effect>(Effect.Brief("Already answered", "")),
            coordinator.onAck(AgentdAction.Ack(frame.getString("msgId"), "duplicate", null)),
        )
        // An applied ack, or a duplicate for an id this coordinator never sent, says nothing.
        assertEquals(emptyList<Effect>(), coordinator.onAck(AgentdAction.Ack(frame.getString("msgId"), "applied", null)))
        assertEquals(emptyList<Effect>(), coordinator.onAck(AgentdAction.Ack("elsewhere", "duplicate", null)))
    }

    private fun frame(id: String, reason: String, kind: String = "approval") = AgentdProtocolCodec().parse(
        JSONObject()
            .put("type", "alert").put("v", 2).put("id", id).put("sessionKey", "claude:s1")
            .put("kind", kind).put("title", "t").put("body", "b").put("waiting", 0).put("reason", reason)
            .put("actions", JSONArray(listOf("allow", "deny")))
            .toString(),
    ) as AgentdAction.Alert

    @Test
    fun the_dwell_taking_a_band_down_sends_nothing_and_keeps_the_card_from_coming_back_on_an_update() {
        val coordinator = AlertCoordinator(clock = { 0L })
        coordinator.onAlert(frame("A", "new"))
        coordinator.onShownEvidence("A")
        assertTrue(coordinator.hasEvidence("A"))

        assertEquals(listOf<Effect>(Effect.Hide), coordinator.onDwellElapsed("A"))
        assertNull(coordinator.current)
        assertEquals(emptyList<Effect>(), coordinator.onAlert(frame("A", "update")))
        // A stale timer for a band that is no longer up does nothing.
        assertEquals(emptyList<Effect>(), coordinator.onDwellElapsed("A"))
        assertEquals(emptyList<Effect>(), coordinator.onDwellElapsed("other"))
        // agentd's reminder shows it again, silently.
        val shown = coordinator.onAlert(frame("A", "reminder")).filterIsInstance<Effect.Show>().single()
        assertFalse(shown.sound)
        assertTrue(shown.wake)
    }
}
