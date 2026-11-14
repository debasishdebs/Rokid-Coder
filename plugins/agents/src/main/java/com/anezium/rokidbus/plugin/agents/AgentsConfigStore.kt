package com.anezium.rokidbus.plugin.agents

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import org.json.JSONObject

data class AgentdConfig(
    val host: String,
    val port: Int,
    val token: String,
    val name: String,
    /** agentd's certificate pin (Node `fingerprint256`); null for a legacy plaintext pairing. */
    val fp: String? = null,
    /** The steering secret (R44). Kept only with [fp], sent only in a pinned wss hello, never shown. */
    val steer: String? = null,
) {
    val configured: Boolean
        get() = host.isNotBlank() && port in 1..65535 && token.isNotBlank()

    /** Only a pinned pairing that holds the steering secret can steer; agentd trusts nothing less. */
    val canSteer: Boolean
        get() = fp != null && steer != null

    // The secrets stay out of every string this object becomes.
    override fun toString(): String = "AgentdConfig(name=$name, host=$host, port=$port, pinned=${fp != null})"
}

/** What the wearer reads when a pairing line is turned away or cannot steer. */
internal object PairingCopy {
    const val BAD_FINGERPRINT = "Pairing line has a bad fingerprint"
    const val BAD_STEER = "Pairing line has a bad steering secret"
    const val PINNED_NEEDS_FINGERPRINT = "Pairing line has no fingerprint — this computer is pinned"
    const val CERT_CHANGED = "Computer's certificate changed — re-pair"
    const val REPAIR_TO_STEER = "Re-pair to allow approvals"
}

data class OpenClawConfig(
    val host: String,
    val port: Int = DEFAULT_PORT,
    val token: String,
) {
    val configured: Boolean
        get() = host.isNotBlank() && port in 1..65535 && token.isNotBlank()

    companion object {
        const val DEFAULT_PORT = 18789
    }
}

data class AgentsConfig(
    val agentdEnabled: Boolean,
    val agentd: AgentdConfig?,
    val openClawEnabled: Boolean,
    val openClaw: OpenClawConfig?,
) {
    // The agentd link (Claude Code and Codex) needs no configuration any more:
    // enabling it makes the phone listen, and the daemon on the LAN finds it
    // by itself.
    val shouldMonitor: Boolean
        get() = agentdEnabled || openClawEnabled && openClaw?.configured == true
}

sealed interface AgentdPairingParseResult {
    data class Valid(val config: AgentdConfig) : AgentdPairingParseResult
    data class Invalid(val reason: String) : AgentdPairingParseResult
}

object AgentdPairingParser {
    fun parse(raw: String): AgentdPairingParseResult {
        val json = runCatching { JSONObject(raw.trim()) }.getOrNull()
            ?: return AgentdPairingParseResult.Invalid("Pairing data is not valid JSON.")
        if (json.intOrNull("v") != 1) {
            return AgentdPairingParseResult.Invalid("Unsupported pairing version.")
        }
        if (json.nullableString("kind", MAX_WIRE_TYPE_CHARS) != "nexus-agentd") {
            return AgentdPairingParseResult.Invalid("Pairing kind must be nexus-agentd.")
        }
        val host = json.identifierOrNull("host", MAX_HOST_CHARS)
            ?: return AgentdPairingParseResult.Invalid("Host is missing.")
        val port = json.intOrNull("port") ?: -1
        val token = json.identifierOrNull("token", MAX_AUTH_TOKEN_CHARS)
            ?: return AgentdPairingParseResult.Invalid("Token is missing.")
        val name = json.nullableString("name", MAX_HUD_LABEL_CHARS) ?: host
        if (port !in 1..65535) return AgentdPairingParseResult.Invalid("Port is invalid.")
        // A fingerprint that does not read is refused, never taken as a legacy line without one.
        val fp = if (!json.has("fp")) {
            null
        } else {
            when (val pin = CertPins.parse(json.opt("fp") as? String ?: "")) {
                is PinParse.Valid -> pin.fp
                PinParse.Absent, PinParse.Malformed ->
                    return AgentdPairingParseResult.Invalid(PairingCopy.BAD_FINGERPRINT)
            }
        }
        val steer = if (!json.has("steer")) {
            null
        } else {
            (json.opt("steer") as? String)?.takeIf(STEER::matches)
                ?: return AgentdPairingParseResult.Invalid(PairingCopy.BAD_STEER)
        }
        // Without a pin there is no wss to carry the secret, so it is not kept at all.
        return AgentdPairingParseResult.Valid(
            AgentdConfig(host, port, token, name, fp = fp, steer = steer?.takeIf { fp != null }),
        )
    }

