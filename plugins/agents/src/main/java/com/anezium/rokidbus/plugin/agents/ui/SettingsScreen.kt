package com.anezium.rokidbus.plugin.agents.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.AgentStatus
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AlertSettings
import com.anezium.rokidbus.plugin.agents.ConnectionState
import com.anezium.rokidbus.plugin.agents.PAIRING_TTL_CHOICES
import com.anezium.rokidbus.plugin.agents.SignedOut
import com.anezium.rokidbus.plugin.agents.ProviderConnectionState
import com.anezium.rokidbus.plugin.agents.TempMode
import com.anezium.rokidbus.plugin.agents.displayText
import com.anezium.rokidbus.plugin.agents.ui.theme.AgentsColors

/** Copy that is part of the contract, kept in one place so a test can hold it to the brief. */
internal object SettingsCopy {
    const val SECURE = "Secure (TLS)"
    const val PAIR_AGAIN = "Not connected — pair again"
    const val NOTIFICATIONS_OFF = "Notifications off — Android may pause Agents"
    const val DND = "Follows phone Do Not Disturb"
    const val REVOKE_ALL = "Turn off approve-all everywhere"
    const val PLUGIN_LIMITS =
        "Plugin mode (claude + /rokid:on): no compact or model change from the glasses; " +
            "replies only while the session waits."
    const val LAUNCHER_LIMITS = "Launcher mode (rk claude): everything, including after the wait."

    /** U6: with no computer yet, the way in is one button that walks through pairing. */
    const val ADD_FIRST_COMPUTER = "Add your first computer"
    const val PAIR_HINT = "Pairing takes two minutes — tap Add your first computer."

    const val TTL_HINT =
        "A computer this phone has not used for this long is signed out, and has to be added again."

    /** U7: the phone signed out of [name], and says what to do next. */
    fun signedOut(name: String, days: Int) = "Signed out of $name — not used for $days days. Add it again."
}

/** What the Monitoring card says about the link, and the colour of its dot. */
internal enum class LinkTone { OK, WARN, ERROR, IDLE }

internal data class LinkLine(val text: String, val tone: LinkTone)

/**
 * The status answers what the glasses are seeing, not just whether a socket is up: session
 * counts while the link works, the link's own state while it does not.
 */
internal fun linkLine(state: ProviderConnectionState, sessions: List<AgentSession>): LinkLine {
    if (state.state != ConnectionState.CONNECTED) {
        val tone = when (state.state) {
            ConnectionState.CONNECTING -> LinkTone.WARN
            ConnectionState.AUTH_FAILED -> LinkTone.ERROR
            else -> LinkTone.IDLE
        }
        return LinkLine(state.displayText(authFailure = "LINK REFUSED"), tone)
    }
    val own = sessions.filter { it.provider in AgentProvider.AGENTD_PROVIDERS }
    val needsYou = own.count { it.status == AgentStatus.NEEDS_YOU }
    val running = own.count { it.status == AgentStatus.WORKING }
    val idle = own.count { it.status == AgentStatus.IDLE }
    val parts = buildList {
        if (needsYou > 0) add(if (needsYou == 1) "1 NEEDS YOU" else "$needsYou NEED YOU")
        add("$running RUNNING")
        add("$idle IDLE")
    }
    return LinkLine("WATCHING · ${parts.joinToString(" · ")}", if (needsYou > 0) LinkTone.WARN else LinkTone.OK)
}

/** Secure only when the link steers. There is no monitor-only link: one that cannot steer is to pair again. */
internal fun trustLabel(connected: Boolean, secure: Boolean): String? = when {
    !connected -> null
    secure -> SettingsCopy.SECURE
    else -> SettingsCopy.PAIR_AGAIN
}

internal data class ComputerRow(
    val title: String,
    val sub: String,
    val connected: Boolean,
    /** Null for the hand-paired daemon, which has no machine id and is forgotten from here. */
    val machineId: String?,
)

internal data class SettingsUiState(
    val version: String,
    val monitoring: Boolean,
    val link: LinkLine,
    val trust: String?,
    val steering: Boolean,
    val notificationsOff: Boolean,
    val computers: List<ComputerRow>,
    val alerts: AlertSettings,
    val batteryAllowed: Boolean,
    val batteryFrozen: Boolean,
    /** Days a computer may go unused before it is signed out (U7). */
    val pairingTtlDays: Int = 14,
    val signedOut: List<SignedOut> = emptyList(),
    /** R75: the first 16 hex digits, grouped, to hold against agentd's log; null until read. */
    val phoneFingerprint: String? = null,
)

