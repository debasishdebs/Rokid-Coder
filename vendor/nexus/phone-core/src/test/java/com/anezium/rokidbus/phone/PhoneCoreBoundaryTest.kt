package com.anezium.rokidbus.phone

import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.util.zip.ZipFile

/**
 * What :phone-core must not carry: the upstream shell's plugin runtime, Store, updater, Patcher,
 * manual ADB setup and cloud speech. Deliberately not opted in to [HubShellApi].
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class PhoneCoreBoundaryTest {
    @Test
    fun phone_core_has_no_plugin_runtime_or_cloud_speech_types() {
        // The module's own compiled main classes, as a directory or the library's classes jar.
        val entries = System.getProperty("java.class.path").orEmpty().split(File.pathSeparator)
            .map(::File)
            .map(::classEntries)
            .filter { HUB_CORE in it }
        assertTrue("compiled core classes on the test classpath", entries.isNotEmpty())
        val names = entries.flatten()
            .map { it.substringAfterLast('/').removeSuffix(".class").substringBefore('$') }
            .toSet()
        val forbidden = listOf(
            Regex("PhonePluginDiscovery"), Regex("PhonePluginRegistry"), Regex("ExternalPlugin.*"),
            Regex("PluginGrantStore"), Regex("PluginGuardian.*"), Regex("SkillsCoordinator"),
            Regex("Store.*"), Regex("Registry(Client|Feed|Plugin.*)?"), Regex("NexusSelfUpdater"),
            Regex("NexusUpdate.*"), Regex("PluginInstaller"), Regex("Patcher.*"), Regex("Youtube.*"),
            Regex("Reddit.*"), Regex("GlassesManual.*"), Regex("CloudStt.*"), Regex(".*RealtimeSpeechToText.*"),
            Regex(".*CompletedAudio.*"), Regex("HubSecretStore"), Regex("SpeechCredits"),
        )
        val found = names.filter { name -> forbidden.any { it.matches(name) } }
        assertTrue("forbidden types in :phone-core: $found", found.isEmpty())

        // The runtime classpath this core ships with: no manual ADB and no HTTP client.
        val classpath = System.getProperty("java.class.path").orEmpty()
        assertTrue("kadb on the core classpath", "kadb-compat" !in classpath && "com.flyfishxu" !in classpath)
        assertTrue("okhttp on the core classpath", "okhttp" !in classpath)
    }

    private fun classEntries(root: File): List<String> = when {
        root.isDirectory -> root.walkTopDown().filter { it.isFile && it.extension == "class" }
            .map { it.relativeTo(root).invariantSeparatorsPath }.toList()
        root.isFile && root.extension == "jar" -> ZipFile(root).use { zip ->
            zip.entries().asSequence().map { it.name }.filter { it.endsWith(".class") }.toList()
        }
        else -> emptyList()
    }

    @Test
    fun in_process_app_builds_its_core_without_opting_in() {
        val host = RecordingHost()
        val core = HubCore(RuntimeEnvironment.getApplication(), HubCoreConfig(foreground = host, inProcessApp = AGENTS_APP))
        assertTrue(core.surface().state.lifecycle == SurfaceState.Lifecycle.CLOSED)
        core.close()
    }

    private companion object {
        const val HUB_CORE = "com/anezium/rokidbus/phone/HubCore.class"
    }
}
