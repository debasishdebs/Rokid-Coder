package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
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
        override fun brief(title: String, body: String) { log += "brief $title" }
        override fun openOutput(alert: AgentdAction.Alert) { log += "output ${alert.id}" }
        override fun openDecision(alert: AgentdAction.Alert) { log += "decision ${alert.id}" }
        override fun openQuestion(alert: AgentdAction.Alert) { log += "question ${alert.id}" }
        override fun invalidate(alertId: String) { log += "invalidate $alertId" }
    }

    private val glasses = Glasses()
    private val written = mutableListOf<JSONObject>()
    private var secure = true
    private var now = 0L
    private val director = AlertDirector(
        coordinator = AlertCoordinator(clock = { now }),
        write = { written += JSONObject(it) },
        secure = { secure },
        glasses = { glasses },
        post = { it() },
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
        return AgentdProtocolCodec().parse(frame.toString()) as AgentdAction.Alert
    }

    private fun feed(alert: AgentdAction.Alert) = director.onEvent(AgentdEvent.Action(alert))
    private fun types() = written.map { it.getString("type") }

    private fun up() = director.onEvent(AgentdEvent.LinkUp(1L, secure))

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
    fun a_press_with_the_link_down_writes_nothing_and_says_monitor_only() {
        up()
        feed(alert())
        director.onEvent(AgentdEvent.LinkDown(1L))
        secure = false
        director.onBandAction("deny")

        assertFalse("alert_action" in types())
        // The band is still up, so the brief waits for it.
        assertTrue(glasses.log.none { it.startsWith("brief") })
        director.onBandClosed(NexusNoticeCloseReason.TIMEOUT)
        assertEquals("brief Monitor only", glasses.log.last())
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
    fun link_up_hides_the_band_and_forgets_the_alert() {
        up()
        feed(alert())
        up()
        director.onBandAction("allow")

        assertEquals(listOf("hide", "show CLAUDE · approve", "hide"), glasses.log)
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
        director.onBrief("Not applied", "newest")
        assertEquals(listOf("hide", "show CLAUDE · approve"), glasses.log)

        director.onBandClosed(NexusNoticeCloseReason.USER)

        // Newest wins: each brief would replace the one before it.
        assertEquals("brief Not applied", glasses.log.last())
        assertEquals(3, glasses.log.size)
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
    fun an_approval_with_no_glasses_is_not_left_for_a_refresh_to_find() {
        val absent = AlertDirector(
            coordinator = AlertCoordinator(clock = { now }),
            write = { written += JSONObject(it) },
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
            write = { },
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
}
