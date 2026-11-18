import { readClaudeSession, type ClaudeSessionFile } from "./claude-sessions";
import type { TypeCommand } from "./launcher-hub";
import type { PtyChild } from "./pty";
import { ScreenModel, probe, showsEmptyPrompt } from "./screen-probe";
import { LaptopInput, sessionBusySince } from "./laptop-input";
import { Typist, sessionReady, systemClock, type BindingView, type Clock } from "./typist";

type Frame = Record<string, unknown>;

const CMD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COMMANDS: ReadonlySet<string> = new Set(["compact", "model", "text"]);
/** `laptop_state` goes out on change, at most this often. */
const DRAFT_REPORT_MS = 250;
/**
 * The key stream alone says a draft exists after any key that might type, but
 * never sees the prompt. While it says so the screen is looked at this often,
 * and the draft is let go only when the prompt box is visibly empty on two
 * looks, no sooner than DRAFT_SETTLE_MS after the last key (a typed character
 * is on screen well within that, and a stray Esc or Tab never is).
 */
const DRAFT_LOOK_MS = 250;
const DRAFT_SETTLE_MS = 1000;
/**
 * A look at the screen proves nothing unless the screen has had the chance to
 * show the key. Two kinds of evidence, and the trade-off between them:
 * - Claude drew something after the last key (any output reaching the model
 *   since), and the box is still empty after that. A key Claude echoes (a
 *   printable one, a Backspace) needs this and nothing else: no output after
 *   it means the echo may still be coming, however long that takes.
 * - A key Claude never echoes (Esc, Tab, an arrow) draws nothing, so there is
 *   no output to wait for. It is let go after DRAFT_QUIET_MS without a key, and
 *   only while Claude's own sessions file says `idle`: a busy or unknown
 *   session might still be about to draw. The cost is that a stray Esc in a
 *   busy session with nothing being drawn keeps the false draft until Claude
 *   draws something or goes idle; the alternative is a reply queued behind
 *   text the wearer typed.
 */
const DRAFT_QUIET_MS = 5000;

export interface LauncherClientOptions {
  child: PtyChild;
  /** Writes a frame to agentd, or drops it while the link is down. */
  send: (frame: Frame) => void;
  /** The launcher's binding copy; rk keeps it current from `bind_accepted` and `binding_state`. */
  binding: BindingView;
  sessionsDir: string;
  clock?: Clock;
  /** The terminal's size, which the screen model needs to read Claude's layout. */
  size?: { cols: number; rows: number };
}

/**
 * Whether keys put something on Claude's screen: a printable character or a
 * Backspace outside any escape sequence. Esc, Tab, arrows and the like draw nothing.
 */
function keyEchoes(data: string): boolean {
  const plain = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b[O\]P^_X][^\x1b]*?(?:\x07|\x1b\\|[@-~])|\x1b./g, "");
  return /[\x20-\x7e\x7f -￿]/.test(plain);
}

