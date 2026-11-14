import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import WebSocket from "ws";
import {
  type ApprovalDecision,
  type ApprovalKind,
  type ApprovalManager,
  type ApprovalRequest,
} from "../approval-manager";
import { sessionKeyOf, type QuestionPayload, type SessionKey } from "../protocol-v2";
import type {
  QuestionAnswers,
  QuestionClosed,
  QuestionClosedListener,
  QuestionClosedReason,
  QuestionOpened,
  QuestionOpenedListener,
} from "../question-relay";
import { MAX_PENDING_QUESTIONS } from "../question-relay";
import {
  normalizeCwd,
  projectName,
  type SessionStore,
  truncateText,
} from "../session-store";
import type {
  AgentConfig,
  Logger,
  PendingRequest,
  Session,
  SessionMessage,
  ThreadStartResult,
} from "../types";
import { daemonEndpoint, resolveDaemonSocketPath } from "./daemon-socket";
import { DETAIL_MESSAGE_LIMIT } from "../transcript-messages";
import { codexThreadMessages, codexTurnMessages, codexTurnsMessages } from "./messages";
import type {
  AdditionalFileSystemPermissions,
  AdditionalNetworkPermissions,
  ApprovalServerRequest,
  CommandApprovalParams,
  FileChangeApprovalParams,
  PermissionsApprovalParams,
  RequestId,
  RpcMessage,
  Thread,
  ThreadListResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTurnsListResponse,
  Turn,
  TurnStartParams,
  TurnStatus,
  TurnStartResponse,
} from "./protocol";
import { readLastTokenUsage, type ContextUsage } from "./rollout-usage";

// The HUD board never shows more than 63 rows, and one thread/resume replays a
// full rollout: a deep backlog at 200 threads kept the first synchronize from
// ever finishing on a real machine. Sixty recent threads is more than the
// glasses can show and cheap enough to resume.
export const MAX_CODEX_SESSIONS = 60;
const APP_SERVER_PAGE_SIZE = 60;
const DEFAULT_CONNECT_TIMEOUT_MS = 800;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_DELAY_MS = 3_000;
const START_RETRY_MS = 150;
const REFRESH_CONCURRENCY = 8;
// The app-server only pushes thread/started for turns it hosts itself. Threads
// born in a terminal (codex exec, the CLI) reach the store only when listed, so
// the monitor re-lists on a slow clock and adopts what it has never seen.
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
// thread/resume fails with "no rollout found" until a thread's first turn has
// been written. Retry briefly; after that the slow sweep picks the thread up.
const DEFAULT_ROLLOUT_RETRY_MS = 5_000;
const MAX_ROLLOUT_RETRIES = 12;
const CLIENT_VERSION = "0.1.0";
const RUN_CODEX_TIMEOUT_MS = 15_000;
const MAX_MODEL_PAGES = 10;
// thread/resume replays nothing, so what happened while we were away is read back
// with thread/turns/list: newest turns first, a few at a time, until enough
// messages are held to fill the detail view (or the thread starts).
const HISTORY_PAGE_TURNS = 20;
const MAX_HISTORY_PAGES = 10;

export interface CodexAvailability {
  enabled: boolean;
  available: boolean;
  reason?: string;
}

export interface CodexSpawnSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** The model and effort a turn/start can carry; never an approval policy. */
export interface FollowUpSettings {
  model?: string;
  effort?: string;
}

/** A turn the monitor saw end on an attached thread. */
export interface CodexTurnCompleted {
  sessionKey: SessionKey;
  threadId: string;
  status: TurnStatus;
  /** The failure message, for a failed turn. */
  error?: string;
}

export type CodexTurnCompletedListener = (event: CodexTurnCompleted) => void;

export type FollowUpResult = "started" | "queued";
/** `unknown`: nothing is waiting on that requestRef, or no answer matched a question. */
export type QuestionAnswerResult = FollowUpResult | "replied" | "unknown";

export interface CodexTerminateSpec {
  command: string;
  args: string[];
  options: SpawnOptions;
}

export function codexSpawnSpec(
  port: number,
  platform = process.platform,
): CodexSpawnSpec {
  return {
    command: "codex",
    args: ["app-server", "--listen", `ws://127.0.0.1:${port}`],
    options: {
      shell: platform === "win32",
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  };
}

export function codexTerminateSpec(
  pid: number,
  platform = process.platform,
): CodexTerminateSpec | undefined {
  if (platform !== "win32") {
    return undefined;
  }
  return {
    command: "taskkill.exe",
    args: ["/pid", String(pid), "/t", "/f"],
    options: {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  };
}

interface PendingRpc {
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingCodexQuestion {
  threadId: string;
  source: "codex_async" | "codex_rpc";
  items: QuestionPayload["items"];
  /** codex_rpc only: the server request to reply to, and the question id behind each item's text. */
  rpcId?: RequestId;
  idByText?: Map<string, string>;
  /** The wait limit Y, as for Claude's questions; then the question is the TUI's alone. */
  timer?: NodeJS.Timeout;
}

interface PendingCodexApproval {
  phoneRequestId: string;
  rpcId: RequestId;
  threadId: string;
  summary: string;
  createdAt: number;
}

export interface CodexMonitorOptions {
  config: Pick<AgentConfig, "machineId" | "machineName" | "codex">;
  store: SessionStore;
  approvals: ApprovalManager;
  logger: Logger;
  /**
   * The opt-in check, by exact thread id. Required rather than defaulted so a
   * caller cannot forget it: a thread that fails it is never adopted, resumed,
   * published or asked about.
   */
  isAttached: (threadId: string) => boolean;
  /**
   * The provider says the thread is over (closed, archived or deleted). Not
   * called when agentd itself stops watching it; that is a detach.
   */
  onThreadEnded?: (threadId: string) => void;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
  startTimeoutMs?: number;
  reconnectDelayMs?: number;
  sweepIntervalMs?: number;
  rolloutRetryMs?: number;
  now?: () => number;
  launch?: (port: number) => ChildProcess;
  terminate?: (child: ChildProcess) => Promise<void>;
  /**
   * Runs the `codex` binary with these arguments and resolves when it exits 0.
   * The follow-up queue goes through it; tests inject it so no real binary runs.
   */
  runCodex?: (args: string[]) => Promise<void>;
}

type ApprovalParams =
  | CommandApprovalParams
  | FileChangeApprovalParams
  | PermissionsApprovalParams;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function codexQueueArgs(threadId: string, text: string): string[] {
  // `--message=<text>`: as a separate argument, text starting with "-" would be
  // read as another flag.
  return ["queue", "--thread", threadId, `--message=${text}`];
}

function runCodexBinary(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // No shell: the text is the wearer's and goes through as one argument.
    const child = spawn("codex", args, { shell: false, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("codex timed out"));
    }, RUN_CODEX_TIMEOUT_MS);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`codex exited with code ${String(code)}`));
      }
    });
  });
}

/** One `Q: … / A: …` line per answered question, in the order they were asked. */
export function formatQuestionAnswers(
  items: QuestionPayload["items"],
  answers: QuestionAnswers,
): string {
  const lines: string[] = [];
  for (const item of items) {
    const answer = answers[item.text];
    if (answer !== undefined) {
      lines.push(`Q: ${item.text} / A: ${Array.isArray(answer) ? answer.join(", ") : answer}`);
    }
  }
  return lines.join("\n");
}

