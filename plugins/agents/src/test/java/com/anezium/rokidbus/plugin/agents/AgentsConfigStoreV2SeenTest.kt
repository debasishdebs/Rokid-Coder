package com.anezium.rokidbus.plugin.agents

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentsConfigStoreV2SeenTest {
    /** In-memory prefs shared by every store built on it, standing in for the file a restart reopens. */
    private class MemoryPrefs : SharedPreferences {
        val map = LinkedHashMap<String, Any?>()
        override fun getAll(): MutableMap<String, *> = LinkedHashMap(map)
        override fun getString(key: String, defValue: String?) = map[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int) = map[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long) = map[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float) = map[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean) = map[key] as? Boolean ?: defValue
        override fun contains(key: String) = key in map
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val puts = LinkedHashMap<String, Any?>()
            private val removes = LinkedHashSet<String>()
            private var clear = false
            override fun putString(key: String, value: String?) = apply { puts[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { puts[key] = values }
            override fun putInt(key: String, value: Int) = apply { puts[key] = value }
            override fun putLong(key: String, value: Long) = apply { puts[key] = value }
            override fun putFloat(key: String, value: Float) = apply { puts[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { puts[key] = value }
            override fun remove(key: String) = apply { removes += key }
            override fun clear() = apply { clear = true }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() {
                if (clear) map.clear()
                removes.forEach(map::remove)
                map.putAll(puts)
            }
        }
    }

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
