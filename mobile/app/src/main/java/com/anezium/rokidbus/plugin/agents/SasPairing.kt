package com.anezium.rokidbus.plugin.agents

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * The commit-then-reveal code (R1′), byte for byte as agentd computes it (`pairing/sas.ts`; both
 * are held to `contracts/sas-vectors.json`):
 *
 *   C     = SHA-256("rokid-sas-v1" ‖ Nc ‖ agentdFp ‖ phoneFp)
 *   code  = first 20 bits of SHA-256("rokid-sas-v1" ‖ Nc ‖ Np ‖ agentdFp ‖ phoneFp), mod 10^6
 *   proof = HMAC-SHA256(key = steer, "rokid-commit-v1" ‖ attempt ‖ agentdFp ‖ phoneFp)
 *
 * Nonces are 32 raw bytes, 64 lowercase hex digits on the wire; every string enters as UTF-8.
 */
object SasPairing {
    private const val LABEL = "rokid-sas-v1"
    private const val PROOF_LABEL = "rokid-commit-v1"
    const val NONCE_BYTES = 32

    fun commit(nc: ByteArray, agentdFp: String, phoneFp: String): String = hex(
        MessageDigest.getInstance("SHA-256").run {
            update(LABEL.toByteArray(Charsets.UTF_8))
            update(nc)
            update(agentdFp.toByteArray(Charsets.UTF_8))
            update(phoneFp.toByteArray(Charsets.UTF_8))
            digest()
        },
    )

    fun code(nc: ByteArray, np: ByteArray, agentdFp: String, phoneFp: String): String {
        val digest = MessageDigest.getInstance("SHA-256").run {
            update(LABEL.toByteArray(Charsets.UTF_8))
            update(nc)
            update(np)
            update(agentdFp.toByteArray(Charsets.UTF_8))
            update(phoneFp.toByteArray(Charsets.UTF_8))
            digest()
        }
        val first20 = ((digest[0].toInt() and 0xff) shl 12) or ((digest[1].toInt() and 0xff) shl 4) or
            ((digest[2].toInt() and 0xff) ushr 4)
        return "%06d".format(first20 % 1_000_000)
    }

    fun proof(steer: String, attempt: String, agentdFp: String, phoneFp: String): String = hex(
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(steer.toByteArray(Charsets.UTF_8), "HmacSHA256"))
            update(PROOF_LABEL.toByteArray(Charsets.UTF_8))
            update(attempt.toByteArray(Charsets.UTF_8))
            update(agentdFp.toByteArray(Charsets.UTF_8))
            update(phoneFp.toByteArray(Charsets.UTF_8))
            doFinal()
        },
    )

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** The bytes of exactly 64 lowercase hex digits, or null. */
    fun unhex(text: String?): ByteArray? {
        if (text == null || !NONCE_HEX.matches(text)) return null
        return ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }

    internal fun isAttemptId(value: String?): Boolean = value != null && ATTEMPT_ID.matches(value)

    private val NONCE_HEX = Regex("[0-9a-f]{64}")
    private val ATTEMPT_ID = Regex("[0-9a-f]{16}")
}

enum class AttemptState { IDLE, WINDOW_OPEN, PEER_TLS, COMMIT_SENT, NONCE_RECEIVED, REVEALED, AWAITING_CONFIRM, PINNED, ABORTED }

/** What the phone UI and the glasses card show of the attempt in progress (6a-R5). */
data class AttemptView(val attempt: String, val state: AttemptState, val code: String?, val peerName: String) {
    // The code is for a screen, never for a log line.
    override fun toString(): String = "AttemptView(attempt=$attempt, state=$state, peer=$peerName)"
}

/** A `pair-ready` announcement: where agentd's wss waits for a phone on its pairing screen. No secret. */
data class PairReady(val machineName: String, val host: String, val wsPort: Int, val attempt: String) {
    companion object {
        fun parse(text: String): PairReady? {
            val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
            if (json.optString("nexus") != "agentd-pair-ready" || json.optInt("v") != 1) return null
            val host = json.optString("host").takeIf { it.isNotBlank() && it.length <= MAX_HOST_CHARS } ?: return null
            val port = json.optInt("wsPort", -1).takeIf { it in 1..65535 } ?: return null
            val attempt = json.optString("attempt").takeIf(SasPairing::isAttemptId) ?: return null
            return PairReady(json.optString("machineName").take(MAX_HUD_LABEL_CHARS).ifBlank { host }, host, port, attempt)
        }
    }
}

/**
 * The phone's one SAS attempt at a time, for both transports (6a-R5). The phone UI and the
 * glasses card are its only callers of [confirm]: a frame from the network never confirms for the
 * phone's human, which is what makes the pairing need a person at the phone.
 */