function settingsOf(value: unknown): FollowUpSettings {
  const record = asRecord(value);
  const settings: FollowUpSettings = {};
  if (typeof record?.model === "string" && record.model) {
    settings.model = record.model;
  }
  if (typeof record?.effort === "string" && record.effort) {
    settings.effort = record.effort;
  }
  return settings;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function rpcIdKey(id: RequestId): string {
  return `${typeof id === "number" ? "number" : "string"}:${String(id)}`;
}

export function codexApprovalRequestId(id: RequestId): string {
  const value = typeof id === "number" ? String(id) : id;
  return `codex:${typeof id === "number" ? "n" : "s"}:${Buffer.from(value).toString("base64url")}`;
}

function approvalThreadId(params: ApprovalParams): string | undefined {
  return typeof params.threadId === "string" && params.threadId
    ? params.threadId
    : undefined;
}

function permissionDetail(params: PermissionsApprovalParams): string {
  const parts: string[] = [];
  if (params.permissions.network) {
    parts.push("network access");
  }
  const fileSystem = params.permissions.fileSystem;
  if (fileSystem?.read?.length) {
    parts.push(`read: ${fileSystem.read.map(normalizeCwd).join(", ")}`);
  }
  if (fileSystem?.write?.length) {
    parts.push(`write: ${fileSystem.write.map(normalizeCwd).join(", ")}`);
  }
  return parts.join("; ");
}

export function describeCodexApproval(request: ApprovalServerRequest): {
  tool: string;
  summary: string;
  detail: string;
  createdAt: number;
} {
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const params = request.params;
      const command = params.command?.trim();
      const reason = params.reason?.trim();
      return {
        tool: "Command",
        summary: truncateText(reason || command || "Run a command", 120),
        detail: truncateText(command || reason || normalizeCwd(params.cwd ?? undefined), 400),
        createdAt: params.startedAtMs,
      };
    }
    case "item/fileChange/requestApproval": {
      const params = request.params;
      const reason = params.reason?.trim();
      const root = normalizeCwd(params.grantRoot ?? undefined);
      return {
        tool: "File change",
        summary: truncateText(reason || (root ? `Change files under ${root}` : "Change files"), 120),
        detail: truncateText(root || reason || "Codex requested permission to change files.", 400),
        createdAt: params.startedAtMs,
      };
    }
    case "item/permissions/requestApproval": {
      const params = request.params;
      const reason = params.reason?.trim();
      const detail = permissionDetail(params);
      return {
        tool: "Permissions",
        summary: truncateText(reason || detail || "Grant additional permissions", 120),
        detail: truncateText(detail || reason || normalizeCwd(params.cwd), 400),
        createdAt: params.startedAtMs,
      };
    }
  }
}

/** From the server-request method, never from describeCodexApproval's display label. */
function codexApprovalKind(method: ApprovalServerRequest["method"]): ApprovalKind {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command";
    case "item/fileChange/requestApproval":
      return "fileChange";
    case "item/permissions/requestApproval":
      return "tool";
  }
}

export function buildCodexApprovalRequest(
  request: ApprovalServerRequest,
  threadId: string,
): ApprovalRequest {
  const described = describeCodexApproval(request);
  return {
    type: "approval_request",
    v: 1,
    requestId: codexApprovalRequestId(request.id),
    sessionId: threadId,
    provider: "codex",
    sessionKey: sessionKeyOf("codex", threadId),
    approvalKind: codexApprovalKind(request.method),
    tool: described.tool,
    summary: described.summary,
    detail: described.detail,
    createdAt: described.createdAt,
  };
}

export function codexApprovalResponse(
  request: ApprovalServerRequest,
  decision: ApprovalDecision,
): Record<string, unknown> {
  if (request.method !== "item/permissions/requestApproval") {
    return { decision: decision === "allow" ? "accept" : "decline" };
  }

  const permissions: {
    network?: AdditionalNetworkPermissions;
    fileSystem?: AdditionalFileSystemPermissions;
  } = {};
  if (decision === "allow") {
    if (request.params.permissions.network) {
      permissions.network = request.params.permissions.network;
    }
    if (request.params.permissions.fileSystem) {
      permissions.fileSystem = request.params.permissions.fileSystem;
    }
  }
  return { permissions, scope: "turn" };
}

function latestTurn(thread: Thread): Turn | undefined {
  return thread.turns.at(-1);
}

function threadIsBusy(thread: Thread): boolean {
  return thread.status.type === "active" || latestTurn(thread)?.status === "inProgress";
}

function threadActivityAt(thread: Thread): number {
  const turn = latestTurn(thread);
  const seconds = Math.max(
    thread.createdAt,
    thread.updatedAt,
    thread.recencyAt ?? 0,
    turn?.startedAt ?? 0,
    turn?.completedAt ?? 0,
  );
  return seconds * 1000;
}

export function normalizeCodexThread(
  thread: Thread,
  identity: Pick<AgentConfig, "machineId" | "machineName">,
  pendingApproval?: Pick<PendingCodexApproval, "summary" | "createdAt">,
  terminalError?: string,
): Session {
  const cwd = normalizeCwd(thread.cwd);
  const project = projectName(cwd);
  const turn = latestTurn(thread);
  const waitingOnApproval =
    thread.status.type === "active" &&
    thread.status.activeFlags.includes("waitingOnApproval");
  const failed =
    terminalError ||
    (thread.status.type === "systemError" ? "Codex app-server reported a system error." : undefined) ||
    (turn?.status === "failed" ? turn.error?.message || "Codex turn failed." : undefined);
  const working =
    thread.status.type === "active" ||
    turn?.status === "inProgress";
  const status = pendingApproval || waitingOnApproval
    ? "needs_you"
    : failed
      ? "error"
      : working
        ? "working"
        : "idle";
  const pendingRequest: PendingRequest | undefined =
    pendingApproval || waitingOnApproval
      ? {
          kind: "permission",
          summary: truncateText(
            pendingApproval?.summary || "Codex is waiting for approval.",
            140,
          ),
          createdAt: pendingApproval?.createdAt ?? threadActivityAt(thread),
        }
      : undefined;
  const activeSince =
    turn?.status === "inProgress"
      ? (turn.startedAt ?? thread.updatedAt) * 1000
      : undefined;

  return {
    id: thread.id,
    provider: "codex",
    machineId: identity.machineId,
    machineName: identity.machineName,
    title: truncateText(
      thread.name?.trim() || thread.preview.trim() || project || thread.id.slice(0, 8),
      120,
    ),
    cwd,
    project,
    status,
    statusDetail: status === "error" ? truncateText(failed || "Codex error", 140) : undefined,
    stale: false,
    lastActivityAt: Math.max(threadActivityAt(thread), pendingApproval?.createdAt ?? 0),
    turn: activeSince === undefined ? undefined : { activeSince },
    pendingRequest,
  };
}

async function inBatches<T>(
  values: T[],
  operation: (value: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < values.length; index += REFRESH_CONCURRENCY) {
    await Promise.all(
      values.slice(index, index + REFRESH_CONCURRENCY).map(operation),
    );
  }
}

export class CodexMonitor {
  private socket?: WebSocket;
  private ownedProcess?: ChildProcess;
  private reconnectTimer?: NodeJS.Timeout;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private connecting = false;
  private stopped = true;
  private nextRequestId = 0;
  private readonly pendingRpc = new Map<number, PendingRpc>();
  private readonly threads = new Map<string, Thread>();
  private readonly approvalsByRpcId = new Map<string, PendingCodexApproval>();
  private readonly terminalErrors = new Map<string, string>();
  private readonly now: () => number;
  private state: CodexAvailability;
  private lastChildError = "";
  // Shared-daemon mode. `wanted` is the set of threads the daemon asked us to
  // subscribe (the attach registry's codex entries); it is what lets an old
  // attached thread be resumed without it appearing in any capped listing.
  private readonly wanted = new Set<string>();
  private readonly rolloutAttempts = new Map<string, number>();
  private readonly subscribing = new Map<string, Promise<void>>();
  private readonly contextByThread = new Map<string, ContextUsage>();
  // Threads whose context fill has come from a live event, which the (older)
  // rollout seed must never overwrite.
  private readonly liveContext = new Set<string>();
  // What the assistant said last, read back from history and kept current by
  // item/completed, so the phone's Done alert has something to say.
  private readonly lastAssistant = new Map<string, string>();
  private readonly pendingSettings = new Map<string, FollowUpSettings>();
  private readonly appliedSettings = new Map<string, FollowUpSettings>();
  private readonly nativeModes = new Map<string, string>();
  private readonly sandboxes = new Map<string, string>();
  private readonly steps = new Map<string, { currentFile?: string; step?: string }>();
  private readonly turnCompleted = new Set<CodexTurnCompletedListener>();
  private readonly questions = new Map<string, PendingCodexQuestion>();
  private readonly questionOpened = new Set<QuestionOpenedListener>();
  private readonly questionClosed = new Set<QuestionClosedListener>();
  private rolloutRetryTimer?: NodeJS.Timeout;

