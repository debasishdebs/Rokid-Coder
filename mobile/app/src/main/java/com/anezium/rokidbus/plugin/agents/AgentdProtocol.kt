package com.anezium.rokidbus.plugin.agents

import org.json.JSONArray
import org.json.JSONObject

sealed interface AgentdAction {
    /** A computer dialling in on the LAN link, before anything else is sent. */
    data class Hello(
        val machineId: String,
        val machineName: String,
        val token: String,
    ) : AgentdAction
    /** [steering] is agentd's own grant (R126); null from an agentd that predates it, which grants nothing. */
    data class HelloAcknowledged(val machineName: String?, val steering: Boolean? = null) : AgentdAction

    /** agentd refused the wss hello (`repair_needed` or `bad_token`) and closes with 4403 next. */
    data class HelloRejected(val reason: String) : AgentdAction

    /** agentd's live trust in this link changed (R126); `false` comes just before it drops the link. */
    data class LinkTrust(val steering: Boolean) : AgentdAction
    data class Snapshot(val seq: Long, val sessions: List<AgentSession>) : AgentdAction
    data class Upsert(val seq: Long, val session: AgentSession) : AgentdAction
    data class Removed(
        val seq: Long,
        val provider: AgentProvider,
        val sessionId: String,
    ) : AgentdAction

    data class Detail(
        val provider: AgentProvider,
        val sessionId: String,
        val messages: List<AgentMessage>,
    ) : AgentdAction

    data class DetailAppend(
        val provider: AgentProvider,
        val sessionId: String,
        val message: AgentMessage,
    ) : AgentdAction
    data class ApprovalRequested(val approval: AgentApproval) : AgentdAction
    data class ApprovalResolved(val requestId: String) : AgentdAction
    data class FolderListing(val listing: FsListing) : AgentdAction
    data class ThreadStarted(val result: ThreadStartResult) : AgentdAction
    data class SessionInputAnswered(val result: SessionInputResult) : AgentdAction

    /** A v2 alert for the glasses. [reason] says why agentd sent it; it never changes what the alert is. */
    data class Alert(
        val id: String,
        val sessionKey: String,
        val kind: AlertKind,
        val title: String,
        val body: String,
        val actions: List<String>,
        val question: QuestionPayload?,
        val waiting: Int,
        val reason: AlertReason,
        /** agentd had to cut the command or path (R128): the glasses offer no Allow for it. */
        val truncated: Boolean = false,
    ) : AgentdAction

    /** An alert left agentd's queue for a reason the glasses did not cause. */
    data class AlertClosed(val id: String, val reason: String) : AgentdAction

    /**
     * The answer to a steering frame; [msgId] is empty when agentd refused a frame that had none.
     * [consumed]: a rejection that spent its msgId (a launcher command already typed), so the phone keeps the id (R152).
     */
    data class Ack(val msgId: String, val result: String, val error: String?, val consumed: Boolean = false) : AgentdAction
    data class FollowupClosed(val sessionKey: String, val reason: String) : AgentdAction
    data class ModeReset(val sessionKey: String, val from: TempMode, val reason: String) : AgentdAction
    data class Models(
        val sessionKey: String,
        val models: List<String>,
        val efforts: List<String>,
        val currentModel: String?,
        val currentEffort: String?,
    ) : AgentdAction

    /** The reply to a detail_open for a session agentd does not have attached. */
    data class DetailRejected(val sessionId: String) : AgentdAction
    data class Send(val text: String) : AgentdAction

    /** Where else the computer can be dialled. Only a link that finished its pinned hello may act on it. */
    data class Endpoint(val hosts: List<String>, val port: Int?) : AgentdAction
    data object Ignore : AgentdAction
}

