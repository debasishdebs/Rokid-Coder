package io.github.debasishdebs.rokidcoder.gradle

import com.android.apksig.ApkSigner
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.cert.X509Certificate

/**
 * A key made for one test in its temp dir, never the release key: keytool writes a PKCS12 there,
 * and the fixture APK (a manifest-only APK, aapt2-linked) is signed with it.
 */
class ThrowawaySigner(dir: File, alias: String) {
    private val key: PrivateKey
    val certificate: X509Certificate

    /** The PKCS12 keytool wrote; its key password is the store password, as release signing expects. */
    val store = File(dir, "$alias.p12")

    init {
        val keytool = File(System.getProperty("java.home"), "bin/keytool").absolutePath
        val process = ProcessBuilder(
            keytool, "-genkeypair", "-keystore", store.absolutePath, "-storetype", "PKCS12",
            "-storepass", PASSWORD, "-keypass", PASSWORD, "-alias", alias, "-keyalg", "RSA",
            "-keysize", "2048", "-validity", "2", "-dname", "CN=$alias",
        ).redirectErrorStream(true).start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor() == 0) { "keytool failed: $output" }
        val keyStore = KeyStore.getInstance("PKCS12").apply { store.inputStream().use { load(it, PASSWORD.toCharArray()) } }
        key = keyStore.getKey(alias, PASSWORD.toCharArray()) as PrivateKey
        certificate = keyStore.getCertificate(alias) as X509Certificate
    }

    val sha256: String
        get() = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }

    fun sign(unsigned: File, out: File): File {
        @Suppress("DEPRECATION")
        val config = ApkSigner.SignerConfig.Builder("signer", key, listOf(certificate)).build()
        ApkSigner.Builder(listOf(config))
            .setInputApk(unsigned)
            .setOutputApk(out)
            .setMinSdkVersion(31)
            .build()
            .sign()
        return out
    }

    companion object {
        const val PASSWORD = "throwaway"

        val fixtureApk: File get() = File(System.getProperty("fixtureApk"))
    }
}