  constructor(private readonly options: CodexMonitorOptions) {
    this.now = options.now ?? Date.now;
    this.state = options.config.codex.enabled
      ? { enabled: true, available: false, reason: "connecting" }
      : { enabled: false, available: false, reason: "disabled" };
  }

  availability(): CodexAvailability {
    return { ...this.state };
  }

  /** The last known context fill of an attached thread, seeded from its rollout. */
  contextUsage(threadId: string): ContextUsage | undefined {
    const usage = this.contextByThread.get(threadId);
    return usage ? { ...usage } : undefined;
  }

  /** The latest of the live thread/tokenUsage/updated event and the rollout seed. */
  contextFill(threadId: string): ContextUsage | undefined {
    return this.contextUsage(threadId);
  }

  /** What Codex confirmed for the thread (thread/settings/updated) and what is still waiting for a turn. */
  settings(threadId: string): { applied: FollowUpSettings; pending: FollowUpSettings } {
    return {
      applied: { ...this.appliedSettings.get(threadId) },
      pending: { ...this.pendingSettings.get(threadId) },
    };
  }

  /**
   * Sends the wearer's text to an attached thread. An idle thread gets a
   * turn/start carrying any pending model and effort; a busy one (or one that
   * cannot be reached over the socket) gets `codex queue`, and the pending
   * settings wait for the next turn/start. A setting counts as applied only
   * once the daemon reports it in thread/settings/updated.
   */
  async followUp(
    threadId: string,
    text: string,
    msgId: string,
    pending?: FollowUpSettings,
  ): Promise<FollowUpResult> {
    if (!this.options.isAttached(threadId)) {
      throw new Error("Codex thread is not attached");
    }
    const merged = { ...this.pendingSettings.get(threadId), ...settingsOf(pending) };
    if (merged.model || merged.effort) {
      this.pendingSettings.set(threadId, merged);
    }
    const thread = this.threads.get(threadId);
    if (this.state.available && this.socket && thread && !threadIsBusy(thread)) {
      const params: TurnStartParams = {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        ...(merged.model ? { model: merged.model } : {}),
        ...(merged.effort ? { effort: merged.effort } : {}),
      };
      await this.request<TurnStartResponse>("turn/start", params as unknown as Record<string, unknown>);
      this.dropAppliedPending(threadId);
      this.options.logger.info("codex_followup", { msgId, route: "turn_start" });
      return "started";
    }
    await (this.options.runCodex ?? runCodexBinary)(codexQueueArgs(threadId, text));
    this.options.logger.info("codex_followup", { msgId, route: "queue" });
    return "queued";
  }

  async compact(threadId: string): Promise<void> {
    if (!this.options.isAttached(threadId)) {
      throw new Error("Codex thread is not attached");
    }
    await this.request("thread/compact/start", { threadId });
  }

  /**
   * Remembers a model and effort for the thread's next turn/start. Nothing is
   * sent now: the thread's settings change only when a turn carries them, and
   * they count as applied only once thread/settings/updated confirms it.
   */
  setPendingSettings(threadId: string, settings: FollowUpSettings): void {
    if (!this.options.isAttached(threadId)) {
      throw new Error("Codex thread is not attached");
    }
    const merged = { ...this.pendingSettings.get(threadId), ...settingsOf(settings) };
    if (merged.model || merged.effort) {
      this.pendingSettings.set(threadId, merged);
      this.publishThread(threadId);
    }
  }

  onTurnCompleted(listener: CodexTurnCompletedListener): () => void {
    this.turnCompleted.add(listener);
    return () => {
      this.turnCompleted.delete(listener);
    };
  }

