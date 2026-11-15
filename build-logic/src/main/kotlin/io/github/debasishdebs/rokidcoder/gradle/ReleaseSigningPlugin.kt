package io.github.debasishdebs.rokidcoder.gradle

import com.android.build.api.dsl.ApplicationExtension
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.provider.Property
import org.gradle.api.provider.ProviderFactory
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest

/**
 * `rokid.release-signing`: signs the release build type with the key named by the three
 * `NEXUS_RELEASE_*` variables, under upstream's rules (vendor/nexus/gradle/plugin-release-signing.gradle: all
 * three or none, PKCS12, key password = store password). Unlike upstream, a release assembly
 * without them fails instead of producing an unsigned APK, and the key must be the pinned one:
 * [VerifyReleaseSignerPin] runs before anything of the release is built.
 */
class ReleaseSigningPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val signing = ReleaseSigning.fromEnvironment(project.providers)
        val verify = project.tasks.register(VERIFY, VerifyReleaseSignerPin::class.java) {
            group = "verification"
            description = "Fails unless the release key's certificate SHA-256 is ${SignerPin.PROPERTY}."
            configured.set(signing != null)
            signing?.let {
                keystore.set(it.keystore)
                password.set(it.password)
                alias.set(it.alias)
            }
            pin.set(project.providers.gradleProperty(SignerPin.PROPERTY).orElse(""))
        }
        project.tasks.matching { it.name in RELEASE_ASSEMBLIES }.configureEach { dependsOn(verify) }
        // AGP's first release task: an unsigned or unpinned release fails before it packages anything.
        project.tasks.matching { it.name == "preReleaseBuild" }.configureEach { mustRunAfter(verify) }

        if (signing == null) return
        project.pluginManager.withPlugin("com.android.application") {
            val android = project.extensions.getByType(ApplicationExtension::class.java)
            val release = android.signingConfigs.create("release")
            release.storeFile = signing.keystore
            release.storePassword = signing.password
            release.keyAlias = signing.alias
            release.keyPassword = signing.password
            release.storeType = "PKCS12"
            android.buildTypes.getByName("release").signingConfig = release
        }
    }

    companion object {
        const val VERIFY = "verifyReleaseSignerPin"
        val RELEASE_ASSEMBLIES = setOf("assembleRelease", "bundleRelease")
    }
}

/** The release key as the environment names it; null when none of the three is set. */
class ReleaseSigning(val keystore: File, val password: String, val alias: String) {
    companion object {
        val VARIABLES = listOf("NEXUS_RELEASE_KEYSTORE", "NEXUS_RELEASE_KEYSTORE_PASSWORD", "NEXUS_RELEASE_KEY_ALIAS")

        fun fromEnvironment(providers: ProviderFactory): ReleaseSigning? {
            val values = VARIABLES.associateWith { providers.environmentVariable(it).orNull?.takeIf(String::isNotBlank) }
            val missing = values.filterValues { it == null }.keys
            if (missing.size == VARIABLES.size) return null
            if (missing.isNotEmpty()) {
                throw GradleException("Incomplete release signing configuration; missing: ${missing.joinToString(", ")}")
            }
            val keystore = File(values.getValue("NEXUS_RELEASE_KEYSTORE")!!)
            if (!keystore.isFile) throw GradleException("Release keystore does not exist: $keystore")
            return ReleaseSigning(keystore, values.getValue("NEXUS_RELEASE_KEYSTORE_PASSWORD")!!, values.getValue("NEXUS_RELEASE_KEY_ALIAS")!!)
        }
    }
}

/**
 * The release key's certificate SHA-256 must equal [SignerPin.PROPERTY], the public digest the
 * phone pins the bundled glasses APK to. No outputs, so it runs on every release build; the
 * password is never an input, so it is never written to the build cache or task history.
 */
abstract class VerifyReleaseSignerPin : DefaultTask() {
    @get:Internal abstract val configured: Property<Boolean>
    @get:Internal abstract val keystore: Property<File>
    @get:Internal abstract val password: Property<String>
    @get:Internal abstract val alias: Property<String>
    @get:Internal abstract val pin: Property<String>

    @TaskAction
    fun verify() {
        if (!configured.get()) {
            throw GradleException(
                "release builds must be signed: set ${ReleaseSigning.VARIABLES.joinToString(", ")} (the PKCS12 release key)",
            )
        }
        val store = KeyStore.getInstance("PKCS12")
        try {
            keystore.get().inputStream().use { store.load(it, password.get().toCharArray()) }
        } catch (refused: Exception) {
            throw GradleException("The release keystore could not be opened with NEXUS_RELEASE_KEYSTORE_PASSWORD", refused)
        }
        val certificate = store.getCertificate(alias.get())
            ?: throw GradleException("The release keystore has no key ${alias.get()} (NEXUS_RELEASE_KEY_ALIAS)")
        val digest = MessageDigest.getInstance("SHA-256").digest(certificate.encoded).joinToString("") { "%02x".format(it) }
        SignerPin.mismatch(digest, pin.get(), "The release key's certificate (alias ${alias.get()})")?.let { throw GradleException(it) }
        logger.lifecycle("Release signer: the key's certificate matches ${SignerPin.PROPERTY}")
    }
}
