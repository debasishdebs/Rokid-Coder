package com.anezium.rokidbus.plugin.agents

import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509ExtendedKeyManager

/**
 * One key and self-signed certificate from a PKCS12 file in
 * `src/test/resources`, each made once with keytool (the commands are in the
 * Task 10 report). Store and key password are both `fixture`.
 */
internal class Pkcs12Fixture(resource: String, alias: String) {
    private val store = KeyStore.getInstance("PKCS12").apply {
        Pkcs12Fixture::class.java.classLoader!!.getResourceAsStream(resource)!!.use { load(it, PASSWORD) }
    }

    val certificate: X509Certificate = store.getCertificate(alias) as X509Certificate
    val key: PrivateKey = store.getKey(alias, PASSWORD) as PrivateKey
    val fingerprint: String = CertPins.fingerprint256(certificate.encoded)

    private companion object {
        val PASSWORD = "fixture".toCharArray()
    }
}

/**
 * The phone identity from `phone-tls-fixture.p12`, an EC P-256 key with a
 * self-signed CN=rokid-coder-phone certificate. It goes through the same
 * [serverSslContext] and [SingleKeyManager] the AndroidKeyStore identity uses.
 */
internal class FixturePhoneTlsIdentity : PhoneTlsIdentity {
    private val fixture = Pkcs12Fixture("phone-tls-fixture.p12", "rokid-coder-phone-tls")

    val certificate: X509Certificate = fixture.certificate

    override fun sslContext(): SSLContext = serverSslContext(fixture.key, arrayOf(certificate))

    override fun fingerprint256(): String = fixture.fingerprint

    override fun keyManager(): X509ExtendedKeyManager = SingleKeyManager(fixture.key, arrayOf(certificate))

    companion object {
        /** `openssl x509 -fingerprint -sha256` of the fixture, which Node's fingerprint256 also prints. */
        const val FINGERPRINT =
            "38:2D:4D:D9:A2:32:97:CF:DE:AD:60:6D:F8:90:00:6D:81:0C:20:97:6B:49:7B:AD:AD:E1:FE:07:53:D2:47:10"

        /** Two agentd-like client identities (RSA-2048, CN=rokid-coder-agentd, as `selfsigned` makes them). */
        fun agentdA() = Pkcs12Fixture("agentd-client-a.p12", "agentd")
        fun agentdB() = Pkcs12Fixture("agentd-client-b.p12", "agentd")
    }
}
