import { randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "./approval-policy";
import { DEFAULT_WAIT_LIMIT_SEC } from "./config";
import { sessionKeyOf, type SessionKey } from "./protocol-v2";
import { truncateText } from "./session-store";
import type { AgentProvider, HookPayload, Logger } from "./types";

export const MAX_PENDING_APPROVALS = 32;
const MAX_TIMER_MS = 2_147_000_000;

export type ApprovalDecision = "allow" | "deny";
export type ApprovalOutcome = ApprovalDecision | "timeout" | "local";

/**
 * What a request is asking to do, as the provider's own protocol says, never as
 * a display label. The temporary approval modes decide on this alone.
 */
export type ApprovalKind = "command" | "fileChange" | "tool" | "interactive";

export interface ApprovalRequest {
  type: "approval_request";
  v: 1;
  requestId: string;
  sessionId: string;
  provider: AgentProvider;
  sessionKey: SessionKey;
  approvalKind: ApprovalKind;
  tool: string;
  summary: string;
  detail: string;
  createdAt: number;
}

const CLAUDE_FILE_CHANGE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Tools whose permission prompt is the user answering something, not granting
// something: an allow with no `updatedInput` answers nothing and approves the
// plan unread. No temporary mode may stand in for the person.
const CLAUDE_INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

export function claudeApprovalKind(tool: string): ApprovalKind {
  if (CLAUDE_INTERACTIVE_TOOLS.has(tool)) {
    return "interactive";
  }
  return CLAUDE_FILE_CHANGE_TOOLS.has(tool) ? "fileChange" : "tool";
}

/** The phone-facing v1 frame: policy-only fields stay inside agentd. */
function toWireFrame(request: ApprovalRequest): ApprovalRequest {
  const {
    provider: _provider,
    sessionKey: _sessionKey,
    approvalKind: _approvalKind,
    ...wire
  } = request;
  return wire as ApprovalRequest;
}

export interface ApprovalTransport {
  readonly connected: boolean;
  sendApprovalRequest(request: ApprovalRequest): boolean;
  sendApprovalResolved(requestId: string, outcome: ApprovalOutcome): boolean;
}

export type HookResponse = Record<string, unknown>;

interface PendingApproval {
  request: ApprovalRequest;
  timer: NodeJS.Timeout;
  resolve: (decision: ApprovalDecision | undefined) => void;
  /** Stops listening for the hook's connection to drop. */
  release?: () => void;
}

/**
 * What the phone-facing alert pipeline hears. `onPending` fires once a request
 * is on the wire (never for one the policy or a missing phone settled first).
 * `onSettled` fires when it ends: `allow`/`deny` is the phone's answer, `timeout`
 * is nobody answering, `local` is anything else, with `reason` saying what
 * (`phone_disconnected`, `session_end`, ...).
 */
export interface ApprovalObserver {
  onPending(request: ApprovalRequest): void;
  onSettled(request: ApprovalRequest, outcome: ApprovalOutcome, reason?: string): void;
}

export interface ApprovalManagerOptions {
  transport: ApprovalTransport;
  observer?: ApprovalObserver;
  logger: Logger;
  /** How long a request waits for the phone: the wait limit Y, which the phone's settings can change. */
  timeoutMs?: number;
  now?: () => number;
  requestId?: () => string;
  maxPending?: number;
  policy?: ApprovalPolicy;
}

const DETAIL_FIELDS = [
  "command",
  "file_path",
  "path",
  "url",
  "query",
  "pattern",
  "prompt",
  "description",
  "old_string",
  "new_string",
  "content",
  "notebook_path",
  "cell_id",
] as const;

function usefulValue(value: unknown, limit: number): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, limit) : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const primitives = value
      .filter((entry) => ["string", "number", "boolean"].includes(typeof entry))
      .map(String)
      .join(", ");
    return primitives ? primitives.slice(0, limit) : undefined;
  }
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, limit);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function argumentFields(input: Record<string, unknown> | undefined): string[] {
  if (!input) {
    return [];
  }
  return [
    ...DETAIL_FIELDS,
    ...Object.keys(input).filter(
      (field) => !DETAIL_FIELDS.includes(field as typeof DETAIL_FIELDS[number]),
    ),
  ];
}

