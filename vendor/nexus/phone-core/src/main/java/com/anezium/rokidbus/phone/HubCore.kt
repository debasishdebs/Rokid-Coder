@file:OptIn(HubShellApi::class)

package com.anezium.rokidbus.phone

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothSocket
import android.graphics.BitmapFactory
import android.content.Context
import android.content.Intent
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
import com.anezium.rokidbus.shared.BusPaths
import com.anezium.rokidbus.shared.FrameProtocol
import com.anezium.rokidbus.shared.ForegroundSurfacePathPolicy
import com.anezium.rokidbus.shared.GlassesHubCapabilitiesContract
import com.anezium.rokidbus.shared.ImageSurfaceContract
import com.anezium.rokidbus.shared.ImageSurfaceMetadata
import com.anezium.rokidbus.shared.ImageSurfaceValidationResult
import com.anezium.rokidbus.shared.LinkStateBits
import com.anezium.rokidbus.shared.MediaArtworkContract
import com.anezium.rokidbus.shared.GlassesFilesContract
import com.anezium.rokidbus.shared.PhoneHubCapabilities
import com.anezium.rokidbus.shared.NoticeSurfaceContract
import com.anezium.rokidbus.shared.NoticeSurfaceValidationResult
import com.anezium.rokidbus.shared.PhoneHubCapabilitiesContract
import com.anezium.rokidbus.shared.PinSurfaceContract
import com.anezium.rokidbus.shared.SppAuthProtocol
import com.anezium.rokidbus.shared.SppHandshakeDeadline
import com.anezium.rokidbus.shared.SppKeyProvisioning
import com.anezium.rokidbus.shared.TtsContract
import com.anezium.rokidbus.shared.TtsDoneEvent
import com.anezium.rokidbus.shared.TtsValidationResult
import com.anezium.rokidbus.shared.plugin.PathRules
import com.anezium.rokidbus.shared.plugin.PluginCapability
import com.anezium.rokidbus.shared.plugin.PluginOpenTypes
import com.anezium.rokidbus.shared.plugin.PluginCapability.Companion.serialize
import com.anezium.rokidbus.ink.InkProblem
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
import com.anezium.rokidbus.shared.skills.SkillsContract
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.FutureTask
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import androidx.annotation.MainThread
import com.example.cxrglobal.callbacks.IGlassAppCbk as GlassAppCallback
import com.anezium.rokidbus.phone.speech.AndroidSttForegroundController
import com.anezium.rokidbus.phone.speech.AndroidSttSessionFactory
import com.anezium.rokidbus.phone.speech.SpeechEngine
import com.anezium.rokidbus.phone.speech.SpeechEngineRegistry
import com.anezium.rokidbus.phone.speech.SpeechReadiness
import com.anezium.rokidbus.shared.AppIdentity
import com.anezium.rokidbus.shared.plugin.PluginDescriptor
import android.content.ComponentName

private const val TAG = "ROKIDBUS-PHONE"
private const val PREF_LAST_GLASSES_ADDRESS = "last_glasses_address"
private const val PREFS = "rokidbus_phone"
private const val PREF_TOKEN = "cxrl_token"
private const val LOCAL_BINARY_MAX_BYTES = 512 * 1024
private const val AUDIO_LEASE_ACQUIRE = "/audio/lease/acquire"
private const val AUDIO_LEASE_RELEASE = "/audio/lease/release"
private const val AUDIO_FRAMES = "/audio/frames"
private const val AUDIO_LEASE_REVOKED = "/audio/lease/revoked"
private val NATIVE_ASSISTANT_EXIT_BURST_DELAYS_MILLIS = longArrayOf(0L, 50L, 150L, 300L)
private const val NATIVE_SCENES_LOG_LIMIT = 512
private const val CXR_AUDIO_PCM = 1
private const val AUDIO_SAMPLE_RATE = 16_000
private const val AUDIO_CHANNELS = 1
private const val AUDIO_ENCODING = "pcm16le"

/**
 * The phone side of the glasses link: CXR, SPP authentication, routing, the HUD tiers, input,
 * speech and the glasses install, as a plain class. The shell owns the Service that drives it.
 */
