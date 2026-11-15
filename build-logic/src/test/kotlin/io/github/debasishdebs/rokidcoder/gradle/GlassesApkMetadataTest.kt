package io.github.debasishdebs.rokidcoder.gradle

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.security.MessageDigest

class GlassesApkMetadataTest {
    @get:Rule val temp = TemporaryFolder()

    @Test
    fun reads_package_version_digest_and_signer_with_apksig() {
        val signer = ThrowawaySigner(temp.root, "a")
        val apk = signer.sign(ThrowawaySigner.fixtureApk, temp.newFile("signed.apk"))

        val metadata = GlassesApkMetadata.read(apk)

        assertEquals("io.github.debasishdebs.rokidcoder.glasses", metadata.packageName)
        assertEquals(10000L, metadata.versionCode)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(apk.readBytes()).joinToString("") { "%02x".format(it) }, metadata.sha256)
        assertEquals(signer.sha256, metadata.signerSha256)
    }

    @Test
    fun an_unsigned_apk_is_refused() {
        try {
            GlassesApkMetadata.read(ThrowawaySigner.fixtureApk)
            fail("an unsigned APK has no signer to pin")
        } catch (refused: IllegalStateException) {
            assertTrue(refused.message.orEmpty().contains("does not verify"))
        }
    }

    @Test
    fun json_carries_exactly_the_four_fields() {
        val json = GlassesApkMetadata("io.example.glasses", 10000L, "ab".repeat(32), "cd".repeat(32)).toJson()
        assertEquals(
            """{"packageName":"io.example.glasses","versionCode":10000,"sha256":"${"ab".repeat(32)}","signerSha256":"${"cd".repeat(32)}"}""",
            json,
        )
    }

    @Test
    fun signer_pin_matches_case_insensitively_and_refuses_anything_else() {
        val pin = "AB".repeat(32)
        assertNull(SignerPin.mismatch(actual = "ab".repeat(32), pin = pin))
        assertTrue(SignerPin.mismatch(actual = "cd".repeat(32), pin = pin)!!.contains("does not match"))
        assertTrue(SignerPin.mismatch(actual = "ab".repeat(32), pin = "")!!.contains("rokid.releaseSignerSha256"))
        assertTrue(SignerPin.mismatch(actual = "ab".repeat(32), pin = "not-a-digest")!!.contains("rokid.releaseSignerSha256"))
    }
}
