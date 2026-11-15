package io.github.debasishdebs.rokidcoder.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.CacheableTask
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

/**
 * Writes the phone's bundled glasses app: `glasses.apk`, the glasses build's APK byte for byte,
 * and `glasses.json`, its [GlassesApkMetadata]. A release refuses an APK whose signer is not the
 * pinned one. The phone verifies nothing itself: the core does, on every install.
 */
@CacheableTask
abstract class GenerateGlassesAsset : DefaultTask() {
    /** The glasses variant's APK output: AGP's APK directory (one .apk and its metadata json). */
    @get:InputFiles
    @get:PathSensitive(PathSensitivity.NAME_ONLY)
    abstract val apkFiles: ConfigurableFileCollection

    /** True for a release: the signer must equal [pinnedSigner]. */
    @get:Input
    abstract val requirePin: Property<Boolean>

    @get:Input
    abstract val pinnedSigner: Property<String>

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @TaskAction
    fun generate() {
        val apks = apkFiles.files.flatMap { file ->
            if (file.isDirectory) file.listFiles().orEmpty().filter { it.name.endsWith(".apk") } else listOf(file)
        }.filter { it.name.endsWith(".apk") }
        val apk = apks.singleOrNull() ?: throw GradleException("Expected one glasses APK, found ${apks.map { it.name }}")
        val metadata = try {
            GlassesApkMetadata.read(apk)
        } catch (refused: IllegalStateException) {
            throw GradleException(refused.message.orEmpty(), refused)
        }
        if (requirePin.get()) {
            SignerPin.mismatch(metadata.signerSha256, pinnedSigner.get())?.let { throw GradleException(it) }
        }
        val out = outputDirectory.get().asFile
        out.deleteRecursively()
        out.mkdirs()
        apk.copyTo(out.resolve(APK), overwrite = true)
        out.resolve(JSON).writeText(metadata.toJson())
    }

    companion object {
        const val APK = "glasses.apk"
        const val JSON = "glasses.json"
    }
}
