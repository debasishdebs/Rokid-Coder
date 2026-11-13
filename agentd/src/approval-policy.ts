import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ApprovalRequest } from "./approval-manager";
import type { DefaultMode, SessionKey, TempMode } from "./protocol-v2";
import type { AgentProvider, Logger } from "./types";

export type { TempMode } from "./protocol-v2";

export interface ResetNotice {
  sessionKey: string;
  from: TempMode;
  reason: "session_ended" | "helper_restarted" | "revoked";
}

export type SetModeResult = { ok: true } | { ok: false; error: "confirm_required" };
export type SetDefaultsResult = { ok: true } | { ok: false; error: "invalid_default" };

export interface ApprovalPolicyOptions {
  /**
   * Where approve-all sessions are recorded so the next start can say they were
   * reset. The record never restores a mode: every start begins at "ask".
   */
  file?: string;
  logger?: Logger;
  now?: () => number;
}

interface PersistedSession {
  sessionKey: string;
  since: number;
}

const FILE_VERSION = 1;

function isDefaultMode(value: unknown): value is DefaultMode {
  return value === "ask" || value === "acceptEdits";
}

/**
 * Per-session temporary approval modes. Everything here lives in agentd's
 * memory: approve-all is never handed to Codex as a native approvalPolicy, and
 * never survives the session or the process. The only thing written to disk is
 * which sessions had approve-all, and only so a restart can report the reset.
 */
export class ApprovalPolicy {
  private readonly modes = new Map<string, TempMode>();
  private readonly approveAllSince = new Map<string, number>();
  private readonly defaults: Record<AgentProvider, DefaultMode> = { claude: "ask", codex: "ask" };
  // Prior-run approve-all sessions whose reset has not been reported yet. They
  // stay in the file until taken, so a second restart cannot swallow them.
  private unreported: PersistedSession[] = [];
  private readonly file?: string;
  private readonly logger?: Logger;
  private readonly now: () => number;

  constructor(options: ApprovalPolicyOptions = {}) {
    this.file = options.file;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.unreported = this.load();
  }

  get(sessionKey: string): TempMode {
    return this.modes.get(sessionKey) ?? "ask";
  }

  set(sessionKey: string, mode: TempMode, confirmed: boolean): SetModeResult {
    if (mode === "approveAll" && confirmed !== true) {
      return { ok: false, error: "confirm_required" };
    }
    const previous = this.modes.get(sessionKey);
    const previousSince = this.approveAllSince.get(sessionKey);
    this.apply(sessionKey, mode);
    if (mode !== "approveAll") {
      // A downgrade must stick even if its record cannot be rewritten; the worst
      // case is a spurious restart notice.
      this.persistQuietly();
      return { ok: true };
    }
    try {
      this.persist();
    } catch (error) {
      // A grant whose reset could not be reported after a restart is refused.
      if (previous === undefined) {
        this.modes.delete(sessionKey);
      } else {
        this.modes.set(sessionKey, previous);
      }
      if (previousSince === undefined) {
        this.approveAllSince.delete(sessionKey);
      } else {
        this.approveAllSince.set(sessionKey, previousSince);
      }
      throw error;
    }
    return { ok: true };
  }

  /**
   * Sets the starting mode for sessions attached from now on. Only ask and
   * acceptEdits qualify: approve-all always needs a live confirm.
   */
  setDefaults(defaults: Partial<Record<AgentProvider, unknown>>): SetDefaultsResult {
    const next: Partial<Record<AgentProvider, DefaultMode>> = {};
    for (const provider of ["claude", "codex"] as const) {
      const value = defaults[provider];
      if (value === undefined) {
        continue;
      }
      if (!isDefaultMode(value)) {
        return { ok: false, error: "invalid_default" };
      }
      next[provider] = value;
    }
    Object.assign(this.defaults, next);
    return { ok: true };
  }

  /** Gives a newly attached session its provider's default, unless it already has a mode. */
  applyDefault(sessionKey: SessionKey): void {
    if (this.modes.has(sessionKey)) {
      return;
    }
    const provider: AgentProvider = sessionKey.startsWith("codex:") ? "codex" : "claude";
    const mode = this.defaults[provider];
    if (mode !== "ask") {
      this.modes.set(sessionKey, mode);
    }
  }

