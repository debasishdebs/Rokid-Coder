import { randomUUID } from "node:crypto";
import type { FollowupState, SessionKey } from "../protocol-v2";
import type { CommandResult, SendError, TypeCommand, WriteCheckPhase } from "./launcher-hub";
import { bgReplyText } from "./paste-text";

/**
 * Where a launcher-bound Claude session stands, for typing into it (R55):
 * `held` while its Stop hook waits for the glasses, `ready` when agentd's own
 * read of Claude's sessions file shows it idle and nothing else is in the way,
 * `busy` otherwise. It is derived from Claude's file, never from hooks alone,
 * so a missed hook cannot leave a session stuck in either direction.
 */
export type LaunchState = "busy" | "held" | "ready";

/**
 * An opt-in exception to "ready comes from Claude's file alone", for sessions
 * with a running background subagent: Claude's file stays `busy` for as long as
 * the subagent lives, though the main prompt is free. See `bgPicture` for what
 * it takes. A main-thread `Stop` older than this is no evidence.
 */
export const BACKGROUND_STOP_FRESH_MS = 6 * 60 * 60_000;

/**
 * The permission modes (the `permission_mode` of a hook payload; the official
 * reference names `default`, `plan`, `acceptEdits`, `auto`, `dontAsk` and
 * `bypassPermissions`) in which a background reply may be typed. A reply typed
 * while Claude works only queues, and a finishing subagent never writes into
 * the prompt box; the one hazard is a modal dialog taking the keys.
 * - `auto`, `bypassPermissions`: no dialog opens (AUTO_APPROVING_MODES);
 * - `acceptEdits`, `dontAsk`, `default`: a dialog may open, so the evidence
 *   gains one guard, no approval pending of any origin (see `bgPicture`), and
 *   the screen checks around the paste stand between a dialog and the Enter;
 * - `plan`: refused, its plan-approval dialog is a modal that takes any keys;
 * - anything unknown or missing: refused.
 */
export const BG_ALLOWED_MODES: ReadonlySet<string> = new Set([
  "auto",
  "bypassPermissions",
  "acceptEdits",
  "dontAsk",
  "default",
]);
/** The modes in which Claude never stops to ask; every other allowed mode takes the extra approval guard. */
export const AUTO_APPROVING_MODES: ReadonlySet<string> = new Set(["auto", "bypassPermissions"]);

/** The brief's windows. */
export const READY_WAIT_MS = 60_000;
export const COMPACT_LIMIT_MS = 180_000;
export const READY_POLL_MS = 250;
/**
 * How long after the launcher's own readiness wait a model or text command may
 * still take: the `/model` dialog (5 s), its result (10 s) and a recovery (5 s),
 * with room to spare. Past it the launcher is not answering, and the command is
 * cancelled.
 */
const RESULT_SLACK_MS = 30_000;
/** How long after the launcher's ok a background reply waits to see Claude take its prompt. */
const BG_ACCEPT_MS = 15_000;
/** How often bound sessions are looked at when nothing is waiting on them. */
const WATCH_MS = 500;

export const CLAUDE_MODELS: readonly string[] = ["opus", "sonnet", "haiku"];

export interface SessionRead {
  status: string;
  statusUpdatedAt: number;
  /** When given, it must be the bound session's own id. */
  sessionId?: string;
}

/** What SessionStates reads besides Claude's file. */
export interface StateSources {
  /** The live binding, or undefined when no launcher holds the session. */
  binding(key: SessionKey): { gen: number; claudePid?: number; uncertain: boolean } | undefined;
  /** The session's Stop hook is held for the glasses. */
  held(key: SessionKey): boolean;
  /** An approval or a question is waiting on the session. */
  asking(key: SessionKey): boolean;
  /** Ends the binding's uncertainty; the launcher is told. */
  clearUncertain(key: SessionKey): void;
  /** Subagents the session store counts as running (SubagentStart seen, SubagentStop not yet). Absent: none. */
  subagents?(key: SessionKey): number;
  /**
   * An approval of any origin (a subagent's included) is pending on the
   * session. Outside the auto-approving modes a background reply needs this to
   * exist and to say no; absent, such a mode is refused.
   */
  approvalPending?(key: SessionKey): boolean;
}

interface CompactWatch {
  gen: number;
  /** The launcher has typed it: a compact before that is the laptop's own. */
  written: boolean;
  manualPreSeen: boolean;
  done: () => void;
}

interface Entry {
  latchAt?: number;
  /**
   * A latch agentd has seen Claude get past. The next command still carries
   * it as `notBefore`, so the launcher checks the same barrier at its write.
   */
  passedLatchAt?: number;
  /** Bumped on every change of `latchAt` or `passedLatchAt`, so a restore can tell whether it still owns them. */
  latchVersion: number;
  inFlight: boolean;
  compact?: CompactWatch;
  /**
   * When agentd saw a main-thread `Stop` (stop_hook_active not true) and no
   * sign of main-thread work since: see `trackMainThread` for what clears it.
   */
  stopAt?: number;
  /** Why `stopAt` is not set: the name of what took the Stop away, for the log. Absent before any Stop. */
  stopCause?: string;
  /** The `permission_mode` of the latest main-thread hook; undefined when that hook carried none. */
  mode?: string;
}

/** What the evidence for a background reply says, short of the phone's switch (the router adds it). */
export interface BgPicture {
  /** Every item of evidence but the permission mode holds. */
  eligible: boolean;
  /** The main thread's latest known permission mode is one a reply may be typed in, and its extra guard holds. */
  modeOk: boolean;
}

/** The readiness latch alone, as it was before a write; never the Stop evidence, which a revocation owns. */
export interface LatchSnapshot {
  latchAt?: number;
  passedLatchAt?: number;
}

/** A prompt or a reply with every whitespace removed, so that it can be compared with the other. */
function squash(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, "");
}

/** A hook fired inside a subagent carries that subagent's id; the main thread's does not. */
function isSubagentHook(payload: Record<string, unknown>): boolean {
  return payload.agent_id !== undefined && payload.agent_id !== null && payload.agent_id !== "";
}

