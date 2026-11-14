package com.anezium.rokidbus.plugin.agents

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class AlertSettingsTest {
    private val fixtures = JSONObject(File("../../contracts/rokid-coder-v2.fixtures.json").readText())
        .getJSONObject("phone_to_agent")

    private fun withoutMsgId(frame: JSONObject) = JSONObject(frame.toString()).apply { remove("msgId") }.toString()

    @Test
    fun defaults_match_agentd() {
        // agentd/src/phone-settings.ts DEFAULT_ALERT_TIMINGS, Wait limit 30 min, Ask for both tools.
        val s = AlertSettings()
        assertEquals(60_000L, s.digestPeriodMs)
        assertEquals(1_800_000L, s.waitLimitMs)
        assertEquals(300_000L, s.reminderMs)
        assertEquals(30_000L, s.ageBoostMs)
        assertEquals(8_000L, s.dwellMs)
        assertEquals(5_000L, s.ackTimeoutMs)
        assertEquals(listOf(5_000L, 10_000L, 20_000L), s.retryBackoffMs)
        assertEquals(TempMode.ASK, s.defaultClaude)
        assertEquals(TempMode.ASK, s.defaultCodex)
        assertFalse(s.quiet)
        assertEquals(s, s.validated())
    }

    @Test
    fun floors_applied() {
        val v = AlertSettings(
            digestPeriodMs = 10, reminderMs = 1_000, ageBoostMs = 1, dwellMs = 0, ackTimeoutMs = -5,
            retryBackoffMs = listOf(0, 500, 20_000),
        ).validated()
        assertEquals(1_000L, v.digestPeriodMs)
        assertEquals(30_000L, v.reminderMs)
        assertEquals(1_000L, v.ageBoostMs)
        assertEquals(1_000L, v.dwellMs)
        assertEquals(1_000L, v.ackTimeoutMs)
        assertEquals(listOf(1_000L, 1_000L, 20_000L), v.retryBackoffMs)
        // Nothing to retry with falls back to agentd's steps; too many are cut to eight.
        assertEquals(listOf(5_000L, 10_000L, 20_000L), AlertSettings(retryBackoffMs = emptyList()).validated().retryBackoffMs)
        assertEquals(8, AlertSettings(retryBackoffMs = List(12) { 2_000L }).validated().retryBackoffMs.size)
    }

    @Test
    fun live_cadence_is_zero_and_stays_zero() {
        assertEquals(AlertSettings.LIVE, AlertSettings(digestPeriodMs = 0).validated().digestPeriodMs)
        assertEquals(AlertSettings.LIVE, AlertSettings(digestPeriodMs = -1).validated().digestPeriodMs)
    }

    @Test
    fun wait_limit_clamped_30s_to_1h() {
        assertEquals(30_000L, AlertSettings(waitLimitMs = 1).validated().waitLimitMs)
        assertEquals(30_000L, AlertSettings(waitLimitMs = 29_999).validated().waitLimitMs)
        assertEquals(30_000L, AlertSettings(waitLimitMs = 30_000).validated().waitLimitMs)
        assertEquals(900_000L, AlertSettings(waitLimitMs = 900_000).validated().waitLimitMs)
        assertEquals(3_600_000L, AlertSettings(waitLimitMs = 3_600_000).validated().waitLimitMs)
        assertEquals(3_600_000L, AlertSettings(waitLimitMs = 9_999_999).validated().waitLimitMs)
    }

    @Test
    fun timings_frame_has_no_expireMs() {
        val frame = JSONObject(AlertSettings(waitLimitMs = 900_000).syncFrames { "m" }.first())
        assertEquals("settings_sync", frame.getString("type"))
        assertFalse(frame.getJSONObject("timings").has("expireMs"))
        assertFalse(frame.has("expireMs"))
        assertEquals(900_000L, frame.getLong("waitLimitMs"))
        assertEquals(
            setOf("ageBoostMs", "dwellMs", "ackTimeoutMs", "retryBackoffMs", "reminderMs"),
            frame.getJSONObject("timings").keys().asSequence().toSet(),
        )
        assertEquals(
            AlertTimings(30_000, 8_000, 5_000, listOf(5_000, 10_000, 20_000), 300_000),
            AlertSettings().timings(),
        )
    }

    @Test
    fun approve_all_never_a_default() {
        val v = AlertSettings(defaultClaude = TempMode.APPROVE_ALL, defaultCodex = TempMode.ACCEPT_EDITS).validated()
        assertEquals(TempMode.ASK, v.defaultClaude)
        assertEquals(TempMode.ACCEPT_EDITS, v.defaultCodex)
        // Even an unvalidated value cannot reach the wire as one.
        val defaults = JSONObject(
            AlertSettings(defaultClaude = TempMode.APPROVE_ALL, defaultCodex = TempMode.APPROVE_ALL).syncFrames { "m" }[1],
        ).getJSONObject("defaultModes")
        assertEquals("ask", defaults.getString("claude"))
        assertEquals("ask", defaults.getString("codex"))
        // A stored approveAll is read back as Ask.
        val stored = AlertSettings.fromJson("""{"defaultClaude":"approveAll","defaultCodex":"acceptEdits"}""")
        assertEquals(TempMode.ASK, stored.defaultClaude)
        assertEquals(TempMode.ACCEPT_EDITS, stored.defaultCodex)
    }

    @Test
    fun serialization_round_trip() {
        val s = AlertSettings(
            digestPeriodMs = AlertSettings.LIVE, waitLimitMs = 900_000, reminderMs = 120_000, ageBoostMs = 20_000,
            dwellMs = 6_500, ackTimeoutMs = 4_000, retryBackoffMs = listOf(2_000, 4_000),
            defaultClaude = TempMode.ACCEPT_EDITS, defaultCodex = TempMode.ASK, quiet = true,
        )
        assertEquals(s, AlertSettings.fromJson(s.toJson(), quiet = true))
        // Quiet has no copy in the stored form (R74).
        assertFalse(JSONObject(s.toJson()).has("quiet"))
        assertFalse(AlertSettings.fromJson(s.toJson()).quiet)
        // Nothing, garbage, or a wrong type is the defaults for that field.
        assertEquals(AlertSettings(), AlertSettings.fromJson(null))
        assertEquals(AlertSettings(), AlertSettings.fromJson("not json"))
        assertEquals(
            AlertSettings(dwellMs = 6_000),
            AlertSettings.fromJson("""{"dwellMs":6000,"waitLimitMs":"soon","retryBackoffMs":"x","defaultCodex":"nope"}"""),
        )
        // What is stored is floored on the way back in.
        assertEquals(30_000L, AlertSettings.fromJson("""{"waitLimitMs":5}""").waitLimitMs)
    }

    @Test
    fun settings_sync_frame_from_settings_matches_fixture() {
        val sync = fixtures.getJSONObject("settings_sync")
        val timings = sync.getJSONObject("timings")
        val modes = fixtures.getJSONObject("defaults_set").getJSONObject("defaultModes")
        val settings = AlertSettings(
            waitLimitMs = sync.getLong("waitLimitMs"),
            reminderMs = timings.getLong("reminderMs"),
            ageBoostMs = timings.getLong("ageBoostMs"),
            dwellMs = timings.getLong("dwellMs"),
            ackTimeoutMs = timings.getLong("ackTimeoutMs"),
            retryBackoffMs = timings.getJSONArray("retryBackoffMs").let { a -> List(a.length()) { a.getLong(it) } },
            defaultClaude = TempMode.fromWire(modes.getString("claude"))!!,
            defaultCodex = TempMode.fromWire(modes.getString("codex"))!!,
        )
        val ids = ArrayDeque(listOf("id-1", "id-2"))
        val (syncLine, defaultsLine) = settings.syncFrames { ids.removeFirst() }

        assertEquals(withoutMsgId(sync), withoutMsgId(JSONObject(syncLine)))
        assertEquals(withoutMsgId(fixtures.getJSONObject("defaults_set")), withoutMsgId(JSONObject(defaultsLine)))
        assertEquals("id-1", JSONObject(syncLine).getString("msgId"))
        assertEquals("id-2", JSONObject(defaultsLine).getString("msgId"))
        // Both are steering, so the wire sends them only over a secure link (R61).
        assertTrue(FrameClass.isSteering("settings_sync"))
        assertTrue(FrameClass.isSteering("defaults_set"))
    }

    @Test
    fun every_sync_gets_fresh_msg_ids() {
        val first = AlertSettings().syncFrames().map { JSONObject(it).getString("msgId") }
        val second = AlertSettings().syncFrames().map { JSONObject(it).getString("msgId") }
        assertEquals(4, (first + second).toSet().size)
        assertTrue((first + second).all { it.isNotEmpty() && it.length <= 128 })
    }

    @Test
    fun advanced_fields_parse_seconds_within_the_floor() {
        assertEquals(8_000L, AlertSettings.parseSeconds("8"))
        assertEquals(2_500L, AlertSettings.parseSeconds(" 2.5 "))
        assertNull(AlertSettings.parseSeconds("0.5"))
        assertNull(AlertSettings.parseSeconds("3601"))
        assertNull(AlertSettings.parseSeconds("abc"))
        assertNull(AlertSettings.parseSeconds(""))
        assertNull(AlertSettings.parseSeconds("NaN"))
        assertEquals(listOf(5_000L, 10_000L, 20_000L), AlertSettings.parseBackoff("5, 10, 20"))
        assertEquals(listOf(5_000L), AlertSettings.parseBackoff("5"))
        assertNull(AlertSettings.parseBackoff(""))
        assertNull(AlertSettings.parseBackoff("5, x"))
        assertNull(AlertSettings.parseBackoff("1,1,1,1,1,1,1,1,1"))
        assertEquals("8", AlertSettings.secondsText(8_000))
        assertEquals("2.5", AlertSettings.secondsText(2_500))
        assertNotEquals(AlertSettings.parseSeconds("8"), AlertSettings.parseSeconds("9"))
    }

    @Test
    fun screen_choices_are_the_settings_defaults() {
        assertTrue(AlertSettings().waitLimitMs / 60_000L in AlertSettings.WAIT_LIMIT_MINUTES.map { it.toLong() })
        assertTrue(AlertSettings().reminderMs / 60_000L in AlertSettings.REMINDER_MINUTES.map { it.toLong() })
        assertEquals(listOf(5, 15, 30, 60), AlertSettings.WAIT_LIMIT_MINUTES)
        assertEquals(listOf(1, 2, 5, 10), AlertSettings.REMINDER_MINUTES)
    }
}