internal class SettingsActions(
    val onBack: () -> Unit,
    val onMonitoring: (Boolean) -> Unit,
    val onOpenComputer: (ComputerRow) -> Unit,
    val onForgetPaired: () -> Unit,
    val onAddComputer: () -> Unit,
    /** Opens Add a computer in guided mode, for a phone with no computer yet. */
    val onAddFirstComputer: () -> Unit = onAddComputer,
    val onAlerts: (AlertSettings.() -> AlertSettings) -> Unit,
    val onQuiet: (Boolean) -> Unit,
    val onRevokeAll: () -> Unit,
    val onPairingTtl: (Int) -> Unit = {},
    val onBatteryGrant: () -> Unit,
    val onBatteryAppInfo: () -> Unit,
    val onUninstall: () -> Unit,
)

@Composable
internal fun SettingsScreen(state: SettingsUiState, actions: SettingsActions) {
    SettingsPage(title = "Agents", onBack = actions.onBack, tag = "agents_settings") {
        item {
            SettingsCard {
                NoticeText(
                    "Mission control for Claude Code and Codex sessions, and OpenClaw. Agents never " +
                        "alerts this phone: when a session needs you, it says so on your glasses. Its " +
                        "one notification just shows that monitoring is running.",
                    tag = "intro",
                )
                NoticeText("v${state.version}", tag = "version")
            }
        }

        item { SectionLabel("Monitoring") }
        item { MonitoringCard(state, actions) }

        item { SectionLabel("Computers") }
        item { ComputersCard(state, actions) }

        item { SectionLabel("Security") }
        item { SecurityCard(state, actions) }

        item { SectionLabel("Alerts") }
        item { AlertsCard(state.alerts, actions) }

        item { SectionLabel("Sound") }
        item {
            SettingsCard {
                SwitchRow(
                    "Quiet", "No spoken alert cue on the glasses", state.alerts.quiet, actions.onQuiet, tag = "quiet",
                )
                NoticeText(SettingsCopy.DND, tag = "dnd")
            }
        }

        item { SectionLabel("Approval") }
        item { ApprovalCard(state, actions) }

        item { SectionLabel("Mode limits") }
        item {
            SettingsCard {
                Text(SettingsCopy.PLUGIN_LIMITS, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("limits_plugin"))
                Text(SettingsCopy.LAUNCHER_LIMITS, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("limits_launcher"))
            }
        }

        item { SectionLabel("Background") }
        item { BackgroundCard(state, actions) }

        item { SectionLabel("Plugin") }
        item {
            SettingsCard {
                Text("Uninstall Agents", style = MaterialTheme.typography.titleMedium)
                NoticeText("Removes this plugin from the phone. Your computers keep their own settings.")
                SecondaryAction("Uninstall", actions.onUninstall, tag = "uninstall")
            }
        }
    }
}

@Composable
private fun MonitoringCard(state: SettingsUiState, actions: SettingsActions) {
    SettingsCard {
        SwitchRow(
            "Monitor sessions", "Claude Code, Codex, and OpenClaw", state.monitoring, actions.onMonitoring, tag = "monitor_switch",
        )
        StatusLine(state.link.text, state.link.tone, tag = "link_state")
        state.trust?.let { NoticeText(it, error = it == SettingsCopy.PAIR_AGAIN, tag = "link_trust") }
        if (state.notificationsOff) NoticeText(SettingsCopy.NOTIFICATIONS_OFF, tag = "notifications_off")
    }
}

@Composable
private fun ComputersCard(state: SettingsUiState, actions: SettingsActions) {
    var expanded by remember { mutableStateOf<String?>(null) }
    SettingsCard {
        if (state.computers.isEmpty()) {
            NoticeText("No computer linked yet", tag = "computers_empty")
            PrimaryAction(SettingsCopy.ADD_FIRST_COMPUTER, actions.onAddFirstComputer, tag = "add_first_computer")
            NoticeText(SettingsCopy.PAIR_HINT, tag = "pair_hint")
        }
        state.computers.forEachIndexed { index, row ->
            val handPaired = row.machineId == null
            val open = handPaired && expanded == PAIRED_ROW
            Row(
                Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable {
                    if (handPaired) expanded = if (open) null else PAIRED_ROW else actions.onOpenComputer(row)
                }.testTag("computer_$index"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Dot(if (row.connected) LinkTone.OK else LinkTone.IDLE)
                Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f)) {
                    Text(row.title, style = MaterialTheme.typography.titleMedium)
                    Text(row.sub, style = MaterialTheme.typography.bodyMedium, color = AgentsColors.InkSoft)
                }
                if (open) {
                    TextButton(onClick = { expanded = null; actions.onForgetPaired() }, modifier = Modifier.testTag("forget_paired")) {
                        Text("Forget", color = AgentsColors.ChipCoral.second)
                    }
                } else {
                    Text("›", style = MaterialTheme.typography.titleLarge, color = AgentsColors.InkSoft)
                }
            }
        }
        state.phoneFingerprint?.let { fingerprint ->
            Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("phone_fingerprint")) {
                Text("This phone's fingerprint", style = MaterialTheme.typography.titleMedium)
                Text(fingerprint, style = MaterialTheme.typography.bodyMedium, color = AgentsColors.InkSoft)
            }
        }
        SecondaryAction("Add a computer", actions.onAddComputer, tag = "add_computer")
    }
}