  /** The model names a turn/start accepts, in the daemon's order. */
  async listModels(): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response: { data?: unknown; nextCursor?: unknown } = await this.request(
        "model/list",
        cursor ? { cursor } : {},
      );
      for (const entry of Array.isArray(response.data) ? response.data : []) {
        const record = asRecord(entry);
        const name = typeof record?.model === "string" ? record.model : record?.id;
        if (typeof name === "string" && name && !names.includes(name)) {
          names.push(name);
        }
      }
      if (typeof response.nextCursor !== "string" || !response.nextCursor) {
        break;
      }
      cursor = response.nextCursor;
    }
    return names;
  }

  /** Questions the wearer can answer. The alert pipeline turns each into an alert. */
  onQuestionOpened(listener: QuestionOpenedListener): () => void {
    this.questionOpened.add(listener);
    return () => {
      this.questionOpened.delete(listener);
    };
  }

  onQuestionClosed(listener: QuestionClosedListener): () => void {
    this.questionClosed.add(listener);
    return () => {
      this.questionClosed.delete(listener);
    };
  }

  /**
   * Answers a codex_async or codex_rpc question by its requestRef. An async
   * question was an ordinary message, so the answer is an ordinary follow-up;
   * a blocking one is a server request, replied to with the schema's shape.
   */
  async answerQuestion(
    requestRef: string,
    answers: QuestionAnswers,
    msgId: string,
  ): Promise<QuestionAnswerResult> {
    const pending = this.questions.get(requestRef);
    if (!pending || !this.options.isAttached(pending.threadId)) {
      return "unknown";
    }
    const closed = (reason: QuestionClosedReason): void =>
      this.emitQuestionClosed({
        sessionKey: sessionKeyOf("codex", pending.threadId),
        requestRef,
        reason,
        msgId,
      });
    if (pending.source === "codex_async") {
      const text = formatQuestionAnswers(pending.items, answers);
      if (!text) {
        return "unknown";
      }
      // Out of the table first: the turn/started this follow-up causes would
      // otherwise report the question as cancelled.
      this.questions.delete(requestRef);
      try {
        const result = await this.followUp(pending.threadId, text, msgId);
        clearTimeout(pending.timer);
        closed("answered");
        return result;
      } catch (error) {
        this.questions.set(requestRef, pending);
        throw error;
      }
    }
    const byId: Record<string, { answers: string[] }> = {};
    for (const item of pending.items) {
      const answer = answers[item.text];
      const id = pending.idByText?.get(item.text);
      if (answer !== undefined && id !== undefined) {
        byId[id] = { answers: Array.isArray(answer) ? [...answer] : [answer] };
      }
    }
    if (Object.keys(byId).length === 0 || pending.rpcId === undefined) {
      return "unknown";
    }
    if (!this.write({ id: pending.rpcId, result: { answers: byId } })) {
      throw new Error("Codex app-server is not connected");
    }
    this.questions.delete(requestRef);
    clearTimeout(pending.timer);
    closed("answered");
    return "replied";
  }

  /**
   * Start watching one attached thread: resume it on the daemon (which is what
   * subscribes this connection to its live stream) and seed its context fill.
   * Safe before the monitor is connected: the connect-time sync picks it up.
   */
  async subscribe(threadId: string): Promise<void> {
    if (!this.options.isAttached(threadId)) {
      return;
    }
    this.wanted.add(threadId);
    if (this.stopped || !this.socket) {
      return;
    }
    await this.resumeAndRefresh(threadId);
  }

  /**
   * Stop watching a thread. Anything it still has pending with the app-server
   * is deliberately left unanswered, so the user's own Codex TUI (which gets
   * the same request) stays the one that decides it.
   */
  unsubscribe(threadId: string): void {
    this.wanted.delete(threadId);
    this.rolloutAttempts.delete(threadId);
    this.contextByThread.delete(threadId);
    this.liveContext.delete(threadId);
    this.lastAssistant.delete(threadId);
    this.pendingSettings.delete(threadId);
    this.appliedSettings.delete(threadId);
    this.nativeModes.delete(threadId);
    this.sandboxes.delete(threadId);
    this.steps.delete(threadId);
    this.removeThread(threadId, "unsubscribed");
  }

  async readMessages(threadId: string, limit: number): Promise<SessionMessage[]> {
    if (!this.state.available || this.stopped || !this.socket || limit <= 0) {
      return [];
    }
    // The shared daemon resumes without turns, so its history is only reachable
    // by paging; an embedded server hydrates the thread itself.
    if (this.options.config.codex.useSharedDaemon) {
      const turns = await this.recentTurns(threadId, limit);
      if (turns) {
        return codexTurnsMessages(turns, limit, this.threads.get(threadId)?.updatedAt ?? this.now() / 1000);
      }
    }
    const response = await this.request<ThreadReadResponse>("thread/read", {
      threadId,
      includeTurns: true,
    });
    return codexThreadMessages(response.thread, limit);
  }

  async startThread(cwd: string, prompt: string): Promise<ThreadStartResult> {
    if (!this.state.available || this.stopped || !this.socket) {
      return { ok: false, error: "Codex is not available on this computer" };
    }
    try {
      const response = await this.request<ThreadStartResponse>(
        "thread/start",
        { cwd } satisfies ThreadStartParams,
      );
      // A thread born on this connection is already live here: thread/resume
      // would look for a rollout that does not exist yet and fail the spawn.
      // Register and publish directly; the thread/started notification runs
      // the tolerant adoption pass behind us.
      this.threads.set(response.thread.id, response.thread);
      this.trimThreads();
      if (this.threads.has(response.thread.id)) {
        this.publishThread(response.thread.id);
      }
      if (prompt) {
        await this.request<TurnStartResponse>(
          "turn/start",
          {
            threadId: response.thread.id,
            input: [{ type: "text", text: prompt, text_elements: [] }],
          } satisfies TurnStartParams,
        );
      }
      return { ok: true, sessionId: response.thread.id };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  start(): void {
    if (!this.options.config.codex.enabled || !this.stopped) {
      return;
    }
    this.stopped = false;
    this.scheduleConnect(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearSweep();
    this.clearRolloutRetry();
    this.wanted.clear();
    this.rolloutAttempts.clear();
    this.contextByThread.clear();
    this.liveContext.clear();
    this.lastAssistant.clear();
    this.pendingSettings.clear();
    this.appliedSettings.clear();
    this.closeQuestions("cancelled");
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.on("error", () => undefined);
      socket.terminate();
    }
    this.rejectPendingRpc(new Error("Codex monitor stopped"));
    this.resolveAllApprovals("codex_monitor_stopped");
    const child = this.ownedProcess;
    this.ownedProcess = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (this.options.terminate) {
        await this.options.terminate(child);
      } else {
        await this.terminateOwnedProcess(child);
      }
    }
    this.state = {
      enabled: this.options.config.codex.enabled,
      available: false,
      reason: this.options.config.codex.enabled ? "stopped" : "disabled",
    };
  }

  private scheduleConnect(delayMs: number): void {
    if (this.stopped || this.reconnectTimer || this.socket) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connectCycle();
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private async connectCycle(): Promise<void> {
    if (this.stopped || this.connecting || this.socket) {
      return;
    }
    this.connecting = true;
    try {
      let socket: WebSocket | undefined;
      try {
        socket = await this.openSocket();
        this.options.logger.info("codex_attached", {
          endpoint: this.endpoint(),
          owned: this.ownedProcess !== undefined,
        });
      } catch (attachError) {
        if (this.stopped) {
          return;
        }
        if (this.options.config.codex.useSharedDaemon) {
          // The shared daemon belongs to the user: never spawn, stop or replace it.
          this.reportUnavailable(
            `Codex shared daemon is not reachable: ${errorMessage(attachError)}`,
          );
          return;
        }
        if (!this.ownedProcess) {
          try {
            this.launchAppServer();
          } catch (launchError) {
            this.reportUnavailable(
              `Codex app-server could not start: ${errorMessage(launchError)}`,
            );
            return;
          }
        }
        socket = await this.waitForStartedServer().catch((startError) => {
          const detail = this.lastChildError
            ? `${errorMessage(startError)} (${this.lastChildError})`
            : errorMessage(startError);
          this.reportUnavailable(`Codex app-server is unavailable: ${detail}`);
          this.options.logger.info("codex_attach_failed", {
            reason: errorMessage(attachError),
          });
          return undefined;
        });
      }
      if (socket && !this.stopped) {
        await this.activate(socket);
      } else if (socket) {
        socket.on("error", () => undefined);
        socket.terminate();
      }
    } catch (error) {
      this.reportUnavailable(`Codex app-server connection failed: ${errorMessage(error)}`);
      (this.socket as WebSocket | undefined)?.terminate();
    } finally {
      this.connecting = false;
      if (!this.socket && !this.stopped) {
        this.scheduleConnect(this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
      }
    }
  }

  private launchAppServer(): void {
    const port = this.options.config.codex.port;
    const child = this.options.launch
      ? this.options.launch(port)
      : (() => {
          const spec = codexSpawnSpec(port);
          return spawn(spec.command, spec.args, spec.options);
        })();
    this.ownedProcess = child;
    this.lastChildError = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      this.lastChildError = `${this.lastChildError}${chunk.toString()}`.trim().slice(-2_000);
    });
    child.once("error", (error) => {
      this.lastChildError = error.message;
    });
    child.once("exit", (code, signal) => {
      if (this.ownedProcess !== child) {
        return;
      }
      this.ownedProcess = undefined;
      if (!this.stopped) {
        this.options.logger.info("codex_app_server_exited", { code, signal });
        if (!this.socket) {
          this.scheduleConnect(this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
        }
      }
    });
    this.options.logger.info("codex_app_server_started", {
      endpoint: this.endpoint(),
      pid: child.pid,
    });
  }

  private async terminateOwnedProcess(child: ChildProcess): Promise<void> {
    const spec = child.pid ? codexTerminateSpec(child.pid) : undefined;
    if (!spec) {
      child.kill();
      return;
    }
    const killer = spawn(spec.command, spec.args, spec.options);
    const succeeded = await new Promise<boolean>((resolve) => {
      killer.once("error", () => resolve(false));
      killer.once("exit", (code) => resolve(code === 0));
    });
    if (!succeeded && child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  private async waitForStartedServer(): Promise<WebSocket> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let lastError: unknown = new Error("startup timed out");
    while (!this.stopped && Date.now() < deadline) {
      try {
        return await this.openSocket();
      } catch (error) {
        lastError = error;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, START_RETRY_MS);
        timer.unref();
      });
    }
    throw lastError;
  }

  private endpoint(): string {
    const codex = this.options.config.codex;
    if (codex.useSharedDaemon) {
      return daemonEndpoint(resolveDaemonSocketPath(codex.socketPath));
    }
    return `ws://127.0.0.1:${this.options.config.codex.port}`;
  }

  private openSocket(): Promise<WebSocket> {
    const socket = new WebSocket(this.endpoint());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        // Terminating a still-connecting socket emits 'error'; without a
        // listener that brings the whole daemon down (seen live on a slow
        // app-server bind).
        socket.on("error", () => undefined);
        socket.terminate();
        reject(new Error("connection timed out"));
      }, this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
      timer.unref();
      const cleanup = () => {
        clearTimeout(timer);
        socket.off("open", onOpen);
        socket.off("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (error: Error) => {
        cleanup();
        socket.on("error", () => undefined);
        socket.terminate();
        reject(error);
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });
  }

  private async activate(socket: WebSocket): Promise<void> {
    this.socket = socket;
    socket.on("message", (data) => this.onMessage(socket, data.toString()));
    socket.on("error", (error) => {
      this.options.logger.info("codex_socket_error", { reason: error.message });
    });
    socket.once("close", () => this.onSocketClosed(socket));

    await this.request("initialize", {
      clientInfo: {
        name: "rokid-coder-agentd",
        title: "Rokid-Coder",
        version: CLIENT_VERSION,
      },
      capabilities: {
        experimentalApi: this.options.config.codex.useSharedDaemon,
        requestAttestation: false,
      },
    });
    this.write({ method: "initialized" });
    await this.synchronize();
    this.state = { enabled: true, available: true };
    this.options.logger.info("codex_available", {
      endpoint: this.endpoint(),
      sessions: this.threads.size,
    });
    this.armSweep();
  }

  private armSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    this.sweepTimer = setInterval(
      () => void this.sweepNewThreads(),
      this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref();
  }

  private clearSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.sweeping = false;
  }

  private async sweepNewThreads(): Promise<void> {
    if (this.stopped || this.sweeping || !this.socket) {
      return;
    }
    this.sweeping = true;
    try {
      const unseen = this.options.config.codex.useSharedDaemon
        ? await this.unseenSharedThreads()
        : (await this.listThreads())
            .map((thread) => thread.id)
            .filter((id) => !this.threads.has(id) && this.options.isAttached(id));
      if (unseen.length > 0) {
        this.options.logger.info("codex_sweep_adopted", { threads: unseen.length });
        await inBatches(unseen, (id) => this.resumeAndRefresh(id));
      }
    } catch (error) {
      this.options.logger.info("codex_sweep_failed", { reason: errorMessage(error) });
    } finally {
      this.sweeping = false;
    }
  }

  private onSocketClosed(socket: WebSocket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.clearSweep();
    this.clearRolloutRetry();
    this.subscribing.clear();
    // The live fill is only as fresh as the connection that carried it: whatever
    // happened while we were away is in the rollout, which the resubscribe re-reads.
    this.liveContext.clear();
    this.rejectPendingRpc(new Error("Codex app-server connection closed"));
    this.resolveAllApprovals("codex_connection_closed");
    this.closeQuestions("cancelled");
    if (!this.stopped) {
      this.reportUnavailable("Codex app-server connection closed; reconnecting.");
      this.scheduleConnect(this.options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
    }
  }

  private async synchronize(): Promise<void> {
    if (this.options.config.codex.useSharedDaemon) {
      await this.synchronizeShared();
      return;
    }
    const resumed = new Map<string, Thread>();
    const previouslyCaredFor = [...this.threads.keys()]
      .filter((threadId) => this.options.isAttached(threadId));

    // Resume first on every connection. thread/read refreshes data but does not
    // subscribe this connection to the live event stream.
    await inBatches(previouslyCaredFor, async (threadId) => {
      const thread = await this.tryResume(threadId);
      if (thread) {
        resumed.set(threadId, thread);
      }
    });

    const listed = (await this.listThreads())
      .filter((thread) => this.options.isAttached(thread.id));
    await inBatches(listed, async (thread) => {
      if (resumed.has(thread.id)) {
        return;
      }
      const resumedThread = await this.tryResume(thread.id);
      if (resumedThread) {
        resumed.set(thread.id, resumedThread);
      }
    });

    const refreshed = new Map<string, Thread>();
    await inBatches(listed, async (listedThread) => {
      try {
        const response = await this.request<ThreadReadResponse>("thread/read", {
          threadId: listedThread.id,
          includeTurns: true,
        });
        refreshed.set(listedThread.id, response.thread);
      } catch (error) {
        const fallback = resumed.get(listedThread.id) ?? listedThread;
        refreshed.set(listedThread.id, fallback);
        this.options.logger.info("codex_thread_refresh_failed", {
          threadId: listedThread.id,
          reason: errorMessage(error),
        });
      }
    });

    for (const threadId of this.threads.keys()) {
      if (!refreshed.has(threadId)) {
        this.removeThread(threadId, "authoritative_refresh");
      }
    }
    this.threads.clear();
    for (const thread of refreshed.values()) {
      this.threads.set(thread.id, thread);
      this.publishThread(thread.id);
    }
  }

  // Live threads come from thread/loaded/list, not the capped thread/list page,
  // and every attached thread we were told about is resumed explicitly, so an
  // old attached thread cannot fall off a listing.
  private async synchronizeShared(): Promise<void> {
    const candidates = [...new Set([
      ...await this.listLoadedThreads(),
      ...this.wanted,
      ...this.threads.keys(),
    ])].filter((id) => this.options.isAttached(id));

    const subscribed = new Set<string>();
    await inBatches(candidates, async (id) => {
      if (await this.subscribeShared(id)) {
        subscribed.add(id);
      }
    });
    for (const threadId of [...this.threads.keys()]) {
      if (!subscribed.has(threadId)) {
        this.removeThread(threadId, "authoritative_refresh");
      }
    }
  }

  private async unseenSharedThreads(): Promise<string[]> {
    const live = await this.listLoadedThreads();
    return [...new Set([...live, ...this.wanted])].filter(
      (id) =>
        !this.threads.has(id) &&
        !this.subscribing.has(id) &&
        this.options.isAttached(id),
    );
  }

  private async listLoadedThreads(): Promise<string[]> {
    const response = await this.request<{ data?: unknown }>("thread/loaded/list", {});
    return Array.isArray(response.data)
      ? response.data.filter((id): id is string => typeof id === "string")
      : [];
  }

  private subscribeShared(threadId: string): Promise<boolean> {
    const running = this.subscribing.get(threadId);
    if (running) {
      return running.then(() => this.threads.has(threadId));
    }
    const run = this.subscribeSharedOnce(threadId).finally(() => {
      this.subscribing.delete(threadId);
    });
    // The map's copy is only waited on; the caller of this call sees a failure.
    this.subscribing.set(threadId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async subscribeSharedOnce(threadId: string): Promise<boolean> {
    if (!this.options.isAttached(threadId)) {
      return false;
    }
    let resumed: Thread;
    try {
      const response = await this.request<ThreadResumeResponse>("thread/resume", {
        threadId,
        excludeTurns: true,
      });
      resumed = response.thread;
      this.rememberThreadModes(threadId, response);
    } catch (error) {
      if (/no rollout found/i.test(errorMessage(error))) {
        this.awaitFirstTurn(threadId);
      } else {
        this.options.logger.info("codex_thread_resume_failed", {
          threadId,
          reason: errorMessage(error),
        });
      }
      return false;
    }
    this.rolloutAttempts.delete(threadId);
    if (this.stopped || !this.options.isAttached(threadId)) {
      return false;
    }
    let thread = resumed;
    try {
      thread = (await this.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true,
      })).thread;
    } catch (error) {
      this.options.logger.info("codex_thread_refresh_failed", {
        threadId,
        reason: errorMessage(error),
      });
    }
    const recent = await this.recentTurns(threadId, DETAIL_MESSAGE_LIMIT);
    if (recent && recent.length > 0) {
      thread = { ...thread, turns: recent };
      this.rememberLastAssistant(threadId, recent, thread.updatedAt);
    }
    if (this.stopped || !this.options.isAttached(threadId)) {
      return false;
    }
    this.threads.set(threadId, thread);
    this.publishThread(threadId);
    if (thread.path) {
      const usage = await readLastTokenUsage(thread.path);
      if (usage && this.threads.has(threadId) && !this.liveContext.has(threadId)) {
        this.contextByThread.set(threadId, usage);
      }
    }
    this.options.logger.info("codex_thread_subscribed", { threadId });
    return true;
  }

  /**
   * The thread's recent history, oldest turn first: pages of thread/turns/list
   * are read newest first until `messageLimit` displayable messages are held or
   * the thread starts. Undefined when the server cannot list turns, so callers
   * keep what thread/read gave them.
   */
  private async recentTurns(threadId: string, messageLimit: number): Promise<Turn[] | undefined> {
    const newestFirst: Turn[] = [];
    let messages = 0;
    let cursor: string | null = null;
    try {
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const response: ThreadTurnsListResponse = await this.request<ThreadTurnsListResponse>(
          "thread/turns/list",
          {
            threadId,
            cursor,
            limit: HISTORY_PAGE_TURNS,
            sortDirection: "desc",
            itemsView: "full",
          },
        );
        for (const turn of response.data) {
          newestFirst.push(turn);
          messages += codexTurnMessages(turn, 0).length;
        }
        cursor = response.nextCursor;
        if (messages >= messageLimit || !cursor || response.data.length === 0) {
          break;
        }
      }
    } catch (error) {
      this.options.logger.info("codex_turns_list_failed", { threadId, reason: errorMessage(error) });
      return undefined;
    }
    return newestFirst.reverse();
  }

  private rememberLastAssistant(threadId: string, turns: Turn[], threadAt: number): void {
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const messages = codexTurnMessages(turns[index], threadAt * 1000);
      for (let at = messages.length - 1; at >= 0; at -= 1) {
        if (messages[at].role === "assistant") {
          this.lastAssistant.set(threadId, messages[at].text);
          return;
        }
      }
    }
  }

  /**
   * The thread's own approval policy and sandbox, as thread/resume reports
   * them. Read-only context for the phone; agentd never sets either.
   */
  private rememberThreadModes(threadId: string, response: unknown): void {
    const record = asRecord(response);
    const policy = record?.approvalPolicy;
    const sandbox = record?.sandbox;
    const label = (value: unknown): string | undefined =>
      typeof value === "string" && value
        ? value
        : typeof asRecord(value)?.type === "string" ? String(asRecord(value)?.type) : undefined;
    const nativeMode = label(policy);
    const sandboxLabel = label(sandbox);
    if (nativeMode) {
      this.nativeModes.set(threadId, nativeMode);
    }
    if (sandboxLabel) {
      this.sandboxes.set(threadId, sandboxLabel);
    }
  }

  private awaitFirstTurn(threadId: string): void {
    const attempts = (this.rolloutAttempts.get(threadId) ?? 0) + 1;
    this.rolloutAttempts.set(threadId, attempts);
    if (attempts > MAX_ROLLOUT_RETRIES) {
      // The sweep keeps looking; this just stops the fast loop.
      this.rolloutAttempts.delete(threadId);
      return;
    }
    if (this.rolloutRetryTimer || this.stopped) {
      return;
    }
    this.rolloutRetryTimer = setTimeout(() => {
      this.rolloutRetryTimer = undefined;
      const waiting = [...this.rolloutAttempts.keys()];
      void Promise.all(waiting.map((id) =>
        this.options.isAttached(id) && this.socket
          ? this.subscribeShared(id)
          : Promise.resolve(false),
      ));
    }, this.options.rolloutRetryMs ?? DEFAULT_ROLLOUT_RETRY_MS);
    this.rolloutRetryTimer.unref();
  }

  private clearRolloutRetry(): void {
    if (this.rolloutRetryTimer) {
      clearTimeout(this.rolloutRetryTimer);
      this.rolloutRetryTimer = undefined;
    }
    this.rolloutAttempts.clear();
  }

  private async listThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response: ThreadListResponse = await this.request<ThreadListResponse>("thread/list", {
        cursor,
        limit: Math.min(APP_SERVER_PAGE_SIZE, MAX_CODEX_SESSIONS - threads.length),
        sortKey: "recency_at",
        sortDirection: "desc",
        archived: false,
        // Omitting this filter means "interactive sources only", which silently
        // hides every `codex exec` run. Sub-agent workers stay out: they are
        // internal machinery, not sessions the wearer supervises.
        sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
      });
      for (const thread of response.data) {
        if (!seen.has(thread.id)) {
          seen.add(thread.id);
          threads.push(thread);
          if (threads.length === MAX_CODEX_SESSIONS) {
            break;
          }
        }
      }
      cursor = threads.length < MAX_CODEX_SESSIONS ? response.nextCursor : null;
    } while (cursor);
    return threads;
  }

  private async tryResume(threadId: string): Promise<Thread | undefined> {
    try {
      return await this.resumeThread(threadId);
    } catch (error) {
      this.options.logger.info("codex_thread_resume_failed", {
        threadId,
        reason: errorMessage(error),
      });
      return undefined;
    }
  }

  private async resumeThread(threadId: string): Promise<Thread> {
    const response = await this.request<ThreadResumeResponse>("thread/resume", { threadId });
    this.threads.set(threadId, response.thread);
    this.publishThread(threadId);
    return response.thread;
  }

  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pendingRpc.set(id, {
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      if (!this.write({ id, method, params })) {
        this.pendingRpc.delete(id);
        clearTimeout(timer);
        reject(new Error("Codex app-server is not connected"));
      }
    });
  }

  private onMessage(socket: WebSocket, raw: string): void {
    if (this.socket !== socket) {
      return;
    }
    let message: RpcMessage;
    try {
      const parsed: unknown = JSON.parse(raw);
      const record = asRecord(parsed);
      if (!record) {
        return;
      }
      message = record as RpcMessage;
    } catch {
      this.options.logger.warn("codex_message_invalid");
      return;
    }

    if (message.method && message.id !== undefined) {
      if (this.isApprovalMethod(message.method)) {
        void this.handleApproval(socket, message as ApprovalServerRequest);
      } else if (message.method === "item/tool/requestUserInput") {
        this.handleUserInputRequest(message.id, message.params);
      } else {
        this.options.logger.info("codex_server_request_ignored", {
          method: message.method,
        });
      }
      return;
    }
    if (message.method) {
      this.handleNotification(message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pendingRpc.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRpc.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private isApprovalMethod(method: string): method is ApprovalServerRequest["method"] {
    return method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval";
  }

  private async handleApproval(
    socket: WebSocket,
    request: ApprovalServerRequest,
  ): Promise<void> {
    const threadId = approvalThreadId(request.params);
    if (!threadId) {
      this.options.logger.warn("codex_approval_invalid", { method: request.method });
      return;
    }
    if (!this.options.isAttached(threadId)) {
      // Left unanswered on purpose: whoever owns the thread decides it locally.
      this.options.logger.info("codex_approval_not_attached", { method: request.method });
      return;
    }
    const key = rpcIdKey(request.id);
    if (this.approvalsByRpcId.has(key)) {
      return;
    }
    const phoneRequest = buildCodexApprovalRequest(request, threadId);
    this.approvalsByRpcId.set(key, {
      phoneRequestId: phoneRequest.requestId,
      rpcId: request.id,
      threadId,
      summary: phoneRequest.summary,
      createdAt: phoneRequest.createdAt,
    });
    this.publishThread(threadId);

    const decision = await this.options.approvals.requestDecision(phoneRequest);
    if (
      decision === undefined ||
      this.socket !== socket ||
      !this.approvalsByRpcId.has(key)
    ) {
      return;
    }
    this.approvalsByRpcId.delete(key);
    this.write({
      id: request.id,
      result: codexApprovalResponse(request, decision),
    });
    this.publishThread(threadId);
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asRecord(rawParams);
    if (!params) {
      return;
    }
    switch (method) {
      case "thread/started": {
        const thread = asRecord(params.thread) as Thread | undefined;
        if (!thread || typeof thread.id !== "string") {
          return;
        }
        void this.adoptStartedThread(thread);
        break;
      }
      case "thread/status/changed": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const status = asRecord(params.status) as Thread["status"] | undefined;
        const thread = threadId ? this.threads.get(threadId) : undefined;
        if (thread && status) {
          thread.status = status;
          thread.updatedAt = Math.max(thread.updatedAt, this.now() / 1000);
          if (status.type !== "systemError") {
            this.terminalErrors.delete(thread.id);
          }
          this.publishThread(thread.id);
        }
        break;
      }
      case "thread/name/updated": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const thread = threadId ? this.threads.get(threadId) : undefined;
        if (thread) {
          thread.name = typeof params.threadName === "string" ? params.threadName : null;
          this.publishThread(thread.id);
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const usage = asRecord(asRecord(params.tokenUsage)?.last);
        const used = usage?.totalTokens;
        const window = asRecord(params.tokenUsage)?.modelContextWindow;
        if (
          threadId &&
          this.options.isAttached(threadId) &&
          typeof used === "number" && Number.isFinite(used) &&
          typeof window === "number" && Number.isFinite(window) && window > 0
        ) {
          this.contextByThread.set(threadId, { used, window });
          this.liveContext.add(threadId);
          this.publishThread(threadId);
        }
        break;
      }
      case "thread/settings/updated": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (threadId && this.options.isAttached(threadId)) {
          this.appliedSettings.set(threadId, {
            ...this.appliedSettings.get(threadId),
            ...settingsOf(params.threadSettings),
          });
          this.dropAppliedPending(threadId);
          this.publishThread(threadId);
        }
        break;
      }
      case "item/started": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (threadId && this.options.isAttached(threadId)) {
          this.noteStep(threadId, asRecord(params.item));
        }
        break;
      }
      case "item/completed": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        if (threadId) {
          this.noteAssistantText(threadId, asRecord(params.item));
          this.handleCompletedItem(threadId, asRecord(params.item));
        }
        break;
      }
      case "turn/started":
      case "turn/completed": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const turn = asRecord(params.turn) as Turn | undefined;
        const thread = threadId ? this.threads.get(threadId) : undefined;
        if (thread && turn && typeof turn.id === "string") {
          const index = thread.turns.findIndex((existing) => existing.id === turn.id);
          if (index >= 0) {
            thread.turns[index] = turn;
          } else {
            thread.turns.push(turn);
          }
          thread.updatedAt = Math.max(thread.updatedAt, this.now() / 1000);
          if (method === "turn/started") {
            this.terminalErrors.delete(thread.id);
            // A new turn means the asked question was answered or moved past.
            this.closeQuestions("cancelled", thread.id, "codex_async");
          }
          if (method === "turn/completed") {
            this.steps.delete(thread.id);
          }
          this.publishThread(thread.id);
          if (method === "turn/completed" && this.options.isAttached(thread.id)) {
            this.emitTurnCompleted(thread.id, turn);
          }
        }
        break;
      }
      case "error": {
        const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
        const error = asRecord(params.error);
        if (threadId && params.willRetry === false) {
          const message =
            typeof error?.message === "string" ? error.message : "Codex turn failed.";
          this.terminalErrors.set(threadId, message);
          this.publishThread(threadId);
        }
        break;
      }
      case "serverRequest/resolved": {
        const requestId =
          typeof params.requestId === "string" || typeof params.requestId === "number"
            ? params.requestId
            : undefined;
        if (requestId !== undefined) {
          this.resolveApproval(requestId, "codex_request_resolved");
          this.resolveQuestionRequest(requestId);
        }
        break;
      }
      case "thread/archived":
      case "thread/deleted": {
        if (typeof params.threadId === "string") {
          this.removeThread(params.threadId, method);
          this.options.onThreadEnded?.(params.threadId);
        }
        break;
      }
      case "thread/closed": {
        const thread = typeof params.threadId === "string"
          ? this.threads.get(params.threadId)
          : undefined;
        if (typeof params.threadId === "string") {
          // Nothing it asked can be answered now; the thread stays listed.
          this.closeQuestions("cancelled", params.threadId);
          for (const approval of [...this.approvalsByRpcId.values()]) {
            if (approval.threadId === params.threadId) {
              this.resolveApproval(approval.rpcId, "thread_closed");
            }
          }
        }
        if (thread) {
          thread.status = { type: "idle" };
          this.publishThread(thread.id);
        }
        if (typeof params.threadId === "string") {
          this.options.onThreadEnded?.(params.threadId);
        }
        break;
      }
      case "thread/unarchived": {
        if (typeof params.threadId === "string") {
          void this.resumeAndRefresh(params.threadId);
        }
        break;
      }
      default:
        break;
    }
  }

  private emitTurnCompleted(threadId: string, turn: Turn): void {
    const event: CodexTurnCompleted = {
      sessionKey: sessionKeyOf("codex", threadId),
      threadId,
      status: turn.status,
      ...(turn.status === "failed" ? { error: turn.error?.message || "Codex turn failed." } : {}),
    };
    for (const listener of [...this.turnCompleted]) {
      try {
        listener(event);
      } catch {
        // One subscriber's bug must not stop the monitor.
      }
    }
  }

  /** What the thread is doing now: the file being changed or the command being run. */
  private noteStep(threadId: string, item: Record<string, unknown> | undefined): void {
    if (item?.type === "fileChange") {
      const change = asRecord(Array.isArray(item.changes) ? item.changes[0] : undefined);
      const file = typeof change?.path === "string" ? change.path : undefined;
      this.steps.set(threadId, {
        ...this.steps.get(threadId),
        currentFile: file ? truncateText(normalizeCwd(file), 200) : undefined,
      });
    } else if (item?.type === "commandExecution") {
      const command = typeof item.command === "string" ? item.command : undefined;
      this.steps.set(threadId, {
        ...this.steps.get(threadId),
        step: command ? truncateText(command, 120) : undefined,
      });
    } else {
      return;
    }
    this.publishThread(threadId);
  }

  /** Confirmed settings clear the pending ones they match; the rest keep waiting. */
  private dropAppliedPending(threadId: string): void {
    const pending = this.pendingSettings.get(threadId);
    if (!pending) {
      return;
    }
    const applied = this.appliedSettings.get(threadId);
    if (pending.model !== undefined && pending.model === applied?.model) {
      delete pending.model;
    }
    if (pending.effort !== undefined && pending.effort === applied?.effort) {
      delete pending.effort;
    }
    if (pending.model === undefined && pending.effort === undefined) {
      this.pendingSettings.delete(threadId);
    }
  }

  // 0.169 delivers request_user_input as a finished agentMessage whose
  // questions[] the TUI renders as text; the answer is an ordinary follow-up.
  private noteAssistantText(threadId: string, item: Record<string, unknown> | undefined): void {
    if (item?.type !== "agentMessage" || typeof item.text !== "string" || !item.text.trim()) {
      return;
    }
    if (this.options.isAttached(threadId) && this.threads.has(threadId)) {
      this.lastAssistant.set(threadId, item.text);
      this.publishThread(threadId);
    }
  }

  private handleCompletedItem(threadId: string, item: Record<string, unknown> | undefined): void {
    if (
      !item ||
      item.type !== "agentMessage" ||
      typeof item.id !== "string" ||
      !this.options.isAttached(threadId) ||
      this.questions.has(item.id)
    ) {
      return;
    }
    const items: QuestionPayload["items"] = [];
    for (const entry of Array.isArray(item.questions) ? item.questions : []) {
      const question = asRecord(entry);
      const text = typeof question?.title === "string" ? question.title : undefined;
      if (!text) {
        continue;
      }
      const options: QuestionPayload["items"][number]["options"] = [];
      for (const option of Array.isArray(question?.options) ? question.options : []) {
        const label = typeof option === "string" ? option : asRecord(option)?.label;
        if (typeof label === "string" && label) {
          const description = asRecord(option)?.description;
          options.push(
            typeof description === "string" && description
              ? { label, description }
              : { label },
          );
        }
      }
      items.push({ text, options, multiSelect: false, allowFreeText: true });
    }
    if (items.length === 0) {
      return;
    }
    this.openQuestion(threadId, item.id, { threadId, source: "codex_async", items });
  }

  // The blocking form: a server request that stays open until it is answered.
  private handleUserInputRequest(id: RequestId, rawParams: unknown): void {
    const params = asRecord(rawParams);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!threadId || !this.options.isAttached(threadId)) {
      // Left unanswered on purpose: whoever owns the thread decides it locally.
      this.options.logger.info("codex_question_not_attached", {});
      return;
    }
    const requestRef = String(id);
    if (this.questions.has(requestRef)) {
      return;
    }
    const items: QuestionPayload["items"] = [];
    const idByText = new Map<string, string>();
    for (const entry of Array.isArray(params?.questions) ? params.questions : []) {
      const question = asRecord(entry);
      if (question?.isSecret === true) {
        // A secret has no business on the glasses; the TUI asks for it.
        this.options.logger.info("codex_question_secret_left_local", {});
        return;
      }
      const text = typeof question?.question === "string" ? question.question : undefined;
      const questionId = typeof question?.id === "string" ? question.id : undefined;
      if (!text || !questionId || idByText.has(text)) {
        continue;
      }
      const options: QuestionPayload["items"][number]["options"] = [];
      for (const option of Array.isArray(question?.options) ? question.options : []) {
        const record = asRecord(option);
        if (typeof record?.label === "string") {
          options.push(
            typeof record.description === "string" && record.description
              ? { label: record.label, description: record.description }
              : { label: record.label },
          );
        }
      }
      idByText.set(text, questionId);
      items.push({
        text,
        options,
        multiSelect: false,
        allowFreeText: question?.isOther === true || options.length === 0,
      });
    }
    if (items.length === 0) {
      return;
    }
    this.openQuestion(threadId, requestRef, {
      threadId,
      source: "codex_rpc",
      items,
      rpcId: id,
      idByText,
    });
  }

  private openQuestion(threadId: string, requestRef: string, pending: PendingCodexQuestion): void {
    if (this.questions.size >= MAX_PENDING_QUESTIONS) {
      this.options.logger.info("codex_question_left_local", { reason: "pending_limit" });
      return;
    }
    pending.timer = setTimeout(() => {
      if (this.questions.get(requestRef) !== pending) {
        return;
      }
      this.questions.delete(requestRef);
      this.emitQuestionClosed({ sessionKey: sessionKeyOf("codex", threadId), requestRef, reason: "timeout" });
    }, this.options.approvals.timeoutMs);
    pending.timer.unref();
    this.questions.set(requestRef, pending);
    const event: QuestionOpened = {
      sessionKey: sessionKeyOf("codex", threadId),
      sessionId: threadId,
      question: { requestRef, source: pending.source, items: pending.items },
    };
    for (const listener of [...this.questionOpened]) {
      try {
        listener(event);
      } catch {
        // One subscriber's bug must not stop the monitor.
      }
    }
  }

  private emitQuestionClosed(event: QuestionClosed): void {
    for (const listener of [...this.questionClosed]) {
      try {
        listener(event);
      } catch {
        // As above.
      }
    }
  }

  /** Forgets questions without answering them: the TUI still owns whatever is pending. */
  private closeQuestions(
    reason: QuestionClosedReason,
    threadId?: string,
    source?: PendingCodexQuestion["source"],
  ): void {
    for (const [requestRef, pending] of [...this.questions]) {
      if ((threadId && pending.threadId !== threadId) || (source && pending.source !== source)) {
        continue;
      }
      this.questions.delete(requestRef);
      clearTimeout(pending.timer);
      this.emitQuestionClosed({
        sessionKey: sessionKeyOf("codex", pending.threadId),
        requestRef,
        reason,
      });
    }
  }

  private resolveQuestionRequest(id: RequestId): void {
    const requestRef = String(id);
    const pending = this.questions.get(requestRef);
    if (pending?.source === "codex_rpc") {
      this.questions.delete(requestRef);
      clearTimeout(pending.timer);
      // Answered elsewhere, which for a thread the user also has open is the TUI.
      this.emitQuestionClosed({
        sessionKey: sessionKeyOf("codex", pending.threadId),
        requestRef,
        reason: "laptop",
      });
    }
  }

  private async adoptStartedThread(thread: Thread): Promise<void> {
    if (!this.options.isAttached(thread.id)) {
      return;
    }
    this.threads.set(thread.id, thread);
    this.trimThreads();
    if (!this.threads.has(thread.id)) {
      return;
    }
    this.publishThread(thread.id);
    await this.resumeAndRefresh(thread.id);
  }

  private async resumeAndRefresh(threadId: string): Promise<void> {
    if (!this.options.isAttached(threadId)) {
      return;
    }
    if (this.options.config.codex.useSharedDaemon) {
      await this.subscribeShared(threadId);
      return;
    }
    const resumed = await this.tryResume(threadId);
    if (!resumed || this.stopped) {
      return;
    }
    try {
      const response = await this.request<ThreadReadResponse>("thread/read", {
        threadId,
        includeTurns: true,
      });
      this.threads.set(threadId, response.thread);
      this.trimThreads();
      this.publishThread(threadId);
    } catch (error) {
      this.options.logger.info("codex_thread_refresh_failed", {
        threadId,
        reason: errorMessage(error),
      });
    }
  }

  private trimThreads(): void {
    const sorted = [...this.threads.values()]
      .sort((left, right) => threadActivityAt(right) - threadActivityAt(left));
    for (const thread of sorted.slice(MAX_CODEX_SESSIONS)) {
      this.removeThread(thread.id, "provider_cap");
    }
  }

  private publishThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || !this.options.isAttached(threadId)) {
      return;
    }
    const pending = [...this.approvalsByRpcId.values()]
      .filter((approval) => approval.threadId === threadId)
      .sort((left, right) => left.createdAt - right.createdAt)[0];
    const base = normalizeCodexThread(
      thread,
      this.options.config,
      pending,
      this.terminalErrors.get(threadId),
    );
    const heading = truncateText(thread.name?.trim() || thread.preview.trim(), 120);
    const pendingSettings = this.pendingSettings.get(threadId);
    const context = this.contextByThread.get(threadId);
    const lastAssistantText = this.lastAssistant.get(threadId);
    this.options.store.upsertProviderSession({
      ...base,
      ...(lastAssistantText ? { lastAssistantText: truncateText(lastAssistantText, 140) } : {}),
      ...(heading ? { heading } : {}),
      ...this.steps.get(threadId),
      ...(context ? { context: { ...context } } : {}),
      ...(this.nativeModes.has(threadId) ? { nativeMode: this.nativeModes.get(threadId) } : {}),
      ...(this.sandboxes.has(threadId) ? { sandbox: this.sandboxes.get(threadId) } : {}),
      ...(pendingSettings ? { pendingSettings: { ...pendingSettings } } : {}),
    });
  }

  private removeThread(threadId: string, reason: string): void {
    this.threads.delete(threadId);
    this.terminalErrors.delete(threadId);
    this.closeQuestions("cancelled", threadId);
    for (const approval of [...this.approvalsByRpcId.values()]) {
      if (approval.threadId === threadId) {
        this.resolveApproval(approval.rpcId, reason);
      }
    }
    if (this.options.store.get(threadId)?.provider === "codex") {
      this.options.store.removeSession(threadId);
    }
  }

  private resolveApproval(id: RequestId, reason: string): void {
    const key = rpcIdKey(id);
    const pending = this.approvalsByRpcId.get(key);
    if (!pending) {
      return;
    }
    this.approvalsByRpcId.delete(key);
    this.options.approvals.resolveRequest(pending.phoneRequestId, reason);
    this.publishThread(pending.threadId);
  }

  private resolveAllApprovals(reason: string): void {
    for (const pending of [...this.approvalsByRpcId.values()]) {
      this.options.approvals.resolveRequest(pending.phoneRequestId, reason);
    }
    this.approvalsByRpcId.clear();
    for (const threadId of this.threads.keys()) {
      this.publishThread(threadId);
    }
  }

  private rejectPendingRpc(error: Error): void {
    for (const pending of this.pendingRpc.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRpc.clear();
  }

  private write(message: RpcMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private reportUnavailable(reason: string): void {
    if (this.state.available || this.state.reason !== reason) {
      this.options.logger.info("codex_unavailable", { reason });
    }
    this.state = { enabled: true, available: false, reason };
  }
}
