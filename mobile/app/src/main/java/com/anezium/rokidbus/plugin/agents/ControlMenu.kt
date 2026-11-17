package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusRowTone

/** One line of the per-session control menu: what it says, and whether it can be picked. */
sealed interface MenuItem {
    val label: String
    val sub: String?
    val enabled: Boolean

    /**
     * A pending approval or question whose card left the glasses: picking it brings the same card back.
     * [alertId] is the item; [sub] says what it is.
     */
    data class AnswerPending(
        val alertId: String,
        val kind: AlertKind,
        override val sub: String?,
        override val enabled: Boolean = true,
    ) : MenuItem {
        override val label: String get() = if (kind == AlertKind.QUESTION) "Answer question" else "Answer approval"
    }

    data class ReplyByVoice(override val sub: String?, override val enabled: Boolean) : MenuItem {
        override val label: String get() = "Reply by voice"
    }

    data class ApprovalMode(override val sub: String?, override val enabled: Boolean) : MenuItem {
        override val label: String get() = "Approval mode"
    }

    data class Model(override val sub: String?, override val enabled: Boolean) : MenuItem {
        override val label: String get() = "Model"
    }

    data class Effort(override val sub: String?, override val enabled: Boolean) : MenuItem {
        override val label: String get() = "Effort"
    }

    data class Compact(override val sub: String?, override val enabled: Boolean) : MenuItem {
        override val label: String get() = "Compact"
    }

    data class Context(override val sub: String?, override val enabled: Boolean = true) : MenuItem {
        override val label: String get() = "Context"
    }

    data class ReadOutput(override val sub: String? = null, override val enabled: Boolean = true) : MenuItem {
        override val label: String get() = "Read output"
    }
}

/**
 * The control menu behind ENTER on a board row, as a pure model: what each card
 * says ([page]), what a pick does ([pick]), and the copy of the notices that
 * follow ([ackNotice], [followupClosedNotice], [modeResetNotice]). The service
 * only draws a [Page], sends a [Command] through the wire and shows a notice, so
 * every rule of the brief is tested here without the glasses.
 *
 * Nothing here sends: a [Step.Send] hands the command back, and the wire still
 * classifies the frame itself, so a link not bound as secure can never steer from here.
 */
object ControlMenu {
    /** A steering row with no secure link: greyed, and a press says so instead of sending. */
    const val NOT_CONNECTED = AlertCoordinator.NOT_CONNECTED
    const val NEEDS_LAUNCHER = "needs rk claude"
    const val NOT_AVAILABLE = "not available"
    const val MODELS_UNAVAILABLE = "Models unavailable"

    /** How long a Codex chooser waits for agentd's `models` frame (R98). */
    const val MODELS_TIMEOUT_MS = 10_000L

    const val FOLLOWUP_CAP_REACHED = "continue on laptop or rk claude"
    const val FOLLOWUP_UNAVAILABLE = "session not waiting"
    const val FOLLOWUP_BUSY = "Claude is working — try again when it is idle"
    const val FOLLOWUP_BACKGROUND = "background work is running — wait for it, or reply at the laptop"
    const val FOLLOWUP_DRAFT = "text typed at the laptop prompt — clear it first"
    const val FOLLOWUP_NOT_LAUNCHER = "start the session with rk claude"
    const val FOLLOWUP_BG_OFF = "background replies are off — turn them on in Settings"
    const val FOLLOWUP_MODE_NOT_ALLOWED = "Background replies aren't supported in this mode"
    const val MODEL_WARNING = "This also changes the default for new sessions"
    const val NOTICE_TITLE = "Session control"

    /** R152: agentd already has this command, so it is not typed again. */
    const val ALREADY_SENT = "Already sent — check laptop"

    /** agentd's refusal of a prompt for a session no `rk claude` launcher holds. */
    const val NOT_LAUNCHER = "not_launcher"
    const val NOT_LAUNCHER_FOLLOWUP = "Start the session with rk claude to send prompts from the glasses."

