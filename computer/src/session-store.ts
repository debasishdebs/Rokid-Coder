import path from "node:path";
import type {
  AgentConfig,
  AgentProvider,
  HookPayload,
  Logger,
  Session,
  TranscriptUpdate,
} from "./types";

const DONE_RETENTION_MS = 30 * 60 * 1000;
const STALLED_AFTER_MS = 30 * 60 * 1000;

interface SessionRecord {
  session: Session;
  lastUserPrompt?: string;
  firstUserPrompt?: string;
  aiTitle?: string;
  transcriptPath?: string;
  /** Subagents running now, oldest first. */
  subagents?: SubagentRun[];
}

interface SubagentRun {
  /** The Task/Agent tool call that started it, when a PreToolUse said so. */
  toolUseId?: string;
  /** The id a SubagentStart, SubagentStop or the tool's own result names it by. */
  agentId?: string;
  /**
   * The agent id came from the tool result or from the SubagentStart naming this tool call. Without
   * it the id was only guessed from arrival order (parallel starts can swap), so a tool result that
   * names no agent does not end it: its SubagentStop does.
   */
  confirmed?: boolean;
  /** The tool call returned `async_launched`: the subagent outlives it and ends only at its SubagentStop. */
  background?: boolean;
  startedAt: number;
}

/** The tool Claude Code starts a subagent with: "Task", and "Agent" in newer versions. */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

const HEADING_PROMPT_CHARS = 48;

/** The task heading: Claude's own title, else the first prompt cut short. */
function headingOf(record: SessionRecord): string | undefined {
  return record.aiTitle || (record.firstUserPrompt
    ? truncateText(record.firstUserPrompt, HEADING_PROMPT_CHARS)
    : undefined);
}

export interface DiscoveredSession {
  id: string;
  cwd?: string;
  projectDir: string;
  title?: string;
  lastActivityAt: number;
  transcriptPath?: string;
}

export interface SessionStoreOptions {
  /**
   * The opt-in check. A session that fails it is never stored, never listed and
   * never published. Absent means everything is allowed, which only unit tests
   * rely on; the daemon always passes the real registry.
   */
  isAttached?: (provider: AgentProvider, id: string) => boolean;
}

