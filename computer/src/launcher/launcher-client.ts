import { readClaudeSession, type ClaudeSessionFile } from "./claude-sessions";
import type { TypeCommand } from "./launcher-hub";
import type { PtyChild } from "./pty";
import { ScreenModel, boxState, describeVerdict, layoutClasses, type ScreenBox, type VerdictShape } from "./screen-probe";
import { LaptopInput, sessionBusySince } from "./laptop-input";
import { Typist, sessionReady, systemClock, type BindingView, type Clock } from "./typist";

type Frame = Record<string, unknown>;

const CMD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const COMMANDS: ReadonlySet<string> = new Set(["compact", "model", "text"]);
/** `laptop_state` goes out on change, at most this often. */
const DRAFT_REPORT_MS = 250;
/** The box report is sent again this often while it is unchanged; agentd takes one older than a few seconds for no news. */
const BOX_REFRESH_MS = 1000;
/** `screen_verdict` goes out when the verdict changed, at most this often (the first one at once). */
const VERDICT_REPORT_MS = 30_000;
/** The verdict is worked out (screen probes, the sessions file) at most this often. */
const VERDICT_CHECK_MS = 1000;
/** How many distinct layouts are counted, and how many unreadable ones are told at once, per session. */
const MAX_LAYOUTS = 500;
const MAX_UNKNOWN_LAYOUTS = 20;

/** A file status as a word the hub accepts (lowercase letters and underscores), else `other`; `none` without a file. */
function readOwnedStatus(file: ClaudeSessionFile | undefined): string {
  if (!file) {
    return "none";
  }
  return typeof file.status === "string" && /^[a-z_]{1,20}$/.test(file.status) ? file.status : "other";
}
/**
 * What agentd is told as `laptop_state.draft` is what the screen shows, not
 * what the keys suggest: the framed prompt box visibly has text in it. The
 * screen is looked at once the output has paused this long.
 */