class AgentdProtocolCodec {
    private var lastSeq: Long? = null
    private var awaitingSnapshot = true
    private var refreshRequested = false
    private val sessionIds = linkedSetOf<String>()
    private val detailMessageCounts = object : LinkedHashMap<String, Int>(
        MAX_TRACKED_DETAIL_SESSIONS + 1,
        0.75f,
        true,
    ) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Int>?): Boolean =
            size > MAX_TRACKED_DETAIL_SESSIONS
    }

    @Synchronized
    fun reset() {
        lastSeq = null
        awaitingSnapshot = true
        refreshRequested = false
        sessionIds.clear()
        detailMessageCounts.clear()
    }

    /** [steer] (R44) is for the hello of a pinned `wss://` link only, the only link the phone dials. */
    fun hello(token: String, versionName: String, steer: String? = null): String = JSONObject()
        .put("type", "hello")
        .put("v", 1)
        .put("token", token)
        .apply { if (steer != null) put("steer", steer) }
        .put(
            "client",
            JSONObject()
                .put("name", "plugin-agents")
                .put("version", versionName),
        )
        .toString()

    @Synchronized
    fun parse(text: String): AgentdAction {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return AgentdAction.Ignore
        return when (json.nullableString("type", MAX_WIRE_TYPE_CHARS)) {
            "hello" -> {
                if (json.intOrNull("v") != 1) return AgentdAction.Ignore
                val machineId = json.identifierOrNull("machineId") ?: return AgentdAction.Ignore
                val token = json.identifierOrNull("token", MAX_AUTH_TOKEN_CHARS)
                    ?: return AgentdAction.Ignore
                AgentdAction.Hello(
                    machineId = machineId,
                    machineName = json.nullableString("machineName", MAX_HUD_LABEL_CHARS)
                        ?: machineId.take(8),
                    token = token,
                )
            }
            "hello_ack" -> {
                if (json.intOrNull("v") != 1) return AgentdAction.Ignore
                AgentdAction.HelloAcknowledged(
                    json.optJSONObject("server")
                        ?.nullableString("machineName", MAX_HUD_LABEL_CHARS),
                    steering = json.booleanOrNull("steering"),
                )
            }
            EndpointFrame.TYPE -> EndpointFrame.parse(json)?.let { AgentdAction.Endpoint(it.hosts, it.port) }
                ?: AgentdAction.Ignore
            "hello_reject" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                AgentdAction.HelloRejected(json.nullableString("reason", MAX_WIRE_TYPE_CHARS).orEmpty())
            }
            "link_trust" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                AgentdAction.LinkTrust(json.booleanOrNull("steering") ?: return AgentdAction.Ignore)
            }
            "snapshot" -> {
                val seq = json.longOrNull("seq") ?: return AgentdAction.Ignore
                val sessionsJson = json.opt("sessions") as? JSONArray ?: return gapAction()
                val sessions = sessionsJson.toSessions()
                sessionIds.clear()
                sessions.mapTo(sessionIds) { sessionKey(it.provider, it.id) }
                lastSeq = seq
                awaitingSnapshot = false
                refreshRequested = false
                AgentdAction.Snapshot(seq, sessions)
            }
            "session_upsert" -> {
                val seq = json.longOrNull("seq") ?: return AgentdAction.Ignore
                if (!acceptDelta(seq)) return gapAction()
                val session = json.optJSONObject("session")?.toAgentSession()
                    ?: return AgentdAction.Ignore
                lastSeq = seq
                val key = sessionKey(session.provider, session.id)
                if (key !in sessionIds && sessionIds.size >= MAX_SESSIONS_PER_PROVIDER) {
                    return AgentdAction.Ignore
                }
                sessionIds += key
                AgentdAction.Upsert(seq, session)
            }
            "session_removed" -> {
                val seq = json.longOrNull("seq") ?: return AgentdAction.Ignore
                if (!acceptDelta(seq)) return gapAction()
                val provider = json.linkProvider() ?: return AgentdAction.Ignore
                val sessionId = json.identifierOrNull("sessionId") ?: return AgentdAction.Ignore
                lastSeq = seq
                sessionIds -= sessionKey(provider, sessionId)
                detailMessageCounts.remove(sessionKey(provider, sessionId))
                AgentdAction.Removed(seq, provider, sessionId)
            }
            // Conversation payloads carry no seq: they are a reply to the
            // wearer opening a session, never part of the session stream.
            "detail" -> {
                val provider = json.linkProvider() ?: return AgentdAction.Ignore
                val sessionId = json.identifierOrNull("sessionId")
                    ?: return AgentdAction.Ignore
                val key = sessionKey(provider, sessionId)
                if (key !in sessionIds) return AgentdAction.Ignore
                val messagesJson = json.opt("messages") as? JSONArray
                    ?: return AgentdAction.Ignore
                val messages = messagesJson.toMessages()
                detailMessageCounts[key] = messages.size
                AgentdAction.Detail(provider, sessionId, messages)
            }
            "detail_append" -> {
                val provider = json.linkProvider() ?: return AgentdAction.Ignore
                val sessionId = json.identifierOrNull("sessionId")
                    ?: return AgentdAction.Ignore
                val key = sessionKey(provider, sessionId)
                if (key !in sessionIds) return AgentdAction.Ignore
                val messageCount = detailMessageCounts[key]
                    ?: return AgentdAction.Ignore
                if (messageCount >= MAX_DETAIL_MESSAGES) {
                    return AgentdAction.Ignore
                }
                val message = json.optJSONObject("message")?.toAgentMessage()
                    ?: return AgentdAction.Ignore
                detailMessageCounts[key] = messageCount + 1
                AgentdAction.DetailAppend(provider, sessionId, message)
            }
            // Approvals carry no seq either: a held tool call is answered by its
            // own id, and must survive a gap in the session stream.
            "approval_request" -> {
                if (json.intOrNull("v") != 1) return AgentdAction.Ignore
                val requestId = json.identifierOrNull("requestId") ?: return AgentdAction.Ignore
                val provider = json.linkProvider() ?: return AgentdAction.Ignore
                val sessionId = json.identifierOrNull("sessionId") ?: return AgentdAction.Ignore
                val summary = json.nullableString("summary", MAX_HUD_LABEL_CHARS)
                    ?: return AgentdAction.Ignore
                AgentdAction.ApprovalRequested(
                    AgentApproval(
                        requestId = requestId,
                        sessionId = sessionId,
                        provider = provider,
                        tool = json.nullableString("tool", MAX_WIRE_TYPE_CHARS).orEmpty(),
                        summary = summary,
                        detail = json.nullableString("detail", MAX_HUD_TEXT_CHARS),
                        createdAt = json.longOrNull("createdAt"),
                    ),
                )
            }
            "approval_resolved" -> {
                if (json.intOrNull("v") != 1) return AgentdAction.Ignore
                val requestId = json.identifierOrNull("requestId") ?: return AgentdAction.Ignore
                AgentdAction.ApprovalResolved(requestId)
            }
            // Folder listings carry no seq: each is the reply to one fs_list
            // the wearer just asked for, matched back by its request id.
            // The verdict on a spawn the wearer asked for, matched by request id.
            "thread_started" -> {
                val requestId = json.identifierOrNull("id", MAX_FS_REQUEST_ID_CHARS)
                    ?: return AgentdAction.Ignore
                AgentdAction.ThreadStarted(
                    ThreadStartResult(
                        requestId = requestId,
                        ok = json.booleanOrNull("ok") ?: false,
                        provider = AgentProvider.fromWire(
                            json.nullableString("provider", MAX_WIRE_TYPE_CHARS),
                        ),
                        sessionId = json.identifierOrNull("sessionId"),
                        error = json.nullableString("error", MAX_STATUS_DETAIL_CHARS),
                    ),
                )
            }
            // Typed-reply verdicts carry no seq either: each is the reply to one
            // session_input the wearer just sent, matched back by its request id.
            "session_input_result" -> {
                val requestId = json.identifierOrNull("id", MAX_FS_REQUEST_ID_CHARS)
                    ?: return AgentdAction.Ignore
                AgentdAction.SessionInputAnswered(
                    SessionInputResult(
                        requestId = requestId,
                        ok = json.booleanOrNull("ok") ?: false,
                        error = json.nullableString("error", MAX_STATUS_DETAIL_CHARS),
                    ),
                )
            }
            "fs_listing" -> {
                val requestId = json.identifierOrNull("id", MAX_FS_REQUEST_ID_CHARS)
                    ?: return AgentdAction.Ignore
                val entriesJson = json.opt("entries") as? JSONArray
                val entries = buildList {
                    if (entriesJson != null) {
                        for (index in 0 until minOf(entriesJson.length(), MAX_FS_ENTRIES)) {
                            val entry = entriesJson.optJSONObject(index) ?: continue
                            val name = entry.nullableString("name", MAX_HUD_LABEL_CHARS) ?: continue
                            val path = entry.nullableString("path", MAX_PATH_CHARS) ?: continue
                            add(FsEntry(name, path))
                        }
                    }
                }
                AgentdAction.FolderListing(
                    FsListing(
                        requestId = requestId,
                        path = json.nullableString("path", MAX_PATH_CHARS),
                        parent = json.nullableString("parent", MAX_PATH_CHARS),
                        entries = entries,
                        truncated = json.booleanOrNull("truncated") ?: false,
                        error = json.nullableString("error", MAX_STATUS_DETAIL_CHARS),
                    ),
                )
            }
            // The v2 frames carry no seq either: they are replies and pushes
            // about the alert queue, not part of the session stream.
            "alert" -> parseAlert(json)
            "alert_closed" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                val id = json.identifierOrNull("id") ?: return AgentdAction.Ignore
                AgentdAction.AlertClosed(id, json.nullableString("reason", MAX_WIRE_TYPE_CHARS).orEmpty())
            }
            "ack" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                val result = json.nullableString("result", MAX_WIRE_TYPE_CHARS)
                    ?.takeIf { it in ACK_RESULTS }
                    ?: return AgentdAction.Ignore
                AgentdAction.Ack(
                    // Empty on purpose: agentd refuses a frame without an id and has none to echo.
                    // Never trimmed, unlike an alert id: agentd echoes the phone's own id byte for
                    // byte, and a trimmed copy would stop matching the frame the phone sent.
                    msgId = (json.opt("msgId") as? String).orEmpty().take(MAX_MSG_ID_CHARS),
                    result = result,
                    error = json.nullableString("error", MAX_WIRE_TYPE_CHARS),
                    consumed = json.opt("consumed") == true,
                )
            }
            "followup_closed" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                val sessionKey = json.sessionKeyOrNull("sessionKey") ?: return AgentdAction.Ignore
                AgentdAction.FollowupClosed(
                    sessionKey,
                    json.nullableString("reason", MAX_WIRE_TYPE_CHARS).orEmpty(),
                )
            }
            "mode_reset" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                val sessionKey = json.sessionKeyOrNull("sessionKey") ?: return AgentdAction.Ignore
                val from = TempMode.fromWire(json.nullableString("from", MAX_WIRE_TYPE_CHARS))
                    ?: return AgentdAction.Ignore
                AgentdAction.ModeReset(
                    sessionKey,
                    from,
                    json.nullableString("reason", MAX_WIRE_TYPE_CHARS).orEmpty(),
                )
            }
            "models" -> {
                if (json.intOrNull("v") != 2) return AgentdAction.Ignore
                val sessionKey = json.sessionKeyOrNull("sessionKey") ?: return AgentdAction.Ignore
                val current = json.optJSONObject("current")
                AgentdAction.Models(
                    sessionKey = sessionKey,
                    models = json.optJSONArray("models").toStrings(),
                    efforts = json.optJSONArray("efforts").toStrings(),
                    currentModel = current?.nullableString("model", MAX_HUD_LABEL_CHARS),
                    currentEffort = current?.nullableString("effort", MAX_HUD_LABEL_CHARS),
                )
            }
            "detail_rejected" -> {
                val sessionId = json.identifierOrNull("sessionId") ?: return AgentdAction.Ignore
                AgentdAction.DetailRejected(sessionId)
            }
            "ping" -> AgentdAction.Send(
                JSONObject()
                    .put("type", "pong")
                    .put("t", json.opt("t"))
                    .toString(),
            )
            else -> AgentdAction.Ignore
        }
    }

    /** An alert of a kind this plugin does not know is dropped: showing it as something else would mislead. */
    private fun parseAlert(json: JSONObject): AgentdAction {
        if (json.intOrNull("v") != 2) return AgentdAction.Ignore
        val id = json.identifierOrNull("id") ?: return AgentdAction.Ignore
        val sessionKey = json.sessionKeyOrNull("sessionKey") ?: return AgentdAction.Ignore
        val kind = AlertKind.fromWire(json.nullableString("kind", MAX_WIRE_TYPE_CHARS))
            ?: return AgentdAction.Ignore
        val question = json.optJSONObject("question")?.toQuestionPayload()
        // A question nobody can answer is not worth a glance at the glasses.
        if (kind == AlertKind.QUESTION && question == null) return AgentdAction.Ignore
        return AgentdAction.Alert(
            id = id,
            sessionKey = sessionKey,
            kind = kind,
            title = json.nullableString("title", MAX_HUD_LABEL_CHARS).orEmpty(),
            body = json.nullableString("body", MAX_HUD_TEXT_CHARS).orEmpty(),
            actions = json.optJSONArray("actions").toStrings(MAX_ALERT_ACTIONS, MAX_WIRE_TYPE_CHARS),
            question = question,
            waiting = json.intOrNull("waiting")?.coerceAtLeast(0) ?: 0,
            reason = AlertReason.fromWire(json.nullableString("reason", MAX_WIRE_TYPE_CHARS)),
            truncated = json.booleanOrNull("truncated") == true,
        )
    }

    private fun acceptDelta(seq: Long): Boolean =
        !awaitingSnapshot && lastSeq?.let { seq == it + 1L } == true

    private fun gapAction(): AgentdAction {
        if (!awaitingSnapshot) {
            awaitingSnapshot = true
        }
        return if (!refreshRequested) {
            refreshRequested = true
            AgentdAction.Send(REFRESH)
        } else {
            AgentdAction.Ignore
        }
    }

    companion object {
        const val REFRESH = """{"type":"refresh"}"""
        const val DETAIL_CLOSE = """{"type":"detail_close"}"""

        fun detailOpen(sessionId: String): String = JSONObject()
            .put("type", "detail_open")
            .put("sessionId", sessionId)
            .toString()

        /** The wearer wants the folders at [path], or the roots when null. */
        fun fsList(requestId: String, path: String?): String = JSONObject()
            .put("type", "fs_list")
            .put("id", requestId)
            .apply { if (path != null) put("path", path) }
            .toString()

        /** The wearer asked for a new session inside a project folder. */
        fun threadStart(
            requestId: String,
            provider: AgentProvider,
            path: String,
            prompt: String,
        ): String = JSONObject()
            .put("type", "thread_start")
            .put("id", requestId)
            .put("provider", provider.wireValue)
            .put("path", path)
            .put("prompt", prompt)
            .toString()

        /** The wearer answered a held tool call. */
        fun approvalDecision(requestId: String, decision: ApprovalDecision): String = JSONObject()
            .put("type", "approval_decision")
            .put("v", 1)
            .put("requestId", requestId)
            .put("decision", decision.wireValue)
            .toString()

        /** The wearer typed a reply into a session's terminal. */
        fun sessionInput(requestId: String, sessionId: String, text: String): String = JSONObject()
            .put("type", "session_input")
            .put("v", 1)
            .put("id", requestId)
            .put("sessionId", sessionId)
            .put("text", text)
            .toString()

        /**
         * Said out loud before hanging up on a computer we will not talk to.
         * Closing in silence leaves the operator watching a reconnect loop with
         * no way to know the phone is refusing them on purpose.
         */
        fun helloReject(reason: String): String = JSONObject()
            .put("type", "hello_reject")
            .put("v", 1)
            .put("reason", reason)
            .toString()

        // ---- protocol v2, phone to agentd. Monitor frames carry no msgId; every steering
        // frame carries one, made once per user action by the caller and reused on resend.

        /** The glasses showed the alert. */
        fun alertShown(id: String): String = v2Frame("alert_shown").put("id", id).toString()

        /** The glasses dismissed the alert; agentd only parks an approval or question. */
        fun alertDismissed(id: String): String = v2Frame("alert_dismissed").put("id", id).toString()

        fun alertAction(id: String, action: String, msgId: String): String =
            steering("alert_action", msgId).put("id", id).put("action", action).toString()

        /** Callers truncate or refuse before calling: agentd rejects text over 16 KiB of UTF-8. */
        fun followup(sessionKey: String, text: String, msgId: String): String {
            require(text.toByteArray(Charsets.UTF_8).size <= MAX_FOLLOWUP_BYTES) {
                "follow-up text is over $MAX_FOLLOWUP_BYTES bytes"
            }
            return steering("followup", msgId, sessionKey).put("text", text).toString()
        }

        /** [answers] maps each question's text to a `String`, or a `List<String>` for a multi-select. */
        fun questionAnswer(
            sessionKey: String,
            alertId: String,
            requestRef: String,
            answers: Map<String, Any>,
            msgId: String,
        ): String {
            require(answers.isNotEmpty() && answers.size <= MAX_ANSWER_ENTRIES) {
                "answers must hold 1..$MAX_ANSWER_ENTRIES entries"
            }
            val answersJson = JSONObject()
            for ((question, answer) in answers) {
                require(question.length <= MAX_ANSWER_CHARS) { "question text is over $MAX_ANSWER_CHARS chars" }
                val parts = when (answer) {
                    is String -> listOf(answer)
                    is List<*> -> answer.map { requireNotNull(it as? String) { "answers hold strings only" } }
                    else -> throw IllegalArgumentException("an answer is a String or a List<String>")
                }
                require(parts.size <= MAX_ANSWER_ENTRIES && parts.all { it.length <= MAX_ANSWER_CHARS }) {
                    "an answer is over the limits"
                }
                answersJson.put(question, if (answer is String) answer else JSONArray(parts))
            }
            return steering("question_answer", msgId, sessionKey)
                .put("alertId", alertId)
                .put("requestRef", requestRef)
                .put("answers", answersJson)
                .toString()
        }

        /** Approve-all must be confirmed by the wearer; agentd refuses it otherwise. */
        fun modeSet(sessionKey: String, mode: TempMode, confirmed: Boolean, msgId: String): String {
            require(mode != TempMode.APPROVE_ALL || confirmed) { "approve-all needs the wearer's confirmation" }
            return steering("mode_set", msgId, sessionKey)
                .put("mode", mode.wire)
                .put("confirmed", confirmed)
                .toString()
        }

        fun modeRevokeAll(msgId: String): String = steering("mode_revoke_all", msgId).toString()

        fun codexSettings(sessionKey: String, model: String?, effort: String?, msgId: String): String {
            require(model != null || effort != null) { "a settings change names a model or an effort" }
            require(listOfNotNull(model, effort).all { it.isNotBlank() && it.length <= MAX_SETTING_CHARS }) {
                "a model or effort is blank or over $MAX_SETTING_CHARS chars"
            }
            return steering("codex_settings", msgId, sessionKey)
                .apply {
                    if (model != null) put("model", model)
                    if (effort != null) put("effort", effort)
                }
                .toString()
        }

        fun codexCompact(sessionKey: String, msgId: String): String =
            steering("codex_compact", msgId, sessionKey).toString()

        /** The mode new sessions start in; approve-all is never a default. */
        fun defaultsSet(claude: TempMode, codex: TempMode, msgId: String): String {
            require(claude != TempMode.APPROVE_ALL && codex != TempMode.APPROVE_ALL) {
                "approve-all is never a default mode"
            }
            return steering("defaults_set", msgId)
                .put("defaultModes", JSONObject().put("claude", claude.wire).put("codex", codex.wire))
                .toString()
        }

        /** The thresholds, the wait limit and the days a pairing may go unused that the phone owns; agentd derives the alert expiry from the limit. */
        fun settingsSync(timings: AlertTimings, waitLimitMs: Long, msgId: String, pairingTtlDays: Int = 14): String =
            steering("settings_sync", msgId)
                .put(
                    "timings",
                    JSONObject()
                        .put("ageBoostMs", timings.ageBoostMs)
                        .put("dwellMs", timings.dwellMs)
                        .put("ackTimeoutMs", timings.ackTimeoutMs)
                        .put("retryBackoffMs", JSONArray(timings.retryBackoffMs))
                        .put("reminderMs", timings.reminderMs),
                )
                .put("waitLimitMs", waitLimitMs)
                .put("pairingTtlDays", pairingTtlDays)
                .toString()

        fun modelsRequest(sessionKey: String): String =
            v2Frame("models_request").put("sessionKey", requireSessionKey(sessionKey)).toString()

        /** Reserved for the launcher (Plan 3); until then agentd answers every one `rejected not_launcher`. */
        fun launcherCommand(sessionKey: String, command: String, model: String?, msgId: String): String {
            require(command == "compact" || command == "model") { "unknown launcher command: $command" }
            require(model == null || command == "model") { "only the model command takes a model" }
            return steering("launcher_command", msgId, sessionKey)
                .put("command", command)
                .apply { if (model != null) put("model", model) }
                .toString()
        }

        private fun v2Frame(type: String): JSONObject = JSONObject().put("type", type).put("v", 2)

        private fun steering(type: String, msgId: String, sessionKey: String? = null): JSONObject {
            require(msgId.isNotEmpty() && msgId.length <= MAX_MSG_ID_CHARS) {
                "msgId must be 1..$MAX_MSG_ID_CHARS chars"
            }
            return v2Frame(type).apply {
                if (sessionKey != null) put("sessionKey", requireSessionKey(sessionKey))
                put("msgId", msgId)
            }
        }

        private fun requireSessionKey(sessionKey: String): String {
            require(isSessionKey(sessionKey)) { "not a session key: $sessionKey" }
            return sessionKey
        }

        const val REJECT_UNKNOWN_MACHINE = "unknown_machine"
        const val REJECT_BAD_TOKEN = "bad_token"

        /** Ids are only unique within a harness, so nothing is tracked without one. */
        internal fun sessionKey(provider: AgentProvider, sessionId: String): String =
            "${provider.wireValue}:$sessionId"
    }
}

