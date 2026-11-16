package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeAction
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusReaderAnchor
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import java.security.MessageDigest

/**
 * What an agentd alert looks like on the glasses: the notice band, its refresh,
 * and the output reader behind a Done or error tap. Pure, so every SDK limit is
 * met here by truncating first; the SDK constructors throw on overflow.
 *
 * Only an approval or a question carries actions. The glasses-hub hold keys on
 * "an Agents band with at least one action", so a Done, error or notice band
 * must never carry one.
 */
object AlertNotices {
    /** Where the glasses offer no Allow because agentd had to cut the command or path (R128). */
    const val COMMAND_CUT = "Command cut — review on laptop"

    /** The footer of a reminder band: agentd re-sent an alert still waiting for the wearer. */
    const val REMINDER = "Reminder"

    private const val TITLE_CHARS = 32
    private const val FOOTER_CHARS = 40
    private const val BRIEF_BODY_CHARS = 240
    private const val BRIEF_MAX_LINES = 8

    /**
     * The hub measures and pages the band; the plugin cannot. An approval has
     * three actions, which leaves it one page of eight lines, so the body is cut
     * to what eight lines of this many characters hold.
     */
    private const val BODY_LINES = 8
    private const val LINE_CHARS = 44
    private const val BODY_CHARS = BODY_LINES * LINE_CHARS

    private const val ACTION_TTL_MS = 45_000L
    private const val DONE_TTL_MS = 12_000L
    private const val NOTICE_TTL_MS = 8_000L

    private const val READER_SEGMENT_CHARS = 4_000
    private const val READER_MAX_SEGMENTS = 240
    private const val READER_TOTAL_CHARS = 40_000
    private const val READER_TITLE_CHARS = 110
    private const val READER_LINE_CHARS = 120

    fun build(alert: AgentdAction.Alert, wake: Boolean): NexusNotice =
        NexusNotice(
            title = title(alert),
            body = body(alert),
            footer = footer(alert),
            interactive = alert.kind == AlertKind.DONE || alert.kind == AlertKind.ERROR,
            actions = actions(alert),
            ttlMs = ttl(alert.kind),
            wakeDisplay = wake && alert.kind != AlertKind.NOTICE,
        )

    /**
     * The same band, refreshed in place. No actions: sending them would ask the
     * wearer the question again. An empty footer clears a stale `+N waiting`.
     */
    fun update(alert: AgentdAction.Alert): NexusNoticeUpdate = NexusNoticeUpdate(
        title = title(alert),
        body = body(alert),
        footer = footer(alert) ?: "",
    )

    /** A one-line message about what the wearer just did or could not do. */
    fun brief(title: String, body: String): NexusNotice = NexusNotice(
        title = title.line(TITLE_CHARS).ifEmpty { "Agents" },
        body = body.line(BRIEF_BODY_CHARS).ifEmpty { null },
        ttlMs = NOTICE_TTL_MS,
    )

    /** Several safety briefs in one band, one per line. */
    fun briefLines(title: String, lines: List<String>): NexusNotice = NexusNotice(
        title = title.line(TITLE_CHARS).ifEmpty { "Agents" },
        lines = lines.map { it.line(BRIEF_BODY_CHARS) }.filter(String::isNotEmpty).take(BRIEF_MAX_LINES),
        ttlMs = NOTICE_TTL_MS,
    )

