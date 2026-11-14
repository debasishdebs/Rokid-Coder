package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import java.util.Locale

/**
 * One tap-to-talk utterance as a pure state machine over the events of a
 * `NexusSpeechSession`: the service feeds it the callbacks, draws [state], and
 * only ever sends what [confirmedText] hands back after the wearer pressed
 * ENTER on the heard card. Nothing here logs: the text is the wearer's speech.
 *
 * One instance serves one utterance. [invalidate] ends it for good, and whatever
 * the hub still delivers afterwards is dropped, so a card that was closed under
 * the wearer can never come back to life with a late final.
 */
class VoiceCapture {
    sealed interface State {
        data object Idle : State
        data object Listening : State
        data class Heard(val text: String) : State
        data class Failed(val message: String) : State
    }

    var state: State = State.Idle
        private set

    private var lastPartial: String? = null
    private var invalidated = false

    fun onStarted() {
        if (invalidated || state != State.Idle) return
        state = State.Listening
    }

    fun onPartial(text: String) {
        if (invalidated || state != State.Listening) return
        if (text.isNotBlank()) lastPartial = text
    }

    /** A null or blank final is the last partial's to cover; with none, nothing was heard. */
    fun onFinal(text: String?) {
        if (invalidated || state != State.Listening) return
        val heard = text?.takeIf { it.isNotBlank() } ?: lastPartial
        state = if (heard != null) State.Heard(heard.trim()) else State.Failed(DIDNT_CATCH)
    }

    fun onStopped(reason: NexusSpeechStopReason) {
        if (invalidated) return
        // A heard or failed utterance keeps its card, whatever ended the session after it.
        if (state is State.Heard || state is State.Failed) return
        state = when (reason) {
            // This side cancelled: no card of voice is left to show.
            NexusSpeechStopReason.CANCELLED -> State.Idle
            // The session ended without a final: the partial is all there is.
            NexusSpeechStopReason.COMPLETED ->
                lastPartial?.let { State.Heard(it.trim()) } ?: State.Failed(DIDNT_CATCH)
            NexusSpeechStopReason.NO_SPEECH -> State.Failed(DIDNT_CATCH)
            NexusSpeechStopReason.DENIED_BUSY -> State.Failed(MIC_BUSY)
            NexusSpeechStopReason.DENIED_NO_LINK,
            NexusSpeechStopReason.LINK_LOST,
            -> State.Failed(LINK_LOST)
            NexusSpeechStopReason.REVOKED,
            NexusSpeechStopReason.DENIED_NOT_READY,
            NexusSpeechStopReason.DENIED_START_FAILED,
            NexusSpeechStopReason.DENIED_INVALID,
            -> State.Failed(UNAVAILABLE)
            NexusSpeechStopReason.ERROR -> State.Failed(VOICE_ERROR)
        }
    }

    /** The card this belongs to is closed: stop caring about anything the hub still says. */
    fun invalidate() {
        invalidated = true
        state = State.Idle
        lastPartial = null
    }

    /** The text to act on, only once the utterance was heard and is not blank. */
    fun confirmedText(): String? =
        (state as? State.Heard)?.text?.takeIf { it.isNotBlank() }

    companion object {
        const val MIC_BUSY = "Mic busy — try again"
        const val LINK_LOST = "Glasses link lost"
        const val DIDNT_CATCH = "Didn't catch that"
        const val UNAVAILABLE = "Voice unavailable"
        const val VOICE_ERROR = "Voice failed — try again"
    }
}

/**
 * The words that answer an approval by voice. A speech engine mishears, and a
 * wrong allow runs a tool, so only a complete utterance from a short fixed list
 * counts: extra words, a negation or a partial match is nothing, and the wearer
 * is asked again. A match is still only a proposal; the confirm card sends.
 */
object VoiceApproval {
    const val PROMPT = "Say allow or deny"

    private val ALLOW = setOf(
        "allow", "approve", "yes", "ok", "okay",
        "allow it", "approve it", "yes allow", "yes approve",
    )
    private val DENY = setOf("deny", "no", "reject", "deny it", "reject it", "no deny")

    fun match(text: String): ApprovalDecision? {
        val said = normalise(text)
        return when (said) {
            in ALLOW -> ApprovalDecision.ALLOW
            in DENY -> ApprovalDecision.DENY
            else -> null
        }
    }

    /** Lowercase, punctuation out, spaces collapsed. An apostrophe is dropped, so `don't` stays one word. */
    private fun normalise(text: String): String {
        val kept = StringBuilder(text.length)
        for (ch in text.lowercase(Locale.ROOT)) {
            when {
                ch == '\'' || ch == '’' -> Unit
                ch.isLetterOrDigit() -> kept.append(ch)
                else -> kept.append(' ')
            }
        }
        return kept.toString().trim().replace(Regex("\\s+"), " ")
    }
}
