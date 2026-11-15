package com.anezium.rokidbus.plugin.agents.connectors

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.anezium.rokidbus.client.ui.BusTheme
import com.anezium.rokidbus.client.ui.NexusUi
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import kotlinx.coroutines.launch

/** Settings → Connectors: Tailscale, its status and the two steps that set it up. */
class ConnectorsActivity : ComponentActivity() {
    private lateinit var status: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = NexusUi.BG
        window.navigationBarColor = NexusUi.BG
        status = NexusUi.statusLine(this)
        val content = NexusUi.contentColumn(this).apply {
            addView(NexusUi.sectionLabel(this@ConnectorsActivity, "Connectors"), NexusUi.block())
            addView(BusTheme.gap(this@ConnectorsActivity, 10))
            addView(tailscaleCard(this@ConnectorsActivity, status), NexusUi.block())
        }
        val root = NexusUi.fixedRoot(this).apply {
            addView(NexusUi.backButton(this@ConnectorsActivity) { finish() }, NexusUi.block())
            addView(NexusUi.screen(this@ConnectorsActivity, content), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        }
        setContentView(root)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                AgentsRuntime.activeSecureLinks.collect { render() }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        render()
    }

    private fun render() {
        status.text = tailscaleStatus(TailscaleConnector.installed(this), AgentsRuntime.activeSecureLinks.value).text
    }

    companion object {
        /** The Tailscale card, here and in onboarding's pairing fallback; [status] is kept up to date by the host. */
        fun tailscaleCard(activity: Activity, status: TextView): LinearLayout = NexusUi.card(activity).apply {
            addView(NexusUi.rowTitle(activity, TailscaleConnector.TITLE), NexusUi.block())
            addView(NexusUi.cardBody(activity, TailscaleConnector.INTRO), NexusUi.block())
            addView(BusTheme.gap(activity, 8))
            addView(status, NexusUi.block())
            addView(BusTheme.gap(activity, 8))
            addView(
                NexusUi.pillButton(activity, "1 · ${TailscaleConnector.STEPS[0]}").apply {
                    setOnClickListener { TailscaleConnector.openStore(activity) }
                },
                NexusUi.block(),
            )
            addView(BusTheme.gap(activity, 6))
            addView(NexusUi.cardBody(activity, "2 · ${TailscaleConnector.STEPS[1]}"), NexusUi.block())
        }
    }
}
