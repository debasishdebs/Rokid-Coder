package com.anezium.rokidbus.plugin.agents.service

import android.content.Context

/**
 * What decides a start at boot. Written with `commit()`: a Stop or a first start must survive the
 * process dying right after it.
 */
class ServicePrefs(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** The notification's Stop, until the app is opened again. */
    val stoppedByUser: Boolean get() = prefs.getBoolean(KEY_STOPPED_BY_USER, false)

    /** Some visible screen of ours started the service once; before that, boot starts nothing. */
    val everStartedFromForeground: Boolean get() = prefs.getBoolean(KEY_EVER_STARTED, false)

    fun recordForegroundStart(): Boolean =
        prefs.edit().putBoolean(KEY_EVER_STARTED, true).putBoolean(KEY_STOPPED_BY_USER, false).commit()

    fun recordStop(): Boolean = prefs.edit().putBoolean(KEY_STOPPED_BY_USER, true).commit()

    private companion object {
        const val PREFS = "coder_service"
        const val KEY_STOPPED_BY_USER = "stopped_by_user"
        const val KEY_EVER_STARTED = "ever_started_from_foreground"
    }
}
