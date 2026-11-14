package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.shared.LinkStateBits
import org.json.JSONObject

/** The phone's Do Not Disturb, as far as the plugin can read it. */
enum class DndState { OFF, ON, UNKNOWN }

/** The one sound an alert makes: a generic spoken line, the Done chime, or nothing. */
sealed interface AlertSound {
    data class Speak(val text: String) : AlertSound
    data object Chime : AlertSound
    data object None : AlertSound
}

/**
 * When an alert is heard, and what it sounds like. The spoken cue is only a nudge to
 * look at the glasses, so it is generic: it names the tool and the kind of
 * alert and never a session heading or any agent text. Pure, so every
 * reason to stay silent is tested without a phone.
 */
object AlertSoundPolicy {
    /**
     * Speaks only when the phone is not in Do Not Disturb (an unreadable state
     * counts as quiet, design §6.2), the wearer has not asked for quiet, the
     * glasses are not muted and are not known to be off the head. A volume or
     * worn state the glasses never reported is unknown, not a reason for silence.
     */
    fun shouldSpeak(dnd: DndState, quiet: Boolean, glassesVolume: Int?, worn: Boolean?): Boolean =
        dnd == DndState.OFF && !quiet && glassesVolume != 0 && worn != false

    /**
     * What an alert of [kind] from [provider] sounds like, as the wearer set it in
     * [prefs] (U19). A new alert follows its kind's setting and a reminder follows
     * the reminder setting; a frame that only retries, resumes or refreshes an
     * alert is never heard again. A notice has no sound.
     */
    fun sound(kind: AlertKind, provider: AgentProvider, reason: AlertReason, prefs: SoundPrefs = SoundPrefs()): AlertSound {
        if (kind == AlertKind.NOTICE) return AlertSound.None
        val slot = when (reason) {
            AlertReason.NEW -> when (kind) {
                AlertKind.APPROVAL -> SoundSlot.APPROVAL
                AlertKind.QUESTION -> SoundSlot.QUESTION
                AlertKind.ERROR -> SoundSlot.ERROR
                AlertKind.DONE -> SoundSlot.DONE
                AlertKind.NOTICE -> return AlertSound.None
            }
            AlertReason.REMINDER -> SoundSlot.REMINDER
            AlertReason.RETRY, AlertReason.RESUME, AlertReason.UPDATE -> return AlertSound.None
        }
        return when (prefs[slot]) {
            SoundChoice.SILENT -> AlertSound.None
            SoundChoice.CHIME -> AlertSound.Chime
            SoundChoice.SPEAK -> AlertSound.Speak("${toolName(provider)} ${phrase(slot)}")
        }
    }

    private fun toolName(provider: AgentProvider): String = when (provider) {
        AgentProvider.CLAUDE -> "Claude"
        AgentProvider.CODEX -> "Codex"
        AgentProvider.OPENCLAW -> "OpenClaw"
    }

    /** What follows the tool's name in the spoken line; the settings screen shows the same words. */
    fun phrase(slot: SoundSlot): String = when (slot) {
        SoundSlot.APPROVAL -> "needs approval"
        SoundSlot.QUESTION -> "has a question"
        SoundSlot.ERROR -> "hit an error"
        SoundSlot.DONE -> "is done"
        SoundSlot.REMINDER -> "is still waiting"
    }

    /** [sound] if the phone, the wearer and the glasses allow a sound right now (the [shouldSpeak] gates), else nothing. */
    fun allowed(sound: AlertSound, dnd: DndState, quiet: Boolean, glassesVolume: Int?, worn: Boolean?): AlertSound =
        if (sound != AlertSound.None && shouldSpeak(dnd, quiet, glassesVolume, worn)) sound else AlertSound.None

    /**
     * The hub reports the worn bit false both before it has heard anything and
     * after the glasses come off, so a clear bit only means "off the head" once
     * it has been seen set.
     */
    fun wornAfter(previous: Boolean?, linkState: Int): Boolean? = when {
        linkState and LinkStateBits.GLASSES_WORN != 0 -> true
        previous == null -> null
        else -> false
    }

    /** The glasses' volume from a `/glasses/device-info` payload, or null when it carries none. */
    fun volumeFrom(payload: JSONObject): Int? =
        if (payload.has("sound") && !payload.isNull("sound")) {
            payload.optInt("sound", -1).takeIf { it >= 0 }
        } else {
            null
        }
}