/**
 * Which harness a daemon frame is about. Absent means Claude: that is what the
 * link carried before it learned to speak for anything else, and an old daemon
 * must keep working against a new plugin.
 */
private fun JSONObject.linkProvider(): AgentProvider? {
    val raw = nullableString("provider", MAX_WIRE_TYPE_CHARS) ?: return AgentProvider.CLAUDE
    return AgentProvider.fromWire(raw)?.takeIf { it in AgentProvider.AGENTD_PROVIDERS }
}

private fun JSONArray?.toMessages(): List<AgentMessage> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until minOf(length(), MAX_DETAIL_MESSAGES)) {
            optJSONObject(index)?.toAgentMessage()?.let(::add)
        }
    }
}

private fun JSONObject.toAgentMessage(): AgentMessage? {
    val text = nullableString("text", MAX_HUD_TEXT_CHARS) ?: return null
    val role = nullableString("role", MAX_WIRE_TYPE_CHARS)?.let { raw ->
        MessageRole.values().firstOrNull { it.wireValue == raw }
    } ?: return null
    return AgentMessage(
        role = role,
        text = text,
        at = longOrNull("at"),
        tool = nullableString("tool", MAX_HUD_LABEL_CHARS),
    )
}

private fun JSONArray?.toSessions(): List<AgentSession> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until minOf(length(), MAX_SESSIONS_PER_PROVIDER)) {
            optJSONObject(index)?.toAgentSession()?.let(::add)
        }
    }
}

