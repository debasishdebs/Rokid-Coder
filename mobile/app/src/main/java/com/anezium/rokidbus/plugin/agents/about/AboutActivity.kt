package com.anezium.rokidbus.plugin.agents.about

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import com.anezium.rokidbus.client.ui.BusTheme
import com.anezium.rokidbus.client.ui.NexusUi
import com.anezium.rokidbus.plugin.agents.AgentsPalette
import com.anezium.rokidbus.plugin.agents.BuildConfig
import com.anezium.rokidbus.plugin.agents.R

/** Settings → About: the version and the privacy note (R11). The text is `strings_about.xml`, the same words as PRIVACY.md. */
class AboutActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AgentsPalette.styleWindow(window)
        val content = NexusUi.contentColumn(this).apply {
            addView(NexusUi.sectionLabel(this@AboutActivity, getString(R.string.about_title)), NexusUi.block())
            addView(BusTheme.gap(this@AboutActivity, 10))
            addView(NexusUi.cardBody(this@AboutActivity, getString(R.string.about_intro)), NexusUi.block())
            addView(NexusUi.metaLabel(this@AboutActivity, "v${BuildConfig.VERSION_NAME}"), NexusUi.block())
            addView(BusTheme.gap(this@AboutActivity, 18))
            addView(NexusUi.sectionLabel(this@AboutActivity, getString(R.string.about_privacy_heading)), NexusUi.block())
            addView(BusTheme.gap(this@AboutActivity, 10))
            addView(privacyCard(), NexusUi.block())
            addView(BusTheme.gap(this@AboutActivity, 12))
            addView(
                NexusUi.pillButton(this@AboutActivity, getString(R.string.about_privacy_link)).apply {
                    setOnClickListener { openPrivacyNote() }
                },
                NexusUi.block(),
            )
        }
        val root = NexusUi.fixedRoot(this).apply {
            addView(NexusUi.backButton(this@AboutActivity) { finish() }, NexusUi.block())
            addView(NexusUi.screen(this@AboutActivity, content), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
    }

    private fun privacyCard(): LinearLayout = NexusUi.card(this).apply {
        addView(NexusUi.rowTitle(this@AboutActivity, getString(R.string.about_privacy_summary)), NexusUi.block())
        addView(BusTheme.gap(this@AboutActivity, 8))
        addView(NexusUi.cardBody(this@AboutActivity, getString(R.string.about_privacy_paths_intro)), NexusUi.block())
        for (path in listOf(R.string.about_privacy_path_cli, R.string.about_privacy_path_speech, R.string.about_privacy_path_tailscale)) {
            addView(BusTheme.gap(this@AboutActivity, 6))
            addView(NexusUi.cardBody(this@AboutActivity, getString(path)), NexusUi.block())
        }
        addView(BusTheme.gap(this@AboutActivity, 8))
        addView(NexusUi.cardBody(this@AboutActivity, getString(R.string.about_privacy_no_extras)), NexusUi.block())
    }

    private fun openPrivacyNote() {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(PRIVACY_URL)))
        } catch (_: ActivityNotFoundException) {
            // A phone with no browser has nothing to open; the text above is the note in short.
        }
    }

    companion object {
        /** The full note on the release branch; `main` is still the upstream base. */
        const val PRIVACY_URL = "https://github.com/debasishdebs/Rokid-Coder/blob/release/1.0.0/PRIVACY.md"
    }
}