class HubCore internal constructor(
    private val context: Context,
    private val config: HubCoreConfig,
    private val seams: HubCoreSeams,
) : AutoCloseable {
    constructor(context: Context, config: HubCoreConfig) : this(context, config, HubCoreSeams())

    internal constructor(context: Context, config: HubCoreConfig, cxr: CxrTransport) :
        this(context, config, HubCoreSeams(cxr = cxr))

    private data class Registration(
        val clientId: String,
        val prefixes: List<String>,
        val uid: Int,
        val callbackBinder: IBinder,
        val callback: IBusCallback,
        val deathRecipient: IBinder.DeathRecipient,
        val principal: PhonePluginPrincipal? = null,
        val grantedCapabilities: Set<PluginCapability> = emptySet(),
    )

    private enum class AudioLeaseSide { LOCAL, REMOTE, INTERNAL }

    private data class AudioLease(
        val leaseId: String,
        val side: AudioLeaseSide,
        val localCallbackBinder: IBinder?,
        val holderPluginId: String?,
        val internalTag: String? = null,
        val internalConsumer: InternalAudioConsumer? = null,
        @Volatile var streamStarted: Boolean = false,
        var seq: Long = 0L,
    )

    private class SpeechBusSession(
        val sessionId: String,
        val callbackBinder: IBinder,
        val pluginId: String,
        val grantKey: PluginGrantKey,
        val stateSeq: AtomicLong = AtomicLong(),
        val partialSeq: AtomicLong = AtomicLong(),
        val accepted: AtomicBoolean = AtomicBoolean(),
        val ended: AtomicBoolean = AtomicBoolean(),
    ) {
        lateinit var listener: SpeechUtteranceListener
    }

    private val executor = Executors.newCachedThreadPool()
    private val speechBusExecutor = SerialExecutor(executor)
    private val audioHandler = Handler(Looper.getMainLooper())
    private val pinHandler = Handler(Looper.getMainLooper())
    private val inkResultHandler = Handler(Looper.getMainLooper())
    private val pinExpiryTick: Runnable = Runnable { pinRouter.expireCanonical() }
    private val activityHandler = Handler(Looper.getMainLooper())
    private val activityExpiryTick: Runnable = Runnable { activityRouter.expireCanonical() }
    private val assistantExitHandler = Handler(Looper.getMainLooper())
    private val assistSessionHandler = Handler(Looper.getMainLooper())
    private val registrations = CopyOnWriteArrayList<Registration>()
    private val assistSession = GlassesAssistSession()
    @HubShellApi @Volatile var cxrClosedByServer = false
        private set
    private val hudRouteSink: PhoneHudRouteSink = object : PhoneHudRouteSink {
        override fun capabilities(): Int = this@HubCore.capabilities()
        override fun pinLinkUp(): Boolean = this@HubCore.pinLinkUp()
        override fun log(message: String) = this@HubCore.log(message)
        override fun sendRemote(envelope: BusEnvelope): String? = this@HubCore.sendRemote(envelope)
        override fun deliverLocal(envelope: BusEnvelope, targetBinder: IBinder?): Boolean =
            this@HubCore.deliverLocal(envelope, targetBinder = targetBinder)
        override fun deliverError(targetBinder: IBinder?, id: String, code: String) =
            this@HubCore.deliverError(targetBinder, id, code)
        override fun recordLocalRoute(
            envelope: BusEnvelope,
            senderUid: Int,
            pluginId: String?,
            verdict: PluginBusJournal.Verdict,
            reason: String?,
        ) = this@HubCore.recordLocalRoute(envelope, senderUid, pluginId, verdict, reason)
        override fun recordRemoteRoute(
            envelope: BusEnvelope,
            verdict: PluginBusJournal.Verdict,
            reason: String?,
        ) = this@HubCore.recordRemoteRoute(envelope, verdict, reason)
    }
    private val noticeRouter = PhoneNoticeRouter(
        state = PhoneNoticeState(nowMs = { SystemClock.elapsedRealtime() }),
        sink = hudRouteSink,
    )
    private val pinRouter: PhonePinRouter = PhonePinRouter(
        state = PhonePinState(nowMs = { SystemClock.elapsedRealtime() }),
        sink = hudRouteSink,
        nowMs = SystemClock::elapsedRealtime,
        postExpiry = { delay -> pinHandler.postDelayed(pinExpiryTick, delay) },
        cancelExpiry = { pinHandler.removeCallbacks(pinExpiryTick) },
    )
    private val activityRouter: PhoneActivityRouter = PhoneActivityRouter(
        state = PhoneActivityState(nowMs = { SystemClock.elapsedRealtime() }),
        sink = hudRouteSink,
        nowMs = SystemClock::elapsedRealtime,
        postExpiry = { delay -> activityHandler.postDelayed(activityExpiryTick, delay) },
        cancelExpiry = { activityHandler.removeCallbacks(activityExpiryTick) },
    )
    private val surfaceRouter = PhoneSurfaceRouter(
        sink = hudRouteSink,
        onPluginSelfHid = ::onExternalSurfaceReleased,
    )
    private val inkRouter = PhoneInkRouter(
        sink = hudRouteSink,
        coordinator = PhoneInkSurfaceCoordinator(
            postResult = { action -> inkResultHandler.post { action() } },
        ),
        surfaceRouter = surfaceRouter,
    )
    private val imageSurfaceRateLimiter = ImageSurfaceRateLimiter()
    private val ttsRequestGate = PhoneTtsRequestGate()
    private lateinit var phoneTtsDispatcher: PhoneTtsDispatcher
    private val pluginBusJournal = config.journal
    private val sppLoopStarted = AtomicBoolean(false)
    private val audioLeaseArbitrator = SingleAudioLeaseArbitrator<AudioLease>()
    private val speechBusLock = Any()
    private var activeSpeechBusSession: SpeechBusSession? = null
    @Volatile private var sppLoopStop = false
    @Volatile private var hubEnabled = false
    private val sppLock = Any()
    private val sppDeadlines = Executors.newSingleThreadScheduledExecutor()
    private val sppNonces = SppAuthProtocol.RecentNonces()
    private val sppProvisioning = Executors.newSingleThreadExecutor()
    private val sppBackoff = SppReconnectBackoff()
    @Volatile private var sppKeyStatus: PhoneSppPairing.KeyStatus? = null
    private val sppCxrIdentity = SppCxrIdentity(
        schedule = { delay, task ->
            val future = sppDeadlines.schedule(task, delay, TimeUnit.MILLISECONDS)
            ({ future.cancel(false); Unit })
        },
        onReady = { revision ->
            sppBackoff.reset()
            offerSppKeyForCurrentCxr(revision)
        },
    )
    private val sppPairing by lazy {
        PhoneSppPairing(
            PhoneSppPairingStorage(applicationContext),
            hasCxrConnection = ::isCxrUp,
            onKeyStatus = ::updateSppKeyStatus,
        ) {
            sppCxrIdentity.current().takeIf { hubEnabled && !sppLoopStop && isCxrUp() }
        }
    }
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var sppSession: SppAuthProtocol.Session? = null
    private var cxrLink: CxrTransport? = null
    private lateinit var speechSettingsStore: SpeechSettingsStore
    private lateinit var speechSessionManager: SpeechSessionManager
    @Volatile private var speechMicrophoneForegroundRequested = false
    @Volatile private var speechMicrophoneForegroundActive = false
    @Volatile private var speechMicrophoneForegroundFailure = ""
    @Volatile private var cxrConnected = false
    @Volatile private var glassBtConnected = false
    @Volatile private var glassesWorn = false
    @Volatile private var lastAnnouncedPhoneCapabilities: PhoneHubCapabilities? = null
    @Volatile private var remoteImageSurfaceVersion = 0
    @Volatile private var remotePinSurfaceVersion = 0
    @Volatile private var remoteNoticeSurfaceVersion = 0
    @Volatile private var remoteActivitySurfaceVersion = 0
    @Volatile private var remoteActivityExtrasVersion = 0
    @Volatile private var remoteInkSurfaceVersion = 0
    @Volatile private var remoteEditableSurfaceVersion = 0
    @Volatile private var remoteMaxImageBytes = 0
    @Volatile private var remoteGlassesVersionName: String? = null
    @Volatile private var lastTransportLinkState = 0
    private val binder = object : IBusService.Stub() {
        override fun apiVersion(): Int = BusConstants.API_VERSION

        override fun register(clientId: String, pathPrefixes: Array<out String>, cb: IBusCallback) {
            val callingUid = Binder.getCallingUid()
            if (callingUid != Process.myUid() && !isDebuggableBuild()) {
                log("legacy client registration rejected status=release_external")
                return
            }
            val prefixes = pathPrefixes.mapNotNull(PathRules::normalizeAbsolute)
            if (prefixes.size != pathPrefixes.size) {
                log("legacy client registration rejected status=invalid_paths")
                return
            }
            if (callingUid != Process.myUid()) {
                log("legacy client registration allowed status=debug_compatibility")
            }
            addRegistration(clientId, prefixes, callingUid, cb)
        }

        override fun unregister(cb: IBusCallback) {
            removeRegistrationsByBinder(cb.asBinder(), "unregister")
        }

        override fun send(path: String, id: String, payload: ByteArray) {
            val json = runCatching { JSONObject(String(payload, Charsets.UTF_8)) }.getOrElse { JSONObject() }
            routeLocal(BusEnvelope(path = path, id = id, payload = json), Binder.getCallingUid())
        }

        override fun sendBinary(path: String, id: String, meta: ByteArray, data: ByteArray) {
            val json = runCatching { JSONObject(String(meta, Charsets.UTF_8)) }.getOrElse { JSONObject() }
            routeLocal(BusEnvelope(path = path, id = id, payload = json, binary = data), Binder.getCallingUid())
        }

        override fun linkState(): Int = this@HubCore.linkState()

        override fun capabilities(): Int = this@HubCore.capabilities()

        /**
         * Answered from the registration this UID already holds, so it can only ever
         * describe the caller: an unknown plugin id, another app's id, or a caller with
         * no live registration all get "" rather than somebody else's grants.
         */
        override fun approvedCapabilities(pluginId: String): String {
            val callingUid = Binder.getCallingUid()
            val registration = registrations.firstOrNull { registration ->
                registration.uid == callingUid &&
                    registration.principal?.descriptor?.id == pluginId
            } ?: return ""
            return PluginCapability.serialize(registration.grantedCapabilities)
        }

        override fun registerPlugin(packageName: String, pluginId: String, cb: IBusCallback): Int {
            val callingUid = Binder.getCallingUid()
            val admission = hooks.admitPlugin(packageName, pluginId, callingUid)
            if (admission is PluginAdmission.Rejected) {
                return pluginRegistrationResult(pluginId, admission.result, admission.reason)
            }
            val principal = (admission as PluginAdmission.Approved).principal
            val prefixes = principal.descriptor.receivePrefixes.filter { prefix ->
                PathRules.requiredCapabilityForReceivePrefix(prefix)?.let { it in admission.capabilities } != false
            }
            return if (addRegistration(
                    clientId = principal.descriptor.id,
                    prefixes = prefixes,
                    uid = callingUid,
                    cb = cb,
                    principal = principal,
                    grantedCapabilities = admission.capabilities,
                )
            ) {
                notifyPluginRegistration(principal, admission.capabilities, cb)
                hooks.onPluginRegistered(principal)
                log("plugin registered package=$packageName plugin=$pluginId status=approved")
                pluginRegistrationResult(pluginId, PluginRegistrationResult.APPROVED)
            } else {
                pluginRegistrationResult(
                    pluginId,
                    PluginRegistrationResult.REGISTRATION_FAILED,
                    "CALLBACK_UNAVAILABLE",
                )
            }
        }
    }

    private val linkCallback = object : ICXRLinkCbk {
        override fun onCXRLConnected(connected: Boolean) {
            cxrConnected = connected
            sppCxrIdentity.onConnectionChanged(isCxrUp())
            if (connected) {
                if (cxrClosedByServer) log("CXR-L closed-session flag cleared: link up")
                cxrClosedByServer = false
            } else {
                glassesWorn = false
                clearGlassesSessionState()
            }
            log("CXR-L connected=$connected")
            notifyLinkState()
            if (!connected) glassesAppSlot.failDispatched()
            if (!isCxrUp()) {
                revokeAudioLease("LINK_DOWN")
            }
        }

        override fun onCXRLDisconnectedByServer() {
            // Hi Rokid closed the session on its side. The wrapper unbinds and reports the link
            // down next if it had been reported up; no automatic rebind, which would fight
            // whatever made Hi Rokid close it. The status notification says so, also for a
            // session closed during setup; tapping it opens Nexus, which reconnects.
            cxrClosedByServer = true
            log("CXR-L session closed by Hi Rokid")
            notifyLinkState()
        }

        override fun onGlassBtConnected(connected: Boolean) {
            glassBtConnected = connected
            sppCxrIdentity.onConnectionChanged(isCxrUp())
            if (!connected) {
                glassesWorn = false
                clearGlassesSessionState()
            }
            log("Hi Rokid glass BT connected=$connected")
            notifyLinkState()
            if (!connected) glassesAppSlot.failDispatched()
            if (!isCxrUp()) {
                revokeAudioLease("LINK_DOWN")
            }
        }

        override fun onGlassDeviceInfo(info: GlassInfo) {
            sppCxrIdentity.onDeviceInfo(info.sn, info.deviceName)
            notifyGlassesDeviceInfo(info)
        }

        override fun onGlassWearingStatus(wearing: Boolean) {
            glassesWorn = wearing
            notifyLinkState()
        }

        override fun onGlassCurrentScenesNotify(scenesJson: String?) {
            // The report's format is still unknown: release logs carry its structure, debug logs
            // the report itself, so the first device capture can settle what it means.
            if (isDebuggableBuild()) {
                log("Hi Rokid scenes raw=${scenesJson.orEmpty().take(NATIVE_SCENES_LOG_LIMIT)}")
            }
            if (!assistSession.onScenesReport(scenesJson)) return
            log(
                "Hi Rokid native scenes shape=${assistSession.scenesShape} " +
                    "running=${assistSession.scenes.joinToString(",").ifEmpty { "none" }}",
            )
        }

        override fun onGlassAiAssistStart() {
            val takeoverEnabled = hooks.assistTakeoverEnabled()
            when (assistSession.onPressStart(isCxrUp(), takeoverEnabled)) {
                GlassesAssistSession.Press.LINK_DOWN -> {
                    log("assistant gesture ignored: CXR link down")
                    return
                }
                // Paused from the glasses or the phone: the native scene the ROM just opened is
                // exactly what the wearer asked for, so there is nothing to dismiss and nobody to wake.
                GlassesAssistSession.Press.TAKEOVER_PAUSED -> {
                    log("assistant gesture left to Rokid: takeover paused")
                    return
                }
                GlassesAssistSession.Press.NATIVE_SCENE -> {
                    log(
                        "assistant gesture left to Rokid: native " +
                            "${assistSession.scenes.joinToString(",")} running",
                    )
                    return
                }
                GlassesAssistSession.Press.ALREADY_HELD -> return
                GlassesAssistSession.Press.TAKE_OVER -> Unit
            }
            // Waking the plugin can hide the previous one's surfaces and the dismiss can fall back
            // to an SPP write; neither belongs on the main thread this press arrived on.
            val session = assistSession.generation
            val press = assistSession.press
            executor.execute {
                if (assistSession.isCurrent(session)) hooks.onAssistGesture(session, press)
            }
        }

        override fun onGlassAiAssistStop() {
            // Also reached as the echo of our own sendExit burst (the native
            // scene closing reports onAiExit). Must stay side-effect-free
            // beyond flag/notify: capture stop belongs to the plugin's VAD,
            // and anything stronger here would let the burst cancel it.
            assistSession.onPressStop()
            notifyGlassesAiButton(active = false)
        }
    }

    // An already-active assistant hears of the press on main, in order with the release handled
    // there. A press released by then is delivered whole, so the plugin's own button gate is not
    // left held with no release to follow.
    private fun signalWarmPress(session: Int, press: Int) {
        if (!assistSession.isCurrent(session)) return
        notifyGlassesAiButton(active = true)
        if (!assistSession.isHeld(press)) notifyGlassesAiButton(active = false)
    }

    // Glasses BT down arrives on a binder thread; the session ends on main, after any scene report
    // or press already queued there.
    private fun clearGlassesSessionState() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            assistSessionHandler.post { clearGlassesSessionState() }
            return
        }
        if (assistSession.clear()) notifyGlassesAiButton(active = false)
    }

    // Phone-side kill of the native assistant popup, complementing the
    // glasses-side BACK burst: Hi Rokid's exported service forwards sendExit
    // to the scene the gesture just opened. A single shot can lose the race
    // against the scene's opening animation, hence the spaced repeats.
    @HubShellApi fun sendNativeAssistantExitBurst(gestureId: String, session: Int) {
        val link = cxrLink ?: return
        for (delayMs in NATIVE_ASSISTANT_EXIT_BURST_DELAYS_MILLIS) {
            assistantExitHandler.postDelayed({
                // A shot outlives neither the session that took the press nor a native scene
                // reported since: the link object is reused by the next session.
                if (!assistSession.isCurrent(session)) return@postDelayed
                if (assistSession.nativeSceneRunning()) {
                    log(
                        "assistant native exit burst delay=${delayMs}ms skipped: " +
                            "native scene gestureId=$gestureId",
                    )
                    return@postDelayed
                }
                val sent = link.sendExit(false)
                log("assistant native exit burst delay=${delayMs}ms sent=$sent gestureId=$gestureId")
            }, delayMs)
        }
    }

    private val audioCallback = object : IAudioStreamCbk {
        override fun onAudioReceived(data: ByteArray, offset: Int, length: Int) {
            runCatching {
                forwardAudioFrame(data, offset, length)
            }.onFailure {
                log("CXR audio frame failed ${it.javaClass.simpleName}: ${it.message}")
            }
        }

        override fun onAudioError(code: Int, msg: String?) {
            log("CXR audio error code=$code msg=${msg.orEmpty()}")
            revokeAudioLease("LINK_DOWN")
        }

        override fun onAudioStreamStateChanged(started: Boolean) {
            log("CXR audio stream state started=$started")
        }
    }

    private val customCmdCallback = object : ICustomCmdCbk {
        override fun onCustomCmdResult(key: String, payload: ByteArray) {
            // Every way out of this callback says so. A frame that reaches the phone's Rokid app
            // and then vanishes here used to leave no trace at all, which made "the callback was
            // never invoked" and "the callback ran and dropped the frame" impossible to tell apart
            // from a log - the two have completely different causes.
            if (key != BusConstants.CXR_KEY) {
                log("CXR RX ignored: key=$key")
                return
            }
            val envelope = decodeCxrPayload(payload)
            if (envelope == null) {
                log("CXR RX undecodable: ${payload.size} bytes")
                return
            }
            if (SppKeyProvisioning.isReserved(envelope.path)) return
            log("CXR RX ${envelope.path} id=${envelope.id}")
            routeRemote(envelope)
        }
    }

    private val hooks: HubShellHooks = config.hooks

    /** The shell's application-id pair; the core names an app only through it. */
    val identity: AppIdentity = config.identity
    private val applicationContext: Context get() = context.applicationContext
    private val packageManager: PackageManager get() = context.packageManager
    private val packageName: String get() = context.packageName
    private val applicationInfo: ApplicationInfo get() = context.applicationInfo
    private fun <T> getSystemService(serviceClass: Class<T>): T? = context.getSystemService(serviceClass)
    private fun getSharedPreferences(name: String, mode: Int) = context.getSharedPreferences(name, mode)
    private fun canRunHub(core: HubCore): Boolean = HubCore.canRunHub(core.context)
    private fun updateStatusNotification(state: Int) = config.foreground.onLinkStateChanged(state)

    // The in-process app is a plugin principal like any other, never PluginRouteCaller.Internal:
    // the same-UID shortcut in resolveSender would skip its capability checks and owner stamping.
    private val inProcessPrincipal: PhonePluginPrincipal? = config.inProcessApp?.let { app ->
        PhonePluginPrincipal(
            packageName = context.packageName,
            serviceComponent = ComponentName(context.packageName, IN_PROCESS_COMPONENT),
            uid = Process.myUid(),
            signingDigestSha256 = IN_PROCESS_DIGEST,
            descriptor = PluginDescriptor(
                id = app.pluginId,
                displayName = app.displayName,
                apiVersion = BusConstants.API_VERSION,
                requestedCapabilities = app.capabilities,
                receivePrefixes = app.receivePrefixes,
                settingsActivity = null,
                launchable = true,
                iconKey = app.iconKey,
            ),
        )
    }

    // One thread, FIFO: the in-process app never blocks on a Bluetooth write and its calls keep
    // their order, as oneway calls to one binder do.
    private val localIngress = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "nexus-local-ingress")
    }

    private val inProcessHub = object : InProcessHub {
        override fun addRegistration(callback: IBusCallback): Boolean {
            val app = config.inProcessApp ?: return false
            val principal = inProcessPrincipal ?: return false
            return this@HubCore.addRegistration(
                clientId = app.pluginId,
                prefixes = app.receivePrefixes,
                uid = Process.myUid(),
                cb = callback,
                principal = principal,
                grantedCapabilities = app.capabilities,
            )
        }

        override fun announceRegistration(callback: IBusCallback) {
            val app = config.inProcessApp ?: return
            val principal = inProcessPrincipal ?: return
            notifyPluginRegistration(principal, app.capabilities, callback)
        }

        override fun removeRegistration(callback: IBusCallback) {
            removeRegistrationsByBinder(callback.asBinder(), "unregister")
        }

        override fun route(envelope: BusEnvelope, callback: IBusCallback): Boolean {
            val app = config.inProcessApp ?: return false
            val sender = AuthorizedSender(
                PluginRouteCaller.Plugin(app.pluginId, app.capabilities),
                callback.asBinder(),
                inProcessPrincipal,
            )
            return runCatching {
                localIngress.execute { routeLocal(envelope, Process.myUid(), sender) }
            }.isSuccess
        }

        override fun capabilities(): Int = this@HubCore.capabilities()
    }

    private val foregroundPort = object : SingleAppForeground.Port {
        override fun deliver(path: String, id: String, payload: JSONObject): Boolean {
            val principal = inProcessPrincipal ?: return false
            return deliverExternalLifecycle(principal, path, id, payload)
        }

        override fun sendRemote(envelope: BusEnvelope): String? = this@HubCore.sendRemote(envelope)

        override fun hideSurfaces(pluginId: String) = hideExternalSurfaces(pluginId)

        override fun hideNotice(pluginId: String, reason: String) {
            noticeRouter.clearForRevokedOwner(pluginId, reason)
        }
    }

    private val foregroundPolicy: HubForegroundPolicy = hooks.foreground()
        ?: config.inProcessApp?.let { app -> SingleAppForeground(app, foregroundPort) }
        ?: SingleAppForeground.None

    private val glassesAppSlot = GlassesAppSlot { cxrLink }

    private val inProcessSurface: InProcessGlassesSurface? =
        config.inProcessApp?.let { app -> InProcessGlassesSurface(app, inProcessHub) }

    private val microphoneForeground = object : AndroidSttForegroundController {
        override fun acquire(): SttError? = requestSpeechMicrophoneForegroundOnMain()

        override fun release() {
            releaseSpeechMicrophoneForegroundOnMain()
        }
    }

    @Volatile private var closed = false

    /** The speech engines; only the Android recognizer unless a shell registers more before start(). */
    val speech: SpeechEngineRegistry = SpeechEngineRegistry()

    /** Installs the glasses app over CXR, verifying every APK before it is pushed. */
    val glassesInstaller: GlassesAppInstaller = CxrGlassesAppInstaller(
        slot = glassesAppSlot,
        link = { cxrLink },
        linkUp = ::isCxrUp,
        wifiEnabled = ::isPhoneWifiEnabled,
        sessionPackage = identity.glassesApplicationId,
        workDirectory = { File(context.noBackupFilesDir, "glasses-install") },
        announcedVersionName = { remoteGlassesVersionName },
    )

    init {
        val phoneSpeakerRouteProbe = PhoneSpeakerRouteProbe(applicationContext) {
            prefs().getString(PREF_LAST_GLASSES_ADDRESS, null)
        }
        val phoneTtsSettings = PhoneTtsSettingsStore(applicationContext)
        phoneTtsDispatcher = PhoneTtsDispatcher(
            playback = PhoneTtsPlayback(
                output = seams.ttsOutput ?: PhoneTtsEngine(applicationContext, ::log),
                defaultLocale = { phoneTtsSettings.speechLocale() },
                emitStarted = ::emitPhoneTtsStarted,
                emitDone = ::emitPhoneTtsDone,
            ),
            emitDone = ::emitPhoneTtsDone,
            phoneRoute = seams.ttsRoute ?: phoneSpeakerRouteProbe::classifyRoute,
            logger = ::log,
        )
        phoneTtsDispatcher.initialize()
        speech.register(
            SpeechEngine.ANDROID_RECOGNIZER,
            AndroidSttSessionFactory(applicationContext, microphoneForeground, seams.recognizer),
        ) { SpeechReadiness.READY }
        speechSettingsStore = SpeechSettingsStore(applicationContext)
        speechSessionManager = SpeechSessionManager(
            context = applicationContext,
            settings = speechSettingsStore,
            registry = speech,
            internalAudio = object : InternalAudioAccess {
                override fun acquireInternalAudio(
                    tag: String,
                    consumer: InternalAudioConsumer,
                ): InternalAudioAcquireResult =
                    this@HubCore.acquireInternalAudio(tag, consumer)

                override fun releaseInternalAudio(tag: String) {
                    this@HubCore.releaseInternalAudio(tag)
                }
            },
        )
    }

    /**
     * Main thread. Enables the hub: turns the gate on, connects the in-process app, starts CXR if
     * a token is stored and the SPP loop once per core. Idempotent; callable again after stop().
     */
    @MainThread
    fun start() {
        check(!closed) { "HubCore is closed" }
        speech.seal()
        hubEnabled = true
        inProcessSurface?.onCoreStarted()
        startCxrIfTokenAvailable()
        connectSpp()
    }

    /**
     * Main thread. Disables the hub and releases the radios. The gate goes off first, so a
     * handshake in flight aborts and no key is offered. Idempotent.
     */
    @MainThread
    fun stop() {
        hubEnabled = false
        inProcessSurface?.onCoreStopping()
        foregroundPolicy.closeAll("hub_stopped")
        if (::speechSessionManager.isInitialized) speechSessionManager.cancel()
        stopAudioLease(InternalAudioStopReason.HUB_STOPPED)
        activityRouter.clearAllForHubStop()
        glassesAppSlot.failDispatched()
        runCatching { cxrLink?.disconnect() }
        cxrLink = null
        cxrConnected = false
        glassBtConnected = false
        cxrClosedByServer = false
        sppCxrIdentity.onConnectionChanged(false)
        glassesWorn = false
        clearGlassesSessionState()
        closeSocket()
        notifyLinkState()
        log("Hub stopped; SPP socket and CXR-L session released")
    }

    /** Main thread. Terminal: stop(), then end the SPP loop and the executors. Idempotent. */
    @MainThread
    override fun close() {
        if (closed) return
        stop()
        pinHandler.removeCallbacks(pinExpiryTick)
        inkResultHandler.removeCallbacksAndMessages(null)
        activityHandler.removeCallbacks(activityExpiryTick)
        activityRouter.clearAllForHubStop()
        sppLoopStop = true
        sppBackoff.reset()
        sppCxrIdentity.onConnectionChanged(false)
        sppDeadlines.shutdownNow()
        sppProvisioning.shutdownNow()
        if (::speechSessionManager.isInitialized) speechSessionManager.close()
        stopAudioLease(InternalAudioStopReason.HUB_STOPPED)
        if (::phoneTtsDispatcher.isInitialized) phoneTtsDispatcher.shutdown()
        runCatching { cxrLink?.disconnect() }
        closeSocket()
        inkRouter.close()
        registrations.clear()
        localIngress.shutdown()
        closed = true
    }

    /** The in-process app's surface. One instance per core. */
    fun surface(): GlassesSurface =
        checkNotNull(inProcessSurface) { "HubCore has no in-process app" }

    @HubShellApi fun deliverQueued(envelope: BusEnvelope): Boolean =
        deliverLocal(envelope)

    private fun routeLocal(envelope: BusEnvelope, senderUid: Int) =
        routeLocal(envelope, senderUid, resolveSender(senderUid))

    private fun routeLocal(envelope: BusEnvelope, senderUid: Int, sender: AuthorizedSender) {
        if (SppKeyProvisioning.isReserved(envelope.path)) return
        if (GlassesFilesContract.isFilesPath(envelope.path)) {
            // The explorer talks to the glasses directly; no local caller, debug or not, may.
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, "TRUSTED_LOCAL_ONLY")
            deliverError(sender.replyBinder, envelope.id, "TRUSTED_LOCAL_ONLY")
            return
        }
        if (isGlassesControlRequest(envelope.path)) {
            val strictlyHubOwned = isStrictlyHubOwnedGlassesPath(envelope.path)
            val trustedLocal = senderUid == Process.myUid() && sender.caller == PluginRouteCaller.Internal
            if (!trustedLocal && (strictlyHubOwned || !isDebuggableBuild())) {
                recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, "TRUSTED_LOCAL_ONLY")
                deliverError(sender.replyBinder, envelope.id, "TRUSTED_LOCAL_ONLY")
                return
            }
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.OK)
            executor.execute { handleGlassesControlRequest(envelope, sender) }
            return
        }
        if (!protectedPathAllowed(envelope.path, senderUid, sender.principal)) {
            val code = if (BusPaths.isProtectedMediaSyncPath(envelope.path)) {
                "PROTECTED_MEDIASYNC_PATH"
            } else {
                "PROTECTED_CAMERA_PATH"
            }
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, code)
            deliverError(sender.replyBinder, envelope.id, code)
            return
        }
        val decision = PluginRoutePolicy.authorize(sender.caller, envelope.path)
        if (decision is PluginRouteDecision.Denied) {
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, decision.code)
            deliverError(sender.replyBinder, envelope.id, decision.code)
            return
        }
        val leaseDenial = sender.principal
            ?.let { principal -> hooks.leaseRestriction(principal, envelope.path) }
        if (leaseDenial != null) {
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, leaseDenial)
            deliverError(sender.replyBinder, envelope.id, leaseDenial)
            return
        }
        if (envelope.path == BusPaths.TTS_SPEAK || envelope.path == BusPaths.TTS_STOP) {
            handleLocalTts(envelope, senderUid, sender)
            return
        }
        val invalidHud = when {
            pinRouter.matches(envelope.path) -> pinRouter.invalidLocalReason(envelope)
            noticeRouter.matches(envelope.path) -> noticeRouter.invalidLocalReason(envelope)
            activityRouter.matches(envelope.path) -> activityRouter.invalidLocalReason(envelope)
            else -> null
        }
        if (invalidHud != null) {
            recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, invalidHud)
            deliverError(sender.replyBinder, envelope.id, invalidHud)
            return
        }
        val ownedEnvelope = if (
            sender.principal != null &&
            PathRules.requiredCapability(envelope.path) in setOf(
                PluginCapability.SURFACES,
                PluginCapability.INK_SURFACE,
            )
        ) {
            val payload = PluginRoutePolicy.injectSurfaceOwner(sender.principal.descriptor.id, envelope.payload)
            if (payload == null) {
                val error = if (
                    envelope.path == BusPaths.PIN_SHOW || envelope.path == BusPaths.PIN_HIDE
                ) {
                    PinSurfaceContract.ERROR_INVALID_PIN
                } else if (noticeRouter.matches(envelope.path)) {
                    NoticeSurfaceContract.ERROR_INVALID_NOTICE
                } else if (activityRouter.matches(envelope.path)) {
                    ActivitySurfaceContract.ERROR_INVALID_ACTIVITY
                } else {
                    "INVALID_SURFACE_ID"
                }
                recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, error)
                deliverError(sender.replyBinder, envelope.id, error)
                return
            }
            envelope.copy(payload = payload)
        } else {
            envelope
        }
        if (ownedEnvelope.path == BusPaths.SURFACE_SHOW || ownedEnvelope.path == BusPaths.SURFACE_UPDATE) {
            val imageError = validateSurfaceImageEnvelope(ownedEnvelope)
            if (imageError != null) {
                recordLocalRoute(ownedEnvelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, imageError)
                deliverError(sender.replyBinder, ownedEnvelope.id, imageError)
                return
            }
        }
        if (
            sender.principal != null &&
            // A plugin that answers its PLUGIN_OPEN on any owner-drawn tier is
            // alive; a notice-only assistant must not be rebound as unresponsive.
            // This must run before the tier dispatches below return -- including
            // the notice image check, which rejects and returns.
            ownedEnvelope.path in setOf(
                BusPaths.SURFACE_SHOW, BusPaths.SURFACE_UPDATE, BusPaths.SURFACE_HIDE,
                BusPaths.NOTICE_SHOW, BusPaths.NOTICE_UPDATE, BusPaths.NOTICE_HIDE,
                BusPaths.PIN_SHOW, BusPaths.PIN_HIDE,
                BusPaths.ACTIVITY_START, BusPaths.ACTIVITY_UPDATE, BusPaths.ACTIVITY_END,
                BusPaths.INK_SHOW, BusPaths.INK_UPDATE, BusPaths.INK_HIDE,
            )
        ) {
            foregroundPolicy.onSurfaceTraffic(sender.principal.descriptor.id)
        }
        if (ownedEnvelope.path == BusPaths.NOTICE_SHOW && ownedEnvelope.binary != null) {
            val validation = NoticeSurfaceContract.validateShow(
                ownedEnvelope.payload,
                ownedEnvelope.binary,
            )
            val metadata = (validation as? NoticeSurfaceValidationResult.Valid)
                ?.content
                ?.image
            val imageError = if (
                metadata == null || validateDecodedImageEnvelope(ownedEnvelope, metadata) != null
            ) {
                NoticeSurfaceContract.ERROR_INVALID_NOTICE
            } else {
                null
            }
            if (imageError != null) {
                recordLocalRoute(
                    ownedEnvelope,
                    senderUid,
                    sender,
                    PluginBusJournal.Verdict.REJECTED,
                    imageError,
                )
                deliverError(sender.replyBinder, ownedEnvelope.id, imageError)
                return
            }
        }
        if (pinRouter.matches(ownedEnvelope.path)) {
            pinRouter.handleLocal(ownedEnvelope, sender.toHudSender(senderUid))
            return
        }
        if (noticeRouter.matches(ownedEnvelope.path)) {
            noticeRouter.handleLocal(ownedEnvelope, sender.toHudSender(senderUid))
            return
        }
        if (activityRouter.matches(ownedEnvelope.path)) {
            activityRouter.handleLocal(ownedEnvelope, sender.toHudSender(senderUid))
            return
        }
        if (
            sender.principal != null &&
            ForegroundSurfacePathPolicy.isShowOrUpdate(ownedEnvelope.path) &&
            !foregroundPolicy.allowSurface(sender.principal, ownedEnvelope.path)
        ) {
            recordLocalRoute(ownedEnvelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, "SURFACE_BUSY")
            if (PathRules.requiredCapability(ownedEnvelope.path) == PluginCapability.INK_SURFACE) {
                inkRouter.deliverProblems(
                    inkRouter.ownerFrom(ownedEnvelope),
                    ownedEnvelope.id,
                    sender.replyBinder,
                    listOf(InkProblem("SURFACE_BUSY", "Another plugin owns the foreground surface")),
                )
            } else {
                deliverError(sender.replyBinder, ownedEnvelope.id, "SURFACE_BUSY")
            }
            log("surface rejected path=${ownedEnvelope.path} plugin=${sender.principal.descriptor.id} reason=foreground_busy")
            return
        }
        if (inkRouter.matches(ownedEnvelope.path)) {
            inkRouter.handleLocal(ownedEnvelope, sender.toHudSender(senderUid))
            return
        }
        val authorizedEnvelope = if (
            sender.principal != null &&
            ownedEnvelope.path in setOf(
                BusPaths.SURFACE_SHOW,
                BusPaths.SURFACE_UPDATE,
                BusPaths.SURFACE_HIDE,
            )
        ) {
            surfaceRouter.withMetadata(
                ownedEnvelope,
                sender.principal.descriptor.id,
                closeOnHide = true,
            )
        } else {
            ownedEnvelope
        }
        if (hooks.onLocal(authorizedEnvelope, sender)) return
        recordLocalRoute(authorizedEnvelope, senderUid, sender, PluginBusJournal.Verdict.OK)
        if (handleHubPath(
                authorizedEnvelope,
                replyRemote = false,
                senderUid = senderUid,
                replyBinder = sender.replyBinder,
                principal = sender.principal,
            )
        ) return
        // The in-process app shares this process's UID with every same-app client, so it is
        // excluded from its own frames by binder rather than by UID.
        val inProcess = sender.principal != null && sender.principal === inProcessPrincipal
        val excludeUid = senderUid.takeUnless { inProcess }
        if (deliverLocal(
                authorizedEnvelope,
                excludeUid = excludeUid,
                excludeBinder = sender.replyBinder.takeIf { inProcess },
            )
        ) return
        if (authorizedEnvelope.path != BusPaths.ERROR &&
            hooks.enqueueUndelivered(authorizedEnvelope, excludeUid)
        ) return
        val errorCode = sendRemote(authorizedEnvelope)
        if (errorCode != null) {
            deliverError(sender.replyBinder, authorizedEnvelope.id, errorCode)
        }
    }

    private fun routeRemote(envelope: BusEnvelope) {
        if (SppKeyProvisioning.isReserved(envelope.path)) return
        // Skills are phone-local: nothing arriving over CXR or SPP may enter that family.
        if (PathRules.matchesPrefix(envelope.path, SKILLS_ROOT)) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.REJECTED)
            return
        }
        if (hooks.onRemote(envelope)) return
        if (envelope.path == "/hub/probe") {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            log("hub probe received from glasses")
            return
        }
        if (envelope.path == BusPaths.HUB_CAPABILITIES) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            updateRemoteCapabilities(envelope.payload)
            return
        }
        if (envelope.path == BusPaths.INK_EVENT) {
            inkRouter.handleGlassesEvent(envelope)
            return
        }
        if (foregroundPolicy.handleRemote(envelope)) return
        if (handleHubPath(envelope, replyRemote = true)) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            return
        }
        if (envelope.path == BusPaths.NOTICE_INPUT) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            noticeRouter.handleGlassesInput(envelope)
            return
        }
        if (envelope.path == BusPaths.NOTICE_ACTION) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            noticeRouter.handleGlassesAction(envelope)
            return
        }
        if (envelope.path == BusPaths.NOTICE_CLOSED) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            noticeRouter.handleGlassesClosed(envelope)
            return
        }
        if (envelope.path == BusPaths.ACTIVITY_ACTION) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            activityRouter.handleGlassesAction(envelope)
            return
        }
        if (envelope.path == BusPaths.ACTIVITY_CLOSED) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            activityRouter.handleGlassesClosed(envelope)
            return
        }
        if (deliverLocal(envelope)) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK)
            return
        }
        if (envelope.path == BusPaths.ERROR) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.REJECTED, "UNDELIVERABLE_ERROR")
            log("dropping undeliverable remote error id=${envelope.id}")
            return
        }
        if (envelope.binary != null) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.REJECTED, "NO_LIVE_REGISTRATION")
            log("dropping undeliverable binary ${envelope.path} id=${envelope.id}; no live registration")
            return
        }
        if (hooks.enqueueUndelivered(envelope, null)) {
            recordRemoteRoute(envelope, PluginBusJournal.Verdict.OK, "QUEUED_LOCAL")
            return
        }
        recordRemoteRoute(envelope, PluginBusJournal.Verdict.REJECTED, "NO_LOCAL_CLIENT")
        sendRemote(errorEnvelope(envelope.id, "NO_LOCAL_CLIENT"))
    }

    private fun recordLocalRoute(
        envelope: BusEnvelope,
        senderUid: Int,
        sender: AuthorizedSender,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) = recordLocalRoute(envelope, senderUid, sender.principal?.descriptor?.id, verdict, reason)

    private fun AuthorizedSender.toHudSender(uid: Int) = PhoneHudRouteSender(
        pluginId = principal?.descriptor?.id,
        replyBinder = replyBinder,
        uid = uid,
    )

    private fun recordLocalRoute(
        envelope: BusEnvelope,
        senderUid: Int,
        pluginId: String?,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) {
        if (senderUid == Process.myUid() || !pluginBusJournal.enabled.get()) return
        try {
            pluginBusJournal.record(
                pluginId = pluginId,
                category = journalCategory(envelope.path, envelope.binary != null),
                direction = PluginBusJournal.Direction.PLUGIN_TO_HUB,
                path = envelope.path,
                sizeBytes = envelope.binary?.size,
                verdict = verdict,
                reason = journalRouteReason(reason),
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    @HubShellApi fun recordRemoteRoute(
        envelope: BusEnvelope,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) {
        if (!pluginBusJournal.enabled.get()) return
        try {
            pluginBusJournal.record(
                pluginId = journalPluginId(envelope),
                category = journalCategory(envelope.path, envelope.binary != null),
                direction = PluginBusJournal.Direction.GLASSES_TO_HUB,
                path = envelope.path,
                sizeBytes = envelope.binary?.size,
                verdict = verdict,
                reason = reason,
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    private fun recordLocalDelivery(
        registration: Registration,
        envelope: BusEnvelope,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) {
        if (!pluginBusJournal.enabled.get()) return
        try {
            pluginBusJournal.record(
                pluginId = registration.principal?.descriptor?.id,
                category = journalCategory(envelope.path, envelope.binary != null),
                direction = PluginBusJournal.Direction.HUB_TO_PLUGIN,
                path = envelope.path,
                sizeBytes = envelope.binary?.size,
                verdict = verdict,
                reason = reason,
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    private fun recordExternalDelivery(
        principal: PhonePluginPrincipal,
        path: String,
        sizeBytes: Int?,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) {
        if (!pluginBusJournal.enabled.get()) return
        try {
            pluginBusJournal.record(
                pluginId = principal.descriptor.id,
                category = journalCategory(path, sizeBytes != null),
                direction = PluginBusJournal.Direction.HUB_TO_PLUGIN,
                path = path,
                sizeBytes = sizeBytes,
                verdict = verdict,
                reason = reason,
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    private fun recordOversizedBinary(
        pluginId: String?,
        direction: PluginBusJournal.Direction,
        path: String,
        sizeBytes: Int,
    ) {
        if (!pluginBusJournal.enabled.get()) return
        try {
            val sizeKiB = (sizeBytes.toLong() + 1023L) / 1024L
            val limitKiB = LOCAL_BINARY_MAX_BYTES / 1024
            pluginBusJournal.record(
                pluginId = pluginId,
                category = PluginBusJournal.Category.BINARY,
                direction = direction,
                path = path,
                sizeBytes = sizeBytes,
                verdict = PluginBusJournal.Verdict.REJECTED,
                reason = "binary too large: ${sizeKiB}KiB > ${limitKiB}KiB",
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    private fun recordRemoteTransport(
        envelope: BusEnvelope,
        verdict: PluginBusJournal.Verdict,
        reason: String,
    ) {
        if (!pluginBusJournal.enabled.get()) return
        try {
            pluginBusJournal.record(
                pluginId = journalPluginId(envelope),
                category = journalCategory(envelope.path, envelope.binary != null),
                direction = PluginBusJournal.Direction.HUB_TO_GLASSES,
                path = envelope.path,
                sizeBytes = envelope.binary?.size,
                verdict = verdict,
                reason = reason,
            )
        } catch (_: Throwable) {
            // Diagnostics must never affect bus routing.
        }
    }

    private fun journalRouteReason(reason: String?): String? = when {
        reason == "PENDING_APPROVAL" -> "PENDING_USER_APPROVAL"
        reason?.startsWith("CAPABILITY_REQUIRED_") == true ->
            "capability denied: ${reason.removePrefix("CAPABILITY_REQUIRED_").lowercase()}"
        else -> reason
    }

    private fun journalPluginId(envelope: BusEnvelope): String? {
        val explicit = envelope.payload.optString("ownerPluginId")
            .ifBlank { envelope.payload.optString("pluginId") }
        if (explicit.isNotBlank()) return explicit
        val surfaceId = envelope.payload.optString("surfaceId")
            .ifBlank { envelope.payload.optString("activityId") }
        return surfaceId.substringBefore(':').takeIf { ':' in surfaceId && it.isNotBlank() }
    }

    private fun journalCategory(path: String, hasBinary: Boolean): PluginBusJournal.Category = when (path) {
        BusPaths.SURFACE_SHOW, BusPaths.SURFACE_UPDATE, BusPaths.SURFACE_HIDE,
        BusPaths.PIN_SHOW, BusPaths.PIN_HIDE,
        BusPaths.NOTICE_SHOW, BusPaths.NOTICE_UPDATE, BusPaths.NOTICE_HIDE,
        BusPaths.ACTIVITY_START, BusPaths.ACTIVITY_UPDATE, BusPaths.ACTIVITY_END,
        -> PluginBusJournal.Category.SURFACE
        BusPaths.SURFACE_INPUT, BusPaths.PLUGIN_INPUT,
        BusPaths.NOTICE_INPUT, BusPaths.NOTICE_ACTION, BusPaths.NOTICE_CLOSED,
        BusPaths.ACTIVITY_ACTION, BusPaths.ACTIVITY_CLOSED,
        -> PluginBusJournal.Category.INPUT
        BusPaths.PLUGIN_OPEN, BusPaths.PLUGIN_CLOSE -> PluginBusJournal.Category.LIFECYCLE
        BusPaths.PLUGIN_REGISTRATION -> PluginBusJournal.Category.REGISTRATION
        BusPaths.LAUNCHER_LIST, BusPaths.LAUNCHER_OPEN -> PluginBusJournal.Category.LAUNCHER
        else -> if (hasBinary) PluginBusJournal.Category.BINARY else PluginBusJournal.Category.TRANSPORT
    }

    private fun handleHubPath(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        senderUid: Int? = null,
        replyBinder: IBinder? = null,
        principal: PhonePluginPrincipal? = null,
    ): Boolean {
        when (envelope.path) {
            AUDIO_LEASE_ACQUIRE -> executor.execute {
                acquireAudioLease(envelope, replyRemote, senderUid, replyBinder)
            }
            AUDIO_LEASE_RELEASE -> executor.execute { releaseAudioLease(envelope, replyRemote, replyBinder) }
            SttWireProtocol.SESSION_START_PATH -> speechBusExecutor.execute {
                handleSpeechSessionStart(envelope, replyRemote, replyBinder, principal)
            }
            SttWireProtocol.SESSION_STOP_PATH -> speechBusExecutor.execute {
                handleSpeechSessionStop(envelope, replyRemote, replyBinder, principal)
            }
            else -> return false
        }
        return true
    }

    private fun isGlassesControlRequest(path: String): Boolean =
        path == BusPaths.GLASSES_BRIGHTNESS_REQUEST ||
            path == BusPaths.GLASSES_VOLUME_REQUEST ||
            isStrictlyHubOwnedGlassesPath(path)

    private fun isStrictlyHubOwnedGlassesPath(path: String): Boolean =
        path == BusPaths.GLASSES_SELFARM_MANUAL ||
            path == BusPaths.GLASSES_SETUP_NOTE ||
            path == BusPaths.GLASSES_SETUP_PAIRING_OFFER ||
            path == BusPaths.GLASSES_SETUP_PAIRING_RESULT ||
            path == BusPaths.GLASSES_REPAIR_CONFIG ||
            path == BusPaths.GLASSES_REPAIR_REQUEST ||
            path == BusPaths.GLASSES_ACCESSIBILITY_CHECK_REQUEST ||
            path == BusPaths.GLASSES_KEYBOARD_REQUEST

    private fun handleGlassesControlRequest(envelope: BusEnvelope, sender: AuthorizedSender) {
        val replyBinder = sender.replyBinder
        if (envelope.path == BusPaths.GLASSES_REPAIR_CONFIG ||
            envelope.path == BusPaths.GLASSES_REPAIR_REQUEST ||
            envelope.path == BusPaths.GLASSES_ACCESSIBILITY_CHECK_REQUEST ||
            envelope.path == BusPaths.GLASSES_KEYBOARD_REQUEST
        ) {
            // Pure forwards: the glasses answer on GLASSES_REPAIR_REPLY / GLASSES_ACCESSIBILITY_
            // CHECK_REPLY / GLASSES_KEYBOARD_REPLY with the request's id, which the calling screen
            // correlates itself. Only a transport failure is answered here, so "not connected"
            // fails fast instead of eating the full timeout.
            val error = sendRemote(envelope)
            if (error != null) {
                deliverError(replyBinder, envelope.id, error)
            }
            return
        }
        if (envelope.path == BusPaths.GLASSES_SELFARM_MANUAL) {
            // Manual ADB setup belongs to the upstream shell; without it the path is refused.
            if (!hooks.onLocal(envelope, sender)) {
                deliverError(replyBinder, envelope.id, "TRUSTED_LOCAL_ONLY")
            }
            return
        }
        val level = GlassesControlLevelPolicy.parseAndClamp(envelope.payload.opt("level"))
        if (level == null) {
            deliverError(replyBinder, envelope.id, "INVALID_LEVEL")
            return
        }
        val link = cxrLink
        if (link == null || !isCxrUp()) {
            deliverError(replyBinder, envelope.id, "NO_CXR")
            return
        }
        val applied = runCatching {
            when (envelope.path) {
                BusPaths.GLASSES_BRIGHTNESS_REQUEST -> link.setBrightness(level)
                BusPaths.GLASSES_VOLUME_REQUEST -> link.setVolume(level)
                else -> false
            }
        }.getOrElse {
            log("CXR glasses control failed ${it.javaClass.simpleName}: ${it.message}")
            false
        }
        when (envelope.path) {
            BusPaths.GLASSES_BRIGHTNESS_REQUEST -> log("glassesBrightnessRequest level=$level applied=$applied")
            BusPaths.GLASSES_VOLUME_REQUEST -> log("glassesVolumeRequest level=$level applied=$applied")
        }
        if (!applied) {
            deliverError(replyBinder, envelope.id, "APPLY_FAILED")
            return
        }
        val response = BusEnvelope(
            path = envelope.path + "/reply",
            id = envelope.id,
            payload = JSONObject().put("applied", true).put("level", level),
        )
        deliverLocal(response, targetBinder = replyBinder)
    }

    @HubShellApi fun deliverLocal(
        envelope: BusEnvelope,
        excludeUid: Int? = null,
        targetBinder: IBinder? = null,
        excludeBinder: IBinder? = null,
    ): Boolean {
        val payload = envelope.payload.toString().toByteArray(Charsets.UTF_8)
        val binary = envelope.binary
        var delivered = false
        registrations.forEach { registration ->
            if (targetBinder != null && registration.callbackBinder != targetBinder) return@forEach
            if (excludeUid != null && registration.uid == excludeUid) return@forEach
            if (excludeBinder != null && registration.callbackBinder == excludeBinder) return@forEach
            if (registrationMatches(registration, envelope)) {
                if (binary != null && binary.size > LOCAL_BINARY_MAX_BYTES) {
                    recordOversizedBinary(
                        pluginId = registration.principal?.descriptor?.id,
                        direction = PluginBusJournal.Direction.HUB_TO_PLUGIN,
                        path = envelope.path,
                        sizeBytes = binary.size,
                    )
                    log("drop local binary ${envelope.path} id=${envelope.id} bytes=${binary.size} over cap=$LOCAL_BINARY_MAX_BYTES")
                    delivered = true
                    return@forEach
                }
                runCatching {
                    if (binary == null) {
                        registration.callback.onMessage(envelope.path, envelope.id, payload)
                    } else {
                        registration.callback.onBinaryMessage(envelope.path, envelope.id, payload, binary)
                    }
                    delivered = true
                    hooks.onLocalDelivered()
                }.onSuccess {
                    recordLocalDelivery(registration, envelope, PluginBusJournal.Verdict.OK, "LOCAL")
                }.onFailure {
                    recordLocalDelivery(registration, envelope, PluginBusJournal.Verdict.REJECTED, "DEAD_CALLBACK")
                    removeRegistration(registration, "dead callback")
                }
            }
        }
        return delivered
    }

    private fun registrationMatches(registration: Registration, envelope: BusEnvelope): Boolean {
        if (!protectedPathAllowed(
                envelope.path,
                registration.uid,
                registration.principal,
                ProtectedPathDirection.RECEIVE,
            )
        ) return false
        val addressed = registration.principal
        if (addressed != null && PathRules.isDirectReply(envelope.path)) {
            return envelope.payload.optString("pluginId") == addressed.descriptor.id
        }
        if (registration.prefixes.none { PathRules.matchesPrefix(envelope.path, it) }) return false
        val principal = registration.principal ?: return true
        if (PathRules.isPluginPrivate(envelope.path, principal.descriptor.id)) return true
        if (PathRules.isOwnerScoped(envelope.path)) {
            return envelope.payload.optString("pluginId") == principal.descriptor.id
        }
        return true
    }

    private fun protectedPathAllowed(
        path: String,
        uid: Int,
        principal: PhonePluginPrincipal?,
        direction: ProtectedPathDirection = ProtectedPathDirection.SEND,
    ): Boolean = ProtectedPathAccessPolicy.isAllowed(
        path = path,
        isHubUid = uid == Process.myUid(),
        principal = principal,
        grantState = principal?.let(::grantStateFor),
        direction = direction,
    )

    /**
     * Photo-sync status, delivered one registration at a time.
     *
     * The plugin SDK drops any message whose payload lacks its own pluginId, so a single broadcast
     * copy was swallowed before it ever reached the settings screen — the screen sat on
     * "Connecting to Rokid Nexus" forever while the hub synced perfectly. Stamping each recipient's
     * id in is what makes status visible; [registrationMatches] still decides who may receive it.
     */
    @HubShellApi
    fun publishMediaSyncStatus(payload: JSONObject) {
        registrations.forEach { registration ->
            val pluginId = registration.principal?.descriptor?.id ?: return@forEach
            val stamped = runCatching { JSONObject(payload.toString()).put("pluginId", pluginId) }
                .getOrNull() ?: return@forEach
            deliverLocal(
                BusEnvelope(path = BusPaths.MEDIA_SYNC_STATUS, payload = stamped),
                targetBinder = registration.callbackBinder,
            )
        }
    }

    private fun handleLocalTts(
        envelope: BusEnvelope,
        senderUid: Int,
        sender: AuthorizedSender,
    ) {
        val principal = sender.principal
        if (principal == null) {
            rejectTts(envelope, senderUid, sender, TtsContract.ERROR_INVALID_TTS)
            return
        }
        if (capabilities() and BusCapabilityBits.TTS == 0) {
            rejectTts(
                envelope,
                senderUid,
                sender,
                TtsContract.ERROR_CAPABILITY_NOT_AVAILABLE,
            )
            return
        }
        when (
            val result = ttsRequestGate.evaluate(
                ownerPluginId = principal.descriptor.id,
                path = envelope.path,
                payload = envelope.payload,
                hasBinary = envelope.binary != null,
            )
        ) {
            is PhoneTtsGateResult.Rejected ->
                rejectTts(envelope, senderUid, sender, result.code)
            is PhoneTtsGateResult.Accepted -> {
                val forwarded = envelope.copy(payload = result.payload)
                when (val dispatch = phoneTtsDispatcher.dispatch(forwarded)) {
                    PhoneTtsDispatchResult.PhoneHandled -> recordLocalRoute(
                        forwarded,
                        senderUid,
                        sender,
                        PluginBusJournal.Verdict.OK,
                    )
                    is PhoneTtsDispatchResult.Invalid ->
                        rejectTts(envelope, senderUid, sender, dispatch.error)
                }
            }
        }
    }

    private fun rejectTts(
        envelope: BusEnvelope,
        senderUid: Int,
        sender: AuthorizedSender,
        code: String,
    ) {
        recordLocalRoute(envelope, senderUid, sender, PluginBusJournal.Verdict.REJECTED, code)
        deliverError(sender.replyBinder, envelope.id, code)
    }

    private fun handleTtsEvent(envelope: BusEnvelope) {
        if (envelope.binary != null) {
            log("tts event ignored path=${envelope.path} reason=${TtsContract.ERROR_INVALID_TTS}")
            return
        }
        val routed = when (envelope.path) {
            BusPaths.TTS_STARTED -> when (val result = TtsContract.validateStarted(envelope.payload)) {
                is TtsValidationResult.Valid -> result.value to null
                is TtsValidationResult.Invalid -> null
            }
            BusPaths.TTS_DONE -> when (val result = TtsContract.validateDone(envelope.payload)) {
                is TtsValidationResult.Valid -> result.value
                is TtsValidationResult.Invalid -> null
            }
            else -> null
        }
        if (routed == null) {
            log("tts event ignored path=${envelope.path} reason=${TtsContract.ERROR_INVALID_TTS}")
            return
        }
        val (request, reason) = routed
        val ownerPluginId = request.ownerPluginId ?: return
        val registration = registrations.firstOrNull { registration ->
            registration.principal?.descriptor?.id == ownerPluginId &&
                PluginCapability.TTS in registration.grantedCapabilities
        }
        val principal = registration?.principal
        if (principal == null) {
            log("tts event undelivered owner=$ownerPluginId reason=no_live_registration")
            return
        }
        val payload = JSONObject()
            .put("utteranceId", request.utteranceId)
        reason?.let { payload.put("reason", it.name) }
        if (!deliverExternalLifecycle(principal, envelope.path, envelope.id, payload)) {
            log("tts event undelivered owner=$ownerPluginId path=${envelope.path}")
        }
    }

    private fun emitPhoneTtsStarted(ownerPluginId: String, utteranceId: String) {
        handleTtsEvent(
            BusEnvelope(
                path = BusPaths.TTS_STARTED,
                payload = TtsContract.startedPayload(ownerPluginId, utteranceId),
            ),
        )
    }

    private fun emitPhoneTtsDone(event: TtsDoneEvent) {
        handleTtsEvent(
            BusEnvelope(
                path = BusPaths.TTS_DONE,
                payload = TtsContract.donePayload(
                    event.ownerPluginId,
                    event.utteranceId,
                    event.reason,
                ),
            ),
        )
    }

    private fun resolveSender(senderUid: Int): AuthorizedSender {
        if (senderUid == Process.myUid()) return AuthorizedSender(PluginRouteCaller.Internal, null)
        val matching = registrations.filter { it.uid == senderUid }
        if (matching.isEmpty()) return AuthorizedSender(PluginRouteCaller.Unregistered, null)
        val principals = matching.mapNotNull(Registration::principal)
            .distinctBy { it.grantKey() }
        if (principals.size > 1) {
            return AuthorizedSender(PluginRouteCaller.Ambiguous, matching.first().callbackBinder)
        }
        val principal = principals.singleOrNull()
        if (principal == null) {
            return if (isDebuggableBuild()) {
                AuthorizedSender(PluginRouteCaller.DebugLegacy, matching.first().callbackBinder)
            } else {
                AuthorizedSender(PluginRouteCaller.Unregistered, matching.first().callbackBinder)
            }
        }
        val pluginRegistration = matching.first { it.principal?.grantKey() == principal.grantKey() }
        return when (val state = hooks.grantFor(principal)) {
            PluginGrantState.Pending -> AuthorizedSender(
                PluginRouteCaller.Pending,
                pluginRegistration.callbackBinder,
                principal,
            )
            PluginGrantState.Denied,
            PluginGrantState.Disabled,
            -> AuthorizedSender(PluginRouteCaller.Revoked, pluginRegistration.callbackBinder, principal)
            is PluginGrantState.Approved -> AuthorizedSender(
                PluginRouteCaller.Plugin(principal.descriptor.id, state.capabilities),
                pluginRegistration.callbackBinder,
                principal,
            )
        }
    }

    @HubShellApi fun deliverError(targetBinder: IBinder?, id: String, code: String) {
        val target = targetBinder?.let { binder -> registrations.firstOrNull { it.callbackBinder == binder } }
            ?: return
        // pluginId matches NexusPluginClient's own filter on every inbound message
        // (onMessage returns early when it doesn't); omitting it, as this used to,
        // meant every error this function ever delivered was silently dropped
        // before a plugin's code ever saw it — including SURFACE_BUSY.
        val envelope = errorEnvelope(id, code, target.clientId)
        val payload = envelope.payload.toString().toByteArray(Charsets.UTF_8)
        runCatching { target.callback.onMessage(envelope.path, envelope.id, payload) }
            .onFailure { removeRegistration(target, "dead callback") }
    }

    private fun notifyPluginRegistration(
        principal: PhonePluginPrincipal,
        capabilities: Set<PluginCapability>,
        callback: IBusCallback,
    ) {
        val eventId = UUID.randomUUID().toString()
        val payload = JSONObject()
            .put("version", 1)
            .put("type", "registration")
            .put("id", eventId)
            .put("pluginId", principal.descriptor.id)
            .put("result", PluginRegistrationResult.APPROVED)
            .put("capabilities", serialize(capabilities))
            .put("noticeInteractionVersion", NoticeSurfaceContract.INTERACTION_VERSION)
            .put(SkillsContract.REGISTRATION_FIELD, SkillsContract.VERSION)
            .toString()
            .toByteArray(Charsets.UTF_8)
        runCatching { callback.onMessage(BusPaths.PLUGIN_REGISTRATION, eventId, payload) }
    }

    private fun removeRegistrationsByBinder(callbackBinder: IBinder, reason: String) {
        registrations.filter { it.callbackBinder == callbackBinder }.forEach { registration ->
            removeRegistration(registration, reason)
        }
    }

    private fun removeRegistration(registration: Registration, reason: String) {
        if (!registrations.remove(registration)) return
        if (pluginBusJournal.enabled.get()) {
            pluginBusJournal.record(
                pluginId = registration.principal?.descriptor?.id,
                category = PluginBusJournal.Category.REGISTRATION,
                direction = PluginBusJournal.Direction.PLUGIN_TO_HUB,
                path = BusPaths.PLUGIN_REGISTRATION,
                reason = "CLIENT_REMOVED: $reason",
            )
        }
        runCatching { registration.callbackBinder.unlinkToDeath(registration.deathRecipient, 0) }
        releaseAudioLeaseForLocalBinder(registration.callbackBinder, reason)
        releaseSpeechSessionForLocalBinder(registration, reason)
        var ownerStillConnected = false
        registration.principal?.descriptor?.id?.let { pluginId ->
            ownerStillConnected = registrations.any {
                it.principal?.descriptor?.id == pluginId
            }
            if (!ownerStillConnected &&
                reason != "replace" &&
                reason != "authorizationChanged"
            ) {
                activityRouter.clearForDisconnectedOwner(pluginId, reason)
            }
        }
        // A registration going away is normal: the hub unbinds dormant plugins, and a
        // background plugin is expected to push its pin and disconnect. The pin outlives
        // the connection — only losing the grant, a TTL, a replacement, or an explicit
        // hide clears it. See pinRouter.clearForRevokedOwner. Activities intentionally differ:
        // the final live registration disappearing cleared that owner's activity above.
        hooks.onRegistrationRemoved(registration.principal, reason, ownerStillConnected)
    }

    private fun grantStateFor(principal: PhonePluginPrincipal): PluginGrantState {
        val app = config.inProcessApp
        if (app != null && principal === inProcessPrincipal) return PluginGrantState.Approved(app.capabilities)
        return hooks.grantFor(principal)
    }

    @HubShellApi @MainThread fun revokePrincipal(key: PluginGrantKey) {
        hooks.onPrincipalRevoking(key)
        pinRouter.clearForRevokedOwner(key.pluginId, "authorizationChanged")
        noticeRouter.clearForRevokedOwner(key.pluginId, "authorizationChanged")
        activityRouter.clearForRevokedOwner(key.pluginId, "authorizationChanged")
        registrations.filter { it.principal?.grantKey() == key }.forEach { registration ->
            removeRegistration(registration, "authorizationChanged")
        }
    }

    @HubShellApi @MainThread fun authorizationChanged(key: PluginGrantKey) {
        revokePrincipal(key)
        hooks.onAuthorizationChanged(key)
        notifyLinkState()
    }

    @HubShellApi fun isPrincipalRegistered(principal: PhonePluginPrincipal): Boolean =
        registrations.any { it.principal?.grantKey() == principal.grantKey() }

    private fun deliverExternalLifecycle(
        principal: PhonePluginPrincipal,
        path: String,
        id: String,
        payload: JSONObject,
    ): Boolean {
        if (!protectedPathAllowed(path, principal.uid, principal)) {
            recordExternalDelivery(principal, path, null, PluginBusJournal.Verdict.REJECTED, "PROTECTED_CAMERA_PATH")
            return false
        }
        val registration = registrations.singleOrNull { it.principal?.grantKey() == principal.grantKey() }
        if (registration == null) {
            recordExternalDelivery(principal, path, null, PluginBusJournal.Verdict.REJECTED, "NO_LIVE_REGISTRATION")
            return false
        }
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        return runCatching {
            registration.callback.onMessage(path, id, bytes)
            recordExternalDelivery(principal, path, null, PluginBusJournal.Verdict.OK, "LOCAL")
            true
        }.getOrElse {
            recordExternalDelivery(principal, path, null, PluginBusJournal.Verdict.REJECTED, "DEAD_CALLBACK")
            removeRegistration(registration, "dead callback")
            false
        }
    }

    private fun deliverExternalBinary(
        principal: PhonePluginPrincipal,
        path: String,
        id: String,
        payload: JSONObject,
        data: ByteArray,
    ): Boolean {
        if (data.size > LOCAL_BINARY_MAX_BYTES) {
            recordOversizedBinary(
                pluginId = principal.descriptor.id,
                direction = PluginBusJournal.Direction.HUB_TO_PLUGIN,
                path = path,
                sizeBytes = data.size,
            )
            log("drop external binary $path id=$id bytes=${data.size} over cap=$LOCAL_BINARY_MAX_BYTES")
            return false
        }
        if (!protectedPathAllowed(path, principal.uid, principal)) {
            recordExternalDelivery(principal, path, data.size, PluginBusJournal.Verdict.REJECTED, "PROTECTED_CAMERA_PATH")
            return false
        }
        val registration = registrations.singleOrNull { it.principal?.grantKey() == principal.grantKey() }
        if (registration == null) {
            recordExternalDelivery(principal, path, data.size, PluginBusJournal.Verdict.REJECTED, "NO_LIVE_REGISTRATION")
            return false
        }
        val bytes = payload.toString().toByteArray(Charsets.UTF_8)
        return runCatching {
            registration.callback.onBinaryMessage(path, id, bytes, data)
            recordExternalDelivery(principal, path, data.size, PluginBusJournal.Verdict.OK, "LOCAL")
            true
        }.getOrElse {
            recordExternalDelivery(principal, path, data.size, PluginBusJournal.Verdict.REJECTED, "DEAD_CALLBACK")
            removeRegistration(registration, "dead callback")
            false
        }
    }

    @HubShellApi fun hideExternalSurfaces(pluginId: String) {
        val surfaceIds = surfaceRouter.hidePlugin(pluginId)
        inkRouter.clearOwner(pluginId) { owners ->
            // A show may still be compiling when its plugin disconnects. The
            // callback also closes surfaces absent from the initial snapshot.
            owners.filterNot { it.wireSurfaceId in surfaceIds }.forEach { owner ->
                surfaceRouter.forget(owner.pluginId, owner.wireSurfaceId)
                surfaceRouter.sendHide(owner.pluginId, owner.wireSurfaceId)
            }
        }
    }

    private fun onExternalSurfaceReleased(pluginId: String, detach: Boolean) {
        val hasActiveAudioLease = pluginHoldsActiveAudioLease(pluginId)
        foregroundPolicy.onSelfHid(
            pluginId = pluginId,
            detach = detach,
            hasActiveAudioLease = hasActiveAudioLease,
        )
        // Close the only race where the lease can end after the grant check but before the
        // controller has installed its background slot. A later lease end sees the slot itself.
        if (detach && hasActiveAudioLease && !pluginHoldsActiveAudioLease(pluginId)) {
            foregroundPolicy.onAudioLeaseEnded(pluginId, "LEASE_ENDED")
        }
    }

    private fun pluginHoldsActiveAudioLease(pluginId: String): Boolean =
        audioLeaseArbitrator.snapshot()?.let { lease ->
            lease.side == AudioLeaseSide.LOCAL &&
                lease.streamStarted &&
                lease.holderPluginId == pluginId
        } == true

    private fun handleSpeechSessionStart(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        replyBinder: IBinder?,
        principal: PhonePluginPrincipal?,
    ) {
        if (replyRemote) {
            sendRemote(errorEnvelope(envelope.id, "STT_LOCAL_ONLY"))
            return
        }
        val registration = speechRegistration(replyBinder, principal) ?: return
        val request = SttWireProtocol.parseStart(envelope.payload)
        if (request == null) {
            replyToSpeechRequest(
                envelope = envelope,
                payload = JSONObject()
                    .put("accepted", false)
                    .put("reason", "INVALID_REQUEST"),
                registration = registration,
            )
            return
        }

        val session = SpeechBusSession(
            sessionId = UUID.randomUUID().toString(),
            callbackBinder = registration.callbackBinder,
            pluginId = registration.principal!!.descriptor.id,
            grantKey = registration.principal.grantKey(),
        )
        session.listener = SpeechBusListener(session)
        val reserved = synchronized(speechBusLock) {
            val current = activeSpeechBusSession
            if (current != null && !current.ended.get()) {
                false
            } else {
                activeSpeechBusSession = session
                true
            }
        }
        if (!reserved) {
            replyToSpeechRequest(
                envelope = envelope,
                payload = JSONObject()
                    .put("accepted", false)
                    .put("reason", "BUSY"),
                registration = registration,
            )
            return
        }

        val startResult = runCatching {
            speechSessionManager.startUtterance(
                listener = session.listener,
                language = request.language,
            )
        }.getOrDefault(SpeechStartResult.START_FAILED)
        if (startResult != SpeechStartResult.OK) {
            discardSpeechBusSession(session)
            replyToSpeechRequest(
                envelope = envelope,
                payload = JSONObject()
                    .put("accepted", false)
                    .put("reason", SttWireProtocol.startDenialReason(startResult)),
                registration = registration,
            )
            return
        }

        if (!isCurrentSpeechBusSession(session) ||
            speechRegistration(registration.callbackBinder, registration.principal) == null
        ) {
            speechSessionManager.cancel(session.listener)
            return
        }
        val realtime = speechSessionManager.activeRealtime
            ?: speechSettingsStore.selectedEngine()?.usesRealtime
            ?: false
        session.accepted.set(true)
        replyToSpeechRequest(
            envelope = envelope,
            payload = JSONObject()
                .put("accepted", true)
                .put("sessionId", session.sessionId)
                .put("realtime", realtime),
            registration = registration,
        )
    }

    private fun handleSpeechSessionStop(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        replyBinder: IBinder?,
        principal: PhonePluginPrincipal?,
    ) {
        if (replyRemote) {
            sendRemote(errorEnvelope(envelope.id, "STT_LOCAL_ONLY"))
            return
        }
        val registration = speechRegistration(replyBinder, principal) ?: return
        val requestedSessionId = envelope.payload.optString("sessionId")
        val ownedSession = synchronized(speechBusLock) {
            activeSpeechBusSession?.let { current ->
                current.takeIf {
                    !current.ended.get() &&
                    current.sessionId == requestedSessionId &&
                    current.callbackBinder == registration.callbackBinder &&
                    current.grantKey == registration.principal!!.grantKey()
                }
            }
        }
        ownedSession?.let { speechSessionManager.cancel(it.listener) }
        replyToSpeechRequest(
            envelope = envelope,
            payload = JSONObject().put("stopped", true),
            registration = registration,
        )
    }

    private inner class SpeechBusListener(
        private val session: SpeechBusSession,
    ) : SpeechUtteranceListener {
        override fun onState(state: SpeechSessionState) {
            speechBusExecutor.execute {
                if (!isCurrentSpeechBusSession(session)) return@execute
                val sequence = session.stateSeq.getAndIncrement()
                deliverSpeechBusEnvelope(
                    session,
                    BusEnvelope(
                        path = SttWireProtocol.STATE_PATH,
                        id = SttWireProtocol.stateId(session.sessionId, sequence),
                        payload = SttWireProtocol.statePayload(
                            session.pluginId,
                            session.sessionId,
                            state,
                        ),
                    ),
                )
            }
        }

        override fun onPartial(text: String) {
            speechBusExecutor.execute {
                if (!isCurrentSpeechBusSession(session)) return@execute
                val sequence = session.partialSeq.getAndIncrement()
                deliverSpeechBusEnvelope(
                    session,
                    BusEnvelope(
                        path = SttWireProtocol.PARTIAL_PATH,
                        id = SttWireProtocol.partialId(session.sessionId, sequence),
                        payload = SttWireProtocol.partialPayload(
                            session.pluginId,
                            session.sessionId,
                            text,
                            sequence,
                        ),
                    ),
                )
            }
        }

        override fun onFinal(text: String) {
            speechBusExecutor.execute {
                if (!isCurrentSpeechBusSession(session)) return@execute
                deliverSpeechBusEnvelope(
                    session,
                    BusEnvelope(
                        path = SttWireProtocol.FINAL_PATH,
                        id = SttWireProtocol.finalId(session.sessionId),
                        payload = SttWireProtocol.finalPayload(
                            session.pluginId,
                            session.sessionId,
                            text,
                        ),
                    ),
                )
            }
        }

        override fun onEnded(reason: SpeechEndReason, error: SttError?) {
            speechBusExecutor.execute {
                if (!completeSpeechBusSession(session)) return@execute
                deliverSpeechBusEnvelope(
                    session,
                    BusEnvelope(
                        path = SttWireProtocol.SESSION_ENDED_PATH,
                        id = SttWireProtocol.endedId(session.sessionId),
                        payload = SttWireProtocol.endedPayload(
                            session.pluginId,
                            session.sessionId,
                            reason,
                            error,
                        ),
                    ),
                )
            }
        }
    }

    private fun speechRegistration(
        callbackBinder: IBinder?,
        principal: PhonePluginPrincipal?,
    ): Registration? {
        if (callbackBinder == null || principal == null) return null
        return registrations.firstOrNull { registration ->
            registration.callbackBinder == callbackBinder &&
                registration.principal?.grantKey() == principal.grantKey() &&
                PluginCapability.STT in registration.grantedCapabilities
        }
    }

    private fun replyToSpeechRequest(
        envelope: BusEnvelope,
        payload: JSONObject,
        registration: Registration,
    ) {
        payload.put("pluginId", registration.principal!!.descriptor.id)
        deliverLocal(
            BusEnvelope(
                path = envelope.path + "/reply",
                id = envelope.id,
                payload = payload,
            ),
            targetBinder = registration.callbackBinder,
        )
    }

    private fun deliverSpeechBusEnvelope(session: SpeechBusSession, envelope: BusEnvelope) {
        deliverLocal(envelope, targetBinder = session.callbackBinder)
    }

    private fun isCurrentSpeechBusSession(session: SpeechBusSession): Boolean =
        synchronized(speechBusLock) {
            activeSpeechBusSession === session && !session.ended.get()
        }

    private fun discardSpeechBusSession(session: SpeechBusSession) {
        synchronized(speechBusLock) {
            if (activeSpeechBusSession === session) activeSpeechBusSession = null
            session.ended.set(true)
        }
    }

    private fun completeSpeechBusSession(session: SpeechBusSession): Boolean =
        synchronized(speechBusLock) {
            if (activeSpeechBusSession !== session ||
                !session.ended.compareAndSet(false, true)
            ) {
                false
            } else {
                activeSpeechBusSession = null
                true
            }
        }

    private fun releaseSpeechSessionForLocalBinder(registration: Registration, reason: String) {
        val session = synchronized(speechBusLock) {
            val current = activeSpeechBusSession
            if (current?.callbackBinder == registration.callbackBinder &&
                current.ended.compareAndSet(false, true)
            ) {
                activeSpeechBusSession = null
                current
            } else {
                null
            }
        } ?: return
        speechSessionManager.cancel(session.listener)
        if (reason != "authorizationChanged" || !session.accepted.get()) return

        val revoked = BusEnvelope(
            path = SttWireProtocol.SESSION_ENDED_PATH,
            id = SttWireProtocol.endedId(session.sessionId),
            payload = SttWireProtocol.revokedPayload(session.pluginId, session.sessionId),
        )
        speechBusExecutor.execute {
            val payload = revoked.payload.toString().toByteArray(Charsets.UTF_8)
            runCatching {
                registration.callback.onMessage(revoked.path, revoked.id, payload)
            }.onSuccess {
                recordLocalDelivery(registration, revoked, PluginBusJournal.Verdict.OK, "LOCAL")
            }.onFailure {
                recordLocalDelivery(
                    registration,
                    revoked,
                    PluginBusJournal.Verdict.REJECTED,
                    "DEAD_CALLBACK",
                )
            }
        }
    }

    /** Whether a pin envelope can go out right now. State is kept either way. */
    private fun pinLinkUp(): Boolean =
        linkState() and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0

    private fun acquireAudioLease(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        senderUid: Int?,
        replyBinder: IBinder?,
    ) {
        val holderPluginId = if (replyRemote) {
            null
        } else {
            registrations.firstOrNull { it.uid == senderUid && it.principal != null }
                ?.principal
                ?.descriptor
                ?.id
        }
        val link = cxrLink
        if (audioLeaseArbitrator.snapshot() != null) {
            replyToAudioRequest(envelope, replyRemote, JSONObject().put("granted", false).put("reason", "BUSY"), replyBinder, holderPluginId)
            return
        }
        if (link == null || !isCxrUp()) {
            replyToAudioRequest(envelope, replyRemote, JSONObject().put("granted", false).put("reason", "NO_CXR"), replyBinder, holderPluginId)
            return
        }

        val holderBinder = if (replyRemote) null else replyBinder ?: findLocalAudioHolder(senderUid)
        val lease = AudioLease(
            leaseId = UUID.randomUUID().toString(),
            side = if (replyRemote) AudioLeaseSide.REMOTE else AudioLeaseSide.LOCAL,
            localCallbackBinder = holderBinder,
            holderPluginId = holderPluginId,
        )
        if (!audioLeaseArbitrator.tryAcquire(lease)) {
            replyToAudioRequest(envelope, replyRemote, JSONObject().put("granted", false).put("reason", "BUSY"), replyBinder, holderPluginId)
            return
        }

        audioHandler.post {
            val started = runCatching {
                link.setInterruptAiWake(true)
                link.setCXRAudioCbk(audioCallback)
                val streamStarted = link.startAudioStream(CXR_AUDIO_PCM)
                log("CXR audio start streamStarted=$streamStarted")
                streamStarted
            }.getOrElse {
                log("CXR audio start failed ${it.javaClass.simpleName}: ${it.message}")
                false
            }
            if (!started) {
                audioLeaseArbitrator.clearIf { it.leaseId == lease.leaseId }
                stopAudioStreamQuietly()
                replyToAudioRequest(envelope, replyRemote, JSONObject().put("granted", false).put("reason", "START_FAILED"), replyBinder, holderPluginId)
                return@post
            }
            val activated = audioLeaseArbitrator.withActive { current ->
                if (current.leaseId == lease.leaseId) {
                    current.streamStarted = true
                    true
                } else {
                    false
                }
            } == true
            if (!activated) {
                // A concurrent revoke may have run stopAudioStreamQuietly() before our
                // startAudioStream() landed; stop again so no orphan stream survives.
                stopAudioStreamQuietly()
                val reason = if (isCxrUp()) "START_FAILED" else "NO_CXR"
                replyToAudioRequest(envelope, replyRemote, JSONObject().put("granted", false).put("reason", reason), replyBinder, holderPluginId)
                return@post
            }

            silenceSpeechForMicrophone()
            replyToAudioRequest(
                envelope,
                replyRemote,
                JSONObject()
                    .put("granted", true)
                    .put("leaseId", lease.leaseId)
                    .put("sampleRate", AUDIO_SAMPLE_RATE)
                    .put("channels", AUDIO_CHANNELS)
                    .put("encoding", AUDIO_ENCODING),
                replyBinder,
                holderPluginId,
            )
        }
    }

    @HubShellApi fun acquireInternalAudio(
        tag: String,
        consumer: InternalAudioConsumer,
    ): InternalAudioAcquireResult {
        val link = cxrLink
        if (audioLeaseArbitrator.snapshot() != null) return InternalAudioAcquireResult.BUSY
        if (link == null || !isCxrUp()) return InternalAudioAcquireResult.NO_LINK
        val lease = AudioLease(
            leaseId = UUID.randomUUID().toString(),
            side = AudioLeaseSide.INTERNAL,
            localCallbackBinder = null,
            holderPluginId = null,
            internalTag = tag,
            internalConsumer = consumer,
        )
        if (!audioLeaseArbitrator.tryAcquire(lease)) return InternalAudioAcquireResult.BUSY

        val result = runOnAudioMain {
            val started = runCatching {
                link.setInterruptAiWake(true)
                link.setCXRAudioCbk(audioCallback)
                link.startAudioStream(CXR_AUDIO_PCM)
            }.getOrDefault(false)
            if (!started) {
                audioLeaseArbitrator.clearIf { it.leaseId == lease.leaseId }
                stopAudioStreamQuietly()
                InternalAudioAcquireResult.START_FAILED
            } else if (audioLeaseArbitrator.withActive { current ->
                    if (current.leaseId == lease.leaseId) {
                        current.streamStarted = true
                        true
                    } else {
                        false
                    }
                } != true
            ) {
                // Match plugin acquisition's post-start double check so a concurrent link
                // revoke cannot leave an orphan stream running.
                stopAudioStreamQuietly()
                if (isCxrUp()) {
                    InternalAudioAcquireResult.START_FAILED
                } else {
                    InternalAudioAcquireResult.NO_LINK
                }
            } else {
                silenceSpeechForMicrophone()
                InternalAudioAcquireResult.OK
            }
        }
        if (result != null) return result

        audioLeaseArbitrator.clearIf { it.leaseId == lease.leaseId }
        stopAudioStreamQuietly()
        return InternalAudioAcquireResult.START_FAILED
    }

    /**
     * Silences TTS the moment the microphone opens, whoever opened it.
     *
     * Speech and dictation share one pair of ears: left running, the glasses
     * record the phone voice into what the wearer is saying. Every path that
     * grants the microphone calls this — the plugin-facing lease and the hub's
     * own internal one, which is the one dictation actually uses. Cancelled
     * speech never resumes; a plugin that still wants it said, says it again.
     */
    private fun silenceSpeechForMicrophone() {
        if (::phoneTtsDispatcher.isInitialized) phoneTtsDispatcher.cancelForMicrophone()
        if (::phoneTtsDispatcher.isInitialized) phoneTtsDispatcher.prewarm()
    }

    @HubShellApi fun releaseInternalAudio(tag: String) {
        val leaseToStop = audioLeaseArbitrator.clearIf {
            it.side == AudioLeaseSide.INTERNAL && it.internalTag == tag
        }
        if (leaseToStop != null) stopAudioStreamQuietly()
    }

    private fun releaseAudioLease(envelope: BusEnvelope, replyRemote: Boolean, replyBinder: IBinder?) {
        val leaseId = envelope.payload.optString("leaseId")
        val leaseToStop = audioLeaseArbitrator.clearIf { it.leaseId == leaseId }
        if (leaseToStop != null) stopAudioStreamQuietly()
        replyToAudioRequest(envelope, replyRemote, JSONObject().put("released", true), replyBinder, leaseToStop?.holderPluginId)
        leaseToStop?.let { finalizeBackgroundPluginForLease(it, "RELEASED") }
    }

    private fun releaseAudioLeaseForLocalBinder(callbackBinder: IBinder, reason: String) {
        val leaseToStop = audioLeaseArbitrator.clearIf { current ->
            current.side == AudioLeaseSide.LOCAL && current.localCallbackBinder == callbackBinder
        }
        if (leaseToStop != null) {
            log("Audio lease ${leaseToStop.leaseId} released after $reason")
            stopAudioStreamQuietly()
            finalizeBackgroundPluginForLease(leaseToStop, reason)
        }
    }

    private fun revokeAudioLease(reason: String) {
        val leaseToRevoke = audioLeaseArbitrator.clear() ?: return
        finishRevokedAudioLease(leaseToRevoke, reason)
    }

    /** Ends [pluginId]'s background audio lease. The shell checks that it is the background plugin. */
    @HubShellApi fun revokeBackgroundAudioLease(pluginId: String, reason: String): Boolean {
        val leaseToRevoke = audioLeaseArbitrator.clearIf { lease ->
            lease.side == AudioLeaseSide.LOCAL &&
                lease.streamStarted &&
                lease.holderPluginId == pluginId
        } ?: return false
        finishRevokedAudioLease(leaseToRevoke, reason)
        return true
    }

    private fun finishRevokedAudioLease(leaseToRevoke: AudioLease, reason: String) {
        stopAudioStreamQuietly()
        if (leaseToRevoke.side == AudioLeaseSide.INTERNAL) {
            leaseToRevoke.internalConsumer?.onStopped(InternalAudioStopReason.LINK_LOST)
            return
        }
        val revoked = BusEnvelope(
            path = AUDIO_LEASE_REVOKED,
            id = leaseToRevoke.leaseId,
            payload = JSONObject()
                .put("leaseId", leaseToRevoke.leaseId)
                .put("reason", reason)
                .apply {
                    if (leaseToRevoke.side == AudioLeaseSide.LOCAL) {
                        leaseToRevoke.holderPluginId?.let { put("pluginId", it) }
                    }
                },
        )
        deliverAudioToHolder(leaseToRevoke, revoked)
        finalizeBackgroundPluginForLease(leaseToRevoke, reason)
    }

    private fun stopAudioLease(internalReason: InternalAudioStopReason) {
        val leaseToStop = audioLeaseArbitrator.clear()
        if (leaseToStop != null) {
            stopAudioStreamQuietly()
            if (leaseToStop.side == AudioLeaseSide.INTERNAL) {
                leaseToStop.internalConsumer?.onStopped(internalReason)
            }
            finalizeBackgroundPluginForLease(leaseToStop, internalReason.name)
        }
    }

    private fun finalizeBackgroundPluginForLease(lease: AudioLease, reason: String) {
        val pluginId = lease.holderPluginId ?: return
        foregroundPolicy.onAudioLeaseEnded(pluginId, reason)
    }

    private fun <T> runOnAudioMain(block: () -> T): T? {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return runCatching(block).getOrNull()
        }
        val task = FutureTask<T> { block() }
        if (!audioHandler.post(task)) return null
        return runCatching {
            task.get(INTERNAL_AUDIO_START_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        }.onFailure {
            task.cancel(false)
        }.getOrNull()
    }

    private fun stopAudioStreamQuietly() {
        val stopAudio = Runnable {
            runCatching { cxrLink?.stopAudioStream() }
            runCatching { cxrLink?.setCXRAudioCbk(null) }
            runCatching { cxrLink?.setInterruptAiWake(false) }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            stopAudio.run()
        } else {
            audioHandler.post(stopAudio)
        }
    }

    private fun forwardAudioFrame(data: ByteArray, offset: Int, length: Int) {
        val safeOffset = offset.coerceIn(0, data.size)
        val safeLength = length.coerceAtMost(data.size - safeOffset)
        if (safeLength <= 0) return
        val leaseSnapshot = audioLeaseArbitrator.withActive { current ->
            val seq = current.seq
            current.seq += 1
            current.copy(seq = seq)
        } ?: return
        if (leaseSnapshot.side == AudioLeaseSide.INTERNAL) {
            leaseSnapshot.internalConsumer?.onPcm(
                data = data,
                offset = safeOffset,
                length = safeLength,
                seq = leaseSnapshot.seq,
                elapsedRealtimeMs = SystemClock.elapsedRealtime(),
            )
            return
        }
        val chunk = data.copyOfRange(safeOffset, safeOffset + safeLength)
        val elapsedRealtime = SystemClock.elapsedRealtime()
        val frame = BusEnvelope(
            path = AUDIO_FRAMES,
            id = "${leaseSnapshot.leaseId}:${leaseSnapshot.seq}",
            payload = JSONObject()
                .put("leaseId", leaseSnapshot.leaseId)
                .put("seq", leaseSnapshot.seq)
                .put("elapsedRealtime", elapsedRealtime)
                .apply {
                    if (leaseSnapshot.side == AudioLeaseSide.LOCAL) {
                        leaseSnapshot.holderPluginId?.let { put("pluginId", it) }
                    }
                },
            binary = chunk,
        )
        deliverAudioToHolder(leaseSnapshot, frame)
    }

    private fun deliverAudioToHolder(lease: AudioLease, envelope: BusEnvelope) {
        when (lease.side) {
            AudioLeaseSide.LOCAL -> lease.localCallbackBinder?.let { deliverLocal(envelope, targetBinder = it) }
            AudioLeaseSide.REMOTE -> sendRemote(envelope)
            AudioLeaseSide.INTERNAL -> Unit
        }
    }

    private fun replyToAudioRequest(
        envelope: BusEnvelope,
        replyRemote: Boolean,
        payload: JSONObject,
        replyBinder: IBinder?,
        pluginId: String?,
    ) {
        val response = BusEnvelope(path = envelope.path + "/reply", id = envelope.id, payload = payload)
        if (!replyRemote && pluginId != null) response.payload.put("pluginId", pluginId)
        if (replyRemote) sendRemote(response) else deliverLocal(response, targetBinder = replyBinder)
    }

    private fun findLocalAudioHolder(senderUid: Int?): IBinder? {
        if (senderUid == null) return null
        val audioRegistration = registrations.firstOrNull { registration ->
            registration.uid == senderUid && registration.prefixes.any { prefix ->
                PathRules.matchesPrefix(AUDIO_FRAMES, prefix) ||
                    PathRules.matchesPrefix(AUDIO_LEASE_REVOKED, prefix)
            }
        }
        return audioRegistration?.callbackBinder ?: registrations.firstOrNull { it.uid == senderUid }?.callbackBinder
    }

    @HubShellApi fun sendRemote(envelope: BusEnvelope): String? {
        if (SppKeyProvisioning.isReserved(envelope.path)) return "INVALID_PATH"
        if (envelope.binary != null) {
            if (sppSession == null) {
                recordRemoteTransport(envelope, PluginBusJournal.Verdict.REJECTED, "NO_DATA_PLANE")
                return "NO_DATA_PLANE"
            }
            return if (writeSpp(envelope)) {
                recordRemoteTransport(envelope, PluginBusJournal.Verdict.OK, "SPP")
                null
            } else {
                recordRemoteTransport(envelope, PluginBusJournal.Verdict.REJECTED, "NO_DATA_PLANE")
                "NO_DATA_PLANE"
            }
        }
        val bytes = FrameProtocol.toJsonBytes(envelope)
        if (bytes.size <= BusConstants.CXR_CONTROL_MAX_BYTES && isCxrUp()) {
            if (sendCxr(envelope)) {
                recordRemoteTransport(envelope, PluginBusJournal.Verdict.OK, "CXR")
                return null
            }
        }
        if (bytes.size > BusConstants.CXR_CONTROL_MAX_BYTES && sppSession == null) {
            recordRemoteTransport(envelope, PluginBusJournal.Verdict.REJECTED, "NO_DATA_PLANE")
            return "NO_DATA_PLANE"
        }
        if (writeSpp(envelope)) {
            recordRemoteTransport(envelope, PluginBusJournal.Verdict.OK, "SPP")
            return null
        }
        val error = if (bytes.size > BusConstants.CXR_CONTROL_MAX_BYTES) "NO_DATA_PLANE" else "NO_LINK"
        recordRemoteTransport(envelope, PluginBusJournal.Verdict.REJECTED, error)
        return error
    }

    @HubShellApi fun sendBuiltInPluginEnvelope(envelope: BusEnvelope): String? {
        if (envelope.path == BusPaths.SURFACE_SHOW || envelope.path == BusPaths.SURFACE_UPDATE) {
            validateSurfaceImageEnvelope(envelope)?.let { return it }
        }
        return sendRemote(envelope)
    }

    private fun sendCxr(envelope: BusEnvelope): Boolean =
        runCatching {
            val json = FrameProtocol.toJson(envelope).toString()
            val result = cxrLink?.sendCustomCmd(
                BusConstants.CXR_KEY,
                Caps().apply { write(json) }.serialize(),
            )
            log("CXR TX ${envelope.path} id=${envelope.id} result=$result")
            result != null && result >= 0
        }.getOrElse {
            log("CXR TX failed ${it.javaClass.simpleName}: ${it.message}")
            false
        }

    private fun offerSppKeyForCurrentCxr(revision: Long) {
        if (!hubEnabled || sppLoopStop || !isCxrUp()) return
        runCatching {
            sppProvisioning.execute {
                if (!sppCxrIdentity.isCurrentOffer(revision)) return@execute
                runCatching { sppPairing.offerCurrent(::sendSppProvisioning) }
                    .onFailure { log("SPP provisioning unavailable; retrying on connection attempt") }
            }
        }
    }

    private fun sendSppProvisioning(prepared: PhoneSppPairing.Prepared): Boolean = runCatching {
        if (!hubEnabled || sppLoopStop || !isCxrUp()) return false
        sppPairing.sendProvisioning(
            prepared,
            serialize = { envelope ->
                Caps().apply { write(FrameProtocol.toJson(envelope).toString()) }.serialize()
            },
            sendCustomCmd = { bytes ->
                val result = cxrLink?.sendCustomCmd(BusConstants.CXR_KEY, bytes)
                result != null && result >= 0
            },
            onStale = { log("SPP provisioning stale; retrying on connection attempt") },
        ).also { offered ->
            if (offered) log("SPP pairing key offered over CXR")
        }
    }.getOrDefault(false)

    private fun updateSppKeyStatus(status: PhoneSppPairing.KeyStatus) {
        if (sppKeyStatus == status) return
        sppKeyStatus = status
        log(when (status) {
            PhoneSppPairing.KeyStatus.UNAVAILABLE -> "SPP pairing key unavailable"
            PhoneSppPairing.KeyStatus.RECOVERING -> "SPP pairing key recovery over CXR"
            PhoneSppPairing.KeyStatus.RECOVERED -> "SPP pairing key recovered; awaiting authentication"
        })
        updateStatusNotification(linkState())
    }

    private fun writeSpp(envelope: BusEnvelope): Boolean {
        val (activeSocket, session) = synchronized(sppLock) {
            (socket ?: return false) to (sppSession ?: return false)
        }
        return runCatching {
            session.write(activeSocket.outputStream, envelope)
            log("SPP TX ${envelope.path} id=${envelope.id}")
            true
        }.getOrElse {
            log("SPP TX failed ${it.javaClass.simpleName}")
            closeSocket(activeSocket)
            false
        }
    }

    private fun pluginRegistrationResult(pluginId: String, result: Int, reason: String? = null): Int {
        pluginBusJournal.record(
            pluginId = pluginId.ifBlank { null },
            category = PluginBusJournal.Category.REGISTRATION,
            direction = PluginBusJournal.Direction.PLUGIN_TO_HUB,
            path = BusPaths.PLUGIN_REGISTRATION,
            verdict = if (result == PluginRegistrationResult.APPROVED) {
                PluginBusJournal.Verdict.OK
            } else {
                PluginBusJournal.Verdict.REJECTED
            },
            reason = reason,
        )
        return result
    }

    private fun addRegistration(
        clientId: String,
        prefixes: List<String>,
        uid: Int,
        cb: IBusCallback,
        principal: PhonePluginPrincipal? = null,
        grantedCapabilities: Set<PluginCapability> = emptySet(),
    ): Boolean {
        val callbackBinder = cb.asBinder()
        val replacedRegistrations = registrations.filter {
            it.callbackBinder == callbackBinder
        }
        val deathRecipient = IBinder.DeathRecipient {
            removeRegistrationsByBinder(callbackBinder, "binderDied")
        }
        if (runCatching { callbackBinder.linkToDeath(deathRecipient, 0) }.isFailure) {
            pluginBusJournal.record(
                pluginId = principal?.descriptor?.id,
                category = PluginBusJournal.Category.REGISTRATION,
                direction = PluginBusJournal.Direction.PLUGIN_TO_HUB,
                path = BusPaths.PLUGIN_REGISTRATION,
                verdict = PluginBusJournal.Verdict.REJECTED,
                reason = "CALLBACK_UNAVAILABLE",
            )
            log("client registration rejected status=callback_unavailable")
            return false
        }
        val registration = Registration(
            clientId = clientId,
            prefixes = prefixes,
            uid = uid,
            callbackBinder = callbackBinder,
            callback = cb,
            deathRecipient = deathRecipient,
            principal = principal,
            grantedCapabilities = grantedCapabilities,
        )
        registrations += registration
        // Keep the old registration live until the replacement callback has a
        // death link and is registered. A failed re-registration is not a
        // connection drop and must not strand or spuriously clear activity.
        replacedRegistrations.forEach { removeRegistration(it, "replace") }
        pluginBusJournal.record(
            pluginId = principal?.descriptor?.id,
            category = PluginBusJournal.Category.REGISTRATION,
            direction = PluginBusJournal.Direction.PLUGIN_TO_HUB,
            path = BusPaths.PLUGIN_REGISTRATION,
            reason = "CLIENT_REGISTERED",
        )
        runCatching { cb.onLinkState(linkState()) }
        hooks.onClientRegistered(prefixes, principal?.grantKey())
        return true
    }

    /**
     * Single permanent connection thread: the only place that ever creates,
     * assigns or retires the SPP socket. A parallel connect attempt against a
     * live RFCOMM link kills it at the stack level, so there must be exactly one.
     */
    @SuppressLint("MissingPermission")
    private fun connectSpp() {
        if (!sppLoopStarted.compareAndSet(false, true)) return
        Thread({
            while (!sppLoopStop) {
                val attempt = sppBackoff.beginAttempt()
                if (!hubEnabled) {
                    sppBackoff.await(attempt, 750L)
                    continue
                }
                if (!canRunHub(this)) {
                    log("Missing BLUETOOTH_CONNECT; SPP loop waiting")
                    sppBackoff.await(attempt, 5_000L)
                    continue
                }
                val device = pickBondedDevice()
                if (device == null) {
                    log("No bonded glasses device found; SPP loop waiting")
                    sppBackoff.await(attempt, 10_000L)
                    continue
                }
                var current: BluetoothSocket? = null
                try {
                    val pairing = sppPairing.prepare(device.address, ::sendSppProvisioning)
                        ?: throw IOException("SPP pairing unavailable")
                    log("SPP connecting to bonded glasses")
                    val candidate = device.createInsecureRfcommSocketToServiceRecord(BusConstants.SPP_UUID)
                    current = candidate
                    synchronized(sppLock) {
                        if (!hubEnabled || sppLoopStop) throw IOException("Hub stopped")
                        socket = candidate
                    }
                    candidate.connect()
                    val deadline = SppHandshakeDeadline(
                        schedule = { delay, task ->
                            val future = sppDeadlines.schedule(task, delay, TimeUnit.MILLISECONDS)
                            ({ future.cancel(false); Unit })
                        },
                        close = { runCatching { candidate.close() }; Unit },
                    )
                    val session = try {
                        sppPairing.authenticate(device.address, pairing, candidate.inputStream, candidate.outputStream, sppNonces)
                    } catch (failure: Exception) {
                        deadline.complete()
                        throw failure
                    }
                    if (!deadline.complete()) throw IOException("SPP handshake timed out")
                    synchronized(sppLock) {
                        if (socket !== candidate || !hubEnabled || sppLoopStop) {
                            throw IOException("SPP connection retired")
                        }
                        sppSession = session
                    }
                    sppBackoff.connected()
                    sppKeyStatus = null
                    log("SPP authenticated")
                    notifyLinkState()
                    readSppLoop(candidate, session)
                    log("SPP link closed")
                } catch (t: Throwable) {
                    log("SPP connect failed: ${t.javaClass.simpleName}; retrying in ${sppBackoff.retryDelayMs()}ms")
                } finally {
                    runCatching { current?.close() }
                    current?.let { closeSocket(it) }
                    notifyLinkState()
                }
                sppBackoff.awaitRetry(attempt)
            }
        }, "rokidbus-spp").apply { isDaemon = true }.start()
    }

    private fun readSppLoop(activeSocket: BluetoothSocket, session: SppAuthProtocol.Session) {
        val input = activeSocket.inputStream
        while (true) {
            val envelope = session.read(input) ?: return
            log("SPP RX ${envelope.path} id=${envelope.id}")
            routeRemote(envelope)
        }
    }

    @SuppressLint("MissingPermission")
    private fun pickBondedDevice(): BluetoothDevice? {
        val bonded = BluetoothAdapter.getDefaultAdapter()?.bondedDevices?.toList().orEmpty()
        val rememberedAddress = prefs().getString(PREF_LAST_GLASSES_ADDRESS, null)
        val selectedIndex = GlassesBondedDeviceSelector.pickIndex(
            bonded.map { device ->
                BondedBluetoothDevice(
                    address = device.address,
                    name = device.name,
                    alias = device.alias,
                    serviceUuids = device.uuids.orEmpty().map { it.uuid.toString() }.toSet(),
                )
            },
            preferredAddress = rememberedAddress,
        ) ?: return null
        return bonded[selectedIndex].also { selected ->
            if (!selected.address.equals(rememberedAddress, ignoreCase = true)) {
                prefs().edit().putString(PREF_LAST_GLASSES_ADDRESS, selected.address).apply()
            }
        }
    }

    private fun startCxrIfTokenAvailable() {
        val token = prefs().getString(PREF_TOKEN, "").orEmpty()
        if (token.isNotBlank()) startCxr(token)
    }

    /**
     * [wearerAsked]: a start or the Glass app screen, for which a session Hi Rokid just closed is no
     * reason to stay down. An automatic attempt (false) never binds into one: Hi Rokid closes the
     * session on a binder thread and the closure reaches us on the main thread later, so the flag can
     * still be clear when the attempt starts; `connect` then finishes the closed bind first, which
     * sets it, and the new bind is let go ([CxrStart.DROPPED]). A bind the library refused is
     * [CxrStart.NOT_BOUND]; the link state says so.
     */
    private fun startCxr(token: String, wearerAsked: Boolean = true): CxrStart {
        val link = cxrLink ?: (seams.cxr ?: CxrLinkTransport(CXRLink(applicationContext))).apply {
            configCXRSession(
                CxrDefs.CXRSession(
                    CxrDefs.CXRSessionType.CUSTOMAPP,
                    identity.glassesApplicationId,
                ),
            )
            setCXRLinkCbk(linkCallback)
            setCXRCustomCmdCbk(customCmdCallback)
        }.also { cxrLink = it }
        val bound = runCatching { link.connect(token) }.getOrDefault(false)
        // After connect: it may first finish a bind Hi Rokid had just closed, setting the flag.
        if (bound && cxrClosedByServer) {
            if (!wearerAsked) {
                runCatching { link.disconnect() }
                log("CXR-L reconnect dropped: Hi Rokid closed the session")
                notifyLinkState()
                return CxrStart.DROPPED
            }
            cxrClosedByServer = false
            log("CXR-L closed-session flag cleared by a wearer start")
            updateStatusNotification(linkState())
        }
        log("CXR-L connect requested bound=$bound")
        if (!bound) {
            cxrConnected = false
            glassBtConnected = false
            sppCxrIdentity.onConnectionChanged(false)
            glassesWorn = false
            notifyLinkState()
        }
        return if (bound) CxrStart.BOUND else CxrStart.NOT_BOUND
    }

    private enum class CxrStart { BOUND, NOT_BOUND, DROPPED }

    private fun isPhoneWifiEnabled(): Boolean =
        runCatching {
            getSystemService(WifiManager::class.java)?.isWifiEnabled == true
        }.getOrDefault(true)

    /**
     * An APK other than the glasses app, through the same CXR app slot as the installer. Busy is
     * false; the callback runs once for an answer and never after a lost link.
     */
    @HubShellApi fun uploadThirdPartyApk(apk: File, callback: (Boolean) -> Unit): Boolean {
        val link = cxrLink ?: return false
        if (!isCxrUp()) return false
        val op = glassesAppSlot.tryAcquire(GlassesAppSlot.Kind.THIRD_PARTY_UPLOAD) ?: return false
        glassesAppSlot.dispatchAsync(
            op,
            call = { cbk -> link.appUploadAndInstall(apk.absolutePath, cbk) },
        ) { result ->
            when (result) {
                is GlassesAppSlot.DispatchResult.Answered -> callback(result.value.success)
                GlassesAppSlot.DispatchResult.Threw -> callback(false)
                GlassesAppSlot.DispatchResult.LinkLost -> Unit
            }
            op.finish()
        }
        return true
    }

    private suspend fun openGlassesActivity(activityClassName: String): Boolean {
        val link = cxrLink ?: return false
        if (!isCxrUp()) return false
        val op = glassesAppSlot.acquire(GlassesAppSlot.Kind.LAUNCH)
        try {
            val result = glassesAppSlot.dispatch(
                op,
                call = { cbk -> link.appStart(activityClassName, cbk) },
            ) { answer -> answer.success }
            return (result as? GlassesAppSlot.DispatchResult.Answered)?.value == true
        } finally {
            op.finish()
        }
    }

    private suspend fun queryGlassesInstalled(): Boolean? {
        val link = cxrLink ?: return null
        if (!isCxrUp()) return null
        val op = glassesAppSlot.acquire(GlassesAppSlot.Kind.QUERY)
        try {
            val result = glassesAppSlot.dispatch(
                op,
                call = { cbk -> link.appIsInstalled(cbk) },
            ) { answer -> answer.success }
            return (result as? GlassesAppSlot.DispatchResult.Answered)?.value
        } finally {
            op.finish()
        }
    }

    private fun decodeCxrPayload(payload: ByteArray): BusEnvelope? =
        runCatching {
            val caps = Caps.fromBytes(payload)
            if (caps.size() == 0) return@runCatching null
            FrameProtocol.fromJson(JSONObject(caps.at(0).string))
        }.onFailure {
            log("CXR decode failed")
        }.getOrNull()

    // The shell's Service promotes itself; the core keeps the microphone bookkeeping.
    private fun startForegroundWithType(): SttError? {
        val requestMicrophone = speechMicrophoneForegroundRequested
        val failure = config.foreground.promote(microphone = requestMicrophone)
        if (failure == null) {
            speechMicrophoneForegroundActive = requestMicrophone
            speechMicrophoneForegroundFailure = ""
            return null
        }
        speechMicrophoneForegroundActive = false
        speechMicrophoneForegroundFailure = foregroundFailureDetail(failure)
        if (requestMicrophone) {
            return SttError(
                SttErrorKind.SOURCE_UNAVAILABLE,
                SpeechProvider.ANDROID.displayName,
                "Microphone foreground service is unavailable " +
                    "(${speechMicrophoneForegroundFailure})",
            )
        }
        return null
    }

    private fun requestSpeechMicrophoneForegroundOnMain(): SttError? {
        speechMicrophoneForegroundRequested = true
        val error = startForegroundWithType()
        if (error != null) speechMicrophoneForegroundRequested = false
        return error
    }

    private fun releaseSpeechMicrophoneForegroundOnMain() {
        if (!speechMicrophoneForegroundRequested && !speechMicrophoneForegroundActive) return
        speechMicrophoneForegroundRequested = false
        startForegroundWithType()
    }

    private fun foregroundFailureDetail(failure: Throwable?): String {
        if (failure == null) return "ForegroundServiceException"
        val type = failure.javaClass.simpleName.ifBlank { "ForegroundServiceException" }
        val message = failure.message?.trim().orEmpty()
        return if (message.isBlank()) type else "$type: $message"
    }

    @HubShellApi fun linkState(): Int = PhoneLinkState.compose(
        cxrControlUp = isCxrUp(),
        sppDataUp = (sppSession != null && socket?.isConnected == true) || seams.sppDataUp(),
        glassesBondedOrPhoneConnected = isGlassesBonded(),
        glassesWorn = glassesWorn,
    )

    @SuppressLint("MissingPermission")
    private fun isGlassesBonded(): Boolean =
        canRunHub(this) &&
            pickBondedDevice() != null

    @HubShellApi fun isCxrUp(): Boolean =
        cxrConnected && glassBtConnected && cxrLink?.isServiceConnected() == true

    private fun notifyGlassesAiButton(active: Boolean) {
        registrations.forEach { registration ->
            runCatching { registration.callback.onGlassesAiButton(active) }
                .onFailure { removeRegistration(registration, "dead callback") }
        }
    }

    /**
     * Resolves the assistant from installed principals as well as live registrations because the
     * normal plugin state is dormant and therefore has no binder registration. The current grant
     * remains the authority; a live registration, when present, must agree with it.
     */
    private fun notifyGlassesDeviceInfo(info: GlassInfo) {
        val eventId = UUID.randomUUID().toString()
        registrations.mapNotNull { it.principal }
            .distinctBy { it.grantKey() }
            .forEach { principal ->
                deliverExternalLifecycle(
                    principal = principal,
                    path = BusPaths.GLASSES_DEVICE_INFO,
                    id = eventId,
                    payload = GlassesDeviceInfoPayload.create(
                        info = info,
                        pluginId = principal.descriptor.id,
                        eventId = eventId,
                    ),
                )
            }
    }

    private fun notifyLinkState() {
        val state = linkState()
        val previousTransportState = lastTransportLinkState
        lastTransportLinkState = state
        val transportBits = LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP
        if (state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) == 0) {
            remoteImageSurfaceVersion = 0
            remoteInkSurfaceVersion = 0
            remoteMaxImageBytes = 0
            // remotePinSurfaceVersion and remoteActivitySurfaceVersion (with its extras)
            // deliberately survive,
            // for the same reason as the setup state below: support is a property of the
            // glasses, not of the link, and both tiers have canonical state plus reconnect
            // resends. The next announce overwrites them, so swapping in older glasses
            // corrects itself. Image support is not kept — an image has no canonical state
            // to resend, so it must refuse while the link is down.
            // The announced version answers installedVersion() only for the link it came on.
            remoteGlassesVersionName = null
            imageSurfaceRateLimiter.clear()
        }
        hooks.onLinkState(state, previousTransportState)
        if (previousTransportState and transportBits != 0 && state and transportBits == 0) {
            inkRouter.clearForLinkLoss()
        }
        updateStatusNotification(state)
        registrations.forEach { registration ->
            runCatching { registration.callback.onLinkState(state) }
                .onFailure { removeRegistration(registration, "dead callback") }
        }
        if (state and (LinkStateBits.CXR_CONTROL_UP or LinkStateBits.SPP_DATA_UP) != 0) {
            foregroundPolicy.syncLauncherList()
            announcePhoneCapabilities()
        } else {
            lastAnnouncedPhoneCapabilities = null
        }
    }

    /** The glasses learn phone-side feature bits (camera readiness) only through this. */
    @HubShellApi fun announcePhoneCapabilities() {
        val hudPosition = PhoneHudPositionStore(context)
        val announced = hooks.announcement(
            PhoneHubCapabilitiesContract.create(
                features = 0,
                cameraConsumerName = null,
                activityAlwaysExpanded =
                    PhoneActivityPresentationSettings(context).isAlwaysExpanded(),
                hudTopInsetDp = hudPosition.hudTopInsetDp(),
                hudPositionAuto = hudPosition.hudPositionAuto(),
            ),
        )
        if (announced == lastAnnouncedPhoneCapabilities) return
        val envelope = BusEnvelope(
            path = BusPaths.HUB_CAPABILITIES,
            id = UUID.randomUUID().toString(),
            payload = PhoneHubCapabilitiesContract.toJson(announced),
        )
        if (sendRemote(envelope) == null) {
            lastAnnouncedPhoneCapabilities = announced
            log("phone capabilities announced features=${announced.features}")
        }
    }

    private fun errorEnvelope(id: String, code: String, pluginId: String? = null): BusEnvelope =
        BusEnvelope(
            path = BusPaths.ERROR,
            id = id,
            payload = JSONObject().put("code", code).put("forId", id).apply {
                if (pluginId != null) put("pluginId", pluginId)
            },
        )

    @HubShellApi fun capabilities(): Int {
        var capabilities = 0
        if (remoteImageSurfaceVersion == ImageSurfaceContract.VERSION &&
            remoteMaxImageBytes >= ImageSurfaceContract.MAX_IMAGE_BYTES &&
            linkState() and LinkStateBits.SPP_DATA_UP != 0
        ) {
            capabilities = capabilities or BusCapabilityBits.IMAGE_SURFACE
        }
        if (PhoneInkCapabilityPolicy.isAvailable(remoteInkSurfaceVersion, linkState())) {
            capabilities = capabilities or BusCapabilityBits.INK_SURFACE
        }
        // Deliberately not gated on the link, unlike IMAGE_SURFACE above: the bit means
        // "these glasses can show a pin", not "a pin would go out this instant". A pin has
        // canonical phone-side state and a resend path, so one pushed while the glasses are
        // asleep is held and delivered on the next announce. An image has neither, so it
        // still has to refuse when the link is down.
        if (remotePinSurfaceVersion == PinSurfaceContract.VERSION) {
            capabilities = capabilities or BusCapabilityBits.PIN_SURFACE
        }
        // Gated on the link, unlike the pin above and for the mirror-image reason:
        // a notice has no resend path because it is never worth delivering late,
        // so a plugin must learn the glasses are unreachable before it composes a
        // banner, not after.
        if (remoteNoticeSurfaceVersion == NoticeSurfaceContract.VERSION &&
            linkState() and LinkStateBits.SPP_DATA_UP != 0
        ) {
            capabilities = capabilities or BusCapabilityBits.NOTICE_SURFACE
        }
        // Like pins, activities have canonical phone-side state and an announce-time
        // resend. Their owner must stay connected, but a transient glasses-link loss does
        // not make an otherwise valid start or update disappear.
        if (remoteActivitySurfaceVersion == ActivitySurfaceContract.VERSION) {
            capabilities = capabilities or BusCapabilityBits.ACTIVITY_SURFACE
            if (remoteActivityExtrasVersion == ActivitySurfaceContract.EXTRAS_VERSION) {
                capabilities = capabilities or BusCapabilityBits.ACTIVITY_EXTRAS
            }
        }
        // Same reasoning as the notice gate above: a card opened to type into is a
        // live interactive moment, not state a plugin can just resend once the
        // glasses come back — so the bit means "reachable right now", not merely
        // "this hub build understands the field".
        if (remoteEditableSurfaceVersion == EditableSurfaceContract.VERSION &&
            linkState() and LinkStateBits.SPP_DATA_UP != 0
        ) {
            capabilities = capabilities or BusCapabilityBits.EDITABLE_SURFACE
        }
        capabilities = capabilities or BusCapabilityBits.TTS
        return hooks.extraCapabilities(capabilities)
    }

    private fun updateRemoteCapabilities(payload: JSONObject) {
        val advertised = GlassesHubCapabilitiesContract.parse(payload)
        val imageSupported = advertised.protocolVersion == GlassesHubCapabilitiesContract.VERSION &&
            advertised.features and BusCapabilityBits.IMAGE_SURFACE != 0 &&
            advertised.imageSurfaceVersion == ImageSurfaceContract.VERSION &&
            advertised.maxImageBytes >= ImageSurfaceContract.MAX_IMAGE_BYTES
        val pinSupported = advertised.protocolVersion == GlassesHubCapabilitiesContract.VERSION &&
            advertised.features and BusCapabilityBits.PIN_SURFACE != 0 &&
            advertised.pinSurfaceVersion == PinSurfaceContract.VERSION
        remoteImageSurfaceVersion = if (imageSupported) ImageSurfaceContract.VERSION else 0
        val noticeSupported = advertised.protocolVersion == GlassesHubCapabilitiesContract.VERSION &&
            advertised.features and BusCapabilityBits.NOTICE_SURFACE != 0 &&
            advertised.noticeSurfaceVersion == NoticeSurfaceContract.VERSION
        val activitySupported = advertised.protocolVersion == GlassesHubCapabilitiesContract.VERSION &&
            advertised.features and BusCapabilityBits.ACTIVITY_SURFACE != 0 &&
            advertised.activitySurfaceVersion == ActivitySurfaceContract.VERSION
        val acceptedInkVersion = PhoneInkCapabilityPolicy.acceptedVersion(advertised)
        val editableSupported = GlassesHubCapabilitiesContract.supportsEditableSurface(advertised)
        remotePinSurfaceVersion = if (pinSupported) PinSurfaceContract.VERSION else 0
        remoteNoticeSurfaceVersion = if (noticeSupported) NoticeSurfaceContract.VERSION else 0
        remoteActivitySurfaceVersion = if (activitySupported) ActivitySurfaceContract.VERSION else 0
        remoteActivityExtrasVersion =
            if (GlassesHubCapabilitiesContract.supportsActivityExtras(advertised)) {
                ActivitySurfaceContract.EXTRAS_VERSION
            } else {
                0
            }
        remoteInkSurfaceVersion = acceptedInkVersion
        remoteEditableSurfaceVersion = if (editableSupported) EditableSurfaceContract.VERSION else 0
        remoteMaxImageBytes = if (imageSupported) advertised.maxImageBytes else 0
        remoteGlassesVersionName = advertised.versionName
        hooks.onGlassesCapabilities(payload)
        log(
            "renderer capabilities image=$imageSupported pin=$pinSupported " +
                "notice=${advertised.features and BusCapabilityBits.NOTICE_SURFACE != 0} " +
                "activity=$activitySupported " +
                "maxImageBytes=$remoteMaxImageBytes",
        )
        // Link bits may be unchanged; repeat the callback so clients refresh capabilities().
        notifyLinkState()
        if (pinSupported) pinRouter.resendIfAvailable()
        if (activitySupported) activityRouter.resendIfAvailable()
    }

    private fun validateImageEnvelope(envelope: BusEnvelope): String? {
        if (capabilities() and BusCapabilityBits.IMAGE_SURFACE == 0) {
            return ImageSurfaceContract.ERROR_CAPABILITY_NOT_AVAILABLE
        }
        val validation = ImageSurfaceContract.validate(envelope.payload, envelope.binary)
        if (validation is ImageSurfaceValidationResult.Invalid) return validation.code
        val metadata = (validation as ImageSurfaceValidationResult.Valid).metadata
        return validateDecodedImageEnvelope(envelope, metadata)
    }

    private fun validateMediaArtworkEnvelope(envelope: BusEnvelope): String? {
        if (capabilities() and BusCapabilityBits.IMAGE_SURFACE == 0) {
            return ImageSurfaceContract.ERROR_CAPABILITY_NOT_AVAILABLE
        }
        val validation = MediaArtworkContract.validate(envelope.payload, envelope.binary)
        if (validation is ImageSurfaceValidationResult.Invalid) return validation.code
        val metadata = (validation as ImageSurfaceValidationResult.Valid).metadata
        return validateDecodedImageEnvelope(envelope, metadata)
    }

    private fun validateSurfaceImageEnvelope(envelope: BusEnvelope): String? =
        when (envelope.payload.optString("kind")) {
            ImageSurfaceContract.KIND -> validateImageEnvelope(envelope)
            MediaArtworkContract.KIND -> if (
                MediaArtworkContract.hasBinaryArtwork(envelope.payload) || envelope.binary != null
            ) {
                validateMediaArtworkEnvelope(envelope)
            } else {
                null
            }
            else -> null
        }

    private fun validateDecodedImageEnvelope(
        envelope: BusEnvelope,
        metadata: ImageSurfaceMetadata,
    ): String? {
        val bytes = envelope.binary ?: return ImageSurfaceContract.ERROR_INVALID_IMAGE
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth != metadata.pixelWidth || options.outHeight != metadata.pixelHeight ||
            options.outMimeType != metadata.mimeType
        ) {
            return ImageSurfaceContract.ERROR_INVALID_IMAGE
        }
        val surfaceId = envelope.payload.optString("surfaceId")
        if (surfaceId.isBlank()) return ImageSurfaceContract.ERROR_INVALID_IMAGE
        if (!imageSurfaceRateLimiter.tryAcquire(surfaceId)) {
            return ImageSurfaceContract.ERROR_IMAGE_RATE_LIMITED
        }
        return null
    }

    private fun closeSocket(expected: BluetoothSocket? = null) {
        val retired = synchronized(sppLock) {
            if (expected != null && socket !== expected) return
            val current = socket
            socket = null
            sppSession = null
            current
        }
        runCatching { retired?.close() }
    }

    private fun isDebuggableBuild(): Boolean =
        applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun log(message: String) {
        config.log(message)
    }

    // ---- The upstream shell's entry points ----

    @HubShellApi val isEnabled: Boolean get() = hubEnabled

    @HubShellApi val microphoneForegroundRequested: Boolean get() = speechMicrophoneForegroundRequested

    @HubShellApi
    fun sppKeyState(): SppKeyState? = when (sppKeyStatus) {
        PhoneSppPairing.KeyStatus.UNAVAILABLE -> SppKeyState.UNAVAILABLE
        PhoneSppPairing.KeyStatus.RECOVERING -> SppKeyState.RECOVERING
        PhoneSppPairing.KeyStatus.RECOVERED -> SppKeyState.RECOVERED
        null -> null
    }

    @HubShellApi fun cxrLinkOrNull(): CXRLink? = (cxrLink as? CxrLinkTransport)?.link

    /**
     * Main thread. Connects CXR again with the stored token, the same call the first start and the
     * Glass app screen make. Nothing in the core does it on its own after the link drops, so a shell
     * that wants the link kept up calls this. False, and nothing done, when the hub is stopped, the
     * link is already up, Hi Rokid closed the session (also one whose closure is still on its way
     * here, which `connect` delivers) or no token is stored.
     */
    @HubShellApi @MainThread
    fun reconnectCxr(): Boolean {
        if (!hubEnabled || closed || isCxrUp() || cxrClosedByServer) return false
        val token = prefs().getString(PREF_TOKEN, "").orEmpty()
        if (token.isBlank()) return false
        log("CXR-L reconnect requested")
        return startCxr(token, wearerAsked = false) != CxrStart.DROPPED
    }

    /**
     * Main thread. Makes sure the CXR link is there for something the wearer just asked for (a voice
     * reply on the glasses). A live link is reused and nothing is bound. A link that is down is bound
     * again with the stored token, exactly as the Glass app screen does, and a session Hi Rokid closed
     * is no reason to stay down: the closure is cleared once the bind is made. The link then comes up
     * on the usual callbacks; this does not wait for it, and never loops. Never for a background retry,
     * which must not fight Hi Rokid ([reconnectCxr] refuses while a closure stands).
     */
    @HubShellApi @MainThread
    fun ensureCxrLink(): CxrEnsureResult {
        if (!hubEnabled || closed) return CxrEnsureResult.HUB_STOPPED
        if (isCxrUp()) return CxrEnsureResult.ALREADY_UP
        val token = prefs().getString(PREF_TOKEN, "").orEmpty()
        if (token.isBlank()) return CxrEnsureResult.NO_TOKEN
        log("CXR-L ensure: link down, binding for the wearer closedByServer=$cxrClosedByServer")
        return when (startCxr(token, wearerAsked = true)) {
            CxrStart.BOUND -> CxrEnsureResult.CONNECTING
            else -> CxrEnsureResult.NOT_BOUND
        }
    }

    /** Main thread. Persists the CXR token, then start(). */
    @HubShellApi @MainThread
    fun startWithToken(token: String) {
        prefs().edit().putString(PREF_TOKEN, token).apply()
        start()
    }

    /** The plugin bus, the same instance for the core's lifetime. */
    @HubShellApi fun busBinder(): IBusService.Stub = binder

    @HubShellApi
    fun deliverToPrincipal(principal: PhonePluginPrincipal, path: String, id: String, payload: JSONObject): Boolean =
        deliverExternalLifecycle(principal, path, id, payload)

    @HubShellApi
    fun deliverBinaryToPrincipal(
        principal: PhonePluginPrincipal,
        path: String,
        id: String,
        payload: JSONObject,
        data: ByteArray,
    ): Boolean = deliverExternalBinary(principal, path, id, payload, data)

    @HubShellApi
    fun deliverErrorToPrincipal(principal: PhonePluginPrincipal, forId: String, code: String) {
        val binder = registrations.firstOrNull { it.principal?.grantKey() == principal.grantKey() }?.callbackBinder
        deliverError(binder, forId, code)
    }

    @HubShellApi fun registeredPrincipals(): List<PhonePluginPrincipal> = registrations.mapNotNull(Registration::principal)

    /** What [principal]'s live registration was granted, or null when it has none. */
    @HubShellApi
    fun grantedCapabilities(principal: PhonePluginPrincipal): Set<PluginCapability>? =
        registrations.firstOrNull { it.principal?.grantKey() == principal.grantKey() }?.grantedCapabilities

    @HubShellApi
    fun recordLocalRoute(
        envelope: BusEnvelope,
        sender: AuthorizedSender,
        verdict: PluginBusJournal.Verdict,
        reason: String? = null,
    ) = recordLocalRoute(
        envelope,
        if (sender.caller == PluginRouteCaller.Internal) Process.myUid() else Process.INVALID_UID,
        sender,
        verdict,
        reason,
    )

    /** Main thread or a worker. Re-reports the link to every client, as after a capability change. */
    @HubShellApi fun refreshLinkState() = notifyLinkState()

    /** After a package change: the pin, notice and activity of owners that lost their grant go. */
    @HubShellApi
    fun clearUnavailableOwners(validPrincipals: List<PhonePluginPrincipal>) {
        // Keyed by owner id, not by registration: the pin's owner is usually dormant by
        // the time it is uninstalled, so there is no binder left to notice it going away.
        pinRouter.ownerPluginId()?.let { owner ->
            val stillGranted = validPrincipals.any { principal ->
                principal.descriptor.id == owner &&
                    hooks.grantFor(principal) is PluginGrantState.Approved
            }
            if (!stillGranted) pinRouter.clearForRevokedOwner(owner, "ownerUnavailable")
            if (!stillGranted) noticeRouter.clearForRevokedOwner(owner, "ownerUnavailable")
        }
        activityRouter.ownerPluginIds().forEach { owner ->
            val stillGranted = validPrincipals.any { principal ->
                principal.descriptor.id == owner &&
                    (hooks.grantFor(principal) as? PluginGrantState.Approved)
                        ?.capabilities
                        ?.contains(PluginCapability.SURFACES) == true
            }
            if (!stillGranted) activityRouter.clearForRevokedOwner(owner, "ownerUnavailable")
        }
    }

    /** Starts [activityClassName] on the glasses through the one CXR app slot. */
    @HubShellApi suspend fun openOnGlasses(activityClassName: String): Boolean = openGlassesActivity(activityClassName)

    /** Whether the glasses app is installed, or null when CXR could not say. */
    @HubShellApi suspend fun queryGlassesAppInstalled(): Boolean? = queryGlassesInstalled()

    @HubShellApi
    val phoneTts: PhoneTtsPort = object : PhoneTtsPort {
        override val isReady: Boolean get() = phoneTtsDispatcher.isReady
        override fun availableVoices(locale: Locale?): List<PhoneTtsVoiceOption> =
            phoneTtsDispatcher.availableVoices(locale)
        override fun speakSample(text: String, locale: Locale): Boolean =
            phoneTtsDispatcher.speakSample(text, locale)
    }

    /** Transcript callbacks go straight to [listener] and never enter a log. */
    @HubShellApi @MainThread
    fun startSpeechDictationTest(listener: SpeechUtteranceListener): SpeechStartResult =
        speechSessionManager.startUtterance(listener)

    @HubShellApi @MainThread fun cancelSpeechDictationTest() = speechSessionManager.cancel()

    @HubShellApi @MainThread fun isSpeechDictationTestActive(): Boolean = speechSessionManager.isActive

    @HubShellApi fun isAssistSessionCurrent(session: Int): Boolean = assistSession.isCurrent(session)

    @HubShellApi val isAssistButtonHeld: Boolean get() = assistSession.isHeld

    /** An already-active assistant hears of the press on main, in order with its release. */
    @HubShellApi
    fun signalWarmAssistPress(session: Int, press: Int) {
        assistSessionHandler.post { signalWarmPress(session, press) }
    }

    companion object {
        private const val SKILLS_ROOT = "/skills"
        private const val INTERNAL_AUDIO_START_TIMEOUT_SECONDS = 10L
        private const val MODE_PRIVATE = Context.MODE_PRIVATE
        private const val IN_PROCESS_COMPONENT = "<in-process>"
        private const val IN_PROCESS_DIGEST = "in-process"

        fun canRunHub(context: android.content.Context): Boolean =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) ==
                PackageManager.PERMISSION_GRANTED
    }
}
