package com.anezium.rokidbus.plugin.agents

import android.content.Context
import android.content.Intent
import com.google.zxing.client.android.Intents
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanIntentResult
import com.journeyapps.barcodescanner.ScanOptions

/** What a finished scan screen means for Add a computer. */
sealed interface ScanOutcome {
    /** The text of a QR code: the pairing line, if it is ours. */
    data class Code(val text: String) : ScanOutcome

    /** Backed out. */
    data object Cancelled : ScanOutcome

    /** The camera was off or taken away: the paste box is the way. */
    data object NoCamera : ScanOutcome
}

/**
 * The pairing QR code, read by zxing's own scan screen: it decodes on the phone and sends
 * nothing anywhere. The camera is asked for only when the user taps Scan, after
 * [WHY_CAMERA]; without it, the pasted pairing line works as before.
 */
object PairingScan {
    const val PROMPT = "Scan the QR code on your computer"
    const val WHY_CAMERA = "To scan the code, Rokid Coder needs your camera. It is used only for this and nothing is recorded or sent."
    const val CAMERA_OFF = "The camera is off, so paste the pairing line instead."
    const val NOT_OURS = "That QR code is not a Rokid Coder pairing code."
    const val ALLOW = "Continue"
    const val NOT_NOW = "Paste instead"

    /** QR only, a short prompt, no beep; the screen's orientation is portrait in the manifest. */
    fun options(): ScanOptions = ScanOptions()
        .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
        .setPrompt(PROMPT)
        .setBeepEnabled(false)
        .setOrientationLocked(false)
        .setBarcodeImageEnabled(false)

    fun intent(context: Context): Intent = ScanContract().createIntent(context, options())

    fun outcome(resultCode: Int, data: Intent?): ScanOutcome {
        val result: ScanIntentResult = ScanContract().parseResult(resultCode, data)
        val text = result.contents
        return when {
            text != null -> ScanOutcome.Code(text)
            result.originalIntent?.getBooleanExtra(Intents.Scan.MISSING_CAMERA_PERMISSION, false) == true -> ScanOutcome.NoCamera
            else -> ScanOutcome.Cancelled
        }
    }
}
