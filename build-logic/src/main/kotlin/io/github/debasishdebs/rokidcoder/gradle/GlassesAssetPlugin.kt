package io.github.debasishdebs.rokidcoder.gradle

import com.android.build.api.variant.ApplicationAndroidComponentsExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.attributes.Attribute
import org.gradle.api.provider.Property
import org.gradle.api.tasks.TaskProvider
import javax.inject.Inject

/**
 * `rokid.glasses-asset`: bundles the glasses app into the phone app's assets, per variant. The
 * glasses project publishes each build type's APK on its consumable `glassesApk` configuration,
 * told apart by [BUILD_TYPE]; the phone resolves the one matching its own build type, so no
 * task of another project is named here.
 */
class GlassesAssetPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("glassesAsset", GlassesAssetExtension::class.java, project)
        project.pluginManager.withPlugin("com.android.application") {
            project.extensions.getByType(ApplicationAndroidComponentsExtension::class.java).onVariants { variant ->
                val task = extension.variant(variant.name, variant.buildType ?: variant.name)
                variant.sources.assets?.addGeneratedSourceDirectory(task, GenerateGlassesAsset::outputDirectory)
            }
        }
    }

    companion object {
        /** The glasses build type an outgoing `glassesApk` variant carries, and the one the phone asks for. */
        val BUILD_TYPE: Attribute<String> = Attribute.of("rokid.glassesBuildType", String::class.java)
        const val CONFIGURATION = "glassesApk"
    }
}

abstract class GlassesAssetExtension @Inject constructor(private val project: Project) {
    /** The project whose `glassesApk` configuration is bundled. */
    abstract val glassesProject: Property<String>

    /**
     * The release signer's certificate digest: a public value, committed by T10, and the only
     * signer a release phone accepts. A debug phone takes the asset's own signer, which is not a pin.
     */
    abstract val releaseSignerSha256: Property<String>

    init {
        glassesProject.convention(":glasses-app")
        releaseSignerSha256.convention(project.providers.gradleProperty(SignerPin.PROPERTY).orElse(""))
    }

    /** Registers `generate<Variant>GlassesAsset`, writing build/generated/glassesAsset/<variant>/. */
    fun variant(name: String, buildType: String): TaskProvider<GenerateGlassesAsset> {
        val suffix = name.replaceFirstChar(Char::uppercaseChar)
        val apk = project.configurations.create("glassesApk$suffix") {
            isCanBeConsumed = false
            isCanBeResolved = true
            attributes.attribute(GlassesAssetPlugin.BUILD_TYPE, buildType)
        }
        project.dependencies.add(
            apk.name,
            project.dependencies.project(mapOf("path" to glassesProject.get(), "configuration" to GlassesAssetPlugin.CONFIGURATION)),
        )
        return project.tasks.register("generate${suffix}GlassesAsset", GenerateGlassesAsset::class.java) {
            group = "build"
            description = "Bundles the $buildType glasses APK and its metadata into the $name phone assets."
            apkFiles.from(apk)
            requirePin.set(buildType == "release")
            pinnedSigner.set(releaseSignerSha256)
            outputDirectory.set(project.layout.buildDirectory.dir("generated/glassesAsset/$name"))
        }
    }
}