    /**
     * The output a Done or error tap opens, at its newest message. [conversation] is the
     * readable conversation when it has loaded; until then the alert's summary and the
     * session's last assistant text stand in for it.
     */
    fun outputReader(
        alert: AgentdAction.Alert,
        session: AgentSession?,
        conversation: List<NexusReaderSegment>,
    ): NexusReader {
        val summary = alert.body.trim().ifEmpty { alert.title.trim() }.ifEmpty { providerLabel(alert) }
        val header = NexusReaderSegment(NexusReaderSegmentKind.HEADER, cut(summary, READER_SEGMENT_CHARS))
        // A conversation is a chat: oldest first, the newest turn last, and the reader opens there.
        // Its last turn is what the alert summarized, so the summary header only stands in until
        // the conversation arrives (then the newest turn would sit under an older summary).
        val segments = if (conversation.isNotEmpty()) {
            fitNewest(conversation, READER_TOTAL_CHARS)
        } else {
            val room = READER_TOTAL_CHARS - header.text.length
            listOf(header) + fitOldest(session?.lastAssistantText?.let(::proseSegments).orEmpty(), room)
        }
        return NexusReader(
            title = (session?.displayTitle ?: alert.title).line(READER_TITLE_CHARS).ifEmpty { "Agents" },
            subtitle = "${providerLabel(alert)} · ${alert.kind.wire}".take(READER_LINE_CHARS),
            footer = "swipe scroll · 2-tap back",
            contentKey = digest(alert.id + segments.joinToString("\u0000") { it.text }),
            handlesBack = true,
            segments = segments,
            // Stream-shaped: the glasses open it at the newest message, swiping back reaches older ones,
            // and a new message keeps a reader at the end there and leaves one scrolled up where it is.
            anchor = NexusReaderAnchor.BOTTOM,
        )
    }

    /**
     * What More opens before the decision card (R125): the request in full, summary
     * first, then what will run (agentd leads the body with the command or the
     * file) and the model's description. [held] is the v1 request agentd holds for
     * the same session, whose detail an older agentd left out of the body.
     */
    fun approvalReader(alert: AgentdAction.Alert, session: AgentSession?, held: AgentApproval?): NexusReader {
        val label = providerLabel(alert)
        val summary = listOfNotNull(label, alert.title.line(READER_LINE_CHARS).ifEmpty { null }).joinToString(" · ")
        val body = alert.body.trim().ifEmpty { alert.title.trim() }
        val extra = held?.detail?.trim()?.takeIf { it.isNotEmpty() && !body.contains(it) }
        val segments = buildList {
            add(NexusReaderSegment(NexusReaderSegmentKind.HEADER, cut(summary, READER_SEGMENT_CHARS)))
            if (alert.truncated) add(NexusReaderSegment(NexusReaderSegmentKind.HEADER, COMMAND_CUT, emphasis = true))
            addAll(proseSegments(body))
            if (alert.truncated) add(NexusReaderSegment(NexusReaderSegmentKind.ASIDE, "… $COMMAND_CUT"))
            extra?.let { addAll(proseSegments(it)) }
            add(NexusReaderSegment(NexusReaderSegmentKind.ASIDE, "tap to decide"))
        }.take(READER_MAX_SEGMENTS)
        return NexusReader(
            title = (session?.displayTitle ?: alert.title).line(READER_TITLE_CHARS).ifEmpty { "Permission" },
            subtitle = "$label · approve".take(READER_LINE_CHARS),
            footer = "swipe scroll · tap decide · 2-tap later",
            contentKey = digest("approve\u0000" + alert.id + segments.joinToString("\u0000") { it.text }),
            handlesBack = true,
            segments = fitOldest(segments, READER_TOTAL_CHARS),
            anchor = NexusReaderAnchor.TOP,
        )
    }

    private fun refusal(alert: AgentdAction.Alert): String? =
        alert.question?.refusal?.takeIf { alert.kind == AlertKind.QUESTION }

    /** The provider of the alert's session, as the band title names it. */
    fun providerLabel(alert: AgentdAction.Alert): String =
        when (AgentProvider.fromWire(alert.sessionKey.substringBefore(':'))) {
            AgentProvider.CLAUDE -> "CLAUDE"
            AgentProvider.CODEX -> "CODEX"
            null -> "AGENT"
        }

    private fun title(alert: AgentdAction.Alert): String {
        val label = providerLabel(alert)
        val text = when (alert.kind) {
            AlertKind.APPROVAL -> "$label · approve"
            AlertKind.QUESTION -> "$label · question"
            AlertKind.DONE -> "$label · done"
            AlertKind.ERROR -> "$label · error"
            AlertKind.NOTICE -> alert.title.line(TITLE_CHARS).ifEmpty { "$label · notice" }
        }
        return cut(text, TITLE_CHARS)
    }

