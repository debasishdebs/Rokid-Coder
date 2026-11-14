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
    private const val BADGE_CHARS = 24
    private const val TRAIL_ITEMS = 8
    private const val TRAIL_ITEM_CHARS = 24

    /**
     * The provider's own approval modes that run things without asking, so the
     * wearer can see that a session is loose even when agentd's temporary mode
     * is `ask`. Claude's `permission_mode` and Codex's `approvalPolicy` share
     * the one read-only field.
     */
    private val PERMISSIVE_NATIVE_MODES = setOf("never", "bypassPermissions", "acceptEdits", "dontAsk")

    /**
     * One session. [waiting] is the current alert's `+N waiting`; it is drawn as
     * its own row ([waitingRow]) and changes nothing here. [fallbackSub] is what
     * the row says when v2 gives no file or step.
     */
    @Suppress("UNUSED_PARAMETER")
    fun row(
        session: AgentSession,
        selected: Boolean,
        now: Long,
        waiting: Int,
        fallbackSub: String? = null,
    ): NexusCardLine {
        val v2 = session.v2
        val approveAll = v2?.tempMode == TempMode.APPROVE_ALL
        val trail = buildList {
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
        val fileAndStep = v2?.let {
            listOfNotNull(it.currentFile, it.step)
                .map { part -> part.singleLine(SUB_CHARS) }
                .filter(String::isNotBlank)
                .joinToString(" · ")
                .takeIf(String::isNotBlank)
        }
        return NexusCardLine(
            text = heading ?: session.displayTitle.singleLine(TEXT_CHARS),
            badge = when (session.provider) {
                AgentProvider.CLAUDE -> "CLAUDE"
                AgentProvider.CODEX -> "CODEX"
                AgentProvider.OPENCLAW -> null
            }?.take(BADGE_CHARS),
            trail = trail,
            sub = (fileAndStep ?: fallbackSub)?.singleLine(SUB_CHARS)?.takeIf(String::isNotBlank),
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
