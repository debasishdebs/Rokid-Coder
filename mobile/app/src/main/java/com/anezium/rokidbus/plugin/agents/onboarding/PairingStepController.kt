package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.plugin.agents.AttemptState
import com.anezium.rokidbus.plugin.agents.AttemptView
import com.anezium.rokidbus.plugin.agents.LinkKey
import com.anezium.rokidbus.plugin.agents.PairingAttemptsModel
import com.anezium.rokidbus.plugin.agents.SecureLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * How a `pair-ready` announcement opens onboarding's window (§13.5). The link server asks it only
 * while the window is shut, and only after 6a's pair-ready gate (a pairing screen open, once per
 * attempt, one window per 30 s) let the announcement through. Set only while the onboarding
 * pairing screen is started; Add a computer never sets it.
 */
object PairReadyWindow {
    @Volatile var opener: (() -> Boolean)? = null
}

/** The pairing window and what the phone holds, as the pairing screen needs them. */
internal interface PairingDoor {
    /** The machine ids the transports announce for every computer the phone holds now. */
    fun baselineNow(): Set<String>

    /** Monitoring on, so a pair-ready announcement can be heard. It opens no window. */
    fun listen()

    /** `openGuidedDoor`: a fresh two-minute window. */
    fun open()
    fun cancel()
    fun remainingMs(): Long
}

enum class PairingPhase { READY, WINDOW_OPEN, SAS, FINISHING, ABORTED, EXPIRED, PAIRED }

internal data class PairingView(
    val phase: PairingPhase,
    val remainingMs: Long = 0L,
    /** The exact attempt whose code this view shows: what its Confirm and Cancel answer. */
    val attempt: AttemptView? = null,
    val pairedName: String? = null,
    /** The Tailscale connector and the scan-the-code fallback are on offer. */
    val offerFallback: Boolean = false,
    /** The wearer said the codes differ. */
    val mismatch: Boolean = false,
) {
    val code: String? get() = attempt?.code
}

/** The first secure link to a computer outside [baseline], from either path: what LAPTOP_DONE waits for. */
internal fun laptopDoneLink(links: Map<LinkKey, SecureLink>, baseline: Set<String>): SecureLink? =
    links.entries.sortedBy { it.key.connectionId }.firstOrNull { it.value.machineId !in baseline }?.value

/**
 * FINISH_ON_COMPUTER and PAIRING, one screen with two states, and LAPTOP_DONE. The window opens
 * only on a pair-ready announcement or the "Ready to pair" tap; the SAS code is only shown and
 * forwarded, confirmed by the wearer's tap here. LAPTOP_DONE reads the current secure links
 * against a baseline persisted before either path could start, so a crash anywhere still ends
 * in it on that computer's next authenticated link.
 */
internal class PairingStepController(
    private val store: OnboardingStore,
    private val door: PairingDoor,
    private val attempts: PairingAttemptsModel,
    private val links: StateFlow<Map<LinkKey, SecureLink>>,
    private val scope: CoroutineScope,
) {
    private val _view = MutableStateFlow(PairingView(PairingPhase.READY))
    val view: StateFlow<PairingView> = _view.asStateFlow()

    // Main thread, and the discovery thread through the pair-ready opener.
    @Volatile private var baseline: Set<String> = emptySet()
    @Volatile private var windowOpened = false
    @Volatile private var peerSeen = false
    @Volatile private var fallback = false
    @Volatile private var saidMismatch = false
    @Volatile private var stale: AttemptView? = null

    fun enter() {
        baseline = store.recordPairingBaseline(door.baselineNow())
        // A window never outlives the process that opened it.
        door.cancel()
        door.listen()
        stale = attempts.state.value
        scope.launch { links.collect { check(it) } }
        scope.launch { attempts.state.collect(::onAttempt) }
    }

    /** The screen is started: 6a's pairing-screen hook, and the pair-ready opener. */
    fun onScreenStarted() {
        attempts.pairingScreenOpen = true
        // Called on the link server's discovery thread, before it dials: the window is armed by the
        // time the computer's commitment arrives.
        PairReadyWindow.opener = {
            openWindow()
            door.remainingMs() > 0L
        }
    }

    fun onScreenStopped() {
        attempts.pairingScreenOpen = false
        PairReadyWindow.opener = null
    }

    /** The "Ready to pair" tap, a retry, or a pair-ready announcement. */
    @Synchronized
    fun openWindow() {
        if (_view.value.phase == PairingPhase.PAIRED) return
        door.open()
        store.complete(OnboardingStep.FINISH_ON_COMPUTER)
        windowOpened = true
        peerSeen = false
        saidMismatch = false
        stale = attempts.state.value
        publish(PairingView(PairingPhase.WINDOW_OPEN, door.remainingMs(), offerFallback = fallback))
    }

    /** "Use it away from home": the Tailscale connector and the scan fallback. */
    fun awayFromHome() {
        fallback = true
        publish(_view.value.copy(offerFallback = true))
    }

    /**
     * The wearer's answer to [shown], the attempt the tapped screen drew, from a touch here only.
     * False, and nothing sent, once another attempt or code has taken its place, even if the
     * screen has not redrawn yet.
     */
    fun confirm(shown: AttemptView?, match: Boolean): Boolean {
        if (shown == null || shown.state != AttemptState.AWAITING_CONFIRM) return false
        val before = saidMismatch
        // Set first: the abort a mismatch causes is published before attempts.confirm returns.
        if (!match) saidMismatch = true
        return attempts.confirm(shown, match).also { if (!it) saidMismatch = before }
    }

    /** Once a second while the screen is up. */
    fun tick() {
        val now = _view.value
        if (now.phase != PairingPhase.WINDOW_OPEN) return
        val remaining = door.remainingMs()
        if (remaining > 0L) return publish(now.copy(remainingMs = remaining))
        if (attemptInProgress()) return
        windowOpened = false
        publish(PairingView(PairingPhase.EXPIRED, offerFallback = fallback || !peerSeen))
    }

    private fun attemptInProgress(): Boolean {
        val view = attempts.state.value?.takeIf { it != stale } ?: return false
        return view.state != AttemptState.ABORTED
    }

    private fun onAttempt(view: AttemptView?) {
        if (_view.value.phase == PairingPhase.PAIRED || view == null || view == stale || !windowOpened) return
        peerSeen = true
        when (view.state) {
            AttemptState.AWAITING_CONFIRM -> publish(PairingView(PairingPhase.SAS, attempt = view))
            AttemptState.PINNED -> publish(PairingView(PairingPhase.FINISHING))
            AttemptState.ABORTED -> {
                windowOpened = false
                door.cancel()
                publish(PairingView(PairingPhase.ABORTED, mismatch = saidMismatch, offerFallback = fallback))
            }
            else -> publish(PairingView(PairingPhase.WINDOW_OPEN, door.remainingMs(), offerFallback = fallback))
        }
    }

    private fun check(current: Map<LinkKey, SecureLink>) {
        if (_view.value.phase == PairingPhase.PAIRED) return
        val link = laptopDoneLink(current, baseline) ?: return
        store.complete(OnboardingStep.FINISH_ON_COMPUTER, OnboardingStep.PAIRING, OnboardingStep.LAPTOP_DONE)
        windowOpened = false
        publish(PairingView(PairingPhase.PAIRED, pairedName = link.name))
    }

    private fun publish(view: PairingView) {
        _view.value = view
    }
}