/**
 * Hooks whose main-thread firing takes the Stop away in every mode: a new turn
 * (a prompt, a background task's report, a compact, a restart) or a tool the
 * classifier refused.
 */
const MAIN_THREAD_TURN: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "UserPromptExpansion",
  "PermissionDenied",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "SessionEnd",
  "StopFailure",
]);
/**
 * Main-thread tool use takes the Stop away only where a tool can open a dialog.
 * In `auto` and `bypassPermissions` none does, and a reply typed while the main
 * thread works only queues, so tool use there is no reason to refuse; the turn
 * hooks above still are.
 */
const MAIN_THREAD_TOOL: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
/**
 * Hooks that mean something is, or may be, waiting on the wearer, whichever
 * thread fired them. A SubagentStop is not one: background agents finishing is
 * normal and puts nothing on the main screen.
 */
const BLOCKING_HOOKS: ReadonlySet<string> = new Set(["PermissionRequest", "Elicitation", "ElicitationResult"]);
/**
 * Notifications that are not a dialog (idle, a login, a finished or resumed
 * background agent, a plugin's own): they leave the Stop alone. Every other type,
 * a dialog's (`permission_prompt`, `elicitation_dialog`, ...) or one agentd does
 * not know or that has none, takes it away.
 */
const QUIET_NOTIFICATIONS: ReadonlySet<string> = new Set([
  "idle_prompt",
  "auth_success",
  "auth_storage_failure",
  "elicitation_complete",
  "elicitation_response",
  "agent_completed",
  "quota_auto_resume_fired",
  "quota_auto_resume_stale",
  "quota_auto_resume_disabled",
  "plugin_notification",
]);
/**
 * What Claude's sessions file may say while a background reply is typed: `busy`,
 * and `shell`, which the live file showed at an idle-looking prompt ("Waiting for
 * background agents to finish") although no document defines it. `idle` takes the
 * ordinary path; anything else or unknown is refused.
 */
export const BG_FILE_STATUSES: ReadonlySet<string> = new Set(["busy", "shell"]);

export class SessionStates {
  private readonly entries = new Map<SessionKey, Entry>();

  constructor(
    private readonly readSession: (claudePid: number) => SessionRead | undefined,
    private readonly clock: () => number,
    private readonly sources: StateSources,
  ) {}

  /**
   * The post-write freshness barrier: until Claude's file shows an idle newer
   * than `at`, the session is not ready. Set synchronously on a Stop delivery
   * and on `command_written`; it only ever moves forward.
   */
  latch(key: SessionKey, at: number, keepStop = false): void {
    const entry = this.entry(key);
    // Whatever the latch stands for (a write, a delivered Stop) is main-thread
    // work. A background reply's own paste keeps the evidence until its Enter is allowed.
    if (!keepStop) {
      entry.stopAt = undefined;
      entry.stopCause = "typed_write_or_delivered_stop";
    }
    entry.latchAt = entry.latchAt === undefined ? at : Math.max(entry.latchAt, at);
    entry.latchVersion += 1;
  }

  /**
   * The command that set it is known to be done; the next one carries no
   * barrier. A latch newer than `upTo` (a Stop delivery since) stays.
   */
  clearLatch(key: SessionKey, upTo = Number.POSITIVE_INFINITY): void {
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    if (entry.latchAt === undefined || entry.latchAt <= upTo) {
      entry.latchAt = undefined;
    }
    entry.passedLatchAt = undefined;
    entry.latchVersion += 1;
  }

  latchAt(key: SessionKey): number | undefined {
    return this.entries.get(key)?.latchAt;
  }

  /** What the next `type_command` carries as `notBefore`. */
  notBefore(key: SessionKey): number | undefined {
    const entry = this.entries.get(key);
    return entry?.latchAt ?? entry?.passedLatchAt;
  }

  /** The readiness latch as it is now, for a write that may have to put it back. */
  snapshotLatch(key: SessionKey): LatchSnapshot {
    const entry = this.entries.get(key);
    return { latchAt: entry?.latchAt, passedLatchAt: entry?.passedLatchAt };
  }

  /** Counts every change of the latch; compare two reads to know whether it moved in between. */
  latchVersion(key: SessionKey): number {
    return this.entries.get(key)?.latchVersion ?? 0;
  }

  /**
   * A paste that was cleared away (a `not_sent`, a takeover or a cancel before the Enter) submitted
   * nothing: the barrier its first write set would wait for an idle that can never come. The latch,
   * and only the latch, goes back to what it was before the paste, and only when nothing has changed
   * it since that write (`version` is what `latchVersion` said right after it): a newer latch, a
   * cleared one or another command's write stands. The Stop evidence is never touched here, so
   * what a revocation took away stays gone. True when it was restored.
   */
  restoreLatch(key: SessionKey, snapshot: LatchSnapshot, version: number): boolean {
    const entry = this.entries.get(key);
    if (!entry || entry.latchVersion !== version) {
      return false;
    }
    entry.latchAt = snapshot.latchAt;
    entry.passedLatchAt = snapshot.passedLatchAt;
    entry.latchVersion += 1;
    return true;
  }

