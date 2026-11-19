package com.anezium.rokidbus.plugin.agents.service

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The last lines of the link log, kept for the Glass app screen's copy, and the wall nothing sensitive passes. */
class LinkLogRingTest {
    private val lines = mutableListOf<String>()
    private val original = LinkLog.sink

    @Before
    fun capture() {
        LinkLog.clearRecent()
        LinkLog.sink = { lines += it }
    }

    @After
    fun restore() {
        LinkLog.sink = original
        LinkLog.clearRecent()
    }

    @Test
    fun the_ring_keeps_the_last_three_hundred_lines_with_their_time_of_day() {
        repeat(LinkLog.MAX_LINES + 25) { LinkLog.i("line $it") }

        val kept = LinkLog.recent()
        assertEquals(LinkLog.MAX_LINES, kept.size)
        assertTrue(kept.first().endsWith(" line 25"))
        assertTrue(kept.last().endsWith(" line ${LinkLog.MAX_LINES + 24}"))
        assertTrue(Regex("^\\d{2}:\\d{2}:\\d{2}\\.\\d{3} line 25$").matches(kept.first()))
        assertEquals(kept.joinToString("\n"), LinkLog.recentText())
    }

    @Test
    fun nothing_sensitive_gets_into_the_log_or_its_copy() {
        val token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef1234567890"
        val serial = "RG2301ABCDEF123456"
        val fingerprint = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
        LinkLog.i("token=$token")
        LinkLog.i("serial $serial")
        LinkLog.i("phone 192.168.68.104 and 100.78.52.6 and fd7a:115c:a1e0::1")
        LinkLog.i("glasses aa:bb:cc:dd:ee:ff")
        LinkLog.i("pin $fingerprint")
        LinkLog.hub("CXR-L connect requested token=$token")

        val everything = LinkLog.recentText() + "\n" + lines.joinToString("\n")
        listOf(
            token, serial, fingerprint, "192.168.68.104", "100.78.52.6", "fd7a:115c", "aa:bb:cc:dd:ee:ff",
            "AB:CD:EF:01", "eyJhbGci",
        ).forEach { secret -> assertFalse("$secret leaked: $everything", everything.contains(secret)) }
        assertTrue(everything.contains("<id>") && everything.contains("<addr>"))
    }

    @Test
    fun the_words_of_our_own_lines_pass_untouched() {
        val own = listOf(
            "link state cxr=down spp=up bonded=true worn=false closedByServer=true",
            "wearer link: down, binding (bind 2, closedByServer=false)",
            "voice tap: link NOT_REACHED after 14000ms (attempt 2 failed, cxr=down spp=down bonded=true worn=false closedByServer=true)",
            "healer: not chasing the link (Hi Rokid closed the session)",
        )
        own.forEach(LinkLog::i)
        assertEquals(own, lines)
    }
}