    /** agentd typed nothing and kept the reply open: Claude was busy when it was about to go in, so the wearer may retry. */
    const val NOT_SENT = "not_sent"
    const val NOT_SENT_FOLLOWUP = "Claude is busy with something else, wait a moment and try again"

    /** R152: typed into the session, then the launcher failed; the id stays spent. */
    const val SENT_MAYBE_UNFINISHED = "Sent, but may not have finished — check laptop"

    /** R152: a kept id is too old for agentd to still know, so the tap sends nothing and arms the retry. */
    const val MAY_ALREADY_BE_SENT = "May already have been sent — tap again to send"

    /** The row's sub while the next tap is an informed resend. */
    const val TAP_TO_SEND_AGAIN = "Tap to send again"

    /** The launcher's fixed model list (design §12.6); Codex asks agentd for its own. */
    val CLAUDE_MODELS = listOf("opus", "sonnet", "haiku")

    /** Over this a line is cut to the SDK's cap and the full text opens in a reader. */
    const val LINE_CHARS = 240

    private const val SUB_PART_CHARS = 160
    private const val NOTICE_CHARS = 240

    /** Both tools take the same three temporary modes. */
    @Suppress("UNUSED_PARAMETER")
    fun modeOptions(provider: AgentProvider): List<TempMode> =
        listOf(TempMode.ASK, TempMode.ACCEPT_EDITS, TempMode.APPROVE_ALL)

    /**
     * The main menu, in order. A session without v2 (an old daemon)
     * has nothing to steer, so it offers only its output. Effort is Codex's.
     */
    fun items(
        session: AgentSession,
        secure: Boolean,
        notApplied: String? = null,
        replyNotSent: String? = null,
        pending: AgentdAction.Alert? = null,
    ): List<MenuItem> {
        val answer = pending?.let {
            MenuItem.AnswerPending(
                it.id,
                it.kind,
                it.body.ifBlank { it.title }.singleLine(SUB_PART_CHARS).takeIf(String::isNotBlank),
            )
        }
        val v2 = session.v2 ?: return listOfNotNull(answer, MenuItem.ReadOutput())
        fun steer(sub: String?, enabled: Boolean = true): Pair<String?, Boolean> =
            if (!secure) NOT_CONNECTED to false else sub to enabled
        // `needs rk claude` is the way out for a Claude session only (R95).
        val missing = if (session.provider == AgentProvider.CLAUDE) NEEDS_LAUNCHER else NOT_AVAILABLE
        fun capability(can: Boolean, pending: String?): Pair<String?, Boolean> =
            steer(if (can) pending?.let { "pending" } else missing, can)

        val reply = steer(
            // A rejected follow-up stays on the row until the next one or a followup_closed (R106).
            if (replyNotSent != null) "Reply not sent: $replyNotSent" else when (v2.followup) {
                FollowupState.WAITING, FollowupState.READY -> null
                FollowupState.CAP_REACHED -> FOLLOWUP_CAP_REACHED
                FollowupState.UNAVAILABLE -> followupUnavailable(v2.followupWhy)
            },
            v2.followup == FollowupState.WAITING || v2.followup == FollowupState.READY,
        )
        val approval = steer(
            listOfNotNull(approvalDetail(v2), notApplied?.let { "Not applied: $it" }).joinToString(" · "),
        )
        val model = capability(v2.canModel, v2.pendingModel)
        val effort = capability(v2.canModel, v2.pendingEffort)
        val compact = capability(v2.canCompact, null)
        return buildList {
            answer?.let(::add)
            add(MenuItem.ReplyByVoice(reply.first, reply.second))
            add(MenuItem.ApprovalMode(approval.first, approval.second))
            add(MenuItem.Model(model.first, model.second))
            if (session.provider == AgentProvider.CODEX) add(MenuItem.Effort(effort.first, effort.second))
            add(MenuItem.Compact(compact.first, compact.second))
            add(MenuItem.Context(contextSub(v2)))
            add(MenuItem.ReadOutput())
        }
    }

