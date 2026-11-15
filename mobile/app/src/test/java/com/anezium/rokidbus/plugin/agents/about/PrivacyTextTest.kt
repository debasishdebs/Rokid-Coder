package com.anezium.rokidbus.plugin.agents.about

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** The in-app privacy text and PRIVACY.md say the same thing: same sentences, same three outbound paths. */
class PrivacyTextTest {
    private fun repoFile(relative: String): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            File(dir, relative).takeIf { it.isFile }?.let { return it }
            dir = dir.parentFile
        }
        error("$relative not found above ${System.getProperty("user.dir")}")
    }

    /** Markdown emphasis, code ticks, list markers and line breaks do not change what a sentence says. */
    private fun normalize(text: String): String = text
        .replace("**", "").replace("`", "")
        .lines().joinToString(" ") { it.trim().removePrefix("- ").removePrefix("* ") }
        .replace(Regex("\\s+"), " ")

    private fun aboutStrings(): Map<String, String> {
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(repoFile("mobile/app/src/main/res/values/strings_about.xml"))
        val nodes = doc.getElementsByTagName("string")
        return (0 until nodes.length).associate { i ->
            val node = nodes.item(i)
            node.attributes.getNamedItem("name").nodeValue to normalize(node.textContent)
        }
    }

    @Test
    fun in_app_privacy_text_matches_privacy_md() {
        val md = normalize(repoFile("PRIVACY.md").readText())
        val app = aboutStrings()
        // The heading and the link label are labels, not sentences of the note.
        val sentences = app.filterKeys { it.startsWith("about_privacy_") && it != "about_privacy_link" && it != "about_privacy_heading" }

        assertTrue("the About screen carries the privacy text: ${app.keys}", sentences.size >= 6)
        for ((name, sentence) in sentences) {
            assertTrue("PRIVACY.md says what $name says: \"$sentence\"", sentence in md)
        }

        val inApp = sentences.values.joinToString(" ").lowercase()
        for (text in listOf(md.lowercase(), inApp)) {
            assertTrue("no servers", "no servers" in text)
            assertTrue("collects nothing", "collects nothing" in text)
            // The three outbound paths, and what is not there.
            assertTrue("Claude/Anthropic and Codex/OpenAI", "claude/anthropic and codex/openai" in text)
            assertTrue("the Android speech engine", "android speech engine" in text)
            assertTrue("Tailscale", "tailscale, if you choose it" in text)
            assertTrue("no cloud speech engines and no analytics", "no cloud speech engines and no analytics" in text)
        }
    }
}