function asTypeCommand(frame: Frame): TypeCommand | undefined {
  const { cmdId, gen, notBefore, bgReply, command, model, text } = frame;
  if (
    typeof cmdId !== "string" ||
    !Number.isInteger(gen) ||
    typeof command !== "string" ||
    !COMMANDS.has(command) ||
    (notBefore !== undefined && (typeof notBefore !== "number" || !Number.isFinite(notBefore))) ||
    (bgReply !== undefined && bgReply !== true) ||
    (model !== undefined && typeof model !== "string") ||
    (text !== undefined && typeof text !== "string")
  ) {
    return undefined;
  }
  return {
    cmdId,
    gen: gen as number,
    command: command as TypeCommand["command"],
    ...(notBefore !== undefined ? { notBefore } : {}),
    ...(bgReply === true ? { bgReply } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * The typist side of `rk claude`: the keyboard goes through `LaptopInput`,
 * agentd's `type_command` goes to the `Typist`, and results, first writes and
 * draft changes go back. A command belongs to the connection it came on; once
 * that connection is gone it is cancelled and its result is not sent.
 */
export class LauncherClient {
  readonly input: LaptopInput;
  private readonly typist: Typist;
  private readonly child: PtyChild;
  private readonly send: (frame: Frame) => void;
  private readonly clock: Clock;
  private readonly sessionsDir: string;
  /** The session the bind poll last found. */
  private polled?: { sessionId: string; pid: number };
  /** The session agentd accepted; readiness reads only its file. */
  private owned?: { sessionId: string; pid: number };
  private epoch = 0;
  private running?: { cmdId: string; epoch: number };
  private readonly screen: ScreenModel;
  private reportedDraft = false;
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private reportTimer?: unknown;
  private lastKeyAt = Number.NEGATIVE_INFINITY;
  /** Claude drew something after the last key, so the screen has had its chance to show it. */
  private outputAfterKey = false;
  /** A key of this draft is one Claude echoes (printable, Backspace), so only a redraw can show it gone. */
  private echoingKey = false;
  /** Claude's own sessions-file status for the bound session, or undefined when unknown. */
  private readonly fileStatus: () => string | undefined;
  private draftTimer?: unknown;
  /** When the screen first showed the prompt box visibly empty during this draft; a second look must agree. */
  private emptySeenAt?: number;
  /** The last decision sent to the log, so a poll that finds the same thing says nothing. */
  private draftLogged?: string;

  constructor(options: LauncherClientOptions) {
    this.child = options.child;
    this.send = options.send;
    this.clock = options.clock ?? systemClock;
    this.sessionsDir = options.sessionsDir;
    const readOwned = (): ClaudeSessionFile | undefined => {
      const owned = this.owned;
      const file = owned ? readClaudeSession(options.sessionsDir, owned.pid) : undefined;
      return file?.sessionId === owned?.sessionId ? file : undefined;
    };
    this.fileStatus = () => readOwned()?.status;
    options.child.onData(() => {
      this.outputAfterKey = true;
    });
    const ready = (after?: number): boolean => sessionReady(readOwned(), after);
    this.input = new LaptopInput({ clock: this.clock, busySince: (at) => sessionBusySince(readOwned(), at) });
    this.screen = new ScreenModel(options.size?.cols ?? 80, options.size?.rows ?? 24);
    this.typist = new Typist(options.child, this.input, ready, this.clock, {
      binding: options.binding,
      bg: {
        screen: this.screen,
        fileStatus: () => readOwned()?.status,
        askWrite: (cmdId, phase) => {
          // Only the command agentd is waiting on is ever asked about.
          if (this.running?.cmdId === cmdId && this.running.epoch === this.epoch) {
            this.send({ type: "write_check", cmdId, phase });
          }
        },
      },
      onWritten: (cmdId, at) => {
        if (this.running?.cmdId === cmdId && this.running.epoch === this.epoch) {
          this.send({ type: "command_written", cmdId, at });
        }
      },
    });
    this.input.onDraftChange(() => {
      this.reportDraft();
      this.watchDraft();
    });
  }

  /** The terminal was resized. */
  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  /** Bytes from the user's terminal. */
  onStdin(data: string): void {
    // After a takeover the typist replays the held keys, a gap after this one (R151).
    this.lastKeyAt = this.clock.now();
    this.outputAfterKey = false;
    this.echoingKey ||= keyEchoes(data);
    this.emptySeenAt = undefined;
    const now = this.input.key(data);
    if (now) {
      this.child.write(now);
    }
  }

  /**
   * While the key stream says there is a draft, looks at the screen on a timer.
   * The screen model is fed Claude's output for the whole session (the typist
   * subscribes in its constructor), not only while a reply is in flight.
   */
  private watchDraft(): void {
    if (!this.input.draft) {
      this.emptySeenAt = undefined;
      this.draftLogged = undefined;
      this.echoingKey = false;
      return;
    }
    if (this.draftTimer === undefined) {
      this.draftTimer = this.clock.setTimeout(() => {
        this.draftTimer = undefined;
        this.reviewDraft();
      }, DRAFT_LOOK_MS);
    }
  }

  /**
   * Lets a draft go only on positive evidence that the prompt box is empty: the
   * screen model is not tainted, the probe finds the framed box with nothing on
   * its input line but muted text (a placeholder or a suggestion), no dialog is
   * up, and a second look agrees. Anything else, a failure to read the screen
   * included, keeps the draft as the key stream had it.
   */
  private reviewDraft(): void {
    if (!this.input.draft) {
      this.watchDraft();
      return;
    }
    const now = this.clock.now();
    if (now - this.lastKeyAt < DRAFT_SETTLE_MS || this.input.holding) {
      this.emptySeenAt = undefined;
      this.watchDraft();
      return;
    }
    // A screen drawn before the key cannot show the key: no evidence yet, so the draft stands.
    const evidence =
      this.outputAfterKey ||
      (!this.echoingKey && now - this.lastKeyAt >= DRAFT_QUIET_MS && this.fileStatus() === "idle");
    if (!evidence) {
      this.emptySeenAt = undefined;
      this.logDraft(
        { probe: "none", reason: this.echoingKey ? "awaiting_echo" : "awaiting_quiet_idle", textLen: 0, tainted: this.screen.tainted },
        "kept",
      );
      this.watchDraft();
      return;
    }
    const seen = probe(this.screen);
    const empty = showsEmptyPrompt(seen);
    const look = {
      probe: seen.kind,
      reason: seen.kind === "prompt" ? (seen.empty ? "empty" : "text") : seen.reason,
      textLen: seen.kind === "prompt" ? seen.text.length : 0,
      tainted: this.screen.tainted,
    };
    if (!empty) {
      this.emptySeenAt = undefined;
      this.logDraft(look, "kept");
    } else if (this.emptySeenAt === undefined) {
      this.emptySeenAt = now;
    } else if (this.input.clearDraftFromScreen()) {
      this.emptySeenAt = undefined;
      this.logDraft(look, "cleared");
    }
    this.watchDraft();
  }

  /** One line for agentd's log when the decision changes: lengths and flags, never prompt text. */
  private logDraft(
    look: { probe: string; reason: string; textLen: number; tainted: boolean },
    decision: "kept" | "cleared",
  ): void {
    const signature = `${decision}|${look.probe}|${look.reason}|${look.textLen > 0}|${look.tainted}`;
    if (signature === this.draftLogged) {
      return;
    }
    this.draftLogged = signature;
    this.send({
      type: "draft_check",
      ...look,
      before: true,
      after: decision === "kept",
      decision,
    });
  }

  /** R161: agentd says the binding is uncertain; the launcher keeps that until it sees proof otherwise. */
  agentdUncertain(): void {
    this.typist.markUncertain();
  }

  /**
   * R161: the launcher's own uncertainty, after a fresh look at Claude's file.
   * N1: while unbound, as when it asks to bind after a link blip, that is the
   * file the bind poll found, so a flag Claude has since cleared is never sent.
   */
  uncertain(): boolean {
    if (this.owned) {
      return this.typist.uncertain();
    }
    const polled = this.polled;
    const file = polled ? readClaudeSession(this.sessionsDir, polled.pid) : undefined;
    return this.typist.uncertain((after) => sessionReady(file?.sessionId === polled?.sessionId ? file : undefined, after));
  }

  /** The owned session the bind poll found. It counts for readiness only once agentd accepts it. */
  setSession(session: ClaudeSessionFile): void {
    this.polled = { sessionId: session.sessionId, pid: session.pid };
  }

  /** The session agentd accepted the bind for, or undefined while none is bound. */
  onBound(sessionId: string | undefined): void {
    this.owned = sessionId !== undefined && this.polled !== undefined ? { sessionId, pid: this.polled.pid } : undefined;
  }

  /** The frames from agentd that are the typist's. Returns false for any other. */
  onFrame(frame: Frame): boolean {
    switch (frame.type) {
      case "type_command":
        this.onTypeCommand(frame);
        return true;
      case "cancel_command":
        if (typeof frame.cmdId === "string") {
          this.typist.cancel(frame.cmdId);
        }
        return true;
      case "write_verdict":
        // Anything but a well-formed yes is a no.
        if (
          typeof frame.cmdId === "string" &&
          (frame.phase === "paste" || frame.phase === "enter") &&
          this.running?.cmdId === frame.cmdId &&
          this.running.epoch === this.epoch
        ) {
          this.typist.verdict(frame.cmdId, frame.phase, frame.ok === true);
        }
        return true;
      case "compact_done":
        if (typeof frame.cmdId === "string") {
          this.typist.compactDone(frame.cmdId);
        }
        return true;
      case "prompt_submitted":
        // R149 and R161: Claude took a prompt typed at the laptop.
        if (typeof frame.at === "number" && Number.isFinite(frame.at)) {
          this.input.promptSubmitted(frame.at);
          this.typist.clearUncertain();
        }
        return true;
      default:
        return false;
    }
  }

  /** A new connection: agentd's copy of the draft starts false. */
  onLinkUp(): void {
    this.linkChanged();
    this.reportedDraft = false;
    this.lastReportAt = Number.NEGATIVE_INFINITY;
    this.reportDraft();
  }

  onLinkDown(): void {
    this.linkChanged();
  }

  dispose(): void {
    this.typist.dispose();
    this.input.dispose();
    this.clock.clearTimeout(this.reportTimer);
    this.clock.clearTimeout(this.draftTimer);
    this.draftTimer = undefined;
  }

  /** R160: whatever was in flight, past its result too, is abandoned with the link that sent it. */
  private linkChanged(): void {
    this.epoch += 1;
    this.running = undefined;
    this.typist.cancelActive();
  }

  private onTypeCommand(frame: Frame): void {
    const cmd = asTypeCommand(frame);
    if (!cmd) {
      if (typeof frame.cmdId === "string" && CMD_ID.test(frame.cmdId)) {
        this.send({ type: "command_result", cmdId: frame.cmdId, ok: false, error: "not_ready" });
      }
      return;
    }
    const epoch = this.epoch;
    const mine = { cmdId: cmd.cmdId, epoch };
    // A concurrent run is refused busy by the typist; it never replaces the one in flight.
    this.running ??= mine;
    void this.typist.run(cmd).then((result) => {
      if (this.running === mine) {
        this.running = undefined;
      }
      if (epoch === this.epoch) {
        this.send({ type: "command_result", cmdId: cmd.cmdId, ok: result.ok, ...(result.error ? { error: result.error } : {}) });
      }
    });
  }

  private reportDraft(): void {
    if (this.reportTimer !== undefined) {
      return; // the pending report sends whatever the draft is then
    }
    const wait = this.lastReportAt + DRAFT_REPORT_MS - this.clock.now();
    if (wait > 0) {
      this.reportTimer = this.clock.setTimeout(() => {
        this.reportTimer = undefined;
        this.reportDraft();
      }, wait);
      return;
    }
    const draft = this.input.draft;
    if (draft !== this.reportedDraft) {
      this.reportedDraft = draft;
      this.lastReportAt = this.clock.now();
      this.send({ type: "laptop_state", draft });
    }
  }
}
