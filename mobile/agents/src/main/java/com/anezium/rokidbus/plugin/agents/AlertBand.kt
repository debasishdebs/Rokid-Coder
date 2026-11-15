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
}
