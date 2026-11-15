package com.anezium.rokidbus.phone.speech

import android.content.Context

internal class AndroidSttSessionFactory(
    context: Context,
    private val foregroundController: AndroidSttForegroundController,
) : SpeechSttSessionFactory {
    private val appContext = context.applicationContext

    override fun create(
        engine: SpeechEngine,
        language: TranscriptionLanguage,
        phoneLanguageTag: String,
        patience: SpeechPatience,
        listener: SttSessionListener,
    ): SttSession {
        require(engine.usesAndroidRecognizer) {
            "AndroidSttSessionFactory cannot create engine ${engine.id}"
        }
        return AndroidSttSession(
            context = appContext,
            language = language,
            patience = patience,
            listener = listener,
            foregroundController = foregroundController,
        )
    }
}

internal class RoutingSttSessionFactory(
    private val registry: SpeechEngineRegistry,
) : SpeechSttSessionFactory {
    override fun create(
        engine: SpeechEngine,
        language: TranscriptionLanguage,
        phoneLanguageTag: String,
        patience: SpeechPatience,
        listener: SttSessionListener,
    ): SttSession {
        val factory = requireNotNull(registry.factoryFor(engine)) {
            "No speech engine registered for ${engine.id}"
        }
        return factory.create(engine, language, phoneLanguageTag, patience, listener)
    }

    override fun close() {
        registry.close()
    }
}
