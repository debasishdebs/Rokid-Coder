import { readClaudeSession, type ClaudeSessionFile } from "./claude-sessions";
import type { TypeCommand } from "./launcher-hub";
import { ScreenModel } from "./screen-probe";
import type { PtyChild } from "./pty";
import { LaptopInput, sessionBusySince } from "./laptop-input";
import { Typist, sessionReady, systemClock, type BindingView, type Clock } from "./typist";

type Frame = Record<string, unknown>;

const CMD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COMMANDS: ReadonlySet<string> = new Set(["compact", "model", "text"]);
/** `laptop_state` goes out on change, at most this often. */
const DRAFT_REPORT_MS = 250;

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

function asTypeCommand(frame: Frame): TypeCommand | undefined {
  const { cmdId, gen, notBefore, viaHooks, command, model, text } = frame;
  if (
    typeof cmdId !== "string" ||
    !Number.isInteger(gen) ||
    typeof command !== "string" ||
    !COMMANDS.has(command) ||
    (notBefore !== undefined && (typeof notBefore !== "number" || !Number.isFinite(notBefore))) ||
    (viaHooks !== undefined && typeof viaHooks !== "boolean") ||
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
    ...(viaHooks === true ? { viaHooks } : {}),
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
    const ready = (after?: number): boolean => sessionReady(readOwned(), after);
    this.input = new LaptopInput({ clock: this.clock, busySince: (at) => sessionBusySince(readOwned(), at) });
    this.screen = new ScreenModel(options.size?.cols ?? 80, options.size?.rows ?? 24);
    this.typist = new Typist(options.child, this.input, ready, this.clock, {
      binding: options.binding,
      screen: this.screen,
      fileStatus: () => readOwned()?.status,
      onWritten: (cmdId, at) => {
        if (this.running?.cmdId === cmdId && this.running.epoch === this.epoch) {
          this.send({ type: "command_written", cmdId, at });
        }
      },
    });
    this.input.onDraftChange(() => this.reportDraft());
  }

  /** The terminal was resized. */
  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  /** Bytes from the user's terminal. */
  onStdin(data: string): void {
    // After a takeover the typist replays the held keys, a gap after this one (R151).
    const now = this.input.key(data);
    if (now) {
      this.child.write(now);
    }
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
