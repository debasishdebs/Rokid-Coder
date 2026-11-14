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
    private const val TEXT_CHARS = 238

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
                VoiceKind.FOLLOWUP -> VoiceView(
                    title,
                    state.text.singleLine(TEXT_CHARS),
                    listOf(VoiceRow("Send", null, VoiceAct.SEND), again, cancel),
                    0,
                )
                VoiceKind.ANSWER -> VoiceView(
                    title,
                    state.text.singleLine(TEXT_CHARS),
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
