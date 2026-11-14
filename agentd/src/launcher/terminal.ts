import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

// What a child killed mid-TUI may leave on, and stty does not cover (R162): a
// kitty keyboard pop for each push it made (on the screen it pushed on, so
// first), mouse and focus reporting off, the normal screen, the cursor shown,
// then bracketed paste off.
const KITTY_POP = "\x1b[<u";
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

/**
 * Follows a child's output for the kitty keyboard protocol's stack: `CSI > flags u`
 * pushes, `CSI < n u` pops n. Only what is still pushed at exit is popped.
 */
export class KittyKeyboardTracker {
  depth = 0;
  private tail = "";

  push(chunk: string): void {
    const text = this.tail + chunk;
    for (const match of text.matchAll(/\x1b\[([<>])(\d*)((?:;\d*)*)u/g)) {
      if (match[1] === ">") {
        this.depth = Math.min(this.depth + 1, KITTY_STACK_MAX);
      } else {
        this.depth = Math.max(this.depth - (Number(match[2]) || 1), 0);
      }
    }
    const last = text.lastIndexOf("\x1b");
    const rest = last < 0 ? "" : text.slice(last);
    this.tail = rest.length < KITTY_SEQ_MAX && /^\x1b(\[([<>][\d;]*)?)?$/.test(rest) ? rest : "";
  }
}

/** Idempotent. Safe to call from any exit path, including after a failed save. */
export function restoreTerminal(saved: SavedTerminal, kittyPushes = 0): void {
  if (saved !== "none" && saved !== "failed") {
    try {
      spawnSync("stty", [saved], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
    } catch {
      // Nothing more can be done for a terminal stty cannot reach.
    }
  }
  if (process.stdout.isTTY) {
    try {
      writeSync(1, KITTY_POP.repeat(kittyPushes) + MOUSE_OFF + FOCUS_OFF + ALT_SCREEN_OFF + SHOW_CURSOR + BRACKETED_PASTE_OFF);
    } catch {
      // The terminal may already be gone.
    }
  }
}
