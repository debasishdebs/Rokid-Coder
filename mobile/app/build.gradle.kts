import com.android.build.api.artifact.SingleArtifact
import org.gradle.api.artifacts.component.ProjectComponentIdentifier
import org.gradle.process.ExecOperations
import org.w3c.dom.Element
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.ZipFile
import javax.inject.Inject
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    id("com.android.application")
    // AGP 9.2.0 compiles Kotlin with its built-in KGP 2.2.10 (see :buildEnvironment); the Compose compiler must match.
    id("org.jetbrains.kotlin.plugin.compose") version "2.2.10"
}

apply(from = rootProject.file("gradle/plugin-release-signing.gradle"))

// Rokid Coder's pair, shared with the glasses app (gradle.properties).
val phoneApplicationId = providers.gradleProperty("rokid.phoneApplicationId").get()
val glassesApplicationId = providers.gradleProperty("rokid.glassesApplicationId").get()

android {
    // The Kotlin namespace stays com.anezium.rokidbus.*, so R, BuildConfig and every test identity are unchanged.
    namespace = "com.anezium.rokidbus.plugin.agents"
    compileSdk = 36

    defaultConfig {
        applicationId = phoneApplicationId
        minSdk = 30
        targetSdk = 36
        versionCode = 800
        versionName = "0.8.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "PHONE_APPLICATION_ID", "\"$phoneApplicationId\"")
        buildConfigField("String", "GLASSES_APPLICATION_ID", "\"$glassesApplicationId\"")
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }

    // Robolectric reads the merged manifest, so ServiceExposureTest sees the real services.
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation(project(":phone-core"))
    implementation("androidx.core:core:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Phone screens only: the PCA light mint theme and settings widgets (R31).
    implementation(platform("androidx.compose:compose-bom:2024.09.00"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.5")
    // The app-foreground signal that starts or promotes the one service (R9′).
    implementation("androidx.lifecycle:lifecycle-process:2.8.5")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
    // A local TLS agentd for the pinned wss client, with a cert that names no host.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
    testImplementation("com.squareup.okhttp3:okhttp-tls:4.12.0")
}

// What the release APK of the one phone app must never carry: an exported service of anyone
// else, the plugin runtime, the store, the updater, Patcher, cloud speech, cleartext or manual
// ADB [FR 6, 6a-R7]. `checkRelease` runs all of it, and `verifyReleaseChecks` proves each rule
// against the fixtures in release-checks/fixtures.

object ReleaseRules {
    private const val ANDROID = "http://schemas.android.com/apk/res/android"
    private const val OURS = "com.anezium.rokidbus.plugin.agents."
    private const val PLUGIN_ACTION = "com.anezium.rokidbus.action.PLUGIN"
    private const val INSTALL_PACKAGES = "android.permission.REQUEST_INSTALL_PACKAGES"

    /** By the outer class's simple name, in our namespace: what the upstream shell keeps [FR 6]. */
    private val bannedNames = listOf(
        "store" to Regex("(Store|Registry)[A-Z].*"),
        "updater" to Regex("NexusSelfUpdater|NexusUpdate[A-Z].*|PluginUpdateChecker|UpdateNotificationPolicy"),
        "Patcher" to Regex("Patcher[A-Z].*"),
        "plugin runtime" to Regex(".*ExternalPlugin.*|PhonePlugin(Discovery|Registry).*"),
        "cloud speech" to Regex("Cloud(Stt|Speech).*|.*RealtimeSpeechToText.*|.*CompletedAudio.*|HubSecretStore|SpeechCredits"),
    )
    private val bannedPackages = listOf("kadb" to "com.flyfishxu.kadb.", "Patcher" to "app.morphe.")

    /**
     * :shared's wire constants for the upstream hub's hand-off to the Patcher plugin: no code, and
     * the hand-off itself (PatcherHandoff) is upstream-shell only and banned above.
     */
    private val contractsOnly = setOf("com.anezium.rokidbus.shared.PatcherContract")

    fun manifest(manifest: File, allowInstallPackages: Boolean): List<String> {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(manifest)
        val root = document.documentElement
        fun elements(parent: Element, tag: String): List<Element> =
            parent.getElementsByTagName(tag).let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }
        fun Element.android(name: String): String = getAttributeNS(ANDROID, name)
        val problems = mutableListOf<String>()
        for (service in elements(root, "service")) {
            val name = service.android("name").let { if (it.startsWith(".")) root.getAttribute("package") + it else it }
            // Without the attribute, an intent filter is what exports a component.
            val exported = service.android("exported").ifEmpty { elements(service, "intent-filter").isNotEmpty().toString() }
            if (exported == "true" && !name.startsWith(OURS)) problems += "exported-service: $name is exported and not ours"
        }
        for (queries in elements(root, "queries")) {
            if (elements(queries, "action").any { it.android("name") == PLUGIN_ACTION }) {
                problems += "plugin-query: <queries> asks for $PLUGIN_ACTION"
            }
        }
        if (elements(root, "application").any { it.android("usesCleartextTraffic") == "true" }) {
            problems += "cleartext: usesCleartextTraffic is true"
        }
        val permissions = elements(root, "uses-permission") + elements(root, "uses-permission-sdk-23")
        if (!allowInstallPackages && permissions.any { it.android("name") == INSTALL_PACKAGES }) {
            problems += "install-packages: $INSTALL_PACKAGES is not recorded as needed"
        }
        return problems
    }

    fun dex(classes: Collection<String>): List<String> = classes.mapNotNull { name ->
        bannedPackages.firstOrNull { (_, prefix) -> name.startsWith(prefix) }?.let { (what, _) ->
            return@mapNotNull "banned-class: $name ($what)"
        }
        if (!name.startsWith("com.anezium.") || name.substringBefore('$') in contractsOnly) return@mapNotNull null
        val simple = name.substringAfterLast('.').substringBefore('$')
        bannedNames.firstOrNull { (_, pattern) -> pattern.matches(simple) }?.let { (what, _) -> "banned-class: $name ($what)" }
    }

    fun dependencies(components: Collection<String>): List<String> = components
        .filter { it == "project :kadb-compat" || it.startsWith("com.flyfishxu:") }
        .map { "kadb: $it is on releaseRuntimeClasspath" }

    /** Every class defined in the APK's dex files, from each file's class_defs table. */
    fun dexClassTable(apk: File): Set<String> = ZipFile(apk).use { zip ->
        zip.entries().asSequence()
            .filter { Regex("classes\\d*\\.dex").matches(it.name) }
            .flatMap { entry -> dexClasses(zip.getInputStream(entry).use { it.readBytes() }) }
            .toSet()
    }

    private fun dexClasses(bytes: ByteArray): List<String> {
        val dex = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        val stringIds = dex.getInt(0x3C)
        val typeIds = dex.getInt(0x44)
        val classDefCount = dex.getInt(0x60)
        val classDefs = dex.getInt(0x64)
        return (0 until classDefCount).map { index ->
            val descriptorIndex = dex.getInt(typeIds + 4 * dex.getInt(classDefs + 32 * index))
            var at = dex.getInt(stringIds + 4 * descriptorIndex)
            while (bytes[at].toInt() and 0x80 != 0) at++
            at++
            val start = at
            while (bytes[at].toInt() != 0) at++
            String(bytes, start, at - start, Charsets.UTF_8).removePrefix("L").removeSuffix(";").replace('/', '.')
        }
    }
}

abstract class CheckReleaseManifest : DefaultTask() {
    @get:InputFile
    abstract val manifest: RegularFileProperty

    /** Plan 6c sets this only once it records that the app needs REQUEST_INSTALL_PACKAGES. */
    @get:Input
    abstract val allowRequestInstallPackages: Property<Boolean>

    @TaskAction
    fun check() {
        val problems = ReleaseRules.manifest(manifest.get().asFile, allowRequestInstallPackages.get())
        if (problems.isNotEmpty()) throw GradleException("Release manifest:\n" + problems.joinToString("\n"))
        logger.lifecycle("Release manifest: clean")
    }
}

abstract class CheckReleaseDex : DefaultTask() {
    @get:InputFiles
    abstract val apkDirectory: DirectoryProperty

    @get:Internal
    abstract val sdkDirectory: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun check() {
        val apk = apkDirectory.get().asFile.listFiles { file -> file.extension == "apk" }?.singleOrNull()
            ?: throw GradleException("Expected one release APK in ${apkDirectory.get().asFile}")
        val (tool, classes) = listClasses(apk)
        // A listing that cannot see our own classes proves nothing about anyone else's.
        if (OWN_CLASS !in classes) throw GradleException("Dex listing ($tool) did not find $OWN_CLASS in $apk")
        val problems = ReleaseRules.dex(classes)
        if (problems.isNotEmpty()) throw GradleException("Release dex ($tool):\n" + problems.joinToString("\n"))
        logger.lifecycle("Release dex ($tool): ${classes.size} classes, clean")
    }

    /** `apkanalyzer dex packages` where the SDK has it; otherwise the class table read from the dex itself. */
    private fun listClasses(apk: File): Pair<String, Set<String>> {
        val sdk = sdkDirectory.get().asFile
        val apkanalyzer = (listOf(sdk.resolve("cmdline-tools/latest/bin/apkanalyzer")) +
            sdk.resolve("cmdline-tools").listFiles().orEmpty().map { it.resolve("bin/apkanalyzer") })
            .firstOrNull(File::canExecute)
        if (apkanalyzer == null) return "dex class table" to ReleaseRules.dexClassTable(apk)
        val out = ByteArrayOutputStream()
        exec.exec {
            commandLine(apkanalyzer.path, "dex", "packages", "--defined-only", apk.path)
            standardOutput = out
        }
        val classes = out.toString(Charsets.UTF_8).lineSequence()
            .filter { it.startsWith("C ") }
            .map { it.trim().split(Regex("\\s+")).last() }
            .toSet()
        return "apkanalyzer dex packages" to classes
    }

    private companion object {
        const val OWN_CLASS = "com.anezium.rokidbus.plugin.agents.AgentsCore"
    }
}

abstract class CheckReleaseDependencies : DefaultTask() {
    /** Every component of releaseRuntimeClasspath, as `project :path` or `group:name:version`. */
    @get:Input
    abstract val components: ListProperty<String>

    @TaskAction
    fun check() {
        val problems = ReleaseRules.dependencies(components.get())
        if (problems.isNotEmpty()) throw GradleException("releaseRuntimeClasspath:\n" + problems.joinToString("\n"))
        logger.lifecycle("releaseRuntimeClasspath: ${components.get().size} components, clean")
    }
}

/** Each rule, against a fixture it must refuse and one it must pass. */
abstract class VerifyReleaseChecks : DefaultTask() {
    @get:InputDirectory
    abstract val fixtures: DirectoryProperty

    @TaskAction
    fun verify() {
        val dir = fixtures.get().asFile
        val failures = mutableListOf<String>()
        fun expect(case: String, problems: List<String>, rule: String?) {
            val ok = if (rule == null) problems.isEmpty() else problems.size == 1 && problems.single().startsWith("$rule:")
            if (!ok) failures += "$case: expected ${rule ?: "no problem"}, got $problems"
        }
        fun lines(name: String) = dir.resolve(name).readLines().filter { it.isNotBlank() && !it.startsWith("#") }

        expect("clean.xml", ReleaseRules.manifest(dir.resolve("clean.xml"), false), null)
        expect("exported-foreign-service.xml", ReleaseRules.manifest(dir.resolve("exported-foreign-service.xml"), false), "exported-service")
        expect("plugin-query.xml", ReleaseRules.manifest(dir.resolve("plugin-query.xml"), false), "plugin-query")
        expect("cleartext.xml", ReleaseRules.manifest(dir.resolve("cleartext.xml"), false), "cleartext")
        expect("install-packages.xml", ReleaseRules.manifest(dir.resolve("install-packages.xml"), false), "install-packages")
        expect("install-packages.xml, recorded as needed", ReleaseRules.manifest(dir.resolve("install-packages.xml"), true), null)
        for (name in lines("dex-banned.txt")) expect("dex $name", ReleaseRules.dex(listOf(name)), "banned-class")
        for (name in lines("dex-allowed.txt")) expect("dex $name", ReleaseRules.dex(listOf(name)), null)
        for (id in lines("dependencies-banned.txt")) expect("dependency $id", ReleaseRules.dependencies(listOf(id)), "kadb")
        for (id in lines("dependencies-allowed.txt")) expect("dependency $id", ReleaseRules.dependencies(listOf(id)), null)

        if (failures.isNotEmpty()) throw GradleException("Release checks misjudged a fixture:\n" + failures.joinToString("\n"))
        logger.lifecycle("Release checks: every fixture judged as expected")
    }
}

val verifyReleaseChecks = tasks.register<VerifyReleaseChecks>("verifyReleaseChecks") {
    group = "verification"
    description = "Proves each release rule against its fixtures."
    fixtures.set(layout.projectDirectory.dir("release-checks/fixtures"))
}

val releaseManifestPolicy = tasks.register<CheckReleaseManifest>("releaseManifestPolicy") {
    group = "verification"
    description = "Fails on a foreign exported service, a plugin query, cleartext or REQUEST_INSTALL_PACKAGES."
    allowRequestInstallPackages.convention(false)
}

// AGP 9 still registers a checkReleaseManifest of its own (CheckManifest), outside every build and
// failing when run, so the name runs the policy and nothing of AGP's.
tasks.matching { it.name == "checkReleaseManifest" }.configureEach {
    group = "verification"
    description = releaseManifestPolicy.get().description
    dependsOn(releaseManifestPolicy)
    enabled = false
}

val checkReleaseDex = tasks.register<CheckReleaseDex>("checkReleaseDex") {
    group = "verification"
    description = "Fails if the release dex carries store, updater, Patcher, plugin-runtime, cloud speech or kadb classes."
}

val checkReleaseDependencies = tasks.register<CheckReleaseDependencies>("checkReleaseDependencies") {
    group = "verification"
    description = "Fails if releaseRuntimeClasspath reaches :kadb-compat [6a-R7]."
    val runtime = configurations.named("releaseRuntimeClasspath")
    components.set(
        runtime.map { configuration ->
            configuration.incoming.resolutionResult.allComponents.map { component ->
                when (val id = component.id) {
                    is ProjectComponentIdentifier -> "project ${id.projectPath}"
                    else -> id.displayName
                }
            }
        },
    )
}

androidComponents {
    onVariants(selector().withBuildType("release")) { variant ->
        releaseManifestPolicy.configure { manifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST)) }
        checkReleaseDex.configure {
            apkDirectory.set(variant.artifacts.get(SingleArtifact.APK))
            sdkDirectory.set(sdkComponents.sdkDirectory)
        }
    }
}

tasks.register("checkRelease") {
    group = "verification"
    description = "Every release check of the phone app."
    dependsOn(verifyReleaseChecks, "checkReleaseManifest", checkReleaseDex, checkReleaseDependencies)
}
