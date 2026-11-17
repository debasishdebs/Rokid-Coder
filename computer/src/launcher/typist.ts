import { REPLAY_GAP_MS, type LaptopInput } from "./laptop-input";
import type { CommandError, TypeCommand } from "./launcher-hub";
import { OutputScanner } from "./output-scanner";
import { bgReplyText, pasteText } from "./paste-text";
import type { PtyChild } from "./pty";
import { probe, showsCleared, showsEmptyPrompt, showsText, type ScreenModel } from "./screen-probe";

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
/** Ctrl+U: clears the input line, and does nothing a dialog would take as an answer. */
const CLEAR_LINE = "\x15";
/** agentd's answer to a write check may take this long; no answer is a no. */
const BG_VERDICT_MS = 2000;
/** The pasted text must be seen on Claude's input line within this long, or it is cleared. */
const BG_CONFIRM_MS = 1500;
/** A positive look at the screen counts only when a second one this much later agrees. */
const BG_STABLE_MS = 40;
/** After Ctrl+U the input line is looked at for this long to see the text gone. */
const BG_CLEAR_MS = 1500;

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

type Phase =
  | "waiting"
  | "dialog"
  | "confirm"
  | "recovering"
  | "compacting"
  // A background reply: asked agentd to allow the paste, pasted and looking
  // for it on screen, asked agentd to allow the Enter, clearing a paste away.
  | "bg_ask_paste"
  | "bg_pasted"
  | "bg_ask_enter"
  | "bg_clearing";

interface Active {
  cmd: TypeCommand;
  resolve: (result: TypistResult) => void;
  settled: boolean;
  phase: Phase;
  deadline: number;
  scanner?: OutputScanner;
  writtenAt?: number;
  escAt?: number;
  /** A background reply: the sanitised text it pastes. */
  bgText?: string;
  /** When the screen first showed what the background reply waits for; a second look must agree. */
  seenAt?: number;
  /** `screen.taints` when the paste went out (or the clearing began); a later one fails closed. */
  mark?: number;
}

