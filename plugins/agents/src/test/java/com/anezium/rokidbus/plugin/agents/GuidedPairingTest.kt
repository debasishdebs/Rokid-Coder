package com.anezium.rokidbus.plugin.agents

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GuidedPairingTest {
    private var now = 1_000L
    private val pairing = GuidedPairing(clock = { now })
    private val state: GuidedPairing.State get() = pairing.state.value

    @Test
    fun guided_pairing_open_then_paired() {
        assertEquals(GuidedPairing.State.Idle, state)
        pairing.start(setOf("desk"))
        assertEquals(GuidedPairing.State.DoorOpen(LINK_WINDOW_DURATION_MS), state)

        now += 30_000L
        pairing.tick(now)
        assertEquals(GuidedPairing.State.DoorOpen(LINK_WINDOW_DURATION_MS - 30_000L), state)

        pairing.onSecureConnected("laptop", "Laptop", atMs = now)
        assertEquals(GuidedPairing.State.Paired("Laptop"), state)
    }

    @Test
    fun guided_pairing_times_out_after_two_minutes() {
        pairing.start(emptySet())
        now += LINK_WINDOW_DURATION_MS - 1L
        pairing.tick(now)
        assertEquals(GuidedPairing.State.DoorOpen(1L), state)

        now += 1L
        pairing.tick(now)
        assertEquals(GuidedPairing.State.TimedOut, state)

        // Too late: a connection after the door shut completes nothing.
        pairing.onSecureConnected("laptop", "Laptop", atMs = now)
        assertEquals(GuidedPairing.State.TimedOut, state)
    }

    @Test
    fun already_trusted_computer_does_not_complete_attempt() {
        // Desk is trusted and connected when the attempt starts, and reconnects during the window.
        pairing.start(setOf("desk"))
        now += 10_000L
        pairing.onSecureConnected("desk", "Desk", atMs = now)
        assertTrue(state is GuidedPairing.State.DoorOpen)

        // A computer the baseline never held is attributable.
        pairing.onSecureConnected("laptop", "Laptop", atMs = now)
        assertEquals(GuidedPairing.State.Paired("Laptop"), state)
    }

    @Test
    fun repairing_computer_completes_on_new_secure_connect() {
        val start = now
        pairing.start(setOf("desk"), repairingMachineIds = setOf("desk"))

        // A connect stamped before the attempt began is the old link, not this one.
        pairing.onSecureConnected("desk", "Desk", atMs = start - 1L)
        assertTrue(state is GuidedPairing.State.DoorOpen)

        now += 5_000L
        pairing.onSecureConnected("desk", "Desk", atMs = now)
        assertEquals(GuidedPairing.State.Paired("Desk"), state)
    }

    @Test
    fun cancel_ends_the_attempt_and_later_connections_complete_nothing() {
        pairing.start(emptySet())
        pairing.cancel()
        assertEquals(GuidedPairing.State.Idle, state)
        pairing.onSecureConnected("laptop", "Laptop", atMs = now)
        assertEquals(GuidedPairing.State.Idle, state)
    }

    @Test
    fun a_connection_stamped_after_the_deadline_completes_nothing() {
        pairing.start(emptySet())
        pairing.onSecureConnected("laptop", "Laptop", atMs = now + LINK_WINDOW_DURATION_MS + 1L)
        assertTrue(state is GuidedPairing.State.DoorOpen)
    }

    @Test
    fun a_new_start_replaces_a_finished_attempt_and_acknowledge_clears_it() {
        pairing.start(emptySet())
        pairing.onSecureConnected("laptop", "Laptop", atMs = now)
        pairing.acknowledge()
        assertEquals(GuidedPairing.State.Idle, state)

        pairing.start(emptySet())
        // acknowledge never ends an attempt that is still open.
        pairing.acknowledge()
        assertTrue(state is GuidedPairing.State.DoorOpen)
    }

    @Test
    fun status_copy_is_verbatim() {
        assertEquals(
            "1 · On your computer: run rk claude (it offers to pair), or type /rokid:pair in Claude, or run agentd pair.",
            GuidedPairingCopy.STEP_ONE,
        )
        assertEquals("2 · Open the door for two minutes", GuidedPairingCopy.STEP_TWO)
        assertEquals("Other ways", GuidedPairingCopy.OTHER_WAYS)
        assertEquals(null, GuidedPairingCopy.status(GuidedPairing.State.Idle))
        assertEquals("Waiting for your computer…", GuidedPairingCopy.status(GuidedPairing.State.DoorOpen(5_000L)))
        assertEquals("Paired with Desk ✓", GuidedPairingCopy.status(GuidedPairing.State.Paired("Desk")))
        assertEquals("Time's up — tap 2 to try again", GuidedPairingCopy.status(GuidedPairing.State.TimedOut))
    }

    @Test
    fun countdown_reads_m_ss_and_counts_down_from_two_minutes() {
        assertEquals("2:00", GuidedPairingCopy.countdown(LINK_WINDOW_DURATION_MS))
        assertEquals("1:59", GuidedPairingCopy.countdown(LINK_WINDOW_DURATION_MS - 1_000L))
        assertEquals("0:01", GuidedPairingCopy.countdown(1L))
        assertEquals("DOOR OPEN · 1:05", GuidedPairingCopy.doorOpen(65_000L))
    }

    @Test
    fun pairing_is_needed_with_no_computer_a_signed_out_one_or_a_refused_one() {
        val desk = TrustedMachine("m1", "Desk", 1L)
        val slot = AgentdConfig("host", 1, "t", "Home", fp = "fp", steer = "s")

        assertTrue(pairingSnapshot(emptyList(), null, emptyList(), needsRepair = false).needed)
        assertFalse(pairingSnapshot(listOf(desk), null, emptyList(), needsRepair = false).needed)
        assertFalse(pairingSnapshot(emptyList(), slot, emptyList(), needsRepair = false).needed)
        assertTrue(pairingSnapshot(listOf(desk), null, listOf(SignedOut("Laptop", 1L, 14)), needsRepair = false).needed)
        assertTrue(pairingSnapshot(emptyList(), slot, emptyList(), needsRepair = true).needed)
    }

    @Test
    fun snapshot_baseline_holds_every_paired_computer_and_repairing_holds_the_ones_to_redo() {
        val desk = TrustedMachine("m1", "Desk", 1L)
        val slot = AgentdConfig("host", 1, "t", "Home", fp = "fp", steer = "s")

        val healthy = pairingSnapshot(listOf(desk), slot, emptyList(), needsRepair = false)
        assertEquals(setOf("m1", GuidedPairing.dialledId("Home")), healthy.baseline)
        assertEquals(emptySet<String>(), healthy.repairing)

        val refused = pairingSnapshot(listOf(desk), slot, emptyList(), needsRepair = true)
        assertEquals(setOf(GuidedPairing.dialledId("Home")), refused.repairing)

        val signedOut = pairingSnapshot(listOf(desk), null, listOf(SignedOut("Laptop", 1L, 14)), needsRepair = false)
        assertEquals(setOf(GuidedPairing.dialledId("Laptop")), signedOut.repairing)
    }
}