@Composable
private fun SecurityCard(state: SettingsUiState, actions: SettingsActions) {
    SettingsCard {
        ChoiceRow(
            "Sign out unused computers", PAIRING_TTL_CHOICES.map { "$it days" },
            PAIRING_TTL_CHOICES.indexOf(state.pairingTtlDays),
            { actions.onPairingTtl(PAIRING_TTL_CHOICES[it]) },
            tag = "pairing_ttl",
        )
        NoticeText(SettingsCopy.TTL_HINT, tag = "ttl_hint")
        state.signedOut.forEachIndexed { index, row ->
            // The next step is the line itself: tapping it opens Add a computer.
            Text(
                SettingsCopy.signedOut(row.name, row.unusedDays),
                style = MaterialTheme.typography.bodyMedium,
                color = AgentsColors.ChipCoral.second,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClick = actions.onAddComputer)
                    .testTag("signed_out_$index"),
            )
        }
    }
}

@Composable
private fun AlertsCard(alerts: AlertSettings, actions: SettingsActions) {
    var advanced by remember { mutableStateOf(false) }
    SettingsCard {
        ChoiceRow(
            "Glasses update", listOf("Every minute", "Live"), if (alerts.digestPeriodMs == AlertSettings.LIVE) 1 else 0,
            { actions.onAlerts { copy(digestPeriodMs = if (it == 1) AlertSettings.LIVE else AlertSettings.DEFAULT_DIGEST_MS) } },
            tag = "cadence",
        )
        NoticeText("How often progress reaches the glasses. Anything that needs you always goes at once.")
        ChoiceRow(
            "Wait limit", AlertSettings.WAIT_LIMIT_MINUTES.map { "$it min" },
            AlertSettings.WAIT_LIMIT_MINUTES.indexOfFirst { it * 60_000L == alerts.waitLimitMs },
            { actions.onAlerts { copy(waitLimitMs = AlertSettings.WAIT_LIMIT_MINUTES[it] * 60_000L) } },
            tag = "wait_limit",
        )
        NoticeText("How long a session waits for your answer before it falls back to the laptop.")
        ChoiceRow(
            "Remind me again after", AlertSettings.REMINDER_MINUTES.map { "$it min" },
            AlertSettings.REMINDER_MINUTES.indexOfFirst { it * 60_000L == alerts.reminderMs },
            { actions.onAlerts { copy(reminderMs = AlertSettings.REMINDER_MINUTES[it] * 60_000L) } },
            tag = "reminder",
        )
        SecondaryAction(if (advanced) "Advanced ▴" else "Advanced ▾", { advanced = !advanced }, tag = "advanced_toggle")
        if (advanced) AdvancedTimings(alerts, actions)
    }
}

@Composable
private fun AdvancedTimings(alerts: AlertSettings, actions: SettingsActions) {
    // Text is held here and applied on request, so a half-typed number is never sent to the computer.
    var ageBoost by remember(alerts) { mutableStateOf(AlertSettings.secondsText(alerts.ageBoostMs)) }
    var dwell by remember(alerts) { mutableStateOf(AlertSettings.secondsText(alerts.dwellMs)) }
    var ack by remember(alerts) { mutableStateOf(AlertSettings.secondsText(alerts.ackTimeoutMs)) }
    var backoff by remember(alerts) { mutableStateOf(alerts.retryBackoffMs.joinToString(", ") { AlertSettings.secondsText(it) }) }
    val parsedAge = AlertSettings.parseSeconds(ageBoost)
    val parsedDwell = AlertSettings.parseSeconds(dwell)
    val parsedAck = AlertSettings.parseSeconds(ack)
    val parsedBackoff = AlertSettings.parseBackoff(backoff)
    val valid = parsedAge != null && parsedDwell != null && parsedAck != null && parsedBackoff != null
    val changed = valid && (
        parsedAge != alerts.ageBoostMs || parsedDwell != alerts.dwellMs ||
            parsedAck != alerts.ackTimeoutMs || parsedBackoff != alerts.retryBackoffMs
        )
    NoticeText("Seconds, from 1 to 3600. These tune how the glasses queue shows and repeats an alert.")
    TextFieldRow("Next alert waits (s)", ageBoost, { ageBoost = it }, tag = "adv_age_boost", number = true, isError = parsedAge == null)
    TextFieldRow("Alert stays on screen (s)", dwell, { dwell = it }, tag = "adv_dwell", number = true, isError = parsedDwell == null)
    TextFieldRow("Wait for glasses ack (s)", ack, { ack = it }, tag = "adv_ack", number = true, isError = parsedAck == null)
    TextFieldRow(
        "Retry after (s, comma separated)", backoff, { backoff = it }, tag = "adv_backoff",
        isError = parsedBackoff == null, supporting = "One to eight steps, e.g. 5, 10, 20",
    )
    PrimaryAction(
        "Apply timings",
        {
            actions.onAlerts {
                copy(ageBoostMs = parsedAge!!, dwellMs = parsedDwell!!, ackTimeoutMs = parsedAck!!, retryBackoffMs = parsedBackoff!!)
            }
        },
        tag = "adv_apply", enabled = changed,
    )
}

