package com.anezium.rokidbus.plugin.agents

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.math.BigInteger
import java.net.Socket
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager
import javax.security.auth.x500.X500Principal

/**
 * The phone's one TLS identity: the server certificate on the link agentd
 * dials, and the client certificate on the wss link the phone dials. agentd
 * pins this certificate on both (R45, R168), so it must stay the same across
 * restarts.
 */
interface PhoneTlsIdentity {
    fun sslContext(): SSLContext
    fun fingerprint256(): String

    /** The same key and certificate, for the wss dial's client authentication. */
    fun keyManager(): X509ExtendedKeyManager
}

/**
 * An EC P-256 key that never leaves AndroidKeyStore, with the self-signed
 * certificate the keystore makes for it (CN rokid-coder-phone, ten years).
 * Generated on first use and then kept under [alias].
 */
class KeystorePhoneTlsIdentity(private val alias: String = DEFAULT_ALIAS) : PhoneTlsIdentity {
    override fun sslContext(): SSLContext {
        val entry = entry()
        return serverSslContext(entry.privateKey, arrayOf(entry.certificate as X509Certificate))
    }

    override fun fingerprint256(): String = CertPins.fingerprint256(entry().certificate.encoded)

    override fun keyManager(): X509ExtendedKeyManager {
        val entry = entry()
        return SingleKeyManager(entry.privateKey, arrayOf(entry.certificate as X509Certificate))
    }

    // One lock for the process: the settings screen and the monitor may both be first to ask.
    private fun entry(): KeyStore.PrivateKeyEntry = synchronized(LOCK) {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.PrivateKeyEntry)?.let { return it }
        generate()
        store.getEntry(alias, null) as KeyStore.PrivateKeyEntry
    }

    private fun generate() {
        val now = System.currentTimeMillis()
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            // NONE because the TLS stack hashes the handshake itself and asks for a raw signature.
            .setDigests(
                KeyProperties.DIGEST_NONE,
                KeyProperties.DIGEST_SHA256,
                KeyProperties.DIGEST_SHA384,
                KeyProperties.DIGEST_SHA512,
            )
            .setCertificateSubject(X500Principal("CN=$COMMON_NAME"))
            .setCertificateSerialNumber(BigInteger(63, SecureRandom()).add(BigInteger.ONE))
            .setCertificateNotBefore(Date(now - DAY_MS))
            .setCertificateNotAfter(Date(now + VALID_DAYS * DAY_MS))
            .build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
            .apply { initialize(spec) }
            .generateKeyPair()
    }

    companion object {
        const val DEFAULT_ALIAS = "rokid-coder-phone-tls"
        private const val COMMON_NAME = "rokid-coder-phone"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val VALID_DAYS = 3650L
        private const val DAY_MS = 24L * 60L * 60L * 1000L
        private val LOCK = Any()
    }
}

/**
 * A server context that presents [chain] and signs with [key], and takes any
 * client certificate at the TLS layer: agentd's is self-signed, and whether it
 * is the right one is the machine's pin, checked at hello (R114).
 */
internal fun serverSslContext(key: PrivateKey, chain: Array<X509Certificate>): SSLContext =
    SSLContext.getInstance("TLS").apply {
        init(arrayOf(SingleKeyManager(key, chain)), arrayOf(AnyClientCertificate), null)
    }

/** The listening socket of the link agentd dials: mutual TLS only, there is no plaintext listener. */
internal fun tlsServerSocket(identity: PhoneTlsIdentity, port: Int): SSLServerSocket =
    (identity.sslContext().serverSocketFactory.createServerSocket(port) as SSLServerSocket).apply {
        needClientAuth = true
        enabledProtocols = enabledProtocols.filter { it == "TLSv1.2" || it == "TLSv1.3" }.toTypedArray()
    }

/** Requires a client certificate and leaves its identity to the pin; never trusts a server. */
private object AnyClientCertificate : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        if (chain.isNullOrEmpty()) throw CertificateException("a client certificate is required")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("this context trusts no server")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/**
 * Serves one key, as a server and as a client. A key held by AndroidKeyStore
 * is not exportable, so the platform's KeyManagerFactory is not relied on to
 * find it.
 */
internal class SingleKeyManager(
    private val key: PrivateKey,
    private val chain: Array<X509Certificate>,
) : X509ExtendedKeyManager() {
    private fun aliasFor(keyType: String?): String? =
        ALIAS.takeIf { keyType == key.algorithm || keyType?.startsWith("${key.algorithm}_") == true }

    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?) = aliasFor(keyType)

    override fun chooseEngineServerAlias(keyType: String?, issuers: Array<out Principal>?, engine: SSLEngine?) =
        aliasFor(keyType)

    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?) = aliasFor(keyType)?.let { arrayOf(it) }

    override fun getCertificateChain(alias: String?) = chain.takeIf { alias == ALIAS }

    override fun getPrivateKey(alias: String?) = key.takeIf { alias == ALIAS }

    // agentd's request names no issuer it trusts (the certificate is self-signed), so only the key type decides.
    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? =
        keyType?.firstNotNullOfOrNull(::aliasFor)

    override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String? =
        keyType?.firstNotNullOfOrNull(::aliasFor)

    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? =
        aliasFor(keyType)?.let { arrayOf(it) }

    private companion object {
        const val ALIAS = "phone"
    }
}
