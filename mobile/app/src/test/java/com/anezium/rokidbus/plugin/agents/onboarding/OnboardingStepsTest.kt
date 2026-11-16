package com.anezium.rokidbus.plugin.agents.onboarding

import android.app.Application
import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The last two screens, as drawn: the test alert's buttons and the sounds' preview. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OnboardingStepsTest {
    private val app: Application = RuntimeEnvironment.getApplication()

    @Before
    fun clean() {
        app.getSharedPreferences(OnboardingStore.PREFS, Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun openAt(step: OnboardingStep): OnboardingActivity {
        OnboardingStore(app).complete(*OnboardingStore.STEPS.takeWhile { it != step }.toTypedArray())
        return Robolectric.buildActivity(OnboardingActivity::class.java).setup().get().also { assertEquals(step, it.currentStep) }
    }

    @Test
    fun test_alert_offers_send_again_beside_saw_it_and_didnt_see_it() {
        val activity = openAt(OnboardingStep.TEST_ALERT)
        val texts = activity.visibleTexts().map(String::lowercase)
        assertTrue("$texts", texts.containsAll(OnboardingCopy.TEST_ALERT_ACTIONS.map(String::lowercase)))

        activity.clickText(OnboardingCopy.SEND_AGAIN)
        assertEquals(OnboardingStep.TEST_ALERT, activity.currentStep)
        activity.clickText(OnboardingCopy.DIDNT_SEE_IT)
        val missed = activity.visibleTexts()
        assertTrue(missed.contains(OnboardingCopy.TEST_ALERT_MISSED))
        assertTrue("it can be sent again from the missed screen too", missed.map(String::lowercase).contains("send again"))
    }

    @Test
    fun sounds_step_says_where_a_preview_plays_and_a_tap_on_a_choice_does_not_break_it() {
        val activity = openAt(OnboardingStep.SOUNDS)
        assertTrue(activity.visibleTexts().contains(OnboardingCopy.SOUNDS_PREVIEW))
        activity.clickText("Chime")
        activity.clickText("Speak")
        activity.clickText("Silent")
        assertEquals(OnboardingStep.SOUNDS, activity.currentStep)
    }
}
