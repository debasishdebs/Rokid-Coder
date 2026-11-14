import type { Clock } from "./typist";

const PASTE_END = "\x1b[201~";
const ESC = "\x1b";
/** R145: how long after an Enter the sessions file may take to show the submit. */
const SUBMIT_PROOF_MS = 1500;
const SUBMIT_POLL_MS = 100;

/** Control keys that only move the cursor, redraw, or remove text: they never make an empty prompt non-empty. */
const NEUTRAL_CONTROLS = new Set(["\x01", "\x02", "\x04", "\x05", "\x06", "\x0b", "\x0c", "\x15", "\x17", "\x1a"]);
const NEUTRAL_FINALS = new Set(["C", "D", "H", "F", "I", "O"]);
/** CSI parameter and intermediate bytes, private prefixes (`<`, `=`, `>`, `?`) included. */
const CSI_BODY = /^[0-?]*[ -/]*$/;
/** The key code, its shifted and base-layout codes, its modifiers and its event type; text is allowed and ignored. */
const KITTY_KEY = /^(\d+)(?::(\d*))?(?::(\d+))?(?:;(\d*)(?::(\d+))?(?:;[\d:]*)?)?$/;
const KITTY_ESC = 27;
const KITTY_ENTER = 13;
const KITTY_C = 99;
const KITTY_CTRL = 4;
/** Caps Lock and Num Lock: reported as modifiers, they change nothing about Ctrl-C. */
const KITTY_LOCKS = 64 | 128;
/** R151: after a takeover key, held keys wait this long, so Esc and the next key are not read as one Alt chord. */
export const REPLAY_GAP_MS = 100;

/**
 * R145's proof of a submit for one read of Claude's sessions file: it says busy,
 * and it was written no earlier than the Enter. Both are whole milliseconds and
 * Claude can go busy in the millisecond the Enter arrived, so equal counts.
 */
export function sessionBusySince(file: { status: string; statusUpdatedAt?: number } | undefined, at: number): boolean {
  return file?.status === "busy" && typeof file.statusUpdatedAt === "number" && file.statusUpdatedAt >= at;
}

/**
 * Follows one key stream for the draft rule. Prompt contents are not
 * observable, so it is conservative: anything that could put text in the
 * prompt sets the draft, Esc included (R144), since Claude may put queued or
 * rewound text back. Ctrl-C clears it. An Enter only arms `enterPending`: it
 * may be `\`+Enter, Meta-Enter or a suggestion being accepted, so only the
 * sessions file can prove it submitted (R145).
 */
class DraftTracker {
  draft = false;
  enterPending = false;
  /** Counts the Enters that armed `enterPending`, so a watch restarts only for a new one. */
  enters = 0;
  /** R149: an Enter on a draft is the last thing typed; unlike `enterPending` it does not lapse. */
  enterLast = false;
  private inPaste = false;

  clone(): DraftTracker {
    const copy = new DraftTracker();
    copy.draft = this.draft;
    copy.enterPending = this.enterPending;
    copy.enters = this.enters;
    copy.enterLast = this.enterLast;
    copy.inPaste = this.inPaste;
    return copy;
  }

  /** The prompt is known empty. */
  clear(): void {
    this.draft = false;
    this.enterPending = false;
    this.enterLast = false;
  }

