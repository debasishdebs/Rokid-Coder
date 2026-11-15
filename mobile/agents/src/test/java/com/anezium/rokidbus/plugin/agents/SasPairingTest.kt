package com.anezium.rokidbus.plugin.agents

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The phone's half of SAS pairing (R1′, Plan 6a T6): the code, the responder's state machine, the
 * credential handover's commit, and [PairingAttemptsModel], the API the phone UI and the glasses
 * card confirm through. agentd's half is played here by a script over the same formulas, which
 * `contracts/sas-vectors.json` pins for both languages.
 */
class SasPairingTest {
    private val vectors = JSONObject(File("../../contracts/sas-vectors.json").readText())
    private val agentdFp = "AB:".repeat(31) + "AB"
    private val phoneFp = "CD:".repeat(31) + "CD"
    private val attempt = "0123456789abcdef"
    private val nc = ByteArray(32) { (it * 7).toByte() }

    private inner class Session(
        val attempts: PairingAttemptsModel = PairingAttemptsModel(clock = { now }),
        storage: ((PairingRecord) -> Boolean)? = null,
    ) {
        val sent = mutableListOf<JSONObject>()
        var closed = false
        val stored = mutableListOf<PairingRecord>()
        val responder = SasResponder(
            attempts = attempts,
            agentdFp = agentdFp,
            phoneFp = phoneFp,
            peerName = "Desk",
            send = { line -> sent += JSONObject(line) },
            store = { record -> storage?.invoke(record) ?: run { stored += record; true } },
            close = { closed = true },
        )

        fun frame(type: String, vararg fields: Pair<String, Any>) {
            val json = JSONObject().put("type", type).put("v", 2).put("attempt", attempt)
            fields.forEach { (key, value) -> json.put(key, value) }
            responder.receive(json.toString())
        }

        fun commit() = frame("sas_commit", "c" to SasPairing.commit(nc, agentdFp, phoneFp))
        fun reveal(value: ByteArray = nc) = frame("sas_reveal", "nc" to SasPairing.hex(value))
        fun nonce(): ByteArray = SasPairing.unhex(sent.first { it.getString("type") == "sas_nonce" }.getString("np"))!!

        /** Commit, nonce, reveal: both sides now hold the code. */
        fun toCode(): String {
            commit()
            reveal()
            return SasPairing.code(nc, nonce(), agentdFp, phoneFp)
        }

        fun credentials() = frame(
            "pair_credentials",
            "token" to "token-0123456789",
            "steer" to "steer-secret-0123456789abcdefghijk",
            "machineId" to "pc-1",
            "machineName" to "Desk",
            "wsHost" to "10.0.0.2",
            "wsPort" to 8792,
        )

        fun types() = sent.map { it.getString("type") }
    }

    private var now = 1_000_000L

    @Test
    fun sas_vectors_match_on_node_and_kotlin() {
        val sas = vectors.getJSONArray("sas")
        for (index in 0 until sas.length()) {
            val v = sas.getJSONObject(index)
            val nc = SasPairing.unhex(v.getString("nc"))!!
            val np = SasPairing.unhex(v.getString("np"))!!
            assertEquals(v.getString("commit"), SasPairing.commit(nc, v.getString("agentdFp"), v.getString("phoneFp")))
            assertEquals(v.getString("code"), SasPairing.code(nc, np, v.getString("agentdFp"), v.getString("phoneFp")))
        }
        val proofs = vectors.getJSONArray("proofs")
        for (index in 0 until proofs.length()) {
            val v = proofs.getJSONObject(index)
            assertEquals(
                v.getString("proof"),
                SasPairing.proof(v.getString("steer"), v.getString("attempt"), v.getString("agentdFp"), v.getString("phoneFp")),
            )
        }
    }

    @Test
    fun the_nonce_goes_out_only_after_the_commitment_and_both_sides_show_one_code() {
        val session = Session()
        assertTrue(session.sent.isEmpty())
        val code = session.toCode()
        assertEquals(listOf("sas_nonce"), session.types())
        val view = session.attempts.state.value!!
        assertEquals(AttemptState.AWAITING_CONFIRM, view.state)
        assertEquals(code, view.code)
        assertEquals(attempt, view.attempt)
        assertEquals("Desk", view.peerName)
    }

