package com.anezium.rokidbus.plugin.agents.onboarding

import com.anezium.rokidbus.phone.CxrLAuth
import com.anezium.rokidbus.phone.GlassesApkMetadata
import com.anezium.rokidbus.phone.GlassesAppInstaller
import com.anezium.rokidbus.phone.InstallResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The GLASSES step: the service from the visible screen, coexistence, CXR authorization and connect. */
@OptIn(ExperimentalCoroutinesApi::class)
class GlassesStepTest {
    private val calls = mutableListOf<String>()

    private inner class FakeHost : GlassesHost {
        override val ready = MutableStateFlow(false)
        override val cxrUp = MutableStateFlow(false)
        var connectSucceeds = true
        var installed: Long? = 10000L
        var installResult: InstallResult = InstallResult.Installed
        var hold: CompletableDeferred<Unit>? = null
        var installs = 0
        val installer = object : GlassesAppInstaller {
            override suspend fun install(apk: File, expected: GlassesApkMetadata, onProgress: (Int) -> Unit): InstallResult {
                installs += 1
                onProgress(50)
                hold?.await()
                return installResult
            }
            override suspend fun installedVersion(): Long? {
                calls += "installedVersion"
                return installed
            }
            override fun cancel() = Unit
        }

        override fun startFromForeground(): Boolean {
            calls += "startFromForeground"
            return true
        }

        override fun connect(token: String) {
            check(ready.value) { "a CXR call before the service was ready" }
            calls += "connect"
            if (connectSucceeds) cxrUp.value = true
        }

        override fun installer(): GlassesAppInstaller {
            check(ready.value) { "a CXR call before the service was ready" }
            return installer
        }
    }

    private val host = FakeHost()
    private var nexusInstalled = false
    private var authorization: CxrLAuth.Result? = CxrLAuth.Result.Success("token")
    private val completed = mutableListOf<String>()

    private fun TestScope.controller() = GlassesStepController(
        host = host,
        nexusInstalled = { nexusInstalled },
        authorize = {
            calls += "authorize"
            authorization
        },
        installs = { installer -> GlassesInstallController(installer, FakeAsset, File("build/tmp/onboarding-test"), expectedGlassesMetadata(FakeAsset.info, FakeAsset.info.packageName, "ef".repeat(32), release = true), Dispatchers.Unconfined) },
        onComplete = { completed += "GLASSES" },
        scope = backgroundScope,
        autoConnectMs = 1_000L,
        connectTimeoutMs = 5_000L,
        recheckMs = 1_000L,
    )

    private object FakeAsset : BundledGlassesAsset {
        override val info = GlassesAssetInfo("io.github.debasishdebs.rokidcoder.glasses", 10000L, "ab".repeat(32), "cd".repeat(32))
        override fun copyTo(target: File) = target.writeText("apk")
    }

    @Test
    fun glasses_step_starts_service_without_backgrounding() = runTest(UnconfinedTestDispatcher()) {
        val step = controller()
        step.enter()
        assertEquals("the visible screen starts the service itself", listOf("startFromForeground"), calls)
        advanceTimeBy(10_000L)
        assertEquals("nothing touches CXR before ready", listOf("startFromForeground"), calls)
        assertEquals(GlassesPhase.STARTING, step.view.value.phase)

        host.ready.value = true
        advanceTimeBy(2_000L)
        runCurrent()
        assertEquals(listOf("startFromForeground", "authorize", "connect", "installedVersion"), calls)
        assertEquals(GlassesPhase.APP, step.view.value.phase)
        assertEquals(GlassesInstallState.UpToDate, step.view.value.install)
        assertEquals(listOf("GLASSES"), completed)
    }

    @Test
    fun upstream_nexus_installed_shows_stop_hub_and_retry() = runTest(UnconfinedTestDispatcher()) {
        nexusInstalled = true
        host.ready.value = true
        val step = controller()
        step.enter()
        val view = step.view.value
        assertEquals(GlassesPhase.NEXUS_INSTALLED, view.phase)
        assertEquals(
            "Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry.",
            OnboardingCopy.NEXUS_INSTALLED,
        )
        assertEquals(listOf("Open Rokid Nexus", "App info", "Retry"), OnboardingCopy.NEXUS_ACTIONS)
        assertEquals("the warning comes before any connect", listOf("startFromForeground"), calls)
        assertEquals("com.anezium.rokidbus.phone", OnboardingCopy.NEXUS_PACKAGE)

        step.retry()
        advanceTimeBy(2_000L)
        runCurrent()
        assertTrue(calls.contains("connect"))
        assertEquals(GlassesPhase.APP, step.view.value.phase)
    }

