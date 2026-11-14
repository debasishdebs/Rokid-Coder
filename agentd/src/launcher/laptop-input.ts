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
  private inPaste = false;

  clone(): DraftTracker {
    const copy = new DraftTracker();
    copy.draft = this.draft;
    copy.enterPending = this.enterPending;
    copy.enters = this.enters;
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
          i = this.csi(data, i);
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
        takeover = true;
        this.mark();
        i += 1;
        continue;
      }
      if (ch === "\r") {
        // An Enter on an empty prompt proves nothing and leaves nothing.
        this.enterPending = this.draft;
        if (this.enterPending) {
          this.enters += 1;
        }
      } else if (ch === "\x03") {
        this.draft = false;
        this.enterPending = false;
        takeover = true;
      } else if (ch >= " " || !NEUTRAL_CONTROLS.has(ch)) {
        // Printable, Tab, Backspace, newline, and any control key not known to be harmless.
        this.mark();
      }
      i += 1;
    }
    return { takeover };
  }

  /** The prompt may hold text, and any Enter before this is no longer the last word. */
  private mark(): void {
    this.draft = true;
    this.enterPending = false;
  }

  /** One CSI starting at `i`; returns where the next key starts. */
  private csi(data: string, i: number): number {
    let j = i + 2;
    while (j < data.length && data[j] >= " " && data[j] <= "?") {
      j += 1;
    }
    const final = data[j];
    if (final === undefined || final < "@" || final > "~") {
      // Cut off at the chunk's end, or malformed: assume the worst, and go on
      // after the bytes that can belong to it so a later Ctrl-C is still seen.
      this.mark();
      return final === undefined ? data.length : j;
    }
    const params = data.slice(i + 2, j);
    if (!CSI_BODY.test(params)) {
      this.mark();
    } else if (params === "200" && final === "~") {
      this.inPaste = true;
      this.mark();
    } else if (params.startsWith("<") && (final === "M" || final === "m")) {
      // An SGR mouse report: a click or a wheel turn types nothing.
    } else if (!NEUTRAL_FINALS.has(final)) {
      this.mark(); // Up/Down recall history; Delete and the rest edit
    }
    return j + 1;
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
 * user's again. `draft` describes the prompt as it will be once every held
 * key has been delivered.
 */
export class LaptopInput {
  private delivered = new DraftTracker();
  /** Set while holding: the delivered state with the held keys applied. */
  private projected?: DraftTracker;
  private held = "";
  private enterAt?: number;
  /** Which Enter the current watch is for. */
  private watchedEnter = 0;
  private submitTimer?: unknown;
  private readonly takeoverListeners: Array<() => void> = [];
  private readonly draftListeners: Array<(draft: boolean) => void> = [];

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

  key(data: string): "pass" | "hold" {
    const before = this.draft;
    if (!this.projected) {
      this.delivered.feed(data);
      this.watchSubmit();
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
      this.watchSubmit();
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
      this.stopSubmitWatch();
    }
  }

  /** Ends holding and returns the held keys, which the caller must write next. */
  flushHeld(): string {
    if (this.projected) {
      this.delivered = this.projected;
      this.projected = undefined;
      this.watchSubmit();
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
      this.delivered.draft = false;
      this.delivered.enterPending = false;
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
