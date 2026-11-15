package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.plugin.agents.service.CoderRuntime
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One guided pairing attempt, shared by the phone's Add a computer screen and the glasses'
 * Pair a computer card: the door open for [LINK_WINDOW_DURATION_MS], waiting for a computer
 * that is this attempt's doing.
 *
 * Pure state over an injected [clock] (the same monotonic clock that stamps the connections),
 * so no test sleeps. The success rule keeps a bystander from completing it: only a connection
 * that this attempt can account for ends it as paired. That is a machine the phone did not hold
 * when the attempt started, or one that was signed out or refused then and has now connected
 * securely since the start. A computer that was already trusted and connected, reconnecting
 * during the window, is not the answer.
 */
class GuidedPairing(
    private val clock: () -> Long,
    private val windowMs: Long = LINK_WINDOW_DURATION_MS,
) {
    sealed interface State {
        data object Idle : State
        data class DoorOpen(val remainingMs: Long) : State
        data class Paired(val name: String) : State
        data object TimedOut : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private var startMs = 0L
    private var deadlineMs = 0L
    private var baseline: Set<String> = emptySet()
    private var repairing: Set<String> = emptySet()

    /**
     * Opens an attempt. [baselineMachineIds] is every computer the phone holds right now;
     * [repairingMachineIds] the ones among them that were signed out or refused, which finish the
     * attempt by connecting securely again.
     */
    @Synchronized
    fun start(baselineMachineIds: Set<String>, repairingMachineIds: Set<String> = emptySet()) {
        startMs = clock()
        deadlineMs = startMs + windowMs
        baseline = baselineMachineIds
        repairing = repairingMachineIds
        _state.value = State.DoorOpen(windowMs)
    }

    @Synchronized
    fun cancel() {
        _state.value = State.Idle
    }

    /** Whoever showed a finished attempt has shown it: back to idle. An open attempt stays open. */
    @Synchronized
    fun acknowledge() {
        if (_state.value is State.Paired || _state.value == State.TimedOut) _state.value = State.Idle
    }

    @Synchronized
    fun tick(now: Long) {
        if (_state.value !is State.DoorOpen) return
        val remaining = deadlineMs - now
        _state.value = if (remaining <= 0L) State.TimedOut else State.DoorOpen(remaining)
    }

    /** A computer bound a secure link at [atMs], on the clock that [start] reads. */
    @Synchronized
    fun onSecureConnected(machineId: String, name: String, atMs: Long) {
        if (_state.value !is State.DoorOpen) return
        if (atMs < startMs || atMs > deadlineMs) return
        val attributable = machineId !in baseline || machineId in repairing
        if (attributable) _state.value = State.Paired(name)
    }

    companion object {
        /**
         * A computer this phone dials (the outbound slot) is known by its pin, not its name: the
         * wire gives no machine id, and the saved label and the name it announces can differ.
         */
        fun dialledId(fp: String): String = "dialled:$fp"
    }
}

/** What the phone knows of its computers when an attempt starts, and whether one is needed at all. */
internal class PairingSnapshot(
    val baseline: Set<String>,
    val repairing: Set<String>,
    /** No computer, one signed out, or one refused: the places that offer Pair a computer. */
    val needed: Boolean,
)

internal fun pairingSnapshot(
    machines: List<TrustedMachine>,
    agentd: AgentdConfig?,
    signedOut: List<SignedOut>,
    needsRepair: Boolean,
): PairingSnapshot {
    val dialled = agentd?.takeIf { it.configured }
    // A slot saved before pins existed has none, and is never dialled; a signed-out slot lost its pin.
    // Neither is in the baseline, so a connection from either is a new one.
    val baseline = buildSet {
        machines.forEach { add(it.machineId) }
        dialled?.fp?.let { add(GuidedPairing.dialledId(it)) }
    }
    val repairing = buildSet {
        if (needsRepair) dialled?.fp?.let { add(GuidedPairing.dialledId(it)) }
    }
    val needed = (machines.isEmpty() && dialled == null) || signedOut.isNotEmpty() || needsRepair
    return PairingSnapshot(baseline, repairing, needed)
}

/**
 * Opens the door for a guided attempt, from the phone or the glasses: adding a computer is an
 * explicit request to monitor, so monitoring is turned on; the window is armed; and [reconcile]
 * makes the monitor listen for it.
 */
internal fun openGuidedDoor(store: AgentsConfigStore, reconcile: () -> Unit = CoderRuntime::reconcile) {
    if (!store.load().agentdEnabled) store.setAgentdEnabled(true)
    store.armLinkWindow()
    reconcile()
}

/**
 * Whether the inbound link server runs. Normally it listens when nothing is dialled; while the
 * window is open it listens even beside an outbound slot, so the door always has a listener.
 */
internal fun inboundListenerWanted(agentdEnabled: Boolean, outboundSlot: Boolean, windowOpen: Boolean): Boolean =
    agentdEnabled && (!outboundSlot || windowOpen)

internal enum class ListenerPlan {
    /** Listen, nothing dialled: the normal rule. */
    RUN_ALONE,

    /** Listen beside a dialled slot, for a guided attempt's window. */
    RUN_BESIDE,

    /** The window is over, but a computer paired through it is still bound: keep listening until its link ends. */
    KEEP_BESIDE,
    STOP,
}

/**
 * What the monitor does with the inbound listener. The window only governs admission of new machines
 * (authorizeMachine enforces that), so a link bound through it outlives it: [besideMode] is the
 * listener having been opened for a window beside a slot, and [boundLink] a bound, authenticated link on it.
 */
internal fun inboundListenerPlan(
    agentdEnabled: Boolean,
    outboundSlot: Boolean,
    windowOpen: Boolean,
    besideMode: Boolean,
    boundLink: Boolean,
): ListenerPlan = when {
    inboundListenerWanted(agentdEnabled, outboundSlot, windowOpen) ->
        if (outboundSlot) ListenerPlan.RUN_BESIDE else ListenerPlan.RUN_ALONE
    agentdEnabled && outboundSlot && besideMode && boundLink -> ListenerPlan.KEEP_BESIDE
    else -> ListenerPlan.STOP
}

/** The words of guided pairing, one place for the phone and the glasses. */
internal object GuidedPairingCopy {
    const val STEP_ONE =
        "1 · On your computer: run rk claude (it offers to pair), or type /rokid:pair in Claude, or run agentd pair."
    const val STEP_TWO = "2 · Open the door for two minutes"
    const val OTHER_WAYS = "Other ways"
    const val GLASSES_BODY = "On your computer: type /rokid:pair in Claude, or run agentd pair"
    const val GLASSES_TIMED_OUT = "Time's up — try again"

    /** The code check, on every screen that shows it: the human compares, then confirms here. */
    const val COMPARE = "Check that your computer shows this same code, then confirm. Cancel if it differs."
    const val GLASSES_COMPARE = "Same code on your computer? Tap to confirm"

    /** The status line under the steps; null while there is nothing to say. */
    fun status(state: GuidedPairing.State): String? = when (state) {
        GuidedPairing.State.Idle -> null
        is GuidedPairing.State.DoorOpen -> "Waiting for your computer…"
        is GuidedPairing.State.Paired -> paired(state.name)
        GuidedPairing.State.TimedOut -> "Time's up — tap 2 to try again"
    }

    fun paired(name: String): String = "Paired with $name ✓"

    /** m:ss, rounded up so a full window reads 2:00 and the last second reads 0:01. */
    fun countdown(remainingMs: Long): String {
        val seconds = ((remainingMs.coerceAtLeast(0L) + 999L) / 1000L)
        return "%d:%02d".format(seconds / 60L, seconds % 60L)
    }

    fun doorOpen(remainingMs: Long): String = "DOOR OPEN · ${countdown(remainingMs)}"
}