  /** Uses only the approval kind and the session's mode. */
  decide(
    sessionKey: string,
    request: Pick<ApprovalRequest, "approvalKind">,
  ): "allow" | undefined {
    // Even approve-all: these ask the person a question or for a plan sign-off.
    if (request.approvalKind === "interactive") {
      return undefined;
    }
    switch (this.modes.get(sessionKey)) {
      case "approveAll":
        return "allow";
      case "acceptEdits":
        return request.approvalKind === "fileChange" ? "allow" : undefined;
      default:
        return undefined;
    }
  }

  endSession(sessionKey: string): ResetNotice | undefined {
    return this.reset(sessionKey, "session_ended", true);
  }

  revokeAll(): ResetNotice[] {
    const notices: ResetNotice[] = [];
    for (const sessionKey of [...this.modes.keys()]) {
      const notice = this.reset(sessionKey, "revoked", false);
      if (notice) {
        notices.push(notice);
      }
    }
    this.persistQuietly();
    return notices;
  }

  /** Approve-all sessions the previous run left behind; reported once. */
  takeRestartNotices(): ResetNotice[] {
    if (this.unreported.length === 0) {
      return [];
    }
    const notices = this.unreported.map((entry): ResetNotice => ({
      sessionKey: entry.sessionKey,
      from: "approveAll",
      reason: "helper_restarted",
    }));
    this.unreported = [];
    this.persistQuietly();
    return notices;
  }

  private apply(sessionKey: string, mode: TempMode): void {
    if (mode === "ask") {
      this.modes.delete(sessionKey);
    } else {
      this.modes.set(sessionKey, mode);
    }
    if (mode === "approveAll") {
      if (!this.approveAllSince.has(sessionKey)) {
        this.approveAllSince.set(sessionKey, this.now());
      }
    } else {
      this.approveAllSince.delete(sessionKey);
    }
  }

  private reset(
    sessionKey: string,
    reason: ResetNotice["reason"],
    persist: boolean,
  ): ResetNotice | undefined {
    const from = this.modes.get(sessionKey);
    if (from === undefined) {
      return undefined;
    }
    this.modes.delete(sessionKey);
    this.approveAllSince.delete(sessionKey);
    if (persist) {
      this.persistQuietly();
    }
    return { sessionKey, from, reason };
  }

  private load(): PersistedSession[] {
    if (!this.file) {
      return [];
    }
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("approve_all_state_unreadable", { reason: "read_failed" });
      }
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; sessions?: unknown };
      if (parsed.version !== FILE_VERSION || !Array.isArray(parsed.sessions)) {
        throw new Error("unrecognised shape");
      }
      const seen = new Set<string>();
      const sessions: PersistedSession[] = [];
      for (const entry of parsed.sessions as unknown[]) {
        const record = entry as Record<string, unknown> | null;
        if (
          record &&
          typeof record.sessionKey === "string" &&
          record.sessionKey.length > 0 &&
          !seen.has(record.sessionKey)
        ) {
          seen.add(record.sessionKey);
          sessions.push({
            sessionKey: record.sessionKey,
            since: typeof record.since === "number" ? record.since : 0,
          });
        }
      }
      return sessions;
    } catch {
      // Losing a notice is the worst a bad file can do; it can never grant anything.
      this.logger?.warn("approve_all_state_unreadable", { reason: "parse_failed" });
      return [];
    }
  }

  private persist(): void {
    if (!this.file) {
      return;
    }
    const sessions: PersistedSession[] = [
      ...this.unreported,
      ...[...this.approveAllSince].map(([sessionKey, since]) => ({ sessionKey, since })),
    ];
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, sessions }), { mode: 0o600 });
    renameSync(temp, this.file);
  }

  private persistQuietly(): void {
    try {
      this.persist();
    } catch {
      // Ending a grant must never fail because its record could not be rewritten;
      // the worst case is a spurious restart notice.
      this.logger?.warn("approve_all_state_unwritable", {});
    }
  }
}