    /** base64url, as agentd's `randomBytes(32).toString("base64url")` writes it. */
    private val STEER = Regex("[A-Za-z0-9_-]{32,128}")
}

data class TrustedMachine(
    val machineId: String,
    val name: String,
    val lastSeenAtMs: Long?,
)

internal enum class MachineTrustResult(val rejectionReason: String? = null) {
    TRUSTED,
    NEWLY_TRUSTED,

    /** We know this machine id, under a different token. */
    REJECTED_BAD_TOKEN(AgentdProtocolCodec.REJECT_BAD_TOKEN),

    /** A stranger, and the wearer is not holding the door open. */
    REJECTED_NOT_INVITED(AgentdProtocolCodec.REJECT_UNKNOWN_MACHINE),

    /**
     * The right token from another certificate (R114): a replayed token, or a
     * computer whose identity was reset. agentd hears bad_token, whose advice
     * (Forget, then link again) is what fixes it.
     */
    REJECTED_CERT_CHANGED(AgentdProtocolCodec.REJECT_BAD_TOKEN),
    ;

    val isRejection: Boolean
        get() = rejectionReason != null
}

/**
 * A machine is trusted only inside the window the wearer armed with Add a
 * computer (R121), the first one ever included: no machine is enrolled on
 * first use, so a LAN host cannot pin itself before the wearer's own does.
 */
internal fun decideMachineTrust(
    knownToken: String?,
    linkWindowOpen: Boolean,
    presentedToken: String,
): MachineTrustResult = when {
    knownToken != null && knownToken == presentedToken -> MachineTrustResult.TRUSTED
    knownToken != null -> MachineTrustResult.REJECTED_BAD_TOKEN
    linkWindowOpen -> MachineTrustResult.NEWLY_TRUSTED
    else -> MachineTrustResult.REJECTED_NOT_INVITED
}

internal fun linkWindowDeadline(now: Long): Long =
    now.coerceAtMost(Long.MAX_VALUE - LINK_WINDOW_DURATION_MS) + LINK_WINDOW_DURATION_MS

internal fun isLinkWindowDeadlineOpen(deadline: Long, now: Long): Boolean =
    deadline - now in 1L..LINK_WINDOW_DURATION_MS

