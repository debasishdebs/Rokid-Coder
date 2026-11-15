package com.anezium.rokidbus.plugin.agents.service

import com.anezium.rokidbus.client.plugin.NexusSpeechError

/** Whether push-to-talk can open the microphone now, and if not, what the wearer does about it. */
enum class VoiceAvailability {
    /** The service holds the microphone type. */
    AVAILABLE,

    /** Started without it (from boot, or a promotion Android refused): opening the app once promotes it. */
    NEEDS_APP_OPEN,

    /** RECORD_AUDIO is not granted. */
    PERMISSION_DENIED,
    ;

    /** The pointer the notification shows, or null when voice works. */
    val notificationLine: String?
        get() = when (this) {
            AVAILABLE -> null
            NEEDS_APP_OPEN -> OPEN_APP
            PERMISSION_DENIED -> "Microphone is off — tap to grant"
        }

    /** The glasses' brief when push-to-talk finds voice off, or null when it is on. */
    val glassesLine: String?
        get() = when (this) {
            AVAILABLE -> null
            NEEDS_APP_OPEN -> OPEN_APP
            PERMISSION_DENIED -> "Microphone is off — grant it in Rokid Coder on the phone"
        }

    companion object {
        const val OPEN_APP = "Open Rokid Coder once to turn on voice"
        const val GLASSES_TITLE = "Voice is off"

        internal const val REASON_KEY = "voice-unavailable="

        /**
         * The reason a speech session ended because the microphone was refused, or null. HubCore
         * words the refusal [VoiceUnavailableException] into the recognizer's error detail, and
         * the session ends as a link loss; this is how the speech result still says why.
         */
        fun of(error: NexusSpeechError?): VoiceAvailability? {
            val detail = error?.detail ?: return null
            val name = Regex(Regex.escape(REASON_KEY) + "([A-Z_]+)").find(detail)?.groupValues?.get(1) ?: return null
            return entries.firstOrNull { it.name == name && it != AVAILABLE }
        }
    }
}

/** [CoderService.promote]'s microphone refusal, carrying why voice is off to the speech result. */
class VoiceUnavailableException(
    val availability: VoiceAvailability,
    cause: Throwable? = null,
) : SecurityException(VoiceAvailability.REASON_KEY + availability.name, cause)
