package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsConfigStoreV2SeenTest {
    private val prefs = MemoryPrefs()
    private fun store() = AgentsConfigStore(prefs) { 0L }

    private val pairing = AgentdConfig(host = "100.1.2.3", port = 8792, token = "t", name = "laptop")

    @Test
    fun retired_provider_keys_are_cleared_and_the_rest_kept() {
        prefs.edit()
            .putBoolean("openclaw.enabled", true)
            .putString("openclaw.host", "gw")
            .putString("openclaw.device_seed", "c2VlZA==")
            .putString("notification.claude:s1", "needs_you:1")
            .putBoolean("notifications.permission_asked", true)
            .apply()
        store().saveAgentd(pairing, true)

        store().clearRetiredKeys()

        assertEquals(emptyList<String>(), prefs.map.keys.filter { it.startsWith("openclaw.") || it.startsWith("notification.") })
        assertTrue(store().notificationPermissionAsked())
        assertEquals(pairing, store().load().agentd)
        assertTrue(store().load().agentdEnabled)
        // Nothing left to clear is a no-op.
        store().clearRetiredKeys()
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
        val config = store().apply { saveAgentd(pairing, true) }
        assertTrue(config.load().shouldMonitor)

        config.stopMonitoring()

        val after = config.load()
        assertFalse(after.agentdEnabled)
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
