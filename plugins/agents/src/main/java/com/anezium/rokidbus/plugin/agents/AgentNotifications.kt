package com.anezium.rokidbus.plugin.agents

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat

/**
 * The one notification this plugin builds: the visible, low-importance
 * "Agents monitoring · n sessions" the monitoring foreground service stands on,
 * with Settings and Stop. It is a documented exception to plugins/AGENTS.md
 * §3.5 (R32): Android freezes a service whose notification is never shown on
 * some phones. It is never an alert. Everything an agent needs from the wearer
 * still reaches them on the glasses, and nothing is ever posted for a session.
 */
class AgentNotifications(private val context: Context) {
    fun createChannels() {
        val manager = context.getSystemService(NotificationManager::class.java)
        // The first release made this channel IMPORTANCE_MIN, and Android never raises a
        // channel's importance after it exists, so the visible one has an id of its own.
        manager.deleteNotificationChannel(LEGACY_MONITOR_CHANNEL_ID)
        manager.createNotificationChannel(
            NotificationChannel(
                MONITOR_CHANNEL_ID,
                "Agent monitor",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                enableLights(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
            },
        )
    }

    fun monitorNotification(sessionCount: Int): android.app.Notification =
        NotificationCompat.Builder(context, MONITOR_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agents)
            .setContentTitle(monitorTitle(sessionCount))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(true)
            .setContentIntent(settingsPendingIntent())
            .addAction(0, ACTION_SETTINGS, settingsPendingIntent())
            .addAction(0, ACTION_STOP, stopPendingIntent())
            .build()

    /** Posts the notification again with a new count; a no-op for Android when the app may not post. */
    fun updateMonitor(sessionCount: Int) {
        context.getSystemService(NotificationManager::class.java)
            .notify(MONITOR_NOTIFICATION_ID, monitorNotification(sessionCount))
    }

    private fun settingsPendingIntent(): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, AgentsSettingsActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Stop turns the Monitoring switch off and stops the service; it never opens the app. */
    private fun stopPendingIntent(): PendingIntent = PendingIntent.getService(
        context,
        1,
        Intent(context, AgentsMonitorService::class.java).setAction(AgentsMonitorService.ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        const val MONITOR_CHANNEL_ID = "nexus_agent_monitor_visible"
        private const val LEGACY_MONITOR_CHANNEL_ID = "nexus_agent_monitor"
        const val MONITOR_NOTIFICATION_ID = 3101
        const val ACTION_SETTINGS = "Settings"
        const val ACTION_STOP = "Stop"

        /** `Agents monitoring · 3 sessions`. */
        fun monitorTitle(sessionCount: Int): String =
            "Agents monitoring · $sessionCount ${if (sessionCount == 1) "session" else "sessions"}"
    }
}
