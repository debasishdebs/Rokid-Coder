package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusRowTone

/**
 * The glasses' side of guided pairing: the Pair a computer row's tap arms the phone's door, the
 * card counts it down, and the attempt ends with a brief. It owns no timer: the service calls
 * [tick] once a second while [active], and [sync] whenever the shared [GuidedPairing] moves.
 */
internal class GlassesPairingCard(
    private val pairing: GuidedPairing,
    private val clock: () -> Long,
    private val host: Host,
    /** The SAS attempt the card shows the code of, and confirms through the phone (6a-R5). */
    private val attempts: PairingAttemptsModel = PairingAttempts,
) {
    interface Host {
        fun snapshot(): PairingSnapshot

        /** Opens the phone's link window and makes sure monitoring listens for it. */
        fun armWindow()
        fun cancelWindow()
        fun openCard()
        fun closeCard()
        fun onScreen(): Boolean
        fun render()
        fun brief(title: String, body: String)
    }

    /** True from the tap until the attempt ends, is cancelled, or the glasses surface goes away. */
    var active = false
        private set

    fun start() {
        val snapshot = host.snapshot()
        host.armWindow()
        pairing.start(snapshot.baseline, snapshot.repairing)
        active = true
        host.openCard()
        host.render()
    }

    /**
     * A tap on the card: the wearer compared the code on the glasses with the computer's and it
     * matches. False when there is no code to confirm yet.
     */
    fun confirm(): Boolean {
        val view = awaiting() ?: return false
        attempts.confirm(view.attempt, true)
        return true
    }

    private fun awaiting(): AttemptView? = attempts.state.value?.takeIf { it.state == AttemptState.AWAITING_CONFIRM }

    /** BACK on the card: the door shuts, and nothing more is said. */
    fun cancel() {
        if (!active) return
        // A code on screen is declined, so the computer's side ends too.
        awaiting()?.let { attempts.confirm(it.attempt, false) }
        active = false
        host.cancelWindow()
        pairing.cancel()
        if (host.onScreen()) host.closeCard()
        host.render()
    }

    /** The glasses surface closed: the attempt goes on at the phone, but this card has nobody to tell. */
    fun detach() {
        active = false
    }

    fun tick() {
        if (!active) return
        pairing.tick(clock())
        sync()
    }

    /** Draws a moved state, or ends the card with its brief. */
    fun sync() {
        if (!active) return
        when (val state = pairing.state.value) {
            is GuidedPairing.State.DoorOpen -> if (host.onScreen()) host.render()
            is GuidedPairing.State.Paired -> finish(GuidedPairingCopy.paired(state.name.fitBrief()))
            GuidedPairing.State.TimedOut -> finish(GuidedPairingCopy.GLASSES_TIMED_OUT)
            // Cancelled from the phone.
            GuidedPairing.State.Idle -> finish(null)
        }
    }

    private fun finish(brief: String?) {
        active = false
        if (host.onScreen()) host.closeCard()
        brief?.let { host.brief(it, "") }
        host.render()
    }

    /** A brief's title holds 32 characters: a long computer name is cut so the check mark survives. */
    private fun String.fitBrief(): String = if (length > BRIEF_NAME_CHARS) take(BRIEF_NAME_CHARS - 1) + "…" else this

    fun card(): NexusCard {
        awaiting()?.code?.let { code ->
            return BoardCards.card(
                title = "Code ${code.take(3)} ${code.drop(3)}",
                subtitle = "pair ${awaiting()?.peerName.orEmpty()}".trim(),
                rows = listOf(NexusCardLine(text = GuidedPairingCopy.GLASSES_COMPARE, tone = NexusRowTone.BODY)),
                footer = "Tap to confirm · Back to cancel",
            )
        }
        val remaining = (pairing.state.value as? GuidedPairing.State.DoorOpen)?.remainingMs ?: 0L
        return BoardCards.card(
            title = "Pairing · ${GuidedPairingCopy.countdown(remaining)}",
            subtitle = "door open",
            rows = listOf(NexusCardLine(text = GuidedPairingCopy.GLASSES_BODY, tone = NexusRowTone.BODY)),
            footer = "2-tap cancel",
        )
    }

    private companion object {
        /** 32 for the title, less "Paired with " and " ✓". */
        const val BRIEF_NAME_CHARS = 17
    }
}
