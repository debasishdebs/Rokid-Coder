package com.anezium.rokidbus.plugin.agents.onboarding

import android.content.Context
import com.anezium.rokidbus.phone.GlassesApkMetadata
import com.anezium.rokidbus.phone.GlassesAppInstaller
import com.anezium.rokidbus.phone.InstallResult
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File

/** What the glasses have, against the glasses app this phone app bundles. */
sealed interface GlassesInstallState {
    data object Checking : GlassesInstallState
    data object NotInstalled : GlassesInstallState
    data object UpdateAvailable : GlassesInstallState
    data object UpToDate : GlassesInstallState

    /** Left alone, with a warning: a phone never downgrades the glasses. */
    data object NewerOnGlasses : GlassesInstallState
    data class Installing(val progress: Int) : GlassesInstallState
    data class Failed(val reason: String) : GlassesInstallState

    val completesStep: Boolean get() = this == UpToDate || this == NewerOnGlasses
}

/** `glasses.json`, as the rokid.glasses-asset build step wrote it. */
data class GlassesAssetInfo(val packageName: String, val versionCode: Long, val sha256: String, val signerSha256: String)

/** The glasses APK bundled in this app's assets, and its metadata. */
interface BundledGlassesAsset {
    val info: GlassesAssetInfo
    fun copyTo(target: File)
}

internal class AssetBundledGlasses(private val context: Context) : BundledGlassesAsset {
    override val info: GlassesAssetInfo by lazy {
        val json = JSONObject(context.assets.open(JSON).bufferedReader().use { it.readText() })
        GlassesAssetInfo(json.getString("packageName"), json.getLong("versionCode"), json.getString("sha256"), json.getString("signerSha256"))
    }

    override fun copyTo(target: File) {
        context.assets.open(APK).use { input -> target.outputStream().use { input.copyTo(it) } }
    }

    private companion object {
        const val APK = "glasses.apk"
        const val JSON = "glasses.json"
    }
}

/**
 * What the core must find in the bundled APK. The signer is the release pin
 * (`BuildConfig.GLASSES_SIGNER_SHA256`, from `rokid.releaseSignerSha256`) and never the asset's own
 * value; a debug build, which has no pin, takes the asset's signer, which is not a pin.
 */
internal fun expectedGlassesMetadata(info: GlassesAssetInfo, glassesApplicationId: String, pinned: String, release: Boolean): GlassesApkMetadata {
    val signer = if (release) pinned.ifBlank { error("This release has no glasses signer pin") } else info.signerSha256
    return GlassesApkMetadata(glassesApplicationId, info.versionCode, info.sha256, signer)
}

/**
 * The bundled glasses app's install, for onboarding's GLASSES step and the home screen's Glasses
 * app row. It copies the asset to `noBackupFilesDir/glasses/`, hands the copy to the core's
 * installer with the pinned metadata, and deletes it after. Verifying the APK is the core's job.
 */
internal class GlassesInstallController(
    private val installer: GlassesAppInstaller,
    private val asset: BundledGlassesAsset,
    private val copyDir: File,
    private val expected: GlassesApkMetadata,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val _state = MutableStateFlow<GlassesInstallState>(GlassesInstallState.Checking)
    val state: StateFlow<GlassesInstallState> = _state.asStateFlow()

    suspend fun refresh() {
        _state.value = stateFor(installer.installedVersion())
    }

    /**
     * A quiet look at the glasses again, for an app that arrived another way (adb from a computer).
     * It never touches an install under way, and it leaves a failure's reason on screen unless the
     * app turned out to be there: only then does the step finish.
     */
    suspend fun recheck() {
        if (_state.value is GlassesInstallState.Installing) return
        val found = stateFor(installer.installedVersion())
        // An install may have started while the glasses were being asked.
        if (_state.value is GlassesInstallState.Installing) return
        if (found.completesStep || _state.value !is GlassesInstallState.Failed) _state.value = found
    }

    private fun stateFor(installed: Long?): GlassesInstallState = when {
        installed == null -> GlassesInstallState.NotInstalled
        installed < expected.versionCode -> GlassesInstallState.UpdateAvailable
        installed == expected.versionCode -> GlassesInstallState.UpToDate
        else -> GlassesInstallState.NewerOnGlasses
    }

    /** Whether the last attempt that failed was a reinstall: its Retry is one too. */
    private var lastForced = false

    /**
     * [force] pushes the bundled app over one of the same version: the build can change without a
     * version bump, and the core would call the glasses current. A Retry after a failed forced
     * attempt stays forced.
     */
    suspend fun install(force: Boolean = false) {
        if (_state.value is GlassesInstallState.Installing) return
        val forced = force || _state.value is GlassesInstallState.Failed && lastForced
        lastForced = forced
        val before = _state.value.takeIf { it !is GlassesInstallState.Failed } ?: GlassesInstallState.Checking
        _state.value = GlassesInstallState.Installing(0)
        val copy = File(copyDir, "glasses.apk")
        try {
            val copied = withContext(io) {
                runCatching {
                    copyDir.mkdirs()
                    asset.copyTo(copy)
                }.isSuccess
            }
            if (!copied) {
                _state.value = GlassesInstallState.Failed("Could not read the bundled glasses app.")
                return
            }
            val result = installer.install(copy, expected, forced) { progress -> _state.value = GlassesInstallState.Installing(progress) }
            _state.value = when (result) {
                InstallResult.Installed, InstallResult.AlreadyCurrent -> GlassesInstallState.UpToDate
                InstallResult.NewerOnGlasses -> GlassesInstallState.NewerOnGlasses
                InstallResult.Cancelled -> before
                is InstallResult.Failed -> GlassesInstallState.Failed(result.reason)
            }
        } finally {
            withContext(io) { copy.delete() }
            if (_state.value is GlassesInstallState.Installing) _state.value = before
        }
    }

    /** The user left the screen: an install not yet uploading stops. */
    fun leave() {
        if (_state.value is GlassesInstallState.Installing) installer.cancel()
    }
}