    /** `NN% · used/window`, k-rounded, or `unknown`. */
    fun contextSub(v2: SessionV2): String {
        val used = v2.contextUsed ?: return "unknown"
        val window = v2.contextWindow?.takeIf { it > 0 } ?: return "unknown"
        val percent = (used * 100 + window / 2) / window
        return "$percent% · ${thousands(used)}/${thousands(window)}"
    }

    private fun thousands(value: Long): String =
        if (value < 1_000) value.toString() else "${(value + 500) / 1_000}k"

    /** The wearer-readable current modes; each part is cut, and the whole is cut again by the row. */
    fun approvalDetail(v2: SessionV2): String = listOfNotNull(
        tempLabel(v2.tempMode),
        v2.nativeMode?.singleLine(SUB_PART_CHARS)?.takeIf(String::isNotBlank)?.let { "native: $it" },
        v2.sandbox?.singleLine(SUB_PART_CHARS)?.takeIf(String::isNotBlank)?.let { "sandbox: $it" },
    ).joinToString(" · ")

    private fun tempLabel(mode: TempMode): String = when (mode) {
        TempMode.ASK -> "ask"
        TempMode.ACCEPT_EDITS -> "accept edits"
        TempMode.APPROVE_ALL -> "approve all"
    }

    // ------------------------------------------------------------------ state

    enum class Setting { MODEL, EFFORT }

    sealed interface Screen {
        data object Main : Screen
        data object Modes : Screen
        data class Choose(val setting: Setting) : Screen

        /** [back] is where BACK and Cancel return to; [command] is sent only on Yes. */
        data class Confirm(
            val prompt: String,
            val warning: String?,
            val yes: String,
            val command: Command,
            val back: Screen,
        ) : Screen
    }

    /**
     * What the menu asks the service to send. [ModelsRequest] is a monitor frame;
     * every other one is steering and carries a msgId made by the caller.
     */
    sealed interface Command {
        data class ModeSet(val mode: TempMode, val confirmed: Boolean) : Command
        data class CodexSettings(val model: String?, val effort: String?) : Command
        data object CodexCompact : Command
        data object LauncherCompact : Command
        data class LauncherModel(val model: String) : Command
        data object ModelsRequest : Command
    }

    /**
     * [index] counts the selectable rows of the current screen only. [models] is
     * the last `models` frame for this session, and [modelsAskedAt] is when the
     * request went out, so the list shows "loading", then "unavailable", rather
     * than "empty". [rearm] says the menu was covered and its ENTER guard, which
     * is the screen's [ActiveCard], must start over the moment it is drawn again.
     */
    data class MenuState(
        val sessionKey: String,
        val screen: Screen = Screen.Main,
        val index: Int = 0,
        val models: AgentdAction.Models? = null,
        val modelsAskedAt: Long? = null,
        val rearm: Boolean = false,
        /** A mode change agentd refused, shown beside the real mode until the mode changes, or 30 s (R101, R107). */
        val notApplied: String? = null,
        /** A follow-up agentd rejected, shown on the Reply by voice row until the next one (R106). */
        val replyNotSent: String? = null,
        /** Launcher commands whose next tap is an informed resend (R152); their rows say so. */
        val retryArmed: Set<Command> = emptySet(),
    )

    /**
     * Another card or an alert took the screen (R96): whatever confirm was open
     * is gone, and the menu starts again on Main with its guard re-armed when it
     * is next drawn, so a tap meant for the other card can never land on it.
     */
    fun covered(state: MenuState): MenuState =
        if (state.screen == Screen.Main) {
            state.copy(rearm = true)
        } else {
            state.copy(screen = Screen.Main, index = 0, modelsAskedAt = null, rearm = true)
        }

    sealed interface Step {
        /** Show [state]; nothing leaves the phone. */
        data class Go(val state: MenuState) : Step

        /** Send [command], then show [state]. */
        data class Send(val command: Command, val state: MenuState) : Step

        /** A brief notice, and the menu stays as it is. */
        data class Say(val title: String, val body: String) : Step

        /** [text] is too long for a row: it opens in a reader. */
        data class ReadText(val title: String, val text: String) : Step

