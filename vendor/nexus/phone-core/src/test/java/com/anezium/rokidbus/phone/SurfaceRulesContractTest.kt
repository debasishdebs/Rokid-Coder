@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import com.anezium.rokidbus.client.plugin.NexusCard
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.shared.BusPaths
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.atomic.AtomicReference

/** The surface's threading, speech-run and attach/detach/restart rules (adr-cores.md §1, §3.2). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [ShadowCaps::class], instrumentedPackages = ["com.rokid.cxr"])
class SurfaceRulesContractTest {
    private val harness = HubCoreHarness().startLinked()
    private val core get() = harness.core
    private val surface: GlassesSurface get() = core.surface()
    private val listener = RecordingSurfaceListener()
    private val notices = RecordingNotices()

    private fun attach() {
        surface.attach(listener, notices)
        harness.settle()
    }

    private fun card() = NexusCard(title = "Board", lines = listOf("line"))

    /** A run the hub has not answered yet: the speech bus is held on a busy STT executor. */
    private fun pendingSpeech(speech: RecordingSpeech): SpeechHandle {
        val handle = surface.startSpeech(null, speech)
        assertEquals(NexusSdkResult.SENT, handle.result)
        return handle
    }

    // ---- Surface threading (§1) ----

    @Test
    fun confined_call_off_main_throws() {
        attach()
        val failure = AtomicReference<Throwable?>()
        Thread { failure.set(runCatching { surface.showCard(card()) }.exceptionOrNull()) }
            .apply { start(); join() }
        assertTrue(failure.get() is IllegalStateException)
        assertEquals("GlassesSurface must be called on the main thread", failure.get()!!.message)
    }

    @Test
    fun callbacks_are_posted_never_reentrant() {
        attach()
        val speech = RecordingSpeech()
        val handle = surface.startSpeech(null, speech)
        harness.await("accepted") { speech.events.any { it.startsWith("started:") } }
        handle.stop()
        // The SDK finishes CANCELLED synchronously inside stop(); the listener hears it later.
        assertTrue(speech.stops().isEmpty())
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
    }

    @Test
    fun cancellation_calls_from_a_background_thread_run_on_main_in_order() {
        attach()
        val speech = RecordingSpeech()
        val tts = RecordingTts()
        val handle = surface.startSpeech(null, speech)
        harness.await("accepted") { speech.events.any { it.startsWith("started:") } }
        surface.speak("hello", "u1", tts)
        harness.await("spoken") { harness.tts.spoken.isNotEmpty() }
        Thread {
            handle.stop()
            surface.stopSpeaking()
        }.apply { start(); join() }
        harness.settle()
        assertTrue(speech.offMain.isEmpty())
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
        assertEquals(listOf("done:u1:STOPPED"), tts.events.filter { it.startsWith("done:") })
        Thread { surface.detach() }.apply { start(); join() }
        harness.settle()
        assertEquals(NexusSdkResult.NOT_REGISTERED, surface.showCard(card()))
    }

    // ---- Speech runs (§3.2.2) ----

    @Test
    fun stop_before_acceptance_latches_and_stops_on_accept() {
        attach()
        val speech = RecordingSpeech()
        val handle = pendingSpeech(speech)
        handle.stop()
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.events.toList())
        assertTrue(speech.events.none { it.startsWith("started:") })
        // The acceptance that follows is answered with a stop at once, ending the engine.
        harness.await("engine cancelled") { harness.stt.sessions.lastOrNull()?.cancelled == true }
        assertEquals(1, speech.stops().size)
    }

    @Test
    fun stop_before_acceptance_then_denial_is_swallowed() {
        attach()
        // Without the microphone the hub denies the start; the stop is latched before it does.
        org.robolectric.Shadows.shadowOf(harness.context).denyPermissions(android.Manifest.permission.RECORD_AUDIO)
        val speech = RecordingSpeech()
        pendingSpeech(speech).stop()
        harness.settle()
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.events.toList())
        assertTrue(harness.stt.sessions.isEmpty())
    }

    @Test
    fun stop_from_background_thread_is_serialized_on_main() {
        attach()
        val speech = RecordingSpeech()
        val handle = surface.startSpeech(null, speech)
        harness.await("accepted") { speech.events.any { it.startsWith("started:") } }
        Thread { handle.stop() }.apply { start(); join() }
        assertTrue(speech.stops().isEmpty())
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
        assertTrue(speech.offMain.isEmpty())
    }

    @Test
    fun stop_after_end_is_a_noop() {
        attach()
        val speech = RecordingSpeech()
        val handle = surface.startSpeech(null, speech)
        harness.await("engine") { harness.stt.sessions.isNotEmpty() && speech.events.any { it.startsWith("started:") } }
        harness.stt.sessions.last().listener.onFinal("done")
        harness.await("completed") { speech.stops().isNotEmpty() }
        handle.stop()
        harness.settle()
        assertEquals(listOf("stopped:COMPLETED"), speech.stops())
    }

    @Test
    fun second_start_while_latched_is_not_available() {
        attach()
        val speech = RecordingSpeech()
        pendingSpeech(speech).stop()
        val second = RecordingSpeech()
        assertEquals(NexusSdkResult.CAPABILITY_NOT_AVAILABLE, surface.startSpeech(null, second).result)
        harness.settle()
        assertTrue(second.events.isEmpty())
    }

    @Test
    fun late_callback_of_an_old_run_never_reaches_a_new_run() {
        attach()
        val old = RecordingSpeech()
        val handle = surface.startSpeech(null, old)
        harness.await("accepted") { old.events.any { it.startsWith("started:") } }
        handle.stop()
        harness.await("old ended") { old.stops().isNotEmpty() }
        // Until the hub ends the old session too, a new start is refused BUSY (BUSSPEC STT sessions).
        harness.await("old session ended at the hub") { harness.speechSessionsEnded() == 1 }
        val oldEngine = harness.stt.sessions.last()
        val fresh = RecordingSpeech()
        surface.startSpeech(null, fresh)
        harness.await("fresh accepted") { fresh.events.any { it.startsWith("started:") } }
        oldEngine.listener.onPartial("stale")
        harness.settle()
        assertFalse(fresh.events.contains("partial:stale"))
        assertFalse(old.events.contains("partial:stale"))
    }

    // ---- Attach, detach, restart (§3.2.1) ----

    @Test
    fun attach_posts_initial_state_and_device_info() {
        harness.cxr.deviceInfo(com.example.cxrglobal.GlassInfo(deviceName = "Glasses"))
        harness.settle()
        surface.attach(listener, notices)
        assertTrue(listener.events.isEmpty())
        harness.settle()
        assertEquals(listOf("state", "device"), listener.events.take(2))
    }

    @Test
    fun detach_drops_already_queued_callbacks() {
        attach()
        harness.launcherOpen()
        // The open is queued on main, then the listener goes before it runs.
        Thread.sleep(50)
        surface.detach()
        harness.settle()
        assertFalse(listener.events.any { it.startsWith("open:") })
    }

    @Test
    fun detach_ends_speech_tts_notice_and_surface() {
        attach()
        harness.launcherOpen()
        harness.await("open") { "open:open" in listener.events }
        val speech = RecordingSpeech()
        surface.startSpeech(null, speech)
        harness.await("accepted") { speech.events.any { it.startsWith("started:") } }
        val tts = RecordingTts()
        surface.speak("hello", "u1", tts)
        surface.showNotice(NexusNotice(title = "Question", interactive = true))
        harness.await("spoken") { harness.tts.spoken.isNotEmpty() }
        val stopsBefore = harness.tts.stops
        surface.detach()
        harness.await("surface hidden") { harness.cxr.framesOn(BusPaths.SURFACE_HIDE).isNotEmpty() }
        harness.await("notice hidden") { harness.cxr.framesOn(BusPaths.NOTICE_HIDE).isNotEmpty() }
        harness.await("speaker stopped") { harness.tts.stops > stopsBefore }
        harness.settle()
        // Released silently: the old listener hears no terminal callback after the detach.
        assertTrue(speech.stops().isEmpty())
        assertTrue(tts.events.none { it.startsWith("done:") })
        assertTrue("close" !in listener.events)
    }

    @Test
    fun open_while_detached_is_hidden_at_once() {
        harness.launcherOpen()
        harness.await("hidden") { harness.cxr.framesOn(BusPaths.SURFACE_HIDE).isNotEmpty() }
        assertEquals(SurfaceState.Lifecycle.CLOSED, surface.state.lifecycle)
    }

    @Test
    fun stop_reports_cancelled_and_stopped_never_error() {
        attach()
        harness.launcherOpen()
        harness.await("open") { "open:open" in listener.events }
        val speech = RecordingSpeech()
        surface.startSpeech(null, speech)
        harness.await("accepted") { speech.events.any { it.startsWith("started:") } }
        val tts = RecordingTts()
        surface.speak("hello", "u1", tts)
        harness.await("spoken") { harness.tts.spoken.isNotEmpty() }
        core.stop()
        harness.settle()
        assertEquals(listOf("stopped:CANCELLED"), speech.stops())
        assertEquals(listOf("done:u1:STOPPED"), tts.events.filter { it.startsWith("done:") })
        assertEquals(1, listener.count("close"))
        assertEquals(NexusSdkResult.NOT_REGISTERED, surface.showCard(card()))
    }

    @Test
    fun restart_recreates_the_client_and_keeps_the_listener() {
        attach()
        core.stop()
        harness.settle()
        listener.events.clear()
        core.start()
        harness.cxr.linkUp()
        harness.announceGlasses()
        harness.await("state again") { "state" in listener.events }
        harness.launcherOpen()
        harness.await("open") { "open:open" in listener.events }
        assertEquals(NexusSdkResult.SENT, surface.showCard(card()))
    }

    @Test
    fun old_epoch_callbacks_are_dropped_after_restart() {
        attach()
        harness.launcherOpen()
        Thread.sleep(50)
        // The open is still queued from the first client when the core restarts.
        core.stop()
        core.start()
        harness.settle()
        assertFalse(listener.events.any { it.startsWith("open:") })
    }
}