  /** The evidence of a main-thread Stop is used up or gone. */
  clearStop(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.stopAt = undefined;
      entry.stopCause = "used_by_a_reply";
    }
  }

  /** The hooks that tell agentd something the file cannot. */
  onHook(key: SessionKey, event: string, payload: Record<string, unknown>): void {
    this.trackMainThread(key, event, payload);
    switch (event) {
      case "UserPromptSubmit":
        // Nothing is typed while uncertain, so a prompt now is the wearer's own:
        // whatever was left on the screen, they have dealt with it.
        if (this.sources.binding(key)?.uncertain) {
          this.sources.clearUncertain(key);
        }
        break;
      case "PreCompact": {
        const watch = this.entries.get(key)?.compact;
        if (watch) {
          watch.manualPreSeen =
            watch.written && payload.trigger === "manual" && this.sources.binding(key)?.gen === watch.gen;
        }
        break;
      }
      case "PostCompact": {
        const entry = this.entries.get(key);
        const watch = entry?.compact;
        if (!entry || !watch) {
          break;
        }
        if (watch.manualPreSeen && payload.trigger !== "auto" && this.sources.binding(key)?.gen === watch.gen) {
          entry.compact = undefined;
          watch.done();
        } else {
          watch.manualPreSeen = false;
        }
        break;
      }
    }
  }

  /**
   * The background-reply evidence from hooks. A Stop hook alone does not prove
   * the main turn is over (another Stop hook can continue it, which is what
   * `stop_hook_active` says), so a Stop only counts when it says it is not a
   * continuation, and everything that shows the main thread working, or
   * something waiting on the wearer, takes it away. Hooks fired inside a
   * subagent (`agent_id`) say nothing about the main thread, except those that
   * can put a dialog on the main screen, which clear it whoever fired them.
   * Notifications are told apart by `notification_type`, never by their text.
   */
  private trackMainThread(key: SessionKey, event: string, payload: Record<string, unknown>): void {
    const sub = isSubagentHook(payload);
    const entry = this.entry(key);
    if (!sub) {
      entry.mode = typeof payload.permission_mode === "string" && payload.permission_mode.length <= 40
        ? payload.permission_mode
        : undefined;
    }
    const revoke = (cause: string): void => {
      entry.stopAt = undefined;
      entry.stopCause = cause;
    };
    if (event === "Stop") {
      const continued = payload.stop_hook_active !== undefined && payload.stop_hook_active !== false;
      if (sub || continued) {
        revoke(continued ? "stop_hook_active" : "stop_from_subagent");
      } else {
        entry.stopAt = this.clock();
        entry.stopCause = undefined;
      }
    } else if (event === "Notification") {
      const type = payload.notification_type;
      if (typeof type !== "string" || !QUIET_NOTIFICATIONS.has(type)) {
        revoke(`Notification:${typeof type === "string" && /^[a-z_]{1,40}$/.test(type) ? type : "unknown"}`);
      }
    } else if (BLOCKING_HOOKS.has(event)) {
      revoke(event);
    } else if (!sub && MAIN_THREAD_TURN.has(event)) {
      revoke(event);
    } else if (!sub && MAIN_THREAD_TOOL.has(event) && !AUTO_APPROVING_MODES.has(entry.mode ?? "")) {
      revoke(event);
    }
  }

  /**
   * For the log only: the first rule of the background-reply evidence that fails
   * for the session, by name, with the raw file status, the main-thread mode and
   * the age of the Stop in seconds. The router adds the phone's switch and the
   * laptop draft. Never a decision, and never anything typed or shown.
   */
  bgDiagnosis(
    key: SessionKey,
    ownsClaim = false,
  ): { rule: string; status: string; mode: string; stopAgeSec: number | null; subagents: number } {
    const binding = this.sources.binding(key);
    const entry = this.entries.get(key);
    const file = binding?.claudePid === undefined ? undefined : this.readSession(binding.claudePid);
    const subagents = this.sources.subagents?.(key) ?? 0;
    const stopAgeMs = entry?.stopAt === undefined ? null : this.clock() - entry.stopAt;
    const stopAge = stopAgeMs === null ? null : Math.round(stopAgeMs / 1000);
    const mode = entry?.mode !== undefined && /^[A-Za-z]{1,40}$/.test(entry.mode) ? entry.mode : "unknown";
    const status = file && /^[a-z_]{1,20}$/.test(file.status) ? file.status : file ? "other" : "none";
    const rule = (): string => {
      if (!binding || binding.claudePid === undefined) {
        return "not_bound";
      }
      if (!BG_ALLOWED_MODES.has(entry?.mode ?? "")) {
        return `mode_not_allowed:${mode}`;
      }
      if (subagents < 1) {
        return "no_running_subagent";
      }
      if (!file) {
        return "file_status:none";
      }
      if (!BG_FILE_STATUSES.has(file.status)) {
        return `file_status:${status}`;
      }
      if (file.sessionId !== key.slice(key.indexOf(":") + 1)) {
        return "file_of_another_session";
      }
      if (entry?.stopAt === undefined) {
        return entry?.stopCause === undefined ? "no_main_thread_stop" : `stop_revoked_by:${entry.stopCause}`;
      }
      if (stopAgeMs === null || stopAgeMs < 0 || stopAgeMs > BACKGROUND_STOP_FRESH_MS) {
        return "stop_too_old";
      }
      if (this.sources.asking(key)) {
        return "approval_pending";
      }
      if (this.sources.held(key)) {
        return "stop_held";
      }
      if (binding.uncertain) {
        return "uncertain";
      }
      if (entry?.inFlight === true && !ownsClaim) {
        return "in_flight";
      }
      const picture = this.bgPicture(key, ownsClaim);
      return picture.eligible && picture.modeOk ? "ok" : "mode_guard";
    };
    return { rule: rule(), status, mode, stopAgeSec: stopAge, subagents };
  }

  /**
   * Whether the hook evidence for typing a background reply holds: Claude's
   * file says `busy` (never `waiting`, never `idle`, which takes the ordinary
   * path), for this session; the session is bound, with nothing held, asked,
   * uncertain or (unless `ownsClaim`, for the command that holds it) in flight;
   * a main-thread Stop, not a continued one, is no older than
   * BACKGROUND_STOP_FRESH_MS with no main-thread work since; and the store
   * counts a running subagent. `modeOk` is the permission-mode item (an allowed
   * mode, and outside `auto` and `bypassPermissions` no pending approval of any
   * origin), kept apart so the phone can be told that one is what is missing.
   * A PermissionRequest or an elicitation or permission notification, from any
   * agent, has already taken the Stop away (`trackMainThread`). The laptop draft and
   * the phone's switch are the router's.
   */
  bgPicture(key: SessionKey, ownsClaim = false): BgPicture {
    const no: BgPicture = { eligible: false, modeOk: false };
    const binding = this.sources.binding(key);
    const entry = this.entries.get(key);
    if (
      this.sources.held(key) ||
      !binding ||
      binding.claudePid === undefined ||
      binding.uncertain ||
      (entry?.inFlight === true && !ownsClaim) ||
      this.sources.asking(key)
    ) {
      return no;
    }
    const file = this.readSession(binding.claudePid);
    if (!file || !BG_FILE_STATUSES.has(file.status) || file.sessionId !== key.slice(key.indexOf(":") + 1)) {
      return no;
    }
    const stopAge = entry?.stopAt === undefined ? undefined : this.clock() - entry.stopAt;
    if (stopAge === undefined || stopAge < 0 || stopAge > BACKGROUND_STOP_FRESH_MS) {
      return no;
    }
    if ((this.sources.subagents?.(key) ?? 0) < 1) {
      return no;
    }
    const mode = entry?.mode;
    if (mode === undefined || !BG_ALLOWED_MODES.has(mode)) {
      return { eligible: true, modeOk: false };
    }
    // Where a dialog may open nothing may be waiting on the wearer, and that
    // has to be known, not assumed.
    const guarded = AUTO_APPROVING_MODES.has(mode) || this.sources.approvalPending?.(key) === false;
    return { eligible: true, modeOk: guarded };
  }

  /**
   * From now on a manual PreCompact, then a PostCompact, of this session under
   * binding `gen` is this compact finishing. One compact is watched at a time.
   */
  armCompact(key: SessionKey, gen: number, done: () => void): void {
    this.entry(key).compact = { gen, written: false, manualPreSeen: false, done };
  }

  /** The armed compact's first write happened. */
  compactWritten(key: SessionKey): void {
    const watch = this.entries.get(key)?.compact;
    if (watch) {
      watch.written = true;
    }
  }

  disarmCompact(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.compact = undefined;
    }
  }

  /** One command at a time per session, through its completion. False when one is already running. */
  claim(key: SessionKey): boolean {
    const entry = this.entry(key);
    if (entry.inFlight) {
      return false;
    }
    entry.inFlight = true;
    return true;
  }

  /** A command holds the session's claim. */
  claimed(key: SessionKey): boolean {
    return this.entries.get(key)?.inFlight === true;
  }

  release(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.inFlight = false;
    }
  }

  /** The session ended: nothing about it is worth keeping. */
  forget(key: SessionKey): void {
    this.entries.delete(key);
  }

  state(key: SessionKey): LaunchState {
    if (this.sources.held(key)) {
      return "held";
    }
    const binding = this.sources.binding(key);
    const entry = this.entries.get(key);
    // A running command keeps the latch it set: only an idle seen after the
    // command is over may clear it.
    if (!binding || entry?.inFlight || this.sources.asking(key) || binding.claudePid === undefined) {
      return "busy";
    }
    const id = key.slice(key.indexOf(":") + 1);
    const file = this.readSession(binding.claudePid);
    if (!file || file.status !== "idle" || (file.sessionId !== undefined && file.sessionId !== id)) {
      return "busy";
    }
    if (entry?.latchAt !== undefined) {
      if (!(file.statusUpdatedAt > entry.latchAt)) {
        return "busy";
      }
      entry.passedLatchAt = entry.latchAt;
      entry.latchAt = undefined;
      entry.latchVersion += 1;
      // R141: Claude has been seen idle since the write that left it uncertain.
      if (binding.uncertain) {
        this.sources.clearUncertain(key);
        return "ready";
      }
    }
    return binding.uncertain ? "busy" : "ready";
  }

  /**
   * Messaging only, never a readiness decision: Claude's own file says `busy`
   * and nothing else is in the way (nothing held, asked, in flight or uncertain).
   */
  fileBusy(key: SessionKey): boolean {
    const binding = this.sources.binding(key);
    if (
      this.sources.held(key) ||
      this.sources.asking(key) ||
      !binding ||
      binding.uncertain ||
      binding.claudePid === undefined ||
      this.entries.get(key)?.inFlight
    ) {
      return false;
    }
    const file = this.readSession(binding.claudePid);
    return file !== undefined && BG_FILE_STATUSES.has(file.status) && (file.sessionId === undefined || file.sessionId === key.slice(key.indexOf(":") + 1));
  }

  private entry(key: SessionKey): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { inFlight: false, latchVersion: 0 };
      this.entries.set(key, entry);
    }
    return entry;
  }
}

