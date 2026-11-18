package com.anezium.rokidbus.plugin.agents.service

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.util.Log
import androidx.annotation.VisibleForTesting
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.anezium.rokidbus.phone.ForegroundPromotion
import com.anezium.rokidbus.phone.HubForegroundHost
import com.anezium.rokidbus.plugin.agents.AgentsConfigStore
import com.anezium.rokidbus.plugin.agents.AgentsCore
import com.anezium.rokidbus.plugin.agents.AgentsRuntime
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * The app's only service: the glasses link ([CoderCore], with the Agents core on its surface) and
 * the agentd links ([AgentdLinks]), in one foreground service. Not exported; the rest of the app
 * reaches it through [CoderRuntime].
 *
 * It holds the microphone type only where Android allows it (R9′). A start from a visible screen
 * asks for it when RECORD_AUDIO is granted; a boot or sticky restart never does. Once held, the
 * type stays until Stop or the service ends: a speech session's release never drops it, so voice
 * keeps working from the background. Where it is missing, [voice] says why, and push-to-talk
 * puts that pointer on the glasses instead of failing silently.
 */
class CoderService : Service(), HubForegroundHost {
    private val prefs by lazy { ServicePrefs(this) }
    private val notifications by lazy { CoderNotifications(this) }
    private val starter by lazy { starterFactory?.invoke(this) ?: ForegroundStarter.of(this) }
    private val promotion = ForegroundPromotion(holdMicrophoneUntilStop = true) { message, _ -> Log.w(TAG, message) }
    private val mainScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private var core: CoderCore? = null
    private var agents: AgentsCore? = null
    private var links: AgentdLinks? = null
    // Read on the Binder thread CXR reports link changes on; the healer hops to the main thread itself.
    @Volatile private var healer: GlassesLinkHealer? = null
    private var monitoringWatch: AutoCloseable? = null
    private var sessionsWatch: Job? = null

    /** Whether some startForeground of this instance succeeded since it last stopped. */
    private var foreground = false
    @Volatile private var linkState = 0
    private var sessionCount = 0

