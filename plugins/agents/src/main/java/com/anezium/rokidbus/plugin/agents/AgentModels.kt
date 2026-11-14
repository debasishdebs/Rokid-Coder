package com.anezium.rokidbus.plugin.agents

enum class AgentProvider(
    val wireValue: String,
    val marker: String,
) {
    CLAUDE("claude", "CC"),
    CODEX("codex", "CX"),
    OPENCLAW("openclaw", "OC"),
    ;

    companion object {
        fun fromWire(value: String?): AgentProvider? =
            values().firstOrNull { it.wireValue == value }

        /**
         * The providers the daemon link speaks for. A snapshot from it is
         * authoritative for all of them at once, while OpenClaw arrives on its
         * own connection and must never be touched by one.
         */
        val AGENTD_PROVIDERS = setOf(CLAUDE, CODEX)
    }
}

enum class AgentStatus(val wireValue: String) {
    WORKING("working"),
    NEEDS_YOU("needs_you"),
    IDLE("idle"),
    DONE("done"),
    ERROR("error"),
}

enum class PendingRequestKind(val wireValue: String) {
    PERMISSION("permission"),
    QUESTION("question"),
    IDLE_PROMPT("idle_prompt"),
}

data class AgentTurn(
    val lastTool: String? = null,
    val activeSince: Long? = null,
)

data class AgentPendingRequest(
    val kind: PendingRequestKind,
    val summary: String? = null,
    val createdAt: Long? = null,
)

data class AgentSession(
    val id: String,
    val provider: AgentProvider,
    val machineId: String? = null,
    val machineName: String? = null,
    val title: String? = null,
    val cwd: String? = null,
    val project: String? = null,
    val status: AgentStatus,
    val statusDetail: String? = null,
    val stale: Boolean = false,
    val lastActivityAt: Long? = null,
    val lastAssistantText: String? = null,
    val turn: AgentTurn? = null,
    val pendingRequest: AgentPendingRequest? = null,
    /** The protocol v2 fields; null for a daemon (or provider) that sends none. */
    val v2: SessionV2? = null,
) {
    val key: String
        get() = "${provider.wireValue}:$id"

    val displayTitle: String
        get() = title?.takeIf(String::isNotBlank)
            ?: project?.takeIf(String::isNotBlank)
            ?: cwd?.substringAfterLast('/')?.substringAfterLast('\\')?.takeIf(String::isNotBlank)
            ?: id
}

/** The temporary approval mode agentd applies to one session; `wire` is the frame's value. */
enum class TempMode(val wire: String) {
    ASK("ask"),
    ACCEPT_EDITS("acceptEdits"),
    APPROVE_ALL("approveAll"),
    ;

    companion object {
        fun fromWire(value: String?): TempMode? = values().firstOrNull { it.wire == value }
    }
}

/** Whether a typed follow-up can be delivered into the session right now. */
enum class FollowupState(val wire: String) {
    WAITING("waiting"),
    UNAVAILABLE("unavailable"),
    CAP_REACHED("cap_reached"),
    READY("ready"),
    ;

    companion object {
        fun fromWire(value: String?): FollowupState? = values().firstOrNull { it.wire == value }
    }
}

/**
 * What protocol v2 adds to a published session. [mode] is `plugin` or
 * `launcher`; [nativeMode] is the provider's own approval mode, read-only.
 */
data class SessionV2(
    val mode: String,
    val canCompact: Boolean,
    val canModel: Boolean,
    val followup: FollowupState,
    val tempMode: TempMode,
    val nativeMode: String?,
    val heading: String,
    val currentFile: String?,
    val step: String?,
    val contextUsed: Long?,
    val contextWindow: Long?,
    val pendingModel: String?,
    val pendingEffort: String?,
    val sandbox: String?,
)

enum class AlertKind(val wire: String) {
    APPROVAL("approval"),
    QUESTION("question"),
    ERROR("error"),
    DONE("done"),
    NOTICE("notice"),
    ;

    companion object {
        fun fromWire(value: String?): AlertKind? = values().firstOrNull { it.wire == value }
    }
}

/** Why agentd sent this alert frame; a missing or unknown reason counts as [NEW]. */
enum class AlertReason(val wire: String) {
    NEW("new"),
    RETRY("retry"),
    REMINDER("reminder"),
    RESUME("resume"),
    UPDATE("update"),
    ;

