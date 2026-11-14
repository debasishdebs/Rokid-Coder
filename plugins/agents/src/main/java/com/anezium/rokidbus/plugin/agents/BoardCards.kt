package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import com.anezium.rokidbus.client.plugin.NexusRowTone
import java.security.MessageDigest

/**
 * How the board, the control menu and the two decision cards are drawn. Pure
 * builders over what the service hands them: nothing here keeps state or decides
 * which card is on screen.
 */
internal object BoardCards {
    const val MENU_LINE_CHARS = 240
    const val VISIBLE_SESSION_ROWS = 6
    private const val MIN_SESSION_ROWS = 4
    private const val MAX_SIGNED_OUT_ROWS = 2
    private const val READER_SEGMENT_CHARS = 4_000
    private const val READER_MAX_SEGMENTS = 236

    private val PERMISSION_PATTERN =
        Regex("permission to use ([\\w.-]+)", RegexOption.IGNORE_CASE)

    fun card(
        title: String,
        subtitle: String,
        rows: List<NexusCardLine>,
        footer: String,
    ): NexusCard {
        val keySource = buildString {
            append(title).append('\n').append(subtitle).append('\n').append(footer).append('\n')
            rows.forEach { row ->
                append(row.badge).append('|').append(row.text).append('|')
                append(row.sub).append('|').append(row.tone.wireValue).append('|')
                append(row.selected).append('|').append(row.trail.joinToString(",")).append('\n')
            }
        }
        return NexusCard(
            title = title,
            lines = emptyList(),
            subtitle = subtitle,
            footer = footer,
            contentKey = MessageDigest.getInstance("SHA-256")
                .digest(keySource.toByteArray())
                .joinToString("") { "%02x".format(it) },
            richLines = rows,
            handlesBack = true,
        )
    }

    /** The HUD does not scroll: a window of rows around the selection. */
    fun <T> windowedRows(
        items: List<T>,
        selected: Int,
        row: (T, Boolean) -> NexusCardLine,
    ): List<NexusCardLine> = windowedRowGroups(items, selected) { item, isSelected -> listOf(row(item, isSelected)) }

    /** The same window, where one item may take several lines (a long text that must be shown whole). */
    fun <T> windowedRowGroups(
        items: List<T>,
        selected: Int,
        rows: (T, Boolean) -> List<NexusCardLine>,
    ): List<NexusCardLine> {
        val start = (selected - VISIBLE_SESSION_ROWS / 2)
            .coerceIn(0, (items.size - VISIBLE_SESSION_ROWS).coerceAtLeast(0))
        return items.drop(start).take(VISIBLE_SESSION_ROWS).flatMapIndexed { offset, item ->
            rows(item, start + offset == selected)
        }
    }

    // ---------------------------------------------------------------- sessions

    /** The board, and the session the selection resolved to (null on the Quiet or start row). */
    class Board(val card: NexusCard, val selectedKey: String?)

