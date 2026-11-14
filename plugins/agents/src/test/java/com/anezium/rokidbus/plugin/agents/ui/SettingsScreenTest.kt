package com.anezium.rokidbus.plugin.agents.ui

import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
import com.anezium.rokidbus.plugin.agents.AlertKind
import com.anezium.rokidbus.plugin.agents.HistoryEntry
import com.anezium.rokidbus.plugin.agents.Outcome
import com.anezium.rokidbus.plugin.agents.SoundChoice
import com.anezium.rokidbus.plugin.agents.SoundSlot
import com.anezium.rokidbus.plugin.agents.AgentStatus
import com.anezium.rokidbus.plugin.agents.ConnectionState
import com.anezium.rokidbus.plugin.agents.ProviderConnectionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsScreenTest {
    private fun session(id: String, status: AgentStatus, provider: AgentProvider = AgentProvider.CLAUDE) =
        AgentSession(id = id, provider = provider, status = status)

    @Test
    fun mode_limits_copy_is_exact() {
        assertEquals(
            "Plugin mode (claude + /rokid:on): no compact or model change from the glasses; replies only while the session waits.",
            SettingsCopy.PLUGIN_LIMITS,
        )
        assertEquals(
            "Launcher mode (rk claude): everything, including after the wait.",
            SettingsCopy.LAUNCHER_LIMITS,
        )
    }

    @Test
    fun link_trust_is_secure_or_pair_again_and_absent_when_not_connected() {
        assertEquals("Secure (TLS)", trustLabel(connected = true, secure = true))
        // There is no monitor-only link: a link that cannot steer is one to pair again.
        assertEquals("Not connected — pair again", trustLabel(connected = true, secure = false))
        assertNull(trustLabel(connected = false, secure = false))
        // A stale secure flag on a dropped link says nothing.
        assertNull(trustLabel(connected = false, secure = true))
    }

    @Test
    fun sound_rows_say_what_each_choice_means() {
        assertEquals(
            listOf("Approval", "Question", "Error", "Done", "Reminder"),
            SoundSlot.values().map { it.label },
        )
        assertEquals("says '<Name> needs approval'", SettingsCopy.soundHint(SoundSlot.APPROVAL, SoundChoice.SPEAK))
        assertEquals("says '<Name> has a question'", SettingsCopy.soundHint(SoundSlot.QUESTION, SoundChoice.SPEAK))
        assertEquals("says '<Name> hit an error'", SettingsCopy.soundHint(SoundSlot.ERROR, SoundChoice.SPEAK))
        assertEquals("says '<Name> is done'", SettingsCopy.soundHint(SoundSlot.DONE, SoundChoice.SPEAK))
        assertEquals("says '<Name> is still waiting'", SettingsCopy.soundHint(SoundSlot.REMINDER, SoundChoice.SPEAK))
        for (slot in SoundSlot.values()) {
            assertEquals("short tone, glasses only", SettingsCopy.soundHint(slot, SoundChoice.CHIME))
            assertEquals("display only", SettingsCopy.soundHint(slot, SoundChoice.SILENT))
        }
        assertEquals(listOf("Speak", "Chime", "Silent"), SettingsCopy.SOUND_CHOICES)
    }

    @Test
    fun notifications_off_line_is_the_one_from_task_8() {
        assertEquals("Notifications off — Android may pause Agents", SettingsCopy.NOTIFICATIONS_OFF)
    }

    @Test
    fun link_line_counts_agentd_sessions_while_connected() {
        val connected = ProviderConnectionState(ConnectionState.CONNECTED)
        val line = linkLine(
            connected,
            listOf(
                session("a", AgentStatus.NEEDS_YOU),
                session("b", AgentStatus.WORKING),
                session("c", AgentStatus.IDLE, AgentProvider.CODEX),
            ),
        )
        assertEquals("WATCHING · 1 NEEDS YOU · 1 RUNNING · 1 IDLE", line.text)
        assertEquals(LinkTone.WARN, line.tone)
        assertEquals(LinkTone.OK, linkLine(connected, emptyList()).tone)
    }

    @Test
    fun link_line_names_the_link_state_when_not_connected() {
        assertEquals(LinkLine("DISCONNECTED", LinkTone.IDLE), linkLine(ProviderConnectionState(), emptyList()))
        assertEquals(
            LinkLine("LINK REFUSED", LinkTone.ERROR),
            linkLine(ProviderConnectionState(ConnectionState.AUTH_FAILED), emptyList()),
        )
        assertEquals(LinkTone.WARN, linkLine(ProviderConnectionState(ConnectionState.CONNECTING), emptyList()).tone)
    }

    @Test
    fun signed_out_line_is_exact_and_names_the_next_step() {
        assertEquals(
            "Signed out of Desk — not used for 14 days. Add it again.",
            SettingsCopy.signedOut("Desk", 14),
        )
    }

    @Test
    fun first_computer_copy_is_exact() {
        assertEquals("Pairing takes two minutes — tap Add your first computer.", SettingsCopy.PAIR_HINT)
        assertEquals("Add your first computer", SettingsCopy.ADD_FIRST_COMPUTER)
    }

    private fun entry(
        outcome: Outcome = Outcome.PENDING,
        label: String? = null,
        count: Int = 1,
        error: String? = null,
        endedAt: Long? = null,
    ) = HistoryEntry(
        alertId = "A", sessionKey = "claude:s1", provider = "CLAUDE", kind = AlertKind.APPROVAL, heading = "my-repo",
        firstShownAtMs = 0L, shownCount = count, outcome = outcome, actionLabel = label, endedAtMs = endedAt,
        lastError = error,
    )

    @Test
    fun history_copy_is_exact() {
        assertEquals("No alerts yet — they'll appear here as your agents ask for things.", HistoryCopy.EMPTY)
        assertEquals("Clear history", HistoryCopy.CLEAR)
    }

    @Test
    fun history_row_names_what_asked_and_how_it_ended() {
        val minute = 60_000L
        val row = historyRow(entry(Outcome.ACTED, "Allowed", endedAt = 3 * minute), now = 5 * minute)
        assertEquals("CLAUDE · approval · my-repo", row.title)
        assertEquals("Allowed · 2 min ago", row.sub)
        assertEquals("Handled · just now", historyRow(entry(Outcome.ACTED), now = 0L).sub)
        assertEquals("Ignored — timed out · 2 h ago", historyRow(entry(Outcome.EXPIRED), now = 130 * minute).sub)
        assertEquals("Handled on laptop · just now", historyRow(entry(Outcome.WITHDRAWN), now = 0L).sub)
        assertEquals("Waiting · just now · shown 3×", historyRow(entry(count = 3), now = 0L).sub)
    }

    @Test
    fun a_refused_answer_reads_not_sent_while_waiting() {
        assertEquals("Not sent: monitor_only · just now", historyRow(entry(error = "monitor_only"), now = 0L).sub)
        assertEquals("Read · just now", historyRow(entry(Outcome.DISMISSED, "Read"), now = 0L).sub)
        assertEquals("Dismissed · just now", historyRow(entry(Outcome.DISMISSED), now = 0L).sub)
    }
}
