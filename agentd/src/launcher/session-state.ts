import { randomUUID } from "node:crypto";
import type { FollowupState, SessionKey } from "../protocol-v2";
import type { CommandResult, SendError, TypeCommand } from "./launcher-hub";

/**
 * Where a launcher-bound Claude session stands, for typing into it (R55):
 * `held` while its Stop hook waits for the glasses, `ready` when agentd's own
 * read of Claude's sessions file shows it idle and nothing else is in the way,
 * `busy` otherwise. It is derived from Claude's file, never from hooks alone,
 * so a missed hook cannot leave a session stuck in either direction.
 */
export type LaunchState = "busy" | "held" | "ready";

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
}

interface CompactWatch {
  gen: number;
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
  inFlight: boolean;
  compact?: CompactWatch;
}

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
  latch(key: SessionKey, at: number): void {
    const entry = this.entry(key);
    entry.latchAt = entry.latchAt === undefined ? at : Math.max(entry.latchAt, at);
  }

  /** The command that set it is known to be done; the next one carries no barrier. */
  clearLatch(key: SessionKey): void {
    const entry = this.entries.get(key);
    if (entry) {
      entry.latchAt = undefined;
      entry.passedLatchAt = undefined;
    }
  }

  latchAt(key: SessionKey): number | undefined {
    return this.entries.get(key)?.latchAt;
  }

  /** What the next `type_command` carries as `notBefore`. */
  notBefore(key: SessionKey): number | undefined {
    const entry = this.entries.get(key);
    return entry?.latchAt ?? entry?.passedLatchAt;
  }

  /** The hooks that tell agentd something the file cannot. */
  onHook(key: SessionKey, event: string, payload: Record<string, unknown>): void {
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
          watch.manualPreSeen = payload.trigger === "manual" && this.sources.binding(key)?.gen === watch.gen;
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
   * From now on a manual PreCompact, then a PostCompact, of this session under
   * binding `gen` is this compact finishing. One compact is watched at a time.
   */
  armCompact(key: SessionKey, gen: number, done: () => void): void {
    this.entry(key).compact = { gen, manualPreSeen: false, done };
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
      // R141: Claude has been seen idle since the write that left it uncertain.
      if (binding.uncertain) {
        this.sources.clearUncertain(key);
        return "ready";
      }
    }
    return binding.uncertain ? "busy" : "ready";
  }

  private entry(key: SessionKey): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { inFlight: false };
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
  setUncertain(key: SessionKey, uncertain: boolean): void;
  laptopDraft(key: SessionKey): boolean;
  compactDone(key: SessionKey, cmdId: string): void;
  onChange(cb: (key: SessionKey) => void): void;
  onCommandWritten(cb: (key: SessionKey, cmdId: string, at: number) => void): void;
}

export interface RouterTimings {
  readyWaitMs: number;
  compactLimitMs: number;
  pollMs: number;
}

export type RouteOutcome = { ok: true } | { ok: false; error: string };

export type LauncherCommand =
  | { command: "compact" }
  | { command: "model"; model: string }
  | { command: "text"; text: string };

const OK: RouteOutcome = { ok: true };
const fail = (error: string): RouteOutcome => ({ ok: false, error });

interface Running {
  cmdId: string;
  written: boolean;
  gen: number;
  abort: (error: string) => void;
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