open class PairingAttemptsModel internal constructor(
    private val clock: () -> Long,
    window: (() -> Boolean)? = null,
) {
    /**
     * Spends the phone's pairing window and says whether it was open. The first commitment on
     * either transport calls it, so one window is one attempt: after an abort, a disconnect or a
     * second peer it stays shut until the wearer opens it again. Unset, it is shut.
     */
    @Volatile var window: (() -> Boolean)? = window

    private val _state = MutableStateFlow<AttemptView?>(null)
    val state: StateFlow<AttemptView?> = _state.asStateFlow()

    private var current: SasResponder? = null
    private val seenPairReady = HashSet<String>()
    private var lastPairReadyAt = Long.MIN_VALUE

    /** True while onboarding's pairing step or Add a computer is on screen. */
    @Volatile var pairingScreenOpen: Boolean = false

    /** The human's answer on the phone (or the glasses, through the phone). A stale attempt id is a no-op. */
    fun confirm(attempt: String, ok: Boolean) {
        val responder = synchronized(this) { current?.takeIf { it.attempt == attempt } } ?: return
        responder.localConfirm(ok)
    }

    /**
     * The answer to exactly what a screen drew: [shown] must still be the attempt in progress,
     * with the same code. False, and nothing sent, when another attempt (even one reusing the id)
     * has taken its place since.
     */
    fun confirm(shown: AttemptView, ok: Boolean): Boolean {
        val responder = synchronized(this) {
            current?.takeIf { shown.code != null && it.attempt == shown.attempt && _state.value == shown }
        } ?: return false
        responder.localConfirm(ok)
        return true
    }

    /**
     * A `pair-ready` announcement is acted on only while a pairing screen is open, once per
     * attempt, and at most one window per [PAIR_READY_SPACING_MS].
     */
    @Synchronized
    fun acceptPairReady(ready: PairReady): Boolean {
        if (!pairingScreenOpen || ready.attempt in seenPairReady) return false
        val now = clock()
        if (lastPairReadyAt != Long.MIN_VALUE && now - lastPairReadyAt < PAIR_READY_SPACING_MS) return false
        seenPairReady += ready.attempt
        lastPairReadyAt = now
        return true
    }

    /**
     * A commitment arrived on [responder]'s session. False when another attempt is running (both
     * end), or when the window is shut: it is spent here, by the first commitment on either
     * transport, and only the wearer opens another.
     */
    @Synchronized
    internal fun begin(responder: SasResponder): Boolean {
        val running = current?.takeIf { it !== responder && it.active }
        if (running != null) {
            running.abort("second_peer")
            return false
        }
        if (window?.invoke() != true) return false
        current = responder
        return true
    }

    @Synchronized
    internal fun publish(responder: SasResponder, view: AttemptView) {
        if (current === responder || current == null) _state.value = view
    }

    @Synchronized
    internal fun clear() {
        current = null
        _state.value = null
    }

    companion object {
        const val PAIR_READY_SPACING_MS = 30_000L
    }
}

/** The process's attempts: the phone UI and the glasses card confirm here. The service sets its [window]. */
object PairingAttempts : PairingAttemptsModel(System::currentTimeMillis)

/**
 * What one screen drew of the attempt, so its Confirm and Cancel answer that attempt and code and
 * never one that replaced it before the screen redrew (6a-R5).
 */
internal class ShownAttempt(private val attempts: PairingAttemptsModel = PairingAttempts) {
    @Volatile var view: AttemptView? = null
        private set

    /** Records what is being drawn; returns the code to show, or null when there is none to confirm. */
    fun render(view: AttemptView?): String? {
        val awaiting = view?.takeIf { it.state == AttemptState.AWAITING_CONFIRM && it.code != null }
        this.view = awaiting
        return awaiting?.code
    }

    fun confirm(ok: Boolean): Boolean = view?.let { attempts.confirm(it, ok) } ?: false
}

/**
 * One SAS session from the phone's side, on a TLS session whose two certificates the handshake
 * fixed. agentd commits first; the phone sends its nonce only after the commitment, checks the
 * reveal against it, and confirms only through [PairingAttemptsModel.confirm]. Credentials are
 * accepted only once both sides confirmed, stored as one atomic record, and acknowledged with
 * `pair_committed` (6a-R4′).
 */
