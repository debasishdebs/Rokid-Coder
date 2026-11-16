package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeCloseReason
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.plugin.agents.AgentProvider
import com.anezium.rokidbus.plugin.agents.AgentdAction
import com.anezium.rokidbus.plugin.agents.AgentdWire
import com.anezium.rokidbus.plugin.agents.AlertCoordinator
import com.anezium.rokidbus.plugin.agents.AlertDirector
import com.anezium.rokidbus.plugin.agents.AlertGlasses
import com.anezium.rokidbus.plugin.agents.AlertKind
import com.anezium.rokidbus.plugin.agents.AlertSound
import com.anezium.rokidbus.plugin.agents.SoundChoice
import com.anezium.rokidbus.plugin.agents.SoundPrefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** TEST_ALERT: a local Done alert, through the director and the coordinator, never through agentd. */
class TestAlertStepTest {
    private val bands = mutableListOf<NexusNotice>()
    private val sounds = mutableListOf<AlertSound>()
    private val written = mutableListOf<String>()
    private var soundPrefs = SoundPrefs(done = SoundChoice.SPEAK)

    private val glasses = object : AlertGlasses {
        override fun showBand(notice: NexusNotice): Boolean = bands.add(notice)
        override fun updateBand(update: NexusNoticeUpdate) = true
        override fun hideBand() = Unit
        override fun brief(title: String, body: String) = Unit
        override fun playSound(sound: AlertSound) {
            sounds += sound
        }
        override fun openOutput(alert: AgentdAction.Alert) = Unit
        override fun openDecision(alert: AgentdAction.Alert) = Unit
        override fun openQuestion(alert: AgentdAction.Alert) = Unit
        override fun invalidate(alertId: String) = Unit
    }

    private val director = AlertDirector(
        coordinator = AlertCoordinator(clock = { 0L }),
        write = { line -> written += line; AgentdWire.Result.Sent },
        secure = { true },
        glasses = { glasses },
        post = { it() },
        soundPrefs = { soundPrefs },
    )

    @Test
    fun test_alert_uses_the_real_alert_path_and_kind_sound() {
        director.raiseLocalTestAlert(AgentProvider.CODEX)
        val band = bands.single()
        assertTrue(listOfNotNull(band.title, band.body).any { "Test alert — Rokid Coder is set up" in it })
        assertTrue("a Done band wakes the glasses", band.wakeDisplay)
        assertEquals("the wearer's sound for Done", listOf<AlertSound>(AlertSound.Speak("Codex is done")), sounds)

        // The wearer's own doing on the band answers nothing: there is no agentd alert behind it.
        director.onBandShown()
        director.onBandClosed(NexusNoticeCloseReason.USER)
        assertEquals(emptyList<String>(), written)

        soundPrefs = SoundPrefs(done = SoundChoice.CHIME)
        director.raiseLocalTestAlert(AgentProvider.CLAUDE)
        assertEquals(AlertSound.Chime, sounds.last())

        val effects = AlertCoordinator(clock = { 0L }).raiseLocalTestAlert(AgentProvider.CLAUDE)
        val show = effects.single() as AlertCoordinator.Effect.Show
        assertEquals(AlertKind.DONE, show.alert.kind)
        assertTrue(show.sound)
        assertEquals(listOf("I saw it", "Send again", "I didn't see it"), OnboardingCopy.TEST_ALERT_ACTIONS)
        assertTrue("Send again" in OnboardingCopy.TEST_ALERT_MISSED)

        // Send again raises the same alert once more, with the sound for Done.
        val before = bands.size
        director.raiseLocalTestAlert(AgentProvider.CLAUDE)
        assertEquals(before + 1, bands.size)
    }
}
