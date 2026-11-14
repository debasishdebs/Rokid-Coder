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
    ) = AgentdAction.Alert(
        id = "A",
        sessionKey = sessionKey,
        kind = kind,
        title = title,
        body = body,
        actions = emptyList(),
        question = null,
        waiting = waiting,
        reason = AlertReason.NEW,
    )

    private fun session(
        status: AgentStatus,
        provider: AgentProvider = AgentProvider.CLAUDE,
    ) = AgentSession(id = "s1", provider = provider, title = "my-repo", status = status)

    private fun NexusNotice.actionIds() = actions.map { it.id }

    @Test
    fun approval_band_wakes_with_allow_deny_more_and_45s_ttl() {
        val notice = AlertNotices.build(alert(), monitorOnly = false, wake = true)

        assertEquals("CLAUDE · approve", notice.title)
        assertEquals("Run npm test", notice.body)
        assertTrue(notice.wakeDisplay)
        assertEquals(listOf("allow", "deny", "more"), notice.actionIds())
        assertEquals(listOf("Allow", "Deny", "More"), notice.actions.map { it.label })
        assertEquals(listOf("check", "close", "dot"), notice.actions.map { it.glyph })
        assertEquals(45_000L, notice.ttlMs)
        assertEquals(
            "CODEX · approve",
            AlertNotices.build(alert(sessionKey = "codex:s9"), monitorOnly = false, wake = true).title,
        )
    }

    @Test
    fun approval_band_stays_dark_when_the_coordinator_asks_for_no_wake() {
        assertFalse(AlertNotices.build(alert(), monitorOnly = false, wake = false).wakeDisplay)
    }

    @Test
    fun question_band_has_answer_later() {
        val notice = AlertNotices.build(alert(kind = AlertKind.QUESTION), monitorOnly = false, wake = true)

        assertEquals(listOf("answer", "later"), notice.actionIds())
        assertEquals(listOf("Answer", "Later"), notice.actions.map { it.label })
        assertTrue(notice.wakeDisplay)
        assertEquals(45_000L, notice.ttlMs)
    }

    @Test
    fun done_band_is_interactive_without_actions_and_12s() {
        for (kind in listOf(AlertKind.DONE, AlertKind.ERROR)) {
            val notice = AlertNotices.build(alert(kind = kind), monitorOnly = false, wake = true)

            assertTrue("$kind", notice.interactive)
            assertTrue("$kind", notice.actions.isEmpty())
            assertEquals(12_000L, notice.ttlMs)
            assertEquals("TAP read", notice.footer)
            assertTrue(notice.wakeDisplay)
        }
    }

    @Test
    fun notice_kind_does_not_wake() {
        val notice = AlertNotices.build(alert(kind = AlertKind.NOTICE), monitorOnly = false, wake = true)

        assertFalse(notice.wakeDisplay)
        assertEquals(8_000L, notice.ttlMs)
        assertTrue(notice.actions.isEmpty())
        assertFalse(notice.interactive)
    }

    @Test
    fun footer_shows_plus_n_waiting() {
        assertEquals("+2 waiting", AlertNotices.build(alert(waiting = 2), false, true).footer)
        assertEquals(
            "+1 waiting",
            AlertNotices.build(alert(kind = AlertKind.DONE, waiting = 1), false, true).footer,
        )
        assertNull(AlertNotices.build(alert(waiting = 0), false, true).footer)
        // A refresh clears a count that no longer holds, instead of leaving it on screen.
        assertEquals("+3 waiting", AlertNotices.update(alert(waiting = 3), false).footer)
        assertEquals("", AlertNotices.update(alert(waiting = 0), false).footer)
        assertEquals("TAP read", AlertNotices.update(alert(kind = AlertKind.DONE), false).footer)
    }

    @Test
    fun titles_and_bodies_never_exceed_sdk_limits_for_long_input() {
        val long = "word ".repeat(2_000)
        // Ends on a surrogate pair at every plausible cut.
        val emoji = "😀".repeat(5_000)
        for (text in listOf(long, emoji)) {
            for (kind in AlertKind.values()) {
                for (monitorOnly in listOf(false, true)) {
                    val big = alert(
                        kind = kind,
                        waiting = Int.MAX_VALUE,
                        sessionKey = "claude:" + text,
                        title = text,
                        body = text,
                    )
                    val notice = AlertNotices.build(big, monitorOnly, wake = true)
                    assertTrue(notice.title!!.length <= 32)
                    assertTrue(notice.footer!!.length <= 40)
                    assertTrue(notice.body!!.length <= 8 * 44)
                    assertTrue(notice.actions.size <= 3)
                    assertTrue(notice.actions.all { it.label.length <= 16 })
                    val update = AlertNotices.update(big, monitorOnly)
                    assertTrue(update.title!!.length <= 32)
                    assertTrue(update.footer!!.length <= 40)
                }
            }
            AlertNotices.brief(text, text)
            AlertNotices.statusNotice(session(AgentStatus.NEEDS_YOU).copy(title = text), text, monitorOnly = false)
            AlertNotices.statusNotice(
                session(AgentStatus.ERROR).copy(title = text, statusDetail = text), text, monitorOnly = false,
            )
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
    fun monitor_only_approval_has_no_allow_deny() {
        val notice = AlertNotices.build(alert(), monitorOnly = true, wake = true)

        assertEquals(listOf("more"), notice.actionIds())
        assertEquals("Run npm test · Monitor only — approve on laptop", notice.body)
        assertTrue(notice.wakeDisplay)
        assertEquals(45_000L, notice.ttlMs)
    }

    @Test
    fun monitor_only_suffix_survives_a_long_body() {
        val notice = AlertNotices.build(alert(body = "x".repeat(10_000)), monitorOnly = true, wake = true)

        assertTrue(notice.body!!.endsWith("Monitor only — approve on laptop"))
        assertTrue(notice.body!!.length <= 8 * 44)
    }

    @Test
    fun monitor_only_link_keeps_v1_status_attention_with_approve_on_laptop_copy() {
        val needs = session(AgentStatus.NEEDS_YOU).copy(
            pendingRequest = AgentPendingRequest(PendingRequestKind.PERMISSION, "Run command", 42),
        )
        val stored = mutableMapOf<String, String>()
        val engine = AttentionDecisionEngine(stored::get) { key, value -> stored[key] = value }

        // The v1 engine still fires for the session on a link that cannot steer.
        val pending = engine.pending(listOf(needs)).single()
        val notice = AlertNotices.statusNotice(pending.session, summary = "wants to run Bash", monitorOnly = true)

        assertEquals("Monitor only — approve on laptop", notice.body)
        assertTrue(notice.actions.isEmpty())
        assertTrue(notice.interactive)
        assertEquals("TAP open", notice.footer)
        assertEquals("my-repo", notice.title)

        // OpenClaw, which is not agentd's to steer, keeps its own summary.
        val own = AlertNotices.statusNotice(needs, summary = "wants to run Bash", monitorOnly = false)
        assertEquals("wants to run Bash", own.body)
        // An error has nothing to approve, so it says what failed.
        val failed = AlertNotices.statusNotice(
            session(AgentStatus.ERROR).copy(statusDetail = "Process failed"), summary = "", monitorOnly = true,
        )
        assertEquals("Process failed", failed.body)
    }

    @Test
    fun summary_first_reader_segments() {
        val done = alert(kind = AlertKind.DONE, body = "Fixed the flaky test")
        val full = "First paragraph. ".repeat(500)
        val session = session(AgentStatus.DONE).copy(lastAssistantText = full)

        val reader = AlertNotices.outputReader(done, session, emptyList())

        assertEquals(NexusReaderAnchor.TOP, reader.anchor)
        assertEquals(NexusReaderSegmentKind.HEADER, reader.segments.first().kind)
        assertEquals("Fixed the flaky test", reader.segments.first().text)
        val rest = reader.segments.drop(1)
        assertTrue(rest.isNotEmpty())
        assertTrue(rest.all { it.kind == NexusReaderSegmentKind.PROSE })
        assertEquals(full.trim(), rest.joinToString("") { it.text })

        // A loaded conversation replaces the last text, still under the summary.
        val turns = listOf(
            NexusReaderSegment(NexusReaderSegmentKind.HEADER, "YOU · 1m"),
            NexusReaderSegment(NexusReaderSegmentKind.PROSE, "fix it"),
        )
        val withTurns = AlertNotices.outputReader(done, session, turns)
        assertEquals(listOf("Fixed the flaky test", "YOU · 1m", "fix it"), withTurns.segments.map { it.text })

        // Too much conversation keeps the newest turns under the summary.
        val many = (1..400).map { NexusReaderSegment(NexusReaderSegmentKind.PROSE, "$it".padEnd(4_000, '.')) }
        val capped = AlertNotices.outputReader(done, session, many)
        assertEquals("Fixed the flaky test", capped.segments.first().text)
        assertTrue(capped.segments.size <= 240)
        assertTrue(capped.segments.sumOf { it.text.length } <= 40_000)
        assertTrue(capped.segments.last().text.startsWith("400"))
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
            write = { written += it },
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
            AlertNotices.build(alert(kind = AlertKind.NOTICE, title = emoji), false, false).title!!,
            AlertNotices.brief(emoji, "x").title!!,
            AlertNotices.statusNotice(session(AgentStatus.ERROR).copy(title = emoji), "", false).title!!,
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
