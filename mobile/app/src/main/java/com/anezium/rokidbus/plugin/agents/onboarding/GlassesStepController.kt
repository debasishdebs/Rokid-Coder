package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.phone.CxrLAuth
import com.anezium.rokidbus.phone.GlassesAppInstaller
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** The running service, as the GLASSES step uses it. */
internal interface GlassesHost {
    /** `CoderService.startFromForeground`, from the visible onboarding screen. */
    fun startFromForeground(): Boolean

    /** `CoderRuntime.ready`: nothing below is called before it is true. */
    val ready: StateFlow<Boolean>

    /** The CXR control link is up. */
    val cxrUp: StateFlow<Boolean>

    /** The Rokid authorization's token to `HubCore`, which connects CXR with it. A CXR call. */
    fun connect(token: String)

    /** `HubCore.glassesInstaller`. A CXR call. */
    fun installer(): GlassesAppInstaller?
}

enum class GlassesPhase { STARTING, NEXUS_INSTALLED, AUTHORIZING, CONNECTING, CONNECT_FAILED, APP }

internal data class GlassesView(
    val phase: GlassesPhase,
    val detail: String? = null,
    val install: GlassesInstallState = GlassesInstallState.Checking,
)

/**
 * The GLASSES step: the coexistence check first, then the Rokid authorization and our CXR
 * connect, then the glasses app. It starts the service itself (an in-app step is no process
 * start) and touches CXR only once the service is ready. Upstream Nexus being installed is only
 * a warning: whether our connect succeeds is what decides.
 */
internal class GlassesStepController(
    private val host: GlassesHost,
    private val nexusInstalled: () -> Boolean,
    /** Opens the Rokid authorization screen; null when it launched and its answer comes to [onAuthorization]. */
    private val authorize: () -> CxrLAuth.Result?,
    private val installs: (GlassesAppInstaller) -> GlassesInstallController,
    private val onComplete: () -> Unit,
    private val scope: CoroutineScope,
    /** How long an earlier authorization's stored token gets to connect on its own. */
    private val autoConnectMs: Long = AUTO_CONNECT_MS,
    private val connectTimeoutMs: Long = CONNECT_TIMEOUT_MS,
) {
    private val _view = MutableStateFlow(GlassesView(GlassesPhase.STARTING))
    val view: StateFlow<GlassesView> = _view.asStateFlow()

    /** Held for this screen only: never persisted here (the core keeps its own) and never logged. */
    private var token: String? = null
    private var install: GlassesInstallController? = null
    private var work: Job? = null

    fun enter() {
        host.startFromForeground()
        work = scope.launch {
            host.ready.first { it }
            when {
                host.cxrUp.value -> showApp()
                nexusInstalled() -> _view.value = GlassesView(GlassesPhase.NEXUS_INSTALLED)
                else -> connect(waitForStoredToken = true)
            }
        }
    }

    /** Retry, from the coexistence guidance or a failed connect. */
    fun retry() {
        if (work?.isActive == true) return
        work = scope.launch {
            host.ready.first { it }
            connect(waitForStoredToken = false)
        }
    }

    fun onAuthorization(result: CxrLAuth.Result) {
        when (result) {
            is CxrLAuth.Result.Success -> {
                token = result.token
                work = scope.launch { connectWithToken(result.token) }
            }
            CxrLAuth.Result.Cancel -> failed("The Rokid authorization was cancelled.")
            is CxrLAuth.Result.Fail -> failed(result.reason)
        }
    }

    fun installApp() {
        val controller = install ?: return
        scope.launch {
            controller.install()
            publishInstall(controller.state.value)
        }
    }

    /** The user left the step: an install not yet uploading is cancelled. */
    fun leave() {
        install?.leave()
    }

    private suspend fun connect(waitForStoredToken: Boolean) {
        if (host.cxrUp.value) return showApp()
        // An earlier authorization's token, kept by the core, connects on start without asking again.
        if (waitForStoredToken && withTimeoutOrNull(autoConnectMs) { host.cxrUp.first { it } } != null) return showApp()
        token?.let { return connectWithToken(it) }
        _view.value = GlassesView(GlassesPhase.AUTHORIZING)
        authorize()?.let(::onAuthorization)
    }

    private suspend fun connectWithToken(token: String) {
        host.ready.first { it }
        _view.value = GlassesView(GlassesPhase.CONNECTING)
        host.connect(token)
        if (withTimeoutOrNull(connectTimeoutMs) { host.cxrUp.first { it } } != null) showApp() else failed(OnboardingCopy.CONNECT_FAILED)
    }

    private fun failed(reason: String) {
        _view.value = if (nexusInstalled()) GlassesView(GlassesPhase.NEXUS_INSTALLED, reason) else GlassesView(GlassesPhase.CONNECT_FAILED, reason)
    }

    private suspend fun showApp() {
        val installer = host.installer() ?: return failed(OnboardingCopy.CONNECT_FAILED)
        val controller = install ?: installs(installer).also { install = it }
        _view.value = GlassesView(GlassesPhase.APP, install = controller.state.value)
        controller.refresh()
        publishInstall(controller.state.value)
    }

    private fun publishInstall(state: GlassesInstallState) {
        _view.value = GlassesView(GlassesPhase.APP, install = state)
        if (state.completesStep) onComplete()
    }

    companion object {
        const val AUTO_CONNECT_MS = 4_000L
        const val CONNECT_TIMEOUT_MS = 20_000L
    }
}
