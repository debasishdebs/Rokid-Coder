@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.graphics.BitmapFactory
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import com.anezium.rokidbus.client.IBusCallback
import com.anezium.rokidbus.client.IBusService
import com.anezium.rokidbus.client.PluginRegistrationResult
import com.anezium.rokidbus.shared.ActivitySurfaceContract
import com.anezium.rokidbus.shared.EditableSurfaceContract
import com.anezium.rokidbus.shared.BusCapabilityBits
import com.anezium.rokidbus.shared.BusConstants
import com.anezium.rokidbus.shared.BusEnvelope
import com.anezium.rokidbus.shared.AssistantTakeoverAction
import com.anezium.rokidbus.shared.AssistantTakeoverContract
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.FrameProtocol
import com.anezium.rokidbus.shared.ForegroundSurfacePathPolicy
import com.anezium.rokidbus.shared.GlassesHubCapabilitiesContract
import com.anezium.rokidbus.shared.GlassesRepairContract
import com.anezium.rokidbus.shared.ImageSurfaceContract
import com.anezium.rokidbus.shared.SetupNoteContract
import com.anezium.rokidbus.shared.ImageSurfaceMetadata
import com.anezium.rokidbus.shared.ImageSurfaceValidationResult
import com.anezium.rokidbus.shared.LinkStateBits
import com.anezium.rokidbus.shared.MediaArtworkContract
import com.anezium.rokidbus.shared.GlassesFilesContract
import com.anezium.rokidbus.shared.NativeAppContract
import com.anezium.rokidbus.shared.PhoneHubCapabilities
import com.anezium.rokidbus.shared.NoticeSurfaceContract
import com.anezium.rokidbus.shared.NoticeSurfaceValidationResult
import com.anezium.rokidbus.shared.PhoneHubCapabilitiesContract
import com.anezium.rokidbus.shared.PinSurfaceContract
import com.anezium.rokidbus.shared.RemoteInputContract
import com.anezium.rokidbus.shared.RemoteNavigationContract
import com.anezium.rokidbus.shared.RemotePointerContract
import com.anezium.rokidbus.shared.SppAuthProtocol
import com.anezium.rokidbus.shared.SppHandshakeDeadline
import com.anezium.rokidbus.shared.SppKeyProvisioning
import com.anezium.rokidbus.shared.SetupPairingFailureReason
import com.anezium.rokidbus.shared.SetupPairingOfferContract
import com.anezium.rokidbus.shared.TtsContract
import com.anezium.rokidbus.shared.TtsDoneEvent
import com.anezium.rokidbus.shared.TtsValidationResult
import com.anezium.rokidbus.shared.WirelessAdbAction
import com.anezium.rokidbus.shared.WirelessAdbContract
import com.anezium.rokidbus.shared.WirelessAdbReply
import com.anezium.rokidbus.shared.plugin.PathRules
import com.anezium.rokidbus.shared.plugin.PluginCapability
import com.anezium.rokidbus.shared.plugin.PluginOpenTypes
import com.anezium.rokidbus.shared.plugin.PluginCapability.Companion.serialize
import com.anezium.rokidbus.ink.InkProblem
import com.anezium.rokidbus.phone.speech.CloudSpeechReadiness
import com.anezium.rokidbus.phone.speech.HubSecretStore
import com.anezium.rokidbus.phone.speech.InternalAudioAccess
import com.anezium.rokidbus.phone.speech.InternalAudioAcquireResult
import com.anezium.rokidbus.phone.speech.InternalAudioConsumer
import com.anezium.rokidbus.phone.speech.InternalAudioStopReason
import com.anezium.rokidbus.phone.speech.SpeechEndReason
import com.anezium.rokidbus.phone.speech.SpeechProvider
import com.anezium.rokidbus.phone.speech.SpeechSessionManager
import com.anezium.rokidbus.phone.speech.SpeechSessionState
import com.anezium.rokidbus.phone.speech.SpeechSettingsStore
import com.anezium.rokidbus.phone.speech.SpeechStartResult
import com.anezium.rokidbus.phone.speech.SpeechUtteranceListener
import com.anezium.rokidbus.phone.speech.SttError
import com.anezium.rokidbus.phone.speech.SttErrorKind
import com.example.cxrglobal.CXRLink
import com.example.cxrglobal.CxrDefs
import com.example.cxrglobal.GlassInfo
import com.example.cxrglobal.callbacks.IAudioStreamCbk
import com.example.cxrglobal.callbacks.ICXRLinkCbk
import com.example.cxrglobal.callbacks.ICustomCmdCbk
import com.example.cxrglobal.callbacks.IGlassAppCbk
import com.rokid.cxr.Caps
import com.anezium.rokidbus.phone.mediasync.MediaSyncCoordinator
import com.anezium.rokidbus.shared.skills.SkillStatus
import com.anezium.rokidbus.shared.skills.SkillsContract
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.FutureTask
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import com.anezium.rokidbus.phone.speech.CloudSttSessionFactory
import com.anezium.rokidbus.phone.speech.SpeechEngine
import kotlinx.coroutines.runBlocking

private const val TAG = "ROKIDBUS-PHONE"
private const val CHANNEL_ID = "rokidbus_phone"
private const val DEVELOPER_CHANNEL_ID = "developer"
private const val UPDATES_CHANNEL_ID = "updates"
private const val NOTIFICATION_ID = 1
private const val DEVELOPER_NOTIFICATION_ID = 2
private const val APP_UPDATE_NOTIFICATION_ID = 3
private const val PLUGIN_UPDATE_NOTIFICATION_ID = 4
private const val ACTION_LOG = "com.anezium.rokidbus.phone.LOG"
private const val ACTION_SET_TOKEN = "com.anezium.rokidbus.phone.SET_TOKEN"
private const val ACTION_STOP = "com.anezium.rokidbus.phone.STOP"
private const val ACTION_DEBUG_IMAGE = "com.anezium.rokidbus.phone.DEBUG_IMAGE_SURFACE"
private const val ACTION_DEBUG_MANUAL_PAIRING = "com.anezium.rokidbus.phone.DEBUG_MANUAL_PAIRING"
private const val ACTION_INSTALL_GLASSES_APP = "com.anezium.rokidbus.phone.INSTALL_GLASSES_APP"
private const val ACTION_QUERY_GLASSES_APP = "com.anezium.rokidbus.phone.QUERY_GLASSES_APP"
private const val ACTION_OPEN_GLASSES_APP = "com.anezium.rokidbus.phone.OPEN_GLASSES_APP"
private const val ACTION_START_GLASSES_SETUP = "com.anezium.rokidbus.phone.START_GLASSES_SETUP"
private const val EXTRA_AUTH_TOKEN = "auth_token"
private const val EXTRA_MANUAL_OPERATION = "manual_operation"
private const val EXTRA_MANUAL_HOST = "manual_host"
private const val EXTRA_MANUAL_PAIR_PORT = "manual_pair_port"
private const val EXTRA_MANUAL_CODE = "manual_code"
private const val PREF_ENABLED = "hub_enabled"
private const val PREF_LAST_GLASSES_ADDRESS = "last_glasses_address"
private const val GLASSES_HUB_PACKAGE = "com.anezium.rokidbus.glasses"
private const val PREFS = "rokidbus_phone"
private const val PREF_TOKEN = "cxrl_token"
private const val UPDATE_NOTIFICATION_PREFERENCES = "update-notification-state"
private const val PREF_LAST_NOTIFIED_APP_VERSION = "last-notified-app-version"
private const val PREF_LAST_NOTIFIED_PLUGIN_UPDATES = "last-notified-plugin-updates"
private const val LOCAL_BINARY_MAX_BYTES = 512 * 1024
private const val GLASSES_RELEASE_CHECK_INTERVAL_MILLIS = 4L * 60L * 60L * 1000L
private const val BACKGROUND_UPDATE_CHECK_INTERVAL_MILLIS = 60L * 60L * 1000L
private const val AUDIO_LEASE_ACQUIRE = "/audio/lease/acquire"
private const val AUDIO_LEASE_RELEASE = "/audio/lease/release"
private const val AUDIO_FRAMES = "/audio/frames"
private const val AUDIO_LEASE_REVOKED = "/audio/lease/revoked"
private const val PLUGIN_AI_ASSIST_PATH = "/system/plugin/ai-assist"
private const val PLUGIN_AI_ASSIST_OPEN_TYPE = PluginOpenTypes.AI_ASSIST
private val NATIVE_ASSISTANT_EXIT_BURST_DELAYS_MILLIS = longArrayOf(0L, 50L, 150L, 300L)
private const val NATIVE_SCENES_LOG_LIMIT = 512
private const val SNAPSHOT_JPEG_QUALITY = 80
private const val SNAPSHOT_ERROR_BUSY = "BUSY"
private const val SNAPSHOT_ERROR_LINK_DOWN = "LINK_DOWN"
private const val SNAPSHOT_ERROR_CAPTURE_FAILED = "CAPTURE_FAILED"
private const val SNAPSHOT_ERROR_TIMEOUT = "TIMEOUT"
private const val CXR_AUDIO_PCM = 1
private const val AUDIO_SAMPLE_RATE = 16_000
private const val AUDIO_CHANNELS = 1
private const val AUDIO_ENCODING = "pcm16le"

/**
 * The upstream Nexus phone hub: the Service, its plugin runtime, Store, updater, setup hand-offs,
 * photo sync, the files explorer and manual ADB setup, over the reusable [HubCore].
 */
class BusHubService : Service(), HubForegroundHost {
    private val executor = Executors.newCachedThreadPool()
    private val updateCheckHandler = Handler(Looper.getMainLooper())
    @Volatile private var updateCheckLoopStopped = true
    private val updateCheckTick = object : Runnable {
        override fun run() {
            if (updateCheckLoopStopped) return
            runBackgroundUpdateChecks()
            if (!updateCheckLoopStopped) {
                updateCheckHandler.postDelayed(this, BACKGROUND_UPDATE_CHECK_INTERVAL_MILLIS)
            }
        }
    }
    private val snapshotCaptureScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    // CXR app calls are suspending core calls; their answers are handled here, off the main thread.
    private val shellScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val snapshotCapture = CxrSnapshotCapture()
    private val snapshotInFlight = AtomicBoolean(false)
    @Volatile private var snapshotCaptureJob: Job? = null
    private val debugImageSeq = AtomicLong(System.currentTimeMillis())
    private val glassesAppOperationLock = Any()
    private val glassesAppStateLock = Any()
    private val glassesAppReleaseLock = Any()
    @Volatile private var startupBlockedByBluetoothPermission = false
    private lateinit var pluginRegistry: PhonePluginRegistry
    private lateinit var pluginDiscovery: PhonePluginDiscovery
    private lateinit var pluginGrantStore: PluginGrantStore
    private lateinit var assistantTakeoverStore: AssistantTakeoverStore
    private lateinit var pluginGrantReconciler: PluginGrantReconciler
    private lateinit var registryClient: RegistryClient
    private lateinit var developerModeStore: DeveloperModeStore
    private var developerModeJournalSubscription: DeveloperModeStore.Subscription? = null
    private lateinit var externalPluginController: ExternalPluginController
    private lateinit var cameraConsumerReadiness: CameraConsumerReadiness
    private lateinit var cameraCompanionController: CameraCompanionController
    private lateinit var skillGrantStore: SkillGrantStore
    private lateinit var skillLeaseRuntime: AndroidSkillLeaseRuntime
    private lateinit var skillsCoordinator: SkillsCoordinator