export function describeTool(payload: HookPayload): {
  tool?: string;
  summary: string;
  detail: string;
} {
  const tool = typeof payload.tool_name === "string" && payload.tool_name.trim()
    ? payload.tool_name.trim().slice(0, 120)
    : undefined;
  const input =
    payload.tool_input && typeof payload.tool_input === "object" && !Array.isArray(payload.tool_input)
      ? payload.tool_input as Record<string, unknown>
      : undefined;

  const command = usefulValue(input?.command, 400);
  const description = usefulValue(input?.description, 120);
  const fields = argumentFields(input);
  const firstArgument = fields
    .filter((field) => field !== "description")
    .map((field) => usefulValue(input?.[field], 120))
    .find((value) => value !== undefined);
  const summary = truncateText(
    description ?? firstArgument ?? (tool ? `${tool} request` : "Tool permission request"),
    120,
  );

  if (command) {
    return { tool, summary, detail: command.slice(0, 400) };
  }

  const parts: string[] = [];
  for (const field of fields) {
    if (field === "description") {
      continue;
    }
    const value = usefulValue(input?.[field], 180);
    if (!value) {
      continue;
    }
    const part = `${field}: ${value}`;
    const separatorLength = parts.length === 0 ? 0 : 2;
    const remaining = 400 - parts.join("; ").length - separatorLength;
    if (remaining <= 0) {
      break;
    }
    parts.push(part.slice(0, remaining));
    if (parts.join("; ").length >= 400) {
      break;
    }
  }

  return {
    tool,
    summary,
    detail: (parts.join("; ") || description || summary).slice(0, 400),
  };
}

/**
 * PermissionRequest's contract, not PreToolUse's: the field is `decision` and
 * an exit code cannot deny, so the verdict has to travel in the JSON. The event
 * matters as much as the shape — PreToolUse fires for every tool call a session
 * makes, including the ones Claude would never have stopped to ask about, so
 * holding on it turned an ordinary working session into hundreds of questions
 * on the wearer's glasses. PermissionRequest fires only when a decision is
 * genuinely needed.
 */
function decisionResponse(decision: ApprovalDecision): HookResponse {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: decision,
        ...(decision === "deny"
          ? { message: "Denied by the wearer in Nexus Agents." }
          : {}),
      },
    },
  };
}

function validTimeout(ms: number | undefined): number | undefined {
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_TIMER_MS) : undefined;
}

export class ApprovalManager {
  private readonly pending = new Map<string, PendingApproval>();
  private waitLimitMs: number;
  private readonly now: () => number;
  private readonly makeRequestId: () => string;
  private readonly maxPending: number;

  constructor(private readonly options: ApprovalManagerOptions) {
    this.waitLimitMs = validTimeout(options.timeoutMs) ?? DEFAULT_WAIT_LIMIT_SEC * 1000;
    this.now = options.now ?? Date.now;
    this.makeRequestId = options.requestId ?? randomUUID;
    this.maxPending = options.maxPending ?? MAX_PENDING_APPROVALS;
  }

  get size(): number {
    return this.pending.size;
  }

  /** The lifetime a request made now gets. */
  get timeoutMs(): number {
    return this.waitLimitMs;
  }

  /** Applies to requests made from now on; one already waiting keeps the lifetime it started with. */
  setTimeoutMs(ms: number): void {
    this.waitLimitMs = validTimeout(ms) ?? this.waitLimitMs;
  }

  /**
   * `closed` is the hook's own connection: it drops when Claude gives up on the
   * hook, which happens once the person answers at the laptop, so it ends the
   * request as answered locally.
   */
  request(payload: HookPayload, closed?: AbortSignal): Promise<HookResponse> {
    const sessionId =
      typeof payload.session_id === "string" && payload.session_id.length > 0
        ? payload.session_id
        : undefined;
    const description = describeTool(payload);
    if (!sessionId || !description.tool) {
      this.options.logger.warn("approval_invalid_hook", {
        hasSessionId: sessionId !== undefined,
        hasTool: description.tool !== undefined,
      });
      return Promise.resolve({});
    }
    const request: ApprovalRequest = {
      type: "approval_request",
      v: 1,
      requestId: this.makeRequestId(),
      sessionId,
      provider: "claude",
      sessionKey: sessionKeyOf("claude", sessionId),
      approvalKind: claudeApprovalKind(description.tool),
      tool: description.tool,
      summary: description.summary,
      detail: description.detail,
      createdAt: this.now(),
    };

    return this.requestDecision(request, closed).then((decision) =>
      decision ? decisionResponse(decision) : {},
    );
  }

