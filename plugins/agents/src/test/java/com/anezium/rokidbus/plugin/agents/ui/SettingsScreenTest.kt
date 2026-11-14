package com.anezium.rokidbus.plugin.agents.ui

import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentSession
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
    fun link_trust_is_secure_or_monitor_only_and_absent_when_not_connected() {
        assertEquals("Secure (TLS)", trustLabel(connected = true, secure = true))
        assertEquals("Monitor only — approve on laptop", trustLabel(connected = true, secure = false))
        assertNull(trustLabel(connected = false, secure = false))
        // A stale secure flag on a dropped link says nothing.
        assertNull(trustLabel(connected = false, secure = true))
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
                session("d", AgentStatus.NEEDS_YOU, AgentProvider.OPENCLAW),
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
}
