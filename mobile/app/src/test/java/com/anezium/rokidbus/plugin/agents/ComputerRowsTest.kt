package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ComputerRowsTest {
    private val now = 100L * 3_600_000L
    private val mac = TrustedMachine("m1", "Debasishs-MacBook-Air.local", now - 19 * 3_600_000L)
    private val other = TrustedMachine("m2", "Desk", now - 3_600_000L)
    private val config = AgentdConfig("192.168.68.104", 8792, "tok", "Debasishs-MacBook-Air.local", fp = "AA", steer = "s")
    private val unreachable = PairingCopy.cantReach(listOf("192.168.68.104"))

    private fun link(address: String) = SecureLink("m1", "Mac", address)

    private fun build(
        trusted: List<TrustedMachine> = emptyList(),
        inbound: LinkMachine? = null,
        slot: DialledSlot? = null,
        belongs: Set<String> = emptySet(),
        reason: String? = null,
    ) = ComputerRows.build(trusted, { 0 }, inbound, slot, { it in belongs }, reason, now)

    @Test
    fun a_dialled_slot_alone_shows_route_and_address_when_connected() {
        val tailnet = build(slot = DialledSlot(config, null, link("100.101.102.103"))).single()
        assertTrue(tailnet.connected)
        assertNull(tailnet.machineId)
        assertEquals("Connected · over Tailscale · 192.168.68.104:8792", tailnet.sub)
        val lan = build(slot = DialledSlot(config, null, link("192.168.68.104"))).single()
        assertEquals("Connected · same Wi-Fi · 192.168.68.104:8792", lan.sub)
    }

    @Test
    fun a_dialled_slot_alone_says_why_when_not_connected_and_keeps_its_address() {
        val idle = build(slot = DialledSlot(config, null, null)).single()
        assertFalse(idle.connected)
        assertEquals("Paired by hand · 192.168.68.104:8792", idle.sub)
        val down = build(slot = DialledSlot(config, "m1", null), reason = unreachable).single()
        assertEquals("Paired by hand · 192.168.68.104:8792 · $unreachable", down.sub)
    }

    @Test
    fun alt_hosts_follow_the_address_and_an_old_slot_is_flagged() {
        val old = config.copy(altHosts = listOf("100.64.0.9"), steer = null)
        val row = build(slot = DialledSlot(old, null, null)).single()
        assertEquals(
            "Paired by hand · 192.168.68.104:8792, 100.64.0.9 · ${PairingCopy.OLDER_AGENTD}",
            row.sub,
        )
    }

    @Test
    fun the_slots_machine_and_its_trusted_row_are_one_row_that_the_dialled_link_lights() {
        val rows = build(
            trusted = listOf(mac, other),
            slot = DialledSlot(config, "m1", link("100.101.102.103")),
            belongs = setOf("m1"),
        )
        assertEquals(listOf("Debasishs-MacBook-Air.local", "Desk"), rows.map { it.title })
        assertTrue(rows[0].connected)
        assertEquals("m1", rows[0].machineId)
        assertEquals("Connected · over Tailscale", rows[0].sub)
        assertFalse(rows[1].connected)
        assertEquals("Last seen 1 h ago", rows[1].sub)
    }

    @Test
    fun the_same_pinned_computer_merges_even_when_the_slot_has_no_machine_id() {
        val rows = build(trusted = listOf(mac), slot = DialledSlot(config, null, null), belongs = setOf("m1"), reason = unreachable)
        assertEquals(1, rows.size)
        assertEquals(unreachable, rows.single().sub)
        assertEquals("m1", rows.single().machineId)
    }

    @Test
    fun a_merged_row_not_dialled_up_falls_back_to_last_seen() {
        val rows = build(trusted = listOf(mac), slot = DialledSlot(config, "m1", null), belongs = setOf("m1"))
        assertEquals("Last seen 19 h ago", rows.single().sub)
        assertFalse(rows.single().connected)
    }

    @Test
    fun an_inbound_link_still_lights_its_trusted_row() {
        val rows = build(trusted = listOf(mac), inbound = LinkMachine("m1", "Mac", overTailnet = false))
        assertEquals("Connected · same Wi-Fi", rows.single().sub)
        assertTrue(rows.single().connected)
    }

    @Test
    fun a_slot_for_another_computer_keeps_its_own_row_beside_the_trusted_one() {
        val rows = build(trusted = listOf(other), slot = DialledSlot(config, "m1", null))
        assertEquals(2, rows.size)
        assertNull(rows[1].machineId)
    }
}
