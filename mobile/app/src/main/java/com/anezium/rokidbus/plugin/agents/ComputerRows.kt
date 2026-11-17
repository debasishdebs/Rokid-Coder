package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.plugin.agents.connectors.isTailnetAddress as isTailnetHost
import com.anezium.rokidbus.plugin.agents.ui.ComputerRow

/** The slot this phone dials, and the secure outbound link up on it right now, if any. */
internal data class DialledSlot(val config: AgentdConfig, val machineId: String?, val link: SecureLink?)

internal object ComputerRows {
    const val PAIRED_BY_HAND = "Paired by hand"

    fun route(overTailnet: Boolean) = if (overTailnet) "Connected · over Tailscale" else "Connected · same Wi-Fi"

    /**
     * One row per computer. The slot's machine is the same computer as a trusted one when
     * [slotBelongsTo] says so (its id, or the pin its pairing recorded): that computer then gets a
     * single row, and the dialled link counts for it as much as the inbound one. A slot with no
     * trusted machine keeps its own row, which has no machine id and is forgotten from the card.
     * [unreachable] is why the dialled computer is not answering, when it is not.
     */
    fun build(
        trusted: List<TrustedMachine>,
        projectCount: (String) -> Int,
        inbound: LinkMachine?,
        slot: DialledSlot?,
        slotBelongsTo: (String) -> Boolean,
        unreachable: String?,
        now: Long,
    ): List<ComputerRow> {
        val slotMachine = slot?.let { s ->
            trusted.firstOrNull { s.machineId == it.machineId || slotBelongsTo(it.machineId) }
        }
        val rows = trusted.map { machine ->
            val isSlot = machine === slotMachine
            val inboundUp = inbound?.machineId == machine.machineId
            val dialledUp = isSlot && slot?.link != null
            val connected = inboundUp || dialledUp
            val sub = when {
                inboundUp -> route(inbound!!.overTailnet)
                dialledUp -> route(isTailnetHost(slot!!.link!!.remoteAddress))
                isSlot && unreachable != null -> unreachable
                else -> lastSeenText(machine.lastSeenAtMs, now)
            }
            val projects = projectCount(machine.machineId)
            ComputerRow(
                title = machine.name,
                sub = if (projects > 0) "$sub · $projects ${if (projects == 1) "project" else "projects"}" else sub,
                connected = connected,
                machineId = machine.machineId,
            )
        }
        val paired = slot?.config ?: return rows
        if (slotMachine != null) return rows
        val addresses = (listOf("${paired.host}:${paired.port}") + paired.altHosts).joinToString(", ")
        val live = slot.link
        val sub = if (live != null) {
            "${route(isTailnetHost(live.remoteAddress))} · $addresses"
        } else {
            "$PAIRED_BY_HAND · $addresses" + unreachable?.let { " · $it" }.orEmpty()
        }
        return rows + ComputerRow(
            title = paired.name,
            // agentd admits only a pinned link with the steering secret; a slot without them is never dialled.
            sub = if (paired.canSteer) sub else "$sub · ${PairingCopy.OLDER_AGENTD}",
            connected = live != null,
            machineId = null,
        )
    }
}
