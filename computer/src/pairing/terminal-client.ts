import net from "node:net";
import path from "node:path";
import { LAUNCHER_SOCKET_NAME } from "../launcher/socket-name";

export type TerminalPairingOutcome = "paired" | "aborted" | "closed" | "skipped" | "unavailable";

export interface TerminalPairingOptions {
  /** agentd's Rokid-Coder state dir, where the 0600 launcher socket lives. */
  configDir: string;
  write: (text: string) => void;
  /** The next line typed, or undefined once input has ended. */
  nextLine: () => Promise<string | undefined>;
  /** How long to wait for a phone before giving the window up. */
  windowMs: number;
}

const WAITING = "Waiting for your phone: open Rokid Coder → Add a computer. The phone and this computer must be on the same Wi-Fi or on Tailscale.";
const QUESTION = "Does your phone show this same code? Confirm on the phone too. [y/N] ";
const CONFIRM_ON_PHONE = "Now confirm on the phone.";
const PAIRED = "Paired ✓";
const CLOSED = "The pairing window closed before a phone was added.";

const ABORTED: Record<string, string> = {
  mismatch: "The codes did not match, so nothing was paired.",
  cancel: "Pairing cancelled.",
  timeout: "Pairing timed out.",
  disconnect: "The phone went away before the pairing finished.",
  second_peer: "More than one device answered — try again.",
  storage: "The phone could not save the pairing — try again.",
};

function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

/**
 * The computer-side half of a SAS confirmation, in a terminal (`agentd pair`,
 * `rk`'s prompt): opens or joins agentd's window over the launcher socket,
 * shows the code when both sides have it, and sends the human's `[y/N]`.
 * Enter or end of input before the code gives the window up. A yes here is
 * only half: nothing pins until the phone's own human confirms as well.
 */
export function confirmInTerminal(options: TerminalPairingOptions): Promise<TerminalPairingOutcome> {
  return new Promise((resolve) => {
    const socket = net.createConnection(path.join(options.configDir, LAUNCHER_SOCKET_NAME));
    let buffer = "";
    let attempt: string | undefined;
    let shownWaiting = false;
    let asked = false;
    let answered = false;
    let done = false;
    let opened = false;
    const finish = (outcome: TerminalPairingOutcome, text?: string): void => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(windowTimer);
      if (text) {
        options.write(`${text}\n`);
      }
      socket.destroy();
      resolve(outcome);
    };
    const send = (frame: Record<string, unknown>): void => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(frame)}\n`);
      }
    };
    const windowTimer = setTimeout(() => {
      if (!asked) {
        if (attempt) {
          send({ type: "pair_confirm", attempt, ok: false });
        }
        finish("closed", CLOSED);
      }
    }, options.windowMs);
    windowTimer.unref();

    // One read is pending at a time: before the code it is a skip, after it the answer.
    // Started only once agentd answered, so an agentd without this IPC leaves input untouched.
    const read = (): void => void options.nextLine().then((answer) => {
      if (done) {
        return;
      }
      if (!asked) {
        if (attempt) {
          send({ type: "pair_confirm", attempt, ok: false });
        }
        finish("skipped");
        return;
      }
      answered = true;
      const yes = typeof answer === "string" && /^\s*y/i.test(answer);
      if (answer === undefined) {
        options.write("\n");
      }
      send({ type: "pair_confirm", attempt, ok: yes });
      if (yes) {
        options.write(`${CONFIRM_ON_PHONE}\n`);
      }
    });

    const onStatus = (status: Record<string, unknown>): void => {
      const state = typeof status.state === "string" ? status.state : "";
      if (typeof status.attempt === "string") {
        attempt = status.attempt;
      }
      if (!opened) {
        opened = true;
        read();
      }
      if (state === "WINDOW_OPEN" || (!asked && state !== "AWAITING_CONFIRM" && state !== "PINNED" && state !== "ABORTED")) {
        if (!shownWaiting) {
          shownWaiting = true;
          options.write(`${WAITING}\n`);
        }
        return;
      }
      if (state === "AWAITING_CONFIRM" && typeof status.code === "string" && !asked) {
        asked = true;
        clearTimeout(windowTimer);
        options.write(`Pairing code: ${formatCode(status.code)} (${status.code})\n${QUESTION}`);
        return;
      }
      if (state === "PINNED") {
        finish("paired", PAIRED);
        return;
      }
      if (state === "ABORTED") {
        const reason = typeof status.reason === "string" ? status.reason : "cancel";
        finish(answered || asked || reason !== "cancel" ? "aborted" : "skipped", ABORTED[reason] ?? "Pairing failed.");
      }
    };

    socket.setEncoding("utf8");
    socket.once("connect", () => send({ type: "pair_open" }));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "pair_status") {
            onStatus(frame);
          }
        } catch {
          // Not ours to read.
        }
      }
    });
    socket.once("error", () => finish(opened ? "aborted" : "unavailable"));
    socket.once("close", () => finish(opened ? "aborted" : "unavailable"));
  });
}
