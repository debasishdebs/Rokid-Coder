package com.anezium.rokidbus.plugin.agents

import android.graphics.Color
import com.anezium.rokidbus.client.ui.NexusUi
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The light look of the NexusUi screens: readable on white and on the grey cards, and really installed. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AgentsPaletteTest {
    private val light = AgentsPalette.LIGHT

    @After
    fun back_to_upstreams_dark() = NexusUi.usePalette(NexusUi.DARK)

    @Test
    fun the_app_installs_the_light_palette_before_any_screen() {
        // The Application ran in this Robolectric test's setup.
        assertEquals(light.bg, NexusUi.BG)
        assertEquals(light.green, NexusUi.ACCENT)
        assertEquals(light.ink, NexusUi.TEXT)
        assertEquals(light.ink2, NexusUi.MUTED)
        assertEquals(light.card, NexusUi.WELL)
        assertEquals(light.line, NexusUi.HAIRLINE)
        assertTrue(light.lightSystemBars)
    }

    @Test
    fun upstreams_own_apps_stay_dark_by_default() {
        assertEquals(0xFF070A08.toInt(), NexusUi.DARK.bg)
        assertEquals(0xFF4DFF8C.toInt(), NexusUi.DARK.green)
        assertTrue(!NexusUi.DARK.lightSystemBars)
        NexusUi.usePalette(NexusUi.DARK)
        assertEquals(NexusUi.DARK.bg, NexusUi.BG)
    }

    @Test
    fun text_and_accents_read_on_the_white_page_and_the_grey_cards() {
        val surfaces = mapOf("page" to light.bg, "card" to light.card)
        for ((surface, background) in surfaces) {
            check("ink on $surface", light.ink, background, 7.0)
            check("body grey on $surface", light.ink2, background, 4.5)
            check("meta grey on $surface", light.ink3, background, 3.0)
            check("accent on $surface", light.green, background, 4.5)
            check("amber on $surface", light.amber, background, 4.5)
            check("danger on $surface", light.danger, background, 4.5)
        }
        check("button label on the accent", light.onAccent, light.green, 4.5)
        check("button label on the pressed accent", light.onAccent, light.greenDim, 4.5)
    }

    private fun check(what: String, foreground: Int, background: Int, atLeast: Double) {
        val ratio = contrast(foreground, background)
        assertTrue("$what is %.2f:1, needs %.1f:1".format(ratio, atLeast), ratio >= atLeast)
    }

    /** WCAG 2 contrast ratio. */
    private fun contrast(a: Int, b: Int): Double {
        val (hi, lo) = listOf(luminance(a), luminance(b)).sortedDescending()
        return (hi + 0.05) / (lo + 0.05)
    }

    private fun luminance(color: Int): Double {
        fun channel(value: Int): Double {
            val c = value / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(Color.red(color)) + 0.7152 * channel(Color.green(color)) + 0.0722 * channel(Color.blue(color))
    }
}
