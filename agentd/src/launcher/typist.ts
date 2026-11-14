import { REPLAY_GAP_MS, type LaptopInput } from "./laptop-input";
import type { CommandError, TypeCommand } from "./launcher-hub";
import { OutputScanner } from "./output-scanner";
import type { PtyChild } from "./pty";

export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface TypistResult {
  ok: boolean;
  error?: CommandError;
}

/** The launcher's own copy of its binding, kept current from `bind_accepted` and `binding_state`. */
export interface BindingView {
  gen: number;
  uncertain: boolean;
  /**
   * R161: the write the launcher's own uncertainty dates from. Only Claude's
   * file showing idle after it, or a laptop prompt, clears the uncertainty.
   */
  uncertainSince?: number;
}

const OUTPUT_QUIET_MS = 500;
const READY_WAIT_MS = 60_000;
const COMPACT_MS = 180_000;
const DIALOG_MS = 5000;
const RESULT_MS = 10_000;
const RECOVERY_QUIET_MS = 1000;
/** A TUI that never goes quiet still ends the recovery. */
const RECOVERY_CAP_MS = 5000;
const POLL_MS = 100;
const MAX_TEXT_BYTES = 16 * 1024;
const CLAUDE_MODELS: ReadonlySet<string> = new Set(["opus", "sonnet", "haiku"]);
const DIALOG_MARKER = "Switch model?";
const RESULT_MARKER = "Set model to";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ESC = "\x1b";

/**
 * The readiness rule for one read of Claude's sessions file: it says idle and,
 * when `after` is given, it was written later than `after`.
 */
export function sessionReady(file: { status: string; statusUpdatedAt?: number } | undefined, after?: number): boolean {
  if (!file || file.status !== "idle") {
    return false;
  }
  return after === undefined || (typeof file.statusUpdatedAt === "number" && file.statusUpdatedAt > after);
}

/** Glasses text as one paste: nothing in it can end the paste or act as a key. */
function pasteText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

type Phase = "waiting" | "dialog" | "confirm" | "recovering" | "compacting";

interface Active {
  cmd: TypeCommand;
  resolve: (result: TypistResult) => void;
  settled: boolean;
  phase: Phase;
  deadline: number;
  scanner?: OutputScanner;
  writtenAt?: number;
  escAt?: number;
}

export interface TypistOptions {
  binding: BindingView;
  /** Right after a command's first write; `at` is the clock's time of the write. */
  onWritten?: (cmdId: string, at: number) => void;
}

/**
 * Types glasses commands into the Claude prompt, one at a time. A command's
 * first write waits until the prompt is ready (R50, R55); its later writes
 * follow only what the command's own scanner sees. From the first write until
 * the command completes the user's keys are held; keys held by then wait for
 * the prompt to be positively ready again, unless a model result proved it
 * (R142). A text command, or a compact agentd cancelled, holds nothing past
 * its end when nothing was held (R143, R148).
 */
export class Typist {
  private active?: Active;
  /** The first write of the last command whose held keys still wait for positive readiness. */
  private releaseAfter?: number;
  private lastOutputAt: number;
  /** The last command's first write, which an uncertainty agentd reports dates from. */
  private lastWrittenAt?: number;
  private timer?: unknown;
  private replayTimer?: unknown;
  private exited = false;
  private disposed = false;

  constructor(
    private readonly pty: PtyChild,
    private readonly input: LaptopInput,
    /** The owned sessions file reads idle (and, given `after`, was written after it). */
    private readonly ready: (after?: number) => boolean,
    private readonly clock: Clock,
    private readonly options: TypistOptions,
  ) {
    this.lastOutputAt = clock.now();
    pty.onData((chunk) => {
      this.lastOutputAt = this.clock.now();
      this.active?.scanner?.push(chunk);
      this.step();
    });
    pty.onExit(() => this.onExit());
    input.onTakeover(() => this.onTakeover());
    input.dropHeldWhile(() => this.dialogMayBeOpen());
  }

  run(cmd: TypeCommand): Promise<TypistResult> {
    if (this.active) {
      return Promise.resolve({ ok: false, error: "busy" });
    }
    if (this.exited || this.disposed) {
      return Promise.resolve({ ok: false, error: "exited" });
    }
    if (!this.typeable(cmd)) {
      return Promise.resolve({ ok: false, error: "not_ready" });
    }
    return new Promise((resolve) => {
      this.active = { cmd, resolve, settled: false, phase: "waiting", deadline: this.clock.now() + READY_WAIT_MS };
      this.step();
    });
  }

