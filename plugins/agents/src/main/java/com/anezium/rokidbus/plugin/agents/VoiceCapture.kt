package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import java.util.Locale

/** The one thing the capture needs from a speech session. The SDK's `stop()` only acts once the hub has accepted the start. */
fun interface SpeechStop {
    fun stop()
}

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
    private var session: SpeechStop? = null
    private var started = false
    private var stopped = false

    /** The session this utterance runs on, so that [invalidate] can stop it. */
    fun attach(session: SpeechStop) {
        this.session = session
    }

    /**
     * The hub accepted the start. If the wearer gave up while it was still
     * answering (R105), the session is live now and nothing is listening to it:
     * stop it at once so the mic closes and the next start is not refused.
     */
    fun onStarted() {
        started = true
        if (invalidated) {
            stopSession()
            return
        }
        if (state != State.Idle) return
        state = State.Listening
    }

    /** The start was refused before any session ran; the copy tells a missing grant from a mic still held. */
    fun onStartRefused(result: NexusSdkResult) {
        if (invalidated || state != State.Idle) return
        state = when (result) {
            NexusSdkResult.SENT -> return
            NexusSdkResult.CAPABILITY_NOT_GRANTED -> State.Failed(UNAVAILABLE)
            // An earlier session of ours is still stopping, or another plugin holds the one speech session.
            NexusSdkResult.CAPABILITY_NOT_AVAILABLE -> State.Failed(MIC_BUSY)
            else -> State.Failed(VOICE_ERROR)
        }
    }

    fun onPartial(text: String) {
        if (invalidated || state != State.Listening) return
        if (text.isNotBlank()) lastPartial = text
    }

    /** A null or blank final is the last partial's to cover; with none, nothing was heard. */
    fun onFinal(text: String?) {
        if (invalidated || state != State.Listening) return
        val heard = text?.takeIf { it.isNotBlank() } ?: lastPartial
        state = if (heard != null) heardOrRefused(heard) else State.Failed(DIDNT_CATCH)
    }

    /**
     * What is sent is exactly what the heard card shows (R123): the transcript with
     * its whitespace collapsed, and only if all of it fits on the card. A longer one
     * is refused, never cut, so no unreviewed tail can reach the agent.
     */
    private fun heardOrRefused(text: String): State {
        val clean = text.singleLine(Int.MAX_VALUE)
        return if (clean.length > MAX_REVIEW_CHARS) State.Failed(TOO_LONG) else State.Heard(clean)
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
                lastPartial?.let(::heardOrRefused) ?: State.Failed(DIDNT_CATCH)
            NexusSpeechStopReason.NO_SPEECH -> State.Failed(DIDNT_CATCH)
            NexusSpeechStopReason.DENIED_BUSY -> State.Failed(MIC_BUSY)
            NexusSpeechStopReason.DENIED_NO_LINK,
            NexusSpeechStopReason.LINK_LOST,
            -> State.Failed(LINK_LOST)
            // Only a grant the wearer took away is theirs to fix in settings.
            NexusSpeechStopReason.REVOKED -> State.Failed(UNAVAILABLE)
            NexusSpeechStopReason.DENIED_NOT_READY,
            NexusSpeechStopReason.DENIED_START_FAILED,
            NexusSpeechStopReason.DENIED_INVALID,
            NexusSpeechStopReason.ERROR,
            -> State.Failed(VOICE_ERROR)
        }
    }

    /**
     * The card this belongs to is closed: stop caring about anything the hub
     * still says, and stop the session if it is live. One that is still starting
     * is stopped by [onStarted] when the hub accepts it.
     */
    fun invalidate() {
        invalidated = true
        state = State.Idle
        lastPartial = null
        if (started) stopSession()
    }

    private fun stopSession() {
        if (stopped) return
        stopped = true
        session?.stop()
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
        const val TOO_LONG = "Too long to review — say a shorter reply"

        /**
         * The longest transcript the heard card shows whole: [VoiceCard.BODY_ROWS]
         * BODY rows of the SDK's 240-char line, 960 chars. It leaves the card room
         * for its three choice rows.
         */
        const val MAX_REVIEW_CHARS = VoiceCard.BODY_ROWS * VoiceCard.ROW_CHARS
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

/** What an utterance is for; it decides the words of the heard card and what its first row does. */
enum class VoiceKind { FOLLOWUP, ANSWER, APPROVAL }

enum class VoiceAct { SEND, USE, SPEAK_AGAIN, CANCEL, CONFIRM }

data class VoiceRow(val text: String, val sub: String?, val act: VoiceAct)

/** [initial] is the row the card opens on; [decision] is set only on the confirm card of a voice approval. */
data class VoiceView(
    val title: String,
    val body: String?,
    val rows: List<VoiceRow>,
    val initial: Int,
    val decision: ApprovalDecision? = null,
)

/**
 * The card of one utterance, as a pure model. Nothing is sent from a state that
 * is not a heard card with a first row the wearer pressed: a follow-up needs
 * `Send`, an approval needs the `Confirm` of its own `Allow?` / `Deny?` card,
 * and that card opens on `Cancel`.
 */
object VoiceCard {
    /** The heard card's transcript is drawn in at most this many BODY rows of [ROW_CHARS] each. */
    const val BODY_ROWS = 4
    const val ROW_CHARS = 240

    /** [body] as the card's rows, each within the SDK's line cap; together they are all of it. */
    fun bodyRows(body: String): List<String> = body.chunked(ROW_CHARS)

    fun view(kind: VoiceKind, state: VoiceCapture.State): VoiceView {
        val title = when (kind) {
            VoiceKind.FOLLOWUP -> "Reply by voice"
            VoiceKind.ANSWER -> "Answer by voice"
            VoiceKind.APPROVAL -> "Approve by voice"
        }
        val again = VoiceRow("Speak again", null, VoiceAct.SPEAK_AGAIN)
        val cancel = VoiceRow("Cancel", null, VoiceAct.CANCEL)
        return when (state) {
            VoiceCapture.State.Idle ->
                VoiceView(title, "Starting…", listOf(VoiceRow("Cancel", null, VoiceAct.CANCEL)), 0)
            VoiceCapture.State.Listening ->
                VoiceView(title, "Listening…", listOf(VoiceRow("Cancel", "speak now", VoiceAct.CANCEL)), 0)
            is VoiceCapture.State.Failed -> VoiceView(
                title,
                state.message,
                listOf(again, cancel),
                0,
            )
            is VoiceCapture.State.Heard -> when (kind) {
                // The whole transcript: it is exactly what Send sends.
                VoiceKind.FOLLOWUP -> VoiceView(
                    title,
                    state.text,
                    listOf(VoiceRow("Send", null, VoiceAct.SEND), again, cancel),
                    0,
                )
                VoiceKind.ANSWER -> VoiceView(
                    title,
                    state.text,
                    listOf(VoiceRow("Use answer", "sent with Send answer", VoiceAct.USE), again, cancel),
                    0,
                )
                VoiceKind.APPROVAL -> when (val decision = VoiceApproval.match(state.text)) {
                    null -> VoiceView(title, VoiceApproval.PROMPT, listOf(again, cancel), 0)
                    else -> VoiceView(
                        title = if (decision == ApprovalDecision.ALLOW) "Allow?" else "Deny?",
                        body = "Nothing is sent until you confirm",
                        rows = listOf(VoiceRow("Confirm", null, VoiceAct.CONFIRM), cancel),
                        initial = 1,
                        decision = decision,
                    )
                }
            }
        }
    }

    /** The sub line of a failure that the wearer can fix, or null. */
    fun hint(state: VoiceCapture.State): String? =
        if (state == VoiceCapture.State.Failed(VoiceCapture.UNAVAILABLE)) "allow Speech to text in Nexus settings" else null
}
