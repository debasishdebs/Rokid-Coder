package com.anezium.rokidbus.plugin.agents.onboarding

import android.app.Application
import android.content.ClipboardManager
import android.content.Context
import com.anezium.rokidbus.plugin.agents.service.LinkLog
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
    fun the_glass_app_screen_has_a_collapsed_link_log_that_copies_as_text_without_anything_sensitive() {
        val secret = "tok1234567890abcdefXYZ"
        LinkLog.clearRecent()
        LinkLog.i("voice tap: link UP after 1200ms (attempt 1)")
        LinkLog.i("hub says token=$secret at 192.168.1.20")
        try {
            val activity = openAt(OnboardingStep.GLASSES)

            // The pill buttons draw their labels in capitals.
            val collapsed = activity.visibleTexts().map(String::lowercase)
            assertTrue("$collapsed", OnboardingCopy.LINK_LOG.lowercase() in collapsed)
            assertFalse("collapsed: no lines shown", collapsed.any { it.contains("voice tap: link up") })
            assertFalse(OnboardingCopy.COPY.lowercase() in collapsed)

            activity.clickText(OnboardingCopy.LINK_LOG)
            val open = activity.visibleTexts()
            assertTrue(open.any { it.contains("voice tap: link UP after 1200ms (attempt 1)") })
            assertTrue(OnboardingCopy.LINK_LOG_HIDE.lowercase() in open.map(String::lowercase))
            assertFalse("what is shown is redacted too", open.any { it.contains(secret) || it.contains("192.168.1.20") })

            activity.clickText(OnboardingCopy.COPY)
            val clip = app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString()
            assertEquals(LinkLog.recentText(), clip)
            assertTrue(clip.contains("voice tap: link UP after 1200ms (attempt 1)"))
            assertFalse(clip.contains(secret))
            assertFalse(clip.contains("192.168.1.20"))

            activity.clickText(OnboardingCopy.LINK_LOG_HIDE)
            assertFalse(activity.visibleTexts().any { it.contains("voice tap: link UP") })
        } finally {
            LinkLog.clearRecent()
        }
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
