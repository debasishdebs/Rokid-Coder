package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The service's routing seam: input reaches only the card on screen, and never through a band (R104, R109). */
class GlassesScreenTest {
    private var now = 0L
    private val confirms = mutableListOf<Pair<String, String>>()
    private val decided = mutableListOf<String>()

    private val screen = GlassesScreen(
        clock = { now },
        guardMs = 600L,
        host = object : GlassesScreen.Host {
            override val secure = true
            override fun render() = Unit
            override fun voiceInput(run: VoiceRun, event: NexusInputEvent) = Unit
            override fun questionInput(flow: QuestionFlow, event: NexusInputEvent) = Unit
            override fun menuInput(event: NexusInputEvent) = Unit
            override fun boardInput(event: NexusInputEvent) = Unit
            override fun startVoice(target: VoiceTarget) = Unit
            override fun confirmAlert(alertId: String, action: String) {
                confirms += alertId to action
            }
            override fun decideRequest(requestId: String, decision: ApprovalDecision): Boolean {
                decided += requestId
                return true
            }
        },
    )

    private val alert = AgentdAction.Alert(
        id = "a1",
        sessionKey = "claude:s1",
        kind = AlertKind.APPROVAL,
        title = "approve",
        body = "Run the test suite",
        actions = listOf("allow", "deny", "more"),
        question = null,
        waiting = 0,
        reason = AlertReason.NEW,
    )

    private fun enter() = screen.onInput(NexusInputEvent("agents", KeyEvent.KEYCODE_ENTER, KeyEvent.ACTION_DOWN))

    /** A decision card open long enough that its own guard ran out long ago, Allow selected. */
    private fun staleDecisionCard() {
        screen.openAlertDecision(alert)
        // Past More's reader, onto Allow and Deny.
        now = 1_000L
        enter()
        now = 60_000L
    }

    @Test
    fun band_dismiss_then_second_tap_never_confirms_card_underneath() {
        staleDecisionCard()
        // Another band arrives over it, and the wearer double-taps it away: Later, then the close.
        screen.bandTaken(v2 = true)
        now += 2_000L
        screen.bandTouched()
        now += 30L
        screen.noticeClosed(NexusNoticeCloseReason.USER, band = {}, brief = {})
        now += 50L
        enter()
        assertTrue(confirms.isEmpty())

        // A brief or the v1 status band, closed by the wearer's BACK, is the same.
        now += 5_000L
        screen.bandTaken(v2 = false)
        now += 5_000L
        screen.noticeClosed(NexusNoticeCloseReason.USER, band = {}, brief = {})
        now += 80L
        enter()
        assertTrue(confirms.isEmpty())

        // The plugin's own hide of the band, and the surface reopening, re-arm it too.
        now += 5_000L
        screen.bandHidden()
        now += 80L
        enter()
        now += 5_000L
        screen.surfaceOpened()
        now += 80L
        enter()
        assertTrue(confirms.isEmpty())

        // Past the guard, a deliberate tap on the card still answers it.
        now += 600L
        enter()
        assertEquals(listOf("a1" to AlertCoordinator.ALLOW), confirms)
    }

    @Test
    fun more_shows_full_command_before_decision() {
        val command = "rm -rf build ~/.ssh && " + "npm test -- --grep slow ".repeat(30)
        val long = alert.copy(body = "$command\nRun the test suite")
        screen.openAlertDecision(long)
        assertTrue(screen.alertReading)

        // The reader opens on the summary, then everything that will run, then the description.
        val reader = AlertNotices.approvalReader(long, session = null, held = null)
        assertEquals(com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind.HEADER, reader.segments.first().kind)
        val prose = reader.segments
            .filter { it.kind == com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind.PROSE }
            .joinToString("") { it.text }
        assertTrue(prose.startsWith(command.trim()))
        assertTrue(prose.endsWith("Run the test suite"))

        // Nothing on the reader decides: a tap moves on to the card, a double tap stops there.
        now = 1_000L
        enter()
        now += 80L
        enter()
        assertTrue(!screen.alertReading)
        assertTrue(confirms.isEmpty())
        assertEquals(ActiveCard.Kind.ALERT_DECISION, screen.kind)

        // The decision card keeps Allow and Deny.
        now += 600L
        enter()
        assertEquals(listOf("a1" to AlertCoordinator.ALLOW), confirms)
    }

    @Test
    fun a_band_over_a_held_tool_call_card_cannot_answer_it_either() {
        screen.openRequestDecision("r1")
        now = 60_000L
        screen.bandTaken(v2 = false)
        now += 9_000L
        screen.noticeClosed(NexusNoticeCloseReason.TIMEOUT, band = {}, brief = {})
        now += 100L
        enter()
        assertTrue(decided.isEmpty())
    }

    @Test
    fun input_follows_the_card_on_screen_not_the_data_left_behind() {
        screen.openAlertDecision(alert)
        // The menu opens over it: the decision's data is gone with it, and ENTER is the menu's.
        screen.openMenu(ControlMenu.open("claude:s1"))
        assertEquals(ActiveCard.Kind.MENU, screen.kind)
        now = 60_000L
        enter()
        assertTrue(confirms.isEmpty())
        assertEquals(null, screen.decidingAlert)
    }
}
