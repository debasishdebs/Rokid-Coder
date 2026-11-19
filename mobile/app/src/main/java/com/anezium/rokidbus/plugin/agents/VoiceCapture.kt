package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.plugin.agents.service.VoiceAvailability
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

    /**
     * The glasses link could not be made sure of before listening, so no session was ever started; [message]
     * says why in words the wearer can act on, not as a link that was lost.
     */
    fun onLinkUnavailable(message: String) {
        if (invalidated || state != State.Idle) return
        state = State.Failed(message)
    }

    fun onPartial(text: String) {
        if (invalidated || state != State.Listening) return
        if (text.isNotBlank()) lastPartial = text
    }

    /** A null or blank final is the last partial's to cover; with none, nothing was heard. */
    fun onFinal(text: String?) {
        if (invalidated || state != State.Listening) return
        val heard = text?.takeIf { it.isNotBlank() } ?: lastPartial
        state = if (heard != null) heardOf(heard) else State.Failed(DIDNT_CATCH)
    }

    /**
     * What is heard is what is sent: the transcript with its whitespace collapsed,
     * all of it. How much of it the card shows is [VoiceCard]'s business (U4/U13).
     */
    private fun heardOf(text: String): State = State.Heard(text.singleLine(Int.MAX_VALUE))

    /**
     * [error] is the hub's, when it gave one: a microphone refused because voice is off ends the
     * session as a link loss, and its detail says why, so the card points at the fix instead.
     */
    fun onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError? = null) {
        if (invalidated) return
        // A heard or failed utterance keeps its card, whatever ended the session after it.
        if (state is State.Heard || state is State.Failed) return
        val voiceOff = VoiceAvailability.of(error)?.glassesLine?.takeIf { reason != NexusSpeechStopReason.CANCELLED }
        if (voiceOff != null) {
            state = State.Failed(voiceOff)
            return
        }
        state = when (reason) {
            // This side cancelled: no card of voice is left to show.
            NexusSpeechStopReason.CANCELLED -> State.Idle
            // The session ended without a final: the partial is all there is.
            NexusSpeechStopReason.COMPLETED ->
                lastPartial?.let(::heardOf) ?: State.Failed(DIDNT_CATCH)
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
        const val NOT_REACHED = "Could not reach the glasses, try again"
        const val MONITORING_OFF = "Monitoring is off — turn it on in Settings"
        const val GLASSES_NOT_SET_UP = "Glasses not set up — open Rokid Coder to connect them"
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

enum class VoiceAct { SEND, USE, READ_ALL, SPEAK_AGAIN, CANCEL, CONFIRM }

data class VoiceRow(val text: String, val sub: String?, val act: VoiceAct)

/**
 * [initial] is the row the card opens on; [decision] is set only on the confirm card of a voice approval.
 * [lead] is the first BODY row of a condensed reply, and [readAll] is the whole of what the reply is shown
 * as, set only when [body] holds a preview of it: the `Read all` row opens it in the reader.
 */
data class VoiceView(
    val title: String,
    val body: String?,
    val rows: List<VoiceRow>,
    val initial: Int,
    val decision: ApprovalDecision? = null,
    val lead: String? = null,
    val readAll: String? = null,
)

/**
 * The card of one utterance, as a pure model. Nothing is sent from a state that
 * is not a heard card with a first row the wearer pressed: a follow-up needs
 * `Send`, an approval needs the `Confirm` of its own `Allow?` / `Deny?` card,
 * and that card opens on `Cancel`.
 */
object VoiceCard {
    /** The BODY rows, its lead row included, the heard card draws of a reply at most. */
    const val BODY_ROWS = 3

    /**
     * The BODY rows of a reply the wearer is sure to see whole. The HUD windows a card's rows around the
     * selection by a height no plugin can measure, so only one is certain; a reply needing more offers
     * `Read all`.
     */
    const val SURE_BODY_ROWS = 1
    const val ROW_CHARS = 240

    /** The HUD wraps a BODY row to at most this many lines and ellipsizes the rest (SurfaceHudView). */
    const val BODY_MAX_LINES = 3

    /** The columns a HUD line is sure to hold (PLUGIN_SDK.md: twenty-six monospace columns); a wider line only shows more. */
    const val LINE_COLUMNS = 26

    private val WHITESPACE = Regex("\\s+")

    /**
     * [body] as the card's rows, each one wrapped as the HUD wraps it into at most [BODY_MAX_LINES]
     * lines of [LINE_COLUMNS], so no row is ellipsized; together they are all of it.
     */
    fun bodyRows(body: String): List<String> {
        val rows = mutableListOf<String>()
        val row = StringBuilder()
        var lines = 0
        var column = 0
        for (word in body.trim().split(WHITESPACE).filter(String::isNotEmpty)) {
            var nextLines = lines
            var nextColumn: Int
            if (row.isNotEmpty() && column + 1 + word.length <= LINE_COLUMNS) {
                nextColumn = column + 1 + word.length
            } else {
                if (row.isNotEmpty()) nextLines++
                // A word wider than a line is broken across lines, as the HUD breaks it.
                nextLines += (word.length - 1) / LINE_COLUMNS
                nextColumn = word.length - (word.length - 1) / LINE_COLUMNS * LINE_COLUMNS
            }
            if (row.isNotEmpty() && nextLines >= BODY_MAX_LINES) {
                rows += row.toString()
                row.clear()
                nextLines = (word.length - 1) / LINE_COLUMNS
                nextColumn = word.length - nextLines * LINE_COLUMNS
            }
            if (row.isNotEmpty()) row.append(' ')
            row.append(word)
            lines = nextLines
            column = nextColumn
        }
        if (row.isNotEmpty()) rows += row.toString()
        return rows.flatMap { it.chunked(ROW_CHARS) }
    }

    /**
     * A heard reply as the card draws it: [lead] if it was condensed, [body] to fit the rows, and [readAll]
     * whenever the reply needs more than [SURE_BODY_ROWS] rows, whether or not [body] holds all of it.
     */
    data class Review(val lead: String?, val body: String, val readAll: String?)

    /**
     * What the card shows of [text] (U4/U13): the condensed display of it, under a lead row saying so. A display
     * needing more [bodyRows] than the wearer is sure to see is offered whole to the reader, and one needing more
     * than the card draws is cut to a preview that fits them.
     */
    fun review(text: String, wordLimit: Int): Review {
        val shown = VoiceCondense.condense(text, wordLimit)
        val lead = if (shown.condensed) {
            "Showing ${shown.shownWords} of ${shown.totalWords} words · the full reply is sent"
        } else {
            null
        }
        val needed = bodyRows(shown.display).size
        if (needed <= SURE_BODY_ROWS) return Review(lead, shown.display, readAll = null)
        val room = BODY_ROWS - (lead?.let { bodyRows(it).size } ?: 0)
        val body = if (needed <= room) shown.display else preview(shown.display, room)
        return Review(lead, body, readAll = shown.display)
    }

    /** The most words of [display] that, with a closing `…`, still fit in [rows] rows. */
    private fun preview(display: String, rows: Int): String {
        val words = display.split(' ')
        fun cut(count: Int) = words.take(count).joinToString(" ") + "…"
        var fits = 0
        var over = words.size
        while (over - fits > 1) {
            val mid = (fits + over) / 2
            if (bodyRows(cut(mid)).size <= rows) fits = mid else over = mid
        }
        return cut(fits)
    }

    /**
     * [allowRefused]: an approval whose command agentd cut (R128); a heard "allow" is refused, "deny" still works.
     * [wordLimit] is how many words of a long reply the card shows before condensing it.
     */
    fun view(
        kind: VoiceKind,
        state: VoiceCapture.State,
        allowRefused: Boolean = false,
        wordLimit: Int = VoiceCondense.DEFAULT_WORD_LIMIT,
    ): VoiceView {
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
                // What Send sends is the whole transcript; the card shows it condensed, and Read all shows what it shows.
                VoiceKind.FOLLOWUP ->
                    heardView(title, state.text, wordLimit, VoiceRow("Send", null, VoiceAct.SEND), again, cancel)
                VoiceKind.ANSWER -> heardView(
                    title, state.text, wordLimit,
                    VoiceRow("Use answer", "sent with Send answer", VoiceAct.USE), again, cancel,
                )
                VoiceKind.APPROVAL -> when (val decision = VoiceApproval.match(state.text)) {
                    null -> VoiceView(title, VoiceApproval.PROMPT, listOf(again, cancel), 0)
                    ApprovalDecision.ALLOW.takeIf { allowRefused } ->
                        VoiceView(title, AlertNotices.COMMAND_CUT, listOf(again, cancel), 0)
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

    private fun heardView(
        title: String,
        text: String,
        wordLimit: Int,
        first: VoiceRow,
        again: VoiceRow,
        cancel: VoiceRow,
    ): VoiceView {
        val review = review(text, wordLimit)
        val readAll = if (review.readAll != null) listOf(VoiceRow("Read all", null, VoiceAct.READ_ALL)) else emptyList()
        return VoiceView(
            title = title,
            body = review.body,
            rows = listOf(first) + readAll + listOf(again, cancel),
            initial = 0,
            lead = review.lead,
            readAll = review.readAll,
        )
    }

    /** The sub line of a failure that the wearer can fix, or null. */
    fun hint(state: VoiceCapture.State): String? =
        if (state == VoiceCapture.State.Failed(VoiceCapture.UNAVAILABLE)) "allow Speech to text in Rokid Coder settings" else null
}
