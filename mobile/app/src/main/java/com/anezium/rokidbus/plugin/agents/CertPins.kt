package com.anezium.rokidbus.plugin.agents

import okhttp3.ConnectionSpec
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.cert.Certificate
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Locale
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import javax.net.ssl.X509TrustManager

sealed interface PinParse {
    data object Absent : PinParse
    data class Valid(val fp: String) : PinParse
    data object Malformed : PinParse
}

/** The peer's certificate is not the one pinned. */
class PinMismatchException : CertificateException("certificate does not match the pin")

/**
 * Whole-certificate pins in the form agentd writes them: Node's
 * `fingerprint256`, the SHA-256 of the DER certificate as colon-separated
 * upper-case hex.
 */
object CertPins {
    fun fingerprint256(der: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(der).joinToString(":") { "%02X".format(it) }

    /** Normalised like agentd's `normalizeFingerprint`: colons and case do not matter, the 64 digits do. */
    fun parse(fp: String?): PinParse {
        if (fp == null) return PinParse.Absent
        val hex = fp.replace(":", "").uppercase(Locale.ROOT)
        if (!HEX_SHA256.matches(hex)) return PinParse.Malformed
        return PinParse.Valid(hex.chunked(2).joinToString(":"))
    }

    fun matches(cert: Certificate?, pin: String): Boolean {
        val der = runCatching { cert?.encoded }.getOrNull() ?: return false
        return MessageDigest.isEqual(
            fingerprint256(der).toByteArray(Charsets.US_ASCII),
            pin.toByteArray(Charsets.US_ASCII),
        )
    }

    /**
     * Trusts exactly one leaf certificate and nothing else: no chain, no CA, no
     * dates. agentd's certificate is self-signed, so the pin is the identity.
     */
    fun trustManager(expected: String): X509TrustManager {
        val pin = (parse(expected) as? PinParse.Valid)?.fp
            ?: throw IllegalArgumentException("not a SHA-256 certificate fingerprint")
        return object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                throw CertificateException("client certificates are not trusted here")
            }

            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                if (!matches(chain?.firstOrNull(), pin)) throw PinMismatchException()
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
    }

    /** The first 16 hex digits in groups of four: what agentd's R60 log line and `phones list` show. */
    fun display(fp: String): String =
        fp.replace(":", "").uppercase(Locale.ROOT).take(16).chunked(4).joinToString(" ")

    /** True when [failure] is the pinned peer presenting a different certificate. */
    fun isPinMismatch(failure: Throwable): Boolean =
        generateSequence(failure) { it.cause }.take(16).any {
            it is PinMismatchException || it is SSLPeerUnverifiedException
        }

    fun isTlsFailure(failure: Throwable): Boolean =
        generateSequence(failure) { it.cause }.take(16).any { it is SSLException }

    private val HEX_SHA256 = Regex("[0-9A-F]{64}")
}

/**
 * A client for one pinned agentd, built apart from [base] so nothing here leaks
 * into the shared client. agentd's self-signed certificate names no host, LAN
 * or Tailscale, so the hostname check is replaced by the pin itself, on this
 * client only. No cleartext spec: a `ws://` URL cannot even be attempted. No
 * redirects either: the link goes to the pinned peer's URL and nowhere else.
 * The handshake presents [identity] as the client certificate, which agentd
 * pins per phone (R168).
 */
internal fun pinnedOkHttpClient(base: OkHttpClient, pin: String, identity: PhoneTlsIdentity): OkHttpClient {
    val trust = CertPins.trustManager(pin)
    val context = SSLContext.getInstance("TLS").apply { init(arrayOf(identity.keyManager()), arrayOf(trust), null) }
    return base.newBuilder()
        .sslSocketFactory(context.socketFactory, trust)
        .hostnameVerifier { _, session ->
            CertPins.matches(runCatching { session.peerCertificates.firstOrNull() }.getOrNull(), pin)
        }
        .connectionSpecs(listOf(ConnectionSpec.MODERN_TLS))
        .followRedirects(false)
        .followSslRedirects(false)
        // One address of several must not hold up the rest: a LAN address from mobile data just goes unanswered.
        .connectTimeout(DIAL_CONNECT_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
        .build()
}