private fun JSONObject.toAgentSession(): AgentSession? {
    val id = identifierOrNull("id") ?: return null
    // The daemon speaks for more than one harness now. An absent provider is a
    // daemon older than this plugin, and it only ever had Claude to talk about.
    val provider = linkProvider() ?: return null
    val wireStatus = nullableString("status", MAX_WIRE_TYPE_CHARS) ?: return null
    val status = AgentStatus.values().firstOrNull { it.wireValue == wireStatus } ?: AgentStatus.IDLE
    val turnJson = optJSONObject("turn")
    val pendingJson = optJSONObject("pendingRequest")
    val pendingKind = pendingJson?.nullableString("kind", MAX_WIRE_TYPE_CHARS)?.let { raw ->
        PendingRequestKind.values().firstOrNull { it.wireValue == raw }
    }
    val unknownStatusDetail = if (AgentStatus.values().none { it.wireValue == wireStatus }) {
        "Unknown daemon status: $wireStatus"
    } else {
        null
    }
    return AgentSession(
        id = id,
        provider = provider,
        machineId = identifierOrNull("machineId"),
        machineName = nullableString("machineName", MAX_HUD_LABEL_CHARS),
        title = nullableString("title", MAX_HUD_LABEL_CHARS),
        cwd = nullableString("cwd", MAX_PATH_CHARS),
        project = nullableString("project", MAX_HUD_LABEL_CHARS),
        status = status,
        statusDetail = nullableString("statusDetail", MAX_STATUS_DETAIL_CHARS)
            ?: unknownStatusDetail,
        stale = booleanOrNull("stale") ?: false,
        lastActivityAt = longOrNull("lastActivityAt"),
        lastAssistantText = nullableString("lastAssistantText", MAX_HUD_TEXT_CHARS),
        turn = turnJson?.let {
            AgentTurn(
                lastTool = it.nullableString("lastTool", MAX_HUD_LABEL_CHARS),
                activeSince = it.longOrNull("activeSince"),
            )
        },
        pendingRequest = if (pendingJson != null && pendingKind != null) {
            AgentPendingRequest(
                kind = pendingKind,
                summary = pendingJson.nullableString("summary", MAX_HUD_LABEL_CHARS),
                createdAt = pendingJson.longOrNull("createdAt"),
            )
        } else {
            null
        },
        v2 = toSessionV2(fallbackHeading = nullableString("title", MAX_HUD_LABEL_CHARS) ?: id),
        subagents = toSubagents(),
    )
}

