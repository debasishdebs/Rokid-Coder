package com.anezium.rokidbus.plugin.agents.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.anezium.rokidbus.plugin.agents.AlertHistory
import com.anezium.rokidbus.plugin.agents.HISTORY_WINDOW_CHOICES
import com.anezium.rokidbus.plugin.agents.HistoryEntry
import com.anezium.rokidbus.plugin.agents.Outcome
import com.anezium.rokidbus.plugin.agents.ui.theme.AgentsColors

/** Copy that is part of the contract, kept in one place so a test can hold it to the brief. */
internal object HistoryCopy {
    const val EMPTY = "No alerts yet — they'll appear here as your agents ask for things."
    const val CLEAR = "Clear history"
    const val KEEP = "Keep after the session closes"
    const val KEEP_SUB = "Off: an alert goes from here when its session ends."
    const val WINDOW = "Keep alerts for"
    const val TIMED_OUT = "Ignored — timed out"
    const val ON_LAPTOP = "Handled on laptop"
    const val WAITING = "Waiting"
    const val DISMISSED = "Dismissed"

    fun notSent(error: String) = "Not sent: $error"
}

/** One line of the history: what asked, and how it ended. */
internal data class HistoryRow(val key: String, val title: String, val sub: String)

/** The outcome as the row says it. A refused answer wins while the alert is still waiting. */
internal fun outcomeText(entry: HistoryEntry): String = when (entry.outcome) {
    Outcome.PENDING -> entry.lastError?.let(HistoryCopy::notSent) ?: HistoryCopy.WAITING
    Outcome.ACTED -> entry.actionLabel ?: AlertHistory.HANDLED
    Outcome.DISMISSED -> entry.actionLabel ?: HistoryCopy.DISMISSED
    Outcome.EXPIRED -> HistoryCopy.TIMED_OUT
    Outcome.WITHDRAWN -> HistoryCopy.ON_LAPTOP
}

internal fun relativeTime(deltaMs: Long): String {
    val minutes = (deltaMs / 60_000L).coerceAtLeast(0L)
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        else -> "${minutes / 60} h ago"
    }
}

internal fun historyRow(entry: HistoryEntry, now: Long): HistoryRow {
    val shown = if (entry.shownCount > 1) " · shown ${entry.shownCount}×" else ""
    val at = entry.endedAtMs ?: entry.firstShownAtMs
    return HistoryRow(
        key = entry.alertId,
        title = "${entry.provider} · ${entry.kind.wire} · ${entry.heading}",
        sub = "${outcomeText(entry)} · ${relativeTime(now - at)}$shown",
    )
}

/** The History card on Settings: how long to keep, and the way into the list. */
@Composable
internal fun HistoryCard(state: SettingsUiState, actions: SettingsActions, onOpen: () -> Unit) {
    SettingsCard {
        TextButton(
            onClick = onOpen,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("history_open"),
        ) {
            val count = state.history.size
            Text(if (count == 0) "Alert history" else "Alert history · $count", style = MaterialTheme.typography.titleMedium)
        }
        SwitchRow(
            HistoryCopy.KEEP, HistoryCopy.KEEP_SUB, state.historyKeepAfterSession, actions.onHistoryKeep,
            tag = "history_keep",
        )
        ChoiceRow(
            HistoryCopy.WINDOW, HISTORY_WINDOW_CHOICES.map { if (it == 1) "1 hour" else "$it hours" },
            HISTORY_WINDOW_CHOICES.indexOf(state.historyWindowHours),
            { actions.onHistoryWindow(HISTORY_WINDOW_CHOICES[it]) },
            tag = "history_window",
        )
    }
}

/** The list itself, newest first. */
@Composable
internal fun HistoryScreen(state: SettingsUiState, actions: SettingsActions, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val rows = state.history.map { historyRow(it, state.nowMs) }
    SettingsPage(
        title = "Alert history", onBack = onBack, tag = "agents_history",
        actions = {
            if (rows.isNotEmpty()) SecondaryAction(HistoryCopy.CLEAR, actions.onClearHistory, tag = "history_clear")
        },
    ) {
        if (rows.isEmpty()) {
            item { SettingsCard { NoticeText(HistoryCopy.EMPTY, tag = "history_empty") } }
        } else {
            items(rows, key = { it.key }) { row ->
                SettingsCard {
                    Column(Modifier.fillMaxWidth().testTag("history_${row.key}")) {
                        Text(row.title, style = MaterialTheme.typography.titleMedium)
                        Text(row.sub, style = MaterialTheme.typography.bodyMedium, color = AgentsColors.InkSoft)
                    }
                }
            }
        }
    }
}
