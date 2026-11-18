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

    // ------------------------------------------------------- a voice start denied for want of the glasses link

    private val linkCore = FakeLinkCore().apply { state = LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED }
    private val healerScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private fun attachHealer(): GlassesLinkHealer =
        GlassesLinkHealer(healerScope, linkCore, settleMs = 2_000).also(CoderRuntime::attachHealer)

    private fun denyNoLink(run: FakeGlassesSurface.Handle) =
        run.listener.onStopped(NexusSpeechStopReason.DENIED_NO_LINK, null)

    @Test
    fun a_voice_start_denied_for_no_link_reconnects_and_runs_again_when_the_link_comes_up() {
        glasses.open()
        val healer = attachHealer()
        core.startVoice(VoiceTarget.Approval("a1"))

        denyNoLink(glasses.speech.single())
        idle()

        assertEquals("one reconnect, at once", 1, linkCore.reconnects)
        assertEquals("the denial is not shown while the link is coming back", 1, glasses.speech.size)
        assertFalse(text(lastCard()).contains(VoiceCapture.LINK_LOST))

        linkCore.state = linkCore.state or LinkStateBits.CXR_CONTROL_UP
        healer.onLinkState(linkCore.state)
        idle()

        assertEquals("the start ran once more", 2, glasses.speech.size)
        glasses.speech.last().listener.onStarted(true)
        assertTrue(text(lastCard()).isNotBlank())
        assertFalse(text(lastCard()).contains(VoiceCapture.LINK_LOST))
        CoderRuntime.attachHealer(null)
    }

    @Test
    fun a_link_that_stays_down_shows_the_loss_after_the_wait() {
        glasses.open()
        attachHealer()
        core.startVoice(VoiceTarget.Approval("a1"))

        denyNoLink(glasses.speech.single())
        idle()
        ShadowLooper.idleMainLooper(2_500, TimeUnit.MILLISECONDS)

        assertEquals(1, glasses.speech.size)
        assertTrue(text(lastCard()).contains(VoiceCapture.LINK_LOST))
        CoderRuntime.attachHealer(null)
    }

    @Test
    fun the_retry_is_one_only_and_a_second_denial_is_shown() {
        glasses.open()
        val healer = attachHealer()
        core.startVoice(VoiceTarget.Approval("a1"))
        denyNoLink(glasses.speech.single())
        linkCore.state = linkCore.state or LinkStateBits.CXR_CONTROL_UP
        healer.onLinkState(linkCore.state)
        idle()
        assertEquals(2, glasses.speech.size)

        denyNoLink(glasses.speech.last())
        idle()
        ShadowLooper.idleMainLooper(5, TimeUnit.SECONDS)

        assertEquals("no second retry", 2, glasses.speech.size)
        assertEquals(1, linkCore.reconnects)
        assertTrue(text(lastCard()).contains(VoiceCapture.LINK_LOST))
        CoderRuntime.attachHealer(null)
    }

    @Test
    fun with_no_service_to_reconnect_the_denial_is_shown_at_once() {
        glasses.open()
        CoderRuntime.attachHealer(null)
        core.startVoice(VoiceTarget.Approval("a1"))

        denyNoLink(glasses.speech.single())
        idle()

        assertTrue(text(lastCard()).contains(VoiceCapture.LINK_LOST))
    }

    @Test
    fun other_denials_are_not_retried() {
        glasses.open()
        attachHealer()
        core.startVoice(VoiceTarget.Approval("a1"))

        glasses.speech.single().listener.onStopped(NexusSpeechStopReason.DENIED_BUSY, null)
        idle()

        assertEquals(0, linkCore.reconnects)
        assertTrue(text(lastCard()).contains(VoiceCapture.MIC_BUSY))
        CoderRuntime.attachHealer(null)
    }

    @Test
    fun a_refused_speech_start_is_drawn_as_the_mic_being_busy() {
        glasses.open()
        glasses.speechResult = NexusSdkResult.CAPABILITY_NOT_AVAILABLE

        core.startVoice(VoiceTarget.Approval("a1"))

        assertTrue(text(lastCard()).contains(VoiceCapture.MIC_BUSY))
    }
}