/** Absent, malformed or a count under one all mean no subagents: the field only ever adds a line. */
private fun JSONObject.toSubagents(): Subagents? {
    val json = optJSONObject("subagents") ?: return null
    val running = json.intOrNull("running")?.takeIf { it >= 1 } ?: return null
    return Subagents(running.coerceAtMost(MAX_SUBAGENTS), json.longOrNull("since")?.takeIf { it > 0 })
}

/**
 * The v2 fields of a published session. A session from a v1 daemon has none of
 * them, and one that is only half v2 is treated as v1 rather than guessed at.
 */
private fun JSONObject.toSessionV2(fallbackHeading: String): SessionV2? {
    val mode = nullableString("mode", MAX_WIRE_TYPE_CHARS)
        ?.takeIf { it == "plugin" || it == "launcher" }
        ?: return null
    val capabilities = optJSONObject("capabilities") ?: return null
    val tempMode = TempMode.fromWire(nullableString("tempMode", MAX_WIRE_TYPE_CHARS)) ?: return null
    val context = optJSONObject("context")
    val used = context?.longOrNull("used")?.takeIf { it >= 0 }
    val window = context?.longOrNull("window")?.takeIf { it > 0 }
    val pending = optJSONObject("pendingSettings")
    return SessionV2(
        mode = mode,
        canCompact = capabilities.booleanOrNull("compact") ?: false,
        canModel = capabilities.booleanOrNull("model") ?: false,
        // A state this plugin does not know is the one that promises nothing.
        followup = FollowupState.fromWire(capabilities.nullableString("followup", MAX_WIRE_TYPE_CHARS))
            ?: FollowupState.UNAVAILABLE,
        tempMode = tempMode,
        nativeMode = nullableString("nativeMode", MAX_WIRE_TYPE_CHARS),
        heading = nullableString("heading", MAX_HUD_LABEL_CHARS) ?: fallbackHeading,
        currentFile = nullableString("currentFile", MAX_PATH_CHARS),
        step = nullableString("step", MAX_HUD_LABEL_CHARS),
        // Half a fill is no fill.
        contextUsed = if (used != null && window != null) used else null,
        contextWindow = if (used != null && window != null) window else null,
        pendingModel = pending?.nullableString("model", MAX_HUD_LABEL_CHARS),
        pendingEffort = pending?.nullableString("effort", MAX_HUD_LABEL_CHARS),
        sandbox = nullableString("sandbox", MAX_HUD_LABEL_CHARS),
    )
}