internal class SasResponder(
    private val attempts: PairingAttemptsModel,
    private val agentdFp: String,
    private val phoneFp: String,
    private val peerName: String,
    private val send: (String) -> Unit,
    private val store: (PairingRecord) -> Boolean,
    private val close: () -> Unit,
    private val onPaired: (PairingRecord) -> Unit = {},
    private val random: SecureRandom = SecureRandom(),
) {
    @Volatile var attempt: String = ""
        private set

    private var state = AttemptState.PEER_TLS
    private var commitment: String? = null
    private var np: ByteArray? = null
    private var code: String? = null
    private var localConfirmed = false
    private var remoteConfirmed = false
    private var stored: PairingRecord? = null

    val active: Boolean @Synchronized get() = state != AttemptState.PINNED && state != AttemptState.ABORTED

    @Synchronized
    fun receive(line: String) {
        val json = runCatching { JSONObject(line) }.getOrNull()
        val type = json?.optString("type").orEmpty()
        if (json == null || type !in FRAME_TYPES) {
            // Before the pins nothing but SAS frames; after them, nothing else either.
            if (active) abort("out_of_order")
            return
        }
        val frameAttempt = json.optString("attempt")
        if (state == AttemptState.PEER_TLS) {
            // A session opens with agentd's commitment, and with nothing else.
            if (type != "sas_commit" || !SasPairing.isAttemptId(frameAttempt)) return abort("out_of_order")
            attempt = frameAttempt
            return onCommit(json)
        }
        // Another attempt's frame: not this session's business.
        if (frameAttempt != attempt || state == AttemptState.ABORTED) return
        when (type) {
            "sas_commit" -> abort("second_commit")
            "sas_reveal" -> onReveal(json)
            "sas_confirm" -> onRemoteConfirm(json)
            "pair_credentials" -> onCredentials(json)
            "pair_abort" -> abort(json.optString("reason").ifBlank { "cancel" }, tell = false)
            else -> if (active) abort("out_of_order")
        }
    }

    @Synchronized
    fun disconnected() {
        if (active) abort("disconnect", tell = false)
    }

    @Synchronized
    internal fun localConfirm(ok: Boolean) {
        if (state != AttemptState.AWAITING_CONFIRM) return
        if (!ok) {
            send(frame("sas_confirm").put("ok", false).toString())
            return abort("mismatch", tell = false)
        }
        if (localConfirmed) return
        localConfirmed = true
        send(frame("sas_confirm").put("ok", true).toString())
        maybePin()
    }

    @Synchronized
    internal fun abort(reason: String, tell: Boolean = true) {
        if (state == AttemptState.ABORTED) return
        if (tell && attempt.isNotEmpty()) send(frame("pair_abort").put("reason", reason).toString())
        np = null
        move(AttemptState.ABORTED)
        close()
    }

    private fun onCommit(json: JSONObject) {
        val c = json.optString("c").takeIf { SasPairing.unhex(it) != null } ?: return abort("out_of_order")
        if (!attempts.begin(this)) {
            return abort("second_peer")
        }
        commitment = c
        move(AttemptState.COMMIT_SENT)
        // Blind: the phone's nonce goes out only after agentd is bound to its own.
        val nonce = ByteArray(SasPairing.NONCE_BYTES).also(random::nextBytes)
        np = nonce
        send(frame("sas_nonce").put("np", SasPairing.hex(nonce)).toString())
        move(AttemptState.NONCE_RECEIVED)
    }

    private fun onReveal(json: JSONObject) {
        if (state != AttemptState.NONCE_RECEIVED) return abort("out_of_order")
        val nc = SasPairing.unhex(json.optString("nc")) ?: return abort("bad_reveal")
        val nonce = np ?: return abort("out_of_order")
        if (!MessageDigest.isEqual(SasPairing.commit(nc, agentdFp, phoneFp).toByteArray(), commitment.orEmpty().toByteArray())) {
            return abort("bad_reveal")
        }
        move(AttemptState.REVEALED)
        code = SasPairing.code(nc, nonce, agentdFp, phoneFp)
        np = null
        move(AttemptState.AWAITING_CONFIRM)
    }

    private fun onRemoteConfirm(json: JSONObject) {
        if (state == AttemptState.PINNED) return
        if (state != AttemptState.AWAITING_CONFIRM || !json.has("ok")) return abort("out_of_order")
        if (!json.optBoolean("ok")) return abort("mismatch", tell = false)
        // agentd's half only: it never stands in for the phone's own human.
        remoteConfirmed = true
        maybePin()
    }

    private fun maybePin() {
        if (localConfirmed && remoteConfirmed && state == AttemptState.AWAITING_CONFIRM) move(AttemptState.PINNED)
    }

    private fun onCredentials(json: JSONObject) {
        if (state != AttemptState.PINNED) return abort("out_of_order")
        val record = PairingRecord.fromCredentials(json, agentdFp, attempt) ?: return abort("out_of_order")
        // The same frame again (a resend) is the same record: writing it again changes nothing.
        if (stored != record) {
            if (!store(record)) return abort("storage")
            stored = record
            onPaired(record)
        }
        send(frame("pair_committed").toString())
        // Both close the pairing session; normal links reconnect with today's admission.
        close()
    }

    private fun frame(type: String): JSONObject = JSONObject().put("type", type).put("v", 2).put("attempt", attempt)

    private fun move(next: AttemptState) {
        state = next
        val shown = code.takeIf { next == AttemptState.AWAITING_CONFIRM || next == AttemptState.PINNED }
        attempts.publish(this, AttemptView(attempt, next, shown, peerName))
    }

    override fun toString(): String = "SasResponder(attempt=$attempt, state=$state)"

    private companion object {
        val FRAME_TYPES = setOf("sas_commit", "sas_reveal", "sas_confirm", "pair_credentials", "pair_abort", "sas_nonce", "pair_committed")
    }
}

