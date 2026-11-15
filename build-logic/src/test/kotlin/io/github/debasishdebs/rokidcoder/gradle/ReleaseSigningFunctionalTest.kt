package io.github.debasishdebs.rokidcoder.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * `rokid.release-signing` in a real build. AGP's release lifecycle is stood in for by plain
 * `preReleaseBuild`, `assembleRelease` and `bundleRelease` tasks, the names the plugin wires to, so
 * no Android SDK is needed; the key is a throwaway PKCS12 made in the test's temp dir.
 */
class ReleaseSigningFunctionalTest {
    @get:Rule val temp = TemporaryFolder()

    private lateinit var project: File
    private lateinit var releaseKey: ThrowawaySigner
    private lateinit var otherKey: ThrowawaySigner

    @Before
    fun fixture() {
        project = temp.newFolder("fixture")
        val keys = temp.newFolder("keys")
        releaseKey = ThrowawaySigner(keys, "rokid-coder")
        otherKey = ThrowawaySigner(keys, "someone-else")
        project.resolve("settings.gradle.kts").writeText("""rootProject.name = "app"""")
        project.resolve("gradle.properties").writeText("org.gradle.jvmargs=-Xmx384m\n")
        project.resolve("build.gradle.kts").writeText(
            """
            plugins { id("rokid.release-signing") }
            val marker = layout.buildDirectory.file("packaged.txt")
            val preReleaseBuild = tasks.register("preReleaseBuild") {
                outputs.file(marker)
                doLast { marker.get().asFile.apply { parentFile.mkdirs(); writeText("packaged") } }
            }
            tasks.register("assembleRelease") { dependsOn(preReleaseBuild) }
            tasks.register("bundleRelease") { dependsOn(preReleaseBuild) }
            tasks.register("assembleDebug") { doLast { } }
            """.trimIndent(),
        )
    }

    private fun runner(env: Map<String, String>, vararg args: String) = GradleRunner.create()
        .withProjectDir(project)
        .withPluginClasspath()
        // The machine's own NEXUS_RELEASE_* never leak into the fixture build.
        .withEnvironment(System.getenv().filterKeys { !it.startsWith("NEXUS_RELEASE_") } + env)
        .withArguments(*args, "--stacktrace")

    private fun signedWith(key: ThrowawaySigner, alias: String = "rokid-coder") = mapOf(
        "NEXUS_RELEASE_KEYSTORE" to key.store.absolutePath,
        "NEXUS_RELEASE_KEYSTORE_PASSWORD" to ThrowawaySigner.PASSWORD,
        "NEXUS_RELEASE_KEY_ALIAS" to alias,
    )

    private val packaged get() = project.resolve("build/packaged.txt")

    @Test
    fun glasses_signer_pin_matches_release_key() {
        val match = runner(signedWith(releaseKey), "assembleRelease", "bundleRelease", "-Prokid.releaseSignerSha256=${releaseKey.sha256.uppercase()}").build()
        assertEquals(TaskOutcome.SUCCESS, match.task(":verifyReleaseSignerPin")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, match.task(":assembleRelease")?.outcome)
        assertEquals(TaskOutcome.SUCCESS, match.task(":bundleRelease")?.outcome)
        assertTrue(match.output, match.output.contains("matches rokid.releaseSignerSha256"))

        packaged.delete()
        val mismatch = runner(signedWith(releaseKey), "assembleRelease", "-Prokid.releaseSignerSha256=${otherKey.sha256}").buildAndFail()
        assertTrue(mismatch.output, mismatch.output.contains("does not match rokid.releaseSignerSha256"))
        assertFalse("the pin fails before anything is packaged", packaged.exists())
        assertFalse("the key's digest is not printed", mismatch.output.contains(releaseKey.sha256))

        val unset = runner(signedWith(releaseKey), "assembleRelease").buildAndFail()
        assertTrue(unset.output, unset.output.contains("rokid.releaseSignerSha256 is not set"))

        val wrongAlias = runner(signedWith(releaseKey, "nobody"), "assembleRelease", "-Prokid.releaseSignerSha256=${releaseKey.sha256}").buildAndFail()
        assertTrue(wrongAlias.output, wrongAlias.output.contains("has no key nobody"))
    }

    @Test
    fun release_build_without_keystore_fails() {
        for (task in listOf("assembleRelease", "bundleRelease")) {
            val unsigned = runner(emptyMap(), task, "-Prokid.releaseSignerSha256=${releaseKey.sha256}").buildAndFail()
            assertTrue(unsigned.output, unsigned.output.contains("release builds must be signed"))
            assertEquals(TaskOutcome.FAILED, unsigned.task(":verifyReleaseSignerPin")?.outcome)
            assertFalse("$task packaged nothing", packaged.exists())
        }

        val debug = runner(emptyMap(), "assembleDebug").build()
        assertEquals(TaskOutcome.SUCCESS, debug.task(":assembleDebug")?.outcome)

        // Upstream's rules: a partial configuration, or a keystore that is not there, fails any build.
        val partial = runner(mapOf("NEXUS_RELEASE_KEYSTORE" to releaseKey.store.absolutePath), "assembleDebug").buildAndFail()
        assertTrue(partial.output, partial.output.contains("Incomplete release signing configuration; missing: NEXUS_RELEASE_KEYSTORE_PASSWORD, NEXUS_RELEASE_KEY_ALIAS"))
        val absent = runner(signedWith(releaseKey) + ("NEXUS_RELEASE_KEYSTORE" to project.resolve("nope.p12").absolutePath), "assembleDebug").buildAndFail()
        assertTrue(absent.output, absent.output.contains("Release keystore does not exist"))
    }
}
