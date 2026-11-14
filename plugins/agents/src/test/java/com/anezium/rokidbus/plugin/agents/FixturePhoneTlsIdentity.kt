package com.anezium.rokidbus.plugin.agents

import java.security.KeyStore
import java.security.PrivateKey
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext

/**
 * The phone identity from `src/test/resources/phone-tls-fixture.p12`, an EC
 * P-256 key with a self-signed CN=rokid-coder-phone certificate made once with
 * keytool (the command is in the Task 10 report). It goes through the same
 * [serverSslContext] the AndroidKeyStore identity uses.
 */
internal class FixturePhoneTlsIdentity : PhoneTlsIdentity {
    private val store = KeyStore.getInstance("PKCS12").apply {
        FixturePhoneTlsIdentity::class.java.classLoader!!.getResourceAsStream(RESOURCE)!!.use { load(it, PASSWORD) }
    }

    val certificate: X509Certificate = store.getCertificate(ALIAS) as X509Certificate

    override fun sslContext(): SSLContext =
        serverSslContext(store.getKey(ALIAS, PASSWORD) as PrivateKey, arrayOf(certificate))

    override fun fingerprint256(): String = CertPins.fingerprint256(certificate.encoded)

    companion object {
        private const val RESOURCE = "phone-tls-fixture.p12"
        private const val ALIAS = "rokid-coder-phone-tls"
        private val PASSWORD = "fixture".toCharArray()

        /** `openssl x509 -fingerprint -sha256` of the fixture, which Node's fingerprint256 also prints. */
        const val FINGERPRINT =
            "38:2D:4D:D9:A2:32:97:CF:DE:AD:60:6D:F8:90:00:6D:81:0C:20:97:6B:49:7B:AD:AD:E1:FE:07:53:D2:47:10"
    }
}
