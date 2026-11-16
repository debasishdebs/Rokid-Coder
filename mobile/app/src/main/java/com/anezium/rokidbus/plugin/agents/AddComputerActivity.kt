package com.anezium.rokidbus.plugin.agents

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.os.Bundle
import android.os.SystemClock
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.anezium.rokidbus.client.ui.BusTheme
import com.anezium.rokidbus.client.ui.NexusUi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import com.anezium.rokidbus.plugin.agents.service.CoderRuntime

/**
 * The roads to a linked computer. A phone with no computer, or with one signed out or
 * refused, opens on a guided section: run one command on the computer, open the door, watch
 * it say Paired. Below it, as equals under "Other ways": automatic on the home Wi-Fi,
 * Tailscale for everywhere else, and the pairing line, scanned or pasted, for whoever wants neither.
 */
class AddComputerActivity : Activity() {
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var doorStatus: TextView
    private lateinit var doorDot: View
    private lateinit var guidedStatus: TextView
    private lateinit var doorOpen: Button
    /** The attempt whose code this screen shows: what its Confirm and Cancel answer. */
    private val shownAttempt = ShownAttempt()
    private lateinit var doorArmed: LinearLayout
    private lateinit var tailscaleStatus: TextView
    private lateinit var tailscaleDot: View
    private lateinit var tailscaleGet: Button
    private lateinit var pairingField: EditText
    private lateinit var pairingSummary: TextView
    private lateinit var codeCard: LinearLayout
    private lateinit var codeText: TextView
    private lateinit var codeStatus: TextView
    private var ticker: Job? = null
    private var knownMachines = 0
    private var guided = false
    private val pairing get() = AgentsRuntime.guidedPairing

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        knownMachines = configStore.trustedMachines().size
        // Guided when Settings asked for it, or when this phone has no computer, or one to pair again.
        guided = intent.getBooleanExtra(EXTRA_GUIDED, false) || currentPairing().needed
        // A finished attempt from before is not news on a screen opened now; an open one is.
        pairing.acknowledge()
        buildUi()
        // Only on the first creation: a rotation must not reopen a scan the user already left.
        if (savedInstanceState == null && intent.getBooleanExtra(EXTRA_SCAN, false)) scanPairingCode()
        uiScope.launch { pairing.state.collect(::renderDoorState) }
        uiScope.launch { PairingAttempts.state.collect(::renderAttempt) }
        uiScope.launch {
            AgentsRuntime.linkedMachines.collect { machineName ->
                // Replay hands us the last machine that ever linked; only a
                // growth in the trusted list means it happened just now.
                val count = configStore.trustedMachines().size
                if (count > knownMachines) {
                    knownMachines = count
                    toast("$machineName is linked.")
                }
            }
        }
    }

    override fun onPause() {
        PairingAttempts.pairingScreenOpen = false
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        // agentd's pair-ready announcements are acted on only while this screen is up.
        PairingAttempts.pairingScreenOpen = true
        pairing.tick(SystemClock.elapsedRealtime())
        renderDoorState(pairing.state.value)
        renderTailscaleState()
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }

    private fun buildUi() {
        window.statusBarColor = NexusUi.BG
        window.navigationBarColor = NexusUi.BG
        doorDot = NexusUi.dot(this)
        doorStatus = NexusUi.statusLine(this)
        guidedStatus = NexusUi.cardBody(this, "").apply { visibility = View.GONE }
        doorOpen = NexusUi.pillButton(this, if (guided) GuidedPairingCopy.STEP_TWO else "Open the door for two minutes").apply {
            setOnClickListener {
                val snapshot = currentPairing()
                pairing.start(snapshot.baseline, snapshot.repairing)
                openGuidedDoor(configStore) { CoderRuntime.fromActivity(this@AddComputerActivity) { reconcile() } }
            }
        }
        doorArmed = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            addView(connectionRow(this@AddComputerActivity, doorDot, doorStatus), NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 10))
            addView(
                NexusUi.outlinePillButton(this@AddComputerActivity, "Cancel").apply {
                    setOnClickListener {
                        configStore.cancelLinkWindow()
                        pairing.cancel()
                        // Back to the normal rule: the listener beside a dialled slot goes.
                        CoderRuntime.fromActivity(this@AddComputerActivity) { reconcile() }
                    }
                },
                NexusUi.block(),
            )
        }
        tailscaleDot = NexusUi.dot(this)
        tailscaleStatus = NexusUi.statusLine(this)
        tailscaleGet = NexusUi.textButton(this, "Get Tailscale for this phone").apply {
            setOnClickListener { openTailscaleInstall(this@AddComputerActivity) }
        }
        codeText = NexusUi.rowTitle(this, "").apply { setTextSize(TypedValue.COMPLEX_UNIT_SP, 34f) }
        codeStatus = NexusUi.cardBody(this, GuidedPairingCopy.COMPARE)
        codeCard = NexusUi.card(this).apply {
            visibility = View.GONE
            addView(NexusUi.rowTitle(this@AddComputerActivity, "Pairing code"), NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 6))
            addView(codeText, NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 6))
            addView(codeStatus, NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 12))
            // The phone's half of the confirmation: a human tap here, never anything from the network.
            addView(
                actionRow(
                    this@AddComputerActivity,
                    primary = "Confirm",
                    // Bound to the attempt whose code is on screen: a replacement is drawn before it can be confirmed.
                    onPrimary = { shownAttempt.confirm(true) },
                    secondary = "Cancel",
                    onSecondary = { shownAttempt.confirm(false) },
                ),
                NexusUi.block(),
            )
        }
        pairingField = NexusUi.field(this, "Paste the pairing line from agentd pair").apply {
            // The line holds no secret now, but it is still not a thing to learn or autofill.
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            typeface = Typeface.DEFAULT
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    renderPairingPreview(s?.toString().orEmpty())
                }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        pairingSummary = NexusUi.cardBody(this, "No daemon paired.")

        val content = NexusUi.contentColumn(this).apply {
            addView(codeCard, NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 14))
            if (guided) {
                addView(guidedCard(), NexusUi.block())
                addView(BusTheme.gap(this@AddComputerActivity, 20))
                addView(NexusUi.sectionLabel(this@AddComputerActivity, GuidedPairingCopy.OTHER_WAYS), NexusUi.block())
                addView(BusTheme.gap(this@AddComputerActivity, 10))
            }
            addView(daemonCard(), NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 14))
            addView(wifiCard(), NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 14))
            addView(tailscaleCard(), NexusUi.block())
            addView(BusTheme.gap(this@AddComputerActivity, 14))
            addView(pairingCard(), NexusUi.block())
        }
        val root = NexusUi.fixedRoot(this).apply {
            addView(backHeader(), NexusUi.block())
            addView(
                NexusUi.screen(this@AddComputerActivity, content),
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f),
            )
        }
        setContentView(root)
    }

    private fun backHeader() = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        val pad = NexusUi.dp(this@AddComputerActivity, 16)
        setPadding(pad, pad, pad, NexusUi.dp(this@AddComputerActivity, 8))
        addView(
            TextView(this@AddComputerActivity).apply {
                text = "‹"
                setTextColor(NexusUi.GREEN)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
                setPadding(0, 0, NexusUi.dp(this@AddComputerActivity, 14), NexusUi.dp(this@AddComputerActivity, 2))
                setOnClickListener { finish() }
            },
        )
        addView(
            TextView(this@AddComputerActivity).apply {
                text = "Add a computer"
                setTextColor(NexusUi.INK)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
                typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            },
        )
    }

    /** Step 1 is on the computer, step 2 is the door; the status line says what happened. */
    private fun guidedCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "Pair a computer"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(NexusUi.cardBody(this@AddComputerActivity, GuidedPairingCopy.STEP_ONE), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 12))
        addView(doorOpen, NexusUi.block())
        addView(doorArmed, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(guidedStatus, NexusUi.block())
    }

    /**
     * Every road below assumes the daemon exists on the computer, so the how
     * of getting it comes before any of them.
     */
    private fun daemonCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "First: nexus-agentd on the computer"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 6))
        addView(
            NexusUi.cardBody(
                this@AddComputerActivity,
                "nexus-agentd is the small program that watches Claude Code and " +
                    "Codex on the computer and talks to this phone. It ships with " +
                    "Rokid Nexus: on the computer, get the repository at " +
                    "github.com/Anezium/RokidNexus, and with Node 20 installed run, " +
                    "inside agentd/: “npm install”, “npm run build”, " +
                    "“node dist/cli.js install-hooks” once, then “node dist/cli.js " +
                    "run” to start it. Its README covers keeping it running at logon.",
            ),
            NexusUi.block(),
        )
    }

    private fun wifiCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "On your Wi-Fi — automatic"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 6))
        addView(
            NexusUi.cardBody(
                this@AddComputerActivity,
                "Run nexus-agentd on the computer, then open the door ${if (guided) "above" else "below"}. " +
                    "A computer this phone does not know yet, the first one " +
                    "included, can only get in while the door is open.",
            ),
            NexusUi.block(),
        )
        if (!guided) {
            addView(BusTheme.gap(this@AddComputerActivity, 12))
            addView(doorOpen, NexusUi.block())
            addView(doorArmed, NexusUi.block())
        }
    }

    private fun tailscaleCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "Anywhere — Tailscale"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(connectionRow(this@AddComputerActivity, tailscaleDot, tailscaleStatus), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(tailscaleGet, NexusUi.block())
        addView(
            NexusUi.cardBody(
                this@AddComputerActivity,
                "Install Tailscale on the computer — Windows and macOS from " +
                    "tailscale.com/download, Linux with " +
                    "“curl -fsSL https://tailscale.com/install.sh | sh” and then " +
                    "“sudo tailscale up” — and sign in with the same account as " +
                    "this phone. The computer then reaches this phone from any network.",
            ),
            NexusUi.block(),
        )
    }

    private fun pairingCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "QR code or pairing line"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(NexusUi.pillButton(this@AddComputerActivity, SCAN_QR).apply { setOnClickListener { scanPairingCode() } }, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(
            NexusUi.cardBody(
                this@AddComputerActivity,
                "Scan the QR code the computer's setup shows, or paste the pairing line that " +
                    "“agentd pair” prints: this phone dials the computer, and both show a code to compare.",
            ),
            NexusUi.block(),
        )
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(pairingField, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(pairingSummary, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 12))
        addView(NexusUi.pillButton(this@AddComputerActivity, "Pair").apply { setOnClickListener { pairWithLine() } }, NexusUi.block())
    }

    private fun currentPairing(): PairingSnapshot = pairingSnapshot(
        machines = configStore.trustedMachines(),
        agentd = configStore.load().agentd,
        signedOut = configStore.signedOut(),
        needsRepair = AgentsRuntime.needsRepair.value,
    )

    private fun renderDoorState(state: GuidedPairing.State) {
        val open = state as? GuidedPairing.State.DoorOpen
        doorOpen.visibility = if (open == null) View.VISIBLE else View.GONE
        doorArmed.visibility = if (open == null) View.GONE else View.VISIBLE
        if (open != null) {
            NexusUi.setDotColor(doorDot, NexusUi.AMBER)
            doorStatus.text = GuidedPairingCopy.doorOpen(open.remainingMs)
            keepCounting()
        }
        guidedStatus.text = GuidedPairingCopy.status(state).orEmpty()
        guidedStatus.visibility = if (guided && guidedStatus.text.isNotEmpty()) View.VISIBLE else View.GONE
    }

    /** One tick a second while the door is open, on the same clock the attempt started on. */
    private fun keepCounting() {
        if (ticker?.isActive == true) return
        ticker = uiScope.launch {
            while (isActive && pairing.state.value is GuidedPairing.State.DoorOpen) {
                delay(1_000L)
                pairing.tick(SystemClock.elapsedRealtime())
            }
        }
    }

    private fun renderTailscaleState() {
        val installed = tailscaleInstalled(this)
        tailscaleStatus.text = if (installed) "READY ON THIS PHONE" else "NOT INSTALLED ON THIS PHONE"
        NexusUi.setDotColor(tailscaleDot, if (installed) NexusUi.GREEN else NexusUi.AMBER)
        tailscaleGet.visibility = if (installed) View.GONE else View.VISIBLE
    }

    private fun renderPairingPreview(raw: String) {
        if (raw.isBlank()) {
            pairingSummary.text = configStore.load().agentd?.let {
                "Paired: ${it.name} · ${it.host}:${it.port}"
            } ?: "No daemon paired."
            return
        }
        pairingSummary.text = when (val parsed = AgentdPairingParser.parse(raw)) {
            is AgentdPairingParseResult.Valid -> "Read: ${parsed.target.host}:${parsed.target.port} — tap Pair, then compare the codes"
            is AgentdPairingParseResult.Invalid -> parsed.reason
        }
    }

    /**
     * The QR code holds the same pairing line, so a scan goes the pasted line's way. The camera is
     * asked for here, on the user's tap, with a line of why before Android's own question.
     */
    private fun scanPairingCode() {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) return openScanner()
        AlertDialog.Builder(this)
            .setMessage(PairingScan.WHY_CAMERA)
            .setPositiveButton(PairingScan.ALLOW) { _, _ -> requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA) }
            .setNegativeButton(PairingScan.NOT_NOW) { _, _ -> cameraOff() }
            .setOnCancelListener { cameraOff() }
            .show()
    }

    private fun openScanner() {
        startActivityForResult(PairingScan.intent(this), REQUEST_SCAN)
    }

    private fun cameraOff() {
        pairingSummary.text = PairingScan.CAMERA_OFF
        toast(PairingScan.CAMERA_OFF)
    }

    @Deprecated("Deprecated in Java")
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) openScanner() else cameraOff()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_SCAN) return
        when (val outcome = PairingScan.outcome(resultCode, data)) {
            is ScanOutcome.Code -> pairWithLine(outcome.text, PairingScan.NOT_OURS)
            ScanOutcome.NoCamera -> cameraOff()
            ScanOutcome.Cancelled -> Unit
        }
    }

    /** The line only says where to dial: the pairing itself is the code check that follows. */
    private fun pairWithLine(raw: String = pairingField.text.toString(), invalid: String = "Fix the pairing line first.") {
        when (val parsed = AgentdPairingParser.parse(raw)) {
            is AgentdPairingParseResult.Valid -> {
                pairingField.text.clear()
                pairingSummary.text = "Connecting to ${parsed.target.host}:${parsed.target.port}…"
                CoderRuntime.fromActivity(this@AddComputerActivity) { pairWithLine(parsed.target) }
            }
            is AgentdPairingParseResult.Invalid -> {
                pairingSummary.text = parsed.reason
                toast(invalid)
            }
        }
    }

    private fun renderAttempt(view: AttemptView?) {
        val code = shownAttempt.render(view)
        codeCard.visibility = if (code != null) View.VISIBLE else View.GONE
        codeText.text = code?.let { "${it.take(3)} ${it.drop(3)}" }.orEmpty()
        codeStatus.text = GuidedPairingCopy.COMPARE
        when (view?.state) {
            AttemptState.PINNED -> pairingSummary.text = "Paired with ${view.peerName} ✓"
            AttemptState.ABORTED -> pairingSummary.text = "Not paired — the codes were not confirmed on both screens."
            else -> Unit
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /** Open on the guided section even when a computer is already paired (Settings' Add your first computer). */
        const val EXTRA_GUIDED = "guided"

        /** Open straight into the QR scanner (onboarding's Scan the QR code). */
        const val EXTRA_SCAN = "scan"

        const val SCAN_QR = "Scan QR code"
        private const val REQUEST_SCAN = 4101
        private const val REQUEST_CAMERA = 4102
    }
}
