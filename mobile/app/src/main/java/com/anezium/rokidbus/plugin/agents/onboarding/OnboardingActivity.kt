package com.anezium.rokidbus.plugin.agents.onboarding

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.anezium.rokidbus.client.ui.BusTheme
import com.anezium.rokidbus.client.ui.NexusUi
import com.anezium.rokidbus.phone.CxrLAuth
import com.anezium.rokidbus.phone.GlassesAppInstaller
import com.anezium.rokidbus.plugin.agents.AddComputerActivity
import com.anezium.rokidbus.plugin.agents.AgentsConfigStore
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.AgentsSettingsActivity
import com.anezium.rokidbus.plugin.agents.BuildConfig
import com.anezium.rokidbus.plugin.agents.PairingAttempts
import com.anezium.rokidbus.plugin.agents.SoundChoice
import com.anezium.rokidbus.plugin.agents.SoundPreview
import com.anezium.rokidbus.plugin.agents.SoundSlot
import com.anezium.rokidbus.plugin.agents.batteryExemptionGranted
import com.anezium.rokidbus.plugin.agents.connectors.ConnectorsActivity
import com.anezium.rokidbus.plugin.agents.connectors.TailscaleConnector
import com.anezium.rokidbus.plugin.agents.connectors.tailscaleStatus
import com.anezium.rokidbus.plugin.agents.openAppInfo
import com.anezium.rokidbus.plugin.agents.openBatteryExemptionRequest
import com.anezium.rokidbus.plugin.agents.openGuidedDoor
import com.anezium.rokidbus.plugin.agents.pairingSnapshot
import com.anezium.rokidbus.plugin.agents.service.CoderRuntime
import com.anezium.rokidbus.plugin.agents.service.CoderService
import com.anezium.rokidbus.shared.LinkStateBits
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.io.File

/**
 * The guided setup of §2, one step at a time, at the first incomplete step. It drives the
 * producers that already exist (the core's installer, 6a's pairing attempts, the secure-link
 * state, the alert path) and re-implements none of them. Views, like the pairing screens.
 */
class OnboardingActivity : ComponentActivity() {
    private val store by lazy { OnboardingStore(this) }
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private val main = Handler(Looper.getMainLooper())

    internal var currentStep: OnboardingStep = OnboardingStep.WELCOME
        private set

    /** Opened from the home screen's Glasses app row: only the glasses app's state and install. */
    private val glassesOnly by lazy { intent.getBooleanExtra(EXTRA_GLASSES_APP, false) }

    private lateinit var content: LinearLayout
    private var stepWork: Job? = null

    private var permissions: PermissionsFlow? = null
    private var asking: PermissionFeature? = null
    private var glasses: GlassesStepController? = null
    private var pairing: PairingStepController? = null
    private var os = ComputerOs.MAC_OS
    private var testAlertMissed = false
    private val preview by lazy { SoundPreview(this) { Toast.makeText(this, it, Toast.LENGTH_SHORT).show() } }

    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        asking?.let { permissions?.answered(it) }
        asking = null
        render()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = NexusUi.BG
        window.navigationBarColor = NexusUi.BG
        // The pairing code is on this screen while a computer pairs.
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        content = NexusUi.contentColumn(this)
        val root = NexusUi.fixedRoot(this).apply {
            addView(NexusUi.screen(this@OnboardingActivity, content), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
        go(if (glassesOnly) OnboardingStep.GLASSES else store.resumeStep())
    }

    override fun onStart() {
        super.onStart()
        pairing?.onScreenStarted()
    }

    override fun onStop() {
        pairing?.onScreenStopped()
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    override fun onDestroy() {
        preview.close()
        glasses?.leave()
        pairing?.onScreenStopped()
        super.onDestroy()
    }

    // The Rokid authorization screen answers here: CxrLAuth starts it with startActivityForResult.
    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_AUTHORIZATION) glasses?.onAuthorization(CxrLAuth.parseAuthorizationResult(resultCode, data))
    }

    // ------------------------------------------------------------------ steps

