package com.anezium.rokidbus.phone.speech

import okhttp3.OkHttpClient
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class CloudSttSessionFactory(
    private val secrets: HubSecretStore,
    private val timeoutScheduler: ExecutorSttTimeoutScheduler = ExecutorSttTimeoutScheduler(),
    private val networkExecutor: java.util.concurrent.ExecutorService =
        Executors.newSingleThreadExecutor(),
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
) : SpeechSttSessionFactory {
    override fun create(
        engine: SpeechEngine,
        language: TranscriptionLanguage,
        phoneLanguageTag: String,
        patience: SpeechPatience,
        listener: SttSessionListener,
    ): SttSession =
        PostCommitTimeoutSttSession(
            delegateFactory = { timedListener ->
                if (engine.usesRealtime) {
                    ApiRealtimeSpeechToText.create(
                        client = httpClient,
                        secrets = secrets,
                        engine = engine,
                        listener = timedListener,
                        forcedLanguage = language,
                        phoneLanguageTag = phoneLanguageTag,
                    )
                } else {
                    BufferedSttSession(
                        engine = engine,
                        language = language,
                        languageTag = phoneLanguageTag,
                        transcriber = ApiCompletedAudioSpeechToTextEngine(secrets, engine),
                        executor = networkExecutor,
                        listener = timedListener,
                    )
                }
            },
            listener = listener,
            providerLabel = engine.provider.displayName,
            timeoutScheduler = timeoutScheduler,
        )

    override fun close() {
        timeoutScheduler.close()
        networkExecutor.shutdownNow()
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()
    }
}