    private fun body(alert: AgentdAction.Alert): String? {
        // A question the glasses cannot answer as sent says so, and where to answer it (R124).
        refusal(alert)?.let { return it }
        val text = alert.body.line(Int.MAX_VALUE)
        val capped = if (text.length > BODY_CHARS) cut(text, BODY_CHARS - 1) + "…" else text
        return capped.ifEmpty { null }
    }

    private fun footer(alert: AgentdAction.Alert): String? {
        val waiting = AlertCoordinator.footer(alert)
        // A reminder says so (it is silent on the glasses), in place of any other footer but the count.
        val text = if (alert.reason == AlertReason.REMINDER) {
            listOfNotNull(REMINDER, waiting).joinToString(" · ")
        } else {
            waiting ?: "TAP read".takeIf { alert.kind == AlertKind.DONE || alert.kind == AlertKind.ERROR }
        }
        return text?.let { cut(it, FOOTER_CHARS) }
    }

    /** Allow and Deny are always offered: a press with no secure link is answered by its brief, not hidden. */
    private fun actions(alert: AgentdAction.Alert): List<NexusNoticeAction> =
        when (alert.kind) {
            AlertKind.APPROVAL -> buildList {
                // A command the wearer cannot see whole is never allowed from the glasses (R128).
                if (!alert.truncated) add(NexusNoticeAction(AlertCoordinator.ALLOW, "check", "Allow"))
                add(NexusNoticeAction(AlertCoordinator.DENY, "close", "Deny"))
                add(NexusNoticeAction(AlertCoordinator.MORE, "dot", "More"))
            }
            AlertKind.QUESTION -> listOfNotNull(
                NexusNoticeAction(AlertCoordinator.ANSWER, "mic", "Answer").takeIf { refusal(alert) == null },
                NexusNoticeAction(AlertCoordinator.LATER, "timer", "Later"),
            )
            AlertKind.DONE, AlertKind.ERROR, AlertKind.NOTICE -> emptyList()
        }

    private fun ttl(kind: AlertKind): Long = when (kind) {
        AlertKind.APPROVAL, AlertKind.QUESTION -> ACTION_TTL_MS
        AlertKind.DONE, AlertKind.ERROR -> DONE_TTL_MS
        AlertKind.NOTICE -> NOTICE_TTL_MS
    }

    private fun proseSegments(text: String): List<NexusReaderSegment> =
        text.trim().chunked(READER_SEGMENT_CHARS)
            .filter { it.isNotBlank() }
            .map { NexusReaderSegment(NexusReaderSegmentKind.PROSE, it) }

    private fun fitOldest(segments: List<NexusReaderSegment>, chars: Int): List<NexusReaderSegment> {
        val kept = mutableListOf<NexusReaderSegment>()
        var used = 0
        for (segment in segments) {
            val text = cut(segment.text, READER_SEGMENT_CHARS)
            if (kept.size >= READER_MAX_SEGMENTS - 1 || used + text.length > chars) break
            kept += segment.copy(text = text)
            used += text.length
        }
        return kept
    }

    /** Keeps the newest segments that fit the reader's caps, each cut to the segment cap. */
    private fun fitNewest(segments: List<NexusReaderSegment>, chars: Int): List<NexusReaderSegment> {
        val room = chars.coerceAtLeast(0)
        val kept = ArrayDeque<NexusReaderSegment>()
        var used = 0
        for (segment in segments.asReversed()) {
            val text = cut(segment.text, READER_SEGMENT_CHARS)
            if (kept.size >= READER_MAX_SEGMENTS - 1 || used + text.length > room) break
            kept.addFirst(segment.copy(text = text))
            used += text.length
        }
        return kept.toList()
    }

    /** Whitespace collapsed to single spaces and cut surrogate-safely. */
    private fun String.line(max: Int): String = cut(replace(WHITESPACE, " ").trim(), max)

    private val WHITESPACE = Regex("\\s+")

    /** Never ends on half a surrogate pair. */
    private fun cut(text: String, max: Int): String {
        if (text.length <= max) return text
        val end = if (max > 0 && Character.isHighSurrogate(text[max - 1])) max - 1 else max
        return text.substring(0, end)
    }

    private fun digest(source: String): String =
        MessageDigest.getInstance("SHA-256").digest(source.toByteArray())
            .joinToString("") { "%02x".format(it) }.take(32)
}