/** What the router needs of the launcher hub. */
export interface LauncherPort {
  binding(key: SessionKey): { gen: number; claudePid?: number; uncertain: boolean } | undefined;
  boundKeys(): SessionKey[];
  /** Why the key's last binding ended, while it has none. */
  unboundReason(key: SessionKey): SendError | undefined;
  send(key: SessionKey, cmd: Omit<TypeCommand, "cmdId" | "gen"> & { cmdId?: string }): Promise<CommandResult>;
  cancel(key: SessionKey, reason: "cancelled" | "taken_over"): void;
  /** R148: cancel one command on the connection that received it, past its result too. */
  cancelCommand(cmdId: string): void;
  setUncertain(key: SessionKey, uncertain: boolean): void;
  /** R149: Claude took a prompt in the session. */
  promptSubmitted(key: SessionKey, at: number): void;
  laptopDraft(key: SessionKey): boolean;
  compactDone(key: SessionKey, cmdId: string): void;
  onChange(cb: (key: SessionKey) => void): void;
  onCommandWritten(cb: (key: SessionKey, cmdId: string, at: number) => void): void;
  /** R165: the launcher's own result for a command agentd had already cancelled. */
  onLateResult(cb: (cmdId: string, ok: boolean, error?: string) => void): void;
  /** A launcher asks, mid-command, whether a background reply may write now (`paste`, then `enter`). */
  onWriteCheck?(cb: (key: SessionKey, cmdId: string, phase: WriteCheckPhase) => boolean): void;
}

export interface RouterTimings {
  readyWaitMs: number;
  compactLimitMs: number;
  pollMs: number;
  /** R165: how long a cancel waits to hear whether the launcher typed the command anyway. */
  cancelSettleMs: number;
  /** How long a background reply waits, after the launcher pressed Enter, to see Claude take its prompt. */
  bgAcceptMs: number;
}

