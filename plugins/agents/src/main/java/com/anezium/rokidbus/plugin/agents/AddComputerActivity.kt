package com.anezium.rokidbus.plugin.agents

import android.app.Activity
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
import android.widget.Switch
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
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The roads to a linked computer. A phone with no computer, or with one signed out or
 * refused, opens on a guided section: run one command on the computer, open the door, watch
 * it say Paired. Below it, as equals under "Other ways": automatic on the home Wi-Fi,
 * Tailscale for everywhere else, and a pasted pairing line for whoever wants neither.
 */
class AddComputerActivity : Activity() {
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val uiScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var doorStatus: TextView
    private lateinit var doorDot: View
    private lateinit var guidedStatus: TextView
    private lateinit var doorOpen: Button
    private lateinit var doorArmed: LinearLayout
    private lateinit var tailscaleStatus: TextView
    private lateinit var tailscaleDot: View
    private lateinit var tailscaleGet: Button
    private lateinit var pairingField: EditText
    private lateinit var pairingSummary: TextView
    private lateinit var openClawEnabled: Switch
    private lateinit var openClawHost: EditText
    private lateinit var openClawPort: EditText
    private lateinit var openClawToken: EditText
    private lateinit var openClawConnection: TextView
    private lateinit var openClawDot: View
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
        uiScope.launch { pairing.state.collect(::renderDoorState) }
        uiScope.launch {
            AgentsRuntime.store.connections.collectLatest { states ->
                val state = states.getValue(AgentProvider.OPENCLAW)
                openClawConnection.text = state.displayText("AUTH FAILED")
                NexusUi.setDotColor(
                    openClawDot,
                    when (state.state) {
                        ConnectionState.CONNECTED -> NexusUi.GREEN
                        ConnectionState.CONNECTING -> NexusUi.AMBER
                        ConnectionState.AUTH_FAILED -> NexusUi.DANGER
                        ConnectionState.DISCONNECTED -> NexusUi.INK3
                    },
                )
            }
        }
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

    override fun onResume() {
        super.onResume()
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
                configStore.armLinkWindow()
                AgentsMonitorService.reconcile(applicationContext)
                pairing.start(snapshot.baseline, snapshot.repairing)
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
        pairingField = NexusUi.field(this, "Paste the pairing line from nexus-agentd").apply {
            // The pairing line carries the token (and the pin), so it is a secret: masked, no
            // keyboard learning or suggestions, no autofill. Never logged. A masked field is one line.
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
        val config = configStore.load()
        openClawEnabled = NexusUi.switch(this).apply {
            isChecked = config.openClawEnabled
            setOnCheckedChangeListener { _, checked ->
                configStore.saveOpenClaw(configStore.load().openClaw, checked)
                AgentsMonitorService.reconcile(applicationContext)
            }
        }
        openClawDot = NexusUi.dot(this)
        openClawConnection = NexusUi.statusLine(this).apply { text = "DISCONNECTED" }
        openClawHost = NexusUi.field(this, "Host or ws(s)://host").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setText(config.openClaw?.host.orEmpty())
        }
        openClawPort = NexusUi.field(this, "Port").apply {
            inputType = InputType.TYPE_CLASS_NUMBER
            setText((config.openClaw?.port ?: OpenClawConfig.DEFAULT_PORT).toString())
        }
        openClawToken = NexusUi.field(this, "Gateway token").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            typeface = Typeface.DEFAULT
            setText(config.openClaw?.token.orEmpty())
        }

