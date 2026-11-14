package com.anezium.rokidbus.plugin.agents

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The v2 codec against the wire fixtures shared with agentd
 * (`contracts/rokid-coder-v2.fixtures.json`). agentd's own contract test runs
 * the same file through its real handlers, so a field that drifts on either
 * side fails one of the two suites.
 */
class AgentdProtocolV2Test {
    private val fixtures: JSONObject = JSONObject(
        File("../../contracts/rokid-coder-v2.fixtures.json").readText(),
    )
    private val fromAgent = fixtures.getJSONObject("agent_to_phone")
    private val fromAgentVariants = fixtures.getJSONObject("agent_to_phone_variants")
    private val toAgent = fixtures.getJSONObject("phone_to_agent")

    private fun parse(codec: AgentdProtocolCodec, frame: JSONObject): AgentdAction =
        codec.parse(frame.toString())

    private fun fixture(name: String): JSONObject =
        (fromAgent.optJSONObject(name) ?: fromAgentVariants.getJSONObject(name))

    /** A codec that has seen the fixture snapshot, so deltas are accepted. */
    private fun syncedCodec(): AgentdProtocolCodec = AgentdProtocolCodec().also {
        assertTrue(parse(it, fixture("snapshot")) is AgentdAction.Snapshot)
    }

    private fun alertJson(patch: JSONObject.() -> Unit = {}): String =
        JSONObject(fixture("alert_approval").toString()).apply(patch).toString()

    // ------------------------------------------------------------ parsing

