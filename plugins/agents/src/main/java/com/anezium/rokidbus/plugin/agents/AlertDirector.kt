package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The glasses side of the alerts: implemented by the plugin service, which owns the bus client. */
interface AlertGlasses {
    /** True when the hub took the band. */
    fun showBand(notice: NexusNotice): Boolean

    /** True when the band for the current alert took the refresh. */
    fun updateBand(update: NexusNoticeUpdate): Boolean
    fun hideBand()
    fun brief(title: String, body: String)

    /** Nothing of the alerts' is on the band slot any more: a deferred v1 attention may take it. */
    fun slotFree() = Unit

    /** A Done or error band was tapped: open the output reader, summary first. */
    fun openOutput(alert: AgentdAction.Alert)
    fun openDecision(alert: AgentdAction.Alert)
    fun openQuestion(alert: AgentdAction.Alert)

    /** The decision or question card bound to [alertId] answers nothing any more. */
    fun invalidate(alertId: String)
}

/**
 * Owns the one [AlertCoordinator] (R72) and is the only thing that calls it:
 * everything arrives through [post], which runs the work one piece at a time,
 * in order, so the coordinator is never touched from two threads. Its effects
 * are applied to the glasses, and `Send` lines go to agentd through the wire,
 * which classifies each one by its type.
 *
 * It keeps what the SDK does not tell it. A notice close carries no identity, so
 * the director remembers which alert's band it put up last and passes that id to
 * the coordinator. It also owns the band slot: a brief message never replaces an
 * alert band that is up.
 */