    private fun go(step: OnboardingStep) {
        if (step != OnboardingStep.GLASSES) glasses?.leave()
        stepWork?.cancel()
        currentStep = step
        when (step) {
            OnboardingStep.DONE -> {
                startActivity(Intent(this, AgentsSettingsActivity::class.java))
                finish()
                return
            }
            OnboardingStep.PERMISSIONS -> permissions = PermissionsFlow(store, Build.VERSION.SDK_INT, ::granted)
            OnboardingStep.GLASSES -> enterGlasses()
            OnboardingStep.FINISH_ON_COMPUTER, OnboardingStep.PAIRING, OnboardingStep.LAPTOP_DONE -> enterPairing()
            OnboardingStep.TEST_ALERT -> raiseTestAlert()
            else -> Unit
        }
        render()
    }

    /** The next step after [done], or the first one still incomplete before it. */
    private fun next(done: OnboardingStep) {
        val after = OnboardingStore.STEPS.dropWhile { it != done }.drop(1)
        val target = when (done) {
            OnboardingStep.FINISH_ON_COMPUTER, OnboardingStep.PAIRING, OnboardingStep.LAPTOP_DONE -> OnboardingStep.TEST_ALERT
            else -> after.firstOrNull() ?: OnboardingStep.DONE
        }
        go(target)
    }

    private fun enterGlasses() {
        val controller = GlassesStepController(
            host = ActivityGlassesHost(),
            nexusInstalled = { installed(OnboardingCopy.NEXUS_PACKAGE) },
            authorize = { CxrLAuth.requestAuthorization(this, REQUEST_AUTHORIZATION) },
            installs = { installer -> installController(installer) },
            onComplete = { store.complete(OnboardingStep.GLASSES) },
            scope = lifecycleScope,
        )
        glasses = controller
        // On entering from the previous screen: no process start happens, so the step starts the service itself.
        controller.enter()
        stepWork = lifecycleScope.launch { controller.view.collect { render() } }
    }

    private fun installController(installer: GlassesAppInstaller): GlassesInstallController {
        val asset = AssetBundledGlasses(applicationContext)
        return GlassesInstallController(
            installer = installer,
            asset = asset,
            copyDir = File(noBackupFilesDir, "glasses"),
            expected = expectedGlassesMetadata(
                asset.info,
                BuildConfig.GLASSES_APPLICATION_ID,
                pinned = BuildConfig.GLASSES_SIGNER_SHA256,
                release = !BuildConfig.DEBUG,
            ),
        )
    }