        /** The wearer picked a pending item's menu line: its card comes back on the glasses. */
        data class Answer(val alertId: String) : Step

        /** Start a voice reply; it is sent as the v2 `followup` after the heard card's Send. */
        data object Reply : Step

        /** Open the conversation. */
        data object Read : Step
        data object Close : Step
    }

    class Row(
        val text: String,
        val sub: String? = null,
        val tone: NexusRowTone = NexusRowTone.NORMAL,
        val selectable: Boolean = true,
    )

    class Page(
        val title: String,
        val subtitle: String,
        val footer: String,
        val rows: List<Row>,
        /** Index into [rows] of the highlighted one, or -1. */
        val selected: Int,
    )

    fun open(sessionKey: String): MenuState = MenuState(sessionKey)

    fun withModels(state: MenuState, models: AgentdAction.Models): MenuState =
        if (models.sessionKey == state.sessionKey) state.copy(models = models) else state

    private class Entry(val row: Row, val act: (() -> Step)?)

    fun page(
        state: MenuState,
        session: AgentSession,
        secure: Boolean,
        now: Long = System.currentTimeMillis(),
        pending: AgentdAction.Alert? = null,
    ): Page {
        val entries = entries(state, session, secure, now, pending)
        val selectable = entries.indices.filter { entries[it].act != null }
        val selected = selectable.getOrNull(state.index.coerceIn(0, (selectable.size - 1).coerceAtLeast(0))) ?: -1
        val heading = headingOf(session)
        val (subtitle, footer) = when (val screen = state.screen) {
            Screen.Main -> "control · ${session.provider.wireValue}" to "swipe move · tap pick · 2-tap board"
            Screen.Modes -> "approval mode" to "swipe move · tap pick · 2-tap back"
            is Screen.Choose -> when (screen.setting) {
                Setting.MODEL -> "model"
                Setting.EFFORT -> "effort"
            } to "swipe move · tap pick · 2-tap back"
            is Screen.Confirm -> "confirm" to "swipe move · tap pick · 2-tap cancel"
        }
        return Page(
            title = heading.singleLine(110),
            subtitle = subtitle.take(120),
            footer = footer,
            rows = entries.map { it.row },
            selected = selected,
        )
    }

    fun move(
        state: MenuState,
        delta: Int,
        session: AgentSession,
        secure: Boolean,
        now: Long = System.currentTimeMillis(),
        pending: AgentdAction.Alert? = null,
    ): MenuState {
        val count = entries(state, session, secure, now, pending).count { it.act != null }
        if (count == 0) return state
        return state.copy(index = ((state.index + delta) % count + count) % count)
    }

    /** BACK: one screen up, or null when the menu itself closes. */
    fun back(state: MenuState): MenuState? = when (val screen = state.screen) {
        Screen.Main -> null
        Screen.Modes, is Screen.Choose -> state.copy(screen = Screen.Main, index = 0)
        is Screen.Confirm -> state.copy(screen = screen.back, index = 0)
    }

    /**
     * ENTER on the highlighted row. Off the main screen a link that stopped
     * steering sends the wearer back to the main menu, which says why, instead
     * of leaving a confirm card that would send nothing.
     */
    fun pick(
        state: MenuState,
        session: AgentSession,
        secure: Boolean,
        now: Long = System.currentTimeMillis(),
        pending: AgentdAction.Alert? = null,
    ): Step {
        if (!secure && state.screen != Screen.Main) return Step.Go(state.copy(screen = Screen.Main, index = 0))
        val entries = entries(state, session, secure, now, pending).filter { it.act != null }
        val entry = entries.getOrNull(state.index.coerceIn(0, (entries.size - 1).coerceAtLeast(0)))
        return entry?.act?.invoke() ?: Step.Close
    }

    // ---------------------------------------------------------------- screens

    private fun entries(
        state: MenuState,
        session: AgentSession,
        secure: Boolean,
        now: Long,
        pending: AgentdAction.Alert?,
    ): List<Entry> =
        when (val screen = state.screen) {
            Screen.Main -> mainEntries(state, session, secure, now, pending)
            Screen.Modes -> modeEntries(state, session)
            is Screen.Choose -> chooseEntries(state, session, screen.setting, now)
            is Screen.Confirm -> confirmEntries(state, screen)
        }