class AgentsConfigStore internal constructor(
    private val prefs: SharedPreferences,
    private val elapsedRealtime: () -> Long,
) {
    constructor(
        context: Context,
        elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
    ) : this(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE), elapsedRealtime)

    fun load(): AgentsConfig {
        val agentdHost = prefs.getString(KEY_AGENTD_HOST, null)
        val agentd = agentdHost?.let {
            AgentdConfig(
                host = it,
                port = prefs.getInt(KEY_AGENTD_PORT, 8792),
                token = prefs.getString(KEY_AGENTD_TOKEN, "").orEmpty(),
                name = prefs.getString(KEY_AGENTD_NAME, it).orEmpty(),
                // As stored: a pin that no longer parses is refused by the client, not dropped here.
                fp = prefs.getString(KEY_AGENTD_FP, null),
                steer = prefs.getString(KEY_AGENTD_STEER, null),
            )
        }?.takeIf(AgentdConfig::configured)
        val openClawHost = prefs.getString(KEY_OPENCLAW_HOST, null)
        val openClaw = openClawHost?.let {
            OpenClawConfig(
                host = it,
                port = prefs.getInt(KEY_OPENCLAW_PORT, OpenClawConfig.DEFAULT_PORT),
                token = prefs.getString(KEY_OPENCLAW_TOKEN, "").orEmpty(),
            )
        }?.takeIf(OpenClawConfig::configured)
        return AgentsConfig(
            agentdEnabled = prefs.getBoolean(KEY_AGENTD_ENABLED, false),
            agentd = agentd,
            openClawEnabled = prefs.getBoolean(KEY_OPENCLAW_ENABLED, false),
            openClaw = openClaw,
        )
    }

    /**
     * Why [config] may not replace the stored pairing, or null when it may. A
     * pinned slot takes only another pinned line; the pin goes only by Forget
     * (`saveAgentd(null, …)`) or by re-pairing with a line that carries one.
     */
    fun agentdPairingRefusal(config: AgentdConfig): String? =
        PairingCopy.PINNED_NEEDS_FINGERPRINT.takeIf {
            config.fp == null && prefs.getString(KEY_AGENTD_FP, null) != null
        }

    /** False, with nothing written, when [agentdPairingRefusal] turns [config] away. */
    fun saveAgentd(config: AgentdConfig?, enabled: Boolean): Boolean {
        if (config != null && agentdPairingRefusal(config) != null) return false
        val current = load().agentd
        prefs.edit().apply {
            putBoolean(KEY_AGENTD_ENABLED, enabled)
            // A different computer, or none: what the old one proved is not this one's.
            val sameComputer = current != null && config != null && current.host == config.host &&
                current.port == config.port && current.token == config.token && current.fp == config.fp
            if (config == null || (current != null && !sameComputer)) {
                remove(v2SeenKey(DIALLED))
            }
            if (config == null) {
                remove(KEY_AGENTD_HOST)
                remove(KEY_AGENTD_PORT)
                remove(KEY_AGENTD_TOKEN)
                remove(KEY_AGENTD_NAME)
                remove(KEY_AGENTD_FP)
                remove(KEY_AGENTD_STEER)
            } else {
                putString(KEY_AGENTD_HOST, config.host)
                putInt(KEY_AGENTD_PORT, config.port)
                putString(KEY_AGENTD_TOKEN, config.token)
                putString(KEY_AGENTD_NAME, config.name)
                if (config.fp != null) putString(KEY_AGENTD_FP, config.fp) else remove(KEY_AGENTD_FP)
                if (config.steer != null) putString(KEY_AGENTD_STEER, config.steer) else remove(KEY_AGENTD_STEER)
            }
        }.apply()
        return true
    }

    /**
     * Turns monitoring off for every provider, keeping what is paired. The
     * notification's Stop uses it, so the Monitoring switch reads off afterwards.
     */
    fun stopMonitoring() {
        prefs.edit()
            .putBoolean(KEY_AGENTD_ENABLED, false)
            .putBoolean(KEY_OPENCLAW_ENABLED, false)
            .apply()
    }

    /**
     * The wearer's quiet toggle: no spoken alert cue. This key is the only copy of
     * it (R74); the glasses board row and the phone settings both read and write it.
     */
    fun isQuiet(): Boolean = prefs.getBoolean(KEY_ALERTS_QUIET, false)

    fun setQuiet(quiet: Boolean) {
        prefs.edit().putBoolean(KEY_ALERTS_QUIET, quiet).apply()
    }

    /**
     * The phone's alert settings. Quiet is not stored with them: it is read from and
     * written to [isQuiet] / [setQuiet], the one copy (R74).
     */
    fun alertSettings(): AlertSettings =
        AlertSettings.fromJson(prefs.getString(KEY_ALERT_SETTINGS, null), quiet = isQuiet())

    fun saveAlertSettings(settings: AlertSettings) {
        val valid = settings.validated()
        prefs.edit().putString(KEY_ALERT_SETTINGS, valid.toJson()).apply()
        setQuiet(valid.quiet)
    }

    /** True once Android's notification prompt has been shown, so the plugin asks only once. */
    fun notificationPermissionAsked(): Boolean = prefs.getBoolean(KEY_NOTIFICATIONS_ASKED, false)

    fun markNotificationPermissionAsked() {
        prefs.edit().putBoolean(KEY_NOTIFICATIONS_ASKED, true).apply()
    }

    fun saveOpenClaw(config: OpenClawConfig?, enabled: Boolean) {
        val previous = load().openClaw
        prefs.edit().apply {
            putBoolean(KEY_OPENCLAW_ENABLED, enabled)
            if (config == null) {
                remove(KEY_OPENCLAW_HOST)
                remove(KEY_OPENCLAW_PORT)
                remove(KEY_OPENCLAW_TOKEN)
            } else {
                putString(KEY_OPENCLAW_HOST, config.host)
                putInt(KEY_OPENCLAW_PORT, config.port)
                putString(KEY_OPENCLAW_TOKEN, config.token)
            }
            if (config != previous) {
                remove(KEY_OPENCLAW_DEVICE_TOKEN)
            }
        }.apply()
    }

    fun openClawSeed(): ByteArray? = prefs.getString(KEY_OPENCLAW_SEED, null)
        ?.let { runCatching { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) }.getOrNull() }
        ?.takeIf { it.size == 32 }

    fun saveOpenClawSeed(seed: ByteArray) {
        require(seed.size == 32)
        prefs.edit().putString(
            KEY_OPENCLAW_SEED,
            android.util.Base64.encodeToString(seed, android.util.Base64.NO_WRAP),
        ).apply()
    }

    fun openClawDeviceToken(): String? =
        prefs.getString(KEY_OPENCLAW_DEVICE_TOKEN, null)?.takeIf(String::isNotBlank)

    fun saveOpenClawDeviceToken(token: String) {
        if (token.isBlank()) return
        prefs.edit().putString(KEY_OPENCLAW_DEVICE_TOKEN, token).apply()
    }

    /**
     * A computer linked inside the wearer's window is remembered with its token,
     * and later connections must present the same one: a stranger on the network
     * cannot take over a known machine's identity.
     */
    fun isMachineTrusted(machineId: String, token: String): Boolean {
        val known = prefs.getString(machineKey(machineId), null) ?: return false
        return known == token
    }

    /**
     * Atomically applies the link-window policy (R121): a machine not yet known is
     * trusted only while the wearer's Add a computer window is open.
     * Existing machine tokens are never changed by this operation.
     *
     * [clientCert] is the fingerprint of the certificate the computer presented
     * on this connection (R114). It is pinned when the machine is trusted now,
     * or when a machine trusted before pins existed connects (migration). Once
     * pinned, the token alone admits nobody: another certificate is refused.
     * So an accepted result with a [clientCert] always means that cert is the
     * machine's pin.
     */
    @Synchronized
    internal fun authorizeMachine(
        machineId: String,
        token: String,
        machineName: String,
        clientCert: String? = null,
    ): MachineTrustResult {
        val key = machineKey(machineId)
        val knownToken = prefs.getString(key, null)
        val result = decideMachineTrust(
            knownToken = knownToken,
            linkWindowOpen = isLinkWindowOpen(),
            presentedToken = token,
        )
        val pinKey = "$KEY_MACHINE_CERT_PREFIX$machineId"
        val pinned = prefs.getString(pinKey, null)
        if (result == MachineTrustResult.TRUSTED && pinned != null && pinned != clientCert) {
            return MachineTrustResult.REJECTED_CERT_CHANGED
        }
        if (result == MachineTrustResult.NEWLY_TRUSTED) {
            prefs.edit()
                .putString(key, token)
                .putString("$KEY_MACHINE_NAME_PREFIX$machineId", machineName)
                .apply { if (clientCert != null) putString(pinKey, clientCert) else remove(pinKey) }
                .remove(KEY_LINK_WINDOW_DEADLINE)
                .apply()
        } else if (result == MachineTrustResult.TRUSTED && pinned == null && clientCert != null) {
            prefs.edit().putString(pinKey, clientCert).apply()
        }
        return result
    }

    /** True when [fingerprint] is the certificate pinned for [machineId]. */
    internal fun isClientCertPinned(machineId: String, fingerprint: String): Boolean =
        prefs.getString("$KEY_MACHINE_CERT_PREFIX$machineId", null) == fingerprint

    fun trustMachine(machineId: String, token: String, machineName: String) {
        prefs.edit()
            .putString(machineKey(machineId), token)
            .putString("$KEY_MACHINE_NAME_PREFIX$machineId", machineName)
            .apply()
    }

    fun armLinkWindow() {
        prefs.edit()
            .putLong(KEY_LINK_WINDOW_DEADLINE, linkWindowDeadline(elapsedRealtime()))
            .apply()
    }

    @Synchronized
    fun isLinkWindowOpen(): Boolean = linkWindowRemainingMs() > 0L

    @Synchronized
    fun linkWindowRemainingMs(): Long {
        val deadline = prefs.getLong(KEY_LINK_WINDOW_DEADLINE, 0L)
        val now = elapsedRealtime()
        val remaining = if (isLinkWindowDeadlineOpen(deadline, now)) deadline - now else 0L
        if (remaining == 0L && deadline != 0L) {
            prefs.edit().remove(KEY_LINK_WINDOW_DEADLINE).apply()
        }
        return remaining
    }

    fun trustedMachineNames(): List<String> = prefs.all.keys
        .filter { it.startsWith(KEY_MACHINE_NAME_PREFIX) }
        .mapNotNull { prefs.getString(it, null) }
        .sorted()

    fun trustedMachines(): List<TrustedMachine> = prefs.all.keys
        .filter { it.startsWith(KEY_MACHINE_PREFIX) }
        .map { it.removePrefix(KEY_MACHINE_PREFIX) }
        .map { id ->
            TrustedMachine(
                machineId = id,
                name = prefs.getString("$KEY_MACHINE_NAME_PREFIX$id", null)?.takeIf(String::isNotBlank) ?: id,
                lastSeenAtMs = prefs.getLong("$KEY_MACHINE_SEEN_PREFIX$id", 0L).takeIf { it > 0L },
            )
        }
        .sortedBy { it.name.lowercase() }

    fun touchMachineSeen(machineId: String, now: Long = System.currentTimeMillis()) {
        if (prefs.getString(machineKey(machineId), null) == null) return
        prefs.edit().putLong("$KEY_MACHINE_SEEN_PREFIX$machineId", now).apply()
    }

    /**
     * Records that the monitor's heartbeat ran, and reports whether the gap
     * since the previous one is too long to be ordinary lateness — see
     * [AgentsFreezeWatch]. The verdict is sticky: the wearer needs to see that
     * the phone froze the app at some point, not only that it is running in the
     * instant they happen to open the screen.
     */
    @Synchronized
    fun recordMonitorHeartbeat(intervalMs: Long, now: Long = elapsedRealtime()): Boolean {
        val previous = prefs.getLong(KEY_HEARTBEAT_AT, 0L)
        val suspended = previous > 0L &&
            AgentsFreezeWatch.wasSuspended(intervalMs, now - previous)
        prefs.edit().apply {
            putLong(KEY_HEARTBEAT_AT, now)
            if (suspended) putBoolean(KEY_WAS_SUSPENDED, true)
        }.apply()
        return suspended
    }

    /** Whether this install has ever caught the system freezing it. */
    fun monitorWasSuspended(): Boolean = prefs.getBoolean(KEY_WAS_SUSPENDED, false)

    /** Clears the verdict so a fix can be seen to work rather than only claimed. */
    @Synchronized
    fun clearMonitorSuspension() {
        prefs.edit().remove(KEY_WAS_SUSPENDED).remove(KEY_HEARTBEAT_AT).apply()
    }

    /**
     * Records that this computer has spoken protocol v2 over a link that can
     * steer. Sticky (R92): v1 attention for its sessions stays off from then on,
     * even while the link is down, until the pairing is forgotten.
     */
    fun markV2Seen(machineId: String?) {
        prefs.edit().putBoolean(v2SeenKey(keyFor(machineId)), true).apply()
    }

    /**
     * True when the v1 status band must stay silent for [session]: agentd's own
     * providers on a link that steers, or on a computer that has shown v2 before.
     */
    fun v1AttentionSuppressed(session: AgentSession, linkSecure: Boolean): Boolean =
        session.provider in AgentProvider.AGENTD_PROVIDERS &&
            (linkSecure || prefs.getBoolean(v2SeenKey(keyFor(session.machineId)), false))

    /** A LAN-linked computer is keyed by its id; the one this phone dials is a single pairing. */
    private fun keyFor(machineId: String?): String =
        machineId?.takeIf { prefs.getString(machineKey(it), null) != null } ?: DIALLED

    private fun v2SeenKey(key: String) = "$KEY_V2_SEEN_PREFIX$key"

    fun forgetMachine(machineId: String) {
        prefs.edit()
            .remove(v2SeenKey(machineId))
            .remove(machineKey(machineId))
            .remove("$KEY_MACHINE_CERT_PREFIX$machineId")
            .remove("$KEY_MACHINE_NAME_PREFIX$machineId")
            .remove("$KEY_MACHINE_SEEN_PREFIX$machineId")
            .remove("$KEY_PROJECTS_PREFIX$machineId")
            .apply()
    }

    fun projects(machineId: String): List<AgentProject> {
        val raw = prefs.getString("$KEY_PROJECTS_PREFIX$machineId", null) ?: return emptyList()
        val array = runCatching { org.json.JSONArray(raw) }.getOrNull() ?: return emptyList()
        return buildList {
            for (index in 0 until array.length()) {
                val json = array.optJSONObject(index) ?: continue
                val name = json.nullableString("name", MAX_HUD_LABEL_CHARS) ?: continue
                val path = json.nullableString("path", MAX_PATH_CHARS) ?: continue
                add(AgentProject(name, path))
            }
        }
    }

    fun addProject(machineId: String, project: AgentProject) {
        val current = projects(machineId).filterNot { it.path == project.path }
        saveProjects(machineId, (current + project).takeLast(MAX_PROJECTS_PER_MACHINE))
    }

    fun removeProject(machineId: String, path: String) {
        saveProjects(machineId, projects(machineId).filterNot { it.path == path })
    }

    private fun saveProjects(machineId: String, projects: List<AgentProject>) {
        val key = "$KEY_PROJECTS_PREFIX$machineId"
        if (projects.isEmpty()) {
            prefs.edit().remove(key).apply()
            return
        }
        val array = org.json.JSONArray()
        projects.forEach { project ->
            array.put(JSONObject().put("name", project.name).put("path", project.path))
        }
        prefs.edit().putString(key, array.toString()).apply()
    }

    fun cancelLinkWindow() {
        prefs.edit().remove(KEY_LINK_WINDOW_DEADLINE).apply()
    }

    fun forgetMachines() {
        prefs.edit().apply {
            prefs.all.keys
                .filter {
                    it.startsWith(KEY_MACHINE_PREFIX) ||
                        it.startsWith(KEY_MACHINE_CERT_PREFIX) ||
                        it.startsWith(KEY_MACHINE_NAME_PREFIX) ||
                        it.startsWith(KEY_MACHINE_SEEN_PREFIX) ||
                        it.startsWith(KEY_V2_SEEN_PREFIX)
                }
                .forEach(::remove)
        }.apply()
    }

    private fun machineKey(machineId: String): String = "$KEY_MACHINE_PREFIX$machineId"

    fun notificationFingerprint(sessionKey: String): String? =
        prefs.getString("$KEY_NOTIFICATION_PREFIX$sessionKey", null)

    fun saveNotificationFingerprint(sessionKey: String, fingerprint: String) {
        prefs.edit().putString("$KEY_NOTIFICATION_PREFIX$sessionKey", fingerprint).apply()
    }

    /**
     * An alert fingerprint outlives the session it describes, so without this
     * the preferences file grows by one entry per session the wearer ever saw.
     */
    fun forgetNotificationFingerprints(sessionKeys: Set<String>) {
        if (sessionKeys.isEmpty()) return
        prefs.edit().apply {
            sessionKeys.forEach { remove("$KEY_NOTIFICATION_PREFIX$it") }
        }.apply()
    }

    private companion object {
        const val PREFS = "nexus_plugin_agents"
        const val KEY_AGENTD_ENABLED = "agentd.enabled"
        const val KEY_AGENTD_HOST = "agentd.host"
        const val KEY_AGENTD_PORT = "agentd.port"
        const val KEY_AGENTD_TOKEN = "agentd.token"
        const val KEY_AGENTD_NAME = "agentd.name"
        const val KEY_AGENTD_FP = "agentd.fp"
        const val KEY_AGENTD_STEER = "agentd.steer"
        const val KEY_OPENCLAW_ENABLED = "openclaw.enabled"
        const val KEY_OPENCLAW_HOST = "openclaw.host"
        const val KEY_OPENCLAW_PORT = "openclaw.port"
        const val KEY_OPENCLAW_TOKEN = "openclaw.token"
        const val KEY_OPENCLAW_SEED = "openclaw.device_seed"
        const val KEY_OPENCLAW_DEVICE_TOKEN = "openclaw.device_token"
        const val KEY_NOTIFICATION_PREFIX = "notification."
        const val KEY_ALERTS_QUIET = "alerts.quiet"
        const val KEY_ALERT_SETTINGS = "alerts.settings"
        const val KEY_NOTIFICATIONS_ASKED = "notifications.permission_asked"
        const val KEY_MACHINE_PREFIX = "machine.token."
        const val KEY_MACHINE_NAME_PREFIX = "machine.name."
        const val KEY_MACHINE_SEEN_PREFIX = "machine.seen."
        const val KEY_MACHINE_CERT_PREFIX = "machine.cert."
        const val KEY_HEARTBEAT_AT = "monitor.heartbeat_at"
        const val KEY_WAS_SUSPENDED = "monitor.was_suspended"
        const val KEY_PROJECTS_PREFIX = "machine.projects."
        const val MAX_PROJECTS_PER_MACHINE = 30
        const val KEY_LINK_WINDOW_DEADLINE = "machine.link_window_deadline"
        const val KEY_V2_SEEN_PREFIX = "machine.v2seen."
        const val DIALLED = "dialled"
    }
}

internal const val LINK_WINDOW_DURATION_MS = 2L * 60L * 1000L
