package com.anezium.rokidbus.plugin.agents.about

import android.content.Intent
import com.anezium.rokidbus.plugin.agents.BuildConfig
import com.anezium.rokidbus.plugin.agents.R
import com.anezium.rokidbus.plugin.agents.onboarding.clickText
import com.anezium.rokidbus.plugin.agents.onboarding.visibleTexts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Settings → About: the version, the privacy text, and the link to the full note. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AboutScreenTest {
    @Test
    fun about_screen_links_privacy_note() {
        val activity = Robolectric.buildActivity(AboutActivity::class.java).setup().get()
        val texts = activity.visibleTexts()

        assertTrue("the version is shown: $texts", texts.any { BuildConfig.VERSION_NAME in it })
        // The sentences themselves are held to PRIVACY.md by PrivacyTextTest; here, that each is shown.
        for (line in listOf(
            R.string.about_privacy_summary,
            R.string.about_privacy_paths_intro,
            R.string.about_privacy_path_cli,
            R.string.about_privacy_path_speech,
            R.string.about_privacy_path_tailscale,
            R.string.about_privacy_no_extras,
        ).map(activity::getString)) {
            assertTrue("\"$line\" is shown: $texts", line in texts)
        }

        assertEquals(
            "https://github.com/debasishdebs/Rokid-Coder/blob/release/1.0.0/PRIVACY.md",
            AboutActivity.PRIVACY_URL,
        )
        activity.clickText("Read the full privacy note")
        val opened: Intent? = shadowOf(activity).nextStartedActivity
        assertNotNull("the link opens something", opened)
        assertEquals(Intent.ACTION_VIEW, opened!!.action)
        assertEquals(AboutActivity.PRIVACY_URL, opened.data.toString())
    }
}
