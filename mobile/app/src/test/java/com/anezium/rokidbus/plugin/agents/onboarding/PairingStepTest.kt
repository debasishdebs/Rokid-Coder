package com.anezium.rokidbus.plugin.agents.onboarding

import android.app.Application
import android.content.Context
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.LinkKey
import com.anezium.rokidbus.plugin.agents.LinkTransport
import com.anezium.rokidbus.plugin.agents.PairingAttemptsModel
import com.anezium.rokidbus.plugin.agents.PairingRecord
import com.anezium.rokidbus.plugin.agents.SasPairing
import com.anezium.rokidbus.plugin.agents.SasResponder
import com.anezium.rokidbus.plugin.agents.SecureLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** FINISH_ON_COMPUTER / PAIRING and LAPTOP_DONE (§13.5, §2.6), over 6a's attempts and the secure-link state. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PairingStepTest {
    private val app: Application = RuntimeEnvironment.getApplication()
    private var now = 1_000_000L

    private inner class FakeDoor : PairingDoor {
        var held = setOf("desk", "dialled:old")
        var remainingMs = 0L
        var opens = 0
        var cancels = 0
        var listens = 0
        override fun baselineNow() = held
        override fun listen() {
            listens += 1
        }
        override fun open() {
            opens += 1
            remainingMs = 120_000L
        }
        override fun cancel() {
            cancels += 1
            remainingMs = 0L
        }
        override fun remainingMs() = remainingMs
    }

    private val door = FakeDoor()
    private val links = MutableStateFlow<Map<LinkKey, SecureLink>>(emptyMap())
    private var windowOpen = false
    private val attempts = PairingAttemptsModel(clock = { now }, window = { windowOpen.also { windowOpen = false } })

    @Before
    fun clean() {
        app.getSharedPreferences(OnboardingStore.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        PairReadyWindow.opener = null
        attempts.pairingScreenOpen = false
    }

    private fun TestScope.controller(store: OnboardingStore = OnboardingStore(app)) =
        PairingStepController(store, door, attempts, links, backgroundScope)

    // agentd's half of a SAS session, over the same formulas (see SasPairingTest).
    private val agentdFp = "AB:".repeat(31) + "AB"
    private val phoneFp = "CD:".repeat(31) + "CD"
    private val nc = ByteArray(32) { (it * 7).toByte() }
    private val attempt = "0123456789abcdef"

    private inner class Agentd(private val id: String = attempt) {
        val sent = mutableListOf<JSONObject>()
        val stored = mutableListOf<PairingRecord>()
        val responder = SasResponder(attempts, agentdFp, phoneFp, "Laptop", { sent += JSONObject(it) }, { stored += it; true }, {})
        fun frame(type: String, vararg fields: Pair<String, Any>) {
            val json = JSONObject().put("type", type).put("v", 2).put("attempt", id)
            fields.forEach { (key, value) -> json.put(key, value) }
            responder.receive(json.toString())
        }
        fun toCode(): String {
            windowOpen = door.remainingMs > 0
            frame("sas_commit", "c" to SasPairing.commit(nc, agentdFp, phoneFp))
            frame("sas_reveal", "nc" to SasPairing.hex(nc))
            val np = SasPairing.unhex(sent.first { it.getString("type") == "sas_nonce" }.getString("np"))!!
            return SasPairing.code(nc, np, agentdFp, phoneFp)
        }
    }

    private fun link(machineId: String, name: String, address: String = "192.168.1.20", id: Long = 1L) =
        LinkKey(LinkTransport.OUTBOUND, id) to SecureLink(machineId, name, address)

    @Test
    fun pairing_window_opens_on_pair_ready_or_button_not_earlier() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        step.onScreenStarted()
        assertEquals("entering never opens the window", 0, door.opens)
        assertEquals(1, door.listens)
        assertEquals(PairingPhase.READY, step.view.value.phase)
        assertTrue("registered through 6a's pairing-screen hook", attempts.pairingScreenOpen)

        // A pair-ready announcement, through the hook the link server calls.
        assertTrue(PairReadyWindow.opener!!.invoke())
        assertEquals(1, door.opens)
        assertEquals(PairingPhase.WINDOW_OPEN, step.view.value.phase)

        step.onScreenStopped()
        assertFalse(attempts.pairingScreenOpen)
        assertNull("no announcement opens a window while the screen is away", PairReadyWindow.opener)

        // The button, the other way in.
        door.cancel()
        step.tick()
        step.onScreenStarted()
        step.openWindow()
        assertEquals(2, door.opens)
    }

    @Test
    fun pairing_resumed_after_process_death_starts_at_finish_on_computer() = runTest(UnconfinedTestDispatcher()) {
        val first = OnboardingStore(app)
        first.complete(*OnboardingStore.STEPS.takeWhile { it != OnboardingStep.FINISH_ON_COMPUTER }.toTypedArray())
        val before = controller(first)
        before.enter()
        before.openWindow()
        assertTrue(OnboardingStore(app).isComplete(OnboardingStep.FINISH_ON_COMPUTER))

        // The process dies with the window open; a new one opens the screen again.
        val resumed = OnboardingStore(app)
        assertEquals(OnboardingStep.FINISH_ON_COMPUTER, resumed.resumeStep())
        val after = controller(resumed)
        after.enter()
        assertEquals("a window never survives the process", 0L, door.remainingMs)
        assertEquals(PairingPhase.READY, after.view.value.phase)
        assertEquals(OnboardingCopy.READY_TO_PAIR, OnboardingCopy.pairing(after.view.value).action)
    }

    @Test
    fun expired_window_shows_times_up_and_retries() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        step.openWindow()
        Agentd().apply { windowOpen = true; frame("sas_commit", "c" to SasPairing.commit(nc, agentdFp, phoneFp)) }
        door.remainingMs = 0L
        step.tick()
        assertEquals("an attempt in progress is not an expiry", PairingPhase.WINDOW_OPEN, step.view.value.phase)

        attempts.clear()
        step.tick()
        assertEquals(PairingPhase.EXPIRED, step.view.value.phase)
        assertEquals(OnboardingCopy.TIMES_UP, OnboardingCopy.pairing(step.view.value).action)
        assertFalse("a peer was seen: no fallback offered on its own", step.view.value.offerFallback)

        step.openWindow()
        assertEquals(PairingPhase.WINDOW_OPEN, step.view.value.phase)
        assertEquals(2, door.opens)
    }

    @Test
    fun pairing_check_offers_tailscale_and_qr_when_unreachable() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        step.openWindow()
        door.remainingMs = 0L
        step.tick()
        assertEquals(PairingPhase.EXPIRED, step.view.value.phase)
        assertTrue("no peer seen: the computer could not reach the phone", step.view.value.offerFallback)
        val copy = OnboardingCopy.pairing(step.view.value)
        assertTrue(copy.links.containsAll(listOf(OnboardingCopy.TAILSCALE_LINK, OnboardingCopy.SCAN_INSTEAD)))

        val other = controller()
        other.enter()
        other.awayFromHome()
        assertTrue(other.view.value.offerFallback)
        assertTrue(OnboardingCopy.pairing(other.view.value).links.contains(OnboardingCopy.SCAN_INSTEAD))
    }

    @Test
    fun sas_code_shown_and_confirm_required_before_done() = runTest(UnconfinedTestDispatcher()) {
        val store = OnboardingStore(app)
        val step = controller(store)
        step.enter()
        step.openWindow()
        val agentd = Agentd()
        val code = agentd.toCode()
        assertEquals(PairingPhase.SAS, step.view.value.phase)
        assertEquals("Does your computer show ${code.take(3)} ${code.drop(3)}?", OnboardingCopy.pairing(step.view.value).title)
        assertEquals(listOf("Codes match", "Codes don't match"), OnboardingCopy.SAS_ACTIONS)
        assertFalse("nothing confirms on its own", agentd.sent.any { it.getString("type") == "sas_confirm" })

        assertTrue(step.confirm(step.view.value.attempt, match = true))
        assertTrue(agentd.sent.any { it.getString("type") == "sas_confirm" && it.getBoolean("ok") })
        assertFalse(store.isComplete(OnboardingStep.LAPTOP_DONE))
    }

    @Test
    fun replaced_attempt_before_click_is_never_confirmed() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        step.openWindow()
        val first = Agentd()
        first.toCode()
        // What the screen drew, and what its buttons answer.
        val drawn = step.view.value.attempt!!
        assertEquals(PairingPhase.SAS, step.view.value.phase)

        // Attempt A ends and B takes its place before the screen redraws.
        first.responder.disconnected()
        step.openWindow()
        val second = Agentd(id = "fedcba9876543210")
        second.toCode()
        assertEquals(PairingPhase.SAS, step.view.value.phase)

        assertFalse("the tap answered A's code, not B's", step.confirm(drawn, match = true))
        assertFalse(step.confirm(drawn, match = false))
        assertFalse(second.sent.any { it.getString("type") == "sas_confirm" })
        assertFalse(step.confirm(null, match = true))

        // B's own drawing confirms B.
        assertTrue(step.confirm(step.view.value.attempt, match = true))
        assertTrue(second.sent.any { it.getString("type") == "sas_confirm" && it.getBoolean("ok") })
    }

    @Test
    fun sas_mismatch_pairs_nothing_and_offers_retry() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        step.openWindow()
        val agentd = Agentd()
        agentd.toCode()
        assertTrue(step.confirm(step.view.value.attempt, match = false))
        assertTrue(agentd.sent.any { it.getString("type") == "sas_confirm" && !it.getBoolean("ok") })
        assertEquals(PairingPhase.ABORTED, step.view.value.phase)
        val copy = OnboardingCopy.pairing(step.view.value)
        assertEquals("Nothing was paired — tap to try again", copy.action)
        assertTrue(copy.lines.any { "didn't match" in it })
        assertTrue(agentd.stored.isEmpty())

        step.openWindow()
        assertEquals(PairingPhase.WINDOW_OPEN, step.view.value.phase)
    }

    @Test
    fun laptop_done_advances_on_first_secure_link() = runTest(UnconfinedTestDispatcher()) {
        // The window path.
        val store = OnboardingStore(app)
        val step = controller(store)
        step.enter()
        step.openWindow()
        links.value = mapOf(link("desk", "Desk"), link("dialled:old", "Old", id = 2L))
        assertEquals("a computer from the baseline is not the answer", PairingPhase.WINDOW_OPEN, step.view.value.phase)
        // An insecure link never reaches the map: only a secure bind announces one.
        AgentsRuntime.clearSecureLinks()
        assertTrue(AgentsRuntime.activeSecureLinks.value.isEmpty())

        links.value = links.value + link("dialled:new", "Laptop", id = 3L)
        assertEquals(PairingPhase.PAIRED, step.view.value.phase)
        assertEquals("Paired with Laptop ✓", OnboardingCopy.pairing(step.view.value).title)
        assertTrue(store.isComplete(OnboardingStep.LAPTOP_DONE))
        assertTrue(store.isComplete(OnboardingStep.PAIRING))

        // A direct QR entry, with no window ever opened.
        app.getSharedPreferences(OnboardingStore.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        links.value = emptyMap()
        val opensBefore = door.opens
        val qr = controller(OnboardingStore(app))
        qr.enter()
        assertEquals(opensBefore, door.opens)
        links.value = mapOf(link("laptop-2", "Laptop 2", id = 4L))
        assertEquals(PairingPhase.PAIRED, qr.view.value.phase)
    }

    @Test
    fun laptop_done_survives_crash_between_pairing_and_step_record() = runTest(UnconfinedTestDispatcher()) {
        // pair_committed was sent, then the process died before any secure link.
        val firstRun = controller(OnboardingStore(app))
        firstRun.enter()
        firstRun.openWindow()
        door.held = door.held + "laptop" // the record is durable now
        val resumed = controller(OnboardingStore(app))
        resumed.enter()
        assertEquals("the baseline is the persisted one, not today's", setOf("desk", "dialled:old"), OnboardingStore(app).pairingBaseline())
        links.value = mapOf(link("dialled:laptop", "Laptop"))
        assertEquals(PairingPhase.PAIRED, resumed.view.value.phase)

        // The secure link came up, then the process died before the step was recorded.
        app.getSharedPreferences(OnboardingStore.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
        links.value = emptyMap()
        door.held = setOf("desk")
        controller(OnboardingStore(app)).enter()
        door.held = setOf("desk", "laptop")
        // ... the next process: the computer reconnects with its credentials.
        val again = controller(OnboardingStore(app))
        again.enter()
        links.value = mapOf(link("laptop", "Laptop", id = 9L))
        assertEquals(PairingPhase.PAIRED, again.view.value.phase)
        assertTrue(OnboardingStore(app).isComplete(OnboardingStep.LAPTOP_DONE))
    }

    @Test
    fun baseline_is_cleared_only_at_done() {
        val store = OnboardingStore(app)
        store.recordPairingBaseline(setOf("a"))
        assertEquals(setOf("a"), store.recordPairingBaseline(setOf("b")))
        store.finish()
        assertNull(OnboardingStore(app).pairingBaseline())
    }
}