class AlertDirector(
    private val coordinator: AlertCoordinator,
    private val write: (String) -> Unit,
    private val secure: () -> Boolean,
    private val glasses: () -> AlertGlasses?,
    private val post: (() -> Unit) -> Unit,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /** The alert whose band the director put up and has not seen end. Only [post]ed work touches it. */
    private var bandId: String? = null

    /** An alert whose band the hub took from us (REPLACED) or timed out: its next frame re-shows it. */
    private var goneId: String? = null

    /**
     * Briefs wait here while an alert band is up or an earlier brief is on screen:
     * a brief never replaces either (R94, R100). They show one at a time, oldest first.
     */
    private class Brief(val title: String, val body: String, val safety: Boolean)

    private val briefs = ArrayDeque<Brief>()
    private var briefShownAt: Long? = null
    private var busy = false

    /** True while an alert band, a brief or a queued brief holds the slot. Read where [post]ed work runs. */
    val slotBusy: Boolean get() = bandId != null || briefOnScreen() || briefs.isNotEmpty()
    private var boardKeys: Set<String> = emptySet()

    private val _waiting = MutableStateFlow(0)

    /** The current alert's `+N waiting`, for the board's own row; it follows the coordinator after every change. */
    val waiting: StateFlow<Int> = _waiting.asStateFlow()

    fun onEvent(event: AgentdEvent) = post {
        when (event) {
            is AgentdEvent.LinkUp -> {
                goneId = null
                apply(coordinator.onLinkUp())
            }
            is AgentdEvent.LinkDown -> apply(coordinator.onLinkDown())
            is AgentdEvent.Action -> when (val action = event.action) {
                is AgentdAction.Alert -> apply(coordinator.onAlert(reshowIfGone(action)))
                is AgentdAction.AlertClosed -> apply(coordinator.onAlertClosed(action.id, action.reason))
                is AgentdAction.FollowupClosed -> apply(coordinator.invalidateSession(action.sessionKey))
                else -> Unit
            }
        }
    }

    /** The sessions on the board now; one that left takes its bound cards with it. */
    fun onBoard(keys: Set<String>) = post {
        val gone = boardKeys - keys
        boardKeys = keys
        gone.forEach { apply(coordinator.invalidateSession(it)) }
    }

    /** A press on the band's action row. Between LinkDown and LinkUp the link is not secure, so nothing steers. */
    fun onBandAction(action: String) = post {
        val id = bandId ?: return@post
        apply(coordinator.onAction(id, action, secure()))
    }

    /** The single confirm of an interactive band: display evidence, and for Done or error the reader. */
    fun onBandInput() = post {
        val id = bandId ?: return@post
        val alert = coordinator.current?.takeIf { it.id == id } ?: return@post
        apply(coordinator.onShownEvidence(id))
        if (alert.kind == AlertKind.DONE || alert.kind == AlertKind.ERROR) glasses()?.openOutput(alert)
    }

    fun onBandClosed(reason: NexusNoticeCloseReason) = post {
        val id = bandId ?: return@post
        // This plugin's own hide: the coordinator already moved on.
        if (reason == NexusNoticeCloseReason.OWNER) return@post
        bandId = null
        // Another plugin took the band, or it ran out: either way no band of ours is
        // up, and the next frame for this alert must show it again (R93).
        goneId = id.takeIf {
            reason == NexusNoticeCloseReason.REPLACED || reason == NexusNoticeCloseReason.TIMEOUT
        }
        apply(coordinator.onBandClosed(id, reason))
    }

    /**
     * A message for the wearer that is not an alert. It waits while an alert band
     * is up or an earlier brief is showing. The queue holds [MAX_BRIEFS], the same
     * text only once. A full queue drops its oldest ordinary brief; a safety brief
     * (a refused change, a monitor-only refusal, a mode switched off) is never
     * dropped, and if only safety briefs fill it they merge into one band of lines.
     */
    fun onBrief(title: String, body: String) = post {
        enqueue(Brief(title, body, isSafety(title, body)))
        settle()
    }

    /** The band a brief was shown on is gone: its turn is over, the next one may show. */
    fun onBriefClosed() = post {
        briefShownAt = null
        settle()
    }

    /** A confirm from a decision or question card bound to [alertId]. */
    fun onCardConfirm(alertId: String, action: String) = post {
        apply(coordinator.onCardConfirm(alertId, action, secure()))
    }

    /** The answers from the question card bound to [alertId]; the coordinator builds the frame and gates it. */
    fun onQuestionConfirm(alertId: String, answers: Map<String, Any>) = post {
        apply(coordinator.onQuestionConfirm(alertId, answers, secure()))
    }

    private fun apply(effects: List<AlertCoordinator.Effect>) {
        applyEffects(effects)
        _waiting.value = coordinator.current?.waiting ?: 0
        settle()
    }

    /** Shows the next brief when the slot is free, and says so once it has emptied. */
    private fun settle() {
        if (bandId == null && !briefOnScreen()) {
            val next = briefs.removeFirstOrNull()
            if (next != null && glasses()?.also { it.brief(next.title, next.body) } != null) {
                briefShownAt = clock()
            }
        }
        val nowBusy = slotBusy
        if (busy && !nowBusy) glasses()?.slotFree()
        busy = nowBusy
    }

    /** A brief's band closes on its own deadline; a lost close must not stall the queue behind it. */
    private fun briefOnScreen(): Boolean {
        val at = briefShownAt ?: return false
        if (clock() - at > BRIEF_STALE_MS) {
            briefShownAt = null
            return false
        }
        return true
    }

    private fun enqueue(brief: Brief) {
        if (briefs.any { it.title == brief.title && it.body == brief.body }) return
        if (briefs.size >= MAX_BRIEFS) {
            val ordinary = briefs.indexOfFirst { !it.safety }
            if (ordinary >= 0) {
                briefs.removeAt(ordinary)
            } else {
                // Every slot holds a safety brief: one band carries them all.
                val merged = Brief(
                    title = briefs.first().title,
                    body = briefs.joinToString("\n") { line(it) },
                    safety = true,
                )
                briefs.clear()
                briefs.addLast(merged)
            }
        }
        briefs.addLast(brief)
    }

    private fun line(brief: Brief): String = when {
        brief.body.isBlank() -> brief.title
        brief.title.isBlank() -> brief.body
        else -> "${brief.title} — ${brief.body}"
    }

    private fun isSafety(title: String, body: String): Boolean =
        SAFETY_PREFIXES.any { title.startsWith(it) || body.startsWith(it) }

    private fun applyEffects(effects: List<AlertCoordinator.Effect>) {
        for (effect in effects) {
            when (effect) {
                is AlertCoordinator.Effect.Show -> showBand(effect.alert, effect.wake)
                is AlertCoordinator.Effect.Update -> updateBand(effect.alert)
                AlertCoordinator.Effect.Hide -> {
                    bandId = null
                    goneId = null
                    glasses()?.hideBand()
                }
                is AlertCoordinator.Effect.Send -> write(effect.line)
                is AlertCoordinator.Effect.Brief -> onBrief(effect.title, effect.body)
                is AlertCoordinator.Effect.Invalidate -> glasses()?.invalidate(effect.alertId)
                is AlertCoordinator.Effect.OpenDecision -> glasses()?.openDecision(effect.alert)
                is AlertCoordinator.Effect.OpenQuestion -> glasses()?.openQuestion(effect.alert)
            }
        }
    }

    private fun showBand(alert: AgentdAction.Alert, wake: Boolean) {
        val taken = glasses()?.showBand(AlertNotices.build(alert, monitorOnly = !secure(), wake = wake)) == true
        if (!taken) {
            // No band is up for this alert, so the coordinator must not refresh one;
            // agentd's next retry shows it again.
            bandId = null
            apply(coordinator.onBandClosed(alert.id, NexusNoticeCloseReason.DISCONNECT))
            return
        }
        bandId = alert.id
        goneId = null
        // The alert took the slot from whatever brief was on it.
        briefShownAt = null
    }

    /**
     * A frame for an alert whose band was taken or timed out is a retry of it,
     * whatever agentd called it: the coordinator ignores an update for a band that
     * is not up, and the wearer would never see the alert again.
     */
    private fun reshowIfGone(alert: AgentdAction.Alert): AgentdAction.Alert =
        if (alert.id == goneId && alert.reason == AlertReason.UPDATE) {
            alert.copy(reason = AlertReason.RETRY)
        } else {
            alert
        }

    private fun updateBand(alert: AgentdAction.Alert) {
        val refreshed = bandId == alert.id &&
            glasses()?.updateBand(AlertNotices.update(alert, monitorOnly = !secure())) == true
        // A band that is gone or overwritten is shown again, without waking anyone.
        if (!refreshed) showBand(alert, wake = false)
    }

    private companion object {
        const val MAX_BRIEFS = 4

        /** A brief's own ttl is 8 s; past this a missing close is assumed lost. */
        const val BRIEF_STALE_MS = 10_000L

        val SAFETY_PREFIXES = listOf("Not applied", "Monitor only", "Approve-all off", "Accept edits off")
    }
}
