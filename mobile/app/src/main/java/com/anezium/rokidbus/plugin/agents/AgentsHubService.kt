package com.anezium.rokidbus.plugin.agents

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.anezium.rokidbus.phone.HubCore
import com.anezium.rokidbus.phone.HubCoreConfig
import com.anezium.rokidbus.phone.HubForegroundHost
import com.anezium.rokidbus.phone.InProcessApp
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.plugin.PluginCapability

/**
 * Hosts the glasses link and the Agents code in this process: one [HubCore] with Agents as
 * its in-process app, and [AgentsCore] on the core's surface. Not exported; nothing outside
 * this app starts or binds it.
 */
class AgentsHubService : Service(), HubForegroundHost {
    private var core: HubCore? = null
    private var agents: AgentsCore? = null

    override fun onCreate() {
        super.onCreate()
        val identity = AppIdentity(BuildConfig.PHONE_APPLICATION_ID, BuildConfig.GLASSES_APPLICATION_ID)
        val hub = HubCore(this, HubCoreConfig(foreground = this, identity = identity, inProcessApp = AGENTS_APP))
        core = hub
        hub.start()
        agents = AgentsCore(hub.surface(), this).also(AgentsCore::start)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        agents?.close()
        agents = null
        core?.close()
        core = null
        super.onDestroy()
    }

    override fun promote(microphone: Boolean): Throwable? = runCatching {
        AgentNotifications(this).createChannels()
        val notification = NotificationCompat.Builder(this, AgentNotifications.MONITOR_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_agents)
            .setContentTitle(GLASSES_TITLE)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setSilent(true)
            .setShowWhen(false)
            .setOngoing(true)
            .build()
        val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
            (if (microphone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        ServiceCompat.startForeground(this, GLASSES_NOTIFICATION_ID, notification, types)
    }.exceptionOrNull()

    override fun onLinkStateChanged(linkState: Int) = Unit

    companion object {
        /** What the hub knows the Agents app as: the grants and prefixes its plugin manifest declared. */
        val AGENTS_APP = InProcessApp(
            pluginId = "agents",
            displayName = "Agents",
            iconKey = "terminal",
            capabilities = setOf(PluginCapability.SURFACES, PluginCapability.STT, PluginCapability.TTS),
            receivePrefixes = listOf("/plugin/agents", "/system/plugin", "/stt", "/tts/started", "/tts/done"),
        )
        private const val GLASSES_NOTIFICATION_ID = 3102
        private const val GLASSES_TITLE = "Glasses connected"
    }
}
