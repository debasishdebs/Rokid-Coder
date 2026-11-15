@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.view.KeyEvent
import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeAction
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusReader
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.phone.speech.SttError
import com.anezium.rokidbus.phone.speech.SttErrorKind
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.EditableSurfaceContract
import com.anezium.rokidbus.shared.EditableSurfaceField
import com.anezium.rokidbus.shared.LinkStateBits
import com.example.cxrglobal.GlassInfo
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * glasses_surface_contract_tests: one test per GlassesSurface inventory row (adr-cores.md §1),
 * against a real HubCore with FakeCxrTransport and the Agents InProcessApp. Each checks the wire
 * frame recorded or injected, the callback, that it ran on main, and the row's ordering rule.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class GlassesSurfaceContractTest {
    private val harness = HubCoreHarness().startLinked()
    private val core get() = harness.core
    private val cxr get() = harness.cxr
    private val surface: GlassesSurface get() = core.surface()
    private val listener = RecordingSurfaceListener()
    private val notices = RecordingNotices()

    private fun attach() {
        surface.attach(listener, notices)
        harness.settle()
    }

    private fun attachOpen() {
        attach()
        harness.launcherOpen()
        harness.await("open") { "open:open" in listener.events }
    }

    private fun card(title: String = "Board") = NexusCard(title = title, lines = listOf("line"))

    private fun lastFrame(path: String): BusEnvelope {
        harness.await(path) { cxr.framesOn(path).isNotEmpty() }
        return cxr.framesOn(path).last()
    }

    /** The glasses' reply about the band last shown, carrying its interaction identity. */
    private fun noticeReply(path: String, extra: JSONObject.() -> Unit = {}): BusEnvelope {
        val shown = lastFrame(BusPaths.NOTICE_SHOW).payload
        return BusEnvelope(
            path = path,
            payload = JSONObject()
                .put("noticeId", shown.getString("surfaceId"))
                .put("noticeInstanceId", shown.getString("noticeInstanceId"))
                .put("noticeQuestionId", shown.getString("noticeQuestionId"))
                .apply(extra),
        )
    }

    private fun acceptedSpeech(speech: RecordingSpeech): SpeechHandle {
        val handle = surface.startSpeech(null, speech)
        assertEquals(NexusSdkResult.SENT, handle.result)
        harness.await("speech accepted") { speech.events.any { it.startsWith("started:") } }
        return handle
    }

    // ---- 1.1 Lifecycle, link and device ----

    @Test
    fun L1_launcher_open_reaches_the_listener_once_with_its_type() {
        attachOpen()
        harness.settle()
        assertEquals(1, listener.count("open:open"))
        assertEquals(SurfaceState.Lifecycle.OPEN, surface.state.lifecycle)
        assertTrue(listener.offMain.isEmpty())
    }

    @Test
    fun L2_background_close_reports_onBackground_after_releasing_speech_and_tts() {
        attachOpen()
        val policy = HubCore::class.java.getDeclaredField("foregroundPolicy")
            .apply { isAccessible = true }.get(core) as HubForegroundPolicy
        policy.onSelfHid("agents", detach = true, hasActiveAudioLease = true)
        harness.await("background") { "background" in listener.events }
        assertEquals(SurfaceState.Lifecycle.BACKGROUND, surface.state.lifecycle)
        assertTrue(listener.offMain.isEmpty())
    }

    @Test
    fun L3_close_ends_speech_and_utterances_before_onClose() {
        attachOpen()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        val tts = RecordingTts()
        assertEquals(NexusSdkResult.SENT, surface.speak("hello", "u1", tts))
        harness.await("spoken") { harness.tts.spoken.isNotEmpty() }
        assertEquals(NexusSdkResult.SENT, surface.hide())
        harness.await("close") { "close" in listener.events }
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
        assertTrue(tts.events.any { it.startsWith("done:u1:") })
        assertEquals(1, listener.count("close"))
        assertEquals(SurfaceState.Lifecycle.CLOSED, surface.state.lifecycle)
    }

    @Test
    fun L4_link_changes_reach_onStateChanged_with_the_worn_bit() {
        attach()
        assertFalse(surface.state.glassesWorn)
        cxr.linkCallback!!.onGlassWearingStatus(true)
        harness.await("worn") { listener.states.lastOrNull()?.glassesWorn == true }
        assertTrue(surface.state.glassesWorn)
        assertTrue(surface.state.linkState and LinkStateBits.CXR_CONTROL_UP != 0)
        assertTrue(surface.state.noticeSupported)
        assertTrue(listener.offMain.isEmpty())
    }

    @Test
    fun L5_show_while_closed_adopts_the_idle_hud_and_update_is_refused() {
        attach()
        assertEquals(NexusSdkResult.SENT, surface.updateCard(card()))
        harness.await("busy") { "rejected:SURFACE_BUSY" in listener.events }
        assertTrue(cxr.framesOn(BusPaths.SURFACE_UPDATE).isEmpty())
        assertEquals(NexusSdkResult.SENT, surface.showCard(card()))
        harness.await("adopted") { "open:adopted" in listener.events }
        lastFrame(BusPaths.SURFACE_SHOW)
        assertEquals(SurfaceState.Lifecycle.OPEN, surface.state.lifecycle)
    }

    @Test
    fun L6_hide_ends_the_session_once_and_is_idempotent_while_closed() {
        attachOpen()
        surface.showCard(card())
        assertEquals(NexusSdkResult.SENT, surface.hide())
        harness.await("close") { "close" in listener.events }
        assertEquals("agents:agents", lastFrame(BusPaths.SURFACE_HIDE).payload.optString("surfaceId"))
        assertEquals(NexusSdkResult.SENT, surface.hide())
        harness.settle()
        assertEquals(1, listener.count("close"))
    }

    @Test
    fun L7_device_info_arrives_without_the_serial_number() {
        attach()
        cxr.deviceInfo(
            GlassInfo(
                deviceName = "Glasses",
                batteryLevel = 80,
                sound = 6,
                brightness = -1,
                systemVersion = "1.2",
                isCharging = true,
                sn = "SERIAL-123",
                wearingStatus = "worn",
            ),
        )
        harness.await("device info") { listener.devices.isNotEmpty() }
        assertEquals(
            GlassesDeviceInfo("Glasses", 80, 6, null, "1.2", true, "worn"),
            listener.devices.single(),
        )
        assertEquals(listener.devices.single(), surface.deviceInfo)
        assertFalse(listener.devices.single().toString().contains("SERIAL"))
    }

    @Test
    fun L8_attach_delivers_state_and_detach_stops_every_callback() {
        attach()
        assertEquals("state", listener.events.first())
        surface.detach()
        harness.launcherOpen()
        harness.settle()
        assertFalse(listener.events.any { it.startsWith("open:") })
        assertEquals(NexusSdkResult.NOT_REGISTERED, surface.showCard(card()))
        assertEquals(SurfaceState.Lifecycle.CLOSED, surface.state.lifecycle)
    }

    // ---- 1.2 Cards, readers and card input ----

    @Test
    fun C1_showCard_sends_the_owned_surface() {
        attachOpen()
        assertEquals(NexusSdkResult.SENT, surface.showCard(card("Board")))
        val frame = lastFrame(BusPaths.SURFACE_SHOW).payload
        assertEquals("agents:agents", frame.optString("surfaceId"))
        assertEquals("agents", frame.optString("ownerPluginId"))
        assertEquals("Board", frame.optString("title"))
    }

    @Test
    fun C2_updateCard_supersedes_the_card_in_order() {
        attachOpen()
        surface.showCard(card("one"))
        surface.updateCard(card("two"))
        harness.await("update") { cxr.framesOn(BusPaths.SURFACE_UPDATE).isNotEmpty() }
        val paths = cxr.frames.map { it.path }.filter { it == BusPaths.SURFACE_SHOW || it == BusPaths.SURFACE_UPDATE }
        assertEquals(listOf(BusPaths.SURFACE_SHOW, BusPaths.SURFACE_UPDATE), paths)
        assertEquals("two", lastFrame(BusPaths.SURFACE_UPDATE).payload.optString("title"))
    }

    @Test
    fun C3_showReader_sends_its_segments() {
        attachOpen()
        assertEquals(NexusSdkResult.SENT, surface.showReader(NexusReader(title = "Doc", segments = listOf(NexusReaderSegment(NexusReaderSegmentKind.PROSE, "a"), NexusReaderSegment(NexusReaderSegmentKind.PROSE, "b")))))
        val frame = lastFrame(BusPaths.SURFACE_SHOW).payload
        assertEquals("reader", frame.optString("kind"))
    }

    @Test
    fun C4_updateReader_goes_out_as_an_update() {
        attachOpen()
        surface.showReader(NexusReader(title = "Doc", segments = listOf(NexusReaderSegment(NexusReaderSegmentKind.PROSE, "a"))))
        assertEquals(NexusSdkResult.SENT, surface.updateReader(NexusReader(title = "Doc", segments = listOf(NexusReaderSegment(NexusReaderSegmentKind.PROSE, "a"), NexusReaderSegment(NexusReaderSegmentKind.PROSE, "b")))))
        assertEquals("reader", lastFrame(BusPaths.SURFACE_UPDATE).payload.optString("kind"))
    }

    @Test
    fun C5_a_rejected_surface_call_is_reported_once() {
        attach()
        surface.updateCard(card())
        harness.await("rejected") { listener.events.any { it.startsWith("rejected:") } }
        harness.settle()
        assertEquals(1, listener.count("rejected:SURFACE_BUSY"))
    }

    @Test
    fun C6_card_input_reaches_onInput_only_while_open() {
        attachOpen()
        surface.showCard(card())
        cxr.inject(surfaceInput(KeyEvent.KEYCODE_DPAD_CENTER))
        harness.await("input") { listener.inputs.isNotEmpty() }
        assertEquals(KeyEvent.KEYCODE_DPAD_CENTER, listener.inputs.single().keyCode)
        surface.hide()
        harness.await("close") { "close" in listener.events }
        cxr.inject(surfaceInput(KeyEvent.KEYCODE_DPAD_CENTER))
        harness.settle()
        assertEquals(1, listener.inputs.size)
    }

    private fun surfaceInput(keyCode: Int) = BusEnvelope(
        path = BusPaths.SURFACE_INPUT,
        payload = JSONObject()
            .put("surfaceId", "agents:agents")
            .put("ownerPluginId", "agents")
            .put("localSurfaceId", "agents")
            .put("keyCode", keyCode)
            .put("action", KeyEvent.ACTION_DOWN),
    )

    @Test
    fun C7_editable_support_is_read_at_call_time_and_the_field_reaches_the_wire() {
        attachOpen()
        assertTrue(surface.state.editableSupported)
        val editable = card().copy(editable = EditableSurfaceField(placeholder = "Reply"))
        assertEquals(NexusSdkResult.SENT, surface.showCard(editable))
        assertTrue(lastFrame(BusPaths.SURFACE_SHOW).payload.optJSONObject("editable") != null)
        harness.sppUp = false
        core.refreshLinkState()
        harness.settle()
        assertFalse(surface.state.editableSupported)
    }

    @Test
    fun C8_a_committed_field_reaches_onTextCommitted_once() {
        attachOpen()
        surface.showCard(card().copy(editable = EditableSurfaceField(placeholder = "Reply")))
        val committed = EditableSurfaceContract.committedPayload("agents:agents", "hello", false)
            .put("ownerPluginId", "agents")
        cxr.inject(BusEnvelope(path = BusPaths.SURFACE_TEXT_COMMITTED, payload = committed))
        harness.await("committed") { listener.events.any { it.startsWith("text:") } }
        assertEquals(1, listener.events.count { it.startsWith("text:") })
        assertTrue(listener.events.single { it.startsWith("text:") }.endsWith(":hello:false"))
    }

    // ---- 1.3 Notices and wake ----

    @Test
    fun N1_showNotice_works_closed_and_raises_this_apps_band() {
        attach()
        assertTrue(surface.state.noticeSupported)
        assertEquals(NexusSdkResult.SENT, surface.showNotice(NexusNotice(title = "Question", interactive = true)))
        val frame = lastFrame(BusPaths.NOTICE_SHOW).payload
        assertEquals("agents", frame.optString("ownerPluginId"))
        assertEquals(SurfaceState.Lifecycle.CLOSED, surface.state.lifecycle)
    }

    @Test
    fun N2_updateNotice_patches_the_band() {
        attach()
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        assertEquals(NexusSdkResult.SENT, surface.updateNotice(NexusNoticeUpdate(body = "more", rearm = false)))
        lastFrame(BusPaths.NOTICE_UPDATE)
    }

    @Test
    fun N3_hideNotice_hides_and_reports_owner_close() {
        attach()
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        lastFrame(BusPaths.NOTICE_SHOW)
        assertEquals(NexusSdkResult.SENT, surface.hideNotice())
        lastFrame(BusPaths.NOTICE_HIDE)
        harness.await("owner close") { "closed:OWNER" in notices.events }
    }

    @Test
    fun N4_a_shown_ack_for_another_band_is_dropped() {
        attach()
        // This hub relays no shown-ack capability, so the app may never wait for one.
        assertFalse(surface.state.noticeShownAckSupported)
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        lastFrame(BusPaths.NOTICE_SHOW)
        cxr.inject(
            BusEnvelope(
                path = BusPaths.NOTICE_SHOWN,
                payload = JSONObject().put("pluginId", "agents").put("noticeId", "agents:old-band"),
            ),
        )
        harness.settle()
        assertFalse("shown" in notices.events)
    }

    @Test
    fun N5_notice_input_arrives_at_most_once_per_question() {
        attach()
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        val reply = noticeReply(BusPaths.NOTICE_INPUT) {
            put("keyCode", KeyEvent.KEYCODE_DPAD_CENTER).put("action", KeyEvent.ACTION_DOWN)
        }
        cxr.inject(reply)
        harness.await("notice input") { notices.events.any { it.startsWith("input:") } }
        cxr.inject(reply.copy(id = "second"))
        harness.settle()
        assertEquals(1, notices.events.count { it.startsWith("input:") })
    }

    @Test
    fun N6_notice_action_arrives_once_and_never_with_input() {
        attach()
        surface.showNotice(
            NexusNotice(
                title = "Proceed?",
                actions = listOf(NexusNoticeAction("yes", "check", "Yes"), NexusNoticeAction("no", "close", "No")),
            ),
        )
        val pick = noticeReply(BusPaths.NOTICE_ACTION) { put("id", "yes") }
        cxr.inject(pick)
        harness.await("action") { "action:yes" in notices.events }
        cxr.inject(pick.copy(id = "again"))
        harness.settle()
        assertEquals(listOf("action:yes"), notices.events.filter { it.startsWith("action:") || it.startsWith("input:") })
    }

    @Test
    fun N7_notice_closed_is_reported_exactly_once() {
        attach()
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        val closed = noticeReply(BusPaths.NOTICE_CLOSED) { put("reason", "user") }
        cxr.inject(closed)
        harness.await("closed") { "closed:USER" in notices.events }
        cxr.inject(closed.copy(id = "again"))
        harness.settle()
        assertEquals(1, notices.events.count { it.startsWith("closed:") })
    }

    @Test
    fun N8_wake_display_reaches_the_wire_payload() {
        attach()
        surface.showNotice(NexusNotice(title = "Ping", wakeDisplay = true))
        assertTrue(lastFrame(BusPaths.NOTICE_SHOW).payload.optBoolean("wakeDisplay"))
    }

    // ---- 1.4 TTS ----

    @Test
    fun T1_speak_reaches_the_speaker_and_a_reused_id_is_refused() {
        attach()
        val tts = RecordingTts()
        assertEquals(NexusSdkResult.SENT, surface.speak("hello", "u1", tts))
        harness.await("spoken") { harness.tts.spoken.size == 1 }
        assertEquals(NexusSdkResult.INVALID_PAYLOAD, surface.speak("again", "u1", tts))
    }

    @Test
    fun T2_the_speaker_starting_reports_onStarted_once() {
        attach()
        val tts = RecordingTts()
        surface.speak("hello", "u1", tts)
        harness.await("spoken") { harness.tts.spoken.size == 1 }
        harness.tts.started()
        harness.await("started") { "started:u1" in tts.events }
        harness.settle()
        assertEquals(1, tts.events.count { it == "started:u1" })
    }

    @Test
    fun T3_every_accepted_utterance_ends_exactly_once() {
        attach()
        val tts = RecordingTts()
        surface.speak("hello", "u1", tts)
        harness.await("spoken") { harness.tts.spoken.size == 1 }
        harness.tts.started()
        harness.tts.finished()
        harness.await("done") { tts.events.any { it.startsWith("done:u1") } }
        harness.settle()
        assertEquals(listOf("started:u1", "done:u1:COMPLETED"), tts.events)
    }

    @Test
    fun T4_stopSpeaking_from_any_thread_ends_the_utterance_stopped() {
        attach()
        val tts = RecordingTts()
        surface.speak("hello", "u1", tts)
        harness.await("spoken") { harness.tts.spoken.size == 1 }
        Thread { surface.stopSpeaking() }.apply { start(); join() }
        harness.await("stopped") { tts.events.any { it.startsWith("done:u1") } }
        assertEquals("done:u1:STOPPED", tts.events.single { it.startsWith("done:") })
    }

    // ---- 1.5 STT ----

    @Test
    fun S1_one_speech_run_at_a_time() {
        attach()
        val first = surface.startSpeech(null, RecordingSpeech())
        assertEquals(NexusSdkResult.SENT, first.result)
        val second = RecordingSpeech()
        assertEquals(NexusSdkResult.CAPABILITY_NOT_AVAILABLE, surface.startSpeech(null, second).result)
        harness.settle()
        assertTrue(second.events.isEmpty())
    }

    @Test
    fun S2_acceptance_reports_onStarted_once() {
        attach()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        harness.settle()
        assertEquals(listOf("started:false"), speech.events.filter { it.startsWith("started:") })
        assertTrue(speech.offMain.isEmpty())
    }

    @Test
    fun S3_engine_state_is_reported_while_active() {
        attach()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        harness.await("listening") { "state:LISTENING" in speech.events }
    }

    @Test
    fun S4_partials_are_reported_while_active() {
        attach()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        harness.await("engine") { harness.stt.sessions.isNotEmpty() }
        harness.stt.sessions.last().listener.onPartial("hel")
        harness.await("partial") { "partial:hel" in speech.events }
    }

    @Test
    fun S5_a_final_result_ends_the_run_completed() {
        attach()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        harness.await("engine") { harness.stt.sessions.isNotEmpty() }
        harness.stt.sessions.last().listener.onFinal("hello there")
        harness.await("stopped") { speech.stops().isNotEmpty() }
        assertTrue("final:hello there" in speech.events)
        assertEquals(listOf("stopped:COMPLETED"), speech.stops())
    }

    @Test
    fun S6_an_engine_failure_ends_the_run_exactly_once() {
        attach()
        val speech = RecordingSpeech()
        acceptedSpeech(speech)
        harness.await("engine") { harness.stt.sessions.isNotEmpty() }
        harness.stt.sessions.last().listener.onError(SttError(SttErrorKind.NETWORK, "Android", null))
        harness.await("stopped") { speech.stops().isNotEmpty() }
        harness.settle()
        assertEquals(listOf("stopped:ERROR"), speech.stops())
    }

    @Test
    fun S7_stop_ends_the_run_cancelled_once_and_is_a_noop_after() {
        attach()
        val speech = RecordingSpeech()
        val handle = acceptedSpeech(speech)
        handle.stop()
        harness.await("stopped") { speech.stops().isNotEmpty() }
        handle.stop()
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
    }

    @Test
    fun device_info_is_kept_for_a_later_attach() {
        cxr.deviceInfo(GlassInfo(deviceName = "Glasses", batteryLevel = 50))
        harness.settle()
        attach()
        harness.await("device info") { listener.devices.isNotEmpty() }
        assertNull(listener.devices.single().volume)
    }
}
