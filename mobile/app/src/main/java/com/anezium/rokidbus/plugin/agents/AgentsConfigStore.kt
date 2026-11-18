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
    /** agentd's certificate pin (Node `fingerprint256`); null only in a slot saved before Plan 4, never dialled. */
    val fp: String? = null,
    /** The steering secret (R44). Kept only with [fp], sent only in a pinned wss hello, never shown. */
    val steer: String? = null,
    /**
     * Other addresses of the same computer, tried after [host] (its LAN address at pairing; these are
     * typically its Tailscale one). Where to dial only: [fp] still decides who answers.
     */
    val altHosts: List<String> = emptyList(),
) {
    /** [host] first, then [altHosts], each once. */
    val dialHosts: List<String>
        get() = (listOf(host) + altHosts).distinctBy { it.lowercase() }

    /** Whether the running client would dial the same computer the same way: [altHosts] are read fresh each round. */
    fun sameDialAs(other: AgentdConfig?): Boolean = other != null && copy(altHosts = emptyList()) == other.copy(altHosts = emptyList())

    val configured: Boolean
        get() = host.isNotBlank() && port in 1..65535 && token.isNotBlank()

    /** Only a pinned pairing that holds the steering secret is dialled; agentd admits nothing less. */
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
    const val REPAIR_TO_STEER = "Pair again — this computer no longer trusts this phone"

    /** A slot saved without a pin or a steering secret: agentd refuses its hello. */
    const val OLDER_AGENTD = "This pairing line is from an older agentd — run agentd pair again"

    /** A v1 line, which carried the token and the steering secret: credentials never come from a line now. */
    const val LEGACY_LINE = "This pairing line is from an older version — pair again"

    /** The outbound dial that the usage TTL stopped; the Computers card says which computer and how long. */
    const val SIGNED_OUT = "Signed out — not used for too long. Add it again."

    private const val CANT_REACH = "Can't reach "
    private const val AWAY_WITH_TAILSCALE =
        "Away from home? Turn on Tailscale on this phone and make sure your computer is on it too."
    private const val LAN_ONLY = "If you're away from home, your computer needs Tailscale too."

    /** Why the dial found nothing at any of [hosts]: the user's own addresses, and what usually fixes it. */
    fun cantReach(hosts: List<String>): String {
        val named = hosts.take(4)
        val list = if (named.size == 1) named[0] else named.dropLast(1).joinToString(", ") + " or " + named.last()
        val lanOnly = named.size == 1 && !isTailnetAddress(named[0])
        return "$CANT_REACH$list. ${if (lanOnly) LAN_ONLY else AWAY_WITH_TAILSCALE}"
    }

    /** Whether [detail] is a [cantReach] sentence, for a screen that wants it under the computer's name. */
    fun isUnreachable(detail: String?): Boolean = detail?.startsWith(CANT_REACH) == true
}

/** A computer the phone signed out because it went unused past the pairing TTL (U7). */
data class SignedOut(val name: String, val atMs: Long, val unusedDays: Int)

data class AgentsConfig(
    val agentdEnabled: Boolean,
    val agentd: AgentdConfig?,
) {
    // The agentd link (Claude Code and Codex) needs no configuration any more:
    // enabling it makes the phone listen, and the daemon on the LAN finds it
    // by itself.
    val shouldMonitor: Boolean
        get() = agentdEnabled
}

/** Where a v2 pairing line says agentd's wss is, and which cert to expect there. Nothing secret. */
data class PairLineTarget(
    val host: String,
    val port: Int,
    val fp: String,
    /** The line's optional full list of addresses (LAN first, Tailscale last); [host] stays the primary. */
    val hosts: List<String> = emptyList(),
)

sealed interface AgentdPairingParseResult {
    data class Valid(val target: PairLineTarget) : AgentdPairingParseResult
    data class Invalid(val reason: String) : AgentdPairingParseResult
}

/**
 * The pairing line and QR, v2: `{v:2, kind:"rokid-coder", host, hosts?, port, fp}`. It only says where to
 * dial; the phone still runs the SAS code check there, and the credentials come after it.
 */
