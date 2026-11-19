package com.anezium.rokidbus.plugin.agents

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.plugin.agents.service.CoderRuntime
import com.anezium.rokidbus.plugin.agents.service.FakeLinkCore
import com.anezium.rokidbus.plugin.agents.service.GlassesLinkHealer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.util.concurrent.TimeUnit
import com.anezium.rokidbus.phone.GlassesDeviceInfo
import com.anezium.rokidbus.shared.LinkStateBits
import com.anezium.rokidbus.shared.plugin.NexusInputEvent
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/** The Agents code on the glasses, through [com.anezium.rokidbus.phone.GlassesSurface] and nothing else. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class AgentsCoreTest {
    private val glasses = FakeGlassesSurface()
    private lateinit var core: AgentsCore

    @Before
    fun setUp() {
        // The service's healer, with the link up, so a tap reuses it and the speech starts as it always did.
        attachHealer()
        core = AgentsCore(glasses, RuntimeEnvironment.getApplication())
        core.start()
        idle()
    }

    @After
    fun tearDown() {
        CoderRuntime.attachHealer(null)
        healerScope.cancel()
        core.close()
        idle()
        AgentsRuntime.hudOpen = false
    }

    private fun idle() = ShadowLooper.idleMainLooper()

    private fun key(code: Int) = NexusInputEvent("agents", code, KeyEvent.ACTION_DOWN)

    private fun text(card: NexusCard): String =
        (listOfNotNull(card.title, card.subtitle, card.footer) + card.lines +
            card.richLines.orEmpty().flatMap { listOfNotNull(it.text, it.sub) }).joinToString("\n")

    private fun lastCard(): NexusCard = when (val call = glasses.calls.last {
        it is FakeGlassesSurface.Call.ShowCard || it is FakeGlassesSurface.Call.UpdateCard
    }) {
        is FakeGlassesSurface.Call.ShowCard -> call.card
        is FakeGlassesSurface.Call.UpdateCard -> call.card
        else -> error("not a card")
    }

    @Test
    fun start_attaches_to_the_surface_and_close_detaches() {
        assertEquals(1, glasses.attaches)
        assertSame(core, glasses.listener)
        assertNotNull(glasses.notices)
        assertSame(core, AgentsRuntime.alertGlasses)

        core.close()

        assertNull(glasses.listener)
        assertNull(glasses.notices)
        assertNull(AgentsRuntime.alertGlasses)
    }

    @Test
    fun an_open_shows_the_board_and_a_close_stops_drawing() {
        glasses.open()

        assertEquals(1, glasses.callsOf<FakeGlassesSurface.Call.ShowCard>().size)
        assertTrue(AgentsRuntime.hudOpen)

        glasses.close()
        glasses.calls.clear()
        core.brief("Computer linked", "its sessions appear here")

        assertFalse(AgentsRuntime.hudOpen)
        assertTrue(glasses.calls.none { it is FakeGlassesSurface.Call.ShowCard || it is FakeGlassesSurface.Call.UpdateCard })
    }

    @Test
    fun back_on_the_board_hides_the_surface() {
        glasses.open()
        glasses.calls.clear()

        glasses.listener!!.onInput(key(KeyEvent.KEYCODE_BACK))

        assertEquals(listOf(FakeGlassesSurface.Call.Hide), glasses.calls)
    }

    @Test
    fun a_band_tap_while_closed_adopts_the_hud() {
        core.brief("Computer linked", "its sessions appear here")
        glasses.calls.clear()

        glasses.notices!!.onInput(key(KeyEvent.KEYCODE_ENTER))

        // A show while closed is the adoption: the hub answers it with an open.
        assertEquals(1, glasses.callsOf<FakeGlassesSurface.Call.ShowCard>().size)
        glasses.open("adopted")
        assertEquals(2, glasses.callsOf<FakeGlassesSurface.Call.ShowCard>().size)
    }

    @Test
    fun an_alert_band_goes_through_the_surface_notice() {
        val notice = NexusNotice(title = "Claude needs approval", body = "Bash")

        assertTrue(core.showBand(notice))
        assertTrue(core.updateBand(NexusNoticeUpdate(title = "Claude needs approval", body = "Edit")))
        core.hideBand()

        assertEquals(
            listOf(
                FakeGlassesSurface.Call.ShowNotice(notice),
                FakeGlassesSurface.Call.UpdateNotice(NexusNoticeUpdate(title = "Claude needs approval", body = "Edit")),
                FakeGlassesSurface.Call.HideNotice,
            ),
            glasses.calls,
        )
    }

    @Test
    fun no_band_is_raised_where_the_glasses_have_no_notice_surface() {
        glasses.state = glasses.state.copy(noticeSupported = false)

        assertFalse(core.showBand(NexusNotice(title = "Claude needs approval")))
        core.brief("Computer linked", "its sessions appear here")

        assertTrue(glasses.calls.isEmpty())
    }

    @Test
    fun a_spoken_cue_speaks_on_the_glasses_with_a_fresh_utterance_each_time() {
        glasses.listener!!.onStateChanged(glasses.state.copy(linkState = LinkStateBits.GLASSES_WORN))
        glasses.listener!!.onDeviceInfo(GlassesDeviceInfo("Rokid", 80, 7, 5, "1.0", false, "on"))

        core.playSound(AlertSound.Speak("Claude is done"))
        core.playSound(AlertSound.Speak("Claude is done"))

        val spoken = glasses.callsOf<FakeGlassesSurface.Call.Speak>()
        assertEquals(listOf("Claude is done", "Claude is done"), spoken.map { it.text })
        assertNotEquals(spoken[0].utteranceId, spoken[1].utteranceId)
    }

    @Test
    fun muted_glasses_hear_no_cue() {
        glasses.listener!!.onDeviceInfo(GlassesDeviceInfo("Rokid", 80, 0, 5, "1.0", false, "on"))

        core.playSound(AlertSound.Speak("Claude is done"))

        assertTrue(glasses.callsOf<FakeGlassesSurface.Call.Speak>().isEmpty())
    }

    @Test
    fun voice_runs_on_the_glasses_speech_and_stops_through_its_handle() {
        glasses.open()

        core.startVoice(VoiceTarget.Approval("a1"))
        val run = glasses.speech.single()
        assertEquals(FakeGlassesSurface.Call.StartSpeech("auto"), glasses.calls.last { it is FakeGlassesSurface.Call.StartSpeech })
        run.listener.onStarted(true)
        core.invalidate("a1")

        assertEquals(1, run.stops)
    }

    // ------------------------------------------------------- every voice tap makes sure of the glasses link first

    private val bonded = LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED
    private val linkCore = FakeLinkCore().apply { state = bonded or LinkStateBits.CXR_CONTROL_UP }
    private val healerScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var monitoring = true

    /** The service's healer on [linkCore], which starts with the link up: a tap then reuses it. */
    private fun attachHealer(): GlassesLinkHealer =
        GlassesLinkHealer(healerScope, linkCore, enabled = { monitoring }).also(CoderRuntime::attachHealer)

    private fun linkDown() {
        linkCore.state = bonded
    }

    private fun linkUp(healer: GlassesLinkHealer) {
        linkCore.state = bonded or LinkStateBits.CXR_CONTROL_UP
        healer.onLinkState(linkCore.state)
        idle()
    }

    @Test
    fun a_tap_with_the_link_up_reuses_it_and_binds_nothing() {
        glasses.open()

        core.startVoice(VoiceTarget.Approval("a1"))

        assertEquals("the speech started at once", 1, glasses.speech.size)
        assertEquals(0, linkCore.binds)
        assertEquals(0, linkCore.reconnects)
    }

    @Test
    fun a_tap_with_the_link_down_binds_once_and_listens_only_when_it_is_up() {
        glasses.open()
        linkDown()
        val healer = attachHealer()

        core.startVoice(VoiceTarget.Approval("a1"))
        idle()

        assertEquals(1, linkCore.binds)
        assertEquals("nothing listens before the link is there", 0, glasses.speech.size)
        assertFalse(text(lastCard()).contains(VoiceCapture.LINK_LOST))

        linkUp(healer)

        assertEquals(1, glasses.speech.size)
        assertEquals(1, linkCore.binds)
    }

    @Test
    fun a_tap_over_a_session_hi_rokid_closed_takes_the_link_back_and_the_closure_clears() {
        glasses.open()
        linkDown()
        linkCore.closedByServer = true
        val healer = attachHealer()

        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertEquals(1, linkCore.binds)
        assertFalse(linkCore.closedByServer)
        assertEquals("the background reconnect was never used", 0, linkCore.reconnects)

        linkUp(healer)
        assertEquals(1, glasses.speech.size)
    }

    @Test
    fun a_link_that_does_not_come_up_says_so_specifically_and_each_tap_tries_again() {
        glasses.open()
        linkDown()
        attachHealer()

        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        ShadowLooper.idleMainLooper(GlassesLinkHealer.ENSURE_WAIT_MS + 500, TimeUnit.MILLISECONDS)

        assertEquals(0, glasses.speech.size)
        assertTrue(text(lastCard()).contains(VoiceCapture.NOT_REACHED))
        assertFalse(text(lastCard()).contains(VoiceCapture.LINK_LOST))

        // Hi Rokid closes it again; "Speak again" is another tap, and another bind: no sticky refusal.
        linkCore.closedByServer = true
        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertEquals(2, linkCore.binds)
    }

    @Test
    fun two_quick_taps_make_one_bind_and_one_listening_session() {
        glasses.open()
        linkDown()
        val healer = attachHealer()

        core.startVoice(VoiceTarget.Approval("a1"))
        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertEquals("one bind, not two", 1, linkCore.binds)

        linkUp(healer)
        assertEquals("only the second tap's card listens", 1, glasses.speech.size)
    }

    @Test
    fun a_missing_token_monitoring_off_or_no_service_each_say_something_of_their_own() {
        glasses.open()
        linkDown()
        attachHealer()
        linkCore.ensureResult = com.anezium.rokidbus.phone.CxrEnsureResult.NO_TOKEN
        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertTrue(text(lastCard()).contains(VoiceCapture.GLASSES_NOT_SET_UP))

        monitoring = false
        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertTrue(text(lastCard()).contains(VoiceCapture.MONITORING_OFF))

        CoderRuntime.attachHealer(null)
        core.startVoice(VoiceTarget.Approval("a1"))
        idle()
        assertTrue(text(lastCard()).contains(VoiceCapture.NOT_REACHED))
        assertEquals("none of them started listening", 0, glasses.speech.size)
    }

    @Test
    fun a_denial_after_the_link_was_made_sure_of_is_shown_not_retried() {
        glasses.open()
        core.startVoice(VoiceTarget.Approval("a1"))

        glasses.speech.single().listener.onStopped(NexusSpeechStopReason.DENIED_NO_LINK, null)
        idle()
        ShadowLooper.idleMainLooper(10, TimeUnit.SECONDS)

        assertTrue(text(lastCard()).contains(VoiceCapture.LINK_LOST))
        assertEquals(1, glasses.speech.size)
        assertEquals(0, linkCore.binds)
    }

    @Test
    fun other_denials_are_shown_as_they_are() {
        glasses.open()
        core.startVoice(VoiceTarget.Approval("a1"))

        glasses.speech.single().listener.onStopped(NexusSpeechStopReason.DENIED_BUSY, null)
        idle()

        assertEquals(0, linkCore.binds)
        assertTrue(text(lastCard()).contains(VoiceCapture.MIC_BUSY))
    }

    @Test
    fun a_refused_speech_start_is_drawn_as_the_mic_being_busy() {
        glasses.open()
        glasses.speechResult = NexusSdkResult.CAPABILITY_NOT_AVAILABLE

        core.startVoice(VoiceTarget.Approval("a1"))

        assertTrue(text(lastCard()).contains(VoiceCapture.MIC_BUSY))
    }
}