    companion object {
        fun fromWire(value: String?): AlertReason = values().firstOrNull { it.wire == value } ?: NEW
    }
}

data class QuestionOption(val label: String, val description: String? = null)

data class QuestionItem(
    val text: String,
    val options: List<QuestionOption>,
    val multiSelect: Boolean,
    val allowFreeText: Boolean,
)

/**
 * [items] hold the exact wire strings agentd matches answers by (R124): a
 * question's text and its option labels are never trimmed or cut here, only
 * when drawn. [refusal] is set when the glasses cannot answer the payload as
 * sent, and then says why; such a question is answered on the laptop.
 */
data class QuestionPayload(
    val requestRef: String,
    val source: String,
    val items: List<QuestionItem>,
    val refusal: String? = null,
) {
    companion object {
        const val TOO_LONG = "Question too long — answer on laptop"
        const val UNANSWERABLE = "Can't answer here — answer on laptop"
    }
}

/**
 * The alert thresholds the phone owns and syncs to agentd. There is no expiry:
 * agentd derives it from the wait limit, so an alert never ends before its hold.
 */
data class AlertTimings(
    val ageBoostMs: Long,
    val dwellMs: Long,
    val ackTimeoutMs: Long,
    val retryBackoffMs: List<Long>,
    val reminderMs: Long,
)

enum class ApprovalDecision(val wireValue: String) {
    ALLOW("allow"),
    DENY("deny"),
}

/** One folder on a linked computer, offered by the daemon's fs browser. */
data class FsEntry(
    val name: String,
    val path: String,
)

/** The daemon's answer to one fs_list request. */
data class FsListing(
    val requestId: String,
    val path: String?,
    val parent: String?,
    val entries: List<FsEntry>,
    val truncated: Boolean,
    val error: String?,
)

/** A folder the wearer anchored as a project on one of their computers. */
data class AgentProject(
    val name: String,
    val path: String,
)

/** The daemon's verdict on one thread_start request. */
data class ThreadStartResult(
    val requestId: String,
    val ok: Boolean,
    val provider: AgentProvider?,
    val sessionId: String?,
    val error: String?,
)

/**
 * The daemon's verdict on one session_input request — typing a reply into a
 * session's terminal. Failure reasons (still working, not running in screen
 * or tmux, too long, etc.) come straight from the daemon so the wearer sees
 * the real reason rather than a generic "couldn't send".
 */
data class SessionInputResult(
    val requestId: String,
    val ok: Boolean,
    val error: String?,
)

/**
 * A tool call an agent is holding still for, waiting on the wearer.
 *
 * This is the only thing in the product that is *decidable* rather than
 * observable, so it is kept apart from [AgentPendingRequest]: that one is what
 * monitoring inferred about a session, this one is a live question with an
 * identity to answer.
 */
data class AgentApproval(
    val requestId: String,
    val sessionId: String,
    val provider: AgentProvider,
    val tool: String,
    val summary: String,
    val detail: String? = null,
    val createdAt: Long? = null,
) {
    val sessionKey: String
        get() = "${provider.wireValue}:$sessionId"

    companion object {
        const val MAX_PENDING = 32
    }
}

enum class MessageRole(val wireValue: String, val label: String) {
    USER("user", "YOU"),
    ASSISTANT("assistant", "CC"),
    TOOL("tool", "RUN"),
}

data class AgentMessage(
    val role: MessageRole,
    val text: String,
    val at: Long? = null,
    val tool: String? = null,
)

/** The conversation the wearer currently has open, as served by the daemon. */
data class AgentConversation(
    val sessionKey: String,
    val sessionId: String,
    val provider: AgentProvider,
    val loading: Boolean = true,
    val messages: List<AgentMessage> = emptyList(),
) {
    companion object {
        const val MAX_MESSAGES = 60
    }
}

enum class ConnectionState(val wireValue: String) {
    DISCONNECTED("disconnected"),
    CONNECTING("connecting"),
    CONNECTED("connected"),
    AUTH_FAILED("auth_failed"),
}

data class ProviderConnectionState(
    val state: ConnectionState = ConnectionState.DISCONNECTED,
    val detail: String? = null,
)
