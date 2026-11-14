package com.anezium.rokidbus.plugin.agents

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.anezium.rokidbus.plugin.agents.ui.ComputerRow
import com.anezium.rokidbus.plugin.agents.ui.SettingsActions
import com.anezium.rokidbus.plugin.agents.ui.SettingsScreen
import com.anezium.rokidbus.plugin.agents.ui.SettingsUiState
import com.anezium.rokidbus.plugin.agents.ui.linkLine
import com.anezium.rokidbus.plugin.agents.ui.theme.AgentsTheme
import com.anezium.rokidbus.plugin.agents.ui.trustLabel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

/**
 * The plugin's settings, in Compose with the PCA theme. The pairing screens
 * (Add a computer, a computer, the project picker, a new thread) stay Views and
 * are launched from here (R43). Exported with no intent filter: the hub opens it
 * by name from the plugin's SETTINGS_ACTIVITY metadata.
 */
class AgentsSettingsActivity : ComponentActivity() {
    private val configStore by lazy { AgentsConfigStore(applicationContext) }
    private var state by mutableStateOf<SettingsUiState?>(null)
    private var liveLink: LinkMachine? = null

    /** Read once, off the main thread: the first read makes the keystore key. */
    private var phoneFingerprint: String? = null

    /** The answer re-reads the screen, so the "Notifications off" line follows a no. */
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A light page under the system bars: dark icons on both.
        val light = SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
        enableEdgeToEdge(statusBarStyle = light, navigationBarStyle = light)
        refresh()
        setContent {
            AgentsTheme {
                state?.let { SettingsScreen(it, actions()) }
            }
        }
        observeLink()
        lifecycleScope.launch {
            // A key that cannot be made means no TLS listener either; say so rather than hide the row.
            phoneFingerprint = withContext(Dispatchers.IO) {
                runCatching { KeystorePhoneTlsIdentity().fingerprint256() }.getOrNull()
            }?.let(CertPins::display) ?: PHONE_KEY_UNAVAILABLE
            refresh()
        }
        if (configStore.load().shouldMonitor) {
            AgentsMonitorService.reconcile(applicationContext)
        }
    }

    override fun onResume() {
        super.onResume()
        // The notification's Stop and the glasses' Quiet row change things from outside this screen.
        refresh()
    }

    private fun actions() = SettingsActions(
        onBack = ::finish,
        onMonitoring = { checked ->
            configStore.saveAgentd(configStore.load().agentd, checked)
            if (checked) askForNotifications()
            AgentsMonitorService.reconcile(applicationContext)
            refresh()
        },
        onOpenComputer = { row ->
            startActivity(
                Intent(this, ComputerActivity::class.java)
                    .putExtra(ComputerActivity.EXTRA_MACHINE_ID, row.machineId)
                    .putExtra(ComputerActivity.EXTRA_MACHINE_NAME, row.title),
            )
        },
        onForgetPaired = {
            val name = configStore.load().agentd?.name
            configStore.saveAgentd(null, enabled = configStore.load().agentdEnabled)
            AgentsMonitorService.reconcile(applicationContext)
            refresh()
            if (name != null) toast("$name forgotten.")
        },
        onAddComputer = { startActivity(Intent(this, AddComputerActivity::class.java)) },
        onAlerts = ::changeAlerts,
        // Quiet has the one store key (R74); it is not part of what agentd is told.
        onQuiet = { quiet ->
            configStore.setQuiet(quiet)
            refresh()
        },
        onRevokeAll = {
            // One id per tap. The wire sends it only over a secure link; the button is off otherwise.
            AgentsMonitorService.sendV2(
                applicationContext,
                AgentdProtocolCodec.modeRevokeAll(UUID.randomUUID().toString()),
            )
        },
        onBatteryGrant = {
            // Re-arm before leaving: the wearer is about to change something, and the question
            // worth answering next is whether it held, not that it was once broken.
            configStore.clearMonitorSuspension()
            openBatteryExemptionRequest(this)
        },
        // The phone's own battery screen is where some ROMs keep the decision that actually
        // binds. Its high-power manager cannot be opened directly, so App info is the nearest
        // door a plugin is allowed to open.
        onBatteryAppInfo = {
            configStore.clearMonitorSuspension()
            openAppInfo(this)
        },
        onUninstall = { startActivity(Intent(Intent.ACTION_DELETE, Uri.parse("package:$packageName"))) },
    )

    /** Saves the change on top of what is stored now (Quiet may have moved on the glasses) and tells agentd. */
    private fun changeAlerts(change: AlertSettings.() -> AlertSettings) {
        configStore.saveAlertSettings(configStore.alertSettings().change())
        AgentsMonitorService.pushSettings(applicationContext)
        refresh()
    }

    private fun observeLink() {
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch {
                    AgentsRuntime.store.linkMachine.collect {
                        liveLink = it
                        refresh()
                    }
                }
                launch {
                    combine(
                        AgentsRuntime.store.connections,
                        AgentsRuntime.store.sessions,
                        AgentsRuntime.linkSecure,
                    ) { _, _, _ -> }.collect { refresh() }
                }
                launch { AgentsRuntime.linkedMachines.collect { refresh() } }
            }
        }
    }

    private fun refresh() {
        val config = configStore.load()
        val connection = AgentsRuntime.store.connections.value.getValue(AgentProvider.CLAUDE)
        val connected = connection.state == ConnectionState.CONNECTED
        val secure = AgentsRuntime.linkSecure.value
        val suspended = configStore.monitorWasSuspended()
        state = SettingsUiState(
            version = BuildConfig.VERSION_NAME,
            monitoring = config.agentdEnabled,
            link = linkLine(connection, AgentsRuntime.store.sessions.value),
            trust = trustLabel(connected, secure),
            steering = connected && secure,
            notificationsOff = config.shouldMonitor && !NotificationManagerCompat.from(this).areNotificationsEnabled(),
            computers = computerRows(config),
            alerts = configStore.alertSettings(),
            // Observation outranks the flag: some phones keep the real decision in their own power
            // manager and leave the platform's answer at false forever, so a green row on a phone
            // that demonstrably froze this app would be the screen lying about what it reports.
            batteryAllowed = batteryExemptionGranted(this),
            batteryFrozen = suspended,
            phoneFingerprint = phoneFingerprint,
        )
    }

    private fun computerRows(config: AgentsConfig): List<ComputerRow> {
        val rows = configStore.trustedMachines().map { machine ->
            val connected = liveLink?.machineId == machine.machineId
            val sub = when {
                connected && liveLink?.overTailnet == true -> "Connected · over Tailscale"
                connected -> "Connected · same Wi-Fi"
                else -> lastSeenText(machine.lastSeenAtMs)
            }
            val projects = configStore.projects(machine.machineId).size
            ComputerRow(
                title = machine.name,
                sub = if (projects > 0) "$sub · $projects ${if (projects == 1) "project" else "projects"}" else sub,
                connected = connected,
                machineId = machine.machineId,
            )
        }
        val paired = config.agentd ?: return rows
        val pairedSub = "Paired by hand · ${paired.host}:${paired.port}"
        return rows + ComputerRow(
            title = paired.name,
            // agentd admits only a pinned link with the steering secret; a slot without them is never dialled.
            sub = if (paired.canSteer) pairedSub else "$pairedSub · ${PairingCopy.OLDER_AGENTD}",
            connected = false,
            machineId = null,
        )
    }

    /**
     * Turning Monitoring on asks Android 13+ for the notification permission, once:
     * a no is final here, and the line below the switch says what it costs. Without
     * it the monitor notification stays hidden and some phones freeze the service.
     */
    private fun askForNotifications() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (configStore.notificationPermissionAsked()) return
        configStore.markNotificationPermissionAsked()
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }
}

private const val PHONE_KEY_UNAVAILABLE = "Unavailable — this phone could not make its TLS key"

internal fun ProviderConnectionState.displayText(authFailure: String): String {
    val label = if (state == ConnectionState.AUTH_FAILED) authFailure else state.wireValue.uppercase()
    val visibleDetail = detail?.takeIf {
        it.isNotBlank() && !it.equals(label, ignoreCase = true)
    }
    return visibleDetail?.let { "$label · $it" } ?: label
}
