package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusNotice
import com.anezium.rokidbus.client.plugin.NexusNoticeUpdate
import com.anezium.rokidbus.client.plugin.NexusReaderAnchor
import com.anezium.rokidbus.client.plugin.NexusReaderSegment
import com.anezium.rokidbus.client.plugin.NexusReaderSegmentKind
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AlertNoticesTest {
    private fun alert(
        kind: AlertKind = AlertKind.APPROVAL,
        waiting: Int = 0,
        sessionKey: String = "claude:s1",
        title: String = "title",
        body: String = "Run npm test",
        reason: AlertReason = AlertReason.NEW,
    ) = AgentdAction.Alert(
        id = "A",
        sessionKey = sessionKey,
        kind = kind,
        title = title,
        body = body,
        actions = emptyList(),
        question = null,
        waiting = waiting,
        reason = reason,
    )

    private fun session(
        status: AgentStatus,
        provider: AgentProvider = AgentProvider.CLAUDE,
    ) = AgentSession(id = "s1", provider = provider, title = "my-repo", status = status)

    @Test
    fun reminder_footer_says_reminder() {
        assertEquals("Reminder", AlertNotices.build(alert(reason = AlertReason.REMINDER), wake = true).footer)
        assertEquals(
            "Reminder · +2 waiting",
            AlertNotices.build(alert(waiting = 2, reason = AlertReason.REMINDER), wake = true).footer,
        )
        // A Done band's "TAP read" gives way to it; a fresh one keeps its own footer.
        assertEquals(
            "Reminder",
            AlertNotices.build(alert(kind = AlertKind.DONE, reason = AlertReason.REMINDER), wake = true).footer,
        )
        assertEquals("TAP read", AlertNotices.build(alert(kind = AlertKind.DONE), wake = true).footer)
        assertEquals("+1 waiting", AlertNotices.build(alert(waiting = 1), wake = true).footer)
    }

    private fun NexusNotice.actionIds() = actions.map { it.id }

    @Test
    fun approval_band_wakes_with_allow_deny_and_more() {
        val notice = AlertNotices.build(alert(), wake = true)

        assertEquals("CLAUDE · approve", notice.title)
        assertEquals("Run npm test", notice.body)
        assertTrue(notice.wakeDisplay)
        assertEquals(listOf("allow", "deny", "more"), notice.actionIds())
        assertEquals(listOf("Allow", "Deny", "More"), notice.actions.map { it.label })
        assertEquals(listOf("check", "close", "dot"), notice.actions.map { it.glyph })
        assertEquals(10_000L, notice.ttlMs)
        assertEquals(
            "CODEX · approve",
            AlertNotices.build(alert(sessionKey = "codex:s9"), wake = true).title,
        )
    }

    @Test
    fun every_kind_lives_as_long_as_the_dwell_setting_plus_a_grace_and_never_past_the_hub_ttl() {
        for (kind in AlertKind.values()) {
            assertEquals("$kind 8 s", 10_000L, AlertNotices.build(alert(kind = kind), wake = true, dwellMs = 8_000L).ttlMs)
            assertEquals("$kind 20 s", 22_000L, AlertNotices.build(alert(kind = kind), wake = true, dwellMs = 20_000L).ttlMs)
            // 60 s outlives one hub ttl: the band starts at the ceiling and is extended once.
            assertEquals("$kind 60 s", 45_000L, AlertNotices.build(alert(kind = kind), wake = true, dwellMs = 60_000L).ttlMs)
        }
        assertEquals(62_000L, AlertNotices.lifetimeMs(60_000L))
        assertEquals(22_000L, AlertNotices.keepAlive(60_000L).ttlMs)
        // A setting past what the hub can hold is read as the most it can.
        assertEquals(82_000L, AlertNotices.lifetimeMs(3_600_000L))
    }

    @Test
    fun approval_band_stays_dark_when_the_coordinator_asks_for_no_wake() {
        assertFalse(AlertNotices.build(alert(), wake = false).wakeDisplay)
    }

    @Test
    fun question_band_has_answer_later() {
        val notice = AlertNotices.build(alert(kind = AlertKind.QUESTION), wake = true)

        assertEquals(listOf("answer", "later"), notice.actionIds())
        assertEquals(listOf("Answer", "Later"), notice.actions.map { it.label })
        assertTrue(notice.wakeDisplay)
        assertEquals(10_000L, notice.ttlMs)
    }

    @Test
    fun done_band_is_interactive_without_actions() {
        for (kind in listOf(AlertKind.DONE, AlertKind.ERROR)) {
            val notice = AlertNotices.build(alert(kind = kind), wake = true)

            assertTrue("$kind", notice.interactive)
            assertTrue("$kind", notice.actions.isEmpty())
            assertEquals(10_000L, notice.ttlMs)
            assertEquals("TAP read", notice.footer)
            assertTrue(notice.wakeDisplay)
        }
    }

    @Test
    fun notice_kind_does_not_wake() {
        val notice = AlertNotices.build(alert(kind = AlertKind.NOTICE), wake = true)

        assertFalse(notice.wakeDisplay)
        assertEquals(10_000L, notice.ttlMs)
        assertTrue(notice.actions.isEmpty())
        assertFalse(notice.interactive)
    }

    @Test
    fun footer_shows_plus_n_waiting() {
        assertEquals("+2 waiting", AlertNotices.build(alert(waiting = 2), wake = true).footer)
        assertEquals(
            "+1 waiting",
            AlertNotices.build(alert(kind = AlertKind.DONE, waiting = 1), wake = true).footer,
        )
        assertNull(AlertNotices.build(alert(waiting = 0), wake = true).footer)
        // A refresh clears a count that no longer holds, instead of leaving it on screen.
        assertEquals("+3 waiting", AlertNotices.update(alert(waiting = 3)).footer)
        assertEquals("", AlertNotices.update(alert(waiting = 0)).footer)
        assertEquals("TAP read", AlertNotices.update(alert(kind = AlertKind.DONE)).footer)
    }

    @Test
    fun titles_and_bodies_never_exceed_sdk_limits_for_long_input() {
        val long = "word ".repeat(2_000)
        // Ends on a surrogate pair at every plausible cut.
        val emoji = "😀".repeat(5_000)
        for (text in listOf(long, emoji)) {
            for (kind in AlertKind.values()) {
                val big = alert(
                    kind = kind,
                    waiting = Int.MAX_VALUE,
                    sessionKey = "claude:" + text,
                    title = text,
                    body = text,
                )
                val notice = AlertNotices.build(big, wake = true)
                assertTrue(notice.title!!.length <= 32)
                assertTrue(notice.footer!!.length <= 40)
                assertTrue(notice.body!!.length <= 8 * 44)
                assertTrue(notice.actions.size <= 3)
                assertTrue(notice.actions.all { it.label.length <= 16 })
                val update = AlertNotices.update(big)
                assertTrue(update.title!!.length <= 32)
                assertTrue(update.footer!!.length <= 40)
            }
            AlertNotices.brief(text, text)
            val reader = AlertNotices.outputReader(
                alert(kind = AlertKind.DONE, title = text, body = text),
                session(AgentStatus.DONE).copy(title = text, lastAssistantText = text.repeat(10)),
                emptyList(),
            )
            assertTrue(reader.segments.size <= 240)
            assertTrue(reader.segments.sumOf { it.text.length } <= 40_000)
        }
    }

    @Test
    fun approval_always_offers_allow_and_deny_unless_cut() {
        // There is no monitor-only band: with no secure link the press says so, the band does not.
        val notice = AlertNotices.build(alert(), wake = true)
        assertEquals(listOf("allow", "deny", "more"), notice.actionIds())
        assertEquals("Run npm test", notice.body)
        assertTrue(notice.wakeDisplay)
        assertEquals(10_000L, notice.ttlMs)

        // Only a command agentd had to cut loses Allow (R128).
        assertEquals(listOf("deny", "more"), AlertNotices.build(alert().copy(truncated = true), wake = true).actionIds())
    }

    @Test
    fun output_reader_opens_at_the_newest_message_and_older_ones_are_above() {
        val done = alert(kind = AlertKind.DONE, body = "Fixed the flaky test")
        val full = "First paragraph. ".repeat(500)
        val session = session(AgentStatus.DONE).copy(lastAssistantText = full)

        // Until the conversation arrives, the summary and the last text stand in, already stream-shaped.
        val loading = AlertNotices.outputReader(done, session, emptyList())
        assertEquals("the glasses open a bottom reader at its end", NexusReaderAnchor.BOTTOM, loading.anchor)
        assertEquals(NexusReaderSegmentKind.HEADER, loading.segments.first().kind)
        assertEquals("Fixed the flaky test", loading.segments.first().text)
        val rest = loading.segments.drop(1)
        assertTrue(rest.all { it.kind == NexusReaderSegmentKind.PROSE })
        assertEquals(full.trim(), rest.joinToString("") { it.text })

        // The conversation, oldest first with the newest last: the reader opens on the last one.
        val turns = listOf(
            NexusReaderSegment(NexusReaderSegmentKind.HEADER, "YOU · 1m"),
            NexusReaderSegment(NexusReaderSegmentKind.PROSE, "fix it"),
            NexusReaderSegment(NexusReaderSegmentKind.HEADER, "CL · now"),
            NexusReaderSegment(NexusReaderSegmentKind.PROSE, "done"),
        )
        val withTurns = AlertNotices.outputReader(done, session, turns)
        assertEquals(NexusReaderAnchor.BOTTOM, withTurns.anchor)
        assertEquals(listOf("YOU · 1m", "fix it", "CL · now", "done"), withTurns.segments.map { it.text })

        // Too much conversation keeps the newest turns, the newest still last.
        val many = (1..400).map { NexusReaderSegment(NexusReaderSegmentKind.PROSE, "$it".padEnd(4_000, '.')) }
        val capped = AlertNotices.outputReader(done, session, many)
        assertTrue(capped.segments.size <= 240)
        assertTrue(capped.segments.sumOf { it.text.length } <= 40_000)
        assertTrue(capped.segments.last().text.startsWith("400"))
        assertFalse("the oldest turns are the ones dropped", capped.segments.first().text.startsWith("1."))
    }

    @Test
    fun a_decision_reader_is_a_document_and_still_opens_at_its_start() {
        val reader = AlertNotices.approvalReader(alert(), session(AgentStatus.NEEDS_YOU), null)
        assertEquals(NexusReaderAnchor.TOP, reader.anchor)
    }

    @Test
    fun summary_first_chain_from_agentd_frame_through_director_to_reader() {
        val frame = JSONObject()
            .put("type", "alert").put("v", 2).put("id", "D1").put("sessionKey", "codex:s7")
            .put("kind", "done").put("title", "my-repo").put("body", "All 12 tests pass")
            .put("waiting", 0).put("reason", "new")
        val parsed = AgentdProtocolCodec().parse(frame.toString()) as AgentdAction.Alert

        val bands = mutableListOf<NexusNotice>()
        val opened = mutableListOf<AgentdAction.Alert>()
        val written = mutableListOf<String>()
        val glasses = object : AlertGlasses {
            override fun showBand(notice: NexusNotice): Boolean = bands.add(notice)
            override fun updateBand(update: NexusNoticeUpdate) = true
            override fun hideBand() = Unit
            override fun brief(title: String, body: String) = Unit
            override fun openOutput(alert: AgentdAction.Alert) { opened += alert }
            override fun openDecision(alert: AgentdAction.Alert) = Unit
            override fun openQuestion(alert: AgentdAction.Alert) = Unit
            override fun invalidate(alertId: String) = Unit
        }
        val director = AlertDirector(
            coordinator = AlertCoordinator(clock = { 0L }),
            write = { written += it; AgentdWire.Result.Sent },
            secure = { true },
            glasses = { glasses },
            post = { it() },
        )

        director.onEvent(AgentdEvent.LinkUp(1L, secure = true))
        director.onEvent(AgentdEvent.Action(parsed))
        assertEquals("CODEX · done", bands.single().title)
        assertTrue(bands.single().interactive)

        director.onBandInput()

        // The tap is evidence, and it opens the reader on the alert it rang for.
        assertEquals(listOf("alert_shown"), written.map { JSONObject(it).getString("type") })
        val reader = AlertNotices.outputReader(
            opened.single(),
            session(AgentStatus.DONE, AgentProvider.CODEX).copy(lastAssistantText = "Full output here"),
            emptyList(),
        )
        assertEquals(
            listOf(NexusReaderSegmentKind.HEADER to "All 12 tests pass", NexusReaderSegmentKind.PROSE to "Full output here"),
            reader.segments.map { it.kind to it.text },
        )
    }

    @Test
    fun cuts_never_end_on_half_a_surrogate_pair() {
        val emoji = "\uD83D\uDE00".repeat(40)
        val titles = listOf(
            AlertNotices.build(alert(kind = AlertKind.NOTICE, title = emoji), wake = false).title!!,
            AlertNotices.brief(emoji, "x").title!!,
        )
        for (title in titles) assertFalse(title, Character.isHighSurrogate(title.last()))
    }

    @Test
    fun one_long_message_is_read_from_its_start() {
        val text = (1..60).joinToString("") { "$it".padEnd(1_000, '.') }
        val reader = AlertNotices.outputReader(
            alert(kind = AlertKind.DONE),
            session(AgentStatus.DONE).copy(lastAssistantText = text),
            emptyList(),
        )

        assertTrue(reader.segments[1].text.startsWith("1."))
        assertTrue(reader.segments.sumOf { it.text.length } <= 40_000)
    }

    @Test
    fun reader_content_key_follows_the_text() {
        val a = AlertNotices.outputReader(alert(kind = AlertKind.DONE), null, listOf(
            NexusReaderSegment(NexusReaderSegmentKind.PROSE, "aaaa"),
        ))
        val b = AlertNotices.outputReader(alert(kind = AlertKind.DONE), null, listOf(
            NexusReaderSegment(NexusReaderSegmentKind.PROSE, "bbbb"),
        ))

        assertTrue(a.contentKey != b.contentKey)
    }

    @Test
    fun merged_briefs_arrive_as_lines() {
        val notice = AlertNotices.briefLines(
            "Session control",
            listOf("Not applied: a", "Approve-all off — x: session ended", "", "y".repeat(10_000)),
        )

        assertNull(notice.body)
        assertEquals(3, notice.lines.size)
        assertTrue(notice.lines.all { it.length <= 240 })
    }

    @Test
    fun a_body_with_newlines_stays_one_line() {
        val notice = AlertNotices.brief("Reply not sent", "line one\nline two")

        assertEquals("line one line two", notice.body)
        assertTrue(notice.lines.isEmpty())
    }
}
