package com.anezium.rokidbus.plugin.agents.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.anezium.rokidbus.plugin.agents.AgentsSettingsActivity
import com.anezium.rokidbus.plugin.agents.MainActivity
import com.anezium.rokidbus.plugin.agents.R
import com.anezium.rokidbus.shared.LinkStateBits

/**
 * The one notification the app builds: the visible, low-importance one [CoderService] stands on,
 * with the glasses link, the session count, a voice pointer when voice is off, Settings and Stop.
 * It is a documented exception to plugins/AGENTS.md §3.5 (R32): Android freezes a service whose
 * notification is never shown on some phones. It is never an alert, and nothing is ever posted
 * for a session; everything an agent needs from the wearer reaches them on the glasses.
 */
class CoderNotifications(private val context: Context) {
    data class Status(val linkState: Int, val sessionCount: Int, val voice: VoiceAvailability)

    fun createChannel() {
        val manager = context.getSystemService(NotificationManager::class.java)
        // Folds in the Agents monitoring channels: one channel for the one notification.
        LEGACY_CHANNEL_IDS.forEach(manager::deleteNotificationChannel)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Rokid Coder", NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                setSound(null, null)
                enableVibration(false)
                enableLights(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            },
        )
    }

    fun build(status: Status): Notification {
        val link = linkLine(status.linkState)
        val pointer = status.voice.notificationLine
        return NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agents)
            .setContentTitle(title(status.sessionCount))
            .setContentText(pointer ?: link)
            .setStyle(NotificationCompat.BigTextStyle().bigText(listOfNotNull(link, pointer).joinToString("\n")))
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(true)
            .setContentIntent(openApp())
            .addAction(0, ACTION_SETTINGS, settings())
            .addAction(0, ACTION_STOP, stop())
            .build()
    }

    /** Posts the notification again; a no-op for Android when the app may not post. */
    fun update(status: Status) {
        context.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(status))
    }

    /**
     * The app as its launcher opens it, never a service or receiver trampoline: the opened
     * activity brings the process to the foreground, and that promotes the service.
     */
    private fun openApp(): PendingIntent {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
            ?: Intent(context, MainActivity::class.java)
        return PendingIntent.getActivity(
            context,
            REQUEST_OPEN,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun settings(): PendingIntent = PendingIntent.getActivity(
        context,
        REQUEST_SETTINGS,
        Intent(context, AgentsSettingsActivity::class.java),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** Stop ends everything until the app is opened again; it never opens the app. */
    private fun stop(): PendingIntent = PendingIntent.getService(
        context,
        REQUEST_STOP,
        Intent(context, CoderService::class.java).setAction(CoderService.ACTION_STOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        const val CHANNEL_ID = "rokid_coder_service"
        private val LEGACY_CHANNEL_IDS = listOf("nexus_agent_monitor", "nexus_agent_monitor_visible")
        const val NOTIFICATION_ID = 3101
        const val ACTION_SETTINGS = "Settings"
        const val ACTION_STOP = "Stop"
        private const val REQUEST_OPEN = 0
        private const val REQUEST_SETTINGS = 1
        private const val REQUEST_STOP = 2

        /** `Rokid Coder · 3 sessions`. */
        fun title(sessionCount: Int): String =
            "Rokid Coder · $sessionCount ${if (sessionCount == 1) "session" else "sessions"}"

        fun linkLine(linkState: Int): String = when {
            linkState and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0 -> "Glasses connected"
            linkState and LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED != 0 -> "Waiting for glasses"
            else -> "Glasses not connected"
        }
    }
}