private fun JSONObject.toQuestionPayload(): QuestionPayload? {
    val requestRef = identifierOrNull("requestRef", MAX_REQUEST_REF_CHARS) ?: return null
    val source = nullableString("source", MAX_WIRE_TYPE_CHARS) ?: return null
    val itemsJson = optJSONArray("items") ?: return null
    // What the glasses cannot answer exactly as sent is refused, never trimmed to fit (R124).
    var tooLong = itemsJson.length() > MAX_QUESTION_ITEMS
    var unanswerable = false
    val items = buildList {
        for (index in 0 until minOf(itemsJson.length(), MAX_QUESTION_ITEMS)) {
            val parsed = itemsJson.optJSONObject(index)?.toQuestionItem()
            if (parsed == null) {
                unanswerable = true
                continue
            }
            tooLong = tooLong || parsed.tooLong
            unanswerable = unanswerable || parsed.unanswerable
            add(parsed.item)
        }
    }
    if (items.isEmpty()) return null
    val texts = items.map { it.text }
    // agentd keys the answers by question text: two items with one text, or a key it refuses, cannot be answered.
    if (texts.toSet().size != texts.size || texts.any { it in FORBIDDEN_ANSWER_KEYS }) unanswerable = true
    val refusal = when {
        tooLong -> QuestionPayload.TOO_LONG
        unanswerable -> QuestionPayload.UNANSWERABLE
        else -> null
    }
    return QuestionPayload(requestRef, source, items, refusal)
}

