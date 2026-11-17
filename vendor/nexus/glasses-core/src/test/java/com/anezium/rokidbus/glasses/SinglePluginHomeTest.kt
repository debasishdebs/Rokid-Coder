package com.anezium.rokidbus.glasses

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SinglePluginHomeTest {
    private val agents = GlassesHub.LauncherEntry("agents", "Rokid Coder")
    private val camera = GlassesHub.LauncherEntry("camera", "Camera")
    private val notes = GlassesHub.LauncherEntry("notes", "Notes")

    private fun home(enabled: Boolean = true) = SinglePluginHome(enabled) { it != "camera" }

    @Test
    fun opensTheOnlyPluginSurface() {
        assertEquals(agents, home().entryToOpen(listOf(agents)))
    }

    @Test
    fun theCameraEntryIsNotAPluginSurface() {
        assertEquals(agents, home().entryToOpen(listOf(camera, agents)))
    }

    @Test
    fun keepsTheListForUpstreamAndForSeveralPlugins() {
        assertNull(home(enabled = false).entryToOpen(listOf(agents)))
        assertNull(home().entryToOpen(listOf(agents, notes)))
        assertNull(home().entryToOpen(emptyList()))
        assertNull(home().entryToOpen(listOf(camera)))
    }

    @Test
    fun opensOnceUntilTheLauncherIsBroughtForwardAgain() {
        val home = home()
        home.opened(agents)
        assertNull(home.entryToOpen(listOf(agents)))
        home.reset()
        assertEquals(agents, home.entryToOpen(listOf(agents)))
    }

    @Test
    fun leavesWhenTheOpenedSurfaceCloses() {
        val home = home()
        home.opened(agents)
        assertFalse(home.onSurface(false))
        assertFalse(home.onSurface(true))
        assertTrue(home.onSurface(false))
        assertTrue(home.leaving)
        assertNull(home.entryToOpen(listOf(agents)))
    }

    @Test
    fun aSurfaceClosingBeforeTheOpenIsNotTheOnesClose() {
        val home = home()
        assertFalse(home.onSurface(false))
        home.opened(agents)
        assertFalse(home.onSurface(false))
        assertFalse(home.leaving)
    }
}