object AgentdPairingParser {
    fun parse(raw: String): AgentdPairingParseResult {
        val json = runCatching { JSONObject(raw.trim()) }.getOrNull()
            ?: return AgentdPairingParseResult.Invalid("Pairing data is not valid JSON.")
        // Credentials never come from a line any more: one that carries them is an old one.
        if (json.intOrNull("v") == 1 || json.has("token") || json.has("steer")) {
            return AgentdPairingParseResult.Invalid(PairingCopy.LEGACY_LINE)
        }
        if (json.intOrNull("v") != 2) {
            return AgentdPairingParseResult.Invalid("Unsupported pairing version.")
        }
        if (json.nullableString("kind", MAX_WIRE_TYPE_CHARS) != "rokid-coder") {
            return AgentdPairingParseResult.Invalid("Pairing kind must be rokid-coder.")
        }
        val host = json.identifierOrNull("host", MAX_HOST_CHARS)
            ?: return AgentdPairingParseResult.Invalid("Host is missing.")
        val port = json.intOrNull("port") ?: -1
        if (port !in 1..65535) return AgentdPairingParseResult.Invalid("Port is invalid.")
        val fp = (CertPins.parse(json.opt("fp") as? String) as? PinParse.Valid)?.fp
            ?: return AgentdPairingParseResult.Invalid(PairingCopy.BAD_FINGERPRINT)
        // An old line has none; a malformed list is ignored whole, never a reason to refuse the line.
        val hosts = EndpointHosts.clean(json.optJSONArray("hosts"))
        return AgentdPairingParseResult.Valid(PairLineTarget(host, port, fp, hosts))
    }
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
    /** Wall time, for how long a pairing has gone unused; a seam so no test sleeps. */
    private val wallClock: () -> Long = System::currentTimeMillis,
    private val elapsedRealtime: () -> Long,
) {
    constructor(
        context: Context,
        elapsedRealtime: () -> Long = SystemClock::elapsedRealtime,
        wallClock: () -> Long = System::currentTimeMillis,
    ) : this(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE), wallClock, elapsedRealtime)

    fun load(): AgentsConfig {
        synchronized(STORE_LOCK) {
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
                    altHosts = EndpointHosts.without(EndpointHosts.decode(prefs.getString(KEY_AGENTD_ALT_HOSTS, null)), it),
                )
            }?.takeIf(AgentdConfig::configured)
            return AgentsConfig(
                agentdEnabled = prefs.getBoolean(KEY_AGENTD_ENABLED, false),
                agentd = agentd,
            )
        }
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

    /** The Monitoring switch: turns the agentd link on or off and leaves whatever is paired, or signed out, as it is. */
    fun setAgentdEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_AGENTD_ENABLED, enabled).apply()
    }

    /**
     * Calls [onChange] after the Monitoring switch is written, by whichever screen or flow wrote it.
     * Close the result to stop; hold on to it meanwhile, or the platform lets the listener go.
     */
    fun watchMonitoring(onChange: () -> Unit): AutoCloseable {
        val listener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == KEY_AGENTD_ENABLED) onChange()
        }
        prefs.registerOnSharedPreferenceChangeListener(listener)
        return AutoCloseable { prefs.unregisterOnSharedPreferenceChangeListener(listener) }
    }

    /**
     * False, with nothing written, when [agentdPairingRefusal] turns [config] away.
     * A non-null [config] is a pairing the wearer just made, so it counts as a use.
     */
    fun saveAgentd(config: AgentdConfig?, enabled: Boolean): Boolean {
        synchronized(STORE_LOCK) {
            if (config != null && agentdPairingRefusal(config) != null) return false
            val current = load().agentd
            val forgottenName = prefs.getString(KEY_AGENTD_NAME, null)
            // One pairing, both transports (6a-R3): forgetting the slot forgets its machine's PhoneLink trust too.
            if (config == null) prefs.getString(KEY_AGENTD_MACHINE_ID, null)?.let(::forgetMachine)
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
                    remove(KEY_AGENTD_ALT_HOSTS)
                    remove(KEY_AGENTD_LAST_USED)
                    remove(KEY_AGENTD_MACHINE_ID)
                    forgottenName?.let { removeSignedOut(this, it) }
                } else {
                    putLong(KEY_AGENTD_LAST_USED, wallClock())
                    removeSignedOut(this, config.name)
                    putString(KEY_AGENTD_HOST, config.host)
                    putInt(KEY_AGENTD_PORT, config.port)
                    putString(KEY_AGENTD_TOKEN, config.token)
                    putString(KEY_AGENTD_NAME, config.name)
                    if (config.fp != null) putString(KEY_AGENTD_FP, config.fp) else remove(KEY_AGENTD_FP)
                    if (config.steer != null) putString(KEY_AGENTD_STEER, config.steer) else remove(KEY_AGENTD_STEER)
                    EndpointHosts.encode(EndpointHosts.without(config.altHosts, config.host))
                        ?.let { putString(KEY_AGENTD_ALT_HOSTS, it) } ?: remove(KEY_AGENTD_ALT_HOSTS)
                }
            }.apply()
            return true
        }
    }

    /**
     * Turns monitoring off for every provider, keeping what is paired. The
     * notification's Stop uses it, so the Monitoring switch reads off afterwards.
     */
    fun stopMonitoring() {
        prefs.edit().putBoolean(KEY_AGENTD_ENABLED, false).apply()
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

    /**
     * A computer linked inside the wearer's window is remembered with its token,
     * and later connections must present the same one: a stranger on the network
     * cannot take over a known machine's identity.
     */
    fun isMachineTrusted(machineId: String, token: String): Boolean = synchronized(STORE_LOCK) {
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
    internal fun authorizeMachine(
        machineId: String,
        token: String,
        machineName: String,
        clientCert: String? = null,
    ): MachineTrustResult {
        synchronized(STORE_LOCK) {
            val key = machineKey(machineId)
            // Before any trust decision: a computer unused past the TTL is signed out and turned away
            // on this very attempt, so it can neither renew itself by reconnecting before a sweep nor
            // spend the wearer's Add a computer window. Its next attempt is an unknown computer's.
            val now = wallClock()
            migrateTtl(now)
            if (prefs.getString(key, null) != null && isMachineStale(machineId, now)) {
                signOutMachine(machineId, now)
                return MachineTrustResult.REJECTED_NOT_INVITED
            }
            val knownToken = prefs.getString(key, null)
            // An open door no longer trusts a stranger's hello: a new computer joins only through a
            // SAS pairing, whose credentials [commitPairing] stores. So the window is not consulted.
            val result = decideMachineTrust(
                knownToken = knownToken,
                linkWindowOpen = false,
                presentedToken = token,
            )
            val pinKey = "$KEY_MACHINE_CERT_PREFIX$machineId"
            val pinned = prefs.getString(pinKey, null)
            if (result == MachineTrustResult.TRUSTED && pinned != null && pinned != clientCert) {
                return MachineTrustResult.REJECTED_CERT_CHANGED
            }
            if (result == MachineTrustResult.TRUSTED && pinned == null && clientCert != null) {
                prefs.edit().putString(pinKey, clientCert).apply()
            }
            return result
        }
    }

    /** True when [fingerprint] is the certificate pinned for [machineId]. */
    internal fun isClientCertPinned(machineId: String, fingerprint: String): Boolean = synchronized(STORE_LOCK) {
        prefs.getString("$KEY_MACHINE_CERT_PREFIX$machineId", null) == fingerprint
    }

    fun trustMachine(machineId: String, token: String, machineName: String) {
        prefs.edit()
            .putString(machineKey(machineId), token)
            .putString("$KEY_MACHINE_NAME_PREFIX$machineId", machineName)
            .putLong("$KEY_MACHINE_SEEN_PREFIX$machineId", wallClock())
            .apply { removeSignedOut(this, machineName) }
            .apply()
    }

    fun armLinkWindow() {
        prefs.edit()
            .putLong(KEY_LINK_WINDOW_DEADLINE, linkWindowDeadline(elapsedRealtime()))
            .apply()
    }

    fun isLinkWindowOpen(): Boolean = linkWindowRemainingMs() > 0L

    /**
     * Spends the door: true when it was open, and then it is shut. The first SAS commitment on
     * either transport calls this, so one opening is one attempt, and only the wearer opens another.
     */
    fun consumeLinkWindow(): Boolean = synchronized(STORE_LOCK) {
        if (!isLinkWindowOpen()) return false
        prefs.edit().remove(KEY_LINK_WINDOW_DEADLINE).commit()
        true
    }

    fun linkWindowRemainingMs(): Long {
        synchronized(STORE_LOCK) {
            val deadline = prefs.getLong(KEY_LINK_WINDOW_DEADLINE, 0L)
            val now = elapsedRealtime()
            val remaining = if (isLinkWindowDeadlineOpen(deadline, now)) deadline - now else 0L
            if (remaining == 0L && deadline != 0L) {
                prefs.edit().remove(KEY_LINK_WINDOW_DEADLINE).apply()
            }
            return remaining
        }
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

    fun touchMachineSeen(machineId: String, now: Long = wallClock()) {
        if (prefs.getString(machineKey(machineId), null) == null) return
        prefs.edit().putLong("$KEY_MACHINE_SEEN_PREFIX$machineId", now).apply()
    }

    // ------------------------------------------------------------ pairing TTL (U7)

    /** Days a computer may go unused before this phone signs out of it. */
    fun pairingTtlDays(): Int =
        prefs.getInt(KEY_PAIRING_TTL_DAYS, DEFAULT_PAIRING_TTL_DAYS).takeIf { it in PAIRING_TTL_CHOICES }
            ?: DEFAULT_PAIRING_TTL_DAYS

    fun setPairingTtlDays(days: Int) {
        if (days !in PAIRING_TTL_CHOICES) return
        prefs.edit().putInt(KEY_PAIRING_TTL_DAYS, days).apply()
    }

    // ------------------------------------------------------------ alert history (U1)

    /** Whether a closed session's alerts stay in the history (phone-only). */
    fun historyKeepAfterSession(): Boolean = prefs.getBoolean(KEY_HISTORY_KEEP_AFTER_SESSION, false)

    fun setHistoryKeepAfterSession(keep: Boolean) {
        prefs.edit().putBoolean(KEY_HISTORY_KEEP_AFTER_SESSION, keep).apply()
    }

    /** Hours an alert stays in the history (phone-only). */
    fun historyWindowHours(): Int =
        prefs.getInt(KEY_HISTORY_WINDOW_HOURS, DEFAULT_HISTORY_WINDOW_HOURS).takeIf { it in HISTORY_WINDOW_CHOICES }
            ?: DEFAULT_HISTORY_WINDOW_HOURS

    fun setHistoryWindowHours(hours: Int) {
        if (hours !in HISTORY_WINDOW_CHOICES) return
        prefs.edit().putInt(KEY_HISTORY_WINDOW_HOURS, hours).apply()
    }

    fun historyPolicy(): HistoryPolicy =
        HistoryPolicy(historyWindowHours() * HOUR_MS, historyKeepAfterSession())

    // ------------------------------------------------------------ voice reply length (U4/U13)

    /** Words of a long voice reply the glasses show before condensing it (phone-only); the reply is sent whole. */
    fun voiceWordLimit(): Int =
        prefs.getInt(KEY_VOICE_WORD_LIMIT, VoiceCondense.DEFAULT_WORD_LIMIT)
            .coerceIn(VoiceCondense.MIN_WORD_LIMIT, VoiceCondense.MAX_WORD_LIMIT)

    fun setVoiceWordLimit(words: Int) {
        val clamped = words.coerceIn(VoiceCondense.MIN_WORD_LIMIT, VoiceCondense.MAX_WORD_LIMIT)
        prefs.edit().putInt(KEY_VOICE_WORD_LIMIT, clamped).apply()
    }

    /** The outbound pairing was used just now: a secure hello_ack, or a link that is still up. */
    fun touchAgentdUsed(now: Long = wallClock()) {
        synchronized(STORE_LOCK) {
            if (prefs.getString(KEY_AGENTD_TOKEN, "").isNullOrBlank()) return
            prefs.edit().putLong(KEY_AGENTD_LAST_USED, now).apply()
        }
    }

    /**
     * Signs out of every computer unused for longer than [pairingTtlDays] as of [now], and says which.
     * An outbound slot keeps its host and name for the re-pair hint; an inbound machine is forgotten.
     */
    fun expireUnused(now: Long = wallClock()): List<SignedOut> {
        synchronized(STORE_LOCK) {
            migrateTtl(now)
            val out = mutableListOf<SignedOut>()
            if (!prefs.getString(KEY_AGENTD_TOKEN, "").isNullOrBlank() && isSlotStale(now)) {
                // Its machine's trust is just as stale (the record's last use is the later of both), so it goes below.
                out += signOutAgentd(now)
            }
            prefs.all.keys
                .filter { it.startsWith(KEY_MACHINE_PREFIX) }
                .map { it.removePrefix(KEY_MACHINE_PREFIX) }
                .filter { isMachineStale(it, now) }
                .forEach { out += signOutMachine(it, now) }
            // One pairing signs out once, though both its transports went.
            return out.distinctBy { it.name }
        }
    }

    /**
     * Whether the outbound pairing may be dialled now. A slot unused past the TTL is signed out
     * here and not dialled, so a stale computer cannot renew itself between sweeps.
     */
    fun outboundAdmitted(now: Long = wallClock()): Boolean {
        synchronized(STORE_LOCK) {
            migrateTtl(now)
            if (prefs.getString(KEY_AGENTD_TOKEN, "").isNullOrBlank()) return false
            if (!isSlotStale(now)) return true
            val machine = prefs.getString(KEY_AGENTD_MACHINE_ID, null)
            signOutAgentd(now)
            // The whole record signs out, both transports.
            machine?.takeIf { prefs.getString(machineKey(it), null) != null }?.let { signOutMachine(it, now) }
            return false
        }
    }

    /** Computers signed out and not yet added again, most recent first. */
    fun signedOut(): List<SignedOut> = prefs.all.keys
        .filter { it.startsWith(KEY_SIGNED_OUT_PREFIX) }
        .map { key ->
            val name = key.removePrefix(KEY_SIGNED_OUT_PREFIX)
            SignedOut(
                name = name,
                atMs = prefs.getLong(key, 0L),
                unusedDays = prefs.getInt("$KEY_SIGNED_OUT_DAYS_PREFIX$name", pairingTtlDays()),
            )
        }
        .sortedWith(compareByDescending<SignedOut> { it.atMs }.thenBy { it.name })

    fun clearSignedOut(name: String) {
        prefs.edit().also { removeSignedOut(it, name) }.apply()
    }

    private fun removeSignedOut(editor: SharedPreferences.Editor, name: String) {
        editor.remove("$KEY_SIGNED_OUT_PREFIX$name").remove("$KEY_SIGNED_OUT_DAYS_PREFIX$name")
    }

    /**
     * The first run of the TTL stamps every pairing that has no timestamp with [now], so nothing
     * paired before the upgrade is signed out at once. Marked by [KEY_TTL_MIGRATED]; once only.
     */
    private fun migrateTtl(now: Long) {
        if (prefs.getBoolean(KEY_TTL_MIGRATED, false)) return
        prefs.edit().apply {
            if (!prefs.getString(KEY_AGENTD_TOKEN, "").isNullOrBlank() && !prefs.contains(KEY_AGENTD_LAST_USED)) {
                putLong(KEY_AGENTD_LAST_USED, now)
            }
            prefs.all.keys.filter { it.startsWith(KEY_MACHINE_PREFIX) }
                .map { it.removePrefix(KEY_MACHINE_PREFIX) }
                .filter { prefs.getLong("$KEY_MACHINE_SEEN_PREFIX$it", 0L) <= 0L }
                .forEach { putLong("$KEY_MACHINE_SEEN_PREFIX$it", now) }
            putBoolean(KEY_TTL_MIGRATED, true)
        }.apply()
    }

    /**
     * One pairing, one TTL (6a-R3): a record's last use is the later of its two transports', so a
     * machine still in use over wss keeps its PhoneLink trust, and the other way round.
     */
    private fun isMachineStale(machineId: String, now: Long): Boolean =
        isStale("$KEY_MACHINE_SEEN_PREFIX$machineId", now) &&
            (prefs.getString(KEY_AGENTD_MACHINE_ID, null) != machineId ||
                prefs.getString(KEY_AGENTD_TOKEN, "").isNullOrBlank() ||
                isStale(KEY_AGENTD_LAST_USED, now))

    private fun isSlotStale(now: Long): Boolean {
        if (!isStale(KEY_AGENTD_LAST_USED, now)) return false
        val machine = prefs.getString(KEY_AGENTD_MACHINE_ID, null) ?: return true
        return prefs.getString(machineKey(machine), null) == null || isStale("$KEY_MACHINE_SEEN_PREFIX$machine", now)
    }

    /**
     * A last use in the future (the clock went back, or a bad write) is clamped to [now]: it is
     * not a reason to sign out, and it must not hold a pairing open past the TTL either. After
     * the one-time migration a pairing with no timestamp at all counts as never used.
     */
    private fun isStale(lastUsedKey: String, now: Long): Boolean {
        val last = prefs.getLong(lastUsedKey, 0L)
        if (last > now) {
            prefs.edit().putLong(lastUsedKey, now).apply()
            return false
        }
        return now - last > pairingTtlDays() * DAY_MS
    }

    private fun unusedDays(lastUsedKey: String, now: Long): Int =
        ((now - prefs.getLong(lastUsedKey, 0L)) / DAY_MS).coerceIn(pairingTtlDays().toLong(), 36_500L).toInt()

    private fun signOutAgentd(now: Long): SignedOut {
        val name = prefs.getString(KEY_AGENTD_NAME, null)?.takeIf(String::isNotBlank)
            ?: prefs.getString(KEY_AGENTD_HOST, "").orEmpty()
        val signedOut = SignedOut(name, now, unusedDays(KEY_AGENTD_LAST_USED, now))
        prefs.edit()
            .remove(KEY_AGENTD_TOKEN)
            .remove(KEY_AGENTD_FP)
            .remove(KEY_AGENTD_STEER)
            .remove(KEY_AGENTD_ALT_HOSTS)
            .remove(KEY_AGENTD_LAST_USED)
            .remove(KEY_AGENTD_MACHINE_ID)
            .remove(v2SeenKey(DIALLED))
            .putLong("$KEY_SIGNED_OUT_PREFIX$name", now)
            .putInt("$KEY_SIGNED_OUT_DAYS_PREFIX$name", signedOut.unusedDays)
            .apply()
        return signedOut
    }

    private fun signOutMachine(machineId: String, now: Long): SignedOut {
        val name = prefs.getString("$KEY_MACHINE_NAME_PREFIX$machineId", null)?.takeIf(String::isNotBlank) ?: machineId
        val signedOut = SignedOut(name, now, unusedDays("$KEY_MACHINE_SEEN_PREFIX$machineId", now))
        forgetMachine(machineId)
        prefs.edit()
            .putLong("$KEY_SIGNED_OUT_PREFIX$name", now)
            .putInt("$KEY_SIGNED_OUT_DAYS_PREFIX$name", signedOut.unusedDays)
            .apply()
        return signedOut
    }

    /**
     * Records that the monitor's heartbeat ran, and reports whether the gap
     * since the previous one is too long to be ordinary lateness — see
     * [AgentsFreezeWatch]. The verdict is sticky: the wearer needs to see that
     * the phone froze the app at some point, not only that it is running in the
     * instant they happen to open the screen.
     */
    fun recordMonitorHeartbeat(intervalMs: Long, now: Long = elapsedRealtime()): Boolean {
        synchronized(STORE_LOCK) {
            val previous = prefs.getLong(KEY_HEARTBEAT_AT, 0L)
            val suspended = previous > 0L &&
                AgentsFreezeWatch.wasSuspended(intervalMs, now - previous)
            prefs.edit().apply {
                putLong(KEY_HEARTBEAT_AT, now)
                if (suspended) putBoolean(KEY_WAS_SUSPENDED, true)
            }.apply()
            return suspended
        }
    }

    /** Whether this install has ever caught the system freezing it. */
    fun monitorWasSuspended(): Boolean = prefs.getBoolean(KEY_WAS_SUSPENDED, false)

    /** Clears the verdict so a fix can be seen to work rather than only claimed. */
    fun clearMonitorSuspension() {
        synchronized(STORE_LOCK) {
            prefs.edit().remove(KEY_WAS_SUSPENDED).remove(KEY_HEARTBEAT_AT).apply()
        }
    }

    /** The sticky v2-seen flags (R92) went with the monitor-only link; their keys are only cleared now. */
    private fun v2SeenKey(key: String) = "$KEY_V2_SEEN_PREFIX$key"

    /**
     * The computer, over a pinned link that [fp] names, says where else it can be reached. Replaces
     * only the alternate addresses of the pairing that pin belongs to: never the primary host, the
     * pin or any credential. False, with nothing written, when nothing changed or it is not that pairing.
     *
     * A frame naming another [port] is dropped whole: the saved port stays what we dial, so hosts
     * learned for a different port would only add addresses that cannot answer.
     */
    fun learnAltHosts(fp: String, hosts: List<String>, port: Int?): Boolean {
        synchronized(STORE_LOCK) {
            val current = load().agentd ?: return false
            val pin = (CertPins.parse(fp) as? PinParse.Valid)?.fp ?: return false
            if ((CertPins.parse(current.fp) as? PinParse.Valid)?.fp != pin) return false
            if (port != null && port != current.port) return false
            val learned = EndpointHosts.without(EndpointHosts.clean(hosts), current.host)
            if (learned == current.altHosts) return false
            val edit = prefs.edit()
            EndpointHosts.encode(learned)?.let { edit.putString(KEY_AGENTD_ALT_HOSTS, it) } ?: edit.remove(KEY_AGENTD_ALT_HOSTS)
            edit.apply()
            return true
        }
    }

    // ------------------------------------------------------------ one pairing per computer (6a-R3)

    /**
     * Stores what a confirmed SAS session handed over as ONE atomic write (6a-R4′, step 2): the
     * record, the outbound slot and the PhoneLink machine trust land together or not at all. False
     * when the write did not reach the disk; the phone then tells agentd `pair_abort storage`.
     *
     * Android's commit() changes the in-memory map before it learns the disk write failed, and
     * every admission check reads that map. So the write and, on failure, the restoring of exactly
     * what was there happen under [STORE_LOCK], which every admission read takes too: nothing ever
     * admits a link, or dials, on a pairing that is not on disk.
     */
    fun commitPairing(record: PairingRecord, now: Long = wallClock()): Boolean {
        synchronized(STORE_LOCK) {
            val id = record.machineId
            val writes = linkedMapOf<String, Any?>(
                "$KEY_PAIRING_RECORD_PREFIX$id" to record.toJson(),
                KEY_AGENTD_HOST to record.wsHost,
                KEY_AGENTD_PORT to record.wsPort,
                KEY_AGENTD_TOKEN to record.token,
                KEY_AGENTD_NAME to record.machineName,
                KEY_AGENTD_FP to record.agentdFp,
                KEY_AGENTD_STEER to record.steer,
                KEY_AGENTD_ALT_HOSTS to EndpointHosts.encode(EndpointHosts.without(record.wsHosts, record.wsHost)),
                KEY_AGENTD_MACHINE_ID to id,
                KEY_AGENTD_LAST_USED to now,
                v2SeenKey(DIALLED) to null,
                machineKey(id) to record.token,
                "$KEY_MACHINE_NAME_PREFIX$id" to record.machineName,
                "$KEY_MACHINE_SEEN_PREFIX$id" to now,
                "$KEY_MACHINE_CERT_PREFIX$id" to record.agentdFp,
                v2SeenKey(id) to null,
                "$KEY_SIGNED_OUT_PREFIX${record.machineName}" to null,
                "$KEY_SIGNED_OUT_DAYS_PREFIX${record.machineName}" to null,
                // The door did its job.
                KEY_LINK_WINDOW_DEADLINE to null,
            )
            val current = prefs.all
            val before = writes.keys.associateWith { current[it] }
            if (prefs.edit().putAll(writes).commit()) return true
            // Memory took the write, the disk did not: put memory back as the disk still has it.
            prefs.edit().putAll(before).commit()
            return false
        }
    }

    private fun SharedPreferences.Editor.putAll(values: Map<String, Any?>): SharedPreferences.Editor = apply {
        values.forEach { (key, value) ->
            when (value) {
                null -> remove(key)
                is String -> putString(key, value)
                is Int -> putInt(key, value)
                is Long -> putLong(key, value)
                is Boolean -> putBoolean(key, value)
                is Float -> putFloat(key, value)
                else -> error("unexpected preference type for $key")
            }
        }
    }

    /** The pairing whose agentd cert is [agentdFp]: what a PhoneLink commit proof is answered from. */
    fun pairingRecordForCert(agentdFp: String): PairingRecord? {
        synchronized(STORE_LOCK) {
            val pin = (CertPins.parse(agentdFp) as? PinParse.Valid)?.fp ?: return null
            return prefs.all.keys
                .filter { it.startsWith(KEY_PAIRING_RECORD_PREFIX) }
                .mapNotNull { PairingRecord.fromJson(prefs.getString(it, null)) }
                .firstOrNull { it.agentdFp == pin && isClientCertPinned(it.machineId, pin) }
        }
    }

    /** The computer whose outbound slot this is, when a SAS pairing made it. */
    fun slotMachineId(): String? = synchronized(STORE_LOCK) { prefs.getString(KEY_AGENTD_MACHINE_ID, null) }

    /**
     * agentd refused the outbound slot's hello: the whole pairing it belongs to goes, its PhoneLink
     * trust and its slot, so no restart can dial those credentials again without a new SAS pairing.
     * A slot no SAS pairing made goes too. Returns the machine whose pairing went, if any; the
     * caller then ends that machine's live links on both transports.
     */
    fun revokeRefusedPairing(): String? = synchronized(STORE_LOCK) {
        val machineId = slotMachineId()
        if (machineId != null) forgetPairing(machineId) else saveAgentd(null, load().agentdEnabled)
        machineId
    }

    /** Forgets the whole pairing: its PhoneLink trust, and its outbound slot when the slot is its own. */
    fun forgetPairing(machineId: String) {
        synchronized(STORE_LOCK) {
            val slotIsIts = slotBelongsTo(machineId)
            forgetMachine(machineId)
            if (slotIsIts) saveAgentd(null, load().agentdEnabled)
        }
    }

    /** Whether the outbound slot is this machine's: its own id, or the certificate pin its pairing recorded. */
    fun slotBelongsTo(machineId: String): Boolean = synchronized(STORE_LOCK) {
        val record = PairingRecord.fromJson(prefs.getString("$KEY_PAIRING_RECORD_PREFIX$machineId", null))
        slotMachineId() == machineId ||
            (record != null && prefs.getString(KEY_AGENTD_FP, null) == record.agentdFp)
    }

    fun forgetMachine(machineId: String) {
        prefs.edit()
            .remove("$KEY_PAIRING_RECORD_PREFIX$machineId")
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
                    it.startsWith(KEY_PAIRING_RECORD_PREFIX) ||
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

    /**
     * What the OpenClaw provider and the v1 attention band left behind: the
     * gateway's settings, its device key and token, and one fingerprint per
     * session ever announced. Nothing reads them any more; a no-op once gone.
     */
    fun clearRetiredKeys() {
        val retired = prefs.all.keys.filter {
            it.startsWith(RETIRED_OPENCLAW_PREFIX) || it.startsWith(RETIRED_NOTIFICATION_PREFIX)
        }
        if (retired.isEmpty()) return
        prefs.edit().apply { retired.forEach(::remove) }.apply()
    }

    private companion object {
        /**
         * One lock for every store over the prefs file, wherever it was made: a pairing's write and
         * every check that admits on it never interleave.
         */
        val STORE_LOCK = Any()
        const val PREFS = "nexus_plugin_agents"
        const val KEY_AGENTD_ENABLED = "agentd.enabled"
        const val KEY_AGENTD_HOST = "agentd.host"
        const val KEY_AGENTD_PORT = "agentd.port"
        const val KEY_AGENTD_TOKEN = "agentd.token"
        const val KEY_AGENTD_NAME = "agentd.name"
        const val KEY_AGENTD_FP = "agentd.fp"
        const val KEY_AGENTD_STEER = "agentd.steer"
        const val KEY_AGENTD_ALT_HOSTS = "agentd.alt_hosts"
        const val KEY_AGENTD_LAST_USED = "agentd.last_used_at"
        const val KEY_AGENTD_MACHINE_ID = "agentd.machine_id"
        const val KEY_PAIRING_RECORD_PREFIX = "pairing.record."
        const val KEY_PAIRING_TTL_DAYS = "security.pairing_ttl_days"
        const val KEY_HISTORY_KEEP_AFTER_SESSION = "history.keep_after_session"
        const val KEY_HISTORY_WINDOW_HOURS = "history.window_hours"
        const val KEY_VOICE_WORD_LIMIT = "voice.word_limit"
        const val KEY_TTL_MIGRATED = "security.ttl_migrated"
        const val KEY_SIGNED_OUT_PREFIX = "signed_out."
        const val KEY_SIGNED_OUT_DAYS_PREFIX = "signed_out_days."
        const val RETIRED_OPENCLAW_PREFIX = "openclaw."
        const val RETIRED_NOTIFICATION_PREFIX = "notification."
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

private const val DAY_MS = 24L * 60L * 60L * 1000L
private const val HOUR_MS = 60L * 60L * 1000L

/** What Sign out unused computers offers, in days. */
val PAIRING_TTL_CHOICES: List<Int> = listOf(3, 7, 14, 30, 90)
const val DEFAULT_PAIRING_TTL_DAYS = 14

/** What Voice reply length shown offers, in words. */
val VOICE_WORD_LIMIT_CHOICES: List<Int> = listOf(100, 150, 250, 500)

/** What History window offers, in hours. */
val HISTORY_WINDOW_CHOICES: List<Int> = listOf(1, 4, 12, 24)
const val DEFAULT_HISTORY_WINDOW_HOURS = 24