private class ParsedQuestionItem(val item: QuestionItem, val tooLong: Boolean, val unanswerable: Boolean)

/** The item with its text and labels exactly as sent; one over agentd's answer bounds is kept cut, for display only. */
private fun JSONObject.toQuestionItem(): ParsedQuestionItem? {
    val text = (opt("text") as? String)?.takeIf(String::isNotBlank) ?: return null
    var tooLong = text.length > MAX_ANSWER_CHARS
    var unanswerable = false
    val optionsJson = optJSONArray("options")
    if (optionsJson != null && optionsJson.length() > MAX_QUESTION_OPTIONS) tooLong = true
    val options = buildList {
        if (optionsJson != null) {
            for (index in 0 until minOf(optionsJson.length(), MAX_QUESTION_OPTIONS)) {
                val option = optionsJson.optJSONObject(index)
                val label = (option?.opt("label") as? String)?.takeIf(String::isNotBlank)
                if (option == null || label == null) {
                    unanswerable = true
                    continue
                }
                if (label.length > MAX_ANSWER_CHARS) tooLong = true
                add(
                    QuestionOption(
                        label.take(MAX_HUD_TEXT_CHARS),
                        option.nullableString("description", MAX_STATUS_DETAIL_CHARS),
                    ),
                )
            }
        }
    }
    val allowFreeText = booleanOrNull("allowFreeText") ?: false
    // Nothing to pick and nothing to say: no answer the glasses could send.
    if (options.isEmpty() && !allowFreeText) unanswerable = true
    return ParsedQuestionItem(
        QuestionItem(
            text = text.take(MAX_HUD_TEXT_CHARS),
            options = options,
            multiSelect = booleanOrNull("multiSelect") ?: false,
            allowFreeText = allowFreeText,
        ),
        tooLong = tooLong,
        unanswerable = unanswerable,
    )
}

private val FORBIDDEN_ANSWER_KEYS = setOf("__proto__", "constructor", "prototype")

/** Strings only, trimmed and capped; anything else in the array is skipped. */
private fun JSONArray?.toStrings(
    maxEntries: Int = MAX_LIST_ENTRIES,
    maxChars: Int = MAX_HUD_LABEL_CHARS,
): List<String> {
    if (this == null) return emptyList()
    return buildList {
        for (index in 0 until minOf(length(), maxEntries)) {
            (opt(index) as? String)?.trim()?.take(maxChars)?.takeIf(String::isNotEmpty)?.let(::add)
        }
    }
}