  cancel(cmdId: string): void {
    const active = this.active;
    if (!active || active.cmd.cmdId !== cmdId) {
      return;
    }
    if (active.phase === "dialog" || active.phase === "confirm") {
      // The dialog may be open: Esc, and nothing else.
      this.pty.write(ESC);
      this.markUncertain(active.writtenAt);
    } else if (active.phase === "recovering") {
      this.markUncertain(active.writtenAt);
    }
    this.settle(active, "cancelled");
    // R148: a compact agentd gave up on stops owning input at once.
    this.end(active, active.phase === "compacting" ? "unless_held" : "when_ready");
    this.step();
  }

  /**
   * R160: the link to agentd is gone, so nothing will ever end the command in
   * flight, a compact past its ok included. It stops owning input at once.
   */
  cancelActive(): void {
    if (this.active) {
      this.cancel(this.active.cmd.cmdId);
    }
  }

  /**
   * R161: the binding is uncertain, from the launcher's own failure or from
   * agentd's word; it dates from `since`, or the last command's write.
   */
  markUncertain(since?: number): void {
    const binding = this.options.binding;
    const at = since ?? this.lastWrittenAt ?? this.clock.now();
    binding.uncertainSince = binding.uncertain ? Math.max(binding.uncertainSince ?? at, at) : at;
    binding.uncertain = true;
  }

  /** R161: still uncertain, unless Claude's own file has since shown it idle. */
  uncertain(): boolean {
    const binding = this.options.binding;
    if (binding.uncertain && binding.uncertainSince !== undefined && this.ready(binding.uncertainSince)) {
      binding.uncertain = false;
      binding.uncertainSince = undefined;
    }
    return binding.uncertain;
  }

  /** R161: a laptop prompt is positive proof the wearer dealt with whatever was on screen. */
  clearUncertain(): void {
    this.options.binding.uncertain = false;
    this.options.binding.uncertainSince = undefined;
  }

  /** agentd's correlated PostCompact for this compact. */
  compactDone(cmdId: string): void {
    const active = this.active;
    if (active?.cmd.cmdId === cmdId && active.phase === "compacting") {
      this.end(active);
      this.step();
    }
  }

  /** Stops for good: a command still running fails `exited`, and nothing is held any more. */
  dispose(): void {
    this.disposed = true;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.clock.clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    this.releaseAfter = undefined;
    const active = this.active;
    this.active = undefined;
    if (active) {
      this.settle(active, "exited");
    }
    this.input.flushHeld();
  }

  private typeable(cmd: TypeCommand): boolean {
    switch (cmd.command) {
      case "compact":
        return true;
      case "model":
        return typeof cmd.model === "string" && CLAUDE_MODELS.has(cmd.model);
      case "text":
        return typeof cmd.text === "string" && Buffer.byteLength(pasteText(cmd.text)) <= MAX_TEXT_BYTES;
      default:
        return false;
    }
  }

  private step(): void {
    if (this.disposed || this.exited) {
      return;
    }
    const now = this.clock.now();
    // Held keys go before any new command's first write.
    this.tryRelease();
    const active = this.active;
    if (active) {
      switch (active.phase) {
        case "waiting":
          this.stepWaiting(active, now);
          break;
        case "dialog":
          if (this.stale(active)) {
            this.cancel(active.cmd.cmdId);
          } else if (active.scanner?.seen(DIALOG_MARKER)) {
            // The result must come from output after the confirm.
            active.scanner = new OutputScanner();
            active.phase = "confirm";
            active.deadline = now + RESULT_MS;
            this.pty.write("\r");
          } else if (now >= active.deadline) {
            this.recover(active, now);
          }
          break;
        case "confirm":
          if (this.stale(active)) {
            this.cancel(active.cmd.cmdId);
          } else if (active.scanner?.seen(RESULT_MARKER)) {
            // R142: the result line is positive proof the prompt is free again.
            this.settle(active);
            this.end(active, "now");
          } else if (now >= active.deadline) {
            this.recover(active, now);
          }
          break;
        case "recovering":
          if (now - Math.max(this.lastOutputAt, active.escAt ?? now) >= RECOVERY_QUIET_MS || now >= active.deadline) {
            this.settle(active, "dialog_not_seen");
            this.end(active);
          }
          break;
        case "compacting":
          if (now >= active.deadline) {
            this.end(active);
            this.tryRelease();
          }
          break;
      }
    }
    this.schedule();
  }

  /** A later write is for the binding the command was sent on, or for nothing. */
  private stale(active: Active): boolean {
    return active.cmd.gen !== this.options.binding.gen;
  }

