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

/** Control keys that only move the cursor, redraw, or remove text: they never make an empty prompt non-empty. */
const NEUTRAL_CONTROLS = new Set(["\x01", "\x02", "\x04", "\x05", "\x06", "\x0b", "\x0c", "\x15", "\x17", "\x1a"]);
const NEUTRAL_FINALS = new Set(["C", "D", "H", "F", "I", "O"]);

/**
 * Follows one key stream for the draft rule. Prompt contents are not
 * observable, so it is conservative: anything that could put text in the
 * prompt sets the draft, and only Enter or Ctrl-C clears it.
 */
class DraftTracker {
  draft = false;
  private inPaste = false;

  clone(): DraftTracker {
    const copy = new DraftTracker();
    copy.draft = this.draft;
    copy.inPaste = this.inPaste;
    return copy;
  }

  /** Applies `data`; says whether it held a bare Esc or a Ctrl-C, outside a paste. */
  feed(data: string): { takeover: boolean } {
    let takeover = false;
    let i = 0;
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        this.draft = true;
        if (end < 0) {
          break;
        }
        this.inPaste = false;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = data[i];
      if (ch === ESC) {
        const next = data[i + 1];
        if (next === "[") {
          const match = /^\x1b\[([0-9;?]*)[ -/]*([@-~])/.exec(data.slice(i));
          if (!match) {
            this.draft = true; // an unfinished sequence: assume the worst
            break;
          }
          if (match[1] === "200" && match[2] === "~") {
            this.inPaste = true;
            this.draft = true;
          } else if (!NEUTRAL_FINALS.has(match[2])) {
            this.draft = true; // Up/Down recall history; Delete and the rest edit
          }
          i += match[0].length;
          continue;
        }
        if (next === "O" && i + 2 < data.length) {
          if (!NEUTRAL_FINALS.has(data[i + 2])) {
            this.draft = true;
          }
          i += 3;
          continue;
        }
        takeover = true; // a bare Esc (or Alt with a key, which starts with one)
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.draft = false;
      } else if (ch === "\x03") {
        this.draft = false;
        takeover = true;
      } else if (ch >= " " || !NEUTRAL_CONTROLS.has(ch)) {
        // Printable, Tab, Backspace, newline, and any control key not known to be harmless.
        this.draft = true;
      }
      i += 1;
    }
    return { takeover };
  }
}

/**
 * The user's keyboard. While automation owns input the keys are held, except
 * that Esc or Ctrl-C is a takeover: it passes, and the held keys are the
 * user's again. `draft` describes the prompt as it will be once every held
 * key has been delivered.
 */
export class LaptopInput {
  private delivered = new DraftTracker();
  /** Set while holding: the delivered state with the held keys applied. */
  private projected?: DraftTracker;
  private held = "";
  private readonly takeoverListeners: Array<() => void> = [];
  private readonly draftListeners: Array<(draft: boolean) => void> = [];

  get draft(): boolean {
    return (this.projected ?? this.delivered).draft;
  }

  get holding(): boolean {
    return this.projected !== undefined;
  }

  key(data: string): "pass" | "hold" {
    const before = this.draft;
    if (!this.projected) {
      this.delivered.feed(data);
      this.notify(before);
      return "pass";
    }
    const probe = this.projected.clone();
    if (probe.feed(data).takeover) {
      // The key goes first, then the held keys are replayed after it.
      this.delivered.feed(data);
      this.delivered.feed(this.held);
      this.projected = undefined;
      for (const cb of [...this.takeoverListeners]) {
        cb();
      }
      this.notify(before);
      return "pass";
    }
    this.projected = probe;
    this.held += data;
    this.notify(before);
    return "hold";
  }

  /** Automation takes input: keys are held from now on. */
  hold(): void {
    if (!this.projected) {
      this.projected = this.delivered.clone();
    }
  }

  /** Ends holding and returns the held keys, which the caller must write next. */
  flushHeld(): string {
    if (this.projected) {
      this.delivered = this.projected;
      this.projected = undefined;
    }
    const held = this.held;
    this.held = "";
    return held;
  }

  onTakeover(cb: () => void): void {
    this.takeoverListeners.push(cb);
  }

  onDraftChange(cb: (draft: boolean) => void): void {
    this.draftListeners.push(cb);
  }

  private notify(before: boolean): void {
    if (this.draft !== before) {
      for (const cb of [...this.draftListeners]) {
        cb(this.draft);
      }
    }
  }
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
 * the command completes, and then until the prompt is positively ready again,
 * the user's keys are held.
 */
export class Typist {
  private active?: Active;
  /** The first write of the last command whose held keys still wait for positive readiness. */
  private releaseAfter?: number;
  private lastOutputAt: number;
  private timer?: unknown;
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
      this.options.binding.uncertain = true;
    } else if (active.phase === "recovering") {
      this.options.binding.uncertain = true;
    }
    this.settle(active, "cancelled");
    this.end(active);
    this.step();
  }

  /** agentd's correlated PostCompact for this compact. */
  compactDone(cmdId: string): void {
    const active = this.active;
    if (active?.cmd.cmdId === cmdId && active.phase === "compacting") {
      this.end(active);
      this.step();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
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
            this.settle(active);
            this.end(active);
            this.tryRelease();
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
    if (binding.uncertain) {
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
        this.end(active);
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
      this.options.binding.uncertain = true;
    }
    active.resolve(error ? { ok: false, error } : { ok: true });
  }

  /** The command no longer owns input; any held keys wait for positive readiness. */
  private end(active: Active): void {
    if (this.active !== active) {
      return;
    }
    this.active = undefined;
    if (active.writtenAt !== undefined && this.input.holding) {
      this.releaseAfter = active.writtenAt;
    }
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
    if (this.options.binding.uncertain || !this.ready(after)) {
      return;
    }
    this.releaseAfter = undefined;
    const held = this.input.flushHeld();
    if (held) {
      this.pty.write(held);
    }
  }

  private onTakeover(): void {
    this.releaseAfter = undefined;
    const active = this.active;
    if (active?.writtenAt !== undefined) {
      this.settle(active, "taken_over");
      this.end(active);
    }
  }

  private onExit(): void {
    this.exited = true;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
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
