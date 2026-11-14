package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsConfigStoreV2SeenTest {
    private val prefs = MemoryPrefs()
    private fun store() = AgentsConfigStore(prefs) { 0L }

    private fun session(machineId: String?, provider: AgentProvider = AgentProvider.CLAUDE) = AgentSession(
        id = "s1", provider = provider, machineId = machineId, status = AgentStatus.NEEDS_YOU,
    )

    private val pairing = AgentdConfig(host = "100.1.2.3", port = 8792, token = "t", name = "laptop")

    @Test
    fun v1_attention_is_openclaw_only() {
        val engine = AttentionDecisionEngine({ null }, { _, _ -> })
        val waiting = listOf(session("m1"), session("m1", AgentProvider.CODEX), session(null, AgentProvider.OPENCLAW))

        // agentd's own providers speak through v2 alerts only, whatever the link is doing.
        val pending = engine.pending(waiting) { !v1AttentionApplies(it) }

        assertEquals(listOf(AgentProvider.OPENCLAW), pending.map { it.session.provider })
    }

    @Test
    fun quiet_has_one_key_and_survives_restart() {
        assertFalse(store().isQuiet())

        store().setQuiet(true)

        assertEquals(true, prefs.map["alerts.quiet"])
        assertTrue(store().isQuiet())
        store().setQuiet(false)
        assertFalse(store().isQuiet())
    }

    @Test
    fun alert_settings_persist_and_quiet_stays_on_its_one_key() {
        assertEquals(AlertSettings(), store().alertSettings())

        store().saveAlertSettings(
            AlertSettings(waitLimitMs = 900_000, defaultCodex = TempMode.ACCEPT_EDITS, quiet = true),
        )

        val back = store().alertSettings()
        assertEquals(900_000L, back.waitLimitMs)
        assertEquals(TempMode.ACCEPT_EDITS, back.defaultCodex)
        // Quiet is read through isQuiet() and lives under that key only (R74).
        assertTrue(back.quiet)
        assertEquals(true, prefs.map["alerts.quiet"])
        assertFalse(prefs.map.getValue("alerts.settings").toString().contains("quiet"))
        store().setQuiet(false)
        assertFalse(store().alertSettings().quiet)
        // A save is floored: the screen cannot store what agentd would refuse.
        store().saveAlertSettings(AlertSettings(waitLimitMs = 1, defaultClaude = TempMode.APPROVE_ALL))
        assertEquals(30_000L, store().alertSettings().waitLimitMs)
        assertEquals(TempMode.ASK, store().alertSettings().defaultClaude)
    }

    @Test
    fun stop_turns_every_provider_off_and_keeps_the_pairing() {
        val config = store().apply {
            saveAgentd(pairing, true)
            saveOpenClaw(OpenClawConfig(host = "gw", token = "t"), true)
        }
        assertTrue(config.load().shouldMonitor)

        config.stopMonitoring()

        val after = config.load()
        assertFalse(after.agentdEnabled)
        assertFalse(after.openClawEnabled)
        assertFalse(after.shouldMonitor)
        assertEquals(pairing, after.agentd)
    }

    @Test
    fun the_notification_prompt_is_remembered_so_it_is_asked_once() {
        assertFalse(store().notificationPermissionAsked())
        store().markNotificationPermissionAsked()
        assertTrue(store().notificationPermissionAsked())
    }
}