const SCREEN_LOOK_MS = 150;

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
  const { cmdId, gen, notBefore, bgReply, queued, command, model, text } = frame;
  if (
    typeof cmdId !== "string" ||
    !Number.isInteger(gen) ||
    typeof command !== "string" ||
    !COMMANDS.has(command) ||
    (notBefore !== undefined && (typeof notBefore !== "number" || !Number.isFinite(notBefore))) ||
    (bgReply !== undefined && bgReply !== true) ||
    (queued !== undefined && (queued !== true || bgReply !== true)) ||
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
    ...(queued === true ? { queued } : {}),
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
  /** `draft|box` as last sent; agentd's copy starts empty on every link. */
  private reportedSignature?: string;
  /** The screen shows text in the prompt box, as of the last look; this, never the keys, is what agentd hears. */
  private visibleDraft = false;
  /** What the screen shows of the box as of the last look; undefined before the first. */
  private visibleBox?: ScreenBox;
  private refreshTimer?: unknown;
  /** Claude's sessions file for the session agentd accepted, read fresh. */
  private readFile?: () => ClaudeSessionFile | undefined;
  /** What `screen_verdict` last said, and when; the distinct layouts (row-class strings) seen, and the unreadable ones told at once. */
  private verdictSignature?: string;
  private verdictSentAt?: number;
  private verdictCheckedAt?: number;
  private readonly layouts = new Set<string>();
  private readonly unknownLayouts = new Set<string>();
  private lastReportAt = Number.NEGATIVE_INFINITY;
  private reportTimer?: unknown;
  private screenTimer?: unknown;

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
    this.readFile = readOwned;
    // The screen model is fed Claude's output for the whole session (the typist subscribes
    // in its constructor); each pause in the output is a moment to look at the prompt box.
    options.child.onData(() => this.scheduleScreenLook());
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
      // What the screen check decided, for agentd's log: names and lengths, never prompt text.
      onCheck: (check) => this.send({ type: "screen_check", ...check }),
      // The row kinds of a screen it could not read, for the log; never its text.
      onShape: (shape) => this.send({ type: "screen_shape", ...shape }),
    });
  }

  /** The terminal was resized. */
  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
    this.scheduleScreenLook();
  }

  /** Bytes from the user's terminal. */
  onStdin(data: string): void {
    // After a takeover the typist replays the held keys, a gap after this one (R151).
    const now = this.input.key(data);
    if (now) {
      this.child.write(now);
    }
  }

  private scheduleScreenLook(): void {
    if (this.screenTimer === undefined) {
      this.screenTimer = this.clock.setTimeout(() => {
        this.screenTimer = undefined;
        this.lookAtScreen();
      }, SCREEN_LOOK_MS);
    }
  }

  /**
   * Whether the prompt box visibly has text in it, which is what agentd calls a
   * laptop draft. The keys never say so: a stray Esc or Tab is not text, and a
   * draft the keys never saw (a restored one, a paste) still is. While a command
   * of ours has the prompt, the box holds our own paste, which is no draft.
   */
  private lookAtScreen(): void {
    if (this.typist.busy) {
      return; // looked at again when the command ends
    }
    const box = boxState(this.screen);
    this.visibleDraft = box === "text";
    this.visibleBox = box;
    this.reportDraft();
    this.reportVerdict();
    this.armRefresh();
  }

  /**
   * Tells agentd, for its log, what the probe made of the screen when that changes (at most once per
   * VERDICT_REPORT_MS, and once at the start), and at once, a few times per session, the first time a layout
   * with a prompt-glyph row the probe could not read appears. Names, numbers and row classes only.
   */
  private reportVerdict(): void {
    // The verdict (several probes of the screen) and the sessions file are looked at only about once a second:
    // a screen redraws several times a second while Claude works, and a line goes out at most every 30 s.
    const at = this.clock.now();
    if (this.verdictCheckedAt !== undefined && at - this.verdictCheckedAt < VERDICT_CHECK_MS) {
      return;
    }
    this.verdictCheckedAt = at;
    const verdict: VerdictShape = describeVerdict(this.screen);
    const classes = layoutClasses(this.screen);
    if (!this.layouts.has(classes) && this.layouts.size < MAX_LAYOUTS) {
      this.layouts.add(classes);
    }
    const newUnknown = verdict.unknown && !this.unknownLayouts.has(classes) && this.unknownLayouts.size < MAX_UNKNOWN_LAYOUTS;
    if (newUnknown) {
      this.unknownLayouts.add(classes);
    }
    const status = readOwnedStatus(this.readFile?.());
    const signature = [verdict.probe, verdict.reason, verdict.box, verdict.tainted, verdict.top, verdict.prompt, verdict.bottom, verdict.cols, verdict.rows, verdict.uw, verdict.dlg, status].join("|");
    const now = this.clock.now();
    const due = this.verdictSentAt === undefined || now - this.verdictSentAt >= VERDICT_REPORT_MS;
    if (!newUnknown && (signature === this.verdictSignature || !due)) {
      return;
    }
    this.verdictSignature = signature;
    this.verdictSentAt = now;
    const { unknown: _unknown, ...fields } = verdict;
    this.send({ type: "screen_verdict", ...fields, file: status, layouts: this.layouts.size, unknown: newUnknown });
  }

  /** The report is repeated while the link is up, so agentd can tell a screen that is still empty from one it has not heard about. */
  private armRefresh(): void {
    if (this.refreshTimer !== undefined) {
      return;
    }
    const handle = this.clock.setTimeout(() => {
      this.refreshTimer = undefined;
      this.lookAtScreen();
      this.armRefresh();
    }, BOX_REFRESH_MS);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    this.refreshTimer = handle;
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
    this.reportedSignature = undefined;
    this.lastReportAt = Number.NEGATIVE_INFINITY;
    this.lookAtScreen();
  }

  onLinkDown(): void {
    this.linkChanged();
  }

  dispose(): void {
    this.typist.dispose();
    this.input.dispose();
    this.clock.clearTimeout(this.reportTimer);
    this.clock.clearTimeout(this.screenTimer);
    this.clock.clearTimeout(this.refreshTimer);
    this.screenTimer = undefined;
    this.refreshTimer = undefined;
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
      this.scheduleScreenLook();
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
    const box = this.visibleBox;
    if (box === undefined) {
      return; // the screen has not been looked at yet
    }
    const signature = `${this.visibleDraft}|${box}`;
    const now = this.clock.now();
    // On change, and again when the last report is a refresh old: agentd takes an older one for no news.
    if (signature !== this.reportedSignature || now - this.lastReportAt >= BOX_REFRESH_MS) {
      this.reportedSignature = signature;
      this.lastReportAt = now;
      this.send({ type: "laptop_state", draft: this.visibleDraft, box, at: now });
    }
  }
}