  private stepWaiting(active: Active, now: number): void {
    const binding = this.options.binding;
    if (active.cmd.gen !== binding.gen) {
      this.settle(active, "cancelled");
      this.end(active);
      return;
    }
    if (this.uncertain()) {
      this.settle(active, "uncertain");
      this.end(active);
      return;
    }
    if (
      !this.input.holding &&
      !this.input.draft &&
      now - this.lastOutputAt >= OUTPUT_QUIET_MS &&
      this.ready(active.cmd.notBefore)
    ) {
      this.firstWrite(active, now);
    } else if (now >= active.deadline) {
      this.settle(active, this.input.draft ? "laptop_draft" : "busy");
      this.end(active);
    }
  }

  private firstWrite(active: Active, now: number): void {
    const { cmd } = active;
    active.writtenAt = now;
    this.lastWrittenAt = now;
    active.scanner = new OutputScanner();
    this.input.hold();
    switch (cmd.command) {
      case "compact":
        this.pty.write("/compact\r");
        active.phase = "compacting";
        active.deadline = now + COMPACT_MS;
        this.settle(active);
        break;
      case "model":
        this.pty.write(`/model ${cmd.model}\r`);
        active.phase = "dialog";
        active.deadline = now + DIALOG_MS;
        break;
      case "text":
        this.pty.write(`${PASTE_START}${pasteText(cmd.text ?? "")}${PASTE_END}\r`);
        this.settle(active);
        // R143: the keyboard is never frozen for the turn this text starts.
        this.end(active, "unless_held");
        break;
    }
    this.options.onWritten?.(cmd.cmdId, now);
  }

  /** Model recovery: Esc, a second of quiet, then `dialog_not_seen`. Esc success is never assumed. */
  private recover(active: Active, now: number): void {
    this.pty.write(ESC);
    active.phase = "recovering";
    active.escAt = now;
    active.deadline = now + RECOVERY_CAP_MS;
  }

  private settle(active: Active, error?: CommandError): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    if (error === "dialog_not_seen") {
      this.markUncertain(active.writtenAt);
    }
    active.resolve(error ? { ok: false, error } : { ok: true });
  }

  /**
   * The command no longer owns input. Holding then ends as `release` says:
   * - `when_ready`: once the prompt is positively ready (the brief's rule);
   * - `unless_held`: at once when no key was held, otherwise when ready;
   * - `now`: at once, replaying the held keys.
   */
  private end(active: Active, release: "when_ready" | "unless_held" | "now" = "when_ready"): void {
    if (this.active !== active) {
      return;
    }
    this.active = undefined;
    if (active.writtenAt === undefined || !this.input.holding) {
      return;
    }
    if (release === "now" || (release === "unless_held" && !this.input.hasHeld)) {
      this.releaseAfter = undefined;
      const held = this.input.flushHeld();
      if (held) {
        this.pty.write(held);
      }
      return;
    }
    this.releaseAfter = active.writtenAt;
  }

  /** Positive readiness: idle, written after the command's first write, and the binding not uncertain. */
  private tryRelease(): void {
    const after = this.releaseAfter;
    if (after === undefined) {
      return;
    }
    if (!this.input.holding) {
      this.releaseAfter = undefined;
      return;
    }
    if (this.uncertain() || !this.ready(after)) {
      return;
    }
    this.releaseAfter = undefined;
    const held = this.input.flushHeld();
    if (held) {
      this.pty.write(held);
    }
  }

  /**
   * A `/model` dialog may be on screen: the command's own, or one an
   * uncertainty says may still be. A held Enter replayed into it would confirm
   * whatever it shows (R151).
   */
  private dialogMayBeOpen(): boolean {
    const active = this.active;
    if (active?.cmd.command === "model" && active.writtenAt !== undefined) {
      return true;
    }
    return this.options.binding.uncertain;
  }

  private onTakeover(): void {
    const active = this.active;
    if (active?.writtenAt !== undefined) {
      this.settle(active, "taken_over");
      this.end(active);
    }
    this.releaseAfter = undefined;
    if (this.input.replayPending) {
      // R151: the takeover key has gone alone; the held keys follow after the gap.
      this.clock.clearTimeout(this.replayTimer);
      this.replayTimer = this.clock.setTimeout(() => {
        this.replayTimer = undefined;
        if (this.disposed || this.exited || !this.input.replayPending) {
          return;
        }
        const held = this.input.flushHeld();
        if (held) {
          this.pty.write(held);
        }
        this.step();
      }, REPLAY_GAP_MS);
    }
  }

  private onExit(): void {
    this.exited = true;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.clock.clearTimeout(this.replayTimer);
    this.replayTimer = undefined;
    this.releaseAfter = undefined;
    const active = this.active;
    if (active) {
      this.settle(active, "exited");
      this.active = undefined;
    }
  }

  private schedule(): void {
    if (this.timer !== undefined || this.disposed || this.exited) {
      return;
    }
    if (!this.active && this.releaseAfter === undefined) {
      return;
    }
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      this.step();
    }, POLL_MS);
  }
}
