package com.anezium.rokidbus.plugin.agents.about

import android.content.Intent
import com.anezium.rokidbus.plugin.agents.BuildConfig
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
        for (line in listOf(
            "Rokid Coder runs no servers and collects nothing.",
            "Data leaves your devices only through services you already use:",
            "The Claude/Anthropic and Codex/OpenAI command-line tools you run on your computer.",
            "Your Android speech engine, which may be online.",
            "Tailscale, if you choose it.",
            "The 1.0 app has no cloud speech engines and no analytics.",
        )) {
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