private val DEFAULT_MODE_CHOICES = listOf(TempMode.ASK, TempMode.ACCEPT_EDITS)

@Composable
private fun ApprovalCard(state: SettingsUiState, actions: SettingsActions) {
    var revokeSent by remember { mutableStateOf(false) }
    SettingsCard {
        ChoiceRow(
            "Claude Code", listOf("Ask", "Accept edits"), DEFAULT_MODE_CHOICES.indexOf(state.alerts.defaultClaude),
            { actions.onAlerts { copy(defaultClaude = DEFAULT_MODE_CHOICES[it]) } }, tag = "default_claude",
        )
        ChoiceRow(
            "Codex", listOf("Ask", "Accept edits"), DEFAULT_MODE_CHOICES.indexOf(state.alerts.defaultCodex),
            { actions.onAlerts { copy(defaultCodex = DEFAULT_MODE_CHOICES[it]) } }, tag = "default_codex",
        )
        NoticeText("The mode new sessions start in. Approve-all is never a default; you turn it on per session, on the glasses.")
        SecondaryAction(
            SettingsCopy.REVOKE_ALL,
            { revokeSent = true; actions.onRevokeAll() },
            tag = "revoke_all", enabled = state.steering,
        )
        if (!state.steering) NoticeText("Needs a secure link to the computer.", tag = "revoke_needs_link")
        else if (revokeSent) NoticeText("Asked the computer to turn approve-all off.", tag = "revoke_sent")
    }
}

@Composable
private fun BackgroundCard(state: SettingsUiState, actions: SettingsActions) {
    val ok = state.batteryAllowed && !state.batteryFrozen
    SettingsCard {
        StatusLine(
            when {
                state.batteryFrozen -> "This phone has frozen Agents"
                state.batteryAllowed -> "Allowed to keep running"
                else -> "Android may freeze this app"
            },
            if (ok) LinkTone.OK else LinkTone.WARN, tag = "battery_state",
        )
        NoticeText(
            if (state.batteryFrozen) {
                "Agents was frozen while monitoring, so sessions went unwatched and a computer waiting on " +
                    "you was answered back at its own keyboard. Allowing it below may not be enough on this " +
                    "phone: open App info, then under battery let it use power in the background. The warning " +
                    "clears when you act on it and comes back only if this happens again."
            } else {
                "Android may treat Agents as idle and freeze it. Frozen, it stops seeing your sessions and a " +
                    "computer waiting on you is answered back at the keyboard instead of on your glasses."
            },
            tag = "battery_hint",
        )
        if (!ok) {
            SecondaryAction("Let Agents keep running", actions.onBatteryGrant, tag = "battery_grant")
            SecondaryAction("Open App info", actions.onBatteryAppInfo, tag = "battery_app_info")
        }
    }
}

@Composable
private fun StatusLine(text: String, tone: LinkTone, tag: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Dot(tone)
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag(tag))
    }
}

@Composable
private fun Dot(tone: LinkTone) {
    val color: Color = when (tone) {
        LinkTone.OK -> AgentsColors.Mint
        LinkTone.WARN -> AgentsColors.ChipAmber.second
        LinkTone.ERROR -> AgentsColors.ChipCoral.second
        LinkTone.IDLE -> AgentsColors.InkSoft
    }
    Box(Modifier.size(8.dp).clip(CircleShape).background(color))
}

private const val PAIRED_ROW = "paired-daemon"