    private fun enterPairing() {
        if (pairing == null) {
            pairing = PairingStepController(store, ActivityPairingDoor(), PairingAttempts, AgentsRuntime.activeSecureLinks, lifecycleScope)
                .also(PairingStepController::enter)
        }
        if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.STARTED)) pairing?.onScreenStarted()
        stepWork = lifecycleScope.launch {
            launch { pairing!!.view.collect { render() } }
            while (true) {
                delay(1_000L)
                pairing?.tick()
            }
        }
    }

    /** Once the glasses app is running: the same alert again, and the question asked afresh. */
    private fun sendTestAlertAgain() {
        raiseTestAlert()
        render()
    }

    private fun raiseTestAlert() {
        testAlertMissed = false
        val provider = (store.computerChoice ?: ComputerChoice.CLAUDE_CODE).testAlertProvider
        CoderRuntime.fromActivity(this) { AgentsRuntime.alertDirector?.raiseLocalTestAlert(provider) }
    }

    // ------------------------------------------------------------------ rendering

    private fun render() {
        if (!::content.isInitialized) return
        content.removeAllViews()
        when (currentStep) {
            OnboardingStep.WELCOME -> {
                title(OnboardingCopy.WELCOME_TITLE)
                body(OnboardingCopy.WELCOME_BODY)
                primary(OnboardingCopy.START) {
                    store.complete(OnboardingStep.WELCOME)
                    next(OnboardingStep.WELCOME)
                }
            }
            OnboardingStep.PERMISSIONS -> renderPermissions()
            OnboardingStep.GLASSES -> renderGlasses()
            OnboardingStep.COMPUTER_CHECKLIST -> {
                title(OnboardingCopy.CHECKLIST_TITLE)
                ComputerChoice.values().forEach { choice ->
                    secondary(choice.label) {
                        store.computerChoice = choice
                        store.complete(OnboardingStep.COMPUTER_CHECKLIST)
                        next(OnboardingStep.COMPUTER_CHECKLIST)
                    }
                }
            }
            OnboardingStep.FINISH_ON_COMPUTER, OnboardingStep.PAIRING, OnboardingStep.LAPTOP_DONE -> renderPairing()
            OnboardingStep.TEST_ALERT -> {
                title(OnboardingCopy.TEST_ALERT_TITLE)
                if (testAlertMissed) {
                    body(OnboardingCopy.TEST_ALERT_MISSED)
                    primary(OnboardingCopy.CONTINUE) { finishTestAlert() }
                    secondary(OnboardingCopy.SEND_AGAIN) { sendTestAlertAgain() }
                } else {
                    body(OnboardingCopy.TEST_ALERT_BODY)
                    primary(OnboardingCopy.SAW_IT) { finishTestAlert() }
                    secondary(OnboardingCopy.SEND_AGAIN) { sendTestAlertAgain() }
                    secondary(OnboardingCopy.DIDNT_SEE_IT) {
                        testAlertMissed = true
                        render()
                    }
                }
            }
            OnboardingStep.SOUNDS -> renderSounds()
            OnboardingStep.DONE -> Unit
        }
    }

    private fun finishTestAlert() {
        store.complete(OnboardingStep.TEST_ALERT)
        next(OnboardingStep.TEST_ALERT)
    }

    private fun renderPermissions() {
        val flow = permissions ?: return
        val screen = flow.current()
        if (screen == null) {
            val summary = flow.summary()
            if (summary.all { it.on }) return next(OnboardingStep.PERMISSIONS)
            title(OnboardingCopy.PERMISSIONS_DONE_TITLE)
            body(OnboardingCopy.PERMISSIONS_SOME_OFF)
            summary.forEach { line ->
                body(line.text)
                line.pointer?.let { pointer -> secondary("$pointer · ${line.feature.label}") { grant(line.feature) } }
            }
            primary(OnboardingCopy.CONTINUE) { next(OnboardingStep.PERMISSIONS) }
            return
        }
        title(screen.title)
        body(screen.reason)
        primary(screen.allowLabel) { ask(screen.feature) }
        secondary(OnboardingCopy.NOT_NOW) {
            flow.answered(screen.feature)
            render()
        }
    }

    private fun ask(feature: PermissionFeature) {
        val runtime = feature.permissions(Build.VERSION.SDK_INT)
        if (feature == PermissionFeature.BATTERY) {
            permissions?.answered(feature)
            openBatteryExemptionRequest(this)
            render()
            return
        }
        asking = feature
        permissionRequest.launch(runtime.toTypedArray())
    }

    /** A feature that is off: its runtime request again, or the place Android keeps the switch. */
    private fun grant(feature: PermissionFeature) {
        when {
            feature == PermissionFeature.BATTERY -> openBatteryExemptionRequest(this)
            feature.permissions(Build.VERSION.SDK_INT).any { shouldShowRequestPermissionRationale(it) } ->
                permissionRequest.launch(feature.permissions(Build.VERSION.SDK_INT).toTypedArray())
            else -> openAppInfo(this)
        }
    }

    private fun granted(feature: PermissionFeature): Boolean =
        if (feature == PermissionFeature.BATTERY) {
            batteryExemptionGranted(this)
        } else {
            feature.permissions(Build.VERSION.SDK_INT).all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        }

    private fun renderGlasses() {
        val view = glasses?.view?.value ?: return
        title(OnboardingCopy.GLASSES_TITLE)
        when (view.phase) {
            GlassesPhase.STARTING -> body(OnboardingCopy.STARTING)
            GlassesPhase.NEXUS_INSTALLED -> {
                body(OnboardingCopy.NEXUS_INSTALLED)
                view.detail?.let(::body)
                secondary(OnboardingCopy.OPEN_NEXUS) {
                    packageManager.getLaunchIntentForPackage(OnboardingCopy.NEXUS_PACKAGE)?.let { runCatching { startActivity(it) } }
                }
                secondary(OnboardingCopy.APP_INFO) {
                    runCatching {
                        startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", OnboardingCopy.NEXUS_PACKAGE, null)))
                    }
                }
                primary(OnboardingCopy.RETRY) { glasses?.retry() }
            }
            GlassesPhase.AUTHORIZING -> body(OnboardingCopy.CONNECT_BODY)
            GlassesPhase.CONNECTING -> body(OnboardingCopy.CONNECTING)
            GlassesPhase.CONNECT_FAILED -> {
                body(OnboardingCopy.CONNECT_FAILED)
                view.detail?.takeIf { it != OnboardingCopy.CONNECT_FAILED }?.let(::body)
                primary(OnboardingCopy.RETRY) { glasses?.retry() }
            }
            GlassesPhase.APP -> {
                val copy = OnboardingCopy.glassesApp(view.install)
                body(copy.title)
                copy.lines.forEach(::body)
                copy.action?.let { action -> primary(action) { glasses?.installApp() } }
                if (view.install.completesStep) {
                    primary(OnboardingCopy.CONTINUE) { if (glassesOnly) finish() else next(OnboardingStep.GLASSES) }
                }
            }
        }
        if (!view.install.completesStep) {
            // Goes on, but GLASSES stays incomplete: the next app open resumes here.
            secondary(OnboardingCopy.NOT_NOW) { if (glassesOnly) finish() else next(OnboardingStep.GLASSES) }
        }
    }

    private fun renderPairing() {
        val view = pairing?.view?.value ?: return
        val copy = OnboardingCopy.pairing(view)
        if (view.phase == PairingPhase.SAS) {
            title(copy.title)
            copy.lines.forEach(::body)
            // The wearer's own tap, on this phone: the code is never confirmed for them. The buttons
            // answer the attempt drawn here, never one that replaced it before the screen redrew.
            val shown = view.attempt
            primary(OnboardingCopy.CODES_MATCH) { pairing?.confirm(shown, match = true) }
            secondary(OnboardingCopy.CODES_DONT_MATCH) { pairing?.confirm(shown, match = false) }
            return
        }
        if (view.phase == PairingPhase.PAIRED) {
            title(copy.title)
            primary(OnboardingCopy.CONTINUE) { next(OnboardingStep.LAPTOP_DONE) }
            return
        }
        title(OnboardingCopy.FINISH_TITLE)
        OnboardingCopy.finishOnComputerLines(store.computerChoice).forEach(::body)
        body(OnboardingCopy.DOWNLOAD_URL)
        row(OnboardingCopy.COPY to ::copyLink, OnboardingCopy.SHARE to ::shareLink)
        row(*ComputerOs.values().map { choice -> choice.label to { os = choice; render() } }.toTypedArray())
        OnboardingCopy.installerHint(os).forEach(::body)
        gap()
        copy.lines.forEach(::body)
        copy.action?.let { action -> primary(action) { pairing?.openWindow() } }
        copy.links.forEach { link ->
            secondary(link) {
                when (link) {
                    OnboardingCopy.AWAY_FROM_HOME -> pairing?.awayFromHome()
                    OnboardingCopy.TAILSCALE_LINK -> startActivity(Intent(this, ConnectorsActivity::class.java))
                    OnboardingCopy.SCAN_QR -> startActivity(Intent(this, AddComputerActivity::class.java).putExtra(AddComputerActivity.EXTRA_SCAN, true))
                }
            }
        }
        if (view.offerFallback) {
            body("Tailscale: ${tailscaleStatus(TailscaleConnector.installed(this), AgentsRuntime.activeSecureLinks.value).text}")
        }
    }

    private fun renderSounds() {
        title(OnboardingCopy.SOUNDS_TITLE)
        body(OnboardingCopy.SOUNDS_BODY)
        body(OnboardingCopy.SOUNDS_PREVIEW)
        val alerts = configStore.alertSettings()
        SoundSlot.values().forEach { slot ->
            body("${slot.label}: ${choiceLabel(alerts.sounds[slot])}")
            row(
                *SoundChoice.values().map { choice ->
                    choiceLabel(choice) to {
                        configStore.saveAlertSettings(configStore.alertSettings().let { it.copy(sounds = it.sounds.with(slot, choice)) })
                        preview.play(slot, choice)
                        // Told to agentd now when a link is up, as the settings screen does.
                        CoderRuntime.pushSettings()
                        render()
                    }
                }.toTypedArray(),
            )
        }
        primary(OnboardingCopy.FINISH) {
            store.finish()
            go(OnboardingStep.DONE)
        }
    }

    private fun choiceLabel(choice: SoundChoice) = when (choice) {
        SoundChoice.SPEAK -> "Speak"
        SoundChoice.CHIME -> "Chime"
        SoundChoice.SILENT -> "Silent"
    }

    private fun copyLink() {
        getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText(OnboardingCopy.FINISH_TITLE, OnboardingCopy.DOWNLOAD_URL))
    }

    private fun shareLink() {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, OnboardingCopy.DOWNLOAD_URL)
        runCatching { startActivity(Intent.createChooser(send, OnboardingCopy.FINISH_TITLE)) }
    }

    private fun installed(packageName: String): Boolean = runCatching { packageManager.getPackageInfo(packageName, 0) }.isSuccess

    // ------------------------------------------------------------------ views

    private fun title(text: String) {
        content.addView(NexusUi.hero(this, 26f).apply { this.text = text }, NexusUi.block())
        gap()
    }

    private fun body(text: String) {
        content.addView(NexusUi.cardBody(this, text), NexusUi.block())
        gap(6)
    }

    private fun gap(dp: Int = 12) = content.addView(BusTheme.gap(this, dp))

    private fun primary(label: String, onClick: () -> Unit) {
        content.addView(NexusUi.pillButton(this, label).apply { setOnClickListener { onClick() } }, NexusUi.block())
        gap(8)
    }

    private fun secondary(label: String, onClick: () -> Unit) {
        content.addView(NexusUi.outlinePillButton(this, label).apply { setOnClickListener { onClick() } }, NexusUi.block())
        gap(8)
    }

    private fun row(vararg buttons: Pair<String, () -> Unit>) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        buttons.forEach { (label, onClick) ->
            row.addView(
                NexusUi.outlinePillButton(this, label).apply { setOnClickListener { onClick() } },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { marginEnd = NexusUi.dp(this@OnboardingActivity, 6) },
            )
        }
        content.addView(row, NexusUi.block())
        gap(8)
    }

    // ------------------------------------------------------------------ producers

    /** The service, from this visible screen. */
    private inner class ActivityGlassesHost : GlassesHost {
        override val ready: StateFlow<Boolean> = CoderRuntime.ready
        override val cxrUp: StateFlow<Boolean> = CoderRuntime.linkState
            .map { it and LinkStateBits.CXR_CONTROL_UP != 0 }
            .stateIn(lifecycleScope, SharingStarted.Eagerly, CoderRuntime.linkState.value and LinkStateBits.CXR_CONTROL_UP != 0)

        override fun startFromForeground(): Boolean = CoderService.startFromForeground(this@OnboardingActivity)

        override fun connect(token: String) {
            CoderRuntime.core?.startWithToken(token)
        }

        override fun installer(): GlassesAppInstaller? = CoderRuntime.core?.glassesInstaller
    }

    /** 6a's window and the phone's computers, as Add a computer uses them. */
    private inner class ActivityPairingDoor : PairingDoor {
        override fun baselineNow(): Set<String> =
            pairingSnapshot(configStore.trustedMachines(), configStore.load().agentd, configStore.signedOut(), needsRepair = false).baseline

        override fun listen() {
            if (!configStore.load().agentdEnabled) configStore.setAgentdEnabled(true)
            CoderRuntime.fromActivity(this@OnboardingActivity) { reconcile() }
        }

        // A pair-ready announcement calls this from the link server's thread: the monitor reconciles on main.
        override fun open() = openGuidedDoor(configStore) { main.post { CoderRuntime.fromActivity(this@OnboardingActivity) { reconcile() } } }

        override fun cancel() = configStore.cancelLinkWindow()

        override fun remainingMs(): Long = configStore.linkWindowRemainingMs()
    }

    companion object {
        private const val REQUEST_AUTHORIZATION = 1281
        private const val EXTRA_GLASSES_APP = "glasses_app"

        /** The home screen's Glasses app row: the same install controller, for later updates. */
        fun glassesApp(context: Context): Intent = Intent(context, OnboardingActivity::class.java).putExtra(EXTRA_GLASSES_APP, true)
    }
}
