package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.shared.LinkStateBits
import org.json.JSONObject

/** The phone's Do Not Disturb, as far as the plugin can read it. */
enum class DndState { OFF, ON, UNKNOWN }

/**
 * When an alert is spoken, and what is said. The spoken cue is only a nudge to
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

    /** The line spoken for an alert of [kind] from [provider], or null for a kind that never speaks. */
    fun cue(kind: AlertKind, provider: AgentProvider): String? {
        val name = when (provider) {
            AgentProvider.CLAUDE -> "Claude"
            AgentProvider.CODEX -> "Codex"
            AgentProvider.OPENCLAW -> "OpenClaw"
        }
        return when (kind) {
            AlertKind.APPROVAL -> "$name needs approval"
            AlertKind.QUESTION -> "$name has a question"
            AlertKind.DONE -> "$name is done"
            AlertKind.ERROR -> "$name hit an error"
            AlertKind.NOTICE -> null
        }
    }

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