    fun sessionsCard(
        sessions: List<AgentSession>,
        connections: Map<AgentProvider, ProviderConnectionState>,
        config: AgentsConfig,
        selectedKey: String?,
        waiting: Int,
        quiet: Boolean,
        now: Long,
        signedOut: List<SignedOut> = emptyList(),
        /** No computer is paired, one is signed out, or one was refused: the board offers Pair a computer. */
        pairing: Boolean = false,
    ): Board {
        val waitingRow = BoardModel.waitingRow(waiting)
        // Monitoring that is off has nothing to pair with: that row says to set up a provider first.
        val pairRow = pairing && config.agentdEnabled
        val quietSelected = selectedKey == BoardModel.QUIET_KEY
        val startPicked = selectedKey == BoardModel.START_KEY
        // An empty board has nothing else to rest on: the pair row, or Start when there is no pair row.
        val pairSelected = pairRow && !quietSelected && !startPicked &&
            (selectedKey == BoardModel.PAIR_KEY || sessions.isEmpty())
        val startSelected = !quietSelected && !pairSelected && (startPicked || sessions.isEmpty())
        val onSession = !quietSelected && !startSelected && !pairSelected
        val selectedIndex = if (onSession) selectedIndexIn(sessions, selectedKey) else -1
        val resolvedKey = when {
            onSession -> sessions.getOrNull(selectedIndex)?.key
            pairSelected -> BoardModel.PAIR_KEY
            else -> selectedKey
        }

        val alerts = buildList {
            waitingRow?.let(::add)
            // The HUD does not scroll, so a pile of them shows the latest two; Settings lists every one.
            signedOut.take(MAX_SIGNED_OUT_ROWS).forEach { add(problemRow("Signed out of ${it.name}", "pair again: Add a computer")) }
            if (config.agentdEnabled &&
                connections[AgentProvider.CLAUDE]?.state == ConnectionState.AUTH_FAILED
            ) {
                add(problemRow("Claude pairing rejected", "re-pair in the phone app"))
            }
            if (config.openClawEnabled &&
                connections[AgentProvider.OPENCLAW]?.state == ConnectionState.AUTH_FAILED
            ) {
                add(problemRow("OpenClaw auth failed", "check the token in the phone app"))
            }
        }

        // The HUD does not scroll: keep a window around the selection.
        val windowSize = (VISIBLE_SESSION_ROWS - alerts.size - 1 - if (pairRow) 1 else 0)
            .coerceAtLeast(MIN_SESSION_ROWS)
        val anchor = when {
            startSelected -> sessions.lastIndex.coerceAtLeast(0)
            quietSelected || pairSelected -> 0
            else -> selectedIndex
        }
        val windowStart = (anchor - windowSize / 2)
            .coerceIn(0, (sessions.size - windowSize).coerceAtLeast(0))

        val rows = buildList {
            addAll(alerts)
            add(BoardModel.quietRow(quiet, quietSelected))
            if (pairRow) add(pairRow(pairSelected))
            if (sessions.isEmpty()) {
                // The pair row already says what to do about an empty board.
                if (!pairRow) add(emptyRow(config))
            } else {
                sessions.drop(windowStart).take(windowSize).forEachIndexed { offset, session ->
                    add(sessionRow(session, windowStart + offset == selectedIndex, now))
                }
            }
            add(
                NexusCardLine(
                    text = "+ Start an agent",
                    sub = "a new thread in one of your projects",
                    tone = NexusRowTone.DIM,
                    selected = startSelected,
                ),
            )
        }

        return Board(
            card(
                title = "Agents",
                subtitle = sessionsSubtitle(sessions, connections, config),
                rows = rows,
                footer = if (sessions.isEmpty()) {
                    if (pairRow) "tap pair a computer · 2-tap exit" else "tap start an agent · 2-tap exit"
                } else {
                    "swipe move · tap open · 2-tap exit"
                },
            ),
            resolvedKey,
        )
    }

    fun selectedIndexIn(sessions: List<AgentSession>, selectedKey: String?): Int =
        sessions.indexOfFirst { it.key == selectedKey }.takeIf { it >= 0 } ?: 0

    fun sessionRow(session: AgentSession, selected: Boolean, now: Long): NexusCardLine =
        BoardModel.row(
            session,
            selected,
            now,
            fallbackSub = sessionSub(session),
        )

    /** The line that says what this session is actually doing to you, or for you. */
    private fun sessionSub(session: AgentSession): String? = when (session.status) {
        AgentStatus.NEEDS_YOU -> pendingSummary(session)
        AgentStatus.ERROR -> session.statusDetail ?: "stopped with an error"
        AgentStatus.WORKING -> session.turn?.lastTool?.let { "running $it" }
            ?: session.lastAssistantText
        // Quiet sessions: where they live is the only thing worth a second line.
        AgentStatus.IDLE, AgentStatus.DONE -> session.project?.takeIf(String::isNotBlank)
    }

    /**
     * Rewrites the stock Claude notification wording into a board-sized phrase.
     * A live approval outranks it: that one is the agent's actual question,
     * where the other is what monitoring inferred about the session.
     */
    fun pendingSummary(session: AgentSession): String {
        AgentsRuntime.store.approvalFor(session.key)?.let { return it.summary.singleLine(160) }
        val raw = session.pendingRequest?.summary?.singleLine(160) ?: return "needs you"
        PERMISSION_PATTERN.find(raw)?.let { return "wants to run ${it.groupValues[1]}" }
        if (raw.contains("waiting for your input", ignoreCase = true)) return "waiting for you"
        return raw
    }

