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
    fun no_v1_band_while_link_down_after_v2_seen() {
        val config = store().apply { trustMachine("m1", "tok", "Laptop"); markV2Seen("m1") }
        val engine = AttentionDecisionEngine({ null }, { _, _ -> })
        val waiting = listOf(session("m1"), session("m1", AgentProvider.CODEX), session("m1", AgentProvider.OPENCLAW))

        // The link is down: not secure. Claude and Codex of that computer stay off the v1 path.
        val pending = engine.pending(waiting) { config.v1AttentionSuppressed(it, linkSecure = false) }

        assertTrue(pending.map { it.session.provider } == listOf(AgentProvider.OPENCLAW))
    }

    @Test
    fun v1_still_alerts_for_a_computer_that_never_spoke_v2() {
        val config = store().apply { trustMachine("m1", "tok", "Laptop"); trustMachine("m2", "tok", "Desk") }
        config.markV2Seen("m1")

        assertTrue(config.v1AttentionSuppressed(session("m1"), linkSecure = false))
        assertFalse(config.v1AttentionSuppressed(session("m2"), linkSecure = false))
        // A live steering link needs no history.
        assertTrue(config.v1AttentionSuppressed(session("m2"), linkSecure = true))
    }

    @Test
    fun v2_seen_survives_restart() {
        store().apply { trustMachine("m1", "tok", "Laptop"); markV2Seen("m1"); saveAgentd(pairing, true); markV2Seen(null) }

        val restarted = store()

        assertTrue(restarted.v1AttentionSuppressed(session("m1"), linkSecure = false))
        assertTrue(restarted.v1AttentionSuppressed(session(null), linkSecure = false))
    }

    @Test
    fun forget_pairing_clears_v2_seen() {
        val config = store().apply { trustMachine("m1", "tok", "Laptop"); markV2Seen("m1") }
        assertTrue(config.v1AttentionSuppressed(session("m1"), linkSecure = false))

        config.forgetMachine("m1")
        assertFalse(config.v1AttentionSuppressed(session("m1"), linkSecure = false))

        // The pairing this phone dials is forgotten by saving none.
        config.saveAgentd(pairing, true)
        config.markV2Seen(null)
        assertTrue(config.v1AttentionSuppressed(session(null), linkSecure = false))
        config.saveAgentd(null, false)
        assertFalse(config.v1AttentionSuppressed(session(null), linkSecure = false))

        // Forgetting every machine clears them all.
        config.trustMachine("m2", "tok", "Desk")
        config.markV2Seen("m2")
        config.forgetMachines()
        assertFalse(config.v1AttentionSuppressed(session("m2"), linkSecure = false))
    }

    @Test
    fun re_pairing_a_different_computer_starts_clean() {
        val config = store().apply { saveAgentd(pairing, true); markV2Seen(null) }

        config.saveAgentd(pairing.copy(name = "renamed"), true)
        assertTrue(config.v1AttentionSuppressed(session(null), linkSecure = false))

        config.saveAgentd(pairing.copy(host = "100.9.9.9"), true)
        assertFalse(config.v1AttentionSuppressed(session(null), linkSecure = false))
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
