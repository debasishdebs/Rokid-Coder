package com.anezium.rokidbus.plugin.agents.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Boot and app update: starts the service again, connected-device only, if the wearer left it running. */
class CoderBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val prefs = ServicePrefs(context)
        if (!CoderBootPolicy.shouldStart(intent.action, prefs.everStartedFromForeground, prefs.stoppedByUser)) return
        runCatching { CoderService.startFromBoot(context.applicationContext) }
            .onFailure { Log.w(TAG, "Boot start refused action=${intent.action} type=${it.javaClass.simpleName}") }
    }

    private companion object {
        const val TAG = "CoderBoot"
    }
}

/** The boot gate as a pure function, as upstream's HubStartupPolicy is. */
object CoderBootPolicy {
    private val ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)

    fun shouldStart(action: String?, everStartedFromForeground: Boolean, stoppedByUser: Boolean): Boolean =
        action in ACTIONS && everStartedFromForeground && !stoppedByUser
}
