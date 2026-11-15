package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.plugin.agents.GuidedPairingCopy

enum class ComputerOs(val label: String) { MAC_OS("macOS"), WINDOWS("Windows") }

/** One block of a screen: what it says, its one main action, and any secondary links. */
internal data class ScreenCopy(
    val title: String,
    val lines: List<String> = emptyList(),
    val action: String? = null,
    val links: List<String> = emptyList(),
)

/** Every word of the guided setup, so the tests hold the screens to the spec's copy. */
internal object OnboardingCopy {
    const val WELCOME_TITLE = "Rokid Coder"
    const val WELCOME_BODY =
        "Your Claude Code and Codex sessions on your Rokid glasses. Setup takes a few minutes: the phone, the glasses, then your computer."
    const val START = "Start"
    const val CONTINUE = "Continue"
    const val NOT_NOW = "Not now"

    const val PERMISSIONS_DONE_TITLE = "Permissions"
    const val PERMISSIONS_SOME_OFF = "Some features are off. You can grant them now or later in Settings."

    // GLASSES
    const val GLASSES_TITLE = "Connect your glasses"
    const val STARTING = "Starting Rokid Coder…"
    const val CONNECT_BODY = "Rokid Coder links to your glasses through the Hi Rokid app. It asks you to allow that once."
    const val CONNECT = "Connect glasses"
    const val CONNECTING = "Connecting to your glasses…"
    const val CONNECT_FAILED = "Couldn't connect to your glasses."
    const val RETRY = "Retry"
    const val NEXUS_PACKAGE = "com.anezium.rokidbus.phone"
    const val NEXUS_INSTALLED = "Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry."
    const val OPEN_NEXUS = "Open Rokid Nexus"
    const val APP_INFO = "App info"
    val NEXUS_ACTIONS = listOf(OPEN_NEXUS, APP_INFO, RETRY)

    // COMPUTER_CHECKLIST
    const val CHECKLIST_TITLE = "Which do you use?"

    // FINISH_ON_COMPUTER / PAIRING
    const val FINISH_TITLE = "Finish on your computer"
    const val DOWNLOAD_URL = "https://github.com/debasishdebs/Rokid-Coder/releases/latest"
    const val COPY = "Copy"
    const val SHARE = "Share"
    const val TIMES_UP = "Time's up — tap to try again"
    const val READY_TO_PAIR = "Ready to pair — tap to open the window"
    const val AWAY_FROM_HOME = "Use it away from home"
    const val TAILSCALE_LINK = "Set up Tailscale"
    const val SCAN_INSTEAD = "Scan the code on your computer instead"
    const val CODES_MATCH = "Codes match"
    const val CODES_DONT_MATCH = "Codes don't match"
    val SAS_ACTIONS = listOf(CODES_MATCH, CODES_DONT_MATCH)
    const val NOTHING_PAIRED = "Nothing was paired — tap to try again"

    // TEST_ALERT
    const val TEST_ALERT_TITLE = "Test alert"
    const val TEST_ALERT_BODY = "Look at your glasses: a test alert is on its way, with the sound you chose for Done."
    const val SAW_IT = "I saw it"
    const val DIDNT_SEE_IT = "I didn't see it"
    val TEST_ALERT_ACTIONS = listOf(SAW_IT, DIDNT_SEE_IT)
    const val TEST_ALERT_MISSED =
        "Check that the glasses are on and connected: open Settings → Glasses on this phone. You can send another test alert from there."

    // SOUNDS
    const val SOUNDS_TITLE = "Sounds"
    const val SOUNDS_BODY = "What the glasses do when each kind of alert arrives. You can change this later in Settings."
    const val FINISH = "Finish"

    fun installerHint(os: ComputerOs): List<String> = when (os) {
        ComputerOs.MAC_OS -> listOf("right-click → Open")
        ComputerOs.WINDOWS -> listOf("More info → Run anyway", "Windows needs WSL 2 — the installer checks it for you")
    }

    /** What the download screen says for the tools the user has. */
    fun finishOnComputerLines(choice: ComputerChoice?): List<String> = buildList {
        add("Download and run the installer on your computer. It installs agentd, rk and the plugins, then pairs with this phone.")
        when (choice) {
            ComputerChoice.CLAUDE_CODE -> add("It adds the Rokid plugin to Claude Code.")
            ComputerChoice.CODEX -> add("It adds the Rokid plugin to Codex.")
            ComputerChoice.BOTH -> add("It adds the Rokid plugins to Claude Code and Codex.")
            ComputerChoice.NEITHER -> add("No Claude Code or Codex yet? rk claude and rk codex offer to install them later.")
            null -> Unit
        }
    }

    fun glassesApp(state: GlassesInstallState): ScreenCopy = when (state) {
        GlassesInstallState.Checking -> ScreenCopy("Glasses app", listOf("Checking the glasses app…"))
        GlassesInstallState.NotInstalled -> ScreenCopy("Glasses app", listOf("Rokid Coder Glasses is not on your glasses yet."), "Install on glasses")
        GlassesInstallState.UpdateAvailable -> ScreenCopy("Glasses app", listOf("A newer Rokid Coder Glasses comes with this app."), "Update glasses app")
        GlassesInstallState.UpToDate -> ScreenCopy("Glasses app", listOf("Rokid Coder Glasses is up to date ✓"))
        GlassesInstallState.NewerOnGlasses -> ScreenCopy(
            "Glasses app",
            listOf("Your glasses have a newer Rokid Coder Glasses than this phone app. It is left as it is; update the phone app to match."),
        )
        is GlassesInstallState.Installing -> ScreenCopy("Glasses app", listOf("Installing on your glasses… ${state.progress}%"))
        is GlassesInstallState.Failed -> ScreenCopy("Glasses app", listOf("The install did not finish.", state.reason), RETRY)
    }

    fun pairing(view: PairingView): ScreenCopy {
        val fallback = if (view.offerFallback) listOf(TAILSCALE_LINK, SCAN_INSTEAD) else listOf(AWAY_FROM_HOME)
        return when (view.phase) {
            PairingPhase.READY -> ScreenCopy(FINISH_TITLE, action = READY_TO_PAIR, links = fallback)
            PairingPhase.WINDOW_OPEN -> ScreenCopy(
                FINISH_TITLE,
                listOf("Waiting for your computer… ${GuidedPairingCopy.countdown(view.remainingMs)}"),
                links = fallback,
            )
            PairingPhase.SAS -> ScreenCopy(
                "Does your computer show ${view.code.orEmpty().take(3)} ${view.code.orEmpty().drop(3)}?",
                listOf(GuidedPairingCopy.COMPARE),
            )
            PairingPhase.FINISHING -> ScreenCopy(FINISH_TITLE, listOf("Codes match ✓ — finishing the secure link…"))
            PairingPhase.ABORTED -> ScreenCopy(
                FINISH_TITLE,
                listOf(
                    if (view.mismatch) "The codes didn't match, so nothing was paired." else
                        "The pairing stopped before it finished: the codes differed on the computer, another device tried to pair, or the connection dropped.",
                ),
                action = NOTHING_PAIRED,
                links = fallback,
            )
            PairingPhase.EXPIRED -> ScreenCopy(FINISH_TITLE, action = TIMES_UP, links = fallback)
            PairingPhase.PAIRED -> ScreenCopy(GuidedPairingCopy.paired(view.pairedName.orEmpty()), action = CONTINUE)
        }
    }
}