    @Test
    fun coexistence_is_a_warning_cxr_connect_decides() = runTest(UnconfinedTestDispatcher()) {
        // Installed, and our connect still fails: the guidance stays, with Retry.
        nexusInstalled = true
        host.ready.value = true
        host.connectSucceeds = false
        val step = controller()
        step.enter()
        step.retry()
        advanceTimeBy(10_000L)
        runCurrent()
        assertEquals(GlassesPhase.NEXUS_INSTALLED, step.view.value.phase)
        assertTrue(completed.isEmpty())

        // Still installed, and the connect works: the step goes on regardless.
        host.connectSucceeds = true
        step.retry()
        advanceTimeBy(2_000L)
        runCurrent()
        assertEquals(GlassesPhase.APP, step.view.value.phase)
        assertEquals(listOf("GLASSES"), completed)
    }

    @Test
    fun a_failed_connect_without_nexus_offers_retry() = runTest(UnconfinedTestDispatcher()) {
        host.ready.value = true
        authorization = CxrLAuth.Result.Fail("Global Hi Rokid is not installed")
        val step = controller()
        step.enter()
        advanceTimeBy(2_000L)
        runCurrent()
        assertEquals(GlassesPhase.CONNECT_FAILED, step.view.value.phase)
        assertEquals("Global Hi Rokid is not installed", step.view.value.detail)

        // The screen launched: the answer comes back through onAuthorization.
        authorization = null
        step.retry()
        runCurrent()
        assertEquals(GlassesPhase.AUTHORIZING, step.view.value.phase)
        step.onAuthorization(CxrLAuth.Result.Success("token"))
        advanceTimeBy(1_000L)
        runCurrent()
        assertEquals(GlassesPhase.APP, step.view.value.phase)
    }

    private fun TestScope.appStep(): GlassesStepController {
        host.ready.value = true
        host.installed = null
        val step = controller()
        step.enter()
        advanceTimeBy(2_000L)
        runCurrent()
        assertEquals(GlassesInstallState.NotInstalled, step.view.value.install)
        return step
    }

    @Test
    fun one_tap_on_install_or_retry_acts_and_shows_it_at_once() = runTest(UnconfinedTestDispatcher()) {
        val step = appStep()
        host.hold = CompletableDeferred()
        host.installResult = InstallResult.Failed(OnboardingCopy.GLASSES_REFUSED)

        step.installApp()
        assertEquals("the screen shows the install the moment it starts", GlassesInstallState.Installing(50), step.view.value.install)
        step.installApp()
        assertEquals("a tap while it runs starts no second install", 1, host.installs)
        host.hold!!.complete(Unit)
        runCurrent()
        assertEquals(GlassesInstallState.Failed(OnboardingCopy.GLASSES_REFUSED), step.view.value.install)

        // Retry: the very first tap leaves the failure screen for the install.
        host.hold = CompletableDeferred()
        step.installApp()
        assertEquals(GlassesInstallState.Installing(50), step.view.value.install)
        assertEquals(2, host.installs)
        host.installResult = InstallResult.Installed
        host.hold!!.complete(Unit)
        runCurrent()
        assertEquals(GlassesInstallState.UpToDate, step.view.value.install)
        assertEquals(listOf("GLASSES"), completed)
    }

    @Test
    fun an_app_that_arrives_over_adb_finishes_the_step_without_leaving_it() = runTest(UnconfinedTestDispatcher()) {
        val step = appStep()
        advanceTimeBy(3_500L)
        assertEquals("still not there", GlassesInstallState.NotInstalled, step.view.value.install)
        assertTrue(completed.isEmpty())

        host.installed = 10000L
        advanceTimeBy(1_000L)
        runCurrent()
        assertEquals(GlassesInstallState.UpToDate, step.view.value.install)
        assertEquals(listOf("GLASSES"), completed)
    }

    @Test
    fun a_refusal_stays_on_screen_while_watching_and_the_watch_ends_when_the_step_is() = runTest(UnconfinedTestDispatcher()) {
        val step = appStep()
        host.installResult = InstallResult.Failed(OnboardingCopy.GLASSES_REFUSED)
        step.installApp()
        runCurrent()
        advanceTimeBy(3_500L)
        assertEquals("the reason is not wiped by a look that finds nothing", GlassesInstallState.Failed(OnboardingCopy.GLASSES_REFUSED), step.view.value.install)

        host.installed = 10000L
        advanceTimeBy(1_000L)
        runCurrent()
        assertEquals(GlassesInstallState.UpToDate, step.view.value.install)
        assertEquals(listOf("GLASSES"), completed)

        val looks = calls.count { it == "installedVersion" }
        advanceTimeBy(10_000L)
        assertEquals("no more looks once the app is there", looks, calls.count { it == "installedVersion" })
    }

    @Test
    fun leaving_the_step_stops_the_watch() = runTest(UnconfinedTestDispatcher()) {
        val step = appStep()
        step.leave()
        val looks = calls.count { it == "installedVersion" }
        advanceTimeBy(10_000L)
        assertEquals(looks, calls.count { it == "installedVersion" })
    }
}