/** `provider:id` for a provider the daemon link speaks for, exactly as agentd's `parseSessionKey` takes it. */
private fun isSessionKey(value: String): Boolean {
    val separator = value.indexOf(':')
    if (separator <= 0 || separator == value.lastIndex) return false
    val provider = AgentProvider.fromWire(value.substring(0, separator))
    return provider != null && provider in AgentProvider.AGENTD_PROVIDERS
}

private fun JSONObject.sessionKeyOrNull(key: String): String? =
    identifierOrNull(key, MAX_SESSION_KEY_CHARS)?.takeIf(::isSessionKey)

/**
 * Whether a frame type changes what a session does (steering) or only reads or
 * acknowledges state (monitor). The exact copy of `FRAME_CLASS` in agentd's
 * `protocol-v2.ts`; the shared fixtures' `_classes` map is checked against it
 * on both sides. Anything not listed counts as steering, so a frame this plugin
 * has not been taught is closed by default.
 */
object FrameClass {
    private const val STEERING = true
    private const val MONITOR = false

    private val TABLE: Map<String, Boolean> = mapOf(
        "approval_decision" to STEERING,
        "session_input" to STEERING,
        "thread_start" to STEERING,
        "alert_action" to STEERING,
        "followup" to STEERING,
        "question_answer" to STEERING,
        "mode_set" to STEERING,
        "mode_revoke_all" to STEERING,
        "codex_settings" to STEERING,
        "codex_compact" to STEERING,
        "launcher_command" to STEERING,
        "defaults_set" to STEERING,
        "settings_sync" to STEERING,
        "hello" to MONITOR,
        "hello_ack" to MONITOR,
        "hello_reject" to MONITOR,
        "refresh" to MONITOR,
        "detail_open" to MONITOR,
        "detail_close" to MONITOR,
        "ping" to MONITOR,
        "pong" to MONITOR,
        "fs_list" to MONITOR,
        "alert_shown" to MONITOR,
        "alert_dismissed" to MONITOR,
        "models_request" to MONITOR,
    )

    /** The types the table lists, for the tests that check it against the shared fixtures. */
    internal val listedTypes: Set<String> get() = TABLE.keys

    fun isSteering(type: String): Boolean = TABLE[type] ?: true
}

private val ACK_RESULTS = setOf("applied", "duplicate", "rejected")

internal const val MAX_SESSIONS_PER_PROVIDER = 200
private const val MAX_SUBAGENTS = 999
internal const val MAX_PENDING_APPROVALS = 200
internal const val MAX_DETAIL_MESSAGES = 200
internal const val MAX_TRACKED_DETAIL_SESSIONS = 200
internal const val MAX_IDENTIFIER_CHARS = 256
internal const val MAX_HOST_CHARS = 512
internal const val MAX_AUTH_TOKEN_CHARS = 4_096
internal const val MAX_WIRE_TYPE_CHARS = 64
internal const val MAX_HUD_LABEL_CHARS = 160
internal const val MAX_STATUS_DETAIL_CHARS = 512
internal const val MAX_PATH_CHARS = 1_024
internal const val MAX_FS_ENTRIES = 300
internal const val MAX_FS_REQUEST_ID_CHARS = 64
internal const val MAX_HUD_TEXT_CHARS = 4_096
internal const val MAX_MSG_ID_CHARS = 128
internal const val MAX_SESSION_KEY_CHARS = 512
internal const val MAX_REQUEST_REF_CHARS = 512
internal const val MAX_ALERT_ACTIONS = 8
internal const val MAX_QUESTION_ITEMS = 16
internal const val MAX_QUESTION_OPTIONS = 32
internal const val MAX_LIST_ENTRIES = 64

/** What agentd takes: 16 KiB of UTF-8 for a follow-up, and these bounds on a question's answers. */
internal const val MAX_FOLLOWUP_BYTES = 16 * 1024
internal const val MAX_ANSWER_ENTRIES = 32
internal const val MAX_ANSWER_CHARS = 4_000
internal const val MAX_SETTING_CHARS = 100

internal fun JSONObject.nullableString(
    key: String,
    maxChars: Int = MAX_HUD_TEXT_CHARS,
): String? {
    val value = opt(key)
    if (value !is String) return null
    return value.trim().take(maxChars).takeIf(String::isNotEmpty)
}

internal fun JSONObject.identifierOrNull(
    key: String,
    maxChars: Int = MAX_IDENTIFIER_CHARS,
): String? {
    val value = opt(key)
    if (value !is String) return null
    val trimmed = value.trim()
    return trimmed.takeIf { it.isNotEmpty() && it.length <= maxChars }
}

internal fun JSONObject.longOrNull(key: String): Long? =
    when (val value = opt(key)) {
        is Byte -> value.toLong()
        is Short -> value.toLong()
        is Int -> value.toLong()
        is Long -> value
        else -> null
    }

internal fun JSONObject.intOrNull(key: String): Int? =
    when (val value = opt(key)) {
        is Byte -> value.toInt()
        is Short -> value.toInt()
        is Int -> value
        is Long -> value.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
        else -> null
    }

internal fun JSONObject.booleanOrNull(key: String): Boolean? =
    opt(key) as? Boolean
