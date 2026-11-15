package com.anezium.rokidbus.phone.speech

/** Whether a cloud engine has what it needs: its API key and, for Azure, a region. */
internal object CloudSpeechReadiness {
    fun readiness(engine: SpeechEngine, secrets: HubSecretStore): SpeechReadiness {
        if (!secrets.hasCredential(engine)) return SpeechReadiness.MISSING_KEY
        if (engine.provider == SpeechProvider.AZURE && secrets.azureRegion().isNullOrBlank()) {
            return SpeechReadiness.MISSING_REGION
        }
        return SpeechReadiness.READY
    }

    /** The settings screens' view of the selected engine, before any hub is running. */
    fun forSettings(settings: SpeechSettingsStore, secrets: HubSecretStore): SpeechReadiness {
        val engine = settings.selectedEngine() ?: return SpeechReadiness.NO_ENGINE
        if (engine.usesAndroidRecognizer && !settings.isRecordAudioPermissionGranted()) {
            return SpeechReadiness.MISSING_MIC_PERMISSION
        }
        return readiness(engine, secrets)
    }
}
