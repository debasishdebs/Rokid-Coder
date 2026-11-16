import { spawn } from "node:child_process";
import path from "node:path";
import {
  ABORTED,
  CODE_QUESTION,
  CONFIRM_ON_PHONE_LINE,
  PAIRED_LINE,
  formatCode,
  type PairStatusEvent,
  type PairingWatch,
} from "../pairing/terminal-client";

export const TAILSCALE_LINK = "https://tailscale.com/download";
const LATER = '~/.rokid-coder/bin/agentd pair';
const MENU = "Not paired yet. [R]etry, [T]ailscale, [Q]R code, or [L]ater? ";

export interface PairIo {
  write(text: string): void;
  /** The next line typed, or undefined at end of input. */
  readLine(): Promise<string | undefined>;
}

/** Listens to agentd's pairing status while the prompt waits (`watchPairStatus`). */
export type WatchPairing = (onStatus: (status: PairStatusEvent) => void) => PairingWatch;

/**
 * `<bundle>/bin/agentd pair` with the terminal inherited: it shows the code,
 * takes `[y/N]` and waits for `pair-ready` (6a). Setup never confirms a
 * pairing itself. Resolves to its exit status; 0 means paired.
 */
export function runAgentdPair(bundleDir: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(path.join(bundleDir, "bin", "agentd"), ["pair"], { stdio: "inherit", env });
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

type Event =
  | { kind: "line"; text: string | undefined }
  | { kind: "code"; attempt: string; code: string }
  | { kind: "aborted"; reason: string }
  | { kind: "paired" };

/**
 * The prompt after a pairing that did not finish. It keeps listening to agentd, because a phone
 * can start an attempt while the prompt waits (a retry on its side, a second window): a code that
 * appears is shown here and asked as `[y/N]` right away, instead of sitting on a screen nobody saw.
 */
async function promptWhileWatching(io: PairIo, watch: WatchPairing | undefined): Promise<"paired" | { answer: string | undefined }> {
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  const push = (event: Event): void => {
    queue.push(event);
    wake?.();
  };
  let reading = false;
  const ensureRead = (): void => {
    if (!reading) {
      reading = true;
      void io.readLine().then((text) => {
        reading = false;
        push({ kind: "line", text });
      });
    }
  };
  // An attempt is told about only once it was seen running: the first status on joining can be the last one's end.
  const live = new Set<string>();
  let shown: { attempt: string; answered: boolean } | undefined;
  const watcher = watch?.((status) => {
    const attempt = status.attempt;
    if (status.state === "AWAITING_CONFIRM" && status.code && attempt) {
      live.add(attempt);
      if (shown?.attempt !== attempt) {
        push({ kind: "code", attempt, code: status.code });
      }
    } else if (status.state === "PINNED") {
      push({ kind: "paired" });
    } else if (status.state === "ABORTED") {
      if (attempt && live.delete(attempt)) {
        push({ kind: "aborted", reason: status.reason ?? "cancel" });
      }
    } else if (attempt) {
      live.add(attempt);
    }
  });
  try {
    io.write(MENU);
    for (;;) {
      ensureRead();
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const event = queue.shift() as Event;
      if (event.kind === "paired") {
        return "paired";
      }
      if (event.kind === "code") {
        shown = { attempt: event.attempt, answered: false };
        io.write(`\nPairing code: ${formatCode(event.code)} (${event.code})\n${CODE_QUESTION}`);
      } else if (event.kind === "aborted") {
        shown = undefined;
        io.write(`\n${ABORTED[event.reason] ?? "Pairing failed."}\n${MENU}`);
      } else if (shown && !shown.answered && watcher) {
        const yes = typeof event.text === "string" && /^\s*y/i.test(event.text);
        shown.answered = true;
        watcher.confirm(shown.attempt, yes);
        if (event.text === undefined) {
          io.write("\n");
          return { answer: undefined };
        }
        // A yes waits for the phone's own confirmation; a no ends the attempt, which agentd then reports.
        if (yes) {
          io.write(`${CONFIRM_ON_PHONE_LINE}\n`);
        }
      } else {
        return { answer: event.text?.trim().toLowerCase() };
      }
    }
  } finally {
    watcher?.stop();
  }
}

/**
 * The pairing step, which is also the post-install reachability check
 * (§13.1). Not paired offers [R]etry, [T]ailscale, [Q]R and [L]ater, and
 * keeps watching agentd for a code while it waits.
 */
export async function pairStep(runPair: () => Promise<number>, io: PairIo, watch?: WatchPairing): Promise<"paired" | "later"> {
  let status = await runPair();
  for (;;) {
    if (status === 0) {
      io.write("Paired.\n");
      return "paired";
    }
    const outcome = await promptWhileWatching(io, watch);
    if (outcome === "paired") {
      io.write(`${PAIRED_LINE}\nPaired.\n`);
      return "paired";
    }
    const answer = outcome.answer;
    if (answer === undefined || answer === "l" || answer === "later") {
      io.write(`${answer === undefined ? "\n" : ""}Pair whenever you are ready: run ${LATER}\n`);
      return "later";
    }
    if (answer === "t" || answer === "tailscale") {
      io.write(
        `Away from this Wi-Fi, or the phone can't reach this computer? Tailscale connects them:\n` +
          `  1. Install Tailscale on this computer: ${TAILSCALE_LINK}\n` +
          "  2. On the phone, open Settings > Connectors > Tailscale, and sign in with the same account.\n",
      );
      continue;
    }
    if (answer === "r" || answer === "retry" || answer === "q" || answer === "qr") {
      // `agentd pair` prints the v2 pairing line and its QR again: where to dial and which cert, nothing secret.
      status = await runPair();
    }
  }
}