    @Test
    fun parses_every_agent_to_phone_v2_fixture() {
        // Every fixture has a parse expectation below: a new one cannot go untested.
        val covered = setOf(
            "snapshot", "session_upsert", "approval_request", "approval_resolved", "alert",
            "alert_closed", "detail_rejected", "ack", "followup_closed", "mode_reset", "models", "link_trust",
        )
        assertEquals(covered, fromAgent.keys().asSequence().toSet())
        assertEquals(AgentdAction.LinkTrust(steering = false), parse(AgentdProtocolCodec(), fixture("link_trust")))

        val codec = AgentdProtocolCodec()
        val snapshot = parse(codec, fixture("snapshot")) as AgentdAction.Snapshot
        assertEquals(6L, snapshot.seq)
        val board = snapshot.sessions.single()
        assertEquals("fx-claude", board.id)
        assertEquals(AgentProvider.CLAUDE, board.provider)
        assertEquals(AgentStatus.NEEDS_YOU, board.status)
        assertEquals(
            SessionV2(
                mode = "plugin",
                canCompact = false,
                canModel = false,
                followup = FollowupState.WAITING,
                tempMode = TempMode.ASK,
                nativeMode = null,
                heading = "Fix the flaky billing test",
                currentFile = null,
                step = null,
                contextUsed = null,
                contextWindow = null,
                pendingModel = null,
                pendingEffort = null,
                sandbox = null,
            ),
            board.v2,
        )

        val upsert = parse(codec, fixture("session_upsert")) as AgentdAction.Upsert
        assertEquals(7L, upsert.seq)
        assertEquals("fx-codex", upsert.session.id)
        assertEquals(AgentProvider.CODEX, upsert.session.provider)
        assertEquals("Refactor the parser", upsert.session.title)
        assertEquals("apply_patch", upsert.session.turn?.lastTool)
        assertEquals(
            SessionV2(
                mode = "launcher",
                canCompact = true,
                canModel = true,
                followup = FollowupState.READY,
                tempMode = TempMode.ACCEPT_EDITS,
                nativeMode = "on-request",
                heading = "Refactor the parser",
                currentFile = "/work/parser/lexer.ts",
                step = "Split the tokenizer",
                contextUsed = 48_000L,
                contextWindow = 200_000L,
                pendingModel = "gpt-6-luna",
                pendingEffort = "low",
                sandbox = "workspace-write",
            ),
            upsert.session.v2,
        )

        val approval = parse(codec, fixture("approval_request")) as AgentdAction.ApprovalRequested
        assertEquals(
            AgentApproval(
                requestId = "fx-request-id",
                sessionId = "fx-claude",
                provider = AgentProvider.CLAUDE,
                tool = "Bash",
                summary = "npm test",
                detail = "npm test -- --runInBand",
                createdAt = 1_760_000_010_000L,
            ),
            approval.approval,
        )
        assertEquals(
            AgentdAction.ApprovalResolved("fx-request-id"),
            parse(codec, fixture("approval_resolved")),
        )

        assertEquals(
            AgentdAction.Alert(
                id = "fx-alert",
                sessionKey = "claude:fx-claude",
                kind = AlertKind.QUESTION,
                title = "Question",
                body = "Which test runner?",
                actions = emptyList(),
                question = QuestionPayload(
                    requestRef = "fx-request-ref",
                    source = "claude_tool",
                    items = listOf(
                        QuestionItem(
                            text = "Which test runner?",
                            options = listOf(QuestionOption("node:test", "Built in"), QuestionOption("vitest")),
                            multiSelect = false,
                            allowFreeText = true,
                        ),
                        QuestionItem(
                            text = "Which suites?",
                            options = listOf(QuestionOption("unit"), QuestionOption("contract")),
                            multiSelect = true,
                            allowFreeText = true,
                        ),
                    ),
                ),
                waiting = 2,
                reason = AlertReason.RETRY,
            ),
            parse(codec, fixture("alert")),
        )
        assertEquals(
            AgentdAction.Alert(
                id = "fx-alert",
                sessionKey = "claude:fx-claude",
                kind = AlertKind.APPROVAL,
                title = "Bash",
                body = "npm test",
                actions = listOf("allow", "deny"),
                question = null,
                waiting = 0,
                reason = AlertReason.NEW,
            ),
            parse(codec, fixture("alert_approval")),
        )
        assertEquals(AgentdAction.AlertClosed("fx-alert", "withdrawn"), parse(codec, fixture("alert_closed")))
        assertEquals(AgentdAction.DetailRejected("fx-claude"), parse(codec, fixture("detail_rejected")))
        assertEquals(
            AgentdAction.Ack("fx-msg-followup", "rejected", "not_waiting"),
            parse(codec, fixture("ack")),
        )
        assertEquals(
            AgentdAction.FollowupClosed("claude:fx-claude", "delivered"),
            parse(codec, fixture("followup_closed")),
        )
        assertEquals(
            AgentdAction.ModeReset("claude:fx-claude", TempMode.APPROVE_ALL, "helper_restarted"),
            parse(codec, fixture("mode_reset")),
        )
        assertEquals(
            AgentdAction.Models(
                sessionKey = "codex:fx-codex",
                models = listOf("gpt-6-luna", "gpt-6"),
                efforts = listOf("low", "medium", "high"),
                currentModel = "gpt-6-luna",
                currentEffort = "low",
            ),
            parse(codec, fixture("models")),
        )
    }

    @Test
    fun a_missing_or_unknown_alert_reason_parses_as_new() {
        val codec = AgentdProtocolCodec()
        val missing = codec.parse(alertJson { remove("reason") }) as AgentdAction.Alert
        assertEquals(AlertReason.NEW, missing.reason)
        val unknown = codec.parse(alertJson { put("reason", "reboot") }) as AgentdAction.Alert
        assertEquals(AlertReason.NEW, unknown.reason)
        for (reason in AlertReason.values()) {
            val alert = codec.parse(alertJson { put("reason", reason.wire) }) as AgentdAction.Alert
            assertEquals(reason, alert.reason)
        }
    }

