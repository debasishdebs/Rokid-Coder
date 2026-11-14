package com.anezium.rokidbus.plugin.agents

import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import okhttp3.tls.HeldCertificate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class CertPinsTest {
    private val fixture = FixturePhoneTlsIdentity()

    @Test
    fun fingerprint_format_matches_node_fingerprint256() {
        assertEquals(FixturePhoneTlsIdentity.FINGERPRINT, CertPins.fingerprint256(fixture.certificate.encoded))
        assertEquals(FixturePhoneTlsIdentity.FINGERPRINT, fixture.fingerprint256())
    }

    @Test
    fun parse_absent_valid_malformed() {
        val pin = FixturePhoneTlsIdentity.FINGERPRINT
        assertEquals(PinParse.Absent, CertPins.parse(null))
        assertEquals(PinParse.Valid(pin), CertPins.parse(pin))
        // Normalised the way agentd's normalizeFingerprint does it.
        assertEquals(PinParse.Valid(pin), CertPins.parse(pin.lowercase()))
        assertEquals(PinParse.Valid(pin), CertPins.parse(pin.replace(":", "")))
        listOf("", "nope", pin.dropLast(3), "$pin:00", pin.replace('A', 'G'), "sha256/$pin").forEach {
            assertEquals(it, PinParse.Malformed, CertPins.parse(it))
        }
    }

    @Test
    fun pinned_trust_manager_accepts_expected_rejects_other() {
        val trust = CertPins.trustManager(FixturePhoneTlsIdentity.FINGERPRINT)
        trust.checkServerTrusted(arrayOf(fixture.certificate), "ECDHE_ECDSA")

        val other = HeldCertificate.Builder().commonName("rokid-coder-agentd").build().certificate
        listOf(arrayOf(other), arrayOf(other, fixture.certificate), emptyArray<X509Certificate>()).forEach { chain ->
            try {
                trust.checkServerTrusted(chain, "ECDHE_ECDSA")
                fail("a chain led by another leaf was trusted")
            } catch (_: PinMismatchException) {
                // Expected.
            }
        }
        try {
            trust.checkClientTrusted(arrayOf(fixture.certificate), "ECDHE_ECDSA")
            fail("the pin is no client trust")
        } catch (_: CertificateException) {
            // Expected.
        }
        assertEquals(0, trust.acceptedIssuers.size)
        assertTrue(CertPins.matches(fixture.certificate, FixturePhoneTlsIdentity.FINGERPRINT))
        assertFalse(CertPins.matches(other, FixturePhoneTlsIdentity.FINGERPRINT))
        assertFalse(CertPins.matches(null, FixturePhoneTlsIdentity.FINGERPRINT))
    }

    @Test
    fun phone_fingerprint_shows_the_first_16_hex_digits_grouped() {
        // agentd's R60 line prints pinnedFingerprint(): the same 16 digits, ungrouped.
        assertEquals("382D 4DD9 A232 97CF", CertPins.display(FixturePhoneTlsIdentity.FINGERPRINT))
    }
}
