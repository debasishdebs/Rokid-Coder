package com.anezium.rokidbus.phone

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

data class ArtifactArchiveInfo(
    val packageName: String,
    val versionCode: Long,
    val signingCertificates: List<ByteArray>,
    val versionName: String? = null,
    val signingCertificateHistory: List<ByteArray> = signingCertificates,
)

fun interface ArtifactPackageInspector {
    fun inspect(apk: File): ArtifactArchiveInfo?
}

fun sha256Matches(file: File, expected: String): Boolean {
    if (!file.isFile) return false
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
    }
    val actual = digest.digest().joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) }
    return actual.equals(expected, ignoreCase = true)
}