    private fun mainEntries(
        state: MenuState,
        session: AgentSession,
        secure: Boolean,
        now: Long,
        pending: AgentdAction.Alert?,
    ): List<Entry> {
        val codex = session.provider == AgentProvider.CODEX
        return items(session, secure, state.notApplied, state.replyNotSent, pending).map { item ->
            val tone = if (item.enabled) NexusRowTone.NORMAL else NexusRowTone.DIM
            val armed = item is MenuItem.Compact && item.enabled && !codex && Command.LauncherCompact in state.retryArmed
            val row = Row(
                text = item.label,
                sub = if (armed) TAP_TO_SEND_AGAIN else item.sub?.singleLine(LINE_CHARS),
                tone = tone,
            )
            val act: () -> Step = when {
                // A greyed row still answers: it says why, and sends nothing.
                !item.enabled -> {
                    {
                        if (item.sub == NOT_CONNECTED) Step.Say(AlertCoordinator.NOT_SENT, NOT_CONNECTED)
                        else Step.Say(NOTICE_TITLE, item.sub ?: "not available")
                    }
                }
                item is MenuItem.AnswerPending -> {
                    { Step.Answer(item.alertId) }
                }
                item is MenuItem.ReplyByVoice -> {
                    { Step.Reply }
                }
                item is MenuItem.ApprovalMode -> {
                    { Step.Go(state.copy(screen = Screen.Modes, index = 0)) }
                }
                item is MenuItem.Model -> {
                    { chooseStep(state, Setting.MODEL, codex, now) }
                }
                item is MenuItem.Effort -> {
                    { chooseStep(state, Setting.EFFORT, codex, now) }
                }
                item is MenuItem.Compact -> {
                    {
                        Step.Go(
                            state.copy(
                                screen = Screen.Confirm(
                                    prompt = "Compact ${headingOf(session).singleLine(120)}?",
                                    warning = null,
                                    yes = "Yes, compact",
                                    command = if (codex) Command.CodexCompact else Command.LauncherCompact,
                                    back = Screen.Main,
                                ),
                                index = CANCEL_INDEX,
                            ),
                        )
                    }
                }
                item is MenuItem.Context -> {
                    { Step.Say("Context", item.sub ?: "unknown") }
                }
                else -> {
                    { Step.Read }
                }
            }
            Entry(row, act)
        }
    }

    /** Claude's list is fixed; Codex's comes from agentd, so asking for it is the first step. */
    private fun chooseStep(state: MenuState, setting: Setting, codex: Boolean, now: Long): Step {
        // A list from an earlier request is stale: the new answer replaces it.
        val next = state.copy(
            screen = Screen.Choose(setting),
            index = 0,
            models = if (codex) null else state.models,
            modelsAskedAt = if (codex) now else null,
        )
        return if (codex) Step.Send(Command.ModelsRequest, next) else Step.Go(next)
    }

    private fun modeEntries(state: MenuState, session: AgentSession): List<Entry> {
        val v2 = session.v2
        val current = v2?.tempMode
        val detail = v2?.let(::approvalDetail).orEmpty()
        return buildList {
            if (detail.length > LINE_CHARS) {
                // The full text of an overflowing row opens in a reader.
                add(
                    Entry(
                        Row(detail.take(LINE_CHARS), tone = NexusRowTone.BODY),
                    ) { Step.ReadText("Approval mode", detail) },
                )
            }
            for (mode in modeOptions(session.provider)) {
                val row = Row(
                    text = modeLabel(mode),
                    sub = if (mode == current) "current" else null,
                    tone = if (mode == TempMode.APPROVE_ALL) NexusRowTone.ALERT else NexusRowTone.NORMAL,
                )
                add(
                    Entry(row) {
                        when {
                            mode == current -> Step.Go(state.copy(screen = Screen.Main, index = 0))
                            mode == TempMode.APPROVE_ALL -> Step.Go(
                                state.copy(
                                    screen = Screen.Confirm(
                                        prompt = "Approve everything in ${headingOf(session).singleLine(120)}?",
                                        warning = null,
                                        yes = "Yes, approve all",
                                        command = Command.ModeSet(TempMode.APPROVE_ALL, confirmed = true),
                                        back = Screen.Modes,
                                    ),
                                    index = CANCEL_INDEX,
                                ),
                            )
                            else -> Step.Send(
                                Command.ModeSet(mode, confirmed = false),
                                state.copy(screen = Screen.Main, index = 0),
                            )
                        }
                    },
                )
            }
        }
    }

