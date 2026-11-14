import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";

// Cursor visible, then bracketed paste off: a child killed mid-TUI may leave
// either one changed, and stty does not cover them.
const SHOW_CURSOR = "\x1b[?25h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";

/**
 * The controlling terminal's settings as `stty -g` prints them, or undefined
 * when stdin is not a TTY (nothing to restore).
 */
export function saveTerminal(): string | undefined {
  if (!process.stdin.isTTY) {
    return undefined;
  }
  try {
    const result = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8", timeout: 2000 });
    const saved = result.status === 0 ? result.stdout.trim() : "";
    return saved === "" ? undefined : saved;
  } catch {
    return undefined;
  }
}

/** Idempotent. Safe to call from any exit path, including after a failed save. */
export function restoreTerminal(saved: string | undefined): void {
  if (saved !== undefined) {
    try {
      spawnSync("stty", [saved], { stdio: ["inherit", "ignore", "ignore"], timeout: 2000 });
    } catch {
      // Nothing more can be done for a terminal stty cannot reach.
    }
  }
  if (process.stdout.isTTY) {
    try {
      writeSync(1, SHOW_CURSOR + BRACKETED_PASTE_OFF);
    } catch {
      // The terminal may already be gone.
    }
  }
}