  /**
   * Shares the phone approval lifecycle with providers whose native response
   * contract is not Claude's PreToolUse hook contract.
   */
  requestDecision(request: ApprovalRequest, closed?: AbortSignal): Promise<ApprovalDecision | undefined> {
    // Ahead of every phone check: a session on approve-all or accept-edits is
    // answered here, whether or not a phone is connected to ask.
    if (this.options.policy?.decide(request.sessionKey, request) === "allow") {
      this.options.logger.info("approval_policy_allowed", {
        requestId: request.requestId,
        sessionKey: request.sessionKey.slice(0, 24),
        approvalKind: request.approvalKind,
      });
      return Promise.resolve("allow");
    }
    if (closed?.aborted) {
      this.options.logger.info("approval_local", { reason: "hook_closed" });
      return Promise.resolve(undefined);
    }
    if (!this.options.transport.connected) {
      this.options.logger.info("approval_local", { reason: "phone_not_connected" });
      return Promise.resolve(undefined);
    }
    if (this.pending.size >= this.maxPending) {
      this.options.logger.warn("approval_local", { reason: "pending_limit" });
      return Promise.resolve(undefined);
    }
    if (!request.requestId || this.pending.has(request.requestId)) {
      this.options.logger.warn("approval_local", {
        requestId: request.requestId,
        reason: "duplicate_request",
      });
      return Promise.resolve(undefined);
    }

    return new Promise<ApprovalDecision | undefined>((resolve) => {
      const timer = setTimeout(() => this.onTimeout(request.requestId), this.waitLimitMs);
      timer.unref();
      const pending: PendingApproval = { request, timer, resolve };
      if (closed) {
        const onAbort = () => this.resolveLocal(request.requestId, "hook_closed", true);
        closed.addEventListener("abort", onAbort, { once: true });
        pending.release = () => closed.removeEventListener("abort", onAbort);
      }
      this.pending.set(request.requestId, pending);
      if (!this.options.transport.sendApprovalRequest(toWireFrame(request))) {
        this.resolveLocal(request.requestId, "send_failed", false);
        return;
      }
      this.options.logger.info("approval_requested", {
        requestId: request.requestId,
        sessionId: request.sessionId.slice(0, 16),
        tool: request.tool,
      });
      this.observe(() => this.options.observer?.onPending(request));
    });
  }

  /** False when nothing is waiting on that request any more (answered, expired or gone). */
  handleDecision(requestId: string, decision: ApprovalDecision): boolean {
    const pending = this.take(requestId);
    if (!pending) {
      return false;
    }
    pending.resolve(decision);
    this.options.logger.info("approval_decided", {
      requestId,
      decision,
    });
    this.observe(() => this.options.observer?.onSettled(pending.request, decision));
    return true;
  }

  onLinkConnected(): void {
    for (const [requestId, pending] of this.pending) {
      if (!this.options.transport.sendApprovalRequest(toWireFrame(pending.request))) {
        this.resolveLocal(requestId, "resend_failed", false);
      }
    }
  }

  onLinkDisconnected(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.resolveLocal(requestId, "phone_disconnected", false);
    }
  }

  resolveSession(sessionId: string): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.request.sessionId === sessionId) {
        this.resolveLocal(requestId, "session_end", true);
      }
    }
  }

  resolveRequest(requestId: string, reason = "upstream_resolved"): void {
    this.resolveLocal(requestId, reason, true);
  }

  dispose(): void {
    for (const requestId of [...this.pending.keys()]) {
      this.resolveLocal(requestId, "daemon_stop", true);
    }
  }

  private onTimeout(requestId: string): void {
    const pending = this.take(requestId);
    if (!pending) {
      return;
    }
    if (this.options.transport.connected) {
      this.options.transport.sendApprovalResolved(requestId, "timeout");
    }
    pending.resolve(undefined);
    this.options.logger.info("approval_timeout", { requestId });
    this.observe(() => this.options.observer?.onSettled(pending.request, "timeout"));
  }

  private resolveLocal(requestId: string, reason: string, notifyPhone: boolean): void {
    const pending = this.take(requestId);
    if (!pending) {
      return;
    }
    if (notifyPhone && this.options.transport.connected) {
      this.options.transport.sendApprovalResolved(requestId, "local");
    }
    pending.resolve(undefined);
    this.options.logger.info("approval_local", { requestId, reason });
    this.observe(() => this.options.observer?.onSettled(pending.request, "local", reason));
  }

  /** An observer's bug must never strand the hook that is waiting on the phone. */
  private observe(notify: () => void): void {
    try {
      notify();
    } catch (error) {
      this.options.logger.warn("approval_observer_failed", {
        reason: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  private take(requestId: string): PendingApproval | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return undefined;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.release?.();
    return pending;
  }
}