type UpsertListener = (session: Session) => void;
type RemovedListener = (sessionId: string) => void;

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function truncateText(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeCwd(value: string | undefined): string {
  return value ? value.replace(/\\/g, "/") : "";
}

export function projectName(value: string): string {
  if (!value) {
    return "";
  }
  return path.win32.basename(value.replace(/\//g, "\\"));
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    turn: session.turn ? { ...session.turn } : undefined,
    ...(session.subagents ? { subagents: { ...session.subagents } } : {}),
    pendingRequest: session.pendingRequest ? { ...session.pendingRequest } : undefined,
  };
}

export class SessionStore {
  private readonly records = new Map<string, SessionRecord>();
  private readonly doneTimers = new Map<string, NodeJS.Timeout>();
  private readonly upsertListeners = new Set<UpsertListener>();
  private readonly removedListeners = new Set<RemovedListener>();
  private readonly now: () => number;
  private readonly attached: (provider: AgentProvider, id: string) => boolean;

  constructor(
    private readonly config: Pick<AgentConfig, "machineId" | "machineName">,
    private readonly logger: Logger,
    now: () => number = Date.now,
    options: SessionStoreOptions = {},
  ) {
    this.now = now;
    this.attached = options.isAttached ?? (() => true);
  }

  get size(): number {
    return this.records.size;
  }

  list(): Session[] {
    return [...this.records.values()]
      .filter((record) => this.attached(record.session.provider, record.session.id))
      .map((record) => cloneSession(record.session))
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  get(sessionId: string): Session | undefined {
    const record = this.records.get(sessionId);
    return record ? cloneSession(record.session) : undefined;
  }

  transcriptPath(sessionId: string): string | undefined {
    return this.records.get(sessionId)?.transcriptPath;
  }

  onUpsert(listener: UpsertListener): () => void {
    this.upsertListeners.add(listener);
    return () => this.upsertListeners.delete(listener);
  }

  onRemoved(listener: RemovedListener): () => void {
    this.removedListeners.add(listener);
    return () => this.removedListeners.delete(listener);
  }

  addDiscovered(discovered: DiscoveredSession): void {
    if (this.records.has(discovered.id) || !this.attached("claude", discovered.id)) {
      return;
    }
    const cwd = normalizeCwd(discovered.cwd);
    const project = projectName(cwd) || projectName(discovered.projectDir);
    const session: Session = {
      id: discovered.id,
      provider: "claude",
      machineId: this.config.machineId,
      machineName: this.config.machineName,
      title: truncateText(discovered.title || project || discovered.id.slice(0, 8), 120),
      cwd,
      project,
      status: "idle",
      stale: true,
      lastActivityAt: discovered.lastActivityAt,
    };
    // Keep the transcript path even while stale: the wearer can open the
    // conversation of a session that has not emitted a hook event yet.
    this.records.set(discovered.id, { session, transcriptPath: discovered.transcriptPath });
    this.emitUpsert(session);
  }

  handleHook(payload: HookPayload): void {
    const eventName = asString(payload.hook_event_name);
    const sessionId = asString(payload.session_id);
    if (!eventName) {
      this.logger.warn("hook_missing_event");
      return;
    }
    if (!sessionId) {
      this.logger.warn("hook_missing_session", { eventName });
      return;
    }
    if (!this.attached("claude", sessionId)) {
      return;
    }

    const existing = this.records.get(sessionId);
    const canCreate = new Set([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "Notification",
      "SessionEnd",
    ]).has(eventName);
    if (!existing && !canCreate) {
      this.logger.info("hook_ignored_unknown_session", { eventName });
      return;
    }

    const now = this.now();
    const cwdFromHook = asString(payload.cwd);
    const transcriptPath = asString(payload.transcript_path);
    const record = existing ?? this.createRecord(sessionId, cwdFromHook, now);
    this.cancelDoneRemoval(sessionId);
    record.session.stale = false;
    record.session.lastActivityAt = now;
    if (cwdFromHook) {
      record.session.cwd = normalizeCwd(cwdFromHook);
      record.session.project = projectName(record.session.cwd);
    }
    if (transcriptPath) {
      record.transcriptPath = transcriptPath;
    }
    const permissionMode = asString(payload.permission_mode);
    if (permissionMode) {
      record.session.nativeMode = permissionMode;
    }

    let refreshTitle = true;
    switch (eventName) {
      case "SessionStart":
        record.subagents = undefined;
        record.session.status = "idle";
        record.session.statusDetail = undefined;
        record.session.pendingRequest = undefined;
        break;
      case "UserPromptSubmit": {
        const prompt = asString(payload.prompt);
        if (prompt && !prompt.trim().startsWith("<")) {
          record.lastUserPrompt = truncateText(prompt, 120);
          record.firstUserPrompt ??= record.lastUserPrompt;
          record.session.title = record.lastUserPrompt || record.session.title;
        } else if (prompt) {
          refreshTitle = false;
        }
        record.session.status = "working";
        record.session.statusDetail = undefined;
        record.session.pendingRequest = undefined;
        record.session.turn = { activeSince: now };
        record.session.currentFile = undefined;
        record.session.step = undefined;
        break;
      }
      case "Stop": {
        // A background subagent goes on after the turn that launched it.
        record.subagents = record.subagents?.filter((run) => run.background);
        record.session.currentFile = undefined;
        record.session.step = undefined;
        // Stop fires before the transcript holds the final message, so the tail
        // still has the previous turn's text; the hook carries the real one.
        const finalText = asString(payload.last_assistant_message);
        if (finalText) {
          record.session.lastAssistantText = truncateText(finalText, 140);
        }
        // The turn is over, so a permission prompt it showed is over too
        // (answered "No" at the laptop fires nothing else).
        if (record.session.pendingRequest?.kind === "permission") {
          record.session.pendingRequest = undefined;
        }
        if (record.session.pendingRequest) {
          record.session.status = "needs_you";
        } else {
          record.session.status = "idle";
          record.session.statusDetail = undefined;
        }
        break;
      }
      case "SubagentStart":
        this.subagentStarted(record, asString(payload.agent_id), asString(payload.tool_use_id), now);
        break;
      case "SubagentStop":
        this.subagentEnded(record, { agentId: asString(payload.agent_id) });
        break;
      case "PreToolUse": {
        if (SUBAGENT_TOOLS.has(asString(payload.tool_name) ?? "")) {
          (record.subagents ??= []).push({ toolUseId: asString(payload.tool_use_id), startedAt: now });
        }
        const input = payload.tool_input;
        const fields = input && typeof input === "object" && !Array.isArray(input)
          ? input as Record<string, unknown>
          : {};
        const file = asString(fields.file_path);
        const step = asString(fields.description);
        record.session.currentFile = file ? truncateText(file, 200) : undefined;
        record.session.step = step ? truncateText(step, 120) : undefined;
        break;
      }
      case "PreCompact":
      case "PostCompact":
      case "PostToolUse":
      case "PostToolUseFailure":
      case "PermissionDenied":
        if (SUBAGENT_TOOLS.has(asString(payload.tool_name) ?? "")) {
          this.subagentToolReturned(record, asString(payload.tool_use_id), payload.tool_response, eventName === "PostToolUse");
        }
        break;
      case "UserPromptExpansion":
        break;
      case "Notification":
        this.applyNotification(record, asString(payload.message), now);
        break;
      case "SessionEnd":
        record.subagents = undefined;
        record.session.status = "done";
        record.session.statusDetail = undefined;
        record.session.pendingRequest = undefined;
        this.scheduleDoneRemoval(sessionId);
        break;
      default:
        this.logger.info("hook_unknown_event", { eventName });
        break;
    }

    if (refreshTitle) {
      this.refreshDerivedTitle(record);
    }
    this.refreshHeading(record);
    this.applySubagents(record);
    this.emitUpsert(record.session);
  }

  /** The agent id a subagent tool's result names, and whether it only launched the subagent in the background. */
  private subagentResult(response: unknown): { agentId?: string; async: boolean } {
    const fields = response && typeof response === "object" && !Array.isArray(response) ? response as Record<string, unknown> : {};
    return { agentId: asString(fields.agentId) ?? asString(fields.agent_id), async: fields.status === "async_launched" };
  }

  /** Gives `run` the identity `agentId`, taking it from any run that only had it by guess. */
  private bindAgent(runs: SubagentRun[], run: SubagentRun, agentId: string): void {
    for (const other of runs) {
      if (other !== run && other.agentId === agentId) {
        other.agentId = undefined;
        other.confirmed = false;
      }
    }
    run.agentId = agentId;
    run.confirmed = true;
  }

  /**
   * A SubagentStart is a subagent a Task/Agent call launched, or, with no such call, a new one. When
   * the hook names its tool call it is bound exactly; otherwise it takes the oldest call with no
   * agent yet, which is a guess that a tool result's agent id later corrects.
   */
  private subagentStarted(record: SessionRecord, agentId: string | undefined, toolUseId: string | undefined, now: number): void {
    const runs = (record.subagents ??= []);
    if (agentId && runs.some((run) => run.agentId === agentId && (run.confirmed || toolUseId === undefined))) {
      return;
    }
    const named = toolUseId === undefined ? undefined : runs.find((run) => run.toolUseId === toolUseId);
    if (named && agentId) {
      this.bindAgent(runs, named, agentId);
      return;
    }
    const unbound = runs.find((run) => run.agentId === undefined && run.toolUseId !== undefined);
    if (unbound) {
      unbound.agentId = agentId;
    } else {
      runs.push({ agentId, startedAt: now });
    }
  }

  /**
   * The Task/Agent tool call returned. A background launch (`async_launched`) only started the
   * subagent: it keeps running, now known by the id the result names, until its SubagentStop. Any
   * other return ended it: the run the result names is removed, else the call's own run, unless
   * that run's id was only guessed and the result names none (its SubagentStop will end it).
   */
  private subagentToolReturned(record: SessionRecord, toolUseId: string | undefined, response: unknown, succeeded: boolean): void {
    const runs = record.subagents;
    const own = toolUseId === undefined ? undefined : runs?.find((run) => run.toolUseId === toolUseId);
    if (!runs) {
      return;
    }
    const { agentId, async } = this.subagentResult(response);
    if (succeeded && async) {
      if (own) {
        own.background = true;
        if (agentId) {
          this.bindAgent(runs, own, agentId);
        }
      }
      return;
    }
    const named = agentId === undefined ? undefined : runs.find((run) => run.agentId === agentId);
    let ended = named;
    if (!ended && own) {
      // Its own run, unless the id on it was a guess and nothing here confirms or contradicts it.
      ended = (agentId === undefined ? own.agentId === undefined || own.confirmed : own.agentId === undefined) ? own : undefined;
    }
    if (ended) {
      runs.splice(runs.indexOf(ended), 1);
    }
  }

  /** A SubagentStop ends the run that id names, and nothing else: an id no run has ends nothing. */
  private subagentEnded(record: SessionRecord, ended: { agentId?: string }): void {
    const runs = record.subagents;
    const at = runs && ended.agentId !== undefined ? runs.findIndex((run) => run.agentId === ended.agentId) : -1;
    if (runs && at >= 0) {
      runs.splice(at, 1);
    }
  }

  /** The phone's view of them: absent when none run, so an idle session's frame is what it always was. */
  private applySubagents(record: SessionRecord): void {
    const runs = record.subagents;
    if (runs && runs.length === 0) {
      record.subagents = undefined;
    }
    record.session.subagents = record.subagents
      ? { running: record.subagents.length, since: Math.min(...record.subagents.map((run) => run.startedAt)) }
      : undefined;
  }

  applyTranscriptUpdate(sessionId: string, update: TranscriptUpdate): void {
    const record = this.records.get(sessionId);
    if (!record || record.session.status === "done" || record.session.stale) {
      return;
    }

    record.session.lastActivityAt = Math.max(record.session.lastActivityAt, update.activityAt);
    if (update.lastAssistantText) {
      record.session.lastAssistantText = truncateText(update.lastAssistantText, 140);
    }
    if (update.lastTool) {
      record.session.turn = {
        ...record.session.turn,
        lastTool: truncateText(update.lastTool, 140),
        activeSince: record.session.turn?.activeSince ?? update.activityAt,
      };
    }
    if (update.interrupted) {
      // The person stopped it, so it waits for them: idle, and no prompt left open.
      record.session.status = "idle";
      record.session.statusDetail = undefined;
      record.session.pendingRequest = undefined;
    } else if (update.error) {
      record.session.status = "error";
      record.session.statusDetail = truncateText(update.error, 140);
    }
    if (update.context) {
      record.session.context = { ...update.context };
    }
    if (update.heading) {
      record.aiTitle = update.heading;
      this.refreshHeading(record);
    }
    this.emitUpsert(record.session);
  }

  /** Titles read from the transcript at attach time, for a session that was already under way. */
  seedHeading(sessionId: string, seed: { aiTitle?: string; firstPrompt?: string }): void {
    const record = this.records.get(sessionId);
    if (!record) {
      return;
    }
    record.aiTitle ??= seed.aiTitle;
    record.firstUserPrompt ??= seed.firstPrompt;
    this.refreshHeading(record);
    this.emitUpsert(record.session);
  }

  /**
   * The permission prompt the session was waiting on has been answered (its
   * tool ran, failed or was denied), so it no longer needs the person.
   */
  clearPermissionRequest(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record?.session.pendingRequest?.kind !== "permission") {
      return;
    }
    record.session.pendingRequest = undefined;
    if (record.session.status === "needs_you") {
      record.session.status = "working";
    }
    this.emitUpsert(record.session);
  }

  /** Publishes the session again, for state that lives outside the store (modes, waits). */
  refresh(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (record) {
      this.emitUpsert(record.session);
    }
  }

  /**
   * Provider adapters publish already-normalized sessions here. Claude stays
   * on its existing discovery/hook path so this cannot bypass hook semantics.
   */
  upsertProviderSession(session: Session): void {
    if (session.provider === "claude") {
      throw new Error("Claude sessions must use the hook and discovery paths");
    }
    if (!this.attached(session.provider, session.id)) {
      return;
    }
    const snapshot = cloneSession(session);
    this.records.set(session.id, { session: snapshot });
    this.emitUpsert(snapshot);
  }

  sweepStalled(now = this.now()): void {
    for (const record of this.records.values()) {
      if (
        record.session.status === "working" &&
        now - record.session.lastActivityAt > STALLED_AFTER_MS
      ) {
        record.session.status = "error";
        record.session.statusDetail = "stalled?";
        this.emitUpsert(record.session);
      }
    }
  }

  removeSession(sessionId: string): void {
    if (!this.records.delete(sessionId)) {
      return;
    }
    this.cancelDoneRemoval(sessionId);
    for (const listener of this.removedListeners) {
      listener(sessionId);
    }
  }

  dispose(): void {
    for (const timer of this.doneTimers.values()) {
      clearTimeout(timer);
    }
    this.doneTimers.clear();
    this.upsertListeners.clear();
    this.removedListeners.clear();
  }

  private createRecord(sessionId: string, cwdValue: string | undefined, now: number): SessionRecord {
    const cwd = normalizeCwd(cwdValue);
    const project = projectName(cwd);
    const record: SessionRecord = {
      session: {
        id: sessionId,
        provider: "claude",
        machineId: this.config.machineId,
        machineName: this.config.machineName,
        title: project || sessionId.slice(0, 8),
        cwd,
        project,
        status: "idle",
        stale: false,
        lastActivityAt: now,
      },
    };
    this.records.set(sessionId, record);
    return record;
  }

  private applyNotification(record: SessionRecord, message: string | undefined, now: number): void {
    if (!message) {
      this.logger.info("notification_unclassified", { reason: "missing_message" });
      return;
    }
    const lower = message.toLowerCase();
    const kind = lower.includes("permission")
      ? "permission"
      : lower.includes("waiting for your input") || lower.includes("idle")
        ? "idle_prompt"
        : undefined;
    if (!kind) {
      this.logger.info("notification_unclassified", { messageLength: message.length });
      return;
    }
    record.session.status = "needs_you";
    record.session.statusDetail = undefined;
    record.session.pendingRequest = {
      kind,
      summary: message,
      createdAt: now,
    };
  }

  private refreshHeading(record: SessionRecord): void {
    record.session.heading = headingOf(record);
  }

  private refreshDerivedTitle(record: SessionRecord): void {
    record.session.title =
      record.lastUserPrompt ||
      projectName(record.session.cwd) ||
      record.session.id.slice(0, 8);
  }

  private emitUpsert(session: Session): void {
    if (!this.attached(session.provider, session.id)) {
      return;
    }
    const snapshot = cloneSession(session);
    for (const listener of this.upsertListeners) {
      listener(snapshot);
    }
  }

  private scheduleDoneRemoval(sessionId: string): void {
    this.cancelDoneRemoval(sessionId);
    const timer = setTimeout(() => {
      this.doneTimers.delete(sessionId);
      this.removeSession(sessionId);
    }, DONE_RETENTION_MS);
    timer.unref();
    this.doneTimers.set(sessionId, timer);
  }

  private cancelDoneRemoval(sessionId: string): void {
    const timer = this.doneTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.doneTimers.delete(sessionId);
    }
  }
}
