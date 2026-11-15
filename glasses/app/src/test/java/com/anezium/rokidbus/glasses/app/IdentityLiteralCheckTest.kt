package com.anezium.rokidbus.glasses.app

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * No source of an app shell or core names an application or a component by a literal id: each
 * comes from the injected pair. Class names, namespaces, package and import lines, and intent
 * actions keep `com.anezium.rokidbus.*` and are never flagged.
 */
class IdentityLiteralCheckTest {
    @Test
    fun no_application_or_component_literal_outside_identity() {
        val repo = File("../..").canonicalFile
        val roots = listOf(
            "vendor/nexus/shared", "vendor/nexus/bus-client", "vendor/nexus/phone-core",
            "vendor/nexus/phone-hub", "vendor/nexus/glasses-core", "vendor/nexus/glasses-hub",
            "glasses/app",
        ).map { File(repo, it) } + (File(repo, "mobile").listFiles()?.filter { it.isDirectory } ?: emptyList())
        val findings = roots.flatMap { root ->
            File(root, "src").listFiles().orEmpty()
                .filter { it.isDirectory && !it.name.startsWith("test") && !it.name.startsWith("androidTest") }
                .flatMap { sourceSet -> sourceSet.walkTopDown().filter { it.isFile && it.extension in SCANNED } }
        }.flatMap { file ->
            val path = file.relativeTo(repo).path
            file.readLines().withIndex().flatMap { (index, line) ->
                IdentityLiterals.find(file.extension, line)
                    .filterNot { ALLOWED.any { (suffix, prefix) -> path.endsWith(suffix) && line.trim().startsWith(prefix) } }
                    .map { "$path:${index + 1}: $it" }
            }
        }
        assertEquals("", findings.joinToString("\n"))
    }

    @Test
    fun the_check_flags_packages_and_components_but_never_namespaces() {
        val flagged = listOf(
            "kt" to "intent.setPackage(\"com.anezium.rokidbus.glasses\")",
            "kt" to "ComponentName(\"com.anezium.rokidbus.phone\", \"com.anezium.rokidbus.phone.BusHubService\")",
            "kt" to "val svc = \"com.anezium.rokidbus.glasses/.RokidBusAccessibilityService\"",
            "kt" to "Uri.parse(\"package:com.anezium.rokidbus.phone\")",
            "kt" to "appendLine(\"am start -n com.anezium.rokidbus.glasses/com.anezium.rokidbus.glasses.MainActivity\")",
            "kt" to "\"/sdcard/Android/data/com.anezium.rokidbus.glasses/files/cmd_bridge\"",
            "kt" to "const val P = \"com.anezium.rokidbus.phone.permission.INTERNAL_CORE_CONTROL\"",
            "xml" to "<permission android:name=\"com.anezium.rokidbus.glasses.permission.START\" />",
            "xml" to "<package android:name=\"com.anezium.rokidbus.phone\" />",
            "sh" to "pm grant com.anezium.rokidbus.glasses android.permission.WRITE_SECURE_SETTINGS",
        )
        for ((extension, line) in flagged) {
            assertEquals(line, 1, IdentityLiterals.find(extension, line).size)
        }
        val clean = listOf(
            "kt" to "package com.anezium.rokidbus.glasses",
            "kt" to "import com.anezium.rokidbus.phone.speech.SpeechEngine",
            "kt" to "const val SETUP = \"com.anezium.rokidbus.glasses.SetupEntryActivity\"",
            "kt" to "private const val ACTION_LOG = \"com.anezium.rokidbus.phone.LOG\"",
            "kt" to "// The upstream hub is com.anezium.rokidbus.glasses.",
            "kt" to "namespace = \"com.anezium.rokidbus.glasses.shell\"",
            "xml" to "<action android:name=\"com.anezium.rokidbus.glasses.PROBE\" />",
            "xml" to "<permission android:name=\"\${applicationId}.permission.START\" />",
            "sh" to "# com.anezium.rokidbus.glasses ships this script",
        )
        for ((extension, line) in clean) {
            assertEquals(line, emptyList<String>(), IdentityLiterals.find(extension, line))
        }
    }

    private companion object {
        val SCANNED = setOf("kt", "java", "xml", "sh")

        /** Each allowed literal, by file and line start, with why it stays. */
        val ALLOWED = listOf(
            // The plugin SDK's addresses of upstream Nexus, for plugins that bind it over AIDL.
            "bus-client/src/main/java/com/anezium/rokidbus/client/HubTarget.kt" to "packageName = \"com.anezium.rokidbus.",
            // The Patcher plugin's hand-off to upstream Nexus's phone hub.
            "shared/src/main/java/com/anezium/rokidbus/shared/PatcherContract.kt" to "const val HUB_PACKAGE =",
            // Upstream defaults that SelfArmScripts replaces with the pair on every install.
            "glasses-core/src/main/assets/rokid-nexus-a11y-watchdog.sh" to "PKG=\"",
            "glasses-core/src/main/assets/rokid-nexus-a11y-watchdog.sh" to "SVC=\"",
            "glasses-core/src/main/assets/rokid-nexus-a11y-watchdog.sh" to "SVC_SHORT=\"",
            "glasses-core/src/main/assets/rokid-nexus-cmd-bridge.sh" to "CHANNEL=\"",
            "glasses-core/src/main/assets/rokid-nexus-cmd-bridge.sh" to "PACKAGE=\"",
            // Coexistence (U39): the phone app detects an installed upstream Rokid Nexus by its id,
            // which it must name exactly; it never acts as or targets that app.
            "mobile/app/src/main/AndroidManifest.xml" to "<package android:name=\"com.anezium.rokidbus.phone\"",
            "mobile/app/src/main/java/com/anezium/rokidbus/plugin/agents/onboarding/OnboardingCopy.kt" to "const val NEXUS_PACKAGE =",
        )
    }
}

/** Finds the upstream application ids used as an application, a component or an app-scoped name. */
internal object IdentityLiterals {
    /** The id not followed by a further namespace segment: a package, a component's package, a path. */
    private val bareId = Regex("com\\.anezium\\.rokidbus\\.(phone|glasses)(?![\\w.])")
    /** An app-scoped permission named after the id. */
    private val permission = Regex("com\\.anezium\\.rokidbus\\.(phone|glasses)\\.permission\\.")
    private val kotlinString = Regex("\"(?:[^\"\\\\]|\\\\.)*\"")
    private val xmlValue = Regex("=\"[^\"]*\"")

    fun find(extension: String, line: String): List<String> {
        val code = line.trim()
        if (code.startsWith("package ") || code.startsWith("import ") || code.startsWith("//") ||
            code.startsWith("*") || code.startsWith("/*") || code.startsWith("#") || code.startsWith("<!--")
        ) {
            return emptyList()
        }
        val literals = when (extension) {
            "kt", "java" -> kotlinString.findAll(code).map { it.value }.toList()
            "xml" -> xmlValue.findAll(code).map { it.value }.toList()
            else -> listOf(code)
        }
        return literals.flatMap { literal ->
            (bareId.findAll(literal) + permission.findAll(literal)).map { it.value }.toList()
        }.distinct().take(1)
    }
}