export const CANCEL_SETTLE_MS = 500;

/** `consumed`: the command was typed before it failed, so its msgId must not be reused. */
export type RouteOutcome = { ok: true } | { ok: false; error: string; consumed?: boolean };

export type LauncherCommand =
  | { command: "compact" }
  | { command: "model"; model: string }
  | { command: "text"; text: string };

const OK: RouteOutcome = { ok: true };
const fail = (error: string): RouteOutcome => ({ ok: false, error });

interface Running {
  cmdId: string;
  written: boolean;
  writtenAt?: number;
  gen: number;
  abort: (error: string) => void;
  /** Set while a cancel waits to settle: the launcher has answered for the command. */
  settled?: () => void;
  /** A background reply (see `bgAssess`): written is its paste, `enterGranted` its Enter allowed. */
  bg?: boolean;
  enterGranted?: boolean;
  /** The command was aborted here; no later write check of it is answered yes. */
  dead?: boolean;
  /** A background reply: called with the prompt of a UserPromptSubmit seen after its Enter was allowed. */
  accept?: (prompt: string | undefined) => void;
  /** `latchVersion` right after this command's own first write: a restore is only for a latch nobody has moved since. */
  latchMark?: number;
  /** The launcher's own error for a command agentd had already cancelled, once it arrived. */
  lateError?: string;
}

/**
 * Routes the glasses' launcher commands and late follow-ups into a bound
 * session: it waits for `ready`, types through the launcher, and decides when
 * a command is really done. Every command is serialised through completion.
 */
export class LauncherRouter {
  readonly states: SessionStates;
  private readonly port: LauncherPort;
  private readonly timings: RouterTimings;
  private readonly clock: () => number;
  private readonly onStateChange: (key: SessionKey) => void;
  /** Bumped when a session ends or is detached: anything waiting on it is cancelled. */
  private readonly epochs = new Map<SessionKey, number>();
  private readonly running = new Map<SessionKey, Running>();
  private readonly shown = new Map<SessionKey, string>();
  private watchTimer?: NodeJS.Timeout;
  private readonly bgSwitch: () => boolean;
  private readonly log?: (event: string, meta: Record<string, unknown>) => void;
  /** The last `bg_decision` logged for each session, so only a change says anything. */
  private readonly bgLogged = new Map<SessionKey, string>();

  constructor(options: {
    port: LauncherPort;
    states: SessionStates;
    clock?: () => number;
    timings?: Partial<RouterTimings>;
    /** A bound session's follow-up state or binding changed: republish it. */
    onStateChange?: (key: SessionKey) => void;
    /** The phone's opt-in for background replies, read live; absent, off. */
    bgReplies?: () => boolean;
    /** Where `bg_decision` lines go: names, a raw status and numbers, never prompt text. */
    log?: (event: string, meta: Record<string, unknown>) => void;
  }) {
    this.log = options.log;
    this.port = options.port;
    this.states = options.states;
    this.clock = options.clock ?? Date.now;
    this.timings = {
      readyWaitMs: options.timings?.readyWaitMs ?? READY_WAIT_MS,
      compactLimitMs: options.timings?.compactLimitMs ?? COMPACT_LIMIT_MS,
      pollMs: options.timings?.pollMs ?? READY_POLL_MS,
      cancelSettleMs: options.timings?.cancelSettleMs ?? CANCEL_SETTLE_MS,
      bgAcceptMs: options.timings?.bgAcceptMs ?? BG_ACCEPT_MS,
    };
    this.bgSwitch = options.bgReplies ?? (() => false);
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.port.onWriteCheck?.((key, cmdId, phase) => this.writeCheck(key, cmdId, phase));
    this.port.onCommandWritten((key, cmdId, at) => {
      const running = this.running.get(key);
      // A background reply's own paste is not the main thread's work; its Enter is.
      this.states.latch(key, at, running?.cmdId === cmdId && running.bg === true && running.enterGranted !== true);
      if (running?.cmdId === cmdId) {
        running.written = true;
        running.writtenAt ??= at;
        running.latchMark ??= this.states.latchVersion(key);
        this.states.compactWritten(key);
        running.settled?.();
      }
    });
    this.port.onLateResult((cmdId, _ok, error) => {
      for (const running of this.running.values()) {
        if (running.cmdId === cmdId) {
          running.lateError = error;
          running.settled?.();
        }
      }
    });
    this.port.onChange((key) => {
      // Past the launcher's ok for a compact only agentd is waiting, so a
      // binding that went away must end that wait here. Before it the hub has
      // already settled the pending command (it settles before it emits), and
      // that result wins the race.
      const running = this.running.get(key);
      const problem = running && this.interrupted(key, running.gen, this.epoch(key));
      if (running && problem) {
        running.abort(problem);
      }
      // R161: a binding that starts uncertain (its launcher said so, and this
      // agentd never saw the write) clears only on an idle newer than now.
      if (this.port.binding(key)?.uncertain && this.states.latchAt(key) === undefined) {
        this.states.latch(key, this.clock());
      }
      this.look(key, true);
    });
  }

  /**
   * Looks at every bound session now and then, so the phone hears when one
   * goes idle (nothing else says so), and so an uncertainty clears once Claude
   * has been seen idle again even when no command is waiting.
   */
  start(): void {
    this.watchTimer ??= setInterval(() => {
      for (const key of this.port.boundKeys()) {
        this.look(key, false);
      }
    }, WATCH_MS);
    this.watchTimer.unref();
  }

