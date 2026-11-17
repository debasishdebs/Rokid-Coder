package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusCardLine
import com.anezium.rokidbus.client.plugin.NexusRowTone

/**
 * What one board row says on the glasses. Pure, so the copy and the SDK limits
 * (text and sub 240, badge 24, 8 trail entries of 24) are tested without the
 * service; every string is cut before a [NexusCardLine] is built, since the SDK
 * constructor throws on overflow.
 */
object BoardModel {
    private const val TEXT_CHARS = 120
    private const val SUB_CHARS = 240

    /** What the step keeps when a file shares the line, so a long path never pushes it out. */
    private const val STEP_CHARS = 80
    private const val FILE_STEP_SEPARATOR = " · "
    private const val BADGE_CHARS = 24
    private const val TRAIL_ITEMS = 8
    private const val TRAIL_ITEM_CHARS = 24

    /** The marker on a session whose hidden approval or question still waits for the wearer. */
    const val PENDING_TAG = "1 waiting"

    /**
     * The provider's own approval modes that run things without asking, so the
     * wearer can see that a session is loose even when agentd's temporary mode
     * is `ask`. Claude's `permission_mode` and Codex's `approvalPolicy` share
     * the one read-only field. `acceptEdits` is informational: it only skips
     * edit prompts, but the wearer should still see it.
     */
    private val PERMISSIVE_NATIVE_MODES = setOf("never", "bypassPermissions", "acceptEdits", "dontAsk")

    /**
     * One session. [fallbackSub] is what the row says when v2 gives no file or
     * step. The `+N waiting` row is drawn apart, by [waitingRow].
     */
    fun row(
        session: AgentSession,
        selected: Boolean,
        now: Long,
        fallbackSub: String? = null,
        /** An approval or question of this session is pending though its card left the glasses. */
        pending: Boolean = false,
    ): NexusCardLine {
        val v2 = session.v2
        val approveAll = v2?.tempMode == TempMode.APPROVE_ALL
        val trail = buildList {
            if (pending) add(PENDING_TAG)
            when (session.status) {
                AgentStatus.NEEDS_YOU -> add("ASK")
                AgentStatus.WORKING -> add("RUN")
                AgentStatus.ERROR -> add("ERR")
                AgentStatus.DONE -> add("done")
                AgentStatus.IDLE -> Unit
            }
            if (v2 == null) {
                // No v2 from this provider or daemon: the plain row, with its age.
                age(now, session.lastActivityAt)?.let(::add)
            } else {
                modeTag(v2.mode)?.let(::add)
                add(tempTag(v2.tempMode))
                v2.nativeMode?.takeIf { it in PERMISSIVE_NATIVE_MODES }?.let(::add)
            }
        }.take(TRAIL_ITEMS).map { it.take(TRAIL_ITEM_CHARS) }

        val heading = v2?.heading?.singleLine(TEXT_CHARS)?.takeIf(String::isNotBlank)
        val fileAndStep = v2?.let { fileAndStep(it.currentFile, it.step) }
        return NexusCardLine(
            text = heading ?: session.displayTitle.singleLine(TEXT_CHARS),
            badge = when (session.provider) {
                AgentProvider.CLAUDE -> "CLAUDE"
                AgentProvider.CODEX -> "CODEX"
            }.take(BADGE_CHARS),
            trail = trail,
            sub = listOfNotNull(session.subagents?.let { subagentsLine(it, now) }, fileAndStep ?: fallbackSub)
                .joinToString(FILE_STEP_SEPARATOR)
                .singleLine(SUB_CHARS)
                .takeIf(String::isNotBlank),
            // Approve-all is a standing permission, so it is loud whatever the session is doing.
            tone = if (approveAll) {
                NexusRowTone.ALERT
            } else {
                when (session.status) {
                    AgentStatus.NEEDS_YOU, AgentStatus.ERROR -> NexusRowTone.ALERT
                    AgentStatus.WORKING -> NexusRowTone.NORMAL
                    AgentStatus.IDLE, AgentStatus.DONE -> NexusRowTone.DIM
                }
            },
            selected = selected,
        )
    }

    /**
     * `file · step`, each part left out when absent. The file is the end of the
     * path, since the name is what matters on a small HUD, and the step has a
     * budget of its own so a long path cannot push it out.
     */
    private fun fileAndStep(currentFile: String?, rawStep: String?): String? {
        val file = currentFile?.singleLine(Int.MAX_VALUE)?.takeIf(String::isNotBlank)
        val step = rawStep?.singleLine(if (file == null) SUB_CHARS else STEP_CHARS)?.takeIf(String::isNotBlank)
        val fileBudget = SUB_CHARS - if (step == null) 0 else FILE_STEP_SEPARATOR.length + step.length
        return listOfNotNull(file?.let { endOfPath(it, fileBudget) }, step)
            .joinToString(FILE_STEP_SEPARATOR)
            .takeIf(String::isNotBlank)
    }