  constructor(options: {
    port: LauncherPort;
    states: SessionStates;
    clock?: () => number;
    timings?: Partial<RouterTimings>;
    /** A bound session's follow-up state or binding changed: republish it. */
    onStateChange?: (key: SessionKey) => void;
  }) {
    this.port = options.port;
    this.states = options.states;
    this.clock = options.clock ?? Date.now;
    this.timings = {
      readyWaitMs: options.timings?.readyWaitMs ?? READY_WAIT_MS,
      compactLimitMs: options.timings?.compactLimitMs ?? COMPACT_LIMIT_MS,
      pollMs: options.timings?.pollMs ?? READY_POLL_MS,
    };
    this.onStateChange = options.onStateChange ?? (() => undefined);
    this.port.onCommandWritten((key, cmdId, at) => {
      this.states.latch(key, at);
      const running = this.running.get(key);
      if (running?.cmdId === cmdId) {
        running.written = true;
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
    return state === "ready" && !this.port.laptopDraft(key) ? "ready" : "unavailable";
  }

  /** A Stop hook just carried a follow-up: Claude carries on, so the session is busy before the hook returns. */
  onStopDelivered(key: SessionKey): void {
    this.states.latch(key, this.clock());
    this.look(key, true);
  }

  onHook(key: SessionKey, event: string, payload: Record<string, unknown>): void {
    this.states.onHook(key, event, payload);
  }

  /** The session ended or was detached: whatever waits or runs on it is cancelled. */
  endSession(key: SessionKey): void {
    this.epochs.set(key, this.epoch(key) + 1);
    this.running.get(key)?.abort("cancelled");
    this.port.cancel(key, "cancelled");
    this.states.forget(key);
    this.shown.delete(key);
  }

  /** `compact` or `model`, from the glasses' launcher_command. */
  async command(key: SessionKey, cmd: LauncherCommand): Promise<RouteOutcome> {
    const start = this.port.binding(key);
    if (!start) {
      return fail("not_launcher");
    }
    const epoch = this.epoch(key);
    const ready = await this.waitForReady(key, start.gen, epoch, false);
    if (ready !== "ready") {
      return fail(ready);
    }
    return this.run(key, start.gen, epoch, cmd);
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
    const ready = await this.waitForReady(key, start.gen, epoch, true);
    if (ready === "held") {
      return deliverHeld();
    }
    if (ready !== "ready") {
      return fail(ready);
    }
    return this.run(key, start.gen, epoch, { command: "text", text });
  }

  /**
   * Waits up to the readiness window. Resolves "ready" with the session
   * claimed, "held" (only when `takeHeld`), or the error to reject with.
   */
  private async waitForReady(key: SessionKey, gen: number, epoch: number, takeHeld: boolean): Promise<string> {
    const deadline = this.clock() + this.timings.readyWaitMs;
    for (;;) {
      const problem = this.interrupted(key, gen, epoch);
      if (problem) {
        return problem;
      }
      const state = this.states.state(key);
      if (state === "held" && takeHeld) {
        return "held";
      }
      if (this.port.binding(key)?.uncertain) {
        return "uncertain";
      }
      if (state === "ready" && this.states.claim(key)) {
        return "ready";
      }
      if (this.clock() >= deadline) {
        return "busy";
      }
      await new Promise((resolve) => setTimeout(resolve, this.timings.pollMs));
    }
  }

  /** Runs a claimed command to its end; the claim is released whatever happens. */
  private async run(key: SessionKey, gen: number, epoch: number, cmd: LauncherCommand): Promise<RouteOutcome> {
    const cmdId = randomUUID();
    let timer: NodeJS.Timeout | undefined;
    let compactDone: Promise<string> | undefined;
    const interrupt = new Promise<string>((resolve) => {
      const running: Running = { cmdId, written: false, gen, abort: resolve };
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
      const sent = this.port.send(key, { cmdId, ...cmd, ...(notBefore !== undefined ? { notBefore } : {}) });
      const result: CommandResult | string = await Promise.race([sent, interrupt]);
      if (typeof result === "string") {
        // The launcher has not answered in time, or the session went away:
        // cancel whatever it is still doing, and say so.
        this.port.cancel(key, "cancelled");
        this.noteFailure(key, gen, cmd, result);
        return fail(result);
      }
      if (!result.ok) {
        const error: SendError = result.error ?? "not_ready";
        this.noteFailure(key, gen, cmd, error);
        return fail(error);
      }
      if (cmd.command === "model") {
        // `/model` may never flip Claude's status, and "Set model to" was seen.
        this.states.clearLatch(key);
        return OK;
      }
      if (cmd.command === "text") {
        return OK;
      }
      const end = await Promise.race([compactDone as Promise<string>, interrupt]);
      if (end !== "done") {
        return fail(end);
      }
      this.port.compactDone(key, cmdId);
      this.states.clearLatch(key);
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

  /** Tells the phone when what it shows for a session would change; `always` for a binding change. */
  private look(key: SessionKey, always: boolean): void {
    if (!this.port.binding(key)) {
      if (this.shown.delete(key) || always) {
        this.onStateChange(key);
      }
      return;
    }
    const seen = this.followupState(key);
    if (always || this.shown.get(key) !== seen) {
      this.shown.set(key, seen);
      this.onStateChange(key);
    }
  }
}