    // Skill calls must run in arrival order: a cancel must not overtake its invoke.
    private val skillsExecutor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "nexus-skills") }
    private val skillScheduler = MainThreadExternalPluginScheduler()
    private val skillRandom = SecureRandom()
    @Volatile private var skillPrincipalsCache: List<PhonePluginPrincipal>? = null
    private lateinit var pluginGuardianCoordinator: PluginGuardianCoordinator
    private lateinit var mediaSyncCoordinator: MediaSyncCoordinator
    private lateinit var coreRemoteBridge: PhoneCoreRemoteBridge
    private lateinit var glassesFiles: GlassesFilesController
    private lateinit var youtubeSetup: YoutubeSetupController
    private lateinit var redditSetup: YoutubeSetupController
    private lateinit var manualPairingEngine: GlassesManualPairingEngine
    private var manualPairingEngineSubscription: Closeable? = null
    private val phoneAssistedSetupOfferPolicy = PhoneAssistedSetupOfferPolicy()
    private val phoneAssistedPairingLock = Any()
    private var activePhoneAssistedPairing: ActivePhoneAssistedPairing? = null
    private lateinit var transitLegacyStateExporter: TransitLegacyStateExporter
    @Volatile private var glassesAppInstallState: GlassesAppInstallState = GlassesAppInstallState.Unknown
    private var glassesAppOperationSequence = 0L
    private var activeGlassesAppOperationId: Long? = null
    private var phoneBatteryReporter: PhoneBatteryReporter? = null
    private var phoneBatteryBadgeSubscription: PhoneBatteryBadgeStore.Subscription? = null
    @Volatile private var lastNotifiedStatus: String? = null
    @Volatile private var remoteGlassesVersionName: String? = null
    @Volatile private var remoteGlassesSetupComplete = false
    @Volatile private var remoteGlassesSetupFailureState = ""
    @Volatile private var remoteGlassesSetupFailureDiagnostic = ""
    @Volatile private var remoteGlassesSetupSessionId = ""
    @Volatile private var remoteGlassesSetupStage = ""
    @Volatile private var remoteGlassesSetupRunning = false
    @Volatile private var remoteGlassesSetupRequiresUserAction = false
    @Volatile private var remoteGlassesSetupSupportCode = ""
    @Volatile private var remoteGlassesSetupCompletionMode = ""
    @Volatile private var remoteGlassesCoreReady = false
    @Volatile private var remoteGlassesMaintenanceReady = false
    @Volatile private var latestGlassesAppRelease: NexusReleaseAsset? = null
    @Volatile private var glassesAppUpdateState: GlassesAppUpdateState = GlassesAppUpdateState.Unknown
    @Volatile private var glassesReleaseCheckedAtMillis = 0L
    private var glassesReleaseCheckInFlight = false
    private var pluginPackageReceiverRegistered = false
    private var wifiStateReceiverRegistered = false
    private val notifiedDeveloperPackages = ConcurrentHashMap.newKeySet<String>()

    private data class ActivePhoneAssistedPairing(
        val sessionId: String,
        val offerId: String,
        var lastState: GlassesManualPairingState = GlassesManualPairingState.IDLE,
    )

    private val pluginPackageReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            val action = intent?.action
            val replacing = intent?.getBooleanExtra(Intent.EXTRA_REPLACING, false) == true
            if (!PluginPackageChangePolicy.shouldReconcile(
                    action = action,
                    replacing = replacing,
                )
            ) return
            val packageName = intent?.data?.schemeSpecificPart.orEmpty()
            if (packageName.isNotBlank()) reconcilePluginPackage(packageName, action, replacing)
        }
    }

    private val wifiStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != WifiManager.WIFI_STATE_CHANGED_ACTION) return
            when (intent.getIntExtra(WifiManager.EXTRA_WIFI_STATE, WifiManager.WIFI_STATE_UNKNOWN)) {
                WifiManager.WIFI_STATE_ENABLED,
                WifiManager.WIFI_STATE_DISABLED,
                -> core.announcePhoneCapabilities()
            }
        }
    }

    private val shellForeground = object : HubForegroundPolicy {
        override fun handleRemote(envelope: BusEnvelope): Boolean =
            ::pluginRegistry.isInitialized && pluginRegistry.handleRemote(envelope)

        override fun allowSurface(principal: PhonePluginPrincipal, path: String): Boolean =
            !::pluginRegistry.isInitialized || pluginRegistry.allowExternalSurface(principal, path)

        override fun onSurfaceTraffic(pluginId: String) {
            if (::externalPluginController.isInitialized) externalPluginController.onPluginActivity(pluginId)
        }

        override fun onSelfHid(pluginId: String, detach: Boolean, hasActiveAudioLease: Boolean) {
            if (::externalPluginController.isInitialized) {
                externalPluginController.onPluginSelfHid(
                    pluginId = pluginId,
                    detach = detach,
                    hasActiveAudioLease = hasActiveAudioLease,
                )
            }
        }

        override fun onAudioLeaseEnded(pluginId: String, reason: String) {
            if (::externalPluginController.isInitialized) {
                externalPluginController.onAudioLeaseEnded(pluginId, reason)
            }
        }

        override fun activeId(): String? =
            if (::externalPluginController.isInitialized) externalPluginController.activeId() else null

        override fun syncLauncherList() {
            if (::pluginRegistry.isInitialized) pluginRegistry.syncLauncherList()
        }

        // Stopping the hub leaves plugins as they are; the registry closes them on destroy.
        override fun closeAll(reason: String) = Unit
    }

    private val hooks = object : HubShellHooks {
        override fun admitPlugin(packageName: String, pluginId: String, uid: Int): PluginAdmission {
            val packages = packageManager.getPackagesForUid(uid).orEmpty()
            if (packageName !in packages) {
                return PluginAdmission.Rejected(PluginRegistrationResult.IDENTITY_MISMATCH, "IDENTITY_MISMATCH")
            }
            if (!::pluginDiscovery.isInitialized) {
                return PluginAdmission.Rejected(PluginRegistrationResult.INVALID_DESCRIPTOR, "INVALID_DESCRIPTOR")
            }
            val candidates = pluginDiscovery.discoverPackage(packageName)
            if (candidates.size != 1) {
                return PluginAdmission.Rejected(PluginRegistrationResult.INVALID_DESCRIPTOR, "INVALID_DESCRIPTOR")
            }
            val candidate = candidates.single()
            if (candidate is PhonePluginCandidate.Invalid) {
                val result = if (candidate.reason == "UNSUPPORTED_API" ||
                    candidate.reason == "SHARED_UID_UNSUPPORTED"
                ) {
                    PluginRegistrationResult.UNSUPPORTED_API
                } else {
                    PluginRegistrationResult.INVALID_DESCRIPTOR
                }
                return PluginAdmission.Rejected(result, candidate.reason)
            }
            val principal = (candidate as PhonePluginCandidate.Valid).principal
            if (principal.uid != uid || principal.descriptor.id != pluginId) {
                return PluginAdmission.Rejected(PluginRegistrationResult.IDENTITY_MISMATCH, "IDENTITY_MISMATCH")
            }
            return when (val state = pluginGrantStore.stateFor(principal)) {
                PluginGrantState.Pending -> PluginAdmission.Rejected(
                    PluginRegistrationResult.PENDING_USER_APPROVAL,
                    "PENDING_USER_APPROVAL",
                )
                PluginGrantState.Denied -> PluginAdmission.Rejected(PluginRegistrationResult.DENIED, "DENIED")
                PluginGrantState.Disabled -> PluginAdmission.Rejected(PluginRegistrationResult.DENIED, "DISABLED")
                is PluginGrantState.Approved -> PluginAdmission.Approved(principal, state.capabilities)
            }
        }

        override fun onPluginRegistered(principal: PhonePluginPrincipal) {
            if (::externalPluginController.isInitialized) {
                externalPluginController.onRegistered(principal)
            }
            if (::cameraCompanionController.isInitialized) {
                cameraCompanionController.onRegistered(principal)
            }
            if (::skillsCoordinator.isInitialized) {
                skillsExecutor.execute { skillsCoordinator.onRegistered(principal) }
            }
        }

        override fun grantFor(principal: PhonePluginPrincipal): PluginGrantState =
            if (::pluginGrantStore.isInitialized) pluginGrantStore.stateFor(principal) else PluginGrantState.Denied

        override fun onRegistrationRemoved(
            principal: PhonePluginPrincipal?,
            reason: String,
            ownerStillConnected: Boolean,
        ) {
            if (principal == null) return
            if (!ownerStillConnected && reason != "replace" && ::skillsCoordinator.isInitialized) {
                skillsExecutor.execute { skillsCoordinator.onRegistrationRemoved(principal) }
            }
            if (reason in setOf("binderDied", "dead callback", "unregister")) {
                if (::externalPluginController.isInitialized) {
                    externalPluginController.onBinderDied(principal.grantKey())
                }
                if (::cameraCompanionController.isInitialized) {
                    cameraCompanionController.onBinderDied(principal.grantKey())
                }
            }
        }

        override fun onPrincipalRevoking(key: PluginGrantKey) {
            if (::cameraCompanionController.isInitialized) cameraCompanionController.onRevoked(key)
            if (::externalPluginController.isInitialized) externalPluginController.onRevoked(key)
        }

        override fun onAuthorizationChanged(key: PluginGrantKey) {
            if (::skillsCoordinator.isInitialized) {
                // A skill approval never outlives the ordinary grant it sits on: re-approving the
                // plugin later must not silently bring its operations back.
                val approved = installedPluginPrincipals().any { principal ->
                    principal.grantKey() == key && pluginGrantStore.stateFor(principal) is PluginGrantState.Approved
                }
                if (!approved) skillGrantStore.revokeAll(key)
                skillsExecutor.execute { skillsCoordinator.onAuthorizationChanged(key) }
            }
            if (::cameraConsumerReadiness.isInitialized) cameraConsumerReadiness.recompute()
            refreshMediaSyncConsent()
        }

        override fun foreground(): HubForegroundPolicy = shellForeground

        override fun onRemote(envelope: BusEnvelope): Boolean = routeShellRemote(envelope)

        override fun onLocal(envelope: BusEnvelope, sender: AuthorizedSender): Boolean =
            routeShellLocal(envelope, sender)

        override fun leaseRestriction(principal: PhonePluginPrincipal, path: String): String? =
            if (::skillsCoordinator.isInitialized) skillsCoordinator.leaseRestriction(principal, path) else null

        override fun enqueueUndelivered(envelope: BusEnvelope, excludeUid: Int?): Boolean =
            PhoneClientSupervisor.enqueue(applicationContext, envelope, excludeUid = excludeUid)

        // Unconditional pairing-offer bit: this build can always take a pairing offer off the
        // glasses. Gating it on link or session state would make the glasses read "no phone help
        // available" during the exact window where the offer is about to be sent.
        override fun extraCapabilities(base: Int): Int =
            PhoneAssistedSetupCapabilityPolicy.advertised(base or baseCameraCapabilities())

        override fun onLinkState(state: Int, previous: Int) = onShellLinkState(state, previous)

        override fun onGlassesCapabilities(payload: JSONObject) = onShellGlassesCapabilities(payload)

        override fun onAssistGesture(session: Int, press: Int): Boolean = takeOverAssistGesture(session, press)

        override fun assistTakeoverEnabled(): Boolean =
            !::assistantTakeoverStore.isInitialized || assistantTakeoverStore.isEnabled()

        override fun onClientRegistered(prefixes: List<String>, key: PluginGrantKey?) {
            PhoneClientSupervisor.onClientRegistered(applicationContext, prefixes, key)
        }

        override fun onLocalDelivered() = PhoneClientSupervisor.touch()

        override fun announcement(base: PhoneHubCapabilities): PhoneHubCapabilities =
            PhoneHubCapabilitiesContract.create(
                features = PhoneAssistedSetupCapabilityPolicy.advertised(phoneCameraCapabilities()) or
                    BusCapabilityBits.GLASSES_FILES_HOTSPOT,
                cameraConsumerName = if (::cameraConsumerReadiness.isInitialized) {
                    cameraConsumerReadiness.resolveApproved()?.descriptor?.displayName
                } else {
                    null
                },
                activityAlwaysExpanded = base.activityAlwaysExpanded,
                hudTopInsetDp = base.hudTopInsetDp,
                hudPositionAuto = base.hudPositionAuto,
            )
    }

    private val coreDelegate = lazy {
        HubCore(
            this,
            HubCoreConfig(foreground = this, hooks = hooks, journal = busJournal, log = ::log),
        )
    }

    /** The phone hub proper. Built on first use, once the Service has its context. */
    val core: HubCore by coreDelegate

    private fun routeShellLocal(envelope: BusEnvelope, sender: AuthorizedSender): Boolean {
        if (envelope.path == BusPaths.GLASSES_SELFARM_MANUAL) {
            handleManualSelfArmControl(envelope, sender.replyBinder)
            return true
        }
        val ackPrincipal = sender.principal
        if (envelope.path == TransitLegacyStateExporter.ACK_PATH && ackPrincipal != null) {
            val acknowledged = transitLegacyStateExporter.acknowledge(
                ackPrincipal,
                pluginGrantStore.stateFor(ackPrincipal),
                envelope.payload,
            )
            if (acknowledged) {
                core.recordLocalRoute(envelope, sender, PluginBusJournal.Verdict.OK)
            } else {
                core.recordLocalRoute(
                    envelope,
                    sender,
                    PluginBusJournal.Verdict.REJECTED,
                    "INVALID_MIGRATION_ACK",
                )
                core.deliverError(sender.replyBinder, envelope.id, "INVALID_MIGRATION_ACK")
            }
            return true
        }
        val handles = when (envelope.path) {
            BusPaths.HTTP_REQUEST,
            BusPaths.MEDIA_SYNC_SETTINGS,
            BusPaths.MEDIA_SYNC_NOW,
            in SKILL_PATHS,
            -> true
            BusPaths.CAMERA_SNAPSHOT_REQUEST,
            BusPaths.WIRELESS_ADB_REQUEST,
            BusPaths.ASSISTANT_TAKEOVER_REQUEST,
            -> sender.principal != null
            else -> false
        }
        if (!handles) return false
        core.recordLocalRoute(envelope, sender, PluginBusJournal.Verdict.OK)
        handleHubPath(envelope, replyRemote = false, replyBinder = sender.replyBinder, principal = sender.principal)
        return true
    }

    private fun routeShellRemote(envelope: BusEnvelope): Boolean {
        if (PathRules.matchesPrefix(envelope.path, GLASSES_FILES_ROOT)) {
            // Deliberately inline on the reader thread: the controller's serial inbox is what keeps
            // a copy's chunks in wire order, and handing them to the cached pool would not.
            val handled = ::glassesFiles.isInitialized && glassesFiles.handleRemote(envelope)
            if (envelope.path != GlassesFilesContract.DATA_PATH) {
                core.recordRemoteRoute(envelope, if (handled) PluginBusJournal.Verdict.OK else PluginBusJournal.Verdict.REJECTED)
            }
            return true
        }
        if (envelope.path == RemoteInputContract.SESSION_PATH ||
            envelope.path == RemoteInputContract.STATUS_PATH ||
            envelope.path == RemoteNavigationContract.RESULT_PATH ||
            envelope.path == RemotePointerContract.RESULT_PATH ||
            envelope.path == NativeAppContract.RESULT_PATH
        ) {
            val handled = (::youtubeSetup.isInitialized && youtubeSetup.handleRemote(envelope)) ||
                (::redditSetup.isInitialized && redditSetup.handleRemote(envelope)) ||
                (::coreRemoteBridge.isInitialized && coreRemoteBridge.handleRemote(envelope))
            core.recordRemoteRoute(
                envelope,
                if (handled) PluginBusJournal.Verdict.OK else PluginBusJournal.Verdict.REJECTED,
                if (handled) null else "INVALID_CORE_RESULT",
            )
            if (!handled) core.sendRemote(errorEnvelope(envelope.id, "INVALID_CORE_RESULT"))
            return true
        }
        if (envelope.path == BusPaths.GLASSES_SETUP_NOTE) {
            // Diagnostics only: file it and move on. Nothing about setup waits on a note.
            SetupNoteContract.fromJson(envelope.payload)?.let { note ->
                SetupJournal.record(
                    context = applicationContext,
                    fromGlasses = true,
                    code = note.code,
                    detail = listOfNotNull(
                        note.stage.takeIf { it.isNotBlank() },
                        note.detail.takeIf { it.isNotBlank() },
                    ).joinToString(" · "),
                )
            }
            return true
        }
        if (envelope.path == BusPaths.GLASSES_SETUP_PAIRING_OFFER) {
            val arrivedAtMillis = SystemClock.elapsedRealtime()
            executor.execute { handlePhoneAssistedSetupOffer(envelope, arrivedAtMillis) }
            return true
        }
        if (handleManualSelfArmResponse(envelope)) return true
        if (::mediaSyncCoordinator.isInitialized && handleMediaSyncRemote(envelope)) {
            core.recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            return true
        }
        if (::cameraCompanionController.isInitialized &&
            cameraCompanionController.onRemoteEnvelope(envelope)
        ) {
            core.recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            return true
        }
        if (envelope.path == BusPaths.HTTP_REQUEST ||
            envelope.path == BusPaths.MEDIA_SYNC_SETTINGS ||
            envelope.path == BusPaths.MEDIA_SYNC_NOW
        ) {
            handleHubPath(envelope, replyRemote = true)
            core.recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            return true
        }
        return false
    }

    private fun onShellLinkState(state: Int, previousTransportState: Int) {
        if (::youtubeSetup.isInitialized) {
            val cxrConnected = state and LinkStateBits.CXR_CONTROL_UP != 0
            youtubeSetup.onLinkChanged(
                state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0,
                cxrConnected,
            )
            if (::redditSetup.isInitialized) redditSetup.onLinkChanged(
                state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0,
                cxrConnected,
            )
        }
        val transportBits = LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP
        if (::coreRemoteBridge.isInitialized) {
            coreRemoteBridge.onLinkStateChanged(
                connected = state and transportBits != 0,
                nativePointerAvailable = state and LinkStateBits.CXR_CONTROL_UP != 0,
            )
        }
        if (::glassesFiles.isInitialized) {
            glassesFiles.onLinkStateChanged(
                controlUp = state and LinkStateBits.CXR_CONTROL_UP != 0,
                dataUp = state and LinkStateBits.SPP_DATA_UP != 0,
            )
        }
        if (::pluginGuardianCoordinator.isInitialized) {
            pluginGuardianCoordinator.onLinkStateChanged(state and transportBits != 0)
        }
        if (::cameraCompanionController.isInitialized &&
            ((previousTransportState and transportBits) and state.inv()) != 0
        ) {
            cameraCompanionController.onLinkLost()
        }
        if (state and LinkStateBits.CXR_CONTROL_UP == 0) {
            failActiveGlassesAppOperation("Connection to the glasses was lost.")
            cancelSnapshotForLinkDown()
        }
        if (state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) == 0) {
            if (::mediaSyncCoordinator.isInitialized) mediaSyncCoordinator.onLinkLost()
            // Keep the last-known setup state across link drops: powered-off glasses must
            // not re-open the setup step. Only a live announcement may report false.
            // The installed version is kept for the same reason — glasses that went quiet
            // did not uninstall their app, and forgetting the version turns the update
            // check into "Reinstall" for something we know is current. The next announce
            // overwrites it, so swapping in another unit still corrects itself.
            updateRemoteGlassesAppState(
                remoteGlassesVersionName,
                setupComplete = remoteGlassesSetupComplete,
            )
        }
        if (::mediaSyncCoordinator.isInitialized &&
            state and LinkStateBits.CXR_CONTROL_UP != 0 &&
            previousTransportState and LinkStateBits.CXR_CONTROL_UP == 0
        ) {
            mediaSyncCoordinator.onLinkUp()
        }
        if (::pluginRegistry.isInitialized &&
            state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0
        ) {
            phoneBatteryReporter?.resend("link_up")
        }
    }

    private fun onShellGlassesCapabilities(payload: JSONObject) {
        val advertised = GlassesHubCapabilitiesContract.parse(payload)
        if (::glassesFiles.isInitialized) {
            val current = advertised.protocolVersion == GlassesHubCapabilitiesContract.VERSION
            glassesFiles.onCapabilities(
                glassesFilesSupported = current && advertised.features and BusCapabilityBits.GLASSES_FILES != 0,
                laneSupported = current && advertised.features and BusCapabilityBits.GLASSES_FILES_LANE != 0,
                hotspotSupported = current && advertised.features and BusCapabilityBits.GLASSES_FILES_HOTSPOT != 0,
            )
        }
        updateRemoteGlassesAppState(
            advertised.versionName,
            advertised.setupComplete,
            advertised.setupFailureState,
            advertised.setupFailureDiagnostic,
            advertised.setupSessionId,
            GlassesHubCapabilitiesContract.effectiveStage(advertised),
            advertised.setupRunning,
            advertised.setupRequiresUserAction,
            advertised.setupSupportCode,
            advertised.setupCompletionMode,
            advertised.coreReady,
            advertised.maintenanceReady,
        )
        NexusPhoneState.setGlassesSetupProgress(
            sessionId = advertised.setupSessionId,
            stage = GlassesHubCapabilitiesContract.effectiveStage(advertised),
            running = advertised.setupRunning,
            requiresUserAction = advertised.setupRequiresUserAction,
            supportCode = advertised.setupSupportCode,
            completionMode = advertised.setupCompletionMode,
            coreReady = advertised.coreReady,
            maintenanceReady = advertised.maintenanceReady,
        )
        if (::manualPairingEngine.isInitialized) {
            manualPairingEngine.onGlassesSetupReported(advertised.setupComplete)
        }
        // The glasses announce on every hub start, which is the one restart the
        // phone cannot see as a link change. Without this the badge stays blank
        // until the phone next crosses a percent.
        phoneBatteryReporter?.resend("glasses_announced")
        // The glasses re-announce on every transport-up, including after a hub restart that
        // wiped their photo-sync consent. Re-push it on the same edge.
        if (::mediaSyncCoordinator.isInitialized) {
            executor.execute { mediaSyncCoordinator.onLinkUp() }
        }
        // The glasses persist the boot-repair switch, but a reinstall or a toggle flipped
        // while the link was down leaves them stale; ride the same edge the consent does.
        executor.execute { pushGlassesRepairConfig() }
    }

    private fun takeOverAssistGesture(session: Int, press: Int): Boolean {
        if (!core.isAssistSessionCurrent(session)) return false
        val assistant = approvedAssistantPrincipal() ?: return false
        val gestureId = UUID.randomUUID().toString()
        val alreadyActive = externalPluginController.activeId() == assistant.descriptor.id
        val captureSignaled = if (alreadyActive) {
            core.signalWarmAssistPress(session, press)
            true
        } else {
            externalPluginController.open(
                assistant,
                ExternalPluginOpenRequest(
                    type = PLUGIN_AI_ASSIST_OPEN_TYPE,
                    followUp = ExternalPluginOpenFollowUp(
                        path = PLUGIN_AI_ASSIST_PATH,
                        type = PLUGIN_AI_ASSIST_OPEN_TYPE,
                        extra = {
                            JSONObject()
                                .put("gestureId", gestureId)
                                .put("buttonActive", core.isAssistButtonHeld)
                                .put("source", "glass_ai_assist_start")
                        },
                    ),
                ),
            )
        }
        if (!captureSignaled) {
            log("assistant gesture wake failed plugin=${assistant.descriptor.id}")
            return false
        }
        if (!core.isAssistSessionCurrent(session)) return true
        core.sendNativeAssistantExitBurst(gestureId, session)
        val error = core.sendRemote(
            BusEnvelope(
                path = BusPaths.GLASSES_ASSISTANT_DISMISS,
                payload = JSONObject()
                    .put("version", 1)
                    .put("gestureId", gestureId)
                    .put("source", "glass_ai_assist_start"),
            ),
        )
        log(
            "assistant gesture plugin=${assistant.descriptor.id} active=$alreadyActive " +
                "gestureId=$gestureId; native dismiss " +
                "sent=${error == null} result=${error ?: "OK"}",
        )
        return true
    }

    override fun onCreate() {
        super.onCreate()
        NexusPhoneState.restore(applicationContext)
        activeInstance = this
        youtubeSetup = YoutubeSetupController(
            applicationContext,
            connected = { core.linkState() and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0 },
            installReady = { core.isCxrUp() && core.cxrLinkOrNull() != null && isPhoneWifiEnabled() },
            send = core::sendRemote,
            upload = core::uploadThirdPartyApk,
        )
        redditSetup = YoutubeSetupController(
            applicationContext,
            connected = { core.linkState() and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0 },
            installReady = { core.isCxrUp() && core.cxrLinkOrNull() != null && isPhoneWifiEnabled() },
            send = core::sendRemote,
            upload = core::uploadThirdPartyApk,
            target = NativeSetupTarget.REDDIT,
        )
        coreRemoteBridge = PhoneCoreRemoteBridge(
            context = applicationContext,
            sendRemote = core::sendRemote,
            sendNativePointer = ::sendNativePointer,
            isConnected = {
                core.linkState() and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0
            },
            isNativePointerAvailable = core::isCxrUp,
        ).also(PhoneCoreRemoteBridge::start)
        glassesFiles = GlassesFilesController(applicationContext, core::sendRemote,
            cameraActive = { ::cameraCompanionController.isInitialized && cameraCompanionController.activeSessionId() != null },
        ).also {
            val state = core.linkState()
            it.onLinkStateChanged(
                controlUp = state and LinkStateBits.CXR_CONTROL_UP != 0,
                dataUp = state and LinkStateBits.SPP_DATA_UP != 0,
            )
            GlassesFilesHub.controller = it
        }
        manualPairingEngine = GlassesManualPairingEngine.create(
            context = applicationContext,
            control = GlassesManualControlSender(::sendManualSelfArmControl),
            logger = ::log,
        )
        manualPairingEngineSubscription =
            manualPairingEngine.observe(::onPhoneAssistedPairingStateChanged)
        // The glasses only re-advertise their setup state once CXR is back up. Without seeding
        // these from the last persisted values, a hub restart (e.g. after an app update kills the
        // process) would broadcast setupComplete=false and versionName="" before the glasses
        // reconnect, which resets the phone's finished onboarding and strands the setup step on
        // "Connect your glasses". Start from what we last knew; a live advertisement still wins.
        prefs().let { stored ->
            remoteGlassesSetupComplete = stored.getBoolean(
                NexusPhoneState.PREF_GLASSES_SETUP_COMPLETE,
                false,
            )
            remoteGlassesVersionName = stored.getString(
                NexusPhoneState.PREF_INSTALLED_GLASSES_VERSION_NAME,
                null,
            )?.trim()?.takeIf { it.isNotEmpty() }
            remoteGlassesSetupFailureState = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_FAILURE_STATE,
                "",
            ).orEmpty()
            remoteGlassesSetupFailureDiagnostic = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_FAILURE_DIAGNOSTIC,
                "",
            ).orEmpty()
            remoteGlassesSetupSessionId = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_SESSION_ID,
                "",
            ).orEmpty()
            remoteGlassesSetupStage = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_STAGE,
                "",
            ).orEmpty()
            remoteGlassesSetupRunning = stored.getBoolean(
                NexusPhoneState.PREF_GLASSES_SETUP_RUNNING,
                false,
            )
            remoteGlassesSetupRequiresUserAction = stored.getBoolean(
                NexusPhoneState.PREF_GLASSES_SETUP_REQUIRES_USER_ACTION,
                false,
            )
            remoteGlassesSetupSupportCode = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_SUPPORT_CODE,
                "",
            ).orEmpty()
            remoteGlassesSetupCompletionMode = stored.getString(
                NexusPhoneState.PREF_GLASSES_SETUP_COMPLETION_MODE,
                "",
            ).orEmpty()
            remoteGlassesCoreReady = stored.getBoolean(
                NexusPhoneState.PREF_GLASSES_CORE_READY,
                false,
            )
            remoteGlassesMaintenanceReady = stored.getBoolean(
                NexusPhoneState.PREF_GLASSES_MAINTENANCE_READY,
                false,
            )
        }
        developerModeStore = DeveloperModeStore(applicationContext)
        developerModeJournalSubscription = bindDeveloperModeToJournal(developerModeStore, busJournal)
        PhoneClientSupervisor.attach(this)
        pluginDiscovery = PhonePluginDiscovery(packageManager)
        pluginGrantStore = PluginGrantStore(applicationContext)
        assistantTakeoverStore = AssistantTakeoverStore(applicationContext)
        registryClient = RegistryClient.create(applicationContext)
        pluginGrantReconciler = PluginGrantReconciler(
            discoverCandidates = pluginDiscovery::discover,
            reconcileGrants = pluginGrantStore::reconcile,
        )
        executor.execute { pluginGrantReconciler.reconcile() }
        pluginGuardianCoordinator = PluginGuardianCoordinator(
            context = applicationContext,
            targetProvider = ::approvedGuardianTargets,
            logger = ::log,
        )
        cameraConsumerReadiness = CameraConsumerReadiness(
            installedPrincipals = ::installedPluginPrincipals,
            grantState = pluginGrantStore::stateFor,
        ).also { it.recompute() }
        transitLegacyStateExporter = TransitLegacyStateExporter(
            AndroidTransitLegacyStateStorage(applicationContext),
        )
        // The core runs only the Android recognizer; the cloud engines are this shell's.
        val secrets = HubSecretStore(applicationContext)
        val cloudSpeech = CloudSttSessionFactory(secrets)
        SpeechEngine.entries.filterNot { it.usesAndroidRecognizer }.forEach { engine ->
            core.speech.register(engine, cloudSpeech) { CloudSpeechReadiness.readiness(engine, secrets) }
        }
        val externalRuntime = AndroidExternalPluginRuntime(
            context = applicationContext,
            isRegisteredCallback = core::isPrincipalRegistered,
            deliverCallback = core::deliverToPrincipal,
            hideCallback = core::hideExternalSurfaces,
            disconnectedCallback = { principal ->
                if (::externalPluginController.isInitialized) {
                    externalPluginController.onBinderDied(principal.grantKey())
                }
            },
        )
        externalPluginController = ExternalPluginController(
            runtime = externalRuntime,
            scheduler = MainThreadExternalPluginScheduler(),
            logger = ::log,
            onRegisteredPrincipal = ::offerTransitLegacyMigration,
            onForegroundChanged = { updateStatusNotification(core.linkState()) },
            onBackgroundChanged = NexusPhoneState::setBackgroundAudioPluginId,
            journal = busJournal,
        )
        val cameraRuntime = AndroidExternalPluginRuntime(
            context = applicationContext,
            isRegisteredCallback = core::isPrincipalRegistered,
            deliverCallback = core::deliverToPrincipal,
            deliverBinaryCallback = core::deliverBinaryToPrincipal,
            hideCallback = {},
            disconnectedCallback = { principal ->
                if (::cameraCompanionController.isInitialized) {
                    cameraCompanionController.onBinderDied(principal.grantKey())
                }
            },
        )
        cameraCompanionController = CameraCompanionController(
            runtime = cameraRuntime,
            scheduler = MainThreadExternalPluginScheduler(),
            resolveApprovedConsumer = cameraConsumerReadiness::resolveApproved,
            logger = ::log,
        )
        skillGrantStore = SkillGrantStore(applicationContext)
        skillLeaseRuntime = AndroidSkillLeaseRuntime(
            context = applicationContext,
            bindingDied = { principal -> skillsExecutor.execute { skillsCoordinator.onLeaseBindingDied(principal) } },
        )
        skillsCoordinator = SkillsCoordinator(skillsHost, skillGrantStore)
        pluginRegistry = PhonePluginRegistry(
            context = applicationContext,
            plugins = emptyList(),
            sendEnvelope = core::sendBuiltInPluginEnvelope,
            capabilitiesProvider = core::capabilities,
            logger = { message -> log(message) },
            catalogProvider = {
                PluginCatalog.build(
                    builtIns = emptyList(),
                    candidates = pluginDiscovery.discover(),
                    registryFeed = registryClient.cachedSnapshot()?.feed
                        ?: RegistryFeed(RegistryClient.SUPPORTED_VERSION, emptyList()),
                    grantState = pluginGrantStore::stateFor,
                )
            },
            externalController = externalPluginController,
            journal = busJournal,
        )
        mediaSyncCoordinator = MediaSyncCoordinator(
            context = applicationContext,
            sendToGlasses = { path, payload ->
                core.sendRemote(BusEnvelope(path = path, payload = payload)) == null
            },
            // Nothing photo sync sends from the phone is bulky; only the glasses stream bytes.
            publishStatus = core::publishMediaSyncStatus,
            logger = ::log,
        )
        refreshMediaSyncConsent()
        registerPluginPackageReceiver()
        registerWifiStateReceiver()
        phoneBatteryReporter = PhoneBatteryReporter(
            context = this,
            send = core::sendRemote,
            log = ::log,
            initiallyEnabled = PhoneBatteryBadgeStore(this).isEnabled(),
        ).also { it.start() }
        phoneBatteryBadgeSubscription = PhoneBatteryBadgeStore(this).addChangeListener { enabled ->
            phoneBatteryReporter?.setEnabled(enabled)
        }
        if (prefs().getBoolean(PREF_ENABLED, true)) {
            if (!canRunHub(this)) {
                startupBlockedByBluetoothPermission = true
                log("BusHubService start deferred: BLUETOOTH_CONNECT permission not granted")
                return
            }
            startForegroundWithType()
            core.start()
        }
        startPeriodicUpdateChecks()
        youtubeSetup.start()
        redditSetup.start()
        log("BusHubService created enabled=${core.isEnabled}")
    }

    override fun onBind(intent: Intent?): IBinder = core.busBinder()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A sticky restart has no command and must not re-enable a stopped hub.
        if (intent == null) return finishUnacceptedStart(startId)
        val debugCommand = isDebuggableBuild() &&
            (intent.action == ACTION_DEBUG_IMAGE || intent.action == ACTION_DEBUG_MANUAL_PAIRING)
        if (!HubCommandIntents.isTrusted(intent) && !debugCommand) {
            log("Hub command rejected status=untrusted_start")
            return finishUnacceptedStart(startId)
        }
        if (startupBlockedByBluetoothPermission && !canRunHub(this)) {
            if (intent.action == ACTION_STOP) {
                prefs().edit().putBoolean(PREF_ENABLED, false).apply()
                core.stop()
            }
            log("BusHubService command skipped: BLUETOOTH_CONNECT permission not granted")
            return finishUnacceptedStart(startId)
        }
        startupBlockedByBluetoothPermission = false
        when (intent.action) {
            ACTION_STOP -> {
                stopHub()
                return START_NOT_STICKY
            }
            ACTION_SET_TOKEN -> {
                val token = intent.getStringExtra(EXTRA_AUTH_TOKEN).orEmpty()
                if (token.isNotBlank()) {
                    enableHub(token)
                }
            }
            ACTION_DEBUG_IMAGE -> {
                if (isDebuggableBuild()) {
                    enableHub()
                    executor.execute(::pushDebugImageWhenReady)
                } else {
                    log("debug image probe rejected status=release_build")
                }
            }
            ACTION_DEBUG_MANUAL_PAIRING -> {
                if (isDebuggableBuild()) {
                    enableHub()
                    when (intent.getStringExtra(EXTRA_MANUAL_OPERATION)) {
                        "start" -> manualPairingEngine.start()
                        "submit" -> {
                            val host = intent.getStringExtra(EXTRA_MANUAL_HOST).orEmpty()
                            val pairPort = intent.getIntExtra(EXTRA_MANUAL_PAIR_PORT, 0)
                            val code = intent.getStringExtra(EXTRA_MANUAL_CODE).orEmpty()
                            intent.removeExtra(EXTRA_MANUAL_CODE)
                            manualPairingEngine.submit(host, pairPort, code)
                        }
                        "cancel" -> manualPairingEngine.cancel()
                    }
                } else {
                    log("debug manual pairing rejected status=release_build")
                }
            }
            ACTION_INSTALL_GLASSES_APP -> installGlassesApp()
            ACTION_QUERY_GLASSES_APP -> queryGlassesApp()
            ACTION_OPEN_GLASSES_APP -> openGlassesAppOnLens()
            ACTION_START_GLASSES_SETUP -> startGlassesSetupOnLens()
            else -> {
                enableHub()
            }
        }
        return START_STICKY
    }

    private fun finishUnacceptedStart(startId: Int): Int {
        if (core.isEnabled && !startupBlockedByBluetoothPermission && canRunHub(this)) {
            if (Build.VERSION.SDK_INT >= 29 && foregroundServiceType != 0) return START_STICKY
            startForegroundWithType()
            return START_STICKY
        }
        // onStartCommand cannot distinguish startService from startForegroundService.
        // Satisfy any foreground deadline before stopping, including while plugins are bound.
        startForegroundWithType(stopping = true)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf(startId)
        return START_NOT_STICKY
    }

    /** Persists the enabled switch, promotes the Service, and starts the core (with [token], if any). */
    private fun enableHub(token: String? = null) {
        prefs().edit().putBoolean(PREF_ENABLED, true).apply()
        // Bound plugins can keep this service alive after stopHub closes the UI bridge.
        if (::coreRemoteBridge.isInitialized) coreRemoteBridge.start()
        if (canRunHub(this)) {
            startForegroundWithType()
        } else {
            log("Hub enabled; foreground start deferred until BLUETOOTH_CONNECT is granted")
        }
        if (token != null) core.startWithToken(token) else core.start()
    }

    /** Release every radio resource: SPP socket, CXR-L session, foreground state. */
    private fun stopHub() {
        prefs().edit().putBoolean(PREF_ENABLED, false).apply()
        snapshotCaptureJob?.cancel()
        if (::coreRemoteBridge.isInitialized) coreRemoteBridge.close()
        core.stop()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    override fun onDestroy() {
        if (::youtubeSetup.isInitialized) youtubeSetup.close()
        if (::redditSetup.isInitialized) redditSetup.close()
        stopPeriodicUpdateChecks()
        snapshotCaptureJob?.cancel()
        snapshotCaptureScope.cancel()
        shellScope.cancel()
        if (::coreRemoteBridge.isInitialized) coreRemoteBridge.close()
        if (::glassesFiles.isInitialized) {
            if (GlassesFilesHub.controller === glassesFiles) GlassesFilesHub.controller = null
            glassesFiles.close()
        }
        PhoneClientSupervisor.detach(applicationContext, this)
        if (pluginPackageReceiverRegistered) {
            runCatching { unregisterReceiver(pluginPackageReceiver) }
            pluginPackageReceiverRegistered = false
        }
        if (wifiStateReceiverRegistered) {
            runCatching { unregisterReceiver(wifiStateReceiver) }
            wifiStateReceiverRegistered = false
        }
        phoneBatteryReporter?.stop()
        phoneBatteryReporter = null
        phoneBatteryBadgeSubscription?.close()
        phoneBatteryBadgeSubscription = null
        developerModeJournalSubscription?.close()
        developerModeJournalSubscription = null
        if (::pluginGuardianCoordinator.isInitialized) pluginGuardianCoordinator.close()
        if (::pluginRegistry.isInitialized) pluginRegistry.close()
        if (::cameraCompanionController.isInitialized) cameraCompanionController.close()
        skillsExecutor.shutdown()
        if (::mediaSyncCoordinator.isInitialized) mediaSyncCoordinator.close()
        synchronized(phoneAssistedPairingLock) { activePhoneAssistedPairing = null }
        manualPairingEngineSubscription?.close()
        manualPairingEngineSubscription = null
        if (::manualPairingEngine.isInitialized) manualPairingEngine.close()
        // Last: the registry's closes above still reach plugins through the core's registrations.
        if (coreDelegate.isInitialized()) core.close()
        if (activeInstance === this) activeInstance = null
        super.onDestroy()
    }

    fun deliverQueued(envelope: BusEnvelope): Boolean = core.deliverQueued(envelope)

    private fun handleSkillRequest(envelope: BusEnvelope, principal: PhonePluginPrincipal) {
        when (envelope.path) {
            BusPaths.SKILLS_CATALOG_REQUEST -> skillsCoordinator.catalogRequest(principal, envelope.id)
            BusPaths.SKILLS_INVOKE -> skillsCoordinator.invoke(principal, envelope.id, envelope.payload)
            BusPaths.SKILLS_CANCEL -> skillsCoordinator.cancel(principal, envelope.payload)
            BusPaths.SKILLS_SESSION_CLOSE -> skillsCoordinator.closeSession(principal, envelope.payload)
            BusPaths.SKILLS_PROVIDER_RESULT -> skillsCoordinator.providerResult(principal, envelope.payload)
        }
    }

    private val skillsHost = object : SkillsHost {
        override fun installedPrincipals(): List<PhonePluginPrincipal> =
            skillPrincipalsCache ?: installedPluginPrincipals().also { skillPrincipalsCache = it }

        override fun grantedCapabilities(principal: PhonePluginPrincipal): Set<PluginCapability>? =
            (pluginGrantStore.stateFor(principal) as? PluginGrantState.Approved)?.capabilities

        override fun isRegistered(principal: PhonePluginPrincipal): Boolean = core.isPrincipalRegistered(principal)

        override fun deliver(principal: PhonePluginPrincipal, path: String, id: String, payload: JSONObject): Boolean =
            core.deliverToPrincipal(principal, path, id, payload)

        override fun deliverError(principal: PhonePluginPrincipal, forId: String, code: String) {
            core.deliverErrorToPrincipal(principal, forId, code)
        }

        override fun bindLease(principal: PhonePluginPrincipal): Boolean = skillLeaseRuntime.bind(principal)

        override fun unbindLease(principal: PhonePluginPrincipal) = skillLeaseRuntime.unbind(principal)

        override fun holdsDisplaySession(principal: PhonePluginPrincipal): Boolean {
            val id = principal.descriptor.id
            if (::externalPluginController.isInitialized &&
                (externalPluginController.activeId() == id || externalPluginController.backgroundId() == id)
            ) return true
            return ::cameraCompanionController.isInitialized &&
                cameraCompanionController.activePrincipalKey() == principal.grantKey()
        }

        override fun schedule(key: String, delayMs: Long, action: () -> Unit) =
            skillScheduler.schedule(key, delayMs) { skillsExecutor.execute(action) }

        override fun cancel(key: String) = skillScheduler.cancel(key)

        override fun elapsedMs(): Long = SystemClock.elapsedRealtime()

        override fun wallMs(): Long = System.currentTimeMillis()

        override fun randomToken(length: Int): String = buildString(length) {
            repeat(length) { append(SKILL_TOKEN_ALPHABET[skillRandom.nextInt(SKILL_TOKEN_ALPHABET.length)]) }
        }

        override fun record(entry: SkillJournalEntry) {
            if (!busJournal.enabled.get()) return
            val delivered = entry.status == SkillStatus.COMPLETED ||
                entry.status == SkillStatus.ACCEPTED ||
                entry.status == SkillStatus.NEEDS_INPUT
            busJournal.record(
                pluginId = entry.providerId.ifBlank { null },
                category = PluginBusJournal.Category.SKILL,
                direction = PluginBusJournal.Direction.HUB_TO_PLUGIN,
                verdict = if (delivered) PluginBusJournal.Verdict.OK else PluginBusJournal.Verdict.REJECTED,
                reason = buildString {
                    append("op=").append(entry.operationId.ifBlank { "?" })
                    append(" status=").append(entry.status.wireValue)
                    entry.errorCode?.let { append(" error=").append(it) }
                    entry.dispatch?.let { append(" dispatch=").append(it.wireValue) }
                    append(" ms=").append(entry.durationMs)
                },
            )
        }
    }

    private fun handleWirelessAdbRequest(
        envelope: BusEnvelope,
        principal: PhonePluginPrincipal,
        replyBinder: IBinder?,
    ) {
        val action = WirelessAdbContract.requestAction(envelope.payload)
        val stamped = action?.let {
            WirelessAdbContract.stampedRequest(envelope.payload, principal.descriptor.id)
        }
        if (envelope.binary != null || action == null || stamped == null) {
            deliverWirelessAdbFailure(
                principal = principal,
                replyBinder = replyBinder,
                requestId = envelope.id,
                action = action ?: WirelessAdbAction.STATUS,
                code = "INVALID_REQUEST",
                message = "The wireless debugging request was invalid.",
            )
            return
        }
        val error = core.sendRemote(envelope.copy(payload = stamped)) ?: return
        deliverWirelessAdbFailure(
            principal = principal,
            replyBinder = replyBinder,
            requestId = envelope.id,
            action = action,
            code = error,
            message = "The glasses are not connected.",
        )
    }

    private fun deliverWirelessAdbFailure(
        principal: PhonePluginPrincipal,
        replyBinder: IBinder?,
        requestId: String,
        action: WirelessAdbAction,
        code: String,
        message: String,
    ) {
        core.deliverLocal(
            BusEnvelope(
                path = BusPaths.WIRELESS_ADB_REPLY,
                id = requestId,
                payload = WirelessAdbContract.reply(
                    principal.descriptor.id,
                    WirelessAdbReply(
                        action = action,
                        success = false,
                        wifiConnected = false,
                        enabled = false,
                        pairingActive = false,
                        errorCode = code,
                        message = message,
                    ),
                ),
            ),
            targetBinder = replyBinder,
        )
    }

    /**
     * A plugin holding the `assistant` grant reading or moving the assist-button switch. The
     * grant was already checked by the route policy; the switch is global on purpose — there is
     * one button — and the reply always reports where it ended up, so a `set` doubles as a read.
     */
    private fun handleAssistantTakeoverRequest(
        envelope: BusEnvelope,
        principal: PhonePluginPrincipal,
        replyBinder: IBinder?,
    ) {
        val request = AssistantTakeoverContract.parseRequest(envelope.payload)
        if (envelope.binary != null || request == null) {
            core.deliverError(replyBinder, envelope.id, AssistantTakeoverContract.ERROR_INVALID_REQUEST)
            return
        }
        if (request.action == AssistantTakeoverAction.SET) {
            val enabled = request.enabled == true
            assistantTakeoverStore.setEnabled(enabled)
            log("assistant takeover set=$enabled by plugin=${principal.descriptor.id}")
        }
        core.deliverLocal(
            BusEnvelope(
                path = BusPaths.ASSISTANT_TAKEOVER_REPLY,
                id = envelope.id,
                payload = AssistantTakeoverContract.reply(
                    principal.descriptor.id,
                    assistantTakeoverStore.isEnabled(),
                ),
            ),
            targetBinder = replyBinder,
        )
    }

    private fun requestCameraSnapshot(
        request: BusEnvelope,
        principal: PhonePluginPrincipal,
    ) {
        if (::cameraCompanionController.isInitialized &&
            cameraCompanionController.activeSessionId() != null
        ) {
            deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_BUSY)
            return
        }
        if (!core.isCxrUp() || core.cxrLinkOrNull() == null) {
            deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_LINK_DOWN)
            return
        }
        if (!snapshotInFlight.compareAndSet(false, true)) {
            deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_BUSY)
            return
        }

        val job = snapshotCaptureScope.launch(start = CoroutineStart.LAZY) {
            try {
                if (::cameraCompanionController.isInitialized &&
                    cameraCompanionController.activeSessionId() != null
                ) {
                    deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_BUSY)
                    return@launch
                }
                val link = core.cxrLinkOrNull()
                if (link == null || !core.isCxrUp()) {
                    deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_LINK_DOWN)
                    return@launch
                }

                val raw = snapshotCapture.capture(CxrLinkSnapshotAdapter(link))
                val normalized = SnapshotJpegEncoder.normalize(
                    encoded = raw,
                    maxBytes = LOCAL_BINARY_MAX_BYTES,
                    jpegQuality = SNAPSHOT_JPEG_QUALITY,
                )
                val payload = JSONObject()
                    .put("version", 1)
                    .put("type", "snapshot")
                    .put("requestId", request.id)
                    .put("pluginId", principal.descriptor.id)
                    .put("mimeType", "image/jpeg")
                    .put("sizeBytes", normalized.jpeg.size)
                    .put("width", normalized.width)
                    .put("height", normalized.height)
                    .put("quality", normalized.quality)
                val delivered = core.deliverBinaryToPrincipal(
                    principal = principal,
                    path = BusPaths.CAMERA_SNAPSHOT_RESULT,
                    id = request.id,
                    payload = payload,
                    data = normalized.jpeg,
                )
                log(
                    "snapshot result plugin=${principal.descriptor.id} request=${request.id} " +
                        "bytes=${normalized.jpeg.size} dimensions=${normalized.width}x${normalized.height} " +
                        "delivered=$delivered",
                )
            } catch (_: SnapshotLinkDownCancellationException) {
                deliverSnapshotError(principal, request.id, SNAPSHOT_ERROR_LINK_DOWN)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (timeout: SnapshotCaptureTimeoutException) {
                deliverSnapshotError(
                    principal,
                    request.id,
                    if (core.isCxrUp()) SNAPSHOT_ERROR_TIMEOUT else SNAPSHOT_ERROR_LINK_DOWN,
                )
            } catch (failure: Throwable) {
                log(
                    "snapshot capture failed plugin=${principal.descriptor.id} " +
                        "request=${request.id} type=${failure.javaClass.simpleName}",
                )
                deliverSnapshotError(
                    principal,
                    request.id,
                    if (core.isCxrUp()) SNAPSHOT_ERROR_CAPTURE_FAILED else SNAPSHOT_ERROR_LINK_DOWN,
                )
            }
        }
        snapshotCaptureJob = job
        job.invokeOnCompletion {
            if (snapshotCaptureJob === job) snapshotCaptureJob = null
            snapshotInFlight.set(false)
        }
        job.start()
    }

    private fun deliverSnapshotError(
        principal: PhonePluginPrincipal,
        requestId: String,
        code: String,
    ) {
        val payload = JSONObject()
            .put("version", 1)
            .put("type", "error")
            .put("requestId", requestId)
            .put("pluginId", principal.descriptor.id)
            .put("code", code)
            .put("message", snapshotErrorMessage(code))
        core.deliverToPrincipal(
            principal = principal,
            path = BusPaths.CAMERA_SNAPSHOT_ERROR,
            id = requestId,
            payload = payload,
        )
        log("snapshot error plugin=${principal.descriptor.id} request=$requestId code=$code")
    }

    private fun snapshotErrorMessage(code: String): String = when (code) {
        SNAPSHOT_ERROR_BUSY -> "Camera is busy."
        SNAPSHOT_ERROR_LINK_DOWN -> "Glasses link is down."
        SNAPSHOT_ERROR_TIMEOUT -> "Camera capture timed out."
        else -> "Camera capture failed."
    }

    private fun cancelSnapshotForLinkDown() {
        snapshotCaptureJob?.cancel(SnapshotLinkDownCancellationException())
    }

    /** Manual ADB setup's control channel, a trusted-local path the core leaves to this shell. */
    private fun handleManualSelfArmControl(envelope: BusEnvelope, replyBinder: IBinder?) {
        val action = envelope.payload.optString("action")
        if (GlassesManualControlAction.entries.none { it.wireValue == action }) {
            core.deliverError(replyBinder, envelope.id, "INVALID_ACTION")
            return
        }
        val error = core.sendRemote(envelope)
        if (error != null) {
            core.deliverError(replyBinder, envelope.id, error)
        }
    }

    private fun handleHubPath(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        replyBinder: IBinder? = null,
        principal: PhonePluginPrincipal? = null,
    ): Boolean {
        when (envelope.path) {
            BusPaths.HTTP_REQUEST -> executor.execute { fetchAndStream(envelope, replyRemote, replyBinder) }
            BusPaths.CAMERA_SNAPSHOT_REQUEST -> {
                if (replyRemote || principal == null) return false
                requestCameraSnapshot(envelope, principal)
            }
            BusPaths.MEDIA_SYNC_SETTINGS -> executor.execute {
                if (::mediaSyncCoordinator.isInitialized) {
                    mediaSyncCoordinator.applySettings(envelope.payload)
                }
            }
            BusPaths.MEDIA_SYNC_NOW -> executor.execute {
                if (::mediaSyncCoordinator.isInitialized) mediaSyncCoordinator.requestSyncNow()
            }
            BusPaths.WIRELESS_ADB_REQUEST -> {
                if (replyRemote || principal == null) return false
                handleWirelessAdbRequest(envelope, principal, replyBinder)
            }
            BusPaths.ASSISTANT_TAKEOVER_REQUEST -> {
                if (replyRemote || principal == null) return false
                handleAssistantTakeoverRequest(envelope, principal, replyBinder)
            }
            BusPaths.SKILLS_CATALOG_REQUEST,
            BusPaths.SKILLS_INVOKE,
            BusPaths.SKILLS_CANCEL,
            BusPaths.SKILLS_SESSION_CLOSE,
            BusPaths.SKILLS_PROVIDER_RESULT,
            -> {
                // Skill traffic is phone-local and only ever comes from an authenticated plugin.
                if (replyRemote || principal == null || envelope.binary != null) return true
                skillsExecutor.execute { handleSkillRequest(envelope, principal) }
            }
            else -> return false
        }
        return true
    }


    /** Hub-to-hub photo-sync traffic: engine state, the config request, and the data plane. */
    private fun handleMediaSyncRemote(envelope: BusEnvelope): Boolean = when {
        envelope.path == BusPaths.MEDIA_SYNC_STATE -> {
            executor.execute { mediaSyncCoordinator.onGlassesState(envelope.payload) }
            true
        }
        envelope.path == BusPaths.MEDIA_SYNC_CONFIG_REQUEST -> {
            // A restarted glasses hub has lost its consent and the transport never bounced, so
            // nothing would have re-pushed it. Answer instead of leaving it dormant.
            executor.execute { mediaSyncCoordinator.onLinkUp() }
            true
        }
        BusPaths.isMediaSyncTransferPath(envelope.path) -> {
            // Deliberately NOT `executor`: that is a cached thread pool, and dispatching an
            // ordered byte stream onto it lets chunks race each other into the staging file.
            // Every chunk still lands exactly once, so lengths stay right while content is
            // scrambled - which is precisely how this failed on device. The coordinator owns a
            // single-threaded data plane; handing it envelopes from this one reader thread is
            // what preserves wire order.
            mediaSyncCoordinator.onTransferEnvelope(
                envelope.path,
                envelope.payload,
                envelope.binary,
            )
            true
        }
        else -> false
    }

    /**
     * Photo sync stays dormant until the wearer approves a `mediasync` plugin: the capability
     * grant is the consent, so the hub never moves private captures on its own initiative.
     */
    private fun refreshMediaSyncConsent() {
        if (!::mediaSyncCoordinator.isInitialized || !::pluginGrantReconciler.isInitialized) return
        val consented = runCatching {
            pluginGrantReconciler.reconcile().validPrincipals.any { principal ->
                val state = pluginGrantStore.stateFor(principal)
                state is PluginGrantState.Approved &&
                    PluginCapability.MEDIA_SYNC in state.capabilities
            }
        }.getOrDefault(false)
        mediaSyncCoordinator.onConsentChanged(consented)
    }

    private fun registerPluginPackageReceiver() {
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED)
            addAction(Intent.ACTION_PACKAGE_CHANGED)
            addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(pluginPackageReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(pluginPackageReceiver, filter)
        }
        pluginPackageReceiverRegistered = true
    }

    private fun registerWifiStateReceiver() {
        val filter = IntentFilter(WifiManager.WIFI_STATE_CHANGED_ACTION)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(wifiStateReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(wifiStateReceiver, filter)
        }
        wifiStateReceiverRegistered = true
    }

    private fun reconcilePluginPackage(packageName: String, action: String?, replacing: Boolean) {
        val reconciliation = pluginGrantReconciler.reconcile()
        val validPrincipals = reconciliation.validPrincipals
        skillPrincipalsCache = null
        if (::skillsCoordinator.isInitialized) {
            skillGrantStore.reconcile(validPrincipals)
            skillsExecutor.execute { skillsCoordinator.onPackageChanged(packageName) }
        }
        handleSideloadNotification(packageName, action, replacing, reconciliation.candidates)
        cameraConsumerReadiness.recompute()
        refreshMediaSyncConsent()
        core.clearUnavailableOwners(validPrincipals)
        val available = validPrincipals.any { principal ->
            principal.packageName == packageName &&
                pluginGrantStore.stateFor(principal) is PluginGrantState.Approved
        }
        if (!available) externalPluginController.onPackageUnavailable(packageName)
        val cameraAvailable = validPrincipals.any { principal ->
            principal.packageName == packageName &&
                cameraConsumerReadiness.isApprovedCameraConsumer(principal)
        }
        if (!cameraAvailable) cameraCompanionController.onPackageUnavailable(packageName)
        core.refreshLinkState()
        if (::pluginRegistry.isInitialized && core.isCxrUp()) pluginRegistry.syncLauncherList()
    }

    private fun handleSideloadNotification(
        packageName: String,
        action: String?,
        replacing: Boolean,
        candidates: List<PhonePluginCandidate>,
    ) {
        if (action == Intent.ACTION_PACKAGE_REMOVED && !replacing) {
            notifiedDeveloperPackages.remove(packageName)
            getSystemService(NotificationManager::class.java)
                .cancel(packageName, DEVELOPER_NOTIFICATION_ID)
            return
        }
        val candidate = candidates.singleOrNull { it.packageName == packageName }
        val principal = (candidate as? PhonePluginCandidate.Valid)?.principal
        if (!PluginSideloadNotificationPolicy.shouldNotify(
                developerModeEnabled = developerModeStore.isEnabled(),
                action = action,
                replacing = replacing,
                candidate = candidate,
                hasExistingGrant = principal?.let(pluginGrantStore::hasGrantFor) == true,
            ) || principal == null || !notifiedDeveloperPackages.add(packageName)
        ) return
        postSideloadNotification(principal)
    }

    private fun postSideloadNotification(principal: PhonePluginPrincipal) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                DEVELOPER_CHANNEL_ID,
                "Developer",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
        val target = PluginGrantTarget(principal.packageName, principal.descriptor.id)
        val review = PendingIntent.getActivity(
            this,
            principal.packageName.hashCode(),
            PluginPermissionsActivity.intent(this, target),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val displayName = principal.descriptor.displayName
        val notification = Notification.Builder(this, DEVELOPER_CHANNEL_ID)
            .setContentTitle("New plugin detected: $displayName")
            .setContentText("Tap to review access")
            .setSmallIcon(R.drawable.ic_nexus_status)
            .setContentIntent(review)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        manager.notify(principal.packageName, DEVELOPER_NOTIFICATION_ID, notification)
    }

    private fun installedPluginPrincipals(): List<PhonePluginPrincipal> =
        pluginDiscovery.discover().mapNotNull { candidate ->
            (candidate as? PhonePluginCandidate.Valid)?.principal
        }

    private fun approvedGuardianTargets(): List<PluginGuardianTarget> =
        selectApprovedGuardianTargets(installedPluginPrincipals(), pluginGrantStore::stateFor)

    private fun offerTransitLegacyMigration(principal: PhonePluginPrincipal) {
        val pending = transitLegacyStateExporter.prepare(
            principal,
            pluginGrantStore.stateFor(principal),
        ) ?: return
        core.deliverToPrincipal(
            principal = principal,
            path = TransitLegacyStateExporter.IMPORT_PATH,
            id = pending.eventId,
            payload = pending.payload,
        )
    }

    private fun sendNativePointer(command: RokidNativePointerCommand): Boolean {
        val link = core.cxrLinkOrNull() ?: return false
        if (!core.isCxrUp()) return false
        return runCatching {
            val message = RokidNativePointerProtocol.encode(command)
            val result = link.sendCustomCmd(
                RokidNativePointerProtocol.MODULE,
                Caps().apply {
                    write(message.capsCommand)
                    write(message.payload.toString())
                }.serialize(),
            )
            result != null && result >= 0
        }.getOrElse {
            log("Native pointer TX failed ${it.javaClass.simpleName}: ${it.message}")
            false
        }
    }

    private fun fetchAndStream(envelope: BusEnvelope, replyRemote: Boolean, replyBinder: IBinder?) {
        val request = envelope.payload
        val reply = { meta: JSONObject, data: ByteArray ->
            val response = BusEnvelope(path = BusPaths.HTTP_REPLY, id = envelope.id, payload = meta, binary = data)
            if (replyRemote) core.sendRemote(response) else core.deliverLocal(response, targetBinder = replyBinder)
        }
        var terminalSent = false
        fun terminal(status: Int, totalBytes: Long, errorCode: String? = null) {
            if (terminalSent) return
            terminalSent = true
            val meta = JSONObject()
                .put("status", status)
                .put("bytes", 0)
                .put("done", true)
                .put("totalBytes", totalBytes)
            errorCode?.let { meta.put("error", it) }
            reply(meta, ByteArray(0))
        }

        val callerHeaders = linkedMapOf<String, String>()
        request.optJSONObject("headers")?.let { headers ->
            headers.keys().forEach { name -> callerHeaders[name] = headers.optString(name) }
        }
        val validation = HttpProxyPolicy.validate(
            urlText = request.optString("url"),
            methodText = request.optString("method", "GET").ifBlank { "GET" },
            callerHeaders = callerHeaders,
            body = request.optString("body").toByteArray(Charsets.UTF_8),
        )
        if (validation is HttpProxyPolicy.Validation.Rejected) {
            terminal(status = 0, totalBytes = 0L, errorCode = validation.errorCode)
            log("HTTP proxy rejected code=${validation.errorCode}")
            return
        }
        val allowed = (validation as HttpProxyPolicy.Validation.Allowed).request
        var connection: HttpURLConnection? = null
        var totalBytes = 0L
        try {
            connection = (allowed.url.openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 20_000
                instanceFollowRedirects = allowed.followRedirects
                requestMethod = allowed.method
                allowed.headers.forEach(::setRequestProperty)
                if (allowed.body.isNotEmpty()) {
                    doOutput = true
                    outputStream.use { it.write(allowed.body) }
                }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val budget = HttpProxyPolicy.ResponseBudget()
            val buffer = ByteArray(16 * 1024)
            stream?.use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read == -1) break
                    if (!budget.accept(read)) {
                        terminal(
                            status = status,
                            totalBytes = budget.totalBytes,
                            errorCode = "RESPONSE_TOO_LARGE",
                        )
                        log("HTTP proxy failed code=RESPONSE_TOO_LARGE totalBytes=${budget.totalBytes}")
                        return
                    }
                    totalBytes = budget.totalBytes
                    reply(
                        JSONObject()
                            .put("status", status)
                            .put("bytes", read)
                            .put("done", false),
                        buffer.copyOf(read),
                    )
                }
            }
            terminal(status = status, totalBytes = budget.totalBytes)
            log("HTTP proxy complete status=$status totalBytes=${budget.totalBytes}")
        } catch (_: Throwable) {
            terminal(status = 0, totalBytes = totalBytes, errorCode = "UPSTREAM_FAILURE")
            log("HTTP proxy failed code=UPSTREAM_FAILURE")
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * One tap on the phone, one switch on the lens. Starts the setup entry point on the glasses so
     * the wearer lands on the accessibility switch directly instead of hunting for it inside the
     * glasses app.
     */
    private fun startGlassesSetupOnLens() {
        if (!core.isCxrUp() || core.cxrLinkOrNull() == null) {
            log("glasses setup start skipped: CXR link down")
            NexusPhoneState.setGlassesSetupHandoff(NexusPhoneState.SetupHandoff.FAILED)
            return
        }
        NexusPhoneState.setGlassesSetupHandoff(NexusPhoneState.SetupHandoff.SENDING)
        SetupJournal.record(applicationContext, fromGlasses = false, code = "start_requested")
        shellScope.launch {
            val success = core.openOnGlasses("$GLASSES_HUB_PACKAGE.SetupEntryActivity")
            log("glasses setup start result=$success")
            SetupJournal.record(
                context = applicationContext,
                fromGlasses = false,
                code = if (success) "start_delivered" else "start_not_confirmed",
                detail = if (success) {
                    ""
                } else {
                    "CXR did not confirm the entry point stayed on screen"
                },
            )
            NexusPhoneState.setGlassesSetupHandoff(
                if (success) {
                    NexusPhoneState.SetupHandoff.IDLE
                } else {
                    NexusPhoneState.SetupHandoff.FAILED
                },
            )
        }
    }

    private fun openGlassesAppOnLens() {
        if (!core.isCxrUp() || core.cxrLinkOrNull() == null) {
            log("glasses app open skipped: CXR link down")
            return
        }
        shellScope.launch {
            val success = core.openOnGlasses("$GLASSES_HUB_PACKAGE.MainActivity")
            log("glasses app open result=$success")
        }
    }

    private fun queryGlassesApp(installIfMissing: Boolean = false) {
        if (!core.isCxrUp() || core.cxrLinkOrNull() == null) {
            transitionGlassesAppState(
                GlassesAppInstallEvent.Failed(
                    "Glasses aren't connected — reconnect them first, then retry.",
                    GlassesAppRetry.QUERY,
                ),
            )
            return
        }
        val operationId = beginGlassesAppOperation()
        if (operationId == null) {
            broadcastGlassesAppState(glassesAppInstallState)
            return
        }
        transitionGlassesAppState(GlassesAppInstallEvent.QueryRequested)
        requestGlassesAppQuery(operationId, installIfMissing)
    }

    private fun requestGlassesAppQuery(
        operationId: Long,
        installIfMissing: Boolean = false,
    ) {
        shellScope.launch {
            val installed = core.queryGlassesAppInstalled()
            if (!isGlassesAppOperationActive(operationId)) return@launch
            if (installed == null) {
                failGlassesAppOperation(
                    operationId,
                    "Could not check whether Nexus is installed on the glasses.",
                    GlassesAppRetry.QUERY,
                )
                return@launch
            }
            transitionGlassesAppState(GlassesAppInstallEvent.QueryCompleted(installed))
            finishGlassesAppOperation(operationId)
            if (!installed && installIfMissing) installGlassesApp()
        }
    }

    private fun installGlassesApp() {
        val state = glassesAppInstallState
        val canInstall = state == GlassesAppInstallState.NotInstalled ||
            (state == GlassesAppInstallState.Installed &&
                (glassesAppUpdateState is GlassesAppUpdateState.UpdateAvailable ||
                    glassesAppUpdateState == GlassesAppUpdateState.Unknown)) ||
            state is GlassesAppInstallState.Error && state.retry == GlassesAppRetry.INSTALL
        if (!canInstall) {
            if (state == GlassesAppInstallState.Unknown) {
                queryGlassesApp(installIfMissing = true)
            } else if (state != GlassesAppInstallState.Resolving &&
                state !is GlassesAppInstallState.Downloading &&
                state != GlassesAppInstallState.Installing &&
                state != GlassesAppInstallState.Querying
            ) {
                queryGlassesApp()
            } else {
                broadcastGlassesAppState(state)
            }
            return
        }
        if (!isPhoneWifiEnabled()) {
            transitionGlassesAppState(
                GlassesAppInstallEvent.Failed(
                    "Turn on Wi-Fi first — the update travels to the glasses over Wi-Fi.",
                    GlassesAppRetry.INSTALL,
                ),
            )
            return
        }
        if (!core.isCxrUp() || core.cxrLinkOrNull() == null) {
            transitionGlassesAppState(
                GlassesAppInstallEvent.Failed(
                    "Glasses aren't connected — reconnect them first, then retry.",
                    GlassesAppRetry.INSTALL,
                ),
            )
            return
        }
        val operationId = beginGlassesAppOperation()
        if (operationId == null) {
            broadcastGlassesAppState(glassesAppInstallState)
            return
        }
        transitionGlassesAppState(GlassesAppInstallEvent.InstallRequested)
        executor.execute { downloadAndInstallGlassesApp(operationId) }
    }

    private fun pushGlassesRepairConfig() {
        val enabled = GlassesRepairSettingsStore(applicationContext).isAutoRepairEnabled()
        val error = core.sendRemote(
            BusEnvelope(
                path = BusPaths.GLASSES_REPAIR_CONFIG,
                payload = GlassesRepairContract.configToJson(enabled),
            ),
        )
        log("glassesRepairConfig push autoRepair=$enabled error=${error ?: "none"}")
    }

    private fun sendManualSelfArmControl(
        requestId: String,
        action: GlassesManualControlAction,
        armed: Boolean,
        abandonSessionId: String?,
    ): String? = core.sendRemote(
        BusEnvelope(
            path = BusPaths.GLASSES_SELFARM_MANUAL,
            id = requestId,
            payload = JSONObject()
                .put("version", 1)
                .put("action", action.wireValue)
                .apply {
                    if (action == GlassesManualControlAction.CLOSE) {
                        put("armed", armed)
                        // Older glasses ignore both and keep their previous CLOSE behaviour;
                        // newer ones end the named session only if it is still the current one.
                        if (!abandonSessionId.isNullOrBlank()) {
                            put("abandonPairing", true)
                            put("abandonSessionId", abandonSessionId)
                        }
                    }
                },
        ),
    )

    private fun handlePhoneAssistedSetupOffer(
        envelope: BusEnvelope,
        arrivedAtMillis: Long,
    ) {
        val validation = SetupPairingOfferContract.validateOffer(envelope.payload)
        if (validation !is SetupPairingOfferContract.OfferValidationResult.Valid) {
            log("phone-assisted pairing offer rejected reason=UNSUPPORTED")
            sendInvalidPhoneAssistedSetupResult(envelope)
            return
        }
        val offer = validation.offer
        val decision = phoneAssistedSetupOfferPolicy.evaluate(
            offer = offer,
            currentSessionId = NexusPhoneState.glassesSetupSessionId,
            lastUserIntentAtMillis = lastGlassesSetupUserIntentAtMillis.get(),
            arrivedAtMillis = arrivedAtMillis,
            nowMillis = SystemClock.elapsedRealtime(),
        )
        if (decision is PhoneAssistedSetupOfferPolicy.Decision.Rejected) {
            log("phone-assisted pairing offer rejected reason=${decision.reason}")
            sendPhoneAssistedSetupResult(
                sessionId = offer.sessionId,
                offerId = offer.offerId,
                ok = false,
                reason = decision.reason,
            )
            return
        }

        val accepted = synchronized(phoneAssistedPairingLock) {
            if (activePhoneAssistedPairing != null) {
                false
            } else {
                activePhoneAssistedPairing = ActivePhoneAssistedPairing(
                    sessionId = offer.sessionId,
                    offerId = offer.offerId,
                )
                true
            }
        }
        if (!accepted) {
            log("phone-assisted pairing offer rejected reason=PAIR_REFUSED")
            sendPhoneAssistedSetupResult(
                sessionId = offer.sessionId,
                offerId = offer.offerId,
                ok = false,
                reason = SetupPairingFailureReason.PAIR_REFUSED,
            )
            return
        }

        log("phone-assisted pairing offer accepted")
        manualPairingEngine.start(awaitGlassesConfirmation = false)
        manualPairingEngine.onPhoneAssistedConnectPort(offer.connectPort)
        if (!manualPairingEngine.submit(offer.host, offer.pairingPort, offer.pairingCode)) {
            synchronized(phoneAssistedPairingLock) {
                activePhoneAssistedPairing
                    ?.takeIf { it.sessionId == offer.sessionId && it.offerId == offer.offerId }
                    ?.let { activePhoneAssistedPairing = null }
            }
            sendPhoneAssistedSetupResult(
                sessionId = offer.sessionId,
                offerId = offer.offerId,
                ok = false,
                reason = SetupPairingFailureReason.PAIR_REFUSED,
            )
        }
    }

    private fun sendInvalidPhoneAssistedSetupResult(envelope: BusEnvelope) {
        val sessionId = envelope.payload.optString("sessionId")
        val offerId = envelope.payload.optString("offerId")
        if (!SetupPairingOfferContract.validSessionId(sessionId) ||
            !SetupPairingOfferContract.validOfferId(offerId)
        ) {
            return
        }
        sendPhoneAssistedSetupResult(
            sessionId = sessionId,
            offerId = offerId,
            ok = false,
            reason = SetupPairingFailureReason.UNSUPPORTED,
        )
    }

    private fun onPhoneAssistedPairingStateChanged(state: GlassesManualPairingState) {
        val completion = synchronized(phoneAssistedPairingLock) {
            val active = activePhoneAssistedPairing ?: return@synchronized null
            when (state) {
                GlassesManualPairingState.DONE -> {
                    activePhoneAssistedPairing = null
                    Triple(active, true, "")
                }
                is GlassesManualPairingState.ERROR -> {
                    val reason =
                        if (active.lastState == GlassesManualPairingState.PAIRING) {
                            SetupPairingFailureReason.PAIR_REFUSED
                        } else {
                            SetupPairingFailureReason.ARM_FAILED
                        }
                    activePhoneAssistedPairing = null
                    Triple(active, false, reason)
                }
                GlassesManualPairingState.IDLE -> {
                    if (active.lastState == GlassesManualPairingState.IDLE) {
                        null
                    } else {
                        activePhoneAssistedPairing = null
                        Triple(active, false, SetupPairingFailureReason.PAIR_REFUSED)
                    }
                }
                else -> {
                    active.lastState = state
                    null
                }
            }
        } ?: return

        sendPhoneAssistedSetupResult(
            sessionId = completion.first.sessionId,
            offerId = completion.first.offerId,
            ok = completion.second,
            reason = completion.third,
        )
    }

    private fun sendPhoneAssistedSetupResult(
        sessionId: String,
        offerId: String,
        ok: Boolean,
        reason: String,
    ) {
        val result = SetupPairingOfferContract.createResult(
            sessionId = sessionId,
            offerId = offerId,
            ok = ok,
            reason = reason,
        ) ?: return
        val error = core.sendRemote(
            BusEnvelope(
                path = BusPaths.GLASSES_SETUP_PAIRING_RESULT,
                payload = SetupPairingOfferContract.resultToJson(result),
            ),
        )
        log(
            if (error == null) {
                "phone-assisted pairing result sent ok=$ok"
            } else {
                "phone-assisted pairing result send failed reason=$error"
            },
        )
    }

    private fun handleManualSelfArmResponse(envelope: BusEnvelope): Boolean {
        if (!::manualPairingEngine.isInitialized) return false
        val requestId = envelope.payload.optString("forId", envelope.id).ifBlank { envelope.id }
        if (envelope.path == BusPaths.GLASSES_SELFARM_MANUAL_REPLY &&
            envelope.payload.optBoolean("connectPortUpdate", false)
        ) {
            val port = envelope.payload.optInt("connectPort")
            val sessionId = envelope.payload.optString("sessionId")
            val offerId = envelope.payload.optString("offerId")
            val accepted = if (sessionId.isNotBlank() || offerId.isNotBlank()) {
                synchronized(phoneAssistedPairingLock) {
                    val active = activePhoneAssistedPairing
                    if (port !in 1..65535 || active == null ||
                        active.sessionId != sessionId || active.offerId != offerId
                    ) {
                        false
                    } else {
                        manualPairingEngine.onPhoneAssistedConnectPort(port)
                        true
                    }
                }
            } else {
                manualPairingEngine.onGlassesConnectPort(requestId, port)
            }
            if (!accepted) {
                return false
            }
            core.recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            log("glasses connect port updated")
            return true
        }
        val errorCode = when (envelope.path) {
            BusPaths.GLASSES_SELFARM_MANUAL_REPLY -> if (
                envelope.payload.optBoolean("accepted", false)
            ) {
                null
            } else {
                envelope.payload.optString("code", "REJECTED")
            }
            BusPaths.ERROR -> envelope.payload.optString("code", "REMOTE_ERROR")
            else -> return false
        }
        if (!manualPairingEngine.onManualControlResponse(requestId, errorCode)) return false
        // Only a reply that matched the live request may teach the engine a connect port. A stale
        // ack straggling in after a cancel used to re-plant its (possibly obsolete) port, and a
        // later typed pairing would then skip discovery and dial the wrong door.
        manualPairingEngine.onGlassesConnectPort(
            requestId,
            envelope.payload.optInt("connectPort"),
        )
        core.recordRemoteRoute(
            envelope,
            if (errorCode == null) PluginBusJournal.Verdict.OK else PluginBusJournal.Verdict.REJECTED,
            errorCode,
        )
        log(
            if (errorCode == null) {
                "manual self-arm control acknowledged"
            } else {
                "manual self-arm control rejected code=$errorCode"
            },
        )
        return true
    }

    private fun isPhoneWifiEnabled(): Boolean =
        runCatching {
            getSystemService(WifiManager::class.java)?.isWifiEnabled == true
        }.getOrDefault(true)

    private fun downloadAndInstallGlassesApp(operationId: Long) {
        val release = runCatching { resolveLatestGlassesAppRelease() }.getOrElse { failure ->
            failGlassesAppOperation(
                operationId,
                "Could not find the latest glasses APK release.",
                GlassesAppRetry.INSTALL,
                failure,
            )
            return
        }
        if (!isGlassesAppOperationActive(operationId)) return

        val cacheDirectory = File(cacheDir, "glasses-app-installs").apply { mkdirs() }
        val apk = File(cacheDirectory, "nexus-glasses-${release.version}.apk")
        apk.delete()
        transitionGlassesAppState(GlassesAppInstallEvent.DownloadStarted)
        runCatching {
            HttpsArtifactDownloader().download(
                url = release.apkUrl,
                destination = apk,
                isCancelled = {
                    !isGlassesAppOperationActive(operationId) || !core.isCxrUp()
                },
                onProgress = { downloaded, total ->
                    if (isGlassesAppOperationActive(operationId)) {
                        transitionGlassesAppState(
                            GlassesAppInstallEvent.DownloadProgress(downloaded, total),
                        )
                    }
                },
            )
        }.onFailure { failure ->
            apk.delete()
            val message = if (!core.isCxrUp()) {
                "Connection to the glasses was lost."
            } else {
                "Could not download or verify the glasses APK."
            }
            failGlassesAppOperation(operationId, message, GlassesAppRetry.INSTALL, failure)
            return
        }

        val digest = release.sha256?.takeIf { it.matches(Regex("[0-9a-fA-F]{64}")) }
        if (digest == null) {
            apk.delete()
            failGlassesAppOperation(
                operationId,
                "Latest glasses release has no valid SHA-256 digest.",
                GlassesAppRetry.INSTALL,
            )
            return
        }
        if (!isGlassesAppOperationActive(operationId)) {
            apk.delete()
            return
        }
        val expected = GlassesApkMetadata(
            packageName = GLASSES_HUB_PACKAGE,
            // An unencodable release version can never match a signed APK; the core refuses it.
            versionCode = GlassesVersionCode.fromSemVersion(release.version) ?: -1L,
            sha256 = digest,
            signerSha256 = BuildConfig.GLASSES_APK_SIGNER_SHA256,
        )
        // The core verifies the APK on every push; the upload begins at 50%.
        val result = runBlocking {
            core.glassesInstaller.install(apk, expected) { progress ->
                if (progress == 50) transitionGlassesAppState(GlassesAppInstallEvent.UploadStarted)
            }
        }
        apk.delete()
        if (!isGlassesAppOperationActive(operationId)) return
        when (result) {
            InstallResult.Installed, InstallResult.AlreadyCurrent -> {
                updateRemoteGlassesAppState(
                    null,
                    setupComplete = false,
                    setupFailureState = "",
                    setupFailureDiagnostic = "",
                )
                transitionGlassesAppState(GlassesAppInstallEvent.InstallCompleted(true))
                requestGlassesAppQuery(operationId)
            }
            InstallResult.NewerOnGlasses -> failGlassesAppOperation(
                operationId,
                "The glasses already run a newer Nexus.",
                GlassesAppRetry.INSTALL,
            )
            InstallResult.Cancelled -> failGlassesAppOperation(
                operationId,
                "Connection to the glasses was lost.",
                GlassesAppRetry.INSTALL,
            )
            is InstallResult.Failed -> {
                val message = if (!core.isCxrUp()) "Connection to the glasses was lost." else result.reason
                failGlassesAppOperation(operationId, message, GlassesAppRetry.INSTALL)
            }
        }
    }

    private fun resolveLatestGlassesAppRelease(): NexusReleaseAsset {
        val response = HttpsNexusUpdateTransport(URL(NexusUpdateChecker.RELEASES_URL)).fetch(null)
        if (response.statusCode != HttpURLConnection.HTTP_OK) {
            throw IOException("GitHub releases request failed with HTTP ${response.statusCode}")
        }
        val body = response.body ?: throw IOException("GitHub releases response was empty")
        return NexusReleaseAssetResolver.parseLatest(body, NexusReleaseArtifact.GLASSES)
            ?: throw IOException("No stable glasses APK release was found")
    }

    private fun updateRemoteGlassesAppState(
        versionName: String?,
        setupComplete: Boolean,
        setupFailureState: String = remoteGlassesSetupFailureState,
        setupFailureDiagnostic: String = remoteGlassesSetupFailureDiagnostic,
        setupSessionId: String = remoteGlassesSetupSessionId,
        setupStage: String = remoteGlassesSetupStage,
        setupRunning: Boolean = remoteGlassesSetupRunning,
        setupRequiresUserAction: Boolean = remoteGlassesSetupRequiresUserAction,
        setupSupportCode: String = remoteGlassesSetupSupportCode,
        setupCompletionMode: String = remoteGlassesSetupCompletionMode,
        coreReady: Boolean = remoteGlassesCoreReady,
        maintenanceReady: Boolean = remoteGlassesMaintenanceReady,
    ) {
        val stateChanged = synchronized(glassesAppReleaseLock) {
            val versionChanged = remoteGlassesVersionName != versionName
            val setupChanged = remoteGlassesSetupComplete != setupComplete
            val failureChanged = remoteGlassesSetupFailureState != setupFailureState ||
                remoteGlassesSetupFailureDiagnostic != setupFailureDiagnostic
            val progressChanged = remoteGlassesSetupSessionId != setupSessionId ||
                remoteGlassesSetupStage != setupStage ||
                remoteGlassesSetupRunning != setupRunning ||
                remoteGlassesSetupRequiresUserAction != setupRequiresUserAction ||
                remoteGlassesSetupSupportCode != setupSupportCode ||
                remoteGlassesSetupCompletionMode != setupCompletionMode ||
                remoteGlassesCoreReady != coreReady ||
                remoteGlassesMaintenanceReady != maintenanceReady
            remoteGlassesVersionName = versionName
            remoteGlassesSetupComplete = setupComplete
            remoteGlassesSetupFailureState = setupFailureState
            remoteGlassesSetupFailureDiagnostic = setupFailureDiagnostic
            remoteGlassesSetupSessionId = setupSessionId
            remoteGlassesSetupStage = setupStage
            remoteGlassesSetupRunning = setupRunning
            remoteGlassesSetupRequiresUserAction = setupRequiresUserAction
            remoteGlassesSetupSupportCode = setupSupportCode
            remoteGlassesSetupCompletionMode = setupCompletionMode
            remoteGlassesCoreReady = coreReady
            remoteGlassesMaintenanceReady = maintenanceReady
            val updateStateChanged = recomputeGlassesAppUpdateStateLocked()
            versionChanged || setupChanged || failureChanged || progressChanged || updateStateChanged
        }
        if (stateChanged) {
            broadcastGlassesAppState(glassesAppInstallState)
        }
        if (versionName != null) refreshLatestGlassesAppRelease()
    }

    private fun refreshLatestGlassesAppRelease() {
        val now = System.currentTimeMillis()
        val shouldCheck = synchronized(glassesAppReleaseLock) {
            val elapsed = now - glassesReleaseCheckedAtMillis
            val checkIsDue = glassesReleaseCheckedAtMillis == 0L ||
                elapsed < 0L || elapsed >= GLASSES_RELEASE_CHECK_INTERVAL_MILLIS
            if (glassesReleaseCheckInFlight || !checkIsDue) {
                false
            } else {
                glassesReleaseCheckInFlight = true
                true
            }
        }
        if (!shouldCheck) return
        executor.execute {
            val result = runCatching(::resolveLatestGlassesAppRelease)
            synchronized(glassesAppReleaseLock) {
                glassesReleaseCheckInFlight = false
                glassesReleaseCheckedAtMillis = System.currentTimeMillis()
                result.getOrNull()?.let { latestGlassesAppRelease = it }
            }
            result.exceptionOrNull()?.let { failure ->
                log(
                    "glasses release check failed type=${failure.javaClass.simpleName} " +
                        "msg=${failure.message.orEmpty()}",
                )
            }
            if (recomputeGlassesAppUpdateState()) {
                broadcastGlassesAppState(glassesAppInstallState)
            }
        }
    }

    private fun recomputeGlassesAppUpdateState(): Boolean {
        return synchronized(glassesAppReleaseLock) { recomputeGlassesAppUpdateStateLocked() }
    }

    private fun recomputeGlassesAppUpdateStateLocked(): Boolean {
        val next = GlassesAppUpdatePolicy.compare(
            installedVersionName = remoteGlassesVersionName,
            latestRelease = latestGlassesAppRelease,
        )
        return if (glassesAppUpdateState == next) {
            false
        } else {
            glassesAppUpdateState = next
            true
        }
    }

    // The shell's install state machine runs one operation at a time; the core's CXR app slot
    // separately keeps every CXR app call apart.
    private fun beginGlassesAppOperation(): Long? = synchronized(glassesAppOperationLock) {
        if (activeGlassesAppOperationId != null) return@synchronized null
        glassesAppOperationSequence += 1L
        glassesAppOperationSequence.also { activeGlassesAppOperationId = it }
    }

    private fun isGlassesAppOperationActive(operationId: Long): Boolean =
        synchronized(glassesAppOperationLock) { activeGlassesAppOperationId == operationId }

    private fun finishGlassesAppOperation(operationId: Long): Boolean =
        synchronized(glassesAppOperationLock) {
            if (activeGlassesAppOperationId != operationId) return@synchronized false
            activeGlassesAppOperationId = null
            true
        }

    private fun failActiveGlassesAppOperation(message: String) {
        val retry = synchronized(glassesAppOperationLock) {
            if (activeGlassesAppOperationId == null) return
            activeGlassesAppOperationId = null
            if (glassesAppInstallState == GlassesAppInstallState.Querying) {
                GlassesAppRetry.QUERY
            } else {
                GlassesAppRetry.INSTALL
            }
        }
        transitionGlassesAppState(GlassesAppInstallEvent.Failed(message, retry))
    }

    private fun failGlassesAppOperation(
        operationId: Long,
        message: String,
        retry: GlassesAppRetry,
        failure: Throwable? = null,
    ) {
        if (!finishGlassesAppOperation(operationId)) return
        if (failure != null) {
            log("glasses app operation failed type=${failure.javaClass.simpleName} msg=${failure.message.orEmpty()}")
        }
        transitionGlassesAppState(GlassesAppInstallEvent.Failed(message, retry))
    }

    private fun transitionGlassesAppState(event: GlassesAppInstallEvent) {
        val state = synchronized(glassesAppStateLock) {
            GlassesAppInstallStateMachine.reduce(glassesAppInstallState, event)
                .also { glassesAppInstallState = it }
        }
        broadcastGlassesAppState(state)
    }

    private fun broadcastGlassesAppState(state: GlassesAppInstallState) {
        val updateState = glassesAppUpdateState
        NexusPhoneState.recordLogLine(glassesAppStatusLine(state))
        val intent = Intent(ACTION_LOG)
            .setPackage(packageName)
            .putExtra("line", glassesAppStatusLine(state))
            .putExtra(NexusPhoneState.EXTRA_GLASSES_APP_STATE, state.broadcastValue())
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_APP_VERSION_NAME,
                remoteGlassesVersionName.orEmpty(),
            )
            .putExtra(NexusPhoneState.EXTRA_GLASSES_SETUP_COMPLETE, remoteGlassesSetupComplete)
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_FAILURE_STATE,
                remoteGlassesSetupFailureState,
            )
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_FAILURE_DIAGNOSTIC,
                remoteGlassesSetupFailureDiagnostic,
            )
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_SESSION_ID,
                remoteGlassesSetupSessionId,
            )
            .putExtra(NexusPhoneState.EXTRA_GLASSES_SETUP_STAGE, remoteGlassesSetupStage)
            .putExtra(NexusPhoneState.EXTRA_GLASSES_SETUP_RUNNING, remoteGlassesSetupRunning)
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_REQUIRES_USER_ACTION,
                remoteGlassesSetupRequiresUserAction,
            )
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_SUPPORT_CODE,
                remoteGlassesSetupSupportCode,
            )
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_SETUP_COMPLETION_MODE,
                remoteGlassesSetupCompletionMode,
            )
            .putExtra(NexusPhoneState.EXTRA_GLASSES_CORE_READY, remoteGlassesCoreReady)
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_MAINTENANCE_READY,
                remoteGlassesMaintenanceReady,
            )
            .putExtra(
                NexusPhoneState.EXTRA_GLASSES_APP_UPDATE_STATE,
                updateState.broadcastValue(),
            )
            .apply {
                updateState.latestVersion()?.let { latest ->
                    putExtra(NexusPhoneState.EXTRA_GLASSES_APP_LATEST_VERSION_NAME, latest.toString())
                }
            }
        when (state) {
            is GlassesAppInstallState.Downloading -> intent
                .putExtra(NexusPhoneState.EXTRA_GLASSES_APP_DOWNLOADED, state.downloadedBytes)
                .apply {
                    state.totalBytes?.let { putExtra(NexusPhoneState.EXTRA_GLASSES_APP_TOTAL, it) }
                }
            is GlassesAppInstallState.Error -> intent
                .putExtra(NexusPhoneState.EXTRA_GLASSES_APP_MESSAGE, state.message)
                .putExtra(NexusPhoneState.EXTRA_GLASSES_APP_RETRY, state.retry.name.lowercase())
            else -> Unit
        }
        sendBroadcast(intent)
    }

    private fun GlassesAppInstallState.broadcastValue(): String = when (this) {
        GlassesAppInstallState.Unknown -> "unknown"
        GlassesAppInstallState.Querying -> "querying"
        GlassesAppInstallState.NotInstalled -> "not_installed"
        GlassesAppInstallState.Resolving -> "resolving"
        is GlassesAppInstallState.Downloading -> "downloading"
        GlassesAppInstallState.Installing -> "installing"
        GlassesAppInstallState.Installed -> "installed"
        is GlassesAppInstallState.Error -> "error"
    }

    private fun GlassesAppUpdateState.broadcastValue(): String = when (this) {
        GlassesAppUpdateState.Unknown -> "unknown"
        is GlassesAppUpdateState.UpToDate -> "up_to_date"
        is GlassesAppUpdateState.UpdateAvailable -> "update_available"
    }

    private fun GlassesAppUpdateState.latestVersion(): NexusSemVersion? = when (this) {
        GlassesAppUpdateState.Unknown -> null
        is GlassesAppUpdateState.UpToDate -> latest
        is GlassesAppUpdateState.UpdateAvailable -> latest
    }

    private fun glassesAppStatusLine(state: GlassesAppInstallState): String = when (state) {
        GlassesAppInstallState.Unknown -> "Glasses app status is unknown"
        GlassesAppInstallState.Querying -> "Checking glasses app installation"
        GlassesAppInstallState.NotInstalled -> "Glasses app is not installed"
        GlassesAppInstallState.Resolving -> "Resolving glasses app release"
        is GlassesAppInstallState.Downloading -> state.totalBytes?.takeIf { it > 0L }?.let { total ->
            "Downloading glasses app ${(state.downloadedBytes * 100L / total).coerceIn(0L, 100L)}%"
        } ?: "Downloading glasses app"
        GlassesAppInstallState.Installing -> "Installing glasses app over CXR"
        GlassesAppInstallState.Installed -> "Glasses app installation confirmed"
        is GlassesAppInstallState.Error -> "Glasses app install error: ${state.message}"
    }

    private fun startPeriodicUpdateChecks() {
        updateCheckLoopStopped = false
        createUpdateNotificationChannel()
        updateCheckHandler.post(updateCheckTick)
    }

    private fun stopPeriodicUpdateChecks() {
        updateCheckLoopStopped = true
        updateCheckHandler.removeCallbacks(updateCheckTick)
    }

    private fun runBackgroundUpdateChecks() {
        runCatching {
            NexusUpdateManager.checkForUpdates(applicationContext) { result ->
                if (!updateCheckLoopStopped && result is NexusUpdateCheckResult.Available) {
                    maybeNotifyAppUpdate(result.release)
                }
            }
        }.onFailure { failure ->
            Log.w(TAG, "Could not start app update check", failure)
        }
        runCatching {
            PluginUpdateChecker.refreshIfStale(applicationContext) { updates ->
                if (!updateCheckLoopStopped) maybeNotifyPluginUpdates(updates)
            }
        }.onFailure { failure ->
            Log.w(TAG, "Could not start plugin update check", failure)
        }
    }

    private fun maybeNotifyAppUpdate(release: NexusAppRelease) {
        val preferences = updateNotificationPreferences()
        val version = release.versionName
        val lastNotifiedVersion = preferences.getString(PREF_LAST_NOTIFIED_APP_VERSION, null)
        if (!UpdateNotificationPolicy.shouldNotifyAppUpdate(version, lastNotifiedVersion)) return

        if (postUpdateNotification(
                notificationId = APP_UPDATE_NOTIFICATION_ID,
                title = "Rokid Nexus update available",
                text = "Version $version is available.",
            )
        ) {
            preferences.edit().putString(PREF_LAST_NOTIFIED_APP_VERSION, version).apply()
        }
    }

    private fun maybeNotifyPluginUpdates(updates: List<PluginUpdateInfo>) {
        val updateSet = UpdateNotificationPolicy.pluginUpdateSet(updates)
        val preferences = updateNotificationPreferences()
        val lastNotifiedSet = preferences.getStringSet(PREF_LAST_NOTIFIED_PLUGIN_UPDATES, null)?.toSet()
        if (!UpdateNotificationPolicy.shouldNotifyPluginUpdates(updateSet, lastNotifiedSet)) return

        val count = updateSet.size
        val title = if (count == 1) {
            "1 plugin update available"
        } else {
            "$count plugin updates available"
        }
        if (postUpdateNotification(
                notificationId = PLUGIN_UPDATE_NOTIFICATION_ID,
                title = title,
                text = "Open Rokid Nexus to review and install.",
            )
        ) {
            preferences.edit().putStringSet(PREF_LAST_NOTIFIED_PLUGIN_UPDATES, updateSet).apply()
        }
    }

    private fun createUpdateNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                UPDATES_CHANNEL_ID,
                "Updates available",
                NotificationManager.IMPORTANCE_DEFAULT,
            ),
        )
    }

    private fun postUpdateNotification(
        notificationId: Int,
        title: String,
        text: String,
    ): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            Log.d(TAG, "Update notification skipped: POST_NOTIFICATIONS permission not granted")
            return false
        }
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(this, UPDATES_CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(R.drawable.ic_nexus_status)
            .setContentIntent(openApp)
            .setAutoCancel(true)
            .setOngoing(false)
            .build()
        return runCatching {
            getSystemService(NotificationManager::class.java).notify(notificationId, notification)
            true
        }.onFailure { failure ->
            Log.w(TAG, "Could not post update notification", failure)
        }.getOrDefault(false)
    }

    private fun updateNotificationPreferences() =
        getSharedPreferences(UPDATE_NOTIFICATION_PREFERENCES, MODE_PRIVATE)

    private fun startForegroundWithType(stopping: Boolean = false) {
        promote(microphone = !stopping && core.microphoneForegroundRequested)
    }

    override fun promote(microphone: Boolean): Throwable? {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Connection status", NotificationManager.IMPORTANCE_LOW),
        )
        val state = core.linkState()
        lastNotifiedStatus = statusText(state)
        val requestMicrophone = microphone
        val result = runCatching {
            startForeground(
                NOTIFICATION_ID,
                buildStatusNotification(state),
                ServiceInfoCompat.hubTypes(includeMicrophone = requestMicrophone),
            )
        }
        if (result.isSuccess) return null

        val failure = result.exceptionOrNull()
        Log.w(
            TAG,
            "Hub foreground promotion failed microphone=$requestMicrophone " +
                "type=${failure?.javaClass?.simpleName.orEmpty()}",
            failure,
        )
        if (requestMicrophone) {
            runCatching {
                startForeground(
                    NOTIFICATION_ID,
                    buildStatusNotification(state),
                    ServiceInfoCompat.hubTypes(),
                )
            }.onFailure { fallbackFailure ->
                Log.w(
                    TAG,
                    "Connected-device foreground fallback failed " +
                        "type=${fallbackFailure.javaClass.simpleName}",
                    fallbackFailure,
                )
            }
        }
        return failure ?: IllegalStateException("ForegroundServiceException")
    }

    override fun onLinkStateChanged(linkState: Int) = updateStatusNotification(linkState)

    private fun buildStatusNotification(state: Int): Notification {
        val openApp = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Rokid Nexus")
            .setContentText(statusText(state))
            .setSmallIcon(R.drawable.ic_nexus_status)
            .setContentIntent(openApp)
            .setOngoing(true)
            .build()
    }

    private fun statusText(state: Int): String = when {
        core.sppKeyState() == SppKeyState.UNAVAILABLE ->
            "Glasses pairing key unavailable; reconnect Hi Rokid to recover"
        core.sppKeyState() == SppKeyState.RECOVERING ->
            "Recovering glasses pairing key"
        core.sppKeyState() == SppKeyState.RECOVERED ->
            "Glasses pairing key recovered; reconnecting"
        core.cxrClosedByServer && state and LinkStateBits.CXR_CONTROL_UP == 0 ->
            "Hi Rokid ended the glasses session; tap to reconnect"
        state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0 -> {
            val livePlugin = if (::externalPluginController.isInitialized) {
                externalPluginController.activeDisplayName()
            } else {
                null
            }
            if (livePlugin != null) "$livePlugin is live on the glasses" else "Connected to glasses"
        }
        state and LinkStateBits.GLASSES_BT_BONDED_OR_PHONE_CONNECTED != 0 ->
            "Waiting for glasses"
        @Suppress("DEPRECATION")
        BluetoothAdapter.getDefaultAdapter()?.isEnabled == false ->
            "Bluetooth is off"
        else -> "Pair your glasses to get started"
    }

    private fun updateStatusNotification(state: Int) {
        if (!core.isEnabled) return
        val text = statusText(state)
        if (text == lastNotifiedStatus) return
        lastNotifiedStatus = text
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildStatusNotification(state))
    }

    /**
     * Resolves the assistant from installed principals as well as live registrations because the
     * normal plugin state is dormant and therefore has no binder registration. The current grant
     * remains the authority; a live registration, when present, must agree with it.
     */
    private fun approvedAssistantPrincipal(): PhonePluginPrincipal? {
        if (!::externalPluginController.isInitialized ||
            !::pluginDiscovery.isInitialized ||
            !::pluginGrantStore.isInitialized
        ) {
            return null
        }
        val activePluginId = externalPluginController.activeId()
        val installed = runCatching(::installedPluginPrincipals).getOrDefault(emptyList())
        val live = core.registeredPrincipals()
        return (installed + live)
            .distinctBy(PhonePluginPrincipal::grantKey)
            .filter { principal ->
                if (PluginCapability.ASSISTANT !in principal.descriptor.requestedCapabilities) {
                    return@filter false
                }
                val currentGrant = pluginGrantStore.stateFor(principal) as? PluginGrantState.Approved
                    ?: return@filter false
                if (PluginCapability.ASSISTANT !in currentGrant.capabilities) return@filter false
                val registered = core.grantedCapabilities(principal)
                registered == null ||
                    PluginCapability.ASSISTANT in registered
            }
            .sortedWith(
                compareBy<PhonePluginPrincipal>(
                    { it.descriptor.id != activePluginId },
                    { it.descriptor.id },
                    { it.packageName },
                ),
            )
            .firstOrNull()
    }

    private fun errorEnvelope(id: String, code: String, pluginId: String? = null): BusEnvelope =
        BusEnvelope(
            path = BusPaths.ERROR,
            id = id,
            payload = JSONObject().put("code", code).put("forId", id).apply {
                if (pluginId != null) put("pluginId", pluginId)
            },
        )

    private fun baseCameraCapabilities(): Int {
        var capabilities = 0
        if (::cameraConsumerReadiness.isInitialized && cameraConsumerReadiness.isReady()) {
            capabilities = capabilities or BusCapabilityBits.CAMERA_CONSUMER_READY
            val consumer = cameraConsumerReadiness.resolveApproved()
            if (consumer?.descriptor?.receivePrefixes?.contains(BusPaths.CAMERA_FREEZE_IMAGE_CHUNK) == true &&
                core.linkState() and LinkStateBits.SPP_DATA_UP != 0
            ) {
                capabilities = capabilities or BusCapabilityBits.CAMERA_FROZEN_SPP
            }
        }
        return capabilities
    }

    private fun phoneCameraCapabilities(): Int {
        val wifiEnabled = runCatching {
            getSystemService(WifiManager::class.java)?.isWifiEnabled
        }.getOrNull()
        return PhoneHubCameraCapabilityPolicy.applyLohsRequirement(baseCameraCapabilities(), wifiEnabled)
    }

    private fun pushDebugImageWhenReady() {
        repeat(20) {
            if (core.capabilities() and BusCapabilityBits.IMAGE_SURFACE != 0) {
                pushDebugImage()
                return
            }
            sleepQuietly(250L)
        }
        log("debug image probe failed code=${ImageSurfaceContract.ERROR_CAPABILITY_NOT_AVAILABLE}")
    }

    private fun pushDebugImage() {
        val resourceId = resources.getIdentifier("image_surface_sample", "raw", packageName)
        if (resourceId == 0) {
            log("debug image probe failed code=RESOURCE_MISSING")
            return
        }
        val bytes = runCatching { resources.openRawResource(resourceId).use { it.readBytes() } }
            .getOrElse {
                log("debug image probe failed code=RESOURCE_READ_FAILED")
                return
            }
        val envelope = BusEnvelope(
            path = BusPaths.SURFACE_SHOW,
            payload = JSONObject()
                .put("surfaceId", "debug:image")
                .put("seq", debugImageSeq.incrementAndGet())
                .put("kind", ImageSurfaceContract.KIND)
                .put("imageVersion", ImageSurfaceContract.VERSION)
                .put("contentKey", "debug-tree-v1")
                .put("mimeType", ImageSurfaceContract.MIME_JPEG)
                .put("pixelWidth", 480)
                .put("pixelHeight", 480)
                .put("sha256", ImageSurfaceContract.sha256(bytes))
                .put("title", "Nexus image probe")
                .put("caption", "Phone hub to glasses over SPP")
                .put("footer", "debug build"),
            binary = bytes,
        )
        // Validated as any built-in surface is, then sent.
        val sendError = core.sendBuiltInPluginEnvelope(envelope)
        if (sendError == null) {
            log("debug image probe sent bytes=${bytes.size} surfaceId=debug:image")
        } else {
            log("debug image probe failed code=$sendError")
        }
    }

    private fun isDebuggableBuild(): Boolean =
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun log(message: String) {
        Log.i(TAG, message)
        NexusPhoneState.recordLogLine(message)
        sendBroadcast(Intent(ACTION_LOG).setPackage(packageName).putExtra("line", message))
    }

    private fun sleepQuietly(ms: Long) {
        try {
            Thread.sleep(ms)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
    }

    companion object {
        @Volatile private var activeInstance: BusHubService? = null
        private val lastGlassesSetupUserIntentAtMillis = AtomicLong(0L)

        // Process-wide so the inspector can read events across service restarts.
        val busJournal = PluginBusJournal()

        fun onPluginAuthorizationChanged(context: android.content.Context, key: PluginGrantKey) {
            PhoneClientSupervisor.onPrincipalRevoked(context.applicationContext, key)
            activeInstance?.core?.authorizationChanged(key)
        }

        /** The wearer changed a per-operation skill approval on the Plugin access screen. */
        fun onSkillGrantsChanged() {
            activeInstance?.let { service ->
                if (service::skillsCoordinator.isInitialized) {
                    service.skillsExecutor.execute { service.skillsCoordinator.onSkillGrantsChanged() }
                }
            }
        }

        private const val GLASSES_FILES_ROOT = "/core/files"
        private const val SKILL_TOKEN_ALPHABET =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        private val SKILL_PATHS = setOf(
            BusPaths.SKILLS_CATALOG_REQUEST,
            BusPaths.SKILLS_INVOKE,
            BusPaths.SKILLS_CANCEL,
            BusPaths.SKILLS_SESSION_CLOSE,
            BusPaths.SKILLS_PROVIDER_RESULT,
        )

        internal fun onActivityPresentationPreferenceChanged() {
            activeInstance?.core?.announcePhoneCapabilities()
        }

        internal fun onHudPositionPreferenceChanged() {
            activeInstance?.core?.announcePhoneCapabilities()
        }

        internal fun onGlassesRepairSettingChanged() {
            activeInstance?.let { service ->
                service.executor.execute { service.pushGlassesRepairConfig() }
            }
        }

        internal fun isPhoneTtsReady(): Boolean =
            activeInstance?.core?.phoneTts?.isReady == true

        internal fun availablePhoneTtsVoices(locale: Locale?): List<PhoneTtsVoiceOption> =
            activeInstance?.core?.phoneTts?.availableVoices(locale) ?: emptyList()

        internal fun speakPhoneTtsSample(text: String, locale: Locale): Boolean =
            activeInstance?.core?.phoneTts?.speakSample(text, locale) == true

        fun pluginCatalog(context: android.content.Context): PluginCatalog =
            activeInstance?.pluginRegistry?.catalog()
                ?: context.applicationContext.let { appContext ->
                    PluginCatalog.build(
                        builtIns = emptyList(),
                        candidates = PhonePluginDiscovery(appContext.packageManager).discover(),
                        registryFeed = RegistryClient.create(appContext).cachedSnapshot()?.feed
                            ?: RegistryFeed(RegistryClient.SUPPORTED_VERSION, emptyList()),
                        grantState = PluginGrantStore(appContext)::stateFor,
                    )
                }

        fun pluginBusJournal(): PluginBusJournal? = activeInstance?.let { busJournal }

        internal fun openPlugin(pluginId: String): Boolean =
            activeInstance?.pluginRegistry?.openFromPhone(pluginId) == true

        internal fun stopBackgroundAudio(pluginId: String): Boolean {
            val service = activeInstance ?: return false
            if (!service::externalPluginController.isInitialized ||
                service.externalPluginController.backgroundId() != pluginId
            ) {
                return false
            }
            return service.core.revokeBackgroundAudioLease(pluginId, "USER_STOPPED")
        }

        internal fun manualPairingEngine(): GlassesManualPairingEngine? =
            activeInstance?.manualPairingEngine

        internal fun noteGlassesSetupUserIntent(
            nowMillis: Long = SystemClock.elapsedRealtime(),
        ) {
            if (nowMillis > 0L) lastGlassesSetupUserIntentAtMillis.set(nowMillis)
        }

        /**
         * Same-process hook for the future non-exported Speech settings activity. Transcript
         * callbacks are delivered directly and never enter the app's log broadcast.
         */
        internal fun startSpeechDictationTest(
            listener: SpeechUtteranceListener,
        ): SpeechStartResult =
            activeInstance?.core?.startSpeechDictationTest(listener)
                ?: SpeechStartResult.NO_LINK

        internal fun cancelSpeechDictationTest() {
            activeInstance?.core?.cancelSpeechDictationTest()
        }

        internal fun isSpeechDictationTestActive(): Boolean =
            activeInstance?.core?.isSpeechDictationTestActive() == true

        fun startWithToken(context: android.content.Context, token: String) {
            if (!canRunHub(context)) {
                Log.i(TAG, "startWithToken skipped: BLUETOOTH_CONNECT permission not granted")
                return
            }
            val intent = HubCommandIntents.create(context)
                .setAction(ACTION_SET_TOKEN)
                .putExtra(EXTRA_AUTH_TOKEN, token)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun start(context: android.content.Context) {
            if (!canRunHub(context)) {
                Log.i(TAG, "start skipped: BLUETOOTH_CONNECT permission not granted")
                return
            }
            val intent = HubCommandIntents.create(context)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun startDebugImage(context: android.content.Context) {
            if (!canRunHub(context)) {
                Log.i(TAG, "startDebugImage skipped: BLUETOOTH_CONNECT permission not granted")
                return
            }
            val intent = HubCommandIntents.create(context).setAction(ACTION_DEBUG_IMAGE)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun installGlassesApp(context: android.content.Context) {
            context.startService(
                HubCommandIntents.create(context).setAction(ACTION_INSTALL_GLASSES_APP),
            )
        }

        fun queryGlassesApp(context: android.content.Context) {
            context.startService(
                HubCommandIntents.create(context).setAction(ACTION_QUERY_GLASSES_APP),
            )
        }

        fun openGlassesApp(context: android.content.Context) {
            context.startService(
                HubCommandIntents.create(context).setAction(ACTION_OPEN_GLASSES_APP),
            )
        }

        fun startGlassesSetup(context: android.content.Context) {
            noteGlassesSetupUserIntent()
            context.startService(
                HubCommandIntents.create(context).setAction(ACTION_START_GLASSES_SETUP),
            )
        }

        /** Plain startService: callers are foreground UI; the hub must not re-promote itself. */
        fun stop(context: android.content.Context) {
            context.startService(
                HubCommandIntents.create(context).setAction(ACTION_STOP),
            )
        }

        fun isEnabled(context: android.content.Context): Boolean =
            context.getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(PREF_ENABLED, true)

        fun hasSavedAuthorization(context: android.content.Context): Boolean =
            context.getSharedPreferences(PREFS, MODE_PRIVATE)
                .getString(PREF_TOKEN, "")
                .orEmpty()
                .isNotBlank()

        fun canRunHub(context: android.content.Context): Boolean = HubCore.canRunHub(context)
    }

}