    private fun modeLabel(mode: TempMode): String = when (mode) {
        TempMode.ASK -> "Ask"
        TempMode.ACCEPT_EDITS -> "Accept edits"
        TempMode.APPROVE_ALL -> "Approve all"
    }

    private fun chooseEntries(state: MenuState, session: AgentSession, setting: Setting, now: Long): List<Entry> {
        val codex = session.provider == AgentProvider.CODEX
        val frame = state.models
        val options = when {
            !codex -> CLAUDE_MODELS
            frame == null -> null
            setting == Setting.MODEL -> frame.models
            else -> frame.efforts
        }
        if (options == null) {
            val asked = state.modelsAskedAt
            val text = when {
                asked == null -> "No list yet"
                now - asked >= MODELS_TIMEOUT_MS -> MODELS_UNAVAILABLE
                else -> "Loading…"
            }
            return listOf(Entry(Row(text, tone = NexusRowTone.DIM, selectable = false), null))
        }
        if (options.isEmpty()) {
            val text = if (setting == Setting.MODEL) "No models offered" else "No efforts offered"
            return listOf(Entry(Row(text, tone = NexusRowTone.DIM, selectable = false), null))
        }
        val current = when (setting) {
            Setting.MODEL -> frame?.currentModel
            Setting.EFFORT -> frame?.currentEffort
        }
        return options.map { option ->
            Entry(
                Row(
                    option.singleLine(120),
                    sub = when {
                        !codex && Command.LauncherModel(option) in state.retryArmed -> TAP_TO_SEND_AGAIN
                        option == current -> "current"
                        else -> null
                    },
                ),
            ) {
                val main = state.copy(screen = Screen.Main, index = 0)
                when {
                    codex -> Step.Send(
                        Command.CodexSettings(
                            model = option.takeIf { setting == Setting.MODEL },
                            effort = option.takeIf { setting == Setting.EFFORT },
                        ),
                        main,
                    )
                    else -> Step.Go(
                        state.copy(
                            screen = Screen.Confirm(
                                prompt = "Switch to $option?",
                                warning = MODEL_WARNING,
                                yes = "Yes, switch",
                                command = Command.LauncherModel(option),
                                back = Screen.Choose(setting),
                            ),
                            index = CANCEL_INDEX,
                        ),
                    )
                }
            }
        }
    }

    private fun confirmEntries(state: MenuState, screen: Screen.Confirm): List<Entry> = buildList {
        add(Entry(Row(screen.prompt.singleLine(LINE_CHARS), tone = NexusRowTone.BODY, selectable = false), null))
        screen.warning?.let {
            add(Entry(Row(it, tone = NexusRowTone.ALERT, selectable = false), null))
        }
        add(
            Entry(
                Row(
                    screen.yes,
                    sub = if (screen.command in state.retryArmed) TAP_TO_SEND_AGAIN else null,
                    tone = NexusRowTone.ALERT,
                ),
            ) {
                Step.Send(screen.command, state.copy(screen = Screen.Main, index = 0))
            },
        )
        add(
            Entry(Row("Cancel")) {
                Step.Go(state.copy(screen = screen.back, index = 0))
            },
        )
    }

    /** Yes is 0 and Cancel is 1, and a confirm opens on Cancel so a double tap never confirms. */
    private const val CANCEL_INDEX = 1

    // ------------------------------------------------------------------ frames

