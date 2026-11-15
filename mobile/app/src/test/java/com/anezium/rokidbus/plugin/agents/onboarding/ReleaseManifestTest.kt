package com.anezium.rokidbus.plugin.agents.onboarding

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The release merged manifest, as processReleaseMainManifest wrote it. The unit-test task runs
 * 6a's checkReleaseManifest policy first (mobile/app/build.gradle.kts), so a release manifest
 * the policy refuses fails this suite before any test runs.
 */
class ReleaseManifestTest {
    private val android = "http://schemas.android.com/apk/res/android"
    private val manifest: Element by lazy {
        val path = System.getProperty("releaseMergedManifest") ?: error("releaseMergedManifest is not set")
        DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File(path)).documentElement
    }

    private fun Element.children(tag: String): List<Element> =
        getElementsByTagName(tag).let { nodes -> (0 until nodes.length).map { nodes.item(it) as Element } }

    @Test
    fun merged_manifest_queries_match_allowlist() {
        val queries = manifest.children("queries")
        val packages = queries.flatMap { it.children("package") }.map { it.getAttributeNS(android, "name") }.toSet()
        val actions = queries.flatMap { it.children("action") }.map { it.getAttributeNS(android, "name") }.toSet()
        assertEquals(
            setOf(
                // The core's: Hi Rokid, as CxrLAuth.isGlobalHiRokidInstalled reads it.
                "com.rokid.sprite.global.aiapp",
                // The CXR SDK's own (com.rokid.cxr:client-l): the Hi Rokid service its link binds.
                "com.rokid.sprite.aiapp",
                // Ours: coexistence with upstream Rokid Nexus, and the Tailscale connector.
                "com.anezium.rokidbus.phone",
                "com.tailscale.ipn",
            ),
            packages,
        )
        assertEquals(
            setOf(
                "com.rokid.sprite.aiapp.externalapp.AUTHORIZATION",
                "com.rokid.sprite.aiapp.externalapp.MEDIA_STREAM_SERVICE",
                "android.intent.action.TTS_SERVICE",
                // The core's recognizer lists RecognitionService implementations by intent (AndroidSttSession).
                "android.speech.RecognitionService",
            ),
            actions,
        )
        for (rejected in listOf("PLUGIN", "CLIENT", "HUB")) assertFalse(actions.contains("com.anezium.rokidbus.action.$rejected"))
        assertFalse(packages.any { it.startsWith("app.morphe") || it.contains("patcher") })
        assertTrue("no other kind of query", queries.flatMap { it.children("provider") }.isEmpty())
    }

    @Test
    fun release_manifest_has_no_request_install_packages() {
        val permissions = (manifest.children("uses-permission") + manifest.children("uses-permission-sdk-23"))
            .map { it.getAttributeNS(android, "name") }
        assertFalse(permissions.contains("android.permission.REQUEST_INSTALL_PACKAGES"))
    }

    @Test
    fun launcher_is_the_router() {
        val launchers = manifest.children("activity").filter { activity ->
            activity.children("category").any { it.getAttributeNS(android, "name") == "android.intent.category.LAUNCHER" }
        }
        assertEquals(listOf("com.anezium.rokidbus.plugin.agents.MainActivity"), launchers.map { it.getAttributeNS(android, "name") })
        val onboarding = manifest.children("activity").single { it.getAttributeNS(android, "name").endsWith(".onboarding.OnboardingActivity") }
        assertEquals("false", onboarding.getAttributeNS(android, "exported"))
    }
}
