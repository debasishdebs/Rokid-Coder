package com.anezium.rokidbus.plugin.agents

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * One logical pairing per (computer, phone) (6a-R3): the credentials a SAS pairing hands over
 * land as ONE atomic [PairingRecord] write that holds both the outbound slot and the PhoneLink
 * machine trust, and forget, the TTL and refusal act on the whole of it.
 */
class PairingRecordTest {
    private var now = 10L * DAY
    private val prefs = MemoryPrefs()
    private val store = AgentsConfigStore(prefs, wallClock = { now }, elapsedRealtime = { 0L })
    private val agentdFp = "AB:".repeat(31) + "AB"
    private val record = PairingRecord(
        machineId = "pc-1",
        machineName = "Desk",
        agentdFp = agentdFp,
        token = "token-0123456789",
        steer = "steer-secret-0123456789abcdefghijk",
        wsHost = "10.0.0.2",
        wsPort = 8792,
        attempt = "0123456789abcdef",
    )

    @Test
    fun one_write_holds_both_the_outbound_slot_and_the_machine_trust() {
        assertTrue(store.commitPairing(record))
        val slot = store.load().agentd!!
        assertEquals("10.0.0.2", slot.host)
        assertEquals(8792, slot.port)
        assertEquals(agentdFp, slot.fp)
        assertTrue(slot.canSteer)
        assertTrue(store.isClientCertPinned("pc-1", agentdFp))
        assertEquals(MachineTrustResult.TRUSTED, store.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
        assertEquals(record, store.pairingRecordForCert(agentdFp))
    }

    @Test
    fun prefs_disk_failure_never_publishes_trust() {
        // Android's commit() changes the in-memory map first and only then finds the disk write failed.
        val failing = AndroidFailingPrefs(prefs)
        val store = AgentsConfigStore(failing, wallClock = { now }, elapsedRealtime = { 0L })
        assertTrue(store.commitPairing(record.copy(machineId = "pc-0", agentdFp = "EF:".repeat(31) + "EF")))
        failing.failCommits = true
        // A second reader of the same prefs, as the PhoneLink listener is, looks while the write is under way.
        val reader = AgentsConfigStore(failing, wallClock = { now }, elapsedRealtime = { 0L })
        var seenDuringWrite: Boolean? = null
        val readerThread = Thread { seenDuringWrite = reader.isMachineTrusted("pc-1", "token-0123456789") }
        failing.duringCommit = { readerThread.start() }
        assertFalse(store.commitPairing(record))
        readerThread.join(5_000)
        assertEquals(false, seenDuringWrite)
        for (view in listOf(store, AgentsConfigStore(failing, wallClock = { now }, elapsedRealtime = { 0L }))) {
            assertFalse(view.isMachineTrusted("pc-1", "token-0123456789"))
            assertFalse(view.isClientCertPinned("pc-1", agentdFp))
            assertNull(view.pairingRecordForCert(agentdFp))
            assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, view.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
            // The slot is still the earlier computer's, exactly as it was.
            assertEquals("pc-0", view.slotMachineId())
            assertEquals("EF:".repeat(31) + "EF", view.load().agentd?.fp)
        }
        assertFalse(prefs.map.keys.any { it.endsWith("pc-1") })
    }

    @Test
    fun refusal_then_restart_never_retries_without_sas() {
        store.commitPairing(record)
        // agentd refused the slot's hello: the whole pairing goes, both transports.
        assertEquals("pc-1", store.revokeRefusedPairing())
        // The service restarts: nothing is left to dial or to admit without a new SAS pairing.
        val restarted = AgentsConfigStore(prefs, wallClock = { now }, elapsedRealtime = { 0L })
        assertNull(restarted.load().agentd)
        assertFalse(restarted.outboundAdmitted())
        assertFalse(restarted.isMachineTrusted("pc-1", "token-0123456789"))
        assertFalse(restarted.isClientCertPinned("pc-1", agentdFp))
        assertNull(restarted.pairingRecordForCert(agentdFp))
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, restarted.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
        assertFalse(prefs.map.keys.any { it.startsWith("agentd.token") || it.startsWith("agentd.steer") || it.startsWith("agentd.fp") })
        // A slot a SAS pairing did not make (no machine id) is no exception.
        store.saveAgentd(record.outbound(), enabled = true)
        assertNull(store.slotMachineId())
        assertNull(store.revokeRefusedPairing())
        assertNull(AgentsConfigStore(prefs, wallClock = { now }, elapsedRealtime = { 0L }).load().agentd)
    }

    @Test
    fun a_failed_write_leaves_nothing_behind() {
        val failing = AgentsConfigStore(FailingPrefs(), wallClock = { now }, elapsedRealtime = { 0L })
        assertFalse(failing.commitPairing(record))
        assertNull(failing.load().agentd)
        assertNull(failing.pairingRecordForCert(agentdFp))
    }

    @Test
    fun pinned_reconnect_needs_no_sas_on_both_transports() {
        store.commitPairing(record)
        // PhoneLink: the hello with the token from the pinned cert is trusted as it stands.
        assertEquals(MachineTrustResult.TRUSTED, store.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
        // wss: the slot holds the pin and the steering secret, which is all AgentdClient dials with.
        assertTrue(store.load().agentd!!.canSteer)
        assertTrue(store.outboundAdmitted())
    }

    @Test
    fun a_new_computer_is_never_trusted_by_its_hello_even_with_the_door_open() {
        store.armLinkWindow()
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, store.authorizeMachine("pc-9", "t", "Other", agentdFp))
        assertFalse(prefs.map.keys.any { it.startsWith("machine.token.") })
    }

    @Test
    fun forget_on_phone_revokes_both_transports() {
        store.commitPairing(record)
        store.forgetPairing("pc-1")
        assertNull(store.load().agentd, "the outbound slot went with it")
        assertFalse(store.isClientCertPinned("pc-1", agentdFp))
        assertNull(store.pairingRecordForCert(agentdFp))
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, store.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
    }

    @Test
    fun revoked_pairing_cannot_reconnect_in_either_direction() {
        store.commitPairing(record)
        store.forgetPairing("pc-1")
        assertFalse("nothing to dial", store.outboundAdmitted())
        assertEquals(MachineTrustResult.REJECTED_NOT_INVITED, store.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
    }

    @Test
    fun ttl_uses_latest_activity_of_either_transport() {
        store.setPairingTtlDays(3)
        store.commitPairing(record)
        // Used over PhoneLink only, every day: the wss slot is not stale either.
        repeat(5) {
            now += DAY
            store.touchMachineSeen("pc-1")
            assertTrue(store.expireUnused().isEmpty())
        }
        assertTrue("the slot is admitted on the record's latest use", store.outboundAdmitted())
        // Then used over wss only: PhoneLink keeps its trust too.
        repeat(5) {
            now += DAY
            store.touchAgentdUsed()
            assertTrue(store.expireUnused().isEmpty())
        }
        assertEquals(MachineTrustResult.TRUSTED, store.authorizeMachine("pc-1", "token-0123456789", "Desk", agentdFp))
        // Unused on both past the TTL: the whole record signs out.
        now += 4 * DAY
        assertEquals(listOf("Desk"), store.expireUnused().map { it.name }.distinct())
        assertNull(store.load().agentd?.takeIf { it.canSteer })
        assertFalse(store.isClientCertPinned("pc-1", agentdFp))
    }

    @Test
    fun legacy_line_with_secrets_refused() {
        val legacy = """{"v":1,"kind":"nexus-agentd","name":"Desk","host":"10.0.0.2","port":8792,""" +
            """"token":"token-0123456789","fp":"$agentdFp","steer":"steer-secret-0123456789abcdefghijk"}"""
        assertEquals(
            AgentdPairingParseResult.Invalid("This pairing line is from an older version — pair again"),
            AgentdPairingParser.parse(legacy),
        )
        // A v2 kind that smuggles a secret is not a v2 line either.
        val smuggled = """{"v":2,"kind":"rokid-coder","host":"10.0.0.2","port":8792,"fp":"$agentdFp","token":"t"}"""
        assertEquals(PairingCopy.LEGACY_LINE, (AgentdPairingParser.parse(smuggled) as AgentdPairingParseResult.Invalid).reason)
    }

    @Test
    fun qr_v2_has_no_secrets_and_still_requires_sas() {
        val line = """{"v":2,"kind":"rokid-coder","host":"10.0.0.2","port":8792,"fp":"$agentdFp"}"""
        val target = (AgentdPairingParser.parse(line) as AgentdPairingParseResult.Valid).target
        assertEquals(PairLineTarget(host = "10.0.0.2", port = 8792, fp = agentdFp), target)
        // The line alone pairs nothing: no slot, no machine.
        assertNull(store.load().agentd)
        assertTrue(prefs.map.isEmpty())
    }

    @Test
    fun the_record_prints_no_secret() {
        val text = record.toString()
        assertFalse(text.contains("token-0123456789"))
        assertFalse(text.contains("steer-secret"))
        assertNotNull(text)
    }

    /** Prefs whose commit fails as a full disk makes Android's fail: memory is changed, the disk is not. */
    private class FailingPrefs(private val inner: MemoryPrefs = MemoryPrefs()) : SharedPreferences by inner {
        override fun edit(): SharedPreferences.Editor {
            val real = inner.edit()
            return object : SharedPreferences.Editor by real {
                override fun commit(): Boolean {
                    real.apply()
                    return false
                }
            }
        }
    }

    /** As [FailingPrefs], once [failCommits] is set, with a hook that runs after memory changed and before the failure is reported. */
    private class AndroidFailingPrefs(private val inner: MemoryPrefs) : SharedPreferences by inner {
        @Volatile var failCommits = false
        var duringCommit: () -> Unit = {}

        override fun edit(): SharedPreferences.Editor {
            val real = inner.edit()
            return object : SharedPreferences.Editor by real {
                override fun commit(): Boolean {
                    real.apply()
                    if (!failCommits) return true
                    duringCommit()
                    duringCommit = {}
                    return false
                }
            }
        }
    }

    private fun assertNull(value: Any?, message: String) = org.junit.Assert.assertNull(message, value)

    private companion object {
        const val DAY = 24L * 60L * 60L * 1000L
    }
}
