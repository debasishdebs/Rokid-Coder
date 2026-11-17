package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.plugin.agents.connectors.isTailnetAddress as isTailnetHost
import com.anezium.rokidbus.plugin.agents.ui.ComputerRow

/** The slot this phone dials, and the secure outbound link up on it right now, if any. */
internal data class DialledSlot(val config: AgentdConfig, val machineId: String?, val link: SecureLink?)

/** What the computer's own page says about it: [line] under its name, and [reason] it is not answering, if it is not. */
internal data class ComputerStatus(val connected: Boolean, val line: String, val reason: String?)

internal object ComputerRows {
    const val PAIRED_BY_HAND = "Paired by hand"

    fun route(overTailnet: Boolean) = if (overTailnet) "Connected · over Tailscale" else "Connected · same Wi-Fi"

    /**
     * The link the phone dialled, not the one agentd dialled: the key's transport tells them apart. A slot that
     * knows its machine only counts links to that machine.
     */
    fun dialledSlot(paired: AgentdConfig?, slotMachineId: String?, links: Map<LinkKey, SecureLink>): DialledSlot? {
        paired ?: return null
        val link = links.entries
            .firstOrNull { it.key.transport == LinkTransport.OUTBOUND && (slotMachineId == null || it.value.machineId == slotMachineId) }
            ?.value
        return DialledSlot(paired, slotMachineId, link)
    }

    /** The trusted machine the dialled slot is: its id, or the pin its pairing recorded. */
    private fun slotMachineOf(
        trusted: List<TrustedMachine>,
        slot: DialledSlot?,
        slotBelongsTo: (String) -> Boolean,
    ): TrustedMachine? = slot?.let { s ->
        trusted.firstOrNull { s.machineId == it.machineId || slotBelongsTo(it.machineId) }
    }

    /**
     * The route a computer is connected by, or null when neither link is up on it: the inbound link (agentd
     * dialled the phone) or the outbound one (the phone dialled it, [isSlot]), whichever is live.
     */
    private fun liveRoute(machineId: String, isSlot: Boolean, inbound: LinkMachine?, slot: DialledSlot?): String? {
        val dialled = slot?.link?.takeIf { isSlot }
        return when {
            inbound?.machineId == machineId -> route(inbound.overTailnet)
            dialled != null -> route(isTailnetHost(dialled.remoteAddress))
            else -> null
        }
    }

    /**
     * The computer page's status line. It reads the same links as the Settings rows, so it never disagrees
     * with them: connected by either link is connected, and the [unreachable] reason shows only for the
     * computer the phone dials, when neither link is up.
     */
    fun status(
        machineId: String,
        trusted: List<TrustedMachine>,
        inbound: LinkMachine?,
        slot: DialledSlot?,
        slotBelongsTo: (String) -> Boolean,
        unreachable: String?,
        now: Long,
    ): ComputerStatus {
        val machine = trusted.firstOrNull { it.machineId == machineId }
        val isSlot = slot != null && (slot.machineId == machineId ||
            machine != null && machine === slotMachineOf(trusted, slot, slotBelongsTo))
        val live = liveRoute(machineId, isSlot, inbound, slot)
        if (live != null) return ComputerStatus(true, live.uppercase(), null)
        return ComputerStatus(
            connected = false,
            line = lastSeenText(machine?.lastSeenAtMs, now).uppercase(),
            reason = unreachable.takeIf { isSlot },
        )
    }

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
        val slotMachine = slotMachineOf(trusted, slot, slotBelongsTo)
        val rows = trusted.map { machine ->
            val isSlot = machine === slotMachine
            val via = liveRoute(machine.machineId, isSlot, inbound, slot)
            val connected = via != null
            val sub = when {
                via != null -> via
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