    /** The end of [path] within [budget], opened with an ellipsis and cut at a slash when it can be: `…/src/foo.ts`. */
    private fun endOfPath(path: String, budget: Int): String {
        if (path.length <= budget) return path
        val tail = path.takeLast(budget - 1)
        val slash = tail.indexOf('/')
        return "…" + if (slash >= 0) tail.substring(slash) else tail
    }

    /** True when the row shows an age, which only a clock can keep fresh. */
    fun showsAge(session: AgentSession): Boolean =
        session.subagents != null || session.v2 == null && session.lastActivityAt != null

    /** "2 subagents running · 3:12": the clock runs on this phone from [Subagents.since]. */
    fun subagentsLine(subagents: Subagents, now: Long): String {
        val label = if (subagents.running == 1) "1 subagent running" else "${subagents.running} subagents running"
        return subagents.since?.let { "$label · ${elapsed(now - it)}" } ?: label
    }

    /** `m:ss`, and `h:mm:ss` from the first hour; a start time ahead of this clock reads 0:00. */
    fun elapsed(ms: Long): String {
        val seconds = ms.coerceAtLeast(0L) / 1000L
        val hours = seconds / 3600L
        val minutes = seconds % 3600L / 60L
        val rest = seconds % 60L
        val mm = if (hours > 0) minutes.toString().padStart(2, '0') else minutes.toString()
        val ss = rest.toString().padStart(2, '0')
        return if (hours > 0) "$hours:$mm:$ss" else "$mm:$ss"
    }

    /** Virtual board row: the quiet toggle, first on the board. */
    const val QUIET_KEY = "!quiet"

    /** Virtual board row: Pair a computer, under Quiet, while no computer is paired, one is signed out or refused. */
    const val PAIR_KEY = "!pair-a-computer"

    /** Virtual board row: the door into the start-an-agent walk, last on the board. */
    const val START_KEY = "!start-an-agent"

    /** The first row of the board: whether alerts speak. ENTER toggles it. */
    fun quietRow(quiet: Boolean, selected: Boolean): NexusCardLine = NexusCardLine(
        text = if (quiet) "Quiet: on" else "Quiet: off",
        sub = if (quiet) "alerts stay silent" else "alerts speak a short cue",
        tone = NexusRowTone.DIM,
        selected = selected,
    )

    /**
     * The row [delta] steps from [selected] on the ring Quiet, [pair] when the board offers it,
     * each session, Start. A selection that is gone (a session that left the board, or none yet)
     * counts as the first session, or on an empty board the pair row, else Start.
     */
    fun step(sessionKeys: List<String>, selected: String?, delta: Int, pair: Boolean = false): String {
        val ring = listOf(QUIET_KEY) + listOfNotNull(PAIR_KEY.takeIf { pair }) + sessionKeys + START_KEY
        val at = ring.indexOf(selected).takeIf { it >= 0 }
            ?: when {
                sessionKeys.isNotEmpty() -> if (pair) 2 else 1
                pair -> 1
                else -> ring.lastIndex
            }
        return ring[((at + delta) % ring.size + ring.size) % ring.size]
    }

    /** The `+N waiting` row that heads the board while more alerts queue behind the current one. */
    fun waitingRow(waiting: Int): NexusCardLine? =
        if (waiting > 0) NexusCardLine(text = "+$waiting waiting", tone = NexusRowTone.ALERT) else null

    fun age(now: Long, at: Long?): String? {
        if (at == null) return null
        val elapsed = (now - at).coerceAtLeast(0)
        return when {
            elapsed < 60_000L -> "now"
            elapsed < 3_600_000L -> "${elapsed / 60_000L}m"
            elapsed < 86_400_000L -> "${elapsed / 3_600_000L}h"
            else -> "${elapsed / 86_400_000L}d"
        }
    }

    private fun modeTag(mode: String): String? = when (mode) {
        "plugin" -> "PLUGIN"
        "launcher" -> "LAUNCHER"
        else -> mode.singleLine(TRAIL_ITEM_CHARS).uppercase().takeIf(String::isNotBlank)
    }

    private fun tempTag(mode: TempMode): String = when (mode) {
        TempMode.ASK -> "ASK"
        TempMode.ACCEPT_EDITS -> "EDITS"
        TempMode.APPROVE_ALL -> "ALL"
    }
}
