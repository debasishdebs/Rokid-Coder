import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

// What a child killed mid-TUI may leave on, and stty does not cover (R162): a
// kitty keyboard pop for each push it made on the alternate screen, mouse and
// focus reporting off, the normal screen, a pop for each push it made on the
// normal screen (N6: kitty keeps a stack per screen), the cursor shown, then
// bracketed paste off.
const KITTY_POP = "\x1b[<u";
/** `CSI = 0 ; 1 u`: every flag of the current entry set to 0. */
const KITTY_FLAGS_OFF = "\x1b[=0;1u";
const ALT_SCREEN_MODES: ReadonlySet<string> = new Set(["47", "1047", "1049"]);
const BEL = "\x07";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l";
const FOCUS_OFF = "\x1b[?1004l";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const SHOW_CURSOR = "\x1b[?25h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
/** No kitty push or pop is longer than this; a longer tail cannot be one. */
const KITTY_SEQ_MAX = 16;
/** A child cannot have pushed more than the terminal keeps. */
const KITTY_STACK_MAX = 64;

/**
 * The saved terminal: `stty -g` output, `none` when stdin is not a TTY
 * (nothing to restore), or `failed` when it is one and the save failed.
 */
export type SavedTerminal = string | "none" | "failed";

/** The controlling terminal's settings as `stty -g` prints them. */
export function saveTerminal(): SavedTerminal {
  if (!process.stdin.isTTY) {
    return "none";
  }
  try {
    const result = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 });
    const saved = result.status === 0 ? result.stdout.trim() : "";
    return saved === "" ? "failed" : saved;
  } catch {
    return "failed";
  }
}

/** What undoes the kitty keyboard state a child left: written on the alternate screen before leaving it, then on the main one. */
export interface KittyRestore {
  onAlt: string;
  onMain: string;
}

interface KittyStack {
  depth: number;
  /** `CSI = … u` set flags while nothing was pushed: no pop undoes those. */
  flagsSet: boolean;
}

/**
 * Follows a child's output for the kitty keyboard protocol. Each screen has
 * its own stack (N6): `CSI > flags u` pushes, `CSI < n u` pops n (and resets
 * every flag once the stack is empty), and `CSI = flags ; mode u` sets the
 * flags of the top entry, or of the screen itself when nothing is pushed.
 * Only what is still pushed or set at exit is undone.
 */
export class KittyKeyboardTracker {
  private readonly main: KittyStack = { depth: 0, flagsSet: false };
  private readonly alt: KittyStack = { depth: 0, flagsSet: false };
  private onAlt = false;
  private tail = "";

  push(chunk: string): void {
    const text = this.tail + chunk;
    for (const match of text.matchAll(/\x1b\[(?:([<>=])([\d;:]*)u|\?([\d;]*)([hl]))/g)) {
      if (match[3] !== undefined) {
        if (match[3].split(";").some((mode) => ALT_SCREEN_MODES.has(mode))) {
          this.onAlt = match[4] === "h";
        }
        continue;
      }
      const stack = this.onAlt ? this.alt : this.main;
      const [first, second] = match[2].split(";");
      if (match[1] === ">") {
        stack.depth = Math.min(stack.depth + 1, KITTY_STACK_MAX);
      } else if (match[1] === "<") {
        stack.depth = Math.max(stack.depth - (Number(first) || 1), 0);
        stack.flagsSet &&= stack.depth > 0;
      } else if (stack.depth === 0) {
        const flags = Number(first) || 0;
        const mode = Number(second) || 1;
        // Mode 1 sets all flags, 2 sets some, 3 clears some: only 1 with 0 is known clean.
        stack.flagsSet = mode === 1 ? flags !== 0 : stack.flagsSet || (mode === 2 && flags !== 0);
      }
    }
    const last = text.lastIndexOf("\x1b");
    const rest = last < 0 ? "" : text.slice(last);
    this.tail = rest.length < KITTY_SEQ_MAX && /^\x1b(\[([<>=?][\d;:]*)?)?$/.test(rest) ? rest : "";
  }

  restore(): KittyRestore {
    const undo = (stack: KittyStack): string =>
      stack.depth > 0 ? KITTY_POP.repeat(stack.depth) : stack.flagsSet ? KITTY_FLAGS_OFF : "";
    // Left on the main screen, the alternate one's stack is out of reach and harmless.
    return { onAlt: this.onAlt ? undo(this.alt) : "", onMain: undo(this.main) };
  }
}

/**
 * N5: rk's own bell goes into the child's output only between escape
 * sequences. Inside one (a title or an OSC 8 link split across chunks) it
 * would end it and print the rest as text, so a bell rung there waits for
 * the sequence's end.
 */
export class BellGate {
  private state: "ground" | "esc" | "csi" | "string" | "stringEsc" = "ground";
  private pending = false;

  /** A chunk of the child's output, with a waiting bell put in right after the sequence it waited for. */
  output(chunk: string): string {
    let at = -1;
    for (let i = 0; i < chunk.length; i++) {
      this.step(chunk.charCodeAt(i));
      if (this.pending && this.state === "ground") {
        this.pending = false;
        at = i + 1;
      }
    }
    return at < 0 ? chunk : chunk.slice(0, at) + BEL + chunk.slice(at);
  }

  /** The bell to write now, or "" when it has to wait; a bell already waiting is the same bell. */
  ring(): string {
    if (this.state === "ground") {
      return BEL;
    }
    this.pending = true;
    return "";
  }

  private step(c: number): void {
    switch (this.state) {
      case "ground":
        if (c === 0x1b) {
          this.state = "esc";
        }
        break;
      case "esc":
        if (c === 0x5b) {
          this.state = "csi";
        } else if (c === 0x5d || c === 0x50 || c === 0x5f || c === 0x5e || c === 0x58) {
          this.state = "string"; // OSC, DCS, APC, PM, SOS
        } else if (c !== 0x1b && (c < 0x20 || c > 0x2f)) {
          this.state = "ground"; // the final byte; intermediates keep waiting for it
        }
        break;
      case "csi":
        if (c === 0x1b) {
          this.state = "esc";
        } else if ((c >= 0x40 && c <= 0x7e) || c === 0x18 || c === 0x1a) {
          this.state = "ground";
        }
        break;
      case "string":
        if (c === 0x1b) {
          this.state = "stringEsc";
        } else if (c === 0x07 || c === 0x18 || c === 0x1a) {
          this.state = "ground";
        }
        break;
      case "stringEsc":
        // ESC \ ends the string; any other ESC starts a new sequence.
        this.state = "esc";
        if (c === 0x5c) {
          this.state = "ground";
        } else {
          this.step(c);
        }
        break;
    }
  }
}

/** Idempotent. Safe to call from any exit path, including after a failed save. */
export function restoreTerminal(saved: SavedTerminal, kitty: KittyRestore = { onAlt: "", onMain: "" }): void {
  if (saved !== "none" && saved !== "failed") {
    try {
      spawnSync("stty", [saved], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
    } catch {
      // Nothing more can be done for a terminal stty cannot reach.
    }
  }
  if (process.stdout.isTTY) {
    try {
      writeSync(1, kitty.onAlt + MOUSE_OFF + FOCUS_OFF + ALT_SCREEN_OFF + kitty.onMain + SHOW_CURSOR + BRACKETED_PASTE_OFF);
    } catch {
      // The terminal may already be gone.
    }
  }
}
