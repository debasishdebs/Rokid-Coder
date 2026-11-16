package com.anezium.rokidbus.plugin.agents

import android.app.Activity
import android.content.Intent
import com.google.zxing.client.android.Intents
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The pairing QR scan: zxing's screen, QR only, and what each way it ends means. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingScanTest {
    private val context = RuntimeEnvironment.getApplication()

    @Test
    fun scan_is_qr_only_with_a_short_prompt_and_no_beep() {
        val intent = PairingScan.intent(context)
        assertEquals("com.journeyapps.barcodescanner.CaptureActivity", intent.component?.className)
        assertEquals("QR_CODE", intent.getStringExtra(Intents.Scan.FORMATS))
        assertEquals("Scan the QR code on your computer", intent.getStringExtra(Intents.Scan.PROMPT_MESSAGE))
        assertFalse(intent.getBooleanExtra(Intents.Scan.BEEP_ENABLED, true))
        assertFalse("the manifest, not the options, holds portrait", intent.getBooleanExtra(Intents.Scan.ORIENTATION_LOCKED, true))
    }

    @Test
    fun a_scanned_code_is_handed_on_as_text() {
        val data = Intent().putExtra(Intents.Scan.RESULT, "agentd://pair?v=2")
        assertEquals(ScanOutcome.Code("agentd://pair?v=2"), PairingScan.outcome(Activity.RESULT_OK, data))
    }

    @Test
    fun backing_out_is_nothing_and_a_missing_camera_says_so() {
        assertEquals(ScanOutcome.Cancelled, PairingScan.outcome(Activity.RESULT_CANCELED, null))
        val noCamera = Intent().putExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, true)
        assertEquals(ScanOutcome.NoCamera, PairingScan.outcome(Activity.RESULT_CANCELED, noCamera))
    }

    @Test
    fun the_camera_is_explained_before_android_asks() {
        assertTrue("camera" in PairingScan.WHY_CAMERA)
        assertTrue("nothing is recorded or sent" in PairingScan.WHY_CAMERA)
        assertTrue("paste" in PairingScan.CAMERA_OFF)
    }
}
