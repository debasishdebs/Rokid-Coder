package com.anezium.rokidbus.plugin.agents

import android.view.Window
import androidx.core.view.WindowCompat
import com.anezium.rokidbus.client.ui.NexusUi

/**
 * The phone app's light look: the PCA and Live Fit palette (white surfaces, soft grey cards, mint
 * accent) on the screens built with [NexusUi]; the Compose screens take the same colors from
 * AgentsTheme. [NexusUi] stays dark for upstream's own apps, so this is installed once, by the
 * Application, before the first view is built.
 */
object AgentsPalette {
    /**
     * The mint is PCA's, deepened: PCA's own 14C3A2 is about 2:1 on white, too faint for the text
     * and button labels NexusUi sets in its accent. Ink, body grey and the accent keep at least
     * 4.5:1 on both the white page and the grey cards (AgentsPaletteTest).
     */
    val LIGHT = NexusUi.Palette(
        bg = 0xFFFFFFFF.toInt(),
        panel = 0xFFF6F8FA.toInt(),
        card = 0xFFF6F8FA.toInt(),
        line = 0xFFECEFF3.toInt(),
        line2 = 0xFFE3E8EE.toInt(),
        ink = 0xFF15181D.toInt(),
        ink2 = 0xFF5B6472.toInt(),
        ink3 = 0xFF7C8594.toInt(),
        ink4 = 0xFFAEB6C1.toInt(),
        green = 0xFF0A7C69.toInt(),
        greenDim = 0xFF075E50.toInt(),
        amber = 0xFF9A5C00.toInt(),
        onAccent = 0xFFFFFFFF.toInt(),
        danger = 0xFFC93A22.toInt(),
        lightSystemBars = true,
    )

    fun apply() = NexusUi.usePalette(LIGHT)

    /** An activity's bars in the palette's background, with the icons dark when that is light. */
    fun styleWindow(window: Window) {
        window.statusBarColor = NexusUi.BG
        window.navigationBarColor = NexusUi.BG
        // WindowCompat installs the decor view first: the window has no insets controller before that.
        val bars = WindowCompat.getInsetsController(window, window.decorView)
        bars.isAppearanceLightStatusBars = NexusUi.palette.lightSystemBars
        bars.isAppearanceLightNavigationBars = NexusUi.palette.lightSystemBars
    }
}