  stop(): void {
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = undefined;
    }
    for (const running of this.running.values()) {
      running.abort("cancelled");
    }
  }

  isBound(key: SessionKey): boolean {
    return this.port.binding(key) !== undefined;
  }

  state(key: SessionKey): LaunchState {
    return this.states.state(key);
  }

  followupState(key: SessionKey): FollowupState {
    const state = this.states.state(key);
    if (state === "held") {
      return "waiting";
    }
    if (this.port.laptopDraft(key)) {
      return "unavailable";
    }
    return state === "ready" || this.bgAssess(key) === "ready" ? "ready" : "unavailable";
  }

  /**
   * The background-reply decision for a session whose file says `busy`:
   * "ready" only when all of `SessionStates.bgPicture`, no laptop draft and
   * the phone's switch hold; "mode_not_allowed" or "bg_off" when everything else
   * would allow it and that one item is what is missing (the mode first);
   * "no" otherwise. Never says "ready" for a session whose file is not busy.
   */
  private bgAssess(key: SessionKey, ownsClaim = false): "ready" | "bg_off" | "mode_not_allowed" | "no" {
    const picture = this.states.bgPicture(key, ownsClaim);
    if (!picture.eligible || this.port.laptopDraft(key)) {
      return "no";
    }
    if (!picture.modeOk) {
      return "mode_not_allowed";
    }
    let on = false;
    try {
      on = this.bgSwitch() === true;
    } catch {
      on = false;
    }
    return on ? "ready" : "bg_off";
  }

  /**
   * Why `followupState` is "unavailable", for the phone to say, never for
   * deciding anything: "draft" (text at the laptop prompt), "mode_not_allowed"
   * or "bg_off" (a background reply would be allowed but for the permission
   * mode, or but for the phone's switch), "background" (Claude's file is busy
   * while `subagentsRunning` subagents run, so the main prompt may well be
   * free) or "busy" (everything else). Undefined when the follow-up is
   * available or waiting, or the session is not bound.
   */
  followupWhy(
    key: SessionKey,
    subagentsRunning = 0,
  ): "busy" | "draft" | "background" | "bg_off" | "mode_not_allowed" | undefined {
    if (!this.port.binding(key)) {
      return undefined;
    }
    const state = this.states.state(key);
    if (state === "held") {
      return undefined;
    }
    if (this.port.laptopDraft(key)) {
      return "draft";
    }
    if (state === "ready") {
      return undefined;
    }
    const bg = this.bgAssess(key);
    if (bg === "ready") {
      return undefined;
    }
    if (bg === "bg_off" || bg === "mode_not_allowed") {
      return bg;
    }
    return subagentsRunning > 0 && this.states.fileBusy(key) ? "background" : "busy";
  }

  /** The phone's switch or its link changed: a background reply whose evidence is gone is cancelled now. */
  bgRepliesChanged(): void {
    for (const key of this.running.keys()) {
      this.revokeBg(key);
    }
    for (const key of this.port.boundKeys()) {
      this.look(key, false);
    }
  }

  /** A Stop hook just carried a follow-up: Claude carries on, so the session is busy before the hook returns. */
  onStopDelivered(key: SessionKey): void {
    this.states.latch(key, this.clock());
    this.look(key, true);
  }

  onHook(key: SessionKey, event: string, payload: Record<string, unknown>): void {
    this.states.onHook(key, event, payload);
    // A hook may take a background reply's evidence away.
    this.revokeBg(key);
    if (event === "UserPromptSubmit" && this.port.binding(key)) {
      const running = this.running.get(key);
      if (running?.bg && running.enterGranted) {
        running.accept?.(typeof payload.prompt === "string" ? payload.prompt : undefined);
      }
      // R163: a laptop turn started; a reply queued before it is not for it.
      this.cancelUnwritten(key);
      this.port.promptSubmitted(key, this.clock());
    }
    if (this.port.binding(key)) {
      // A Stop or the like changes what the phone may show; the file never would.
      this.look(key, false);
    }
  }

  /**
   * R163: a Stop hold opened, or an approval or a question is now pending.
   * A dispatched command not yet typed is cancelled; one already typed is
   * left alone, since a `/model` mid-dialog must not get another Esc.
   */
  onBlocked(key: SessionKey): void {
    if (this.port.binding(key)) {
      // A background reply that loses its evidence fails busy, as every revocation does.
      this.revokeBg(key);
      this.cancelUnwritten(key);
      this.look(key, true);
    }
  }

  /** A Stop hold ended other than by a delivery: what the phone shows may change. */
  onHoldReleased(key: SessionKey): void {
    if (this.port.binding(key)) {
      this.look(key, true);
    }
  }

  /**
   * The background reply in flight, before its Enter is allowed, loses its
   * evidence: it is aborted busy at once (before the paste nothing was typed;
   * after it the launcher clears the input line), and never retyped.
   */
  private revokeBg(key: SessionKey): void {
    const running = this.running.get(key);
    if (running?.bg && !running.enterGranted && !running.dead && this.bgAssess(key, true) !== "ready") {
      running.abort("busy");
    }
  }

  /**
   * The write boundary, asked by the launcher right before its paste and right
   * before its Enter: all the evidence again, on this very answer. Allowing
   * the Enter is what uses the Stop up, so a later one cannot reuse it.
   */
  private writeCheck(key: SessionKey, cmdId: string, phase: WriteCheckPhase): boolean {
    const running = this.running.get(key);
    if (!running?.bg || running.cmdId !== cmdId || running.dead || running.enterGranted) {
      return false;
    }
    if (this.interrupted(key, running.gen, this.epoch(key)) || (phase === "paste") === running.written) {
      return false;
    }
    if (this.bgAssess(key, true) !== "ready") {
      return false;
    }
    if (phase === "enter") {
      running.enterGranted = true;
      this.states.clearStop(key);
    }
    return true;
  }

  private cancelUnwritten(key: SessionKey): void {
    const running = this.running.get(key);
    if (running && !running.written) {
      running.abort("cancelled");
    }
  }

  /** The session ended or was detached: whatever waits or runs on it is cancelled. */
  endSession(key: SessionKey): void {
    this.epochs.set(key, this.epoch(key) + 1);
    this.running.get(key)?.abort("cancelled");
    this.port.cancel(key, "cancelled");
    this.states.forget(key);
    this.shown.delete(key);
    this.bgLogged.delete(key);
  }

  /** `compact` or `model`, from the glasses' launcher_command. */
  async command(key: SessionKey, cmd: LauncherCommand): Promise<RouteOutcome> {
    const start = this.port.binding(key);
    if (!start) {
      return fail("not_launcher");
    }
    const epoch = this.epoch(key);
    const ready = await this.waitForReady(key, start.gen, epoch, false, false);
    if (ready !== "ready") {
      return fail(ready);
    }
    return this.run(key, start.gen, epoch, cmd, false);
  }

  /**
   * A follow-up for a bound session: a held Stop takes it as before
   * (`deliverHeld`); a session that is idle past the wait limit gets it typed.
   */
  async followup(key: SessionKey, text: string, deliverHeld: () => RouteOutcome): Promise<RouteOutcome> {
    const start = this.port.binding(key);
    if (!start) {
      return fail("not_launcher");
    }
    const epoch = this.epoch(key);
    // Only a text Claude can echo whole may take the background route.
    const ready = await this.waitForReady(key, start.gen, epoch, true, bgReplyText(text) !== undefined);
    if (ready === "held") {
      return deliverHeld();
    }
    if (ready !== "ready" && ready !== "ready_bg") {
      return fail(ready);
    }
    return this.run(key, start.gen, epoch, { command: "text", text }, ready === "ready_bg");
  }

  /**
   * Waits up to the readiness window. Resolves "ready" with the session
   * claimed ("ready_bg" when that is the background-reply exception, which only
   * a `background` caller, a text, ever takes), "held" (only when `takeHeld`),
   * or the error to reject with.
   */
  private async waitForReady(
    key: SessionKey,
    gen: number,
    epoch: number,
    takeHeld: boolean,
    background: boolean,
  ): Promise<string> {
    const deadline = this.clock() + this.timings.readyWaitMs;
    for (;;) {
      const problem = this.interrupted(key, gen, epoch);
      if (problem) {
        return problem;
      }
      const state = this.states.state(key);
      // A command still in flight finishes first; a delivery beside it would race it.
      if (state === "held" && takeHeld && !this.states.claimed(key)) {
        return "held";
      }
      if (this.port.binding(key)?.uncertain) {
        return "uncertain";
      }
      // The launcher would hold it behind the draft anyway (Review Focus 1);
      // waiting here keeps what agentd dispatches in line with what it shows.
      const draft = this.port.laptopDraft(key);
      const viaBg = background && state !== "ready" && state !== "held" && this.bgAssess(key) === "ready";
      if ((state === "ready" || viaBg) && !draft && this.states.claim(key)) {
        return viaBg ? "ready_bg" : "ready";
      }
      if (this.clock() >= deadline) {
        return state === "ready" && draft ? "laptop_draft" : "busy";
      }
      await new Promise((resolve) => setTimeout(resolve, this.timings.pollMs));
    }
  }

  /** Runs a claimed command to its end; the claim is released whatever happens. */
  private async run(
    key: SessionKey,
    gen: number,
    epoch: number,
    cmd: LauncherCommand,
    bg: boolean,
  ): Promise<RouteOutcome> {
    const cmdId = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    let compactDone: Promise<string> | undefined;
    const running: Running = { cmdId, written: false, gen, abort: () => undefined, ...(bg ? { bg: true } : {}) };
    // A background reply is spent only when its Enter was allowed: before that
    // the launcher clears the paste away, and the same msgId may be sent again.
    const spent = (): boolean => (bg ? running.enterGranted === true : running.written);
    // Typed, then failed: the msgId is spent, so a resend is a duplicate, never a retype.
    // For a text reply the launcher's `not_sent`, `laptop_draft` and `taken_over` all say the Enter was
    // never pressed (it cleared its paste away, or made none): nothing was submitted, so the same msgId
    // may be sent again and the readiness state is what it was before the paste. A compact or a model
    // change that was taken over had been typed, and stays spent.
    // `cancelled` is the launcher's too: it cleared the paste when asked to stop, and nothing was entered.
    const unsent = (error: string): boolean =>
      cmd.command === "text" &&
      (error === "not_sent" || error === "laptop_draft" || error === "taken_over" || error === "cancelled");
    const before = this.states.snapshotLatch(key);
    // Puts the latch back for a paste that was never entered, if nobody has moved it since that write.
    const putBack = (): void => {
      if (running.latchMark !== undefined) {
        this.states.restoreLatch(key, before, running.latchMark);
      }
    };
    const failed = (error: string): RouteOutcome =>
      spent() && !unsent(error) ? { ok: false, error, consumed: true } : fail(error);
    const promptSeen = bg && cmd.command === "text"
      ? new Promise<string>((resolve) => {
          const want = squash(cmd.text);
          // The prompt of a background task's report is another turn's; ours may follow it.
          running.accept = (prompt) => {
            if (prompt === undefined || squash(prompt) === want) {
              resolve("accepted");
            }
          };
        })
      : undefined;
    const interrupt = new Promise<string>((resolve) => {
      running.abort = (error) => {
        running.dead = true;
        resolve(error);
      };
      this.running.set(key, running);
      const limit = cmd.command === "compact"
        ? this.timings.compactLimitMs
        : this.timings.readyWaitMs + RESULT_SLACK_MS;
      timer = setTimeout(() => resolve("timeout"), limit);
    });
    try {
      if (epoch !== this.epoch(key)) {
        return fail("cancelled");
      }
      if (cmd.command === "compact") {
        compactDone = new Promise<string>((resolve) => this.states.armCompact(key, gen, () => resolve("done")));
      }
      const notBefore = this.states.notBefore(key);
      const sent = this.port.send(key, {
        cmdId,
        ...cmd,
        ...(notBefore !== undefined ? { notBefore } : {}),
        ...(bg ? { bgReply: true as const } : {}),
      });
      const result: CommandResult | string = await Promise.race([sent, interrupt]);
      if (typeof result === "string") {
        // The launcher has not answered in time, or the session went away:
        // cancel whatever it is still doing, and say so.
        this.port.cancelCommand(cmdId);
        await this.settleCancel(key, running, cmd.command === "text");
        this.noteFailure(key, gen, cmd, result);
        // R165: it was typed before the cancel reached the launcher. The msgId
        // is spent, so a resend is a duplicate and never typed twice.
        if (bg && !spent()) {
          if (running.written) {
            putBack();
            return fail("not_sent");
          }
          return fail(result);
        }
        // The launcher's own word that it cleared a pasted reply and never pressed the Enter.
        if (running.written && running.lateError !== undefined && unsent(running.lateError)) {
          putBack();
          return fail(result);
        }
        return running.written ? { ok: false, error: "typed_after_cancel", consumed: true } : failed(result);
      }
      if (!result.ok) {
        const error: SendError = result.error ?? "not_ready";
        this.noteFailure(key, gen, cmd, error);
        if (unsent(error)) {
          putBack();
        }
        return failed(error);
      }
      if (cmd.command === "model") {
        // `/model` may never flip Claude's status, and "Set model to" was seen.
        this.states.clearLatch(key, running.writtenAt ?? this.clock());
        return OK;
      }
      if (cmd.command === "text") {
        if (promptSeen) {
          // The launcher pressed Enter; it counts only once Claude takes the prompt, and is never retyped.
          const acceptTimer = new Promise<string>((resolve) => {
            const handle = setTimeout(() => resolve("timeout"), this.timings.bgAcceptMs);
            void promptSeen.then(() => clearTimeout(handle));
            void interrupt.then(() => clearTimeout(handle));
          });
          const end = await Promise.race([promptSeen, acceptTimer, interrupt]);
          if (end !== "accepted") {
            return failed(end);
          }
        }
        return OK;
      }
      const end = await Promise.race([compactDone as Promise<string>, interrupt]);
      if (end !== "done") {
        // R148: past its ok the launcher still owns input for this compact,
        // until compact_done; it has to hear that agentd gave up.
        this.port.cancelCommand(cmdId);
        return failed(end);
      }
      this.port.compactDone(key, cmdId);
      this.states.clearLatch(key, running.writtenAt ?? this.clock());
      return OK;
    } finally {
      clearTimeout(timer);
      if (this.running.get(key)?.cmdId === cmdId) {
        this.running.delete(key);
      }
      if (cmd.command === "compact") {
        this.states.disarmCompact(key);
      }
      this.states.release(key);
      this.look(key, true);
    }
  }

  /**
   * R165: a command cancelled before agentd heard of a write may still have
   * been typed, its `command_written` already on the way. The answer waits
   * until the launcher says either way, or the settle window passes.
   */
  private settleCancel(key: SessionKey, running: Running, text = false): Promise<void> {
    // A text reply that was pasted may still be waiting for its Enter: the launcher's own result says
    // whether it was pressed (`not_sent`, `cancelled`, `taken_over`: no), so that is waited for too.
    if ((running.written && !text) || this.port.binding(key)?.gen !== running.gen) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => running.settled?.(), this.timings.cancelSettleMs);
      running.settled = () => {
        clearTimeout(timer);
        running.settled = undefined;
        resolve();
      };
    });
  }

  /**
   * R141: a model command that failed after its first write may have left
   * the `/model` dialog, or half of it, on screen. Until the wearer types at
   * the laptop or Claude is seen idle again, nothing more is typed.
   */
  private noteFailure(key: SessionKey, gen: number, cmd: LauncherCommand, error: string): void {
    if (cmd.command !== "model" || this.port.binding(key)?.gen !== gen) {
      return;
    }
    const written = this.running.get(key)?.written === true;
    if (error === "dialog_not_seen" || (written && ["cancelled", "taken_over", "timeout"].includes(error))) {
      this.port.setUncertain(key, true);
    }
  }

  private interrupted(key: SessionKey, gen: number, epoch: number): string | undefined {
    if (epoch !== this.epoch(key)) {
      return "cancelled";
    }
    // Gone outright is the launcher's exit, or its move to another session
    // (a /clear, a resume), which is a binding change like any other.
    const binding = this.port.binding(key);
    if (!binding) {
      return this.port.unboundReason(key) === "cancelled" ? "cancelled" : "exited";
    }
    return binding.gen === gen ? undefined : "cancelled";
  }

  private epoch(key: SessionKey): number {
    return this.epochs.get(key) ?? 0;
  }

  /**
   * One `bg_decision` line when the background-reply answer for a session
   * changes (not per poll): the first rule that fails, in the order switch, mode,
   * running subagent, file status, main-thread Stop (and what revoked it),
   * approval pending, in flight or uncertain, laptop draft; the raw file status,
   * the mode name, the running subagents and the Stop's age in seconds. Lengths
   * and names only. Diagnosis for a real session, never a decision.
   */
  private logBgDecision(key: SessionKey): void {
    if (!this.log) {
      return;
    }
    const diagnosis = this.states.bgDiagnosis(key);
    let on = false;
    try {
      on = this.bgSwitch() === true;
    } catch {
      on = false;
    }
    const rule = !on
      ? "switch_off"
      : diagnosis.rule !== "ok"
        ? diagnosis.rule
        : this.port.laptopDraft(key)
          ? "laptop_draft"
          : "ready";
    const signature = `${rule}|${diagnosis.status}`;
    if (this.bgLogged.get(key) === signature) {
      return;
    }
    this.bgLogged.set(key, signature);
    this.log("bg_decision", {
      session: key,
      answer: rule === "ready" ? "ready" : "refused",
      rule,
      fileStatus: diagnosis.status,
      mode: diagnosis.mode,
      runningSubagents: diagnosis.subagents,
      secondsSinceStop: diagnosis.stopAgeSec,
    });
  }

  /** Tells the phone when what it shows for a session would change; `always` for a binding change. */
  private look(key: SessionKey, always: boolean): void {
    if (!this.port.binding(key)) {
      if (this.shown.delete(key) || always) {
        this.onStateChange(key);
      }
      return;
    }
    this.revokeBg(key);
    this.logBgDecision(key);
    // What the phone shows is the follow-up state and, when unavailable, why.
    const seen = `${this.followupState(key)}/${this.bgAssess(key)}`;
    if (always || this.shown.get(key) !== seen) {
      this.shown.set(key, seen);
      this.onStateChange(key);
    }
  }
}