    override fun onCreate() {
        super.onCreate()
        notifications.createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopByUser()
            return START_NOT_STICKY
        }
        // A sticky restart carries no intent and is treated as boot: never the microphone.
        if (intent == null && prefs.stoppedByUser) {
            stopSelf()
            return START_NOT_STICKY
        }
        val fromForeground = intent?.action == ACTION_FOREGROUND_START
        promoteService(microphone = fromForeground && microphoneGranted())
        if (!foreground) {
            // Android would end the process for a start that never went foreground.
            stopSelf()
            return START_NOT_STICKY
        }
        startRuntime()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        shutdown()
        mainScope.cancel()
        super.onDestroy()
    }

    /**
     * The core's speech asking for the microphone (true) or releasing it (false). A held type
     * answers both at once with no new start; a refusal sets the pointer and shows it on the glasses.
     * Without a held type, only a visible app may ask Android for it: from the background the
     * answer is the open-app pointer, never a start Android is left to refuse.
     */
    override fun promote(microphone: Boolean): Throwable? {
        if (microphone && !promotion.microphoneHeld) {
            val refusal = when {
                !microphoneGranted() -> VoiceAvailability.PERMISSION_DENIED
                !processStarted() -> VoiceAvailability.NEEDS_APP_OPEN
                else -> null
            }
            if (refusal != null) {
                refreshVoice()
                pointVoiceOnGlasses()
                return VoiceUnavailableException(refusal)
            }
        }
        val failure = promoteService(microphone) ?: return null
        if (!microphone) return failure
        pointVoiceOnGlasses()
        val reason = _voice.value.takeIf { it != VoiceAvailability.AVAILABLE } ?: VoiceAvailability.NEEDS_APP_OPEN
        return VoiceUnavailableException(reason, failure)
    }

    override fun onLinkStateChanged(linkState: Int) {
        this.linkState = linkState
        CoderRuntime.publishLinkState(linkState)
        healer?.onLinkState(linkState)
        updateNotification()
    }

    private fun promoteService(microphone: Boolean): Throwable? {
        val failure = promotion.promote(microphone) { withMicrophone ->
            val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE or
                (if (withMicrophone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
            val voiceAfter = if (withMicrophone) VoiceAvailability.AVAILABLE else voiceWithoutMicrophone()
            starter.start(CoderNotifications.NOTIFICATION_ID, notifications.build(status(voiceAfter)), types)
            foreground = true
        }
        refreshVoice()
        return failure
    }

    private fun startRuntime() {
        if (core != null) return
        val agentdLinks = AgentdLinks(this).also { links = it }
        agentdLinks.start()
        val hub = (coreFactory?.invoke(this, this) ?: HubCoderCore(this, this)).also { core = it }
        // Before the hub starts, so the first link state it reports already reaches the healer.
        val config = AgentsConfigStore(this)
        val glassesHealer = GlassesLinkHealer(
            mainScope, hub, enabled = { config.load().shouldMonitor },
        ).also { healer = it }
        hub.start()
        glassesHealer.onLinkState(hub.linkState())
        CoderRuntime.attachHealer(glassesHealer)
        // The switch alone changes whether the glasses are chased: the link state does not move with it.
        monitoringWatch = config.watchMonitoring { glassesHealer.onMonitoringChanged() }
        agents = AgentsCore(hub.surface, this).also(AgentsCore::start)
        CoderRuntime.attachCore(hub)
        CoderRuntime.attach(agentdLinks)
        agentdLinks.reconcile()
        sessionsWatch = mainScope.launch {
            AgentsRuntime.store.sessions.map { it.size }.distinctUntilChanged().collect { count ->
                sessionCount = count
                updateNotification()
            }
        }
    }

    /** The notification's Stop: everything ends, and stays ended across reboots until the app is opened. */
    private fun stopByUser() {
        prefs.recordStop()
        shutdown()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun shutdown() {
        sessionsWatch?.cancel()
        sessionsWatch = null
        links?.let(CoderRuntime::detach)
        runCatching { monitoringWatch?.close() }
        monitoringWatch = null
        healer?.stop()
        healer = null
        CoderRuntime.attachHealer(null)
        if (core != null) CoderRuntime.attachCore(null)
        agents?.close()
        agents = null
        core?.close()
        core = null
        links?.close()
        links = null
        // Stop and the service's end: the transports are gone, so is every link they held.
        AgentsRuntime.clearSecureLinks()
        promotion.reset()
        foreground = false
        refreshVoice()
    }

    private fun microphoneGranted(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun voiceWithoutMicrophone(): VoiceAvailability =
        if (microphoneGranted()) VoiceAvailability.NEEDS_APP_OPEN else VoiceAvailability.PERMISSION_DENIED

    private fun refreshVoice() {
        val now = if (promotion.microphoneHeld) VoiceAvailability.AVAILABLE else voiceWithoutMicrophone()
        if (_voice.value == now) return
        _voice.value = now
        updateNotification()
    }

    private fun pointVoiceOnGlasses() {
        val line = _voice.value.glassesLine ?: return
        links?.brief(VoiceAvailability.GLASSES_TITLE, line)
    }

    private fun status(voice: VoiceAvailability = _voice.value) =
        CoderNotifications.Status(linkState, sessionCount, voice)

    private fun updateNotification() {
        if (!foreground) return
        notifications.update(status())
    }

    companion object {
        const val ACTION_STOP = "com.anezium.rokidbus.plugin.agents.action.STOP"
        internal const val ACTION_FOREGROUND_START = "com.anezium.rokidbus.plugin.agents.action.START_FROM_FOREGROUND"
        internal const val ACTION_BOOT_START = "com.anezium.rokidbus.plugin.agents.action.START_FROM_BOOT"
        private const val TAG = "CoderService"

        private val _voice = MutableStateFlow(VoiceAvailability.NEEDS_APP_OPEN)
        val voice: StateFlow<VoiceAvailability> = _voice.asStateFlow()

        @VisibleForTesting
        internal var processStarted: () -> Boolean = {
            ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
        }

        @VisibleForTesting internal var starterFactory: ((Service) -> ForegroundStarter)? = null

        @VisibleForTesting internal var coreFactory: ((Context, HubForegroundHost) -> CoderCore)? = null

        @VisibleForTesting
        internal fun resetSeams() {
            processStarted = { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
            starterFactory = null
            coreFactory = null
            _voice.value = VoiceAvailability.NEEDS_APP_OPEN
        }

        /**
         * Starts or promotes the service from a visible screen of ours, and only then; a call from
         * anywhere else does nothing and returns false. Every accepted call first records that
         * a foreground start happened and clears a Stop, so boot eligibility never depends on
         * which caller started it.
         */
        fun startFromForeground(context: Context): Boolean {
            if (!processStarted()) return false
            ServicePrefs(context).recordForegroundStart()
            return runCatching {
                ContextCompat.startForegroundService(context, intent(context, ACTION_FOREGROUND_START))
            }.onFailure { Log.w(TAG, "Foreground start refused type=${it.javaClass.simpleName}") }.isSuccess
        }

        /** From boot or an app update: connected-device only, never the microphone. */
        fun startFromBoot(context: Context) {
            ContextCompat.startForegroundService(context, intent(context, ACTION_BOOT_START))
        }

        private fun intent(context: Context, action: String) = Intent(context, CoderService::class.java).setAction(action)
    }
}