    private fun sessionsSubtitle(
        sessions: List<AgentSession>,
        connections: Map<AgentProvider, ProviderConnectionState>,
        config: AgentsConfig,
    ): String {
        val counts = listOfNotNull(
            sessions.count { it.status == AgentStatus.NEEDS_YOU }
                .takeIf { it > 0 }?.let { "$it waiting" },
            sessions.count { it.status == AgentStatus.WORKING }
                .takeIf { it > 0 }?.let { "$it running" },
            sessions.count { it.status == AgentStatus.ERROR }
                .takeIf { it > 0 }?.let { "$it failed" },
            sessions.count { it.status == AgentStatus.IDLE }
                .takeIf { it > 0 }?.let { "$it idle" },
        )
        if (counts.isNotEmpty()) {
            return counts.joinToString(" · ").take(120)
        }
        val connecting = AgentProvider.values().any { provider ->
            provider.enabledIn(config) &&
                connections[provider]?.state == ConnectionState.CONNECTING
        }
        return if (connecting) "connecting…" else "no sessions"
    }

    private fun emptyRow(config: AgentsConfig): NexusCardLine = NexusCardLine(
        text = if (config.agentdEnabled || config.openClawEnabled) {
            "Nothing running"
        } else {
            "Set up a provider in the phone app"
        },
        sub = if (config.agentdEnabled || config.openClawEnabled) {
            "sessions appear here as soon as an agent starts"
        } else {
            null
        },
        tone = NexusRowTone.DIM,
    )

    private fun pairRow(selected: Boolean): NexusCardLine = NexusCardLine(
        text = "Pair a computer",
        sub = "tap to start",
        tone = NexusRowTone.NORMAL,
        selected = selected,
    )

    private fun problemRow(text: String, sub: String): NexusCardLine =
        NexusCardLine(text = text, sub = sub, tone = NexusRowTone.ALERT, trail = listOf("!"))

    // -------------------------------------------------------------------- menu

    fun menuCard(page: ControlMenu.Page): NexusCard {
        val rows = windowedRows(page.rows, page.selected) { row, selected ->
            NexusCardLine(
                text = row.text.take(MENU_LINE_CHARS),
                sub = row.sub?.take(MENU_LINE_CHARS),
                tone = row.tone,
                selected = selected,
            )
        }
        return card(title = page.title, subtitle = page.subtitle, rows = rows, footer = page.footer)
    }

    /** What a menu row too long for a line opens: its full text, to scroll. */
    fun menuReader(title: String, text: String): NexusReader {
        val segments = text.chunked(READER_SEGMENT_CHARS)
            .filter { it.isNotBlank() }
            .take(READER_MAX_SEGMENTS)
            .map { NexusReaderSegment(NexusReaderSegmentKind.PROSE, it) }
            .ifEmpty { listOf(NexusReaderSegment(NexusReaderSegmentKind.PROSE, "…")) }
        return NexusReader(
            title = title.singleLine(110).ifBlank { "Agents" },
            footer = "swipe scroll · 2-tap back",
            handlesBack = true,
            contentKey = "menu:${text.hashCode()}",
            segments = segments,
        )
    }

    // ----------------------------------------------------------------- decide

    /**
     * The one screen in this product that does something rather than show
     * something. It says what will run, in the agent's own words, and offers
     * exactly two answers — no third path, no "always allow", nothing that turns
     * a glance into a standing permission.
     */
    /** The most of a held call's detail its card shows whole: two rows. Past it the card offers Deny only (R128). */
    private const val REQUEST_DETAIL_CHARS = 2 * MENU_LINE_CHARS

    /** True when the held call's card shows what will run whole, so it may offer Allow. */
    fun requestShowsWhole(approval: AgentApproval): Boolean =
        (approval.detail?.singleLine(Int.MAX_VALUE)?.length ?: 0) <= REQUEST_DETAIL_CHARS

