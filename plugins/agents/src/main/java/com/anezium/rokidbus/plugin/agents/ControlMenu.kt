package com.anezium.rokidbus.plugin.agents

import com.anezium.rokidbus.client.plugin.NexusRowTone

/** One line of the per-session control menu: what it says, and whether it can be picked. */
sealed interface MenuItem {
    val label: String
    val sub: String?
    val enabled: Boolean

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
 * classifies the frame itself, so a plaintext link can never steer from here.
 */
object ControlMenu {
    const val MONITOR_ONLY = AlertNotices.MONITOR_ONLY_BODY
    const val NEEDS_LAUNCHER = "needs rk claude"
    const val FOLLOWUP_CAP_REACHED = "continue on laptop or rk claude"
    const val FOLLOWUP_UNAVAILABLE = "session not waiting"
    const val MODEL_WARNING = "This also changes the default for new sessions"
    const val NOTICE_TITLE = "Session control"

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
     * The main menu, in order. A session without v2 (OpenClaw, an old daemon)
     * has nothing to steer, so it offers only its output. Effort is Codex's.
     */
    fun items(session: AgentSession, secure: Boolean): List<MenuItem> {
        val v2 = session.v2 ?: return listOf(MenuItem.ReadOutput())
        fun steer(sub: String?, enabled: Boolean = true): Pair<String?, Boolean> =
            if (!secure) MONITOR_ONLY to false else sub to enabled
        fun capability(can: Boolean, pending: String?): Pair<String?, Boolean> =
            steer(if (can) pending?.let { "pending" } else NEEDS_LAUNCHER, can)

        val reply = steer(
            when (v2.followup) {
                FollowupState.WAITING, FollowupState.READY -> null
                FollowupState.CAP_REACHED -> FOLLOWUP_CAP_REACHED
                FollowupState.UNAVAILABLE -> FOLLOWUP_UNAVAILABLE
            },
            v2.followup == FollowupState.WAITING || v2.followup == FollowupState.READY,
        )
        val approval = steer(approvalDetail(v2))
        val model = capability(v2.canModel, v2.pendingModel)
        val effort = capability(v2.canModel, v2.pendingEffort)
        val compact = capability(v2.canCompact, null)
        return buildList {
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
     * the last `models` frame for this session, and [modelsAsked] says the
     * request is out, so the list shows "loading" rather than "empty".
     */
    data class MenuState(
        val sessionKey: String,
        val screen: Screen = Screen.Main,
        val index: Int = 0,
        val models: AgentdAction.Models? = null,
        val modelsAsked: Boolean = false,
    )

    sealed interface Step {
        /** Show [state]; nothing leaves the phone. */
        data class Go(val state: MenuState) : Step

        /** Send [command], then show [state]. */
        data class Send(val command: Command, val state: MenuState) : Step

        /** A brief notice, and the menu stays as it is. */
        data class Say(val title: String, val body: String) : Step

        /** [text] is too long for a row: it opens in a reader. */
        data class ReadText(val title: String, val text: String) : Step

        /** Open the editable reply card; its send path is the v2 `followup`. */
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

    fun page(state: MenuState, session: AgentSession, secure: Boolean): Page {
        val entries = entries(state, session, secure)
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

    fun move(state: MenuState, delta: Int, session: AgentSession, secure: Boolean): MenuState {
        val count = entries(state, session, secure).count { it.act != null }
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
    fun pick(state: MenuState, session: AgentSession, secure: Boolean): Step {
        if (!secure && state.screen != Screen.Main) return Step.Go(state.copy(screen = Screen.Main, index = 0))
        val entries = entries(state, session, secure).filter { it.act != null }
        val entry = entries.getOrNull(state.index.coerceIn(0, (entries.size - 1).coerceAtLeast(0)))
        return entry?.act?.invoke() ?: Step.Close
    }

    // ---------------------------------------------------------------- screens

    private fun entries(state: MenuState, session: AgentSession, secure: Boolean): List<Entry> =
        when (val screen = state.screen) {
            Screen.Main -> mainEntries(state, session, secure)
            Screen.Modes -> modeEntries(state, session)
            is Screen.Choose -> chooseEntries(state, session, screen.setting)
            is Screen.Confirm -> confirmEntries(state, screen)
        }

    private fun mainEntries(state: MenuState, session: AgentSession, secure: Boolean): List<Entry> {
        val codex = session.provider == AgentProvider.CODEX
        return items(session, secure).map { item ->
            val tone = if (item.enabled) NexusRowTone.NORMAL else NexusRowTone.DIM
            val row = Row(
                text = item.label,
                sub = item.sub?.singleLine(LINE_CHARS),
                tone = tone,
            )
            val act: () -> Step = when {
                // A greyed row still answers: it says why, and sends nothing.
                !item.enabled -> {
                    { Step.Say(NOTICE_TITLE, item.sub ?: "not available") }
                }
                item is MenuItem.ReplyByVoice -> {
                    { Step.Reply }
                }
                item is MenuItem.ApprovalMode -> {
                    { Step.Go(state.copy(screen = Screen.Modes, index = 0)) }
                }
                item is MenuItem.Model -> {
                    { chooseStep(state, Setting.MODEL, codex) }
                }
                item is MenuItem.Effort -> {
                    { chooseStep(state, Setting.EFFORT, codex) }
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
    private fun chooseStep(state: MenuState, setting: Setting, codex: Boolean): Step {
        val next = state.copy(screen = Screen.Choose(setting), index = 0, modelsAsked = codex)
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

    private fun chooseEntries(state: MenuState, session: AgentSession, setting: Setting): List<Entry> {
        val codex = session.provider == AgentProvider.CODEX
        val frame = state.models
        val options = when {
            !codex -> CLAUDE_MODELS
            frame == null -> null
            setting == Setting.MODEL -> frame.models
            else -> frame.efforts
        }
        if (options == null) {
            val text = if (state.modelsAsked) "Loading…" else "No list yet"
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
                Row(option.singleLine(120), sub = if (option == current) "current" else null),
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
            Entry(Row(screen.yes, tone = NexusRowTone.ALERT)) {
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

    /** `ack rejected` with any error; an applied or duplicate ack says nothing. */
    fun ackNotice(ack: AgentdAction.Ack): String? {
        if (ack.result != "rejected") return null
        val error = ack.error?.singleLine(NOTICE_CHARS)?.takeIf(String::isNotBlank)
        return error?.let { "Not applied: $it" } ?: "Not applied"
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