        val content = NexusUi.contentColumn(this).apply {
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
            addView(BusTheme.gap(this@AddComputerActivity, 14))
            addView(openClawCard(), NexusUi.block())
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
        addView(NexusUi.rowTitle(this@AddComputerActivity, "By hand — pairing line"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 6))
        addView(
            NexusUi.cardBody(
                this@AddComputerActivity,
                "If you would rather use neither, paste the pairing line that " +
                    "“nexus-agentd pair” prints and this phone dials the computer.",
            ),
            NexusUi.block(),
        )
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(pairingField, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 10))
        addView(pairingSummary, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 12))
        addView(
            actionRow(
                this@AddComputerActivity,
                primary = "Save",
                onPrimary = { savePairing(test = false) },
                secondary = "Test connection",
                onSecondary = { savePairing(test = true) },
            ),
            NexusUi.block(),
        )
    }

    /** Not a computer but a gateway: OpenClaw sessions arrive on their own connection. */
    private fun openClawCard() = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AddComputerActivity, "A gateway — OpenClaw"), NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 6))
        addView(
            NexusUi.switchRow(
                this@AddComputerActivity,
                "Monitor sessions",
                "Watch the sessions on your OpenClaw gateway",
                openClawEnabled,
            ),
            NexusUi.block(),
        )
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(connectionRow(this@AddComputerActivity, openClawDot, openClawConnection), NexusUi.block())
        addView(NexusUi.divider(this@AddComputerActivity))
        addView(openClawHost, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(openClawPort, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 8))
        addView(openClawToken, NexusUi.block())
        addView(BusTheme.gap(this@AddComputerActivity, 12))
        addView(
            actionRow(
                this@AddComputerActivity,
                primary = "Save",
                onPrimary = { saveOpenClaw(test = false) },
                secondary = "Test connection",
                onSecondary = { saveOpenClaw(test = true) },
            ),
            NexusUi.block(),
        )
    }

    private fun saveOpenClaw(test: Boolean) {
        val host = openClawHost.text.toString().trim()
        val port = openClawPort.text.toString().toIntOrNull()
        val token = openClawToken.text.toString().trim()
        if (host.isBlank() || port !in 1..65535 || token.isBlank()) {
            toast("Enter a host, valid port, and token.")
            return
        }
        val config = OpenClawConfig(host, checkNotNull(port), token)
        configStore.saveOpenClaw(config, openClawEnabled.isChecked)
        if (test) {
            AgentsMonitorService.test(applicationContext, AgentProvider.OPENCLAW)
            toast("Testing OpenClaw connection…")
        } else {
            AgentsMonitorService.reconcile(applicationContext)
            toast("OpenClaw settings saved.")
        }
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
            is AgentdPairingParseResult.Valid -> configStore.agentdPairingRefusal(parsed.config)
                ?: "Parsed: ${parsed.config.name} · ${parsed.config.host}:${parsed.config.port}"
            is AgentdPairingParseResult.Invalid -> parsed.reason
        }
    }

    private fun savePairing(test: Boolean) {
        val raw = pairingField.text.toString()
        val config = if (raw.isBlank()) {
            configStore.load().agentd
        } else {
            when (val parsed = AgentdPairingParser.parse(raw)) {
                is AgentdPairingParseResult.Valid -> parsed.config
                is AgentdPairingParseResult.Invalid -> {
                    pairingSummary.text = parsed.reason
                    toast("Fix the pairing data first.")
                    return
                }
            }
        }
        if (config == null) {
            toast("Paste pairing data first.")
            return
        }
        if (!configStore.saveAgentd(config, configStore.load().agentdEnabled)) {
            pairingSummary.text = configStore.agentdPairingRefusal(config)
            toast("Fix the pairing data first.")
            return
        }
        pairingField.text.clear()
        pairingSummary.text = "Paired: ${config.name} · ${config.host}:${config.port}"
        if (test) {
            AgentsMonitorService.test(applicationContext, AgentProvider.CLAUDE)
            toast("Testing the computer link…")
        } else {
            AgentsMonitorService.reconcile(applicationContext)
            toast("Computer link settings saved.")
        }
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /** Open on the guided section even when a computer is already paired (Settings' Add your first computer). */
        const val EXTRA_GUIDED = "guided"
    }
}