    @Test
    fun unknown_v2_alert_kind_is_ignored_not_crashed() {
        val codec = AgentdProtocolCodec()
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("kind", "fireworks") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { remove("kind") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("kind", 7) }))
        // A question with nothing to answer, a bad session key and a bad id are dropped the same way.
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("kind", "question") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("sessionKey", "openclaw:x") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("sessionKey", "claude:") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { remove("id") }))
        assertEquals(AgentdAction.Ignore, codec.parse(alertJson { put("v", 1) }))
        // The codec carries on: the next, known alert is still understood.
        assertTrue(codec.parse(alertJson()) is AgentdAction.Alert)
        assertEquals(AgentdAction.Ignore, codec.parse("""{"type":"mode_reset","v":2,"sessionKey":"claude:s","from":"yolo","reason":"x"}"""))
        assertEquals(AgentdAction.Ignore, codec.parse("""{"type":"ack","v":2,"msgId":"m","result":"maybe"}"""))
    }

    @Test
    fun an_ack_for_a_frame_without_an_id_keeps_the_empty_id() {
        val ack = AgentdProtocolCodec()
            .parse("""{"type":"ack","v":2,"msgId":"","result":"rejected","error":"bad_msg_id"}""")
        assertEquals(AgentdAction.Ack("", "rejected", "bad_msg_id"), ack)
    }

    @Test
    fun alert_title_body_capped_at_MAX_HUD_LABEL_CHARS_and_MAX_HUD_TEXT_CHARS() {
        val alert = AgentdProtocolCodec().parse(
            alertJson {
                put("title", "t".repeat(MAX_HUD_LABEL_CHARS * 3))
                put("body", "b".repeat(MAX_HUD_TEXT_CHARS * 3))
                put("actions", JSONArray(List(40) { "a".repeat(200) }))
            },
        ) as AgentdAction.Alert
        assertEquals(MAX_HUD_LABEL_CHARS, alert.title.length)
        assertEquals(MAX_HUD_TEXT_CHARS, alert.body.length)
        assertEquals(MAX_ALERT_ACTIONS, alert.actions.size)
        assertTrue(alert.actions.all { it.length == MAX_WIRE_TYPE_CHARS })

        // Inside a question nothing that answers is cut: past agentd's bounds the question is refused (R124).
        val question = JSONObject(fixture("alert").toString()).apply {
            getJSONObject("question").getJSONArray("items").getJSONObject(0)
                .put("text", "q".repeat(MAX_HUD_TEXT_CHARS * 2))
                .getJSONArray("options").getJSONObject(0).put("label", "l".repeat(MAX_HUD_LABEL_CHARS * 2))
        }
        val parsed = AgentdProtocolCodec().parse(question.toString()) as AgentdAction.Alert
        assertEquals(QuestionPayload.TOO_LONG, parsed.question!!.refusal)
        // Kept for display only, within the HUD's bound.
        assertEquals(MAX_HUD_TEXT_CHARS, parsed.question!!.items[0].text.length)
    }

    @Test
    fun answer_uses_exact_wire_strings() {
        val text = "  Which runner?\n"
        val label = "node:test " + "with a long explanation ".repeat(10) + " "
        val wire = JSONObject(fixture("alert").toString()).apply {
            getJSONObject("question").put(
                "items",
                JSONArray().put(
                    JSONObject().put("text", text).put("multiSelect", false).put("allowFreeText", false).put(
                        "options",
                        JSONArray().put(JSONObject().put("label", label)).put(JSONObject().put("label", " vitest")),
                    ),
                ),
            )
        }
        val alert = AgentdProtocolCodec().parse(wire.toString()) as AgentdAction.Alert
        val payload = alert.question!!
        assertNull(payload.refusal)
        assertEquals(text, payload.items[0].text)
        assertEquals(label, payload.items[0].options[0].label)

        val flow = QuestionFlow(alert.id, alert.sessionKey, payload)
        flow.toggle(0, 0)
        // Keyed and valued with exactly what agentd sent, so its exact match finds them.
        assertEquals(mapOf<String, Any>(text to label), flow.answers())

        // A question that cannot be answered exactly is refused on the band, never trimmed.
        val tooLong = JSONObject(wire.toString()).apply {
            getJSONObject("question").getJSONArray("items").getJSONObject(0).put("text", "q".repeat(MAX_ANSWER_CHARS + 1))
        }
        val refused = AgentdProtocolCodec().parse(tooLong.toString()) as AgentdAction.Alert
        assertEquals("Question too long — answer on laptop", refused.question!!.refusal)
        val band = AlertNotices.build(refused, monitorOnly = false, wake = false)
        assertEquals("Question too long — answer on laptop", band.body)
        assertEquals(listOf(AlertCoordinator.LATER), band.actions.map { it.id })

        // An item with nothing to pick and no free text cannot be answered here either.
        val nothing = JSONObject(wire.toString()).apply {
            getJSONObject("question").getJSONArray("items").getJSONObject(0).put("options", JSONArray())
        }
        assertEquals(
            QuestionPayload.UNANSWERABLE,
            (AgentdProtocolCodec().parse(nothing.toString()) as AgentdAction.Alert).question!!.refusal,
        )
    }

    @Test
    fun hostile_v2_frames_are_made_safe_not_thrown_on() {
        val codec = AgentdProtocolCodec()
        fun alert(patch: JSONObject.() -> Unit) = codec.parse(alertJson(patch))

        // A wrong-typed or out-of-range waiting counts nothing.
        for (waiting in listOf<Any>("3", -5, 1.5, JSONObject.NULL, JSONArray())) {
            assertEquals(0, (alert { put("waiting", waiting) } as AgentdAction.Alert).waiting)
        }
        // Wrong-typed text fields are empty, not a crash.
        val noText = alert { put("title", 7); put("body", JSONArray()) } as AgentdAction.Alert
        assertEquals(listOf("", ""), listOf(noText.title, noText.body))
        // actions that are not a list of strings keep only the strings.
        assertEquals(emptyList<String>(), (alert { put("actions", "allow") } as AgentdAction.Alert).actions)
        assertEquals(
            listOf("ok"),
            (alert { put("actions", JSONArray(listOf<Any?>(1, JSONObject.NULL, JSONObject(), "", "ok"))) } as AgentdAction.Alert).actions,
        )
        // A question that is not an object is no question; on an approval the alert still stands.
        assertNull((alert { put("question", "nope") } as AgentdAction.Alert).question)
        assertNull((alert { put("question", JSONArray()) } as AgentdAction.Alert).question)
        // ...but a question alert without a usable payload is dropped.
        fun questionAlert(question: Any) = alert { put("kind", "question"); put("question", question) }
        assertEquals(AgentdAction.Ignore, questionAlert("nope"))
        assertEquals(AgentdAction.Ignore, questionAlert(JSONObject().put("requestRef", "r").put("source", "claude_tool").put("items", "x")))
        assertEquals(AgentdAction.Ignore, questionAlert(JSONObject().put("requestRef", 5).put("source", "claude_tool").put("items", JSONArray())))
        assertEquals(
            AgentdAction.Ignore,
            questionAlert(
                JSONObject().put("requestRef", "r").put("source", "claude_tool")
                    .put("items", JSONArray(listOf<Any?>(1, "x", JSONObject().put("options", JSONArray())))),
            ),
        )

        // Lists over the cap are refused: a question cut to fit would be answered incompletely (R124).
        val bigQuestion = JSONObject().put("requestRef", "r").put("source", "claude_tool").put(
            "items",
            JSONArray(
                List(MAX_QUESTION_ITEMS * 2) {
                    JSONObject().put("text", "q$it").put(
                        "options",
                        JSONArray(List(MAX_QUESTION_OPTIONS * 2) { option -> JSONObject().put("label", "o$option") }),
                    )
                },
            ),
        )
        val capped = (questionAlert(bigQuestion) as AgentdAction.Alert).question!!
        assertEquals(QuestionPayload.TOO_LONG, capped.refusal)
        assertEquals(MAX_QUESTION_ITEMS, capped.items.size)
        assertTrue(capped.items.all { it.options.size == MAX_QUESTION_OPTIONS })

        val models = codec.parse(
            JSONObject(fixture("models").toString())
                .put("models", JSONArray(List(MAX_LIST_ENTRIES * 3) { "m$it" }))
                .put("efforts", JSONArray(List(MAX_LIST_ENTRIES * 3) { "e$it" }))
                .toString(),
        ) as AgentdAction.Models
        assertEquals(MAX_LIST_ENTRIES, models.models.size)
        assertEquals(MAX_LIST_ENTRIES, models.efforts.size)

        // A current that is not an object, and lists that are not lists, leave the choices empty.
        for (current in listOf<Any>("gpt", JSONArray(listOf("gpt")), 3)) {
            val frame = JSONObject(fixture("models").toString()).put("current", current)
                .put("models", "gpt-6").put("efforts", JSONObject())
            val parsed = codec.parse(frame.toString()) as AgentdAction.Models
            assertNull(parsed.currentModel)
            assertNull(parsed.currentEffort)
            assertEquals(emptyList<String>(), parsed.models + parsed.efforts)
        }
    }

    // ------------------------------------------------------------ session fields

    @Test
    fun session_upsert_v2_fields_round_trip_into_SessionV2() {
        val codec = syncedCodec()
        val frame = JSONObject(fixture("session_upsert").toString())
        frame.put("seq", 7)
        frame.getJSONObject("session")
            .put("provider", "claude")
            .put("mode", "plugin")
            .put("tempMode", "approveAll")
            .remove("pendingSettings")
        frame.getJSONObject("session").getJSONObject("capabilities")
            .put("compact", false).put("model", false).put("followup", "cap_reached")
        val upsert = codec.parse(frame.toString()) as AgentdAction.Upsert
        val v2 = upsert.session.v2!!
        assertEquals("plugin", v2.mode)
        assertFalse(v2.canCompact)
        assertFalse(v2.canModel)
        assertEquals(FollowupState.CAP_REACHED, v2.followup)
        assertEquals(TempMode.APPROVE_ALL, v2.tempMode)
        assertNull(v2.pendingModel)
        assertNull(v2.pendingEffort)
        assertEquals(48_000L, v2.contextUsed)
        assertEquals(200_000L, v2.contextWindow)

        // The store keeps the whole session, v2 fields included, through upsert.
        val store = AgentSessionStore()
        store.upsert(upsert.session, nowMs = 1L)
        assertEquals(v2, store.sessions.value.single().v2)
    }

    @Test
    fun session_upsert_v2_fields_parse_whatever_the_link_and_the_menu_opens_greyed() {
        // The codec knows nothing of link trust, and agentd decorates every session_upsert,
        // so a monitor-only (plaintext) link carries the same v2 fields as a secure one.
        val frame = JSONObject(fixture("session_upsert").toString()).put("seq", 7)
        frame.getJSONObject("session").put("provider", "claude").put("mode", "plugin")
        val session = (syncedCodec().parse(frame.toString()) as AgentdAction.Upsert).session
        assertNotNull(session.v2)

        // ENTER opens the menu for it, and with no steering link every steering row is greyed.
        val items = ControlMenu.items(session, secure = false)
        val steering = items.filter { it.label != "Context" && it.label != "Read output" }
        assertTrue(steering.isNotEmpty())
        assertTrue(steering.all { !it.enabled && it.sub == "Monitor only — approve on laptop" })
        assertTrue(items.first { it.label == "Read output" }.enabled)
    }

    @Test
    fun session_v2_edge_values_are_made_safe() {
        val codec = syncedCodec()
        fun upsertWith(seq: Long, patch: JSONObject.() -> Unit): AgentSession {
            val frame = JSONObject(fixture("session_upsert").toString()).put("seq", seq)
            frame.getJSONObject("session").apply(patch)
            return (codec.parse(frame.toString()) as AgentdAction.Upsert).session
        }
        // A follow-up state this plugin does not know promises nothing.
        assertEquals(
            FollowupState.UNAVAILABLE,
            upsertWith(7) { getJSONObject("capabilities").put("followup", "teleport") }.v2!!.followup,
        )
        // Half a context fill is none.
        val noWindow = upsertWith(8) { put("context", JSONObject().put("used", 5)) }.v2!!
        assertNull(noWindow.contextUsed)
        assertNull(noWindow.contextWindow)
        // A missing heading falls back to the title; text fields are capped.
        val capped = upsertWith(9) {
            remove("heading")
            put("step", "s".repeat(MAX_HUD_LABEL_CHARS * 2))
            put("currentFile", "/" + "f".repeat(MAX_PATH_CHARS * 2))
        }.v2!!
        assertEquals("Refactor the parser", capped.heading)
        assertEquals(MAX_HUD_LABEL_CHARS, capped.step!!.length)
        assertEquals(MAX_PATH_CHARS, capped.currentFile!!.length)
    }

    @Test
    fun v1_session_without_v2_fields_has_null_v2() {
        val codec = AgentdProtocolCodec()
        val snapshot = codec.parse(
            """{"type":"snapshot","seq":1,"sessions":[
                {"id":"old","provider":"claude","status":"working","title":"Old daemon"},
                {"id":"half","provider":"claude","status":"idle","mode":"plugin","tempMode":"ask"},
                {"id":"bad-mode","provider":"claude","status":"idle","mode":"hybrid",
                 "capabilities":{"compact":false,"model":false,"followup":"ready"},"tempMode":"ask"},
                {"id":"bad-temp","provider":"claude","status":"idle","mode":"plugin",
                 "capabilities":{"compact":false,"model":false,"followup":"ready"},"tempMode":"yolo"}
            ]}""",
        ) as AgentdAction.Snapshot
        assertEquals(listOf("old", "half", "bad-mode", "bad-temp"), snapshot.sessions.map { it.id })
        assertTrue(snapshot.sessions.all { it.v2 == null })
    }

    // ------------------------------------------------------------ builders

    /** JSON as plain maps, lists and numbers, so two frames compare by value whatever their key order. */
    private fun plain(value: Any?): Any? = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { plain(value.get(it)) }
        is JSONArray -> List(value.length()) { plain(value.get(it)) }
        is Number -> value.toLong()
        JSONObject.NULL -> null
        else -> value
    }

    private fun withoutMsgId(frame: JSONObject): Any? =
        (plain(frame) as Map<*, *>).let { if ("msgId" in it) it + ("msgId" to "<msgId>") else it }

    private fun assertMatchesFixture(type: String, built: String) {
        val actual = JSONObject(built)
        val expected = toAgent.getJSONObject(type)
        assertEquals(type, actual.getString("type"))
        // Each steering frame carries a real id of its own; the monitor frames carry none.
        assertEquals("$type msgId presence", expected.has("msgId"), actual.has("msgId"))
        if (actual.has("msgId")) assertEquals(MSG_ID, actual.getString("msgId"))
        assertEquals("$type: built $actual vs fixture $expected", withoutMsgId(expected), withoutMsgId(actual))
    }

    @Test
    fun every_phone_to_agent_builder_matches_its_fixture() {
        fun f(type: String) = toAgent.getJSONObject(type)
        val claude = f("followup").getString("sessionKey")
        val codex = f("codex_compact").getString("sessionKey")
        val answers = f("question_answer").getJSONObject("answers")
        val timings = f("settings_sync").getJSONObject("timings")
        val modes = f("defaults_set").getJSONObject("defaultModes")
        val built = mapOf(
            "approval_decision" to AgentdProtocolCodec.approvalDecision(
                f("approval_decision").getString("requestId"),
                ApprovalDecision.ALLOW,
            ),
            "session_input" to AgentdProtocolCodec.sessionInput(
                f("session_input").getString("id"),
                f("session_input").getString("sessionId"),
                f("session_input").getString("text"),
            ),
            "thread_start" to AgentdProtocolCodec.threadStart(
                f("thread_start").getString("id"),
                AgentProvider.CLAUDE,
                f("thread_start").getString("path"),
                f("thread_start").getString("prompt"),
            ),
            "alert_shown" to AgentdProtocolCodec.alertShown(f("alert_shown").getString("id")),
            "alert_dismissed" to AgentdProtocolCodec.alertDismissed(f("alert_dismissed").getString("id")),
            "alert_action" to AgentdProtocolCodec.alertAction(
                f("alert_action").getString("id"),
                f("alert_action").getString("action"),
                MSG_ID,
            ),
            "followup" to AgentdProtocolCodec.followup(claude, f("followup").getString("text"), MSG_ID),
            "question_answer" to AgentdProtocolCodec.questionAnswer(
                sessionKey = claude,
                alertId = f("question_answer").getString("alertId"),
                requestRef = f("question_answer").getString("requestRef"),
                answers = mapOf(
                    "Which test runner?" to answers.getString("Which test runner?"),
                    "Which suites?" to answers.getJSONArray("Which suites?").let { list ->
                        List(list.length()) { list.getString(it) }
                    },
                ),
                msgId = MSG_ID,
            ),
            "mode_set" to AgentdProtocolCodec.modeSet(claude, TempMode.APPROVE_ALL, confirmed = true, msgId = MSG_ID),
            "mode_revoke_all" to AgentdProtocolCodec.modeRevokeAll(MSG_ID),
            "codex_settings" to AgentdProtocolCodec.codexSettings(
                codex,
                f("codex_settings").getString("model"),
                f("codex_settings").getString("effort"),
                MSG_ID,
            ),
            "codex_compact" to AgentdProtocolCodec.codexCompact(codex, MSG_ID),
            "launcher_command" to AgentdProtocolCodec.launcherCommand(
                claude,
                f("launcher_command").getString("command"),
                f("launcher_command").getString("model"),
                MSG_ID,
            ),
            "defaults_set" to AgentdProtocolCodec.defaultsSet(
                TempMode.fromWire(modes.getString("claude"))!!,
                TempMode.fromWire(modes.getString("codex"))!!,
                MSG_ID,
            ),
            "settings_sync" to AgentdProtocolCodec.settingsSync(
                AlertTimings(
                    ageBoostMs = timings.getLong("ageBoostMs"),
                    dwellMs = timings.getLong("dwellMs"),
                    ackTimeoutMs = timings.getLong("ackTimeoutMs"),
                    retryBackoffMs = timings.getJSONArray("retryBackoffMs").let { list ->
                        List(list.length()) { list.getLong(it) }
                    },
                    reminderMs = timings.getLong("reminderMs"),
                ),
                f("settings_sync").getLong("waitLimitMs"),
                MSG_ID,
            ),
            "models_request" to AgentdProtocolCodec.modelsRequest(codex),
        )
        // A fixture without a builder (or the reverse) is a gap in the contract.
        assertEquals(toAgent.keys().asSequence().toSet(), built.keys)
        built.forEach { (type, frame) -> assertMatchesFixture(type, frame) }

        // The compact command takes no model.
        val compact = JSONObject(AgentdProtocolCodec.launcherCommand(claude, "compact", null, MSG_ID))
        assertEquals("compact", compact.getString("command"))
        assertFalse(compact.has("model"))
        // One settings field is enough, and an absent one is left out.
        val effortOnly = JSONObject(AgentdProtocolCodec.codexSettings(codex, null, "high", MSG_ID))
        assertEquals("high", effortOnly.getString("effort"))
        assertFalse(effortOnly.has("model"))
        // No expiry travels: agentd derives it from the wait limit.
        val sync = JSONObject(built.getValue("settings_sync"))
        assertFalse(sync.getJSONObject("timings").has("expireMs"))
        assertFalse(sync.has("defaultModes"))
    }

    @Test
    fun followup_text_over_16_KiB_is_refused_by_builder() {
        val key = "claude:fx-claude"
        // Exactly 16 KiB goes through; one byte more is refused.
        val edge = JSONObject(AgentdProtocolCodec.followup(key, "a".repeat(MAX_FOLLOWUP_BYTES), MSG_ID))
        assertEquals(MAX_FOLLOWUP_BYTES, edge.getString("text").length)
        assertThrows(IllegalArgumentException::class.java) {
            AgentdProtocolCodec.followup(key, "a".repeat(MAX_FOLLOWUP_BYTES + 1), MSG_ID)
        }
        // The limit is bytes, not characters: 5462 three-byte characters are 16 386 bytes.
        assertThrows(IllegalArgumentException::class.java) {
            AgentdProtocolCodec.followup(key, "€".repeat(5_462), MSG_ID)
        }
        assertNotNull(AgentdProtocolCodec.followup(key, "€".repeat(5_461), MSG_ID))
    }

    @Test
    fun builders_refuse_what_agentd_would_reject() {
        val key = "claude:fx-claude"
        fun refused(block: () -> Unit) {
            assertThrows(IllegalArgumentException::class.java) { block() }
        }
        // Every steering frame needs a real id, and a session key agentd can parse.
        refused { AgentdProtocolCodec.codexCompact("codex:t", "") }
        refused { AgentdProtocolCodec.codexCompact("codex:t", "m".repeat(MAX_MSG_ID_CHARS + 1)) }
        refused { AgentdProtocolCodec.followup("fx-claude", "hi", MSG_ID) }
        refused { AgentdProtocolCodec.followup("openclaw:x", "hi", MSG_ID) }
        refused { AgentdProtocolCodec.modelsRequest("claude:") }
        // Approve-all is never unconfirmed, and never a default.
        refused { AgentdProtocolCodec.modeSet(key, TempMode.APPROVE_ALL, confirmed = false, msgId = MSG_ID) }
        assertNotNull(AgentdProtocolCodec.modeSet(key, TempMode.ACCEPT_EDITS, confirmed = false, msgId = MSG_ID))
        refused { AgentdProtocolCodec.defaultsSet(TempMode.APPROVE_ALL, TempMode.ASK, MSG_ID) }
        refused { AgentdProtocolCodec.defaultsSet(TempMode.ASK, TempMode.APPROVE_ALL, MSG_ID) }
        // Settings name something; launcher commands are the two agentd knows.
        refused { AgentdProtocolCodec.codexSettings("codex:t", null, null, MSG_ID) }
        refused { AgentdProtocolCodec.codexSettings("codex:t", " ", null, MSG_ID) }
        refused { AgentdProtocolCodec.launcherCommand(key, "restart", null, MSG_ID) }
        refused { AgentdProtocolCodec.launcherCommand(key, "compact", "opus", MSG_ID) }
        // Answers keep to the bounds agentd enforces.
        fun answer(answers: Map<String, Any>) =
            AgentdProtocolCodec.questionAnswer(key, "a", "r", answers, MSG_ID)
        refused { answer(emptyMap()) }
        refused { answer(List(MAX_ANSWER_ENTRIES + 1) { "q$it" to "x" }.toMap()) }
        refused { answer(mapOf("q" to 7)) }
        refused { answer(mapOf("q" to listOf("ok", 7))) }
        refused { answer(mapOf("q" to "x".repeat(MAX_ANSWER_CHARS + 1))) }
        refused { answer(mapOf("k".repeat(MAX_ANSWER_CHARS + 1) to "x")) }
        refused { answer(mapOf("q" to List(MAX_ANSWER_ENTRIES + 1) { "x" })) }
        val ok = JSONObject(answer(mapOf("q" to "x".repeat(MAX_ANSWER_CHARS), "m" to listOf("a", "b"))))
        assertEquals(2, ok.getJSONObject("answers").getJSONArray("m").length())
    }

    // ------------------------------------------------------------ frame classes

    @Test
    fun frame_class_table_matches_fixture_expectations() {
        val classes = fixtures.getJSONObject("_classes")
        // The fixtures list the whole table, and every phone-to-agent fixture is in it.
        assertEquals(classes.keys().asSequence().toSet(), FrameClass.listedTypes)
        assertTrue(classes.keys().asSequence().toSet().containsAll(toAgent.keys().asSequence().toSet()))
        for (type in classes.keys()) {
            val steering = when (val kind = classes.getString(type)) {
                "steering" -> true
                "monitor" -> false
                else -> error("$type: unknown class $kind")
            }
            assertEquals(type, steering, FrameClass.isSteering(type))
        }
        // A type nobody classified is closed, not open.
        assertTrue(FrameClass.isSteering("a_frame_nobody_has_heard_of"))
        assertTrue(FrameClass.isSteering(""))
        // settings_sync and launcher_command are steering (R61); the three monitor v2 frames are not.
        assertTrue(FrameClass.isSteering("settings_sync"))
        assertTrue(FrameClass.isSteering("launcher_command"))
        for (type in listOf("alert_shown", "alert_dismissed", "models_request")) {
            assertFalse(type, FrameClass.isSteering(type))
        }
    }

    private companion object {
        const val MSG_ID = "fx-msg-test"
    }
}