  /** Applies `data`; says where its first bare Esc or Ctrl-C outside a paste is, if it has one. */
  feed(data: string): { takeover?: { start: number; end: number } } {
    let takeover: { start: number; end: number } | undefined;
    let i = 0;
    while (i < data.length) {
      if (this.inPaste) {
        const end = data.indexOf(PASTE_END, i);
        this.mark();
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
          const csi = this.csi(data, i);
          if (csi.takeover) {
            takeover ??= { start: i, end: csi.next };
          }
          i = csi.next;
          continue;
        }
        if (next === "O" && i + 2 < data.length) {
          if (!NEUTRAL_FINALS.has(data[i + 2])) {
            this.mark();
          }
          i += 3;
          continue;
        }
        // A bare Esc (or Alt with a key, which starts with one).
        takeover ??= { start: i, end: i + 1 };
        this.mark();
        i += 1;
        continue;
      }
      if (ch === "\r") {
        this.enter();
      } else if (ch === "\x03") {
        this.clear();
        takeover ??= { start: i, end: i + 1 };
      } else if (ch >= " " || !NEUTRAL_CONTROLS.has(ch)) {
        // Printable, Tab, Backspace, newline, and any control key not known to be harmless.
        this.mark();
      }
      i += 1;
    }
    return { takeover };
  }

  /** An Enter on an empty prompt proves nothing and leaves nothing. */
  private enter(): void {
    this.enterPending = this.draft;
    this.enterLast = this.draft;
    if (this.enterPending) {
      this.enters += 1;
    }
  }

  /** The prompt may hold text, and any Enter before this is no longer the last word. */
  private mark(): void {
    this.draft = true;
    this.enterPending = false;
    this.enterLast = false;
  }

  /** One CSI starting at `i`; says where the next key starts, and whether it was a takeover key. */
  private csi(data: string, i: number): { next: number; takeover: boolean } {
    let j = i + 2;
    while (j < data.length && data[j] >= " " && data[j] <= "?") {
      j += 1;
    }
    const final = data[j];
    if (final === undefined || final < "@" || final > "~") {
      // Cut off at the chunk's end, or malformed: assume the worst, and go on
      // after the bytes that can belong to it so a later Ctrl-C is still seen.
      this.mark();
      return { next: final === undefined ? data.length : j, takeover: false };
    }
    const params = data.slice(i + 2, j);
    let takeover = false;
    if (!CSI_BODY.test(params)) {
      this.mark();
    } else if (final === "u") {
      takeover = this.kittyKey(params);
    } else if (params === "200" && final === "~") {
      this.inPaste = true;
      this.mark();
    } else if (params.startsWith("<") && (final === "M" || final === "m")) {
      // An SGR mouse report: a click or a wheel turn types nothing.
    } else if (!NEUTRAL_FINALS.has(final)) {
      this.mark(); // Up/Down recall history; Delete and the rest edit
    }
    return { next: j + 1, takeover };
  }

  /**
   * R164: a key in the kitty keyboard protocol, `CSI code[:shifted[:base]][;mods[:event][;text]] u`.
   * Esc and Ctrl-C are takeovers exactly as their legacy bytes are, and a
   * plain Enter (flag 8 reports it so) is an Enter; anything else that is
   * pressed may type. Returns whether it was a takeover.
   */
  private kittyKey(params: string): boolean {
    if (params.startsWith("?")) {
      return false; // the terminal answering a flags query, not a key
    }
    const match = KITTY_KEY.exec(params);
    if (!match) {
      this.mark();
      return false;
    }
    const code = Number(match[1]);
    const base = match[3] ? Number(match[3]) : undefined;
    const mods = (match[4] ? Number(match[4]) - 1 : 0) & ~KITTY_LOCKS;
    if (match[5] === "3") {
      return false; // a release types nothing
    }
    if (code === KITTY_ESC || base === KITTY_ESC) {
      this.mark();
      return true;
    }
    if (code === KITTY_ENTER && mods === 0) {
      this.enter();
      return false;
    }
    if (mods === KITTY_CTRL && (code === KITTY_C || base === KITTY_C)) {
      // N3: a non-Latin layout names Ctrl-C only by its base-layout key. On
      // another Latin layout the key's own code may be what Claude reads, so
      // that one takes over but never clears the draft.
      if (code === KITTY_C || code > 0x7f) {
        this.clear();
      } else {
        this.mark();
      }
      return true;
    }
    this.mark();
    return false;
  }
}

export interface LaptopInputOptions {
  clock: Clock;
  /** R145: whether the owned sessions file reads busy, written at or after `at`. Without it an Enter never clears. */
  busySince?: (at: number) => boolean;
}

/**
 * The user's keyboard. While automation owns input the keys are held, except
 * that Esc or Ctrl-C is a takeover: it passes, and the held keys are the
 * user's again, replayed by the typist after a gap (R151). Keys that would
 * land in an open `/model` dialog are dropped, not held. `draft` describes
 * the prompt as it will be once every held key has been delivered.
 */
export class LaptopInput {
  private delivered = new DraftTracker();
  /** Set while holding: the delivered state with the held keys applied. */
  private projected?: DraftTracker;
  private held = "";
  /** R151: a takeover passed and the held keys wait out the gap; keys typed meanwhile queue behind them. */
  private replaying = false;
  /** R151: held keys that would land in an open `/model` dialog are dropped instead. */
  private dropping: () => boolean = () => false;
  private droppedThisHold = false;
  private enterAt?: number;
  /** When the last Enter that armed `enterLast` reached the prompt. */
  private lastEnterAt?: number;
  /** Which Enter the current watch is for. */
  private watchedEnter = 0;
  private submitTimer?: unknown;
  private readonly takeoverListeners: Array<() => void> = [];
  private readonly draftListeners: Array<(draft: boolean) => void> = [];
  private readonly droppedListeners: Array<() => void> = [];

  constructor(private readonly options: LaptopInputOptions) {}

  get draft(): boolean {
    return (this.projected ?? this.delivered).draft;
  }

  get holding(): boolean {
    return this.projected !== undefined;
  }

  /** Keys are waiting to be replayed. */
  get hasHeld(): boolean {
    return this.held.length > 0;
  }

  /** A takeover passed and the held keys are due after the gap. */
  get replayPending(): boolean {
    return this.replaying;
  }