    @Test
    fun reveal_not_matching_commit_aborts() {
        val session = Session()
        session.commit()
        session.reveal(ByteArray(32) { 9 })
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
        assertNull(session.attempts.state.value?.code)
        assertEquals("bad_reveal", session.sent.last().getString("reason"))
        assertTrue(session.closed)
    }

    @Test
    fun out_of_order_frame_aborts() {
        val session = Session()
        session.reveal()
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
        assertTrue(session.closed)
        // A hello in the middle of a session is just as out of order.
        val other = Session()
        other.commit()
        other.responder.receive("""{"type":"hello","v":1,"machineId":"pc","token":"t"}""")
        assertEquals(AttemptState.ABORTED, other.attempts.state.value?.state)
    }

    @Test
    fun second_commit_in_window_aborts() {
        val session = Session()
        session.commit()
        session.commit()
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
        assertEquals("second_commit", session.sent.last().getString("reason"))
    }

    @Test
    fun second_peer_aborts_both() {
        val attempts = PairingAttemptsModel(clock = { now })
        val first = Session(attempts)
        first.toCode()
        val second = Session(attempts)
        second.commit()
        assertTrue(first.closed)
        assertTrue(second.closed)
        assertEquals(AttemptState.ABORTED, attempts.state.value?.state)
        assertEquals("second_peer", second.sent.last().getString("reason"))
    }

    @Test
    fun stale_attempt_ids_are_ignored() {
        val session = Session()
        session.toCode()
        session.responder.receive("""{"type":"sas_confirm","v":2,"attempt":"ffffffffffffffff","ok":false}""")
        assertEquals(AttemptState.AWAITING_CONFIRM, session.attempts.state.value?.state)
    }

    @Test
    fun phone_confirm_requires_on_device_input_not_a_frame() {
        val session = Session()
        session.toCode()
        // agentd's confirmation arrives: the phone does not confirm for its human.
        session.frame("sas_confirm", "ok" to true)
        assertEquals(AttemptState.AWAITING_CONFIRM, session.attempts.state.value?.state)
        assertFalse(session.types().contains("sas_confirm"))
        session.attempts.confirm(attempt, true)
        assertEquals("sas_confirm", session.sent.last().getString("type"))
        assertTrue(session.sent.last().getBoolean("ok"))
        assertEquals(AttemptState.PINNED, session.attempts.state.value?.state)
    }

    @Test
    fun no_pin_or_steering_before_both_confirm() {
        val session = Session()
        session.toCode()
        session.attempts.confirm(attempt, true)
        // Only the phone confirmed: credentials now would be out of order, and are never stored.
        session.credentials()
        assertTrue(session.stored.isEmpty())
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
    }

    @Test
    fun credentials_sent_only_after_both_confirm_and_agentd_durable_only_after_pair_committed() {
        val session = Session()
        session.toCode()
        session.frame("sas_confirm", "ok" to true)
        session.attempts.confirm(attempt, true)
        session.credentials()
        val record = session.stored.single()
        assertEquals("pc-1", record.machineId)
        assertEquals(agentdFp, record.agentdFp)
        assertEquals(attempt, record.attempt)
        assertEquals(8792, record.wsPort)
        assertEquals(JSONObject().put("type", "pair_committed").put("v", 2).put("attempt", attempt).toString(), session.sent.last().toString())
        assertTrue(session.closed)
    }

    @Test
    fun duplicate_credentials_frame_is_idempotent() {
        val session = Session()
        session.toCode()
        session.frame("sas_confirm", "ok" to true)
        session.attempts.confirm(attempt, true)
        session.credentials()
        session.credentials()
        assertEquals(2, session.types().count { it == "pair_committed" })
        assertEquals(1, session.stored.distinct().size)
        assertEquals(AttemptState.PINNED, session.attempts.state.value?.state)
    }

    @Test
    fun phone_storage_failure_aborts_and_agentd_drops_provisional() {
        val session = Session(storage = { false })
        session.toCode()
        session.frame("sas_confirm", "ok" to true)
        session.attempts.confirm(attempt, true)
        session.credentials()
        val abort = session.sent.last()
        assertEquals("pair_abort", abort.getString("type"))
        assertEquals("storage", abort.getString("reason"))
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
    }

