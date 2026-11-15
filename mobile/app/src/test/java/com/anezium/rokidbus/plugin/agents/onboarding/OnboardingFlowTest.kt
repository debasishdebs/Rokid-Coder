package com.anezium.rokidbus.plugin.agents.onboarding

import android.Manifest
import android.app.Application
import android.content.Context
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentsSettingsActivity
import com.anezium.rokidbus.plugin.agents.MainActivity
import com.anezium.rokidbus.plugin.agents.service.CoderAppLifecycle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

/** The persisted state machine: resume, the launcher's route, the permissions step and the autostart gate. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OnboardingFlowTest {
    private val app: Application = RuntimeEnvironment.getApplication()

    @Before
    fun clean() {
        app.getSharedPreferences(OnboardingStore.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    /** A new store on the same file is what a new process reads: only committed writes are there. */
    private fun reopened() = OnboardingStore(app)

    @Test
    fun onboarding_resumes_at_first_incomplete_step_after_process_death() {
        assertEquals(OnboardingStep.WELCOME, reopened().resumeStep())
        OnboardingStore(app).complete(OnboardingStep.WELCOME, OnboardingStep.PERMISSIONS)
        assertEquals(OnboardingStep.GLASSES, reopened().resumeStep())

        // "Not now" on the glasses goes on, but the next open resumes there.
        OnboardingStore(app).complete(OnboardingStep.COMPUTER_CHECKLIST, OnboardingStep.FINISH_ON_COMPUTER, OnboardingStep.PAIRING)
        assertEquals(OnboardingStep.GLASSES, reopened().resumeStep())
        assertFalse("DONE needs every step", reopened().isDone())

        OnboardingStore(app).complete(OnboardingStep.GLASSES, OnboardingStep.LAPTOP_DONE, OnboardingStep.TEST_ALERT)
        assertEquals(OnboardingStep.SOUNDS, reopened().resumeStep())
        OnboardingStore(app).finish()
        assertEquals(OnboardingStep.DONE, reopened().resumeStep())
        assertTrue(reopened().isDone())
    }

    @Test
    fun launcher_routes_to_onboarding_until_done_then_home() {
        OnboardingStore(app).complete(OnboardingStep.WELCOME)
        val first = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val toOnboarding = shadowOf(first).nextStartedActivity
        assertEquals(OnboardingActivity::class.java.name, toOnboarding.component?.className)
        assertTrue(first.isFinishing)

        OnboardingStore.STEPS.forEach { OnboardingStore(app).complete(it) }
        val second = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        assertEquals(AgentsSettingsActivity::class.java.name, shadowOf(second).nextStartedActivity.component?.className)
    }

    @Test
    fun onboarding_activity_opens_at_the_resumed_step() {
        OnboardingStore(app).complete(OnboardingStep.WELCOME, OnboardingStep.PERMISSIONS, OnboardingStep.GLASSES)
        val activity = Robolectric.buildActivity(OnboardingActivity::class.java).setup().get()
        assertEquals(OnboardingStep.COMPUTER_CHECKLIST, activity.currentStep)
    }

    @Test
    fun service_autostart_is_allowed_from_the_glasses_step_on() {
        CoderAppLifecycle.autoStartAllowed = { OnboardingStore(app).serviceAllowed() }
        assertFalse(CoderAppLifecycle.autoStartAllowed())
        OnboardingStore(app).complete(OnboardingStep.WELCOME, OnboardingStep.PERMISSIONS)
        assertTrue(CoderAppLifecycle.autoStartAllowed())
        val source = File("src/main/java/com/anezium/rokidbus/plugin/agents/RokidCoderApp.kt").readText()
        assertTrue("the app points the predicate at onboarding", "serviceAllowed()" in source)
    }

    @Test
    fun permissions_step_explains_each_permission_and_continues_on_deny_with_pointer() {
        val store = OnboardingStore(app)
        val granted = mutableSetOf<PermissionFeature>()
        val flow = PermissionsFlow(store, sdkInt = 34, isGranted = { it in granted })

        assertEquals(
            listOf(PermissionFeature.BLUETOOTH, PermissionFeature.MICROPHONE, PermissionFeature.NOTIFICATIONS, PermissionFeature.BATTERY),
            flow.features,
        )
        assertEquals(listOf(Manifest.permission.BLUETOOTH_CONNECT), PermissionFeature.BLUETOOTH.permissions(34))
        assertEquals(listOf(Manifest.permission.RECORD_AUDIO), PermissionFeature.MICROPHONE.permissions(34))
        assertEquals(listOf(Manifest.permission.POST_NOTIFICATIONS), PermissionFeature.NOTIFICATIONS.permissions(34))

        // One screen each, each with its reason.
        val seen = mutableListOf<PermissionFeature>()
        while (true) {
            val screen = flow.current() ?: break
            seen += screen.feature
            assertTrue(screen.reason.isNotBlank())
            assertEquals("Allow", screen.allowLabel)
            // The microphone is denied; everything else granted.
            if (screen.feature != PermissionFeature.MICROPHONE) granted += screen.feature
            flow.answered(screen.feature)
        }
        assertEquals(flow.features, seen)
        assertTrue("asked once each: the step is complete", reopened().isComplete(OnboardingStep.PERMISSIONS))

        val summary = flow.summary()
        val microphone = summary.single { it.feature == PermissionFeature.MICROPHONE }
        assertFalse(microphone.on)
        assertEquals("Microphone — off", microphone.text)
        assertEquals("Grant", microphone.pointer)
        assertTrue(summary.filter { it.feature != PermissionFeature.MICROPHONE }.all { it.on && it.pointer == null })
    }

    @Test
    fun older_phones_skip_the_screens_they_have_no_permission_for() {
        val flow = PermissionsFlow(OnboardingStore(app), sdkInt = 30, isGranted = { false })
        assertEquals(listOf(PermissionFeature.MICROPHONE, PermissionFeature.BATTERY), flow.features)
    }

    @Test
    fun computer_checklist_is_persisted_and_picks_the_test_alert_provider() {
        OnboardingStore(app).computerChoice = ComputerChoice.CODEX
        assertEquals(ComputerChoice.CODEX, reopened().computerChoice)
        assertEquals(AgentProvider.CODEX, ComputerChoice.CODEX.testAlertProvider)
        assertEquals(AgentProvider.CLAUDE, ComputerChoice.BOTH.testAlertProvider)
        assertTrue(OnboardingCopy.finishOnComputerLines(ComputerChoice.NEITHER).any { "rk claude" in it && "rk codex" in it })
        assertFalse(OnboardingCopy.finishOnComputerLines(ComputerChoice.CLAUDE_CODE).any { "rk codex" in it })
    }

    @Test
    fun finish_on_computer_shows_link_and_unsigned_installer_hint_per_os() {
        assertEquals("Finish on your computer", OnboardingCopy.FINISH_TITLE)
        assertEquals("https://github.com/debasishdebs/Rokid-Coder/releases/latest", OnboardingCopy.DOWNLOAD_URL)
        assertEquals("right-click → Open", OnboardingCopy.installerHint(ComputerOs.MAC_OS).single())
        assertEquals(
            listOf("More info → Run anyway", "Windows needs WSL 2 — the installer checks it for you"),
            OnboardingCopy.installerHint(ComputerOs.WINDOWS),
        )
        assertEquals("Time's up — tap to try again", OnboardingCopy.TIMES_UP)
        assertEquals("Ready to pair — tap to open the window", OnboardingCopy.READY_TO_PAIR)

        // The screen draws the link with Copy and Share, and the switch changes the hint.
        OnboardingStore(app).complete(*OnboardingStore.STEPS.takeWhile { it != OnboardingStep.FINISH_ON_COMPUTER }.toTypedArray())
        val activity = Robolectric.buildActivity(OnboardingActivity::class.java).setup().get()
        assertEquals(OnboardingStep.FINISH_ON_COMPUTER, activity.currentStep)
        val texts = activity.visibleTexts()
        assertTrue(texts.contains(OnboardingCopy.FINISH_TITLE))
        assertTrue(texts.contains(OnboardingCopy.DOWNLOAD_URL))
        // The outline buttons draw their label in the mono capitals of the pairing screens.
        val buttons = texts.map(String::lowercase)
        assertTrue("$texts", buttons.containsAll(listOf("copy", "share", "macos", "windows")))
        assertTrue(texts.contains(OnboardingCopy.READY_TO_PAIR))
        assertTrue(texts.contains("right-click → Open"))
        activity.clickText("Windows")
        assertTrue(activity.visibleTexts().contains("More info → Run anyway"))
        assertNotNull(activity)
    }
}