  /** One read from the terminal. Returns what goes to the child now; the rest is held or dropped. */
  key(data: string): string {
    const before = this.draft;
    if (!this.projected) {
      this.deliver(data);
      this.watchSubmit();
      this.notify(before);
      return data;
    }
    const probe = this.projected.clone();
    const { takeover } = probe.feed(data);
    if (takeover) {
      // N4: the takeover key passes alone. Keys read before it in the same
      // chunk are held or dropped like any other; those after it queue behind
      // the held keys, so none can reach a dialog with it.
      if (takeover.start > 0) {
        this.key(data.slice(0, takeover.start));
      }
      const key = data.slice(takeover.start, takeover.end);
      this.takeOver(key, data.slice(takeover.end));
      return key;
    }
    if (!this.replaying && this.dropping()) {
      if (!this.droppedThisHold) {
        this.droppedThisHold = true;
        for (const cb of [...this.droppedListeners]) {
          cb();
        }
      }
      return "";
    }
    this.projected = probe;
    this.held += data;
    this.notify(before);
    return "";
  }

  /** Automation takes input: keys are held from now on. */
  hold(): void {
    if (!this.projected) {
      this.projected = this.delivered.clone();
      this.droppedThisHold = false;
      this.stopSubmitWatch();
    }
  }

  /** Ends holding and returns the held keys, which the caller must write next. */
  flushHeld(): string {
    if (this.projected) {
      if (this.projected.enters !== this.delivered.enters) {
        this.lastEnterAt = this.options.clock.now();
      }
      this.delivered = this.projected;
      this.projected = undefined;
      this.watchSubmit();
    }
    this.replaying = false;
    const held = this.held;
    this.held = "";
    return held;
  }

  /**
   * R149: agentd saw Claude take a prompt at `at`. A draft whose last key was
   * an Enter, made before then, was that prompt; anything typed since is not.
   */
  promptSubmitted(at: number): void {
    if (!this.delivered.enterLast || this.lastEnterAt === undefined || this.lastEnterAt > at) {
      return;
    }
    const before = this.draft;
    this.delivered.clear();
    this.stopSubmitWatch();
    if (this.projected) {
      const projected = this.delivered.clone();
      projected.feed(this.held);
      this.projected = projected;
    }
    this.notify(before);
  }

  /** R151: while `when` says so, a held key is dropped rather than kept for replay. */
  dropHeldWhile(when: () => boolean): void {
    this.dropping = when;
  }

  onTakeover(cb: () => void): void {
    this.takeoverListeners.push(cb);
  }

  onDraftChange(cb: (draft: boolean) => void): void {
    this.draftListeners.push(cb);
  }

  /** The first key dropped while one hold lasts. */
  onKeysDropped(cb: () => void): void {
    this.droppedListeners.push(cb);
  }

  /** The key goes first; the held keys, then `after`, follow it after the gap (R151). */
  private takeOver(key: string, after: string): void {
    const before = this.draft;
    this.deliver(key);
    this.held += after;
    if (this.held) {
      const projected = this.delivered.clone();
      projected.feed(this.held);
      this.projected = projected;
      this.replaying = true;
    } else {
      this.projected = undefined;
      this.replaying = false;
    }
    for (const cb of [...this.takeoverListeners]) {
      cb();
    }
    if (!this.projected) {
      this.watchSubmit();
    }
    this.notify(before);
  }

  private deliver(data: string): void {
    const enters = this.delivered.enters;
    this.delivered.feed(data);
    if (this.delivered.enters !== enters) {
      this.lastEnterAt = this.options.clock.now();
    }
  }

  dispose(): void {
    this.stopSubmitWatch();
  }

  /** After keys reach the prompt: an Enter that may have submitted the draft is checked against the file. */
  private watchSubmit(): void {
    if (!this.delivered.enterPending || !this.options.busySince) {
      this.stopSubmitWatch();
      return;
    }
    if (this.enterAt !== undefined && this.watchedEnter === this.delivered.enters) {
      return; // a cursor move after the Enter does not restart its window
    }
    this.stopSubmitWatch();
    this.watchedEnter = this.delivered.enters;
    this.enterAt = this.options.clock.now();
    this.scheduleSubmitCheck();
  }

  private scheduleSubmitCheck(): void {
    this.submitTimer = this.options.clock.setTimeout(() => {
      this.submitTimer = undefined;
      this.checkSubmit();
    }, SUBMIT_POLL_MS);
  }

  private checkSubmit(): void {
    const at = this.enterAt;
    if (at === undefined || this.projected || !this.delivered.enterPending) {
      return;
    }
    if (this.options.busySince?.(at)) {
      const before = this.draft;
      this.delivered.clear();
      this.enterAt = undefined;
      this.notify(before);
    } else if (this.options.clock.now() - at >= SUBMIT_PROOF_MS) {
      this.delivered.enterPending = false;
      this.enterAt = undefined;
    } else {
      this.scheduleSubmitCheck();
    }
  }

  private stopSubmitWatch(): void {
    if (this.submitTimer !== undefined) {
      this.options.clock.clearTimeout(this.submitTimer);
      this.submitTimer = undefined;
    }
    this.enterAt = undefined;
  }

  private notify(before: boolean): void {
    if (this.draft !== before) {
      for (const cb of [...this.draftListeners]) {
        cb(this.draft);
      }
    }
  }
}
