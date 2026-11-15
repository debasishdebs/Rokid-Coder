package com.anezium.rokidbus.plugin.agents.service

import android.Manifest
import android.app.Application
import android.app.ForegroundServiceStartNotAllowedException
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.phone.GlassesSurface
import com.anezium.rokidbus.plugin.agents.AgentsConfigStore
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import com.anezium.rokidbus.plugin.agents.FakeGlassesSurface
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ServiceController
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

/** One foreground service, with the microphone only where Android allows it (R9, R9′). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class CoderServiceTest {
    private val app: Application = RuntimeEnvironment.getApplication()

    private data class Start(val id: Int, val notification: Notification, val types: Int) {
        val microphone get() = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0
        val connectedDevice get() = types and ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE != 0
    }

    private val starts = mutableListOf<Start>()

    /** What Android says to a microphone start: null allows it. */
    private var microphoneRefusal: (() -> Throwable)? = null

    private val glasses = FakeGlassesSurface()
    private var coreStarts = 0
    private var coreCloses = 0
    private var processStarted = true

    private val core = object : CoderCore {
        override val surface: GlassesSurface get() = glasses
        override fun start() {
            coreStarts += 1
        }
        override fun close() {
            coreCloses += 1
        }
    }

    @Before
    fun setUp() {
        CoderRuntime.reset()
        // The app points the predicate at onboarding (OnboardingFlowTest); these tests are about the service.
        CoderAppLifecycle.autoStartAllowed = { true }
        CoderService.processStarted = { processStarted }
        CoderService.starterFactory = {
            ForegroundStarter { id, notification, types ->
                if (types and ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE != 0) microphoneRefusal?.let { throw it() }
                starts += Start(id, notification, types)
            }
        }
        CoderService.coreFactory = { _, _ -> core }
    }

    @After
    fun tearDown() {
        running.forEach { runCatching { it.destroy() } }
        idle()
        CoderService.resetSeams()
        CoderRuntime.reset()
        CoderAppLifecycle.autoStartAllowed = { true }
        AgentsRuntime.hudOpen = false
    }

    private val running = mutableListOf<ServiceController<CoderService>>()

    private val processOwner = object : LifecycleOwner {
        override val lifecycle: Lifecycle get() = error("unused")
    }

    private fun idle() = ShadowLooper.idleMainLooper()

    private fun grantMicrophone(granted: Boolean) {
        if (granted) {
            shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
        } else {
            shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
        }
    }

    /** Runs the start Android would deliver for [intent]; null is a sticky restart. */
    private fun deliver(intent: Intent?): CoderService {
        val controller = running.lastOrNull() ?: Robolectric.buildService(CoderService::class.java).create().also { running += it }
        controller.get().onStartCommand(intent, 0, running.size)
        idle()
        return controller.get()
    }

    /** The start the last call asked Android for, delivered to the service. */
    private fun deliverNextStart(): CoderService {
        val intent = shadowOf(app).nextStartedService
        assertNotNull("nothing asked for the service", intent)
        return deliver(intent)
    }

    private fun bootIntent(): Intent {
        CoderService.startFromBoot(app)
        return shadowOf(app).nextStartedService
    }

    private fun receiveBoot(action: String = Intent.ACTION_BOOT_COMPLETED) {
        CoderBootReceiver().onReceive(app, Intent(action))
    }

    private fun text(notification: Notification): String =
        listOfNotNull(
            notification.extras.getCharSequence(NotificationCompat.EXTRA_TITLE),
            notification.extras.getCharSequence(NotificationCompat.EXTRA_TEXT),
            notification.extras.getCharSequence(NotificationCompat.EXTRA_BIG_TEXT),
        ).joinToString("\n")

    private fun shownNotification(): Notification =
        shadowOf(app.getSystemService(NotificationManager::class.java))
            .getNotification(CoderNotifications.NOTIFICATION_ID) ?: starts.last().notification

    private fun glassesNotices(): List<NexusNotice> =
        glasses.callsOf<FakeGlassesSurface.Call.ShowNotice>().map { it.notice }

    @Test
    fun boot_start_never_requests_microphone_type() {
        grantMicrophone(true)

        deliver(bootIntent())

        assertEquals(1, starts.size)
        assertTrue(starts.single().connectedDevice)
        assertFalse(starts.single().microphone)
        assertEquals(CoderNotifications.NOTIFICATION_ID, starts.single().id)
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
        assertEquals(1, coreStarts)
        assertTrue(CoderRuntime.ready.value)
    }

    @Test
    fun sticky_restart_is_treated_as_boot() {
        grantMicrophone(true)
        ServicePrefs(app).recordForegroundStart()

        deliver(null)

        assertEquals(listOf(false), starts.map { it.microphone })
        assertTrue(starts.single().connectedDevice)
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
    }

    @Test
    fun boot_receiver_starts_only_after_a_foreground_start_and_never_when_stopped() {
        assertFalse(CoderBootPolicy.shouldStart(Intent.ACTION_BOOT_COMPLETED, everStartedFromForeground = false, stoppedByUser = false))
        assertTrue(CoderBootPolicy.shouldStart(Intent.ACTION_BOOT_COMPLETED, everStartedFromForeground = true, stoppedByUser = false))
        assertTrue(CoderBootPolicy.shouldStart(Intent.ACTION_MY_PACKAGE_REPLACED, everStartedFromForeground = true, stoppedByUser = false))
        assertFalse(CoderBootPolicy.shouldStart(Intent.ACTION_BOOT_COMPLETED, everStartedFromForeground = true, stoppedByUser = true))
        assertFalse(CoderBootPolicy.shouldStart(Intent.ACTION_SCREEN_ON, everStartedFromForeground = true, stoppedByUser = false))
        assertFalse(CoderBootPolicy.shouldStart(null, everStartedFromForeground = true, stoppedByUser = false))

        // Fresh storage: nothing.
        receiveBoot()
        assertNull(shadowOf(app).nextStartedService)

        ServicePrefs(app).recordForegroundStart()
        receiveBoot()
        assertEquals(CoderService.ACTION_BOOT_START, shadowOf(app).nextStartedService.action)
        receiveBoot(Intent.ACTION_MY_PACKAGE_REPLACED)
        assertEquals(CoderService.ACTION_BOOT_START, shadowOf(app).nextStartedService.action)

        ServicePrefs(app).recordStop()
        receiveBoot()
        assertNull(shadowOf(app).nextStartedService)
    }

    @Test
    fun first_start_from_any_caller_makes_boot_eligible() {
        grantMicrophone(true)
        // The process start is not allowed to start the service (onboarding has not reached GLASSES).
        CoderAppLifecycle.autoStartAllowed = { false }
        CoderAppLifecycle.observer(app).onStart(processOwner)
        assertNull(shadowOf(app).nextStartedService)
        assertFalse(ServicePrefs(app).everStartedFromForeground)

        // The GLASSES step starts it itself, from its visible activity.
        assertTrue(CoderService.startFromForeground(app))
        assertTrue(ServicePrefs(app).everStartedFromForeground)
        shadowOf(app).clearStartedServices()

        // A reboot, and the app is not reopened.
        receiveBoot()
        deliverNextStart()

        assertEquals(listOf(false), starts.map { it.microphone })
        assertTrue(starts.single().connectedDevice)
    }

    @Test
    fun app_open_promotes_to_microphone_when_permission_granted() {
        grantMicrophone(true)
        ServicePrefs(app).recordForegroundStart()
        deliver(bootIntent())
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)

        CoderAppLifecycle.observer(app).onStart(processOwner)
        deliverNextStart()

        assertEquals(listOf(false, true), starts.map { it.microphone })
        assertTrue(starts.last().connectedDevice)
        assertEquals(VoiceAvailability.AVAILABLE, CoderService.voice.value)
        assertNull(CoderService.voice.value.notificationLine)
        assertEquals(1, coreStarts)
    }

    @Test
    fun a_start_outside_a_visible_activity_is_refused() {
        processStarted = false

        assertFalse(CoderService.startFromForeground(app))
        assertNull(shadowOf(app).nextStartedService)
        assertFalse(ServicePrefs(app).everStartedFromForeground)
    }

    @Test
    fun notification_tap_is_an_activity_intent_and_promotes_on_open() {
        grantMicrophone(true)
        ServicePrefs(app).recordForegroundStart()
        deliver(bootIntent())

        val notification = starts.single().notification
        val tap = shadowOf(notification.contentIntent)
        assertTrue("the tap opens an activity, never a trampoline", tap.isActivityIntent)
        assertFalse(tap.isServiceIntent)
        assertFalse(tap.isBroadcastIntent)
        val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
        assertEquals(launch?.component ?: android.content.ComponentName(app, "com.anezium.rokidbus.plugin.agents.AgentsSettingsActivity"), tap.savedIntent.component)

        val actions = notification.actions.associateBy { it.title.toString() }
        assertEquals(setOf(CoderNotifications.ACTION_SETTINGS, CoderNotifications.ACTION_STOP), actions.keys)
        assertTrue(shadowOf(actions.getValue(CoderNotifications.ACTION_SETTINGS).actionIntent).isActivityIntent)
        val stop = shadowOf(actions.getValue(CoderNotifications.ACTION_STOP).actionIntent)
        assertTrue(stop.isServiceIntent)
        assertEquals(CoderService.ACTION_STOP, stop.savedIntent.action)
        assertEquals(CoderService::class.java.name, stop.savedIntent.component?.className)

        // The opened activity brings the process to the foreground: that start promotes.
        CoderAppLifecycle.observer(app).onStart(processOwner)
        deliverNextStart()
        assertTrue(starts.last().microphone)
        assertEquals(VoiceAvailability.AVAILABLE, CoderService.voice.value)
    }

    @Test
    fun voice_needs_app_open_after_boot_and_pointer_shown() {
        grantMicrophone(true)
        ServicePrefs(app).recordForegroundStart()
        val service = deliver(bootIntent())

        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
        assertTrue(text(shownNotification()).contains("Open Rokid Coder once to turn on voice"))

        // Push-to-talk from the background: Android refuses the microphone, as it does after boot.
        microphoneRefusal = { ForegroundServiceStartNotAllowedException("background") }
        val failure = service.promote(microphone = true)
        idle()

        assertTrue(failure is ForegroundServiceStartNotAllowedException)
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
        val notice = glassesNotices().single()
        assertEquals(VoiceAvailability.GLASSES_TITLE, notice.title)
        assertEquals("Open Rokid Coder once to turn on voice", notice.body)
        assertTrue(starts.none { it.microphone })
    }

    @Test
    fun speech_before_app_open_never_asks_android_for_the_microphone() {
        grantMicrophone(true)
        ServicePrefs(app).recordForegroundStart()
        val service = deliver(bootIntent())
        // After boot and before the app opens: whatever Android would answer, the service does not ask.
        processStarted = false

        val failure = service.promote(microphone = true)
        idle()

        assertNotNull(failure)
        assertEquals("no microphone start from the background", listOf(false), starts.map { it.microphone })
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
        assertEquals(VoiceAvailability.OPEN_APP, glassesNotices().single().body)

        // Opened once, the type is held: a later session from the background needs no visible screen.
        processStarted = true
        CoderAppLifecycle.observer(app).onStart(processOwner)
        deliverNextStart()
        assertTrue(starts.last().microphone)
        processStarted = false
        assertNull(service.promote(microphone = true))
        assertNull(service.promote(microphone = false))
        assertEquals(VoiceAvailability.AVAILABLE, CoderService.voice.value)
    }

    @Test
    fun promotion_failure_shows_pointer_not_silence() {
        grantMicrophone(true)
        microphoneRefusal = { SecurityException("not in the foreground") }

        deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))

        // The refused microphone falls back to connected-device; the service stays up.
        assertEquals(listOf(false), starts.map { it.microphone })
        assertTrue(starts.single().connectedDevice)
        assertEquals(VoiceAvailability.NEEDS_APP_OPEN, CoderService.voice.value)
        assertTrue(CoderRuntime.ready.value)

        // The STT session's acquire gets the error back, and the glasses say what to do.
        val service = running.single().get()
        val failure = service.promote(microphone = true)
        idle()

        assertTrue(failure is SecurityException)
        assertEquals("Open Rokid Coder once to turn on voice", glassesNotices().single().body)
        assertTrue(text(shownNotification()).contains("Open Rokid Coder once to turn on voice"))
    }

    @Test
    fun denied_mic_permission_shows_grant_pointer() {
        grantMicrophone(false)

        val service = deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))

        assertEquals(listOf(false), starts.map { it.microphone })
        assertEquals(VoiceAvailability.PERMISSION_DENIED, CoderService.voice.value)
        assertTrue(text(starts.single().notification).contains("Microphone is off — tap to grant"))

        val failure = service.promote(microphone = true)
        idle()

        assertNotNull(failure)
        assertEquals(1, starts.size)
        assertTrue(glassesNotices().single().body!!.startsWith("Microphone is off"))

        // Granted, then the app opened: the service promotes.
        grantMicrophone(true)
        deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))
        assertTrue(starts.last().microphone)
        assertEquals(VoiceAvailability.AVAILABLE, CoderService.voice.value)
    }

    @Test
    fun stt_release_keeps_microphone_entitlement_in_product() {
        grantMicrophone(true)
        val service = deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))
        assertEquals(listOf(true), starts.map { it.microphone })
        // From here on the app is in the background: a new microphone start would be refused.
        microphoneRefusal = { ForegroundServiceStartNotAllowedException("background") }

        // HubCore's acquire and release around a session ending normally, a cancel and an STT error.
        for (ending in listOf("completed", "cancelled", "error")) {
            assertNull("acquire before $ending", service.promote(microphone = true))
            assertNull("release after $ending", service.promote(microphone = false))
            assertEquals(ending, VoiceAvailability.AVAILABLE, CoderService.voice.value)
        }

        assertEquals("no start without the microphone type", listOf(true), starts.map { it.microphone })
        assertTrue(glassesNotices().isEmpty())
    }

    @Test
    fun stop_action_stops_until_app_opened() {
        grantMicrophone(true)
        val service = deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))
        assertTrue(CoderRuntime.ready.value)

        val result = service.onStartCommand(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_STOP), 0, 9)
        idle()

        assertEquals(android.app.Service.START_NOT_STICKY, result)
        assertTrue(ServicePrefs(app).stoppedByUser)
        assertTrue(shadowOf(service).isStoppedBySelf)
        assertTrue(shadowOf(service).isForegroundStopped)
        assertTrue(shadowOf(service).notificationShouldRemoved)
        assertEquals(1, coreCloses)
        assertFalse(CoderRuntime.ready.value)
        assertNull(glasses.listener)
        assertNull(AgentsRuntime.alertDirector)

        // Boot does nothing now.
        receiveBoot()
        assertNull(shadowOf(app).nextStartedService)

        // Opening the app clears it, and starts with voice.
        assertTrue(CoderService.startFromForeground(app))
        assertFalse(ServicePrefs(app).stoppedByUser)
        running.forEach { it.destroy() }
        running.clear()
        starts.clear()
        deliverNextStart()
        assertTrue(starts.single().microphone)
    }

    @Test
    fun stop_survives_reboot_until_app_opened() {
        grantMicrophone(true)
        assertTrue(CoderService.startFromForeground(app))
        deliverNextStart()
        deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_STOP))
        running.forEach { it.destroy() }
        running.clear()

        // A reboot: a new process reads the stored flags; nothing starts, however often it boots.
        repeat(2) {
            receiveBoot()
            assertNull(shadowOf(app).nextStartedService)
        }

        // The app is opened: it starts with voice, and the next boot starts it again.
        assertTrue(CoderService.startFromForeground(app))
        starts.clear()
        deliverNextStart()
        assertTrue(starts.single().microphone)
        receiveBoot()
        assertEquals(CoderService.ACTION_BOOT_START, shadowOf(app).nextStartedService.action)
    }

    @Test
    fun stop_keeps_monitoring_setting_unchanged() {
        val config = AgentsConfigStore(app)
        config.setAgentdEnabled(true)
        val service = deliver(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_FOREGROUND_START))

        service.onStartCommand(Intent(app, CoderService::class.java).setAction(CoderService.ACTION_STOP), 0, 2)
        idle()

        assertTrue(config.load().agentdEnabled)
    }

    @Test
    fun a_service_that_cannot_go_foreground_stops_itself() {
        CoderService.starterFactory = { ForegroundStarter { _, _, _ -> throw SecurityException("no prerequisite") } }

        val service = deliver(bootIntent())

        assertTrue(shadowOf(service).isStoppedBySelf)
        assertEquals(0, coreStarts)
    }

    @Test
    fun the_service_hosts_the_agents_core_on_the_hub_surface() {
        deliver(bootIntent())

        assertEquals(1, glasses.attaches)
        assertNotNull(glasses.listener)
        assertSame(glasses.listener, AgentsRuntime.alertGlasses)
        assertNotNull(AgentsRuntime.alertDirector)
    }
}