    fun decisionCard(approval: AgentApproval?, session: AgentSession?, choice: ApprovalDecision): NexusCard {
        if (approval == null) return expiredDecisionCard()
        val whole = requestShowsWhole(approval)
        val rows = buildList {
            add(
                NexusCardLine(
                    text = approval.summary.singleLine(238),
                    badge = approval.tool.take(6).ifBlank { "ASK" },
                    tone = NexusRowTone.BODY,
                ),
            )
            // What will run, whole, in two rows at most; one that does not fit is cut, said, and cannot be allowed.
            approval.detail
                ?.takeIf { it.isNotBlank() && it != approval.summary }
                ?.singleLine(Int.MAX_VALUE)
                ?.let { if (whole) it else it.take(REQUEST_DETAIL_CHARS - 1) + "…" }
                ?.chunked(MENU_LINE_CHARS)
                ?.forEach { add(NexusCardLine(text = it, tone = NexusRowTone.BODY)) }
            if (whole) {
                add(choiceRow("Allow", "let it run", choice == ApprovalDecision.ALLOW))
            } else {
                add(NexusCardLine(text = AlertNotices.COMMAND_CUT, tone = NexusRowTone.ALERT))
            }
            add(choiceRow("Deny", "tell the agent no", choice == ApprovalDecision.DENY))
        }
        return card(
            title = session?.displayTitle?.singleLine(110) ?: "Permission",
            subtitle = listOfNotNull(
                approval.tool.takeIf(String::isNotBlank),
                session?.project?.takeIf(String::isNotBlank),
                "waiting for you",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = "swipe choose · tap confirm · 2-tap later",
        )
    }

    /** The card behind a band's More: the same two answers, bound to the alert it was opened for. */
    fun alertDecisionCard(
        alert: AgentdAction.Alert,
        session: AgentSession?,
        choices: List<GlassesScreen.AlertRow>,
        row: Int,
    ): NexusCard {
        val rows = buildList {
            add(
                NexusCardLine(
                    text = alert.body.ifBlank { alert.title }.singleLine(Int.MAX_VALUE).let {
                        if (it.length > 238) it.take(237) + "…" else it
                    },
                    badge = AlertNotices.providerLabel(alert).take(6),
                    tone = NexusRowTone.BODY,
                ),
            )
            // Always offered: a confirm with no secure link is answered by the Not sent brief.
            if (alert.truncated) add(NexusCardLine(text = AlertNotices.COMMAND_CUT, tone = NexusRowTone.ALERT))
            choices.forEachIndexed { index, choice ->
                add(
                    when (choice) {
                        GlassesScreen.AlertRow.ALLOW -> choiceRow("Allow", "let it run", row == index)
                        GlassesScreen.AlertRow.DENY -> choiceRow("Deny", "tell the agent no", row == index)
                        GlassesScreen.AlertRow.VOICE ->
                            choiceRow(VoiceApproval.PROMPT, "asks you to confirm", row == index)
                    },
                )
            }
        }
        return card(
            title = session?.displayTitle?.singleLine(110) ?: alert.title.singleLine(110).ifEmpty { "Permission" },
            subtitle = listOfNotNull(
                session?.project?.takeIf(String::isNotBlank),
                "waiting for you",
            ).joinToString(" · ").take(120),
            rows = rows,
            footer = "swipe choose · tap confirm · 2-tap later",
        )
    }

    private fun choiceRow(label: String, sub: String, picked: Boolean): NexusCardLine = NexusCardLine(
        text = label,
        sub = sub,
        selected = picked,
        tone = if (picked) NexusRowTone.ALERT else NexusRowTone.DIM,
    )

    private fun expiredDecisionCard(): NexusCard = card(
        title = "Too late",
        subtitle = "the agent stopped waiting",
        rows = listOf(
            NexusCardLine(
                text = "This request is gone",
                sub = "it timed out, or it was answered on the computer",
                tone = NexusRowTone.DIM,
            ),
        ),
        footer = "2-tap back",
    )
}

internal fun AgentProvider.enabledIn(config: AgentsConfig): Boolean = when (this) {
    // Codex rides the daemon link rather than a connection of its own, so it is
    // on exactly when the daemon is. It gets its own switch when the settings
    // screen learns to offer a choice of harness.
    AgentProvider.CLAUDE, AgentProvider.CODEX -> config.agentdEnabled
    AgentProvider.OPENCLAW -> config.openClawEnabled
}
