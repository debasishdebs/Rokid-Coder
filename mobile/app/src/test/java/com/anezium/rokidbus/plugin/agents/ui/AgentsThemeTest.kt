package com.anezium.rokidbus.plugin.agents.ui

import com.anezium.rokidbus.plugin.agents.ui.theme.AgentsColors
import org.junit.Assert.assertEquals
import org.junit.Test

class AgentsThemeTest {
    @Test
    fun agents_theme_uses_pca_palette() {
        assertEquals(0xFF14C3A2L, AgentsColors.MINT_ARGB)
        assertEquals(0xFF0E9F86L, AgentsColors.MINT_DEEP_ARGB)
        assertEquals(0xFF3D8BFFL, AgentsColors.SKY_ARGB)
        assertEquals(0xFF15181DL, AgentsColors.INK_ARGB)
        assertEquals(0xFF6B7280L, AgentsColors.INK_SOFT_ARGB)
        assertEquals(0xFFECEFF3L, AgentsColors.LINE_ARGB)
        assertEquals(0xFFF6F8FAL, AgentsColors.SURFACE_SOFT_ARGB)
    }
}
