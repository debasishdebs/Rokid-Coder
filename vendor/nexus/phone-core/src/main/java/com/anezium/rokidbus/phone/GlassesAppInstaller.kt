package com.anezium.rokidbus.phone

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.util.UUID

/** Installs the glasses app over CXR. The APK is verified on every call, before anything is pushed. */
interface GlassesAppInstaller {
    suspend fun install(apk: File, expected: GlassesApkMetadata, onProgress: (Int) -> Unit): InstallResult

    /** The glasses app's version code, or null when CXR is down, it is absent, or it has not announced. */
    suspend fun installedVersion(): Long?

    /** Stops an install that has not started pushing yet. */
    fun cancel()
}

data class GlassesApkMetadata(
    val packageName: String,
    val versionCode: Long,
    val sha256: String,
    /** One or more comma-separated 64-hex certificate digests. */
    val signerSha256: String,
)

sealed interface InstallResult {
    data object Installed : InstallResult
    data object AlreadyCurrent : InstallResult
    data object NewerOnGlasses : InstallResult
    data object Cancelled : InstallResult

    /** [reason] is a fixed sentence, never a path, digest or exception message. */
    data class Failed(val reason: String) : InstallResult
}

/**
 * The install pipeline: copy the APK somewhere only the core writes, verify the copy, compare
 * versions, then push the copy, all on one CXR app slot operation. Progress is coarse because
 * CXR reports only the final result.
 */
internal class CxrGlassesAppInstaller(
    private val slot: GlassesAppSlot,
    private val link: () -> CxrTransport?,
    private val linkUp: () -> Boolean,
    private val wifiEnabled: () -> Boolean,
    private val sessionPackage: String,
    private val workDirectory: () -> File,
    private val announcedVersionName: () -> String?,
    private val inspector: ArtifactPackageInspector = ApksigGlassesApkInspector(),
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : GlassesAppInstaller {
    private class Attempt {
        @Volatile var cancelled = false
        @Volatile var pushing = false
    }

    @Volatile private var current: Attempt? = null

    override suspend fun install(
        apk: File,
        expected: GlassesApkMetadata,
        onProgress: (Int) -> Unit,
    ): InstallResult {
        onProgress(0)
        if (expected.packageName != sessionPackage) return InstallResult.Failed(PACKAGE_MISMATCH)
        val op = slot.acquire(GlassesAppSlot.Kind.INSTALL)
        val attempt = Attempt().also { current = it }
        try {
            val copy = File(workDirectory(), "${UUID.randomUUID()}.apk")
            op.onComplete { copy.delete() }
            val copied = withContext(io) {
                runCatching {
                    copy.parentFile?.mkdirs()
                    apk.copyTo(copy, overwrite = true)
                }.isSuccess
            }
            if (!copied) return InstallResult.Failed(UNREADABLE)

            val rejection = withContext(io) {
                runCatching { GlassesApkVerificationPolicy.verify(copy, expected, inspector) }
                    .exceptionOrNull()
            }
            if (rejection != null) {
                return InstallResult.Failed((rejection as? GlassesApkVerificationException)?.reason ?: UNVERIFIABLE)
            }
            onProgress(25)

            val installed = installedVersionOn(op)
            if (installed != null && installed == expected.versionCode) return InstallResult.AlreadyCurrent
            if (installed != null && installed > expected.versionCode) return InstallResult.NewerOnGlasses

            if (!wifiEnabled()) return InstallResult.Failed(WIFI_OFF)
            val target = link()
            if (target == null || !linkUp()) return InstallResult.Failed(NOT_CONNECTED)

            if (attempt.cancelled) return InstallResult.Cancelled
            currentCoroutineContext().ensureActive()
            onProgress(50)
            attempt.pushing = true
            val pushed = slot.dispatch(
                op,
                call = { cbk -> target.appUploadAndInstall(copy.absolutePath, cbk) },
            ) { answer -> answer.success }
            return when (pushed) {
                is GlassesAppSlot.DispatchResult.Answered -> if (pushed.value) {
                    onProgress(100)
                    InstallResult.Installed
                } else {
                    InstallResult.Failed(REFUSED)
                }
                GlassesAppSlot.DispatchResult.LinkLost -> InstallResult.Failed(LINK_LOST)
                GlassesAppSlot.DispatchResult.Threw -> InstallResult.Failed(NOT_SENT)
            }
        } finally {
            if (current === attempt) current = null
            op.finish()
        }
    }

    override suspend fun installedVersion(): Long? {
        if (link() == null || !linkUp()) return null
        val op = slot.acquire(GlassesAppSlot.Kind.QUERY)
        try {
            return installedVersionOn(op)
        } finally {
            op.finish()
        }
    }

    override fun cancel() {
        current?.takeUnless { it.pushing }?.cancelled = true
    }

    // CXR has no version query: it says only whether the app is there. The version is the one the
    // glasses announced on this link, by the hub release convention (R205).
    private suspend fun installedVersionOn(op: GlassesAppSlot.Op): Long? {
        val target = link() ?: return null
        if (!linkUp()) return null
        val answer = slot.dispatch(
            op,
            call = { cbk -> target.appIsInstalled(cbk) },
        ) { it.success }
        val installed = (answer as? GlassesAppSlot.DispatchResult.Answered)?.value == true
        if (!installed) return null
        return GlassesVersionCode.fromVersionName(announcedVersionName())
    }

    private companion object {
        const val PACKAGE_MISMATCH = "Glasses APK package does not match this hub."
        const val UNREADABLE = "Could not read the glasses APK."
        const val UNVERIFIABLE = "Glasses APK signature or manifest could not be verified."
        const val WIFI_OFF = "Turn on Wi-Fi first — the update travels to the glasses over Wi-Fi."
        const val NOT_CONNECTED = "Glasses aren't connected — reconnect them first, then retry."
        const val REFUSED = "The glasses did not install the app."
        const val LINK_LOST = "Connection to the glasses was lost."
        const val NOT_SENT = "Could not send the glasses APK over CXR."
    }
}