export interface TypistOptions {
  binding: BindingView;
  /** Right after a command's first write; `at` is the clock's time of the write. */
  onWritten?: (cmdId: string, at: number) => void;
  /**
   * What a background reply (`bgReply`) needs and nothing else supplies: the
   * screen model of Claude's terminal, Claude's own file status right now, and
   * the question to agentd, which alone holds the evidence the reply rests on,
   * "may I write?" before the paste and again before the Enter (answered by
   * `verdict`). Without them a background reply is never typed.
   */
  bg?: {
    screen: ScreenModel;
    fileStatus: () => string | undefined;
    askWrite: (cmdId: string, phase: "paste" | "enter") => void;
  };
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
      this.options.bg?.screen.push(chunk);
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
    if (active.phase === "bg_pasted" || active.phase === "bg_ask_enter") {
      this.bgAbort(active, "cancelled");
      this.step();
      return;
    }
    if (active.phase === "bg_clearing") {
      return; // already giving up; the clearing finishes on its own
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

  /** R161: still uncertain, unless Claude's own file, as `ready` reads it, has since shown it idle. */
  uncertain(ready: (after?: number) => boolean = this.ready): boolean {
    const binding = this.options.binding;
    if (binding.uncertain && binding.uncertainSince !== undefined && ready(binding.uncertainSince)) {
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
    if (cmd.bgReply && cmd.command !== "text") {
      return false;
    }
    switch (cmd.command) {
      case "compact":
        return true;
      case "model":
        return typeof cmd.model === "string" && CLAUDE_MODELS.has(cmd.model);
      case "text":
        if (cmd.bgReply) {
          return this.options.bg !== undefined && bgReplyText(cmd.text) !== undefined;
        }
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
        case "bg_ask_paste":
          // Only the verdict moves it on; no answer is a no.
          if (this.stale(active)) {
            this.settle(active, "cancelled");
            this.end(active);
          } else if (now >= active.deadline) {
            this.settle(active, "busy");
            this.end(active);
          }
          break;
        case "bg_pasted":
          this.stepBgPasted(active, now);
          break;
        case "bg_ask_enter":
          if (this.stale(active)) {
            this.bgAbort(active, "cancelled");
          } else if (now >= active.deadline) {
            this.bgAbort(active, "not_sent");
          }
          break;
        case "bg_clearing":
          this.stepBgClearing(active, now);
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
    if (active.cmd.bgReply) {
      this.stepBgWaiting(active, now);
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

  /**
   * A background reply is not waited on by Claude's file going idle (it stays
   * busy for as long as the subagent lives) and not by the output going quiet
   * (a spinner never lets it). It is allowed only while Claude's file reads
   * `busy` and the screen positively shows the framed input box VISIBLY EMPTY,
   * with no dialog, question, follow-up text or running-turn sign, on two looks
   * 40 ms apart; then agentd, which alone holds the rest of the evidence, is
   * asked to allow the paste. A box that shows anything else, on two looks, gets
   * nothing sent and the retryable `not_sent`.
   */
  private stepBgWaiting(active: Active, now: number): void {
    const boundary = this.bgBoundary();
    if (boundary === "open" || boundary === "full") {
      active.seenAt ??= now;
      if (now - active.seenAt >= BG_STABLE_MS) {
        active.seenAt = undefined;
        if (boundary === "full") {
          this.settle(active, "not_sent");
          this.end(active);
          return;
        }
        active.phase = "bg_ask_paste";
        active.deadline = now + BG_VERDICT_MS;
        this.options.bg?.askWrite(active.cmd.cmdId, "paste");
        return;
      }
    } else {
      active.seenAt = undefined;
    }
    if (now >= active.deadline) {
      this.settle(active, this.input.draft ? "laptop_draft" : "busy");
      this.end(active);
    }
  }

  /**
   * Whether the first byte may go. "open": nothing of the laptop's is in the
   * way, Claude's file reads busy and the screen shows the prompt box visibly
   * empty. "full": all of that but the screen shows something else, a
   * dialog, a menu, a running turn or text in the box. "closed": anything else.
   */
  private bgBoundary(): "open" | "full" | "closed" {
    const bg = this.options.bg;
    if (!bg || this.input.holding || this.input.draft || bg.fileStatus() !== "busy") {
      return "closed";
    }
    const seen = probe(bg.screen);
    if (seen.kind === "unknown") {
      return "closed";
    }
    return showsEmptyPrompt(seen) ? "open" : "full";
  }

  /** agentd's answer to a write check. Anything but a clear yes, or a yes for a phase not being asked, is a no. */
  verdict(cmdId: string, phase: "paste" | "enter", ok: boolean): void {
    const active = this.active;
    if (!active || active.cmd.cmdId !== cmdId || this.disposed || this.exited) {
      return;
    }
    if (phase === "paste" && active.phase === "bg_ask_paste") {
      if (ok === true && !this.stale(active) && !this.uncertain() && this.bgBoundary() === "open") {
        this.bgPaste(active, this.clock.now());
      } else {
        // Agentd's no is a busy; its yes against a boundary that has since closed is a reply not sent.
        this.settle(active, ok !== true ? "busy" : this.stale(active) ? "cancelled" : "not_sent");
        this.end(active);
      }
    } else if (phase === "enter" && active.phase === "bg_ask_enter") {
      if (ok === true && !this.stale(active) && this.bgStillShows(active)) {
        this.bgEnter(active);
      } else {
        this.bgAbort(active, "not_sent");
      }
    }
    this.step();
  }

  /** The text, whole, on the input line; nothing disturbed the screen since it was pasted; Claude's file still busy. */
  private bgStillShows(active: Active): boolean {
    const bg = this.options.bg;
    if (!bg || active.bgText === undefined || bg.fileStatus() !== "busy") {
      return false;
    }
    return showsText(probe(bg.screen, { sinceTaints: active.mark }), active.bgText);
  }

  /** One bracketed paste and no Enter. */
  private bgPaste(active: Active, now: number): void {
    const bg = this.options.bg;
    const text = bgReplyText(active.cmd.text);
    if (!bg || text === undefined) {
      this.settle(active, "not_ready");
      this.end(active);
      return;
    }
    active.bgText = text;
    active.writtenAt = now;
    this.lastWrittenAt = now;
    active.mark = bg.screen.taints;
    active.seenAt = undefined;
    this.input.hold();
    this.pty.write(`${PASTE_START}${text}${PASTE_END}`);
    active.phase = "bg_pasted";
    active.deadline = now + BG_CONFIRM_MS;
    this.options.onWritten?.(active.cmd.cmdId, now);
  }

  /** Waits for the pasted text to be seen on the input line, twice; nothing else lets the Enter go. */
  private stepBgPasted(active: Active, now: number): void {
    const bg = this.options.bg;
    if (!bg || active.bgText === undefined || this.stale(active)) {
      this.bgAbort(active, this.stale(active) ? "cancelled" : "not_sent");
      return;
    }
    const seen = probe(bg.screen, { sinceTaints: active.mark });
    if (showsText(seen, active.bgText)) {
      active.seenAt ??= now;
      if (now - active.seenAt >= BG_STABLE_MS) {
        active.seenAt = undefined;
        active.phase = "bg_ask_enter";
        active.deadline = now + BG_VERDICT_MS;
        this.options.bg?.askWrite(active.cmd.cmdId, "enter");
      }
      return;
    }
    active.seenAt = undefined;
    const lost = seen.kind === "blocked" || (seen.kind === "unknown" && seen.reason === "screen_disturbed");
    if (lost || now >= active.deadline) {
      this.bgAbort(active, "not_sent");
    }
  }

  private bgEnter(active: Active): void {
    this.pty.write("\r");
    this.settle(active);
    // Held keys go on now: Claude's file may stay busy for hours, so waiting for it to read idle would freeze the keyboard.
    this.end(active, "now");
  }

  /**
   * The paste is not going to be submitted. Ctrl+U clears an input line and
   * is harmless in a dialog; the command fails `not_sent` (or as given), and
   * the input line is then looked at: unless the text is positively gone the
   * prompt is uncertain, and nothing more is typed until it is not.
   */
  private bgAbort(active: Active, error: CommandError): void {
    this.pty.write(CLEAR_LINE);
    this.settle(active, error);
    active.phase = "bg_clearing";
    active.deadline = this.clock.now() + BG_CLEAR_MS;
    active.mark = this.options.bg?.screen.taints;
    active.seenAt = undefined;
  }

  private stepBgClearing(active: Active, now: number): void {
    const bg = this.options.bg;
    const cleared =
      bg !== undefined &&
      active.bgText !== undefined &&
      showsCleared(probe(bg.screen, { sinceTaints: active.mark }), active.bgText);
    if (cleared) {
      this.end(active, "now");
    } else if (now >= active.deadline) {
      this.markUncertain(active.writtenAt);
      this.end(active);
    }
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
    if (active?.phase === "bg_pasted" || active?.phase === "bg_ask_enter") {
      // The wearer's key reached the prompt beside the paste: it is not submitted.
      this.bgAbort(active, "taken_over");
    } else if (active?.writtenAt !== undefined && active.phase !== "bg_clearing") {
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