/**
 * What the PhoneLink listener needs to pair: whether the door is open, this phone's own
 * fingerprint, the one atomic store write, and the record a commit proof is answered from.
 */
class SasDoor(
    val open: () -> Boolean,
    val attempts: PairingAttemptsModel,
    val phoneFingerprint: () -> String,
    val commit: (PairingRecord) -> Boolean,
    val recordForCert: (String) -> PairingRecord?,
    val onPaired: (PairingRecord) -> Unit = {},
    val onPairReady: (PairReady) -> Unit = {},
    /**
     * While the window is shut: what opens one for an announcement, or null. Only onboarding's
     * pairing screen sets one (§13.5); Add a computer waits for the wearer's tap.
     */
    val pairReadyOpener: () -> (() -> Boolean)? = { null },
)

/**
 * The phone dialling agentd's wss for a SAS session, from a `pair-ready` announcement or a v2
 * pairing line. The cert is unpinned (or held to the line's fp), and only SAS frames travel.
 */
internal class SasWssDialer(
    private val base: OkHttpClient,
    private val identity: PhoneTlsIdentity,
    private val attempts: PairingAttemptsModel,
    private val commit: (PairingRecord) -> Boolean,
    private val onPaired: (PairingRecord) -> Unit,
) {
    /**
     * [lineHosts] are the pairing line's own list of addresses: they stand in for the credentials' `wsHosts` when
     * the computer sent none, and never replace a list it did send.
     */
    fun dial(host: String, port: Int, expectedFp: String?, peerName: String, lineHosts: List<String> = emptyList()) {
        val pin = expectedFp?.let { (CertPins.parse(it) as? PinParse.Valid)?.fp }
        val trust = sessionTrust(pin)
        val context = SSLContext.getInstance("TLS").apply { init(arrayOf(identity.keyManager()), arrayOf(trust), null) }
        val client = base.newBuilder()
            .sslSocketFactory(context.socketFactory, trust)
            // The cert names no host; it is held by its fingerprint, from the handshake, instead.
            .hostnameVerifier { _, _ -> true }
            .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
            .followRedirects(false)
            .followSslRedirects(false)
            .build()
        val request = Request.Builder().url(webSocketUrl(host, port, secure = true)).build()
        client.newWebSocket(request, object : WebSocketListener() {
            private var responder: SasResponder? = null

            override fun onOpen(webSocket: WebSocket, response: Response) {
                val agentdFp = response.handshake?.peerCertificates?.firstOrNull()?.let { CertPins.fingerprint256(it.encoded) }
                if (agentdFp == null) {
                    webSocket.cancel()
                    return
                }
                responder = SasResponder(
                    attempts = attempts,
                    agentdFp = agentdFp,
                    phoneFp = identity.fingerprint256(),
                    peerName = peerName,
                    send = { line -> webSocket.send(line) },
                    store = { record -> commit(record.withLineHosts(lineHosts)) },
                    close = { webSocket.close(1000, null) },
                    onPaired = { record -> onPaired(record.withLineHosts(lineHosts)) },
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                responder?.receive(text) ?: webSocket.cancel()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                responder?.disconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                responder?.disconnected()
            }
        })
    }

    /** Any server cert, or only [pin]'s: the SAS code, not a chain, is what authenticates this session. */
    private fun sessionTrust(pin: String?): X509TrustManager = object : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            throw CertificateException("client certificates are not trusted here")
        }

        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
            val leaf = chain?.firstOrNull() ?: throw CertificateException("no server certificate")
            if (pin != null && !CertPins.matches(leaf, pin)) throw PinMismatchException()
        }

        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}

private fun PairingRecord.withLineHosts(lineHosts: List<String>): PairingRecord =
    if (wsHosts.isNotEmpty() || lineHosts.isEmpty()) this else copy(wsHosts = lineHosts)
