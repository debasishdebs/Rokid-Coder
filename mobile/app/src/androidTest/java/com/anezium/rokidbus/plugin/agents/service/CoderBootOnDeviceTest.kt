package com.anezium.rokidbus.plugin.agents.service

import android.Manifest
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.ParcelFileDescriptor
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.anezium.rokidbus.client.plugin.NexusSdkResult
import com.anezium.rokidbus.client.plugin.NexusSpeechError
import com.anezium.rokidbus.client.plugin.NexusSpeechStopReason
import com.anezium.rokidbus.phone.HubPrefs
import com.anezium.rokidbus.phone.SpeechHandle
import com.anezium.rokidbus.phone.SpeechListener
import com.anezium.rokidbus.phone.SpeechTestSeam
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On a rooted emulator image (`adb root` first): BOOT_COMPLETED to our receiver starts the service
 * connected-device only, as `dumpsys activity services` reports it. The test runs in the app's
 * process, so it cannot reboot; a real reboot gives the same type (types=0x10, see the T4 report).
 * Voice keeps working after HOME: two sessions run through the hub's real speech pipeline, with
 * PCM injected for the glasses' microphone and a scripted recognizer (phone-core's debug-only
 * `SpeechTestSeam`).
 */
@RunWith(AndroidJUnit4::class)
class CoderBootOnDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val pkg = context.packageName

    private fun shell(command: String): String =
        ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command))
            .use { it.readBytes().toString(Charsets.UTF_8) }

    /** The running service's foreground types, or null while it is not foreground. */
    private fun foregroundTypes(): Int? {
        val dump = shell("dumpsys activity services $pkg/${CoderService::class.java.name}")
        if (!dump.contains("isForeground=true")) return null
        val hex = Regex("\\btypes=(?:0x)?([0-9a-fA-F]+)").find(dump)?.groupValues?.get(1) ?: return null
        return hex.toLong(16).toInt()
    }

    private fun await(what: String, timeoutMs: Long = 15_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) fail("timed out waiting for $what")
            Thread.sleep(100)
        }
    }

    @After
    fun tearDown() {
        runCatching { context.startService(Intent(context, CoderService::class.java).setAction(CoderService.ACTION_STOP)) }
        CoderService.resetSeams()
        context.getSharedPreferences(HubPrefs.PREFS, 0).edit().remove("cxrl_token").commit()
    }

    @Test
    fun boot_receiver_starts_connected_device_only_on_device() {
        // connectedDevice needs a Bluetooth or network prerequisite on API 34+; onboarding grants it.
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.BLUETOOTH_CONNECT)
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.RECORD_AUDIO)
        ServicePrefs(context).recordForegroundStart()

        // The system's own BOOT_COMPLETED carries a temporary allowlist for a foreground start; one
        // sent from the shell does not, so the test grants the same allowlist first.
        shell("cmd deviceidle tempwhitelist -d 20000 $pkg")
        shell("am broadcast -a ${Intent.ACTION_BOOT_COMPLETED} -n $pkg/${CoderBootReceiver::class.java.name}")

        var types: Int? = null
        val deadline = System.currentTimeMillis() + 15_000
        while (types == null && System.currentTimeMillis() < deadline) {
            Thread.sleep(250)
            types = foregroundTypes()
        }
        assertNotNull("the service never went foreground after BOOT_COMPLETED", types)
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE, types!! and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        assertEquals("no microphone type after boot", 0, types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    }

    /** One speech run's callbacks, from the main thread. */
    private class Run : SpeechListener {
        @Volatile var final: String? = null
        @Volatile var stopped: NexusSpeechStopReason? = null
        @Volatile var error: NexusSpeechError? = null
        override fun onStarted(realtime: Boolean) = Unit
        override fun onPartial(text: String) = Unit
        override fun onFinal(text: String) {
            final = text
        }
        override fun onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?) {
            stopped = reason
            this.error = error
        }
    }

    private fun processStarted(): Boolean {
        var started = false
        instrumentation.runOnMainSync {
            started = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        }
        return started
    }

    @Test
    fun voice_survives_background_across_two_sessions_on_device() {
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.BLUETOOTH_CONNECT)
        instrumentation.uiAutomation.grantRuntimePermission(pkg, Manifest.permission.RECORD_AUDIO)
        ServicePrefs(context).recordForegroundStart()
        // The real hub, session manager and AndroidSttSession; only the glasses' microphone and the
        // platform recognizer are the test's.
        val glasses = SpeechTestSeam.Glasses()
        val transcripts = listOf("first session", "second session")
        val recognizer = SpeechTestSeam.Recognizer(context, transcripts)
        var core: CoderCore? = null
        CoderService.coreFactory = { ctx, host ->
            HubCoderCore(SpeechTestSeam.hubCore(ctx, HubCoderCore.config(host), glasses, recognizer)).also { core = it }
        }

        // The app on screen: the one start that may ask Android for the microphone.
        context.startActivity(context.packageManager.getLaunchIntentForPackage(pkg)!!.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        await("the app on screen") { processStarted() }
        assertTrue(CoderService.startFromForeground(context))
        await("the microphone type") { (foregroundTypes() ?: 0) and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0 }
        await("the core") { core != null }
        instrumentation.runOnMainSync {
            core!!.startWithToken("speech-test")
            glasses.linkUp()
        }

        // HOME: from here on Android would refuse a new microphone start.
        shell("input keyevent KEYCODE_HOME")
        await("the app in the background") { !processStarted() }

        transcripts.forEachIndexed { index, said ->
            val run = Run()
            var handle: SpeechHandle? = null
            instrumentation.runOnMainSync { handle = core!!.surface.startSpeech(null, run) }
            assertEquals("session ${index + 1} start", NexusSdkResult.SENT, handle!!.result)
            await("session ${index + 1} audio stream") { glasses.streaming || run.stopped != null }

            // About a second of voice, then the silence a wearer leaves, as 20 ms frames of 16 kHz PCM.
            val voice = ByteArray(FRAME_BYTES).also { pcm ->
                for (sample in 0 until FRAME_BYTES / 2) {
                    val value = if (sample % 2 == 0) VOICE_LEVEL else -VOICE_LEVEL
                    pcm[2 * sample] = value.toByte()
                    pcm[2 * sample + 1] = (value shr 8).toByte()
                }
            }
            val silence = ByteArray(FRAME_BYTES)
            val deadline = System.currentTimeMillis() + 20_000
            var frames = 0
            while (run.stopped == null && System.currentTimeMillis() < deadline) {
                glasses.push(if (frames < VOICE_FRAMES) voice else silence)
                frames += 1
                Thread.sleep(FRAME_MS)
            }

            assertEquals("session ${index + 1} ended error=${run.error}", NexusSpeechStopReason.COMPLETED, run.stopped)
            assertEquals(said, run.final)
            assertTrue("session ${index + 1} heard its audio", recognizer.bytesHeard[index] > 0)
            assertTrue("still in the background", !processStarted())
        }

        val types = foregroundTypes() ?: 0
        assertTrue("the microphone type held after both sessions", types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0)
        assertEquals(VoiceAvailability.AVAILABLE, CoderService.voice.value)
        assertEquals("one stream per session", transcripts.size, glasses.streamStarts)
    }

    private companion object {
        const val FRAME_MS = 20L
        const val FRAME_BYTES = 640
        const val VOICE_FRAMES = 50

        // A loud square wave, little-endian 16-bit: well over the hub's voice threshold.
        const val VOICE_LEVEL = 12_000
    }
}