    @Test
    fun phone_crash_before_persist_leaves_no_trust_anywhere() {
        val session = Session()
        session.toCode()
        session.frame("sas_confirm", "ok" to true)
        session.attempts.confirm(attempt, true)
        // The link drops before pair_credentials: nothing is stored, nothing was committed.
        session.responder.disconnected()
        assertTrue(session.stored.isEmpty())
        assertFalse(session.types().contains("pair_committed"))
    }

    @Test
    fun mismatch_discards_both_pins_and_closes_window() {
        val session = Session()
        session.toCode()
        session.attempts.confirm(attempt, false)
        assertEquals(false, session.sent.last().getBoolean("ok"))
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
        assertTrue(session.closed)
        session.credentials()
        assertTrue(session.stored.isEmpty())
    }

    @Test
    fun disconnect_mid_attempt_aborts_and_discards() {
        val session = Session()
        session.toCode()
        session.responder.disconnected()
        assertEquals(AttemptState.ABORTED, session.attempts.state.value?.state)
        assertTrue(session.stored.isEmpty())
    }

    @Test
    fun stale_confirm_from_aborted_attempt_rejected() {
        val attempts = PairingAttemptsModel(clock = { now })
        val first = Session(attempts)
        first.toCode()
        first.responder.disconnected()
        val second = Session(attempts)
        second.toCode()
        val sentBefore = second.sent.size
        attempts.confirm("ffffffffffffffff", true)
        assertEquals(sentBefore, second.sent.size)
        assertEquals(AttemptState.AWAITING_CONFIRM, attempts.state.value?.state)
    }

    @Test
    fun nonces_and_credentials_never_logged() {
        val session = Session()
        val code = session.toCode()
        session.frame("sas_confirm", "ok" to true)
        session.attempts.confirm(attempt, true)
        session.credentials()
        // Nothing here logs; what could reach a log by accident is how these objects print.
        val printed = listOf(session.stored.single().toString(), session.attempts.state.value.toString(), session.responder.toString())
        for (text in printed) {
            for (secret in listOf("token-0123456789", "steer-secret-0123456789abcdefghijk", code, SasPairing.hex(nc), agentdFp)) {
                assertFalse("printed: $text", text.contains(secret))
            }
        }
    }

    @Test
    fun pair_ready_one_shot_and_ignored_outside_pairing_screens() {
        val attempts = PairingAttemptsModel(clock = { now })
        val ready = PairReady.parse(
            """{"nexus":"agentd-pair-ready","v":1,"machineName":"Desk","host":"10.0.0.2","wsPort":8792,"attempt":"$attempt"}""",
        )
        assertNotNull(ready)
        assertEquals("10.0.0.2", ready!!.host)
        assertFalse("no pairing screen open", attempts.acceptPairReady(ready))
        attempts.pairingScreenOpen = true
        assertTrue(attempts.acceptPairReady(ready))
        assertFalse("once per attempt", attempts.acceptPairReady(ready))
        val next = ready.copy(attempt = "fedcba9876543210")
        assertFalse("at most one window per 30 s", attempts.acceptPairReady(next))
        now += 30_000
        assertTrue(attempts.acceptPairReady(next))
        assertNull(PairReady.parse("""{"nexus":"agentd","v":1}"""))
    }

    @Test
    fun glasses_card_confirm_reaches_attempt() {
        val attempts = PairingAttemptsModel(clock = { now })
        val session = Session(attempts)
        val code = session.toCode()
        val card = GlassesPairingCard(
            pairing = GuidedPairing(clock = { now }),
            clock = { now },
            host = object : GlassesPairingCard.Host {
                override fun snapshot() = PairingSnapshot(emptySet(), emptySet(), needed = true)
                override fun armWindow() = Unit
                override fun cancelWindow() = Unit
                override fun openCard() = Unit
                override fun closeCard() = Unit
                override fun onScreen() = true
                override fun render() = Unit
                override fun brief(title: String, body: String) = Unit
            },
            attempts = attempts,
        )
        card.start()
        assertTrue(card.card().title.contains(code.take(3)))
        assertTrue(card.confirm())
        assertEquals("sas_confirm", session.sent.last().getString("type"))
        assertTrue(session.sent.last().getBoolean("ok"))
    }
}
