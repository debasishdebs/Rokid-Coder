package io.github.debasishdebs.rokidcoder.gradle

import org.gradle.testkit.runner.GradleRunner
import org.gradle.testkit.runner.TaskOutcome
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The plugin in a real build: a phone project consumes a glasses project's APKs through the
 * outgoing `glassesApk` configuration, one per build type, exactly as :mobile:app consumes
 * :glasses-app (whose variants AGP makes; here a plain project publishes the same shape).
 */
class GlassesAssetFunctionalTest {
    @get:Rule val temp = TemporaryFolder()

    private lateinit var project: File
    private lateinit var debugSigner: ThrowawaySigner
    private lateinit var releaseSigner: ThrowawaySigner
    private lateinit var debugApk: File
    private lateinit var releaseApk: File

    @Before
    fun fixture() {
        project = temp.newFolder("fixture")
        val keys = temp.newFolder("keys")
        debugSigner = ThrowawaySigner(keys, "debugkey")
        releaseSigner = ThrowawaySigner(keys, "releasekey")
        debugApk = debugSigner.sign(ThrowawaySigner.fixtureApk, project.resolve("glasses/out/debug/app-debug.apk").also { it.parentFile.mkdirs() })
        releaseApk = releaseSigner.sign(ThrowawaySigner.fixtureApk, project.resolve("glasses/out/release/app-release.apk").also { it.parentFile.mkdirs() })
        project.resolve("settings.gradle.kts").writeText("""include(":glasses", ":phone")""")
        project.resolve("gradle.properties").writeText("org.gradle.jvmargs=-Xmx384m\n")
        project.resolve("glasses/build.gradle.kts").writeText(
            """
            val buildType = Attribute.of("rokid.glassesBuildType", String::class.java)
            configurations.consumable("glassesApk") {
                outgoing.variants.create("debug") {
                    attributes.attribute(buildType, "debug")
                    artifact(file("out/debug")) { type = "directory" }
                }
                outgoing.variants.create("release") {
                    attributes.attribute(buildType, "release")
                    artifact(file("out/release")) { type = "directory" }
                }
            }
            """.trimIndent(),
        )
        project.resolve("phone").mkdirs()
        project.resolve("phone/build.gradle.kts").writeText(
            """
            plugins { id("rokid.glasses-asset") }
            glassesAsset {
                glassesProject.set(":glasses")
                variant("debug", "debug")
                variant("release", "release")
            }
            """.trimIndent(),
        )
    }

    private fun runner(vararg args: String) = GradleRunner.create()
        .withProjectDir(project)
        .withPluginClasspath()
        .withArguments(*args, "--stacktrace")

    private fun generated(variant: String) = project.resolve("phone/build/generated/glassesAsset/$variant")

    @Test
    fun bundled_asset_metadata_matches_built_glasses_apk() {
        val result = runner(":phone:generateDebugGlassesAsset").build()
        assertEquals(TaskOutcome.SUCCESS, result.task(":phone:generateDebugGlassesAsset")?.outcome)

        val out = generated("debug")
        assertArrayEquals("the asset is the debug glasses APK, byte for byte", debugApk.readBytes(), out.resolve("glasses.apk").readBytes())
        val expected = GlassesApkMetadata.read(debugApk)
        assertEquals(expected.toJson(), out.resolve("glasses.json").readText())
        assertEquals(debugSigner.sha256, expected.signerSha256)
        assertEquals(setOf("glasses.apk", "glasses.json"), out.list()!!.toSet())
    }

    @Test
    fun release_asset_generation_fails_on_signer_pin_mismatch() {
        val failed = runner(":phone:generateReleaseGlassesAsset", "-Prokid.releaseSignerSha256=${debugSigner.sha256}").buildAndFail()
        assertTrue(failed.output, failed.output.contains("does not match rokid.releaseSignerSha256"))

        val unpinned = runner(":phone:generateReleaseGlassesAsset").buildAndFail()
        assertTrue(unpinned.output, unpinned.output.contains("rokid.releaseSignerSha256 is not set"))

        val pinned = runner(":phone:generateReleaseGlassesAsset", "-Prokid.releaseSignerSha256=${releaseSigner.sha256.uppercase()}").build()
        assertEquals(TaskOutcome.SUCCESS, pinned.task(":phone:generateReleaseGlassesAsset")?.outcome)
        assertArrayEquals(releaseApk.readBytes(), generated("release").resolve("glasses.apk").readBytes())
        assertEquals(GlassesApkMetadata.read(releaseApk).toJson(), generated("release").resolve("glasses.json").readText())
    }

    @Test
    fun debug_asset_is_not_held_to_the_release_pin() {
        val result = runner(":phone:generateDebugGlassesAsset", "-Prokid.releaseSignerSha256=${releaseSigner.sha256}").build()
        assertEquals(TaskOutcome.SUCCESS, result.task(":phone:generateDebugGlassesAsset")?.outcome)
        assertEquals(GlassesApkMetadata.read(debugApk).toJson(), generated("debug").resolve("glasses.json").readText())
    }
}