    /** The wire line for [command]; [msgId] is ignored by the monitor frame. May throw on a blank or oversize value. */
    fun frame(command: Command, sessionKey: String, msgId: String): String = when (command) {
        is Command.ModeSet -> AgentdProtocolCodec.modeSet(sessionKey, command.mode, command.confirmed, msgId)
        is Command.CodexSettings ->
            AgentdProtocolCodec.codexSettings(sessionKey, command.model, command.effort, msgId)
        Command.CodexCompact -> AgentdProtocolCodec.codexCompact(sessionKey, msgId)
        Command.LauncherCompact -> AgentdProtocolCodec.launcherCommand(sessionKey, "compact", null, msgId)
        is Command.LauncherModel -> AgentdProtocolCodec.launcherCommand(sessionKey, "model", command.model, msgId)
        Command.ModelsRequest -> AgentdProtocolCodec.modelsRequest(sessionKey)
    }

    /** True for a command that carries a msgId and so is answered by an `ack`. */
    fun steers(command: Command): Boolean = command != Command.ModelsRequest

    // ------------------------------------------------------------------ copy

    /**
     * A duplicate says it was already sent, a consumed rejection says it may not have finished (R152),
     * any other `rejected` names its error; an applied ack says nothing.
     */
    fun ackNotice(ack: AgentdAction.Ack, followup: Boolean = false): String? {
        if (ack.result == "duplicate") return ALREADY_SENT
        if (ack.result != "rejected") return null
        if (ack.consumed) return SENT_MAYBE_UNFINISHED
        if (followup) followupHint(ack.error)?.let { return it }
        val error = ack.error?.singleLine(NOTICE_CHARS)?.takeIf(String::isNotBlank)
        return error?.let { "Not applied: $it" } ?: "Not applied"
    }

    /**
     * Why a follow-up was refused, for the menu row and the alert history: agentd's `not_launcher`
     * says a plugin-only session cannot take a prompt, and this says what to do about it.
     */
    fun followupRejection(error: String?, limit: Int): String =
        followupHint(error) ?: error?.singleLine(limit)?.takeIf(String::isNotBlank) ?: "rejected"

    /** The wearer's words for a refusal agentd gives a follow-up, or null for one that keeps its own. */
    fun followupHint(error: String?): String? = when (error) {
        NOT_LAUNCHER -> NOT_LAUNCHER_FOLLOWUP
        NOT_SENT -> NOT_SENT_FOLLOWUP
        else -> null
    }

    /** The row's text for an unavailable reply, by agentd's `followupWhy`; none or unknown keeps the old line. */
    fun followupUnavailable(why: String?): String = when (why) {
        "busy" -> FOLLOWUP_BUSY
        "background" -> FOLLOWUP_BACKGROUND
        "draft" -> FOLLOWUP_DRAFT
        NOT_LAUNCHER -> FOLLOWUP_NOT_LAUNCHER
        "bg_off" -> FOLLOWUP_BG_OFF
        "mode_not_allowed" -> FOLLOWUP_MODE_NOT_ALLOWED
        else -> FOLLOWUP_UNAVAILABLE
    }

    /** `delivered` is the happy ending and gets no notice. */
    fun followupClosedNotice(reason: String): String? = when (reason) {
        "laptop" -> "Laptop took over"
        "timeout" -> "Reply window closed"
        "cancelled" -> "Reply cancelled"
        else -> null
    }

    fun modeResetNotice(from: TempMode, heading: String, reason: String): String {
        val why = when (reason) {
            "session_ended" -> "session ended"
            "helper_restarted" -> "helper restarted"
            "revoked" -> "revoked"
            else -> reason.singleLine(40)
        }
        val head = if (from == TempMode.APPROVE_ALL) "Approve-all off" else "${modeLabel(from)} off"
        return "$head — ${heading.singleLine(120)}: $why".take(NOTICE_CHARS)
    }

    private fun headingOf(session: AgentSession): String =
        session.v2?.heading?.takeIf(String::isNotBlank) ?: session.displayTitle
}
