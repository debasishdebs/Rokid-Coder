package com.anezium.rokidbus.phone

/**
 * The host Service's `startForeground`, for [HubForegroundHost.promote]: the microphone type when
 * asked, and on a refusal, connected-device alone with the failure returned. Both the upstream
 * shell and an app's own service promote through it.
 *
 * It keeps apart the service's microphone entitlement and one speech session's use of it. With
 * [holdMicrophoneUntilStop] false (upstream), a session's release drops the type again. With it
 * true, a start that got the type keeps it until [reset]: a later request needs no new start, and
 * a release never starts the service again without it, so a second session from the background
 * still has the microphone.
 */
class ForegroundPromotion(
    private val holdMicrophoneUntilStop: Boolean,
    private val log: (message: String, failure: Throwable?) -> Unit = { _, _ -> },
) {
    /** True while the last successful start carried the microphone type. */
    @Volatile var microphoneHeld = false
        private set

    /** [start] calls the platform's `startForeground`, with the microphone type when told to. Returns the failure, or null. */
    fun promote(microphone: Boolean, start: (microphone: Boolean) -> Unit): Throwable? {
        if (holdMicrophoneUntilStop && microphoneHeld) return null
        val result = runCatching { start(microphone) }
        if (result.isSuccess) {
            microphoneHeld = microphone
            return null
        }

        val failure = result.exceptionOrNull()
        log(
            "Hub foreground promotion failed microphone=$microphone " +
                "type=${failure?.javaClass?.simpleName.orEmpty()}",
            failure,
        )
        if (microphone) {
            runCatching { start(false) }
                .onSuccess { microphoneHeld = false }
                .onFailure { fallbackFailure ->
                    log(
                        "Connected-device foreground fallback failed " +
                            "type=${fallbackFailure.javaClass.simpleName}",
                        fallbackFailure,
                    )
                }
        }
        return failure ?: IllegalStateException("ForegroundServiceException")
    }

    /** The service stopped being foreground: the entitlement goes with it. */
    fun reset() {
        microphoneHeld = false
    }
}
