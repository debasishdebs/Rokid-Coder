package io.github.debasishdebs.rokidcoder.gradle

import com.android.apksig.ApkVerifier
import com.android.apksig.apk.ApkUtils
import com.android.apksig.util.DataSources
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * What the phone app is told about the glasses APK it bundles (`glasses.json`): the core's
 * `GlassesApkMetadata`, read here with the same apksig the core verifies with.
 */
data class GlassesApkMetadata(
    val packageName: String,
    val versionCode: Long,
    val sha256: String,
    /** The one signer's certificate SHA-256, lowercase hex. */
    val signerSha256: String,
) {
    fun toJson(): String =
        """{"packageName":"$packageName","versionCode":$versionCode,"sha256":"$sha256","signerSha256":"$signerSha256"}"""

    companion object {
        private val PACKAGE = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+")

        /** Refuses an APK that does not verify, or that has anything but exactly one signer. */
        fun read(apk: File): GlassesApkMetadata = RandomAccessFile(apk, "r").use { file ->
            val source = DataSources.asDataSource(file)
            val result = ApkVerifier.Builder(source).build().verify()
            check(result.isVerified) { "The glasses APK ${apk.name} does not verify" }
            val signer = result.signerCertificates.singleOrNull()
                ?: error("The glasses APK ${apk.name} has ${result.signerCertificates.size} signers; one is pinned")
            val manifest = ApkUtils.getAndroidManifest(source)
            val packageName = ApkUtils.getPackageNameFromBinaryAndroidManifest(manifest.duplicate())
            check(PACKAGE.matches(packageName)) { "The glasses APK names no plain package" }
            GlassesApkMetadata(
                packageName = packageName,
                versionCode = ApkUtils.getLongVersionCodeFromBinaryAndroidManifest(manifest.duplicate()),
                sha256 = sha256(apk.readBytes()),
                signerSha256 = sha256(signer.encoded),
            )
        }

        internal fun sha256(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}

/** The release pin: the glasses APK a release phone bundles is signed by the key T10 commits the digest of. */
object SignerPin {
    const val PROPERTY = "rokid.releaseSignerSha256"
    private val DIGEST = Regex("[0-9a-fA-F]{64}")

    /** Why [actual], the signer of [what], may not ship under [pin], or null when it may. */
    fun mismatch(actual: String, pin: String, what: String = "The glasses APK signer"): String? = when {
        pin.isBlank() -> "$PROPERTY is not set: a release bundles only a glasses APK signed by the pinned key"
        !DIGEST.matches(pin) -> "$PROPERTY is not a 64-hex SHA-256 certificate digest"
        !actual.equals(pin, ignoreCase = true) -> "$what does not match $PROPERTY"
        else -> null
    }
}
