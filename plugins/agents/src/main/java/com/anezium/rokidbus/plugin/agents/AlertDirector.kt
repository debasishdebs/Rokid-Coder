package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate

/** The glasses side of the alerts: implemented by the plugin service, which owns the bus client. */
interface AlertGlasses {
    /** True when the hub took the band. */
    fun showBand(notice: NexusNotice): Boolean

    /** True when the band for the current alert took the refresh. */
    fun updateBand(update: NexusNoticeUpdate): Boolean
    fun hideBand()
    fun brief(title: String, body: String)

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
 * the coordinator; a close that belongs to a band of its own it just replaced
 * is not the new band's.
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
    private var ignoreReplacedUntil = 0L
    private var boardKeys: Set<String> = emptySet()

    fun onEvent(event: AgentdEvent) = post {
        when (event) {
            is AgentdEvent.LinkUp -> {
                ignoreReplacedUntil = 0L
                apply(coordinator.onLinkUp())
            }
            is AgentdEvent.LinkDown -> apply(coordinator.onLinkDown())
            is AgentdEvent.Action -> when (val action = event.action) {
                is AgentdAction.Alert -> apply(coordinator.onAlert(action))
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
        // This plugin's own hide, or a band it replaced: the coordinator already moved on.
        if (reason == NexusNoticeCloseReason.OWNER) return@post
        if (reason == NexusNoticeCloseReason.REPLACED && clock() < ignoreReplacedUntil) {
            ignoreReplacedUntil = 0L
            return@post
        }
        bandId = null
        apply(coordinator.onBandClosed(id, reason))
    }

    /** A confirm from a decision or question card bound to [alertId]. */
    fun onCardConfirm(alertId: String, action: String) = post {
        apply(coordinator.onCardConfirm(alertId, action, secure()))
    }

    private fun apply(effects: List<AlertCoordinator.Effect>) {
        for (effect in effects) {
            when (effect) {
                is AlertCoordinator.Effect.Show -> showBand(effect.alert, effect.wake)
                is AlertCoordinator.Effect.Update -> updateBand(effect.alert)
                AlertCoordinator.Effect.Hide -> {
                    bandId = null
                    glasses()?.hideBand()
                }
                is AlertCoordinator.Effect.Send -> write(effect.line)
                is AlertCoordinator.Effect.Brief -> glasses()?.brief(effect.title, effect.body)
                is AlertCoordinator.Effect.Invalidate -> glasses()?.invalidate(effect.alertId)
                is AlertCoordinator.Effect.OpenDecision -> glasses()?.openDecision(effect.alert)
                is AlertCoordinator.Effect.OpenQuestion -> glasses()?.openQuestion(effect.alert)
            }
        }
    }

    private fun showBand(alert: AgentdAction.Alert, wake: Boolean) {
        val replacing = bandId != null
        val taken = glasses()?.showBand(AlertNotices.build(alert, monitorOnly = !secure(), wake = wake)) == true
        if (!taken) {
            // No band is up for this alert, so the coordinator must not refresh one;
            // agentd's next retry shows it again.
            bandId = null
            apply(coordinator.onBandClosed(alert.id, NexusNoticeCloseReason.DISCONNECT))
            return
        }
        bandId = alert.id
        // A hub that still reports the replaced band's close does so a moment later.
        if (replacing) ignoreReplacedUntil = clock() + REPLACED_GRACE_MS
    }

    private fun updateBand(alert: AgentdAction.Alert) {
        val refreshed = bandId == alert.id &&
            glasses()?.updateBand(AlertNotices.update(alert, monitorOnly = !secure())) == true
        // A band that is gone or overwritten is shown again, without waking anyone.
        if (!refreshed) showBand(alert, wake = false)
    }

    private companion object {
        const val REPLACED_GRACE_MS = 2_000L
    }
}
