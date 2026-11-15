package com.anezium.rokidbus.phone

import java.io.File
import java.io.IOException

internal sealed interface GlassesApkVerdict {
    data object Accept : GlassesApkVerdict

    data class Reject(val reason: String) : GlassesApkVerdict
}

/** Only fixed verification reasons may be shown in the installation UI. */
internal class GlassesApkVerificationException(val reason: String) : IOException(reason)

/** Every check is required, including on phones unable to parse a newer APK. */
internal object GlassesApkVerificationPolicy {
    fun verify(
        apk: File,
        expected: GlassesApkMetadata,
        inspector: ArtifactPackageInspector,
    ) {
        val digest = expected.sha256.takeIf { it.matches(Regex("[0-9a-fA-F]{64}")) }
            ?: throw GlassesApkVerificationException("Latest glasses release has no valid SHA-256 digest.")
        if (!sha256Matches(apk, digest)) {
            throw GlassesApkVerificationException("Glasses APK SHA-256 verification failed.")
        }
        val archive = runCatching { inspector.inspect(apk) }.getOrNull()
        val verdict = verdict(archive, expected)
        if (verdict is GlassesApkVerdict.Reject) throw GlassesApkVerificationException(verdict.reason)
    }

    fun verdict(
        archive: ArtifactArchiveInfo?,
        expected: GlassesApkMetadata,
    ): GlassesApkVerdict {
        if (archive == null) return GlassesApkVerdict.Reject("Glasses APK signature or manifest could not be verified.")
        if (archive.packageName != expected.packageName) {
            return GlassesApkVerdict.Reject("Glasses APK package does not match Nexus.")
        }
        val pins = expected.signerSha256.split(',')
        if (pins.any { !it.matches(Regex("[0-9a-fA-F]{64}")) }) {
            return GlassesApkVerdict.Reject("Glasses APK signer pin is not configured correctly.")
        }
        if (archive.signingCertificates.size != 1) {
            return GlassesApkVerdict.Reject("Glasses APK must have exactly one signing certificate.")
        }
        val signer = signingCertificateSha256(archive.signingCertificates.single())
        if (pins.none { it.equals(signer, ignoreCase = true) }) {
            return GlassesApkVerdict.Reject("Glasses APK signer does not match this phone build.")
        }
        if (expected.versionCode <= 0L || archive.versionCode != expected.versionCode) {
            return GlassesApkVerdict.Reject("Glasses APK version does not match the release.")
        }
        return GlassesApkVerdict.Accept
    }
}
