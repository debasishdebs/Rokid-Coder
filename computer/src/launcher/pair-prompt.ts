import type { PinStore } from "../tls";
import { confirmInTerminal } from "../pairing/terminal-client";
import { launcherConfigDir, phonePinsFile } from "./status-probe";

/**
 * Pairing as a step of `rk claude` and `rk codex` (U6), before the agent
 * starts: it opens agentd's window over the launcher socket, shows the
 * 6-digit code when the phone has it too, and takes the `[y/N]` here; the
 * phone confirms on its own screen. With an agentd too old to speak that,
 * it only opens the window, as `agentd phones allow-next` does.
 */
export const PAIR_LATER = 'Pair later: run "agentd pair" or type /rokid:pair in Claude (rokid:pair in Codex).';
const QUESTION = "No phone paired yet. Pair now? [Y/n] ";
const PHONE_STEP = "Open Agents on your phone → Add a computer";
const NETWORK_NOTE = "The phone and this computer must be on the same Wi-Fi or on Tailscale.";
const PAIRED = "Paired ✓";
const CLOSED = "The pairing window closed before a phone was added.";
const POLL_MS = 1000;

/** Lines typed on stdin. The stream is paused again by close(), so the child gets the terminal. */
export class LineReader {
  private buffer = "";
  private lines: Array<string | undefined> = [];
  private waiter?: (line: string | undefined) => void;
  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    let end: RegExpExecArray | null;
    while ((end = /\r\n|\r|\n/.exec(this.buffer))) {
      this.push(this.buffer.slice(0, end.index));
      this.buffer = this.buffer.slice(end.index + end[0].length);
    }
  };
  private readonly onEnd = (): void => this.push(undefined);

  constructor(private readonly stream: NodeJS.ReadStream) {
    stream.setEncoding("utf8");
    stream.on("data", this.onData);
    stream.on("end", this.onEnd);
    stream.resume();
  }

  /** The next line, or undefined once stdin has ended. */
  next(): Promise<string | undefined> {
    const queued = this.lines.length > 0;
    return queued ? Promise.resolve(this.lines.shift()) : new Promise((resolve) => (this.waiter = resolve));
  }

  close(): void {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.onEnd);
    this.stream.pause();
  }

  private push(line: string | undefined): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) {
      waiter(line);
    } else {
      this.lines.push(line);
    }
  }
}

function pinned(pins: PinStore): boolean {
  try {
    return !pins.isEmpty();
  } catch {
    return false; // an unreadable file is not a paired phone; the window still runs out
  }
}

/** The window `agentd phones allow-next` opens. The override exists only so a test need not wait it out. */
function pairWindowMs(): number | undefined {
  const parsed = Number(process.env.ROKID_RK_PAIR_WINDOW_MS);
  return process.env.ROKID_RK_PAIR_WINDOW_MS !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Asks to pair when stdin is a terminal; anything else gets the one-line
 * pointer. A yes opens the window and waits until a phone is pinned, the
 * window ends, or Enter skips. It returns without starting anything.
 */
export async function offerPairing(): Promise<void> {
  const err = process.stderr;
  if (!process.stdin.isTTY) {
    err.write(`${PAIR_LATER}\n`);
    return;
  }
  const input = new LineReader(process.stdin);
  try {
    err.write(QUESTION);
    const answer = await input.next();
    if (answer === undefined || /^\s*n/i.test(answer)) {
      err.write(`${answer === undefined ? "\n" : ""}${PAIR_LATER}\n`);
      return;
    }
    const confirmed = await confirmInTerminal({
      configDir: launcherConfigDir(),
      write: (text) => err.write(text),
      nextLine: () => input.next(),
      windowMs: pairWindowMs() ?? 2 * 60 * 1000,
    });
    if (confirmed !== "unavailable") {
      if (confirmed !== "paired") {
        err.write(`${PAIR_LATER}\n`);
      }
      return;
    }
    const { PinStore } = await import("../tls.js");
    const pins = new PinStore(phonePinsFile());
    let until: number;
    try {
      until = pins.armAllowNext(Date.now(), pairWindowMs());
    } catch (error) {
      err.write(`Could not open the pairing window: ${error instanceof Error ? error.message : String(error)}\n${PAIR_LATER}\n`);
      return;
    }
    const tty = Boolean(err.isTTY);
    const status = (): string => `${PHONE_STEP} (${clock(until - Date.now())} left)`;
    err.write(`${NETWORK_NOTE}\n`);
    err.write(tty ? status() : `${status()}\n`);
    const outcome = await new Promise<"paired" | "closed" | "skipped">((resolve) => {
      const timer = setInterval(() => {
        if (pinned(pins)) {
          done("paired");
        } else if (Date.now() >= until) {
          done("closed");
        } else if (tty) {
          err.write(`\r\x1b[2K${status()}`);
        }
      }, POLL_MS);
      let settled = false;
      const done = (result: "paired" | "closed" | "skipped"): void => {
        if (!settled) {
          settled = true;
          clearInterval(timer);
          resolve(result);
        }
      };
      void input.next().then(() => done("skipped"));
    });
    if (outcome === "skipped") {
      // A user who skipped is not left with a window still open for a stranger.
      try {
        pins.closeAllowNext();
      } catch {
        // the window still ends by itself
      }
    }
    // Enter already moved the cursor to a fresh line; the countdown did not.
    const fresh = outcome === "skipped" || !tty ? "" : "\r\x1b[2K";
    err.write(
      outcome === "paired" ? `${fresh}${PAIRED}\n` : outcome === "closed" ? `${fresh}${CLOSED}\n${PAIR_LATER}\n` : `${PAIR_LATER}\n`,
    );
  } finally {
    input.close();
  }
}
