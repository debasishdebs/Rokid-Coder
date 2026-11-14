package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusPluginClient
import com.anezium.rokidbus.client.plugin.NexusSdkResult

/**
 * The band slot's glue: every notice this plugin raises goes through here, so
 * [GlassesScreen] always knows whether the band up now is a v2 alert's, and a
 * band taking the screen reaches the card under it.
 */
internal class AlertBand(
    private val client: () -> NexusPluginClient?,
    private val screen: GlassesScreen,
    private val attention: AttentionDecisionEngine,
) {
    /** A v2 alert's band; true when the hub took it. */
    fun show(notice: NexusNotice): Boolean {
        val client = client() ?: return false
        if (!client.supportsNoticeSurface) return false
        val taken = client.showNotice(notice) == NexusSdkResult.SENT
        if (taken) screen.bandTaken(v2 = true)
        return taken
    }

    fun update(update: NexusNoticeUpdate): Boolean {
        val client = client() ?: return false
        // A brief or status band took the slot since: the update would rewrite that one.
        return screen.v2BandUp && client.updateNotice(update) == NexusSdkResult.SENT
    }

    fun hide() {
        if (!screen.v2BandUp) return
        screen.bandHidden()
        client()?.hideNotice()
    }

    /** Every band that is not a v2 alert's goes through here, so the callbacks know whose band is up. */
    private fun showOther(client: NexusPluginClient, notice: NexusNotice): NexusSdkResult {
        val result = client.showNotice(notice)
        if (result == NexusSdkResult.SENT) screen.bandTaken(v2 = false)
        return result
    }

    fun briefNow(title: String, body: String) {
        val client = client()
        val shown = client != null && client.supportsNoticeSurface &&
            showOther(client, AlertNotices.brief(title, body)) == NexusSdkResult.SENT
        // A brief that never reached the glasses has no close coming: free its turn.
        if (!shown) AgentsRuntime.alertDirector?.onBriefClosed(NexusNoticeCloseReason.OWNER)
    }

    fun briefLines(title: String, lines: List<String>) {
        val client = client()
        val shown = client != null && client.supportsNoticeSurface &&
            showOther(client, AlertNotices.briefLines(title, lines)) == NexusSdkResult.SENT
        if (!shown) AgentsRuntime.alertDirector?.onBriefClosed(NexusNoticeCloseReason.OWNER)
    }

    /**
     * The phone stays silent by design, so this band is the only interruption
     * Agents ever makes. It is raised at most one at a time — several sessions
     * asking at once become one line, because a queue of bands is not an alert,
     * it is a nuisance — and the fingerprint is only committed once the hub has
     * actually taken the notice, so an alert that could not be delivered is
     * offered again on the next update instead of being lost.
     *
     * Returns the session the band is about, or null when none was raised.
     */
    fun raiseAttention(): String? {
        val client = client() ?: return null
        if (!client.supportsNoticeSurface) return null
        // An approval's band is never replaced by this one; the wearer's answer comes first.
        if (screen.v2BandUp || AgentsRuntime.alertDirector?.slotBusy == true) return null
        val director = AgentsRuntime.alertDirector
        val pending = attention.pending(AgentsRuntime.store.sessions.value) { session ->
            // A session that had a v2 alert is the alerts' to announce, not v1's.
            !v1AttentionApplies(session) || director?.hadAlert(session.key) == true
        }
        if (pending.isEmpty()) return null
        val notice = if (pending.size == 1) singleNotice(pending.single()) else groupNotice(pending)
        if (showOther(client, notice) != NexusSdkResult.SENT) return null
        pending.forEach(attention::commit)
        return pending.first().session.key
    }

    private fun singleNotice(item: AgentAttention): NexusNotice =
        AlertNotices.statusNotice(item.session, summary = BoardCards.pendingSummary(item.session))

    private fun groupNotice(items: List<AgentAttention>): NexusNotice {
        val waiting = items.count { it.session.status == AgentStatus.NEEDS_YOU }
        val failed = items.count { it.session.status == AgentStatus.ERROR }
        val parts = listOfNotNull(
            waiting.takeIf { it > 0 }?.let { "$it waiting for you" },
            failed.takeIf { it > 0 }?.let { "$it failed" },
        )
        return NexusNotice(
            title = "Agents",
            body = parts.joinToString(" · ").singleLine(NOTICE_BODY_CHARS),
            footer = "TAP open",
            interactive = true,
            ttlMs = ATTENTION_TTL_MS,
        )
    }

    private companion object {
        const val NOTICE_BODY_CHARS = 240
        const val ATTENTION_TTL_MS = 12_000L
    }
}

/**
 * The v1 status band is OpenClaw's only. agentd's own providers speak through
 * their v2 alerts, which every link agentd accepts carries; with no link up
 * the board shows the computer is not connected, and v1 does not stand in.
 */
internal fun v1AttentionApplies(session: AgentSession): Boolean = session.provider == AgentProvider.OPENCLAW
