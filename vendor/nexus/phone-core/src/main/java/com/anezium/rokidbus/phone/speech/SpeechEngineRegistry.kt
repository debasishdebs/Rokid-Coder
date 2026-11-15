package com.anezium.rokidbus.phone.speech

/**
 * The speech engines this hub can run. The core registers only the Android recognizer; any other
 * engine exists only if a shell registers it before the hub starts, so an app that never does
 * carries no cloud speech code at all.
 */
class SpeechEngineRegistry internal constructor() {
    private class Entry(
        val factory: SpeechSttSessionFactory,
        val readiness: () -> SpeechReadiness,
    )

    private val lock = Any()
    private val entries = linkedMapOf<SpeechEngine, Entry>()
    private var sealed = false

    /** Before HubCore.start() only; a later call throws IllegalStateException. */
    fun register(
        engine: SpeechEngine,
        factory: SpeechSttSessionFactory,
        readiness: () -> SpeechReadiness,
    ) {
        synchronized(lock) {
            check(!sealed) { "Speech engines must be registered before the hub starts" }
            entries[engine] = Entry(factory, readiness)
        }
    }

    fun engines(): List<SpeechEngine> = synchronized(lock) { entries.keys.toList() }

    fun isRegistered(engine: SpeechEngine): Boolean = synchronized(lock) { engine in entries }

    internal fun seal() {
        synchronized(lock) { sealed = true }
    }

    internal fun factoryFor(engine: SpeechEngine): SpeechSttSessionFactory? =
        synchronized(lock) { entries[engine]?.factory }

    internal fun readiness(engine: SpeechEngine): SpeechReadiness? =
        synchronized(lock) { entries[engine]?.readiness }?.invoke()

    internal fun close() {
        val factories = synchronized(lock) { entries.values.map(Entry::factory).distinct() }
        factories.forEach { factory -> runCatching { factory.close() } }
    }
}
