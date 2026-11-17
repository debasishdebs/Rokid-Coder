package com.anezium.rokidbus.plugin.agents

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * What the phone's settings screen owns and syncs to agentd (§12.2): the alert
 * thresholds, the wait limit *Y*, the default approval mode per tool, and the
 * glasses' digest cadence. The values here are agentd's own defaults
 * (`agentd/src/phone-settings.ts`), so an untouched phone and a fresh daemon agree.
 *
 * [quiet] has no copy of its own (R74): [AgentsConfigStore.alertSettings] reads it
 * from, and [AgentsConfigStore.saveAlertSettings] writes it to, `isQuiet()` /
 * `setQuiet()`, the same key the glasses board toggles. [toJson] leaves it out.
 */
data class AlertSettings(
    /** How often progress reaches the glasses; 0 is Live (see [DigestGate]). */
    val digestPeriodMs: Long = DEFAULT_DIGEST_MS,
    val waitLimitMs: Long = 1_800_000,
    val reminderMs: Long = 300_000,
    val ageBoostMs: Long = 30_000,
    val dwellMs: Long = 8_000,
    val ackTimeoutMs: Long = 5_000,
    val retryBackoffMs: List<Long> = listOf(5_000, 10_000, 20_000),
    val defaultClaude: TempMode = TempMode.ASK,
    val defaultCodex: TempMode = TempMode.ASK,
    val quiet: Boolean = false,
    /** Experimental: agentd may type a reply into the terminal while background subagents run. Off until the wearer turns it on. */
    val bgReplies: Boolean = false,
    /** What each alert state sounds like on the phone (U19). Kept on the phone: never sent to agentd. */
    val sounds: SoundPrefs = SoundPrefs(),
) {
    /**
     * The floors agentd applies, applied here first so the screen shows what the
     * daemon will hold to: timings at least 1 s, the reminder at least 30 s, the
     * wait limit 30 s to 1 h, and nothing above an hour (agentd's own cap).
     * Approve-all is never a default, so it falls back to Ask.
     */
    fun validated(): AlertSettings = copy(
        digestPeriodMs = if (digestPeriodMs <= 0L) LIVE else digestPeriodMs.coerceIn(MIN_TIMING_MS, MAX_MS),
        waitLimitMs = waitLimitMs.coerceIn(MIN_WAIT_LIMIT_MS, MAX_MS),
        reminderMs = reminderMs.coerceIn(MIN_REMINDER_MS, MAX_MS),
        ageBoostMs = ageBoostMs.coerceIn(MIN_TIMING_MS, MAX_MS),
        dwellMs = dwellMs.coerceIn(MIN_TIMING_MS, MAX_MS),
        ackTimeoutMs = ackTimeoutMs.coerceIn(MIN_TIMING_MS, MAX_MS),
        retryBackoffMs = retryBackoffMs.take(MAX_BACKOFF_STEPS).map { it.coerceIn(MIN_TIMING_MS, MAX_MS) }
            .ifEmpty { DEFAULT_BACKOFF },
        defaultClaude = defaultClaude.asDefault(),
        defaultCodex = defaultCodex.asDefault(),
    )

    /** The wire's five thresholds. There is no expiry: agentd derives it from [waitLimitMs] (R61). */
    fun timings(): AlertTimings {
        val v = validated()
        return AlertTimings(v.ageBoostMs, v.dwellMs, v.ackTimeoutMs, v.retryBackoffMs, v.reminderMs)
    }

    /** `settings_sync` then `defaults_set`, each with a msgId of its own (one per user action). Both steer. */
    fun syncFrames(
        pairingTtlDays: Int = DEFAULT_PAIRING_TTL_DAYS,
        newMsgId: () -> String = { UUID.randomUUID().toString() },
    ): List<String> {
        val v = validated()
        return listOf(
            AgentdProtocolCodec.settingsSync(v.timings(), v.waitLimitMs, newMsgId(), pairingTtlDays, v.bgReplies),
            AgentdProtocolCodec.defaultsSet(v.defaultClaude, v.defaultCodex, newMsgId()),
        )
    }

    /** The persisted form. [quiet] is not in it (R74). */
    fun toJson(): String {
        val v = validated()
        val json = JSONObject()
            .put("digestPeriodMs", v.digestPeriodMs)
            .put("waitLimitMs", v.waitLimitMs)
            .put("reminderMs", v.reminderMs)
            .put("ageBoostMs", v.ageBoostMs)
            .put("dwellMs", v.dwellMs)
            .put("ackTimeoutMs", v.ackTimeoutMs)
            .put("retryBackoffMs", JSONArray(v.retryBackoffMs))
            .put("defaultClaude", v.defaultClaude.wire)
            .put("defaultCodex", v.defaultCodex.wire)
            .put("bgReplies", v.bgReplies)
        for (slot in SoundSlot.values()) json.put(slot.key, v.sounds[slot].wire)
        return json.toString()
    }

    companion object {
        const val LIVE = 0L
        const val DEFAULT_DIGEST_MS = 60_000L
        const val MIN_TIMING_MS = 1_000L
        const val MIN_REMINDER_MS = 30_000L
        const val MIN_WAIT_LIMIT_MS = 30_000L
        const val MAX_MS = 3_600_000L
        private const val MAX_BACKOFF_STEPS = 8
        private val DEFAULT_BACKOFF = listOf(5_000L, 10_000L, 20_000L)

        /** The wait limit and reminder choices the screen offers, in minutes. */
        val WAIT_LIMIT_MINUTES = listOf(5, 15, 30, 60)
        val REMINDER_MINUTES = listOf(1, 2, 5, 10)

        /** Anything missing or unreadable falls back to the default for that field, never to a stale one. */
        fun fromJson(raw: String?, quiet: Boolean = false): AlertSettings {
            val defaults = AlertSettings(quiet = quiet)
            val json = raw?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return defaults
            fun long(key: String, fallback: Long) = if (json.has(key)) json.optLong(key, fallback) else fallback
            fun mode(key: String) = TempMode.fromWire(json.optString(key, "")) ?: TempMode.ASK
            val sounds = SoundSlot.values().fold(SoundPrefs()) { prefs, slot ->
                prefs.with(slot, SoundChoice.fromWire(json.optString(slot.key, "")) ?: slot.default)
            }
            val backoff = json.optJSONArray("retryBackoffMs")?.let { array ->
                List(array.length()) { array.optLong(it, 0L) }
            } ?: defaults.retryBackoffMs
            return AlertSettings(
                digestPeriodMs = long("digestPeriodMs", defaults.digestPeriodMs),
                waitLimitMs = long("waitLimitMs", defaults.waitLimitMs),
                reminderMs = long("reminderMs", defaults.reminderMs),
                ageBoostMs = long("ageBoostMs", defaults.ageBoostMs),
                dwellMs = long("dwellMs", defaults.dwellMs),
                ackTimeoutMs = long("ackTimeoutMs", defaults.ackTimeoutMs),
                retryBackoffMs = backoff,
                defaultClaude = mode("defaultClaude"),
                defaultCodex = mode("defaultCodex"),
                quiet = quiet,
                // Only a stored true counts; an old save has no key and reads false.
                bgReplies = json.optBoolean("bgReplies", false),
                sounds = sounds,
            ).validated()
        }

        /** "8" or "2.5" seconds typed into an Advanced field; null for anything else or outside 1 s..1 h. */
        fun parseSeconds(text: String): Long? {
            val seconds = text.trim().toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
            return Math.round(seconds * 1000.0).takeIf { it in MIN_TIMING_MS..MAX_MS }
        }

        /** "5, 10, 20": one to eight steps, each a valid [parseSeconds]; null otherwise. */
        fun parseBackoff(text: String): List<Long>? {
            val steps = text.split(',', ' ', ';').filter(String::isNotBlank).map { parseSeconds(it) ?: return null }
            return steps.takeIf { it.size in 1..MAX_BACKOFF_STEPS }
        }

        /** Milliseconds as typed back into a field: 8000 -> "8", 2500 -> "2.5". */
        fun secondsText(ms: Long): String =
            if (ms % 1000L == 0L) (ms / 1000L).toString() else (ms / 1000.0).toString()
    }
}

/** Ask or Accept edits only: approve-all is a per-session choice the wearer confirms, never a default. */
private fun TempMode.asDefault(): TempMode = if (this == TempMode.APPROVE_ALL) TempMode.ASK else this
