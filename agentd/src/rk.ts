#!/usr/bin/env node
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeSessionsDir, findOwnedClaudeSession } from "./launcher/claude-sessions";
import { LauncherClient } from "./launcher/launcher-client";
import { offerPairing } from "./launcher/pair-prompt";
import { spawnPty, type PtyChild } from "./launcher/pty";
import { launcherSocketPath, launcherSocketTrusted, probeStatus, type StatusProbe } from "./launcher/status-probe";
import { BellGate, KittyKeyboardTracker, restoreTerminal, saveTerminal } from "./launcher/terminal";

const UNREACHABLE = "Rokid-Coder: agentd isn't running — this session is not attached.";
// R155: printed before the bind, so it says attaching; only the phone shows the bind itself.
const ATTACHING =
  "Rokid-Coder launcher: attaching… From the glasses you can reply at any time, compact, and change model (changing model also sets your default for new sessions).";
const KEYS_DROPPED =
  "Rokid-Coder: keys you typed while a model change from the glasses had Claude's model dialog open were dropped, so none could answer the dialog.";
const SOCKET_OFF = "Rokid-Coder: agentd is running but its launcher socket is off — this session is not attached.";
// U5: everything the banner needs is said before the TUI takes the screen.
const CLAUDE_COMMANDS_LINE = "  In Claude, {/rokid:status} shows this session's state and {/rokid:off} stops sending it to the glasses.";
const CLAUDE_LIMITS_LINE =
  "  Launcher mode: once attached, the glasses can reply at any time, compact, and change model (changing model also sets your default for new sessions).";
const CLAUDE_GLASSES_LINE = "  On your glasses: open Agents to see this session.";
const CLAUDE_START_LINE = "  Next step: start it in another terminal with {agentd run}; this session attaches by itself once it is up.";
const CLAUDE_SOCKET_LINE = '  Next step: look for "launcher socket disabled" in agentd\'s log, fix it, then restart {agentd run}.';
const CODEX_REFUSAL =
  "rk codex: -c and --dangerously-bypass-hook-trust move Codex off the shared daemon; run plain codex for those.";
// R133: rk codex cannot bind a thread it owns, so it runs plain codex and points at the plugin attach (U5).
const CODEX_HINT_LINES = [
  "Rokid-Coder: starting Codex, ready to attach.",
  "  Next step: type {rokid:on} inside Codex to show this session on the glasses ({rokid:off} detaches, {rokid:status} checks).",
  "  rokid:on works only once the Rokid-Coder plugin (plugins/codex) is installed in Codex.",
];
// R158: on a terminal the hint stays readable until a key or 3 s, and is recalled after Codex.
const CODEX_WAIT_LINE = "  Codex starts in 3 s, or press any key to start it now.";
const CODEX_REMINDER_LINE = "Rokid-Coder: type {rokid:on} inside Codex to show a session on the glasses.";
const CODEX_UNREACHABLE_LINE = "  agentd isn't running, so nothing can attach yet. Start it in another terminal: {agentd run}";

const SESSION_POLL_FAST_MS = 500;
const SESSION_POLL_SLOW_MS = 2000;
const RECONNECT_MS = 2000;
/** M5: a refused bind is asked again after 2 s, then 4, 8, … at most 30 s apart. */
const BIND_RETRY_FIRST_MS = 2000;
const BIND_RETRY_MAX_MS = 30_000;
const MAX_FRAME_BYTES = 64 * 1024;
const HARD_EXIT_AFTER_KILL_MS = 2000;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// The brief's windows. The environment overrides exist only so tests need not wait them out.
const EOF_WAIT_MS = (): number => envMs("ROKID_RK_EOF_WAIT_MS", 10_000);
const KILL_AFTER_MS = (): number => envMs("ROKID_RK_KILL_AFTER_MS", 3000);
const SESSION_POLL_GIVE_UP_MS = (): number => envMs("ROKID_RK_BIND_GIVE_UP_MS", 30_000);
const CODEX_HINT_WAIT_MS = (): number => envMs("ROKID_RK_CODEX_HINT_WAIT_MS", 3000);

/** Set once the child is running: what a crash outside the exit machinery must still do. */
let emergencyCleanup: (() => void) | undefined;

function signalNumber(name: string | null): number | undefined {
  return name ? (os.constants.signals as Record<string, number>)[name] : undefined;
}

/** A child's exit code, or 128 + n when a signal ended it. */
function exitStatus(code: number | null, signal: string | null): number {
  const n = signalNumber(signal);
  return n !== undefined ? 128 + n : (code ?? 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveExecutable(bin: string): string | undefined {
  const candidates = bin.includes("/")
    ? [path.resolve(bin)]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Only a socket that is provably this user's is connected to; anything else is as good as absent. */
function tryConnect(socketPath: string): Promise<net.Socket | undefined> {
  if (!launcherSocketTrusted(socketPath)) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.removeAllListeners("error");
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(undefined);
    });
  });
}

type Frame = Record<string, unknown>;

const AGENTD_FRAMES: ReadonlySet<string> = new Set([
  "bind_accepted",
  "bind_rejected",
  "bind_retry",
  "binding_state",
  "type_command",
  "cancel_command",
  "compact_done",
  "prompt_submitted",
]);

/** One line from agentd as a frame of a known type, or undefined. */
function parseFrame(line: string): Frame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const frame = parsed as Frame;
  return typeof frame.type === "string" && AGENTD_FRAMES.has(frame.type) ? frame : undefined;
}

/**
 * The newline-JSON connection to agentd's launcher socket. After a loss it
 * reconnects every 2 s and says hello again with the same launcherId.
 */
class LauncherLink {
  up = false;
  private socket?: net.Socket;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly socketPath: string,
    private readonly hello: Frame,
    private readonly handlers: { onFrame: (frame: Frame) => void; onUp: () => void; onDown: () => void },
  ) {}

  attach(socket: net.Socket): void {
    this.socket = socket;
    this.up = true;
    let buffer: Buffer = Buffer.alloc(0);
    // The hub's own framing: a line over 64 KiB, bad JSON or an unknown frame closes the link.
    socket.on("data", (chunk: Buffer) => {
      buffer = buffer.length > 0 ? Buffer.concat([buffer, chunk]) : chunk;
      let start = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, start);
        if (newline < 0) {
          break;
        }
        if (newline - start > MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        const frame = parseFrame(buffer.toString("utf8", start, newline));
        start = newline + 1;
        if (!frame) {
          socket.destroy();
          return;
        }
        this.handlers.onFrame(frame);
        if (socket.destroyed) {
          return;
        }
      }
      buffer = Buffer.from(buffer.subarray(start));
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.up = false;
        this.handlers.onDown();
        this.scheduleReconnect();
      }
    });
    this.send(this.hello);
    this.handlers.onUp();
  }

  send(frame: Frame): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${JSON.stringify(frame)}\n`);
    }
  }

  scheduleReconnect(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void tryConnect(this.socketPath).then((socket) => {
        if (!socket) {
          this.scheduleReconnect();
        } else if (this.stopped) {
          socket.destroy();
        } else {
          this.attach(socket);
        }
      });
    }, RECONNECT_MS);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.socket?.destroy();
  }
}

async function runClaude(args: string[]): Promise<void> {
  const bin = process.env.ROKID_RK_CLAUDE_BIN || "claude";
  const socketPath = launcherSocketPath();

  // Everything is said before the TUI starts, so nothing lands in the middle of it.
  const status = await probeStatus();
  const color = Boolean(process.stderr.isTTY);
  process.stderr.write(claudeBanner(status, color));
  if ((status.launcherSocket || status.agentd === "up") && !status.paired) {
    await offerPairing();
  }
  const probe = await tryConnect(socketPath);

  const saved = saveTerminal();
  if (saved === "failed") {
    // Raw mode that cannot be undone exactly is worse than a cooked terminal.
    process.stderr.write("rk: could not save the terminal settings (stty -g failed); running without raw mode.\n");
  }
  const kitty = new KittyKeyboardTracker();
  const bell = new BellGate();
  let child: PtyChild;
  try {
    const file = resolveExecutable(bin);
    if (!file) {
      throw new Error(`${bin}: command not found`);
    }
    if (process.stdin.isTTY && saved !== "failed") {
      process.stdin.setRawMode(true);
    }
    child = spawnPty(file, args, {
      cwd: process.cwd(),
      env: process.env,
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });
  } catch (error) {
    probe?.destroy();
    restoreTerminal(saved);
    process.stderr.write(`rk: could not start claude: ${errorMessage(error)}\n`);
    process.exit(127);
  }

  emergencyCleanup = () => {
    child.kill("SIGKILL");
    restoreTerminal(saved, kitty.restore());
  };

  // ---- exit handling (R53) ----
  // R140: the process group is swept only when rk itself ends the child by a
  // signal (TERM, HUP, INT, QUIT or an uncaught error). When Claude exits on its
  // own, including after stdin EOF, nothing is swept: plain `claude` leaves a
  // background job the user started on purpose (`npm run dev &`) running, and rk
  // must behave the same.
  let shutdown: { code: number; note?: string } | undefined;
  let sweepGroup = false;
  let finished = false;
  let eofStarted = false;
  let eofTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;

  const finish = (code: number | null, signal: string | null): void => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(eofTimer);
    clearTimeout(killTimer);
    clearTimeout(hardTimer);
    clearTimeout(pollTimer);
    link.stop();
    if (sweepGroup) {
      // Whatever the child left in its process group dies with it.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // the group is already empty
      }
    }
    const status = shutdown?.code ?? exitStatus(code, signal);
    const done = (): void => {
      try {
        restoreTerminal(saved, kitty.restore());
        if (keysDropped) {
          fs.writeSync(2, `${KEYS_DROPPED}\n`);
        }
        if (shutdown?.note) {
          fs.writeSync(2, shutdown.note);
        }
      } finally {
        process.exit(status);
      }
    };
    const flushDeadline = setTimeout(done, 500);
    process.stdout.write("", () => {
      clearTimeout(flushDeadline);
      done();
    });
  };

  const armKill = (): void => {
    clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      hardTimer = setTimeout(() => finish(null, "SIGKILL"), HARD_EXIT_AFTER_KILL_MS);
    }, KILL_AFTER_MS());
  };

  const beginShutdown = (signal: NodeJS.Signals, code: number, note?: string): void => {
    if (shutdown) {
      return;
    }
    shutdown = { code, note };
    sweepGroup = true;
    clearTimeout(eofTimer);
    child.kill(signal);
    armKill();
  };

  // ---- the launcher link and session binding ----
  const sessionsDir = claudeSessionsDir();
  const binding: { gen: number; uncertain: boolean; uncertainSince?: number } = { gen: 0, uncertain: false };
  let boundId: string | undefined;
  let requestedId: string | undefined;
  /** The session the last launcher_bind named; agentd may accept it later, on /rokid:on. */
  let askedId: string | undefined;
  let refused: { sessionId: string; delay: number; retryAt: number } | undefined;
  const client = new LauncherClient({ child, send: (frame) => link.send(frame), binding, sessionsDir });
  // R151: keys typed while a glasses /model dialog may be open are dropped. The
  // bell says so at once without drawing over Claude's screen (N5: never inside one of
  // its escape sequences); the line after exit says why.
  let keysDropped = false;
  client.input.onKeysDropped(() => {
    keysDropped = true;
    const now = bell.ring();
    if (now) {
      process.stdout.write(now);
    }
  });

  const link: LauncherLink = new LauncherLink(
    socketPath,
    { type: "launcher_hello", v: 1, launcherId: randomUUID(), provider: "claude", childPid: child.pid },
    {
      onUp: () => {
        boundId = undefined;
        requestedId = undefined;
        askedId = undefined;
        refused = undefined;
        client.onBound(undefined);
        client.onLinkUp();
        if (gaveUp && !finished) {
          // A late-started agentd gets a fresh window to find the session.
          gaveUp = false;
          startedAt = Date.now();
          pollTimer = setTimeout(pollSession, SESSION_POLL_FAST_MS);
        }
      },
      onDown: () => client.onLinkDown(),
      onFrame: (frame) => {
        switch (frame.type) {
          case "bind_accepted":
            boundId = requestedId ?? askedId ?? boundId;
            refused = undefined;
            client.onBound(boundId);
            binding.gen = typeof frame.gen === "number" ? frame.gen : binding.gen;
            break;
          case "bind_rejected":
            if (askedId !== undefined) {
              const delay = refused?.sessionId === askedId ? Math.min(refused.delay * 2, BIND_RETRY_MAX_MS) : BIND_RETRY_FIRST_MS;
              // Less a poll's slack, so a retry due now is not put off to the next one.
              refused = { sessionId: askedId, delay, retryAt: Date.now() + delay - SESSION_POLL_SLOW_MS / 4 };
            }
            requestedId = undefined;
            if (frame.reason === "detached") {
              boundId = undefined;
              client.onBound(undefined);
            }
            break;
          case "bind_retry":
            // /rokid:on ended the refusal: ask again now, with the uncertainty as it is now (N2).
            refused = undefined;
            requestedId = undefined;
            if (!finished) {
              clearTimeout(pollTimer);
              pollSession();
            }
            break;
          case "binding_state":
            if (typeof frame.gen === "number" && typeof frame.uncertain === "boolean") {
              binding.gen = frame.gen;
              // R161: agentd's false never clears the launcher's own true; a
              // restarted agentd knows nothing of it.
              if (frame.uncertain) {
                client.agentdUncertain();
              }
            }
            break;
          default:
            // type_command, cancel_command and compact_done
            client.onFrame(frame);
            break;
        }
      },
    },
  );
  // Polling for the owned session. It is declared before the first attach so the
  // link's onUp can restart it.
  let startedAt = Date.now();
  let everFound = false;
  let gaveUp = false;
  const pollSession = (): void => {
    pollTimer = undefined;
    if (finished) {
      return;
    }
    if (link.up) {
      const session = findOwnedClaudeSession(sessionsDir, child.pid);
      if (session) {
        everFound = true;
        client.setSession(session);
        const waiting = refused?.sessionId === session.sessionId && Date.now() < refused.retryAt;
        if (session.sessionId !== boundId && session.sessionId !== requestedId && !waiting) {
          requestedId = session.sessionId;
          askedId = session.sessionId;
          link.send({ type: "launcher_bind", sessionId: session.sessionId, uncertain: client.uncertain() });
        }
      }
    }
    if (!everFound && Date.now() - startedAt >= SESSION_POLL_GIVE_UP_MS()) {
      gaveUp = true; // stay unattached until agentd (re)connects
      return;
    }
    pollTimer = setTimeout(pollSession, everFound ? SESSION_POLL_SLOW_MS : SESSION_POLL_FAST_MS);
  };
  pollTimer = setTimeout(pollSession, SESSION_POLL_FAST_MS);

  if (probe) {
    link.attach(probe);
  } else {
    link.scheduleReconnect();
  }


  // ---- wiring: data and exit are subscribed in the same tick as the spawn ----
  child.onData((chunk) => {
    kitty.push(chunk);
    process.stdout.write(bell.output(chunk));
  });
  child.onExit((code, signal) => finish(code, signal));

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => client.onStdin(data));
  process.stdin.on("error", () => {});
  const onStdinEnd = (): void => {
    if (shutdown || eofStarted) {
      return;
    }
    eofStarted = true;
    child.endInput();
    eofTimer = setTimeout(() => {
      child.kill("SIGHUP");
      armKill();
    }, EOF_WAIT_MS());
  };
  process.stdin.on("end", onStdinEnd);
  process.stdin.resume();
  // A Ctrl-D at the pairing prompt already ended stdin; it never ends twice.
  if (process.stdin.readableEnded) {
    onStdinEnd();
  }

  process.stdout.on("resize", () => child.resize(process.stdout.columns || 80, process.stdout.rows || 24));

  const onSignal = (signal: NodeJS.Signals): void => beginShutdown(signal, 128 + (signalNumber(signal) ?? 15));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGHUP", () => onSignal("SIGHUP"));
  if (process.stdin.isTTY) {
    // In raw mode the keyboard never produces these; only a kill sent to rk does.
    // Without this a stray kill -INT would leave the terminal raw.
    process.on("SIGINT", () => onSignal("SIGINT"));
    process.on("SIGQUIT", () => onSignal("SIGQUIT"));
  }
  // rk never stops itself: Ctrl-Z is a byte for the child.
  process.on("SIGTSTP", () => {});
  const onFatal = (error: unknown): void =>
    beginShutdown("SIGTERM", 128 + 15, `rk: unexpected error: ${errorMessage(error)}\n`);
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);
}

function refusesCodexArgs(args: string[]): boolean {
  const end = args.indexOf("--");
  const scanned = end < 0 ? args : args.slice(0, end);
  return scanned.some(
    (arg) => /^-c/.test(arg) || arg === "--config" || arg.startsWith("--config=") || arg === "--dangerously-bypass-hook-trust",
  );
}

/** `{word}` is a command: bold on a terminal, plain on a pipe. */
function markCommands(lines: string[], color: boolean): string {
  const mark = (text: string): string =>
    text.replace(/\{([^}]+)\}/g, (_, word: string) => (color ? `\x1b[1m${word}\x1b[22m` : word));
  return `${lines.map(mark).join("\n")}\n`;
}

/** What `rk claude` prints before Claude starts; an unpaired phone's next step is the pairing prompt after it. */
function claudeBanner(status: StatusProbe, color: boolean): string {
  if (status.launcherSocket) {
    return markCommands(
      [ATTACHING, CLAUDE_COMMANDS_LINE, ...(status.paired ? [CLAUDE_GLASSES_LINE] : [])],
      color,
    );
  }
  return status.agentd === "up"
    ? markCommands([SOCKET_OFF, CLAUDE_LIMITS_LINE, CLAUDE_SOCKET_LINE], color)
    : markCommands([UNREACHABLE, CLAUDE_LIMITS_LINE, CLAUDE_START_LINE], color);
}

/**
 * Resolves at the first key on the terminal, or after `ms`; the key is
 * consumed. N7: raw mode turns Ctrl-C into a byte, so it is told apart: true.
 */
function waitForKey(ms: number): Promise<boolean> {
  const stdin = process.stdin;
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = (data?: Buffer | string): void => {
      clearTimeout(timer);
      stdin.off("data", done);
      stdin.off("end", done);
      try {
        stdin.setRawMode(false);
      } catch {
        // the terminal is already gone
      }
      stdin.pause();
      resolve(data !== undefined && String(data).includes("\x03"));
    };
    timer = setTimeout(done, ms);
    try {
      stdin.setRawMode(true);
    } catch {
      // still waits out the time
    }
    stdin.on("data", done);
    stdin.on("end", done);
    stdin.resume();
  });
}

/** The block `rk codex` prints before Codex starts. */
function codexHint(status: StatusProbe, color: boolean): string {
  return markCommands([...CODEX_HINT_LINES, ...(status.agentd === "up" ? [] : [CODEX_UNREACHABLE_LINE])], color);
}

async function runCodex(args: string[]): Promise<void> {
  if (refusesCodexArgs(args)) {
    process.stderr.write(`${CODEX_REFUSAL}\n`);
    process.exit(2);
  }
  const bin = process.env.ROKID_RK_CODEX_BIN || "codex";
  const file = resolveExecutable(bin);
  if (!file) {
    process.stderr.write(`rk: could not start codex: ${bin}: command not found\n`);
    process.exit(127);
  }
  const saved = saveTerminal();
  // Until Codex runs, a kill or an error of rk's own ends rk here. The hint
  // holds the terminal raw, and only SIGTERM's default would give it back.
  const abortBeforeCodex = (status: number, note?: string): void => {
    restoreTerminal(saved);
    if (note) {
      fs.writeSync(2, note);
    }
    process.exit(status);
  };
  const preTerm = (): void => abortBeforeCodex(128 + (signalNumber("SIGTERM") ?? 15));
  const preHup = (): void => abortBeforeCodex(128 + (signalNumber("SIGHUP") ?? 1));
  const preFatal = (error: unknown): void =>
    abortBeforeCodex(128 + 15, `rk: unexpected error: ${errorMessage(error)}\n`);
  process.on("SIGTERM", preTerm);
  process.on("SIGHUP", preHup);
  process.on("uncaughtException", preFatal);
  process.on("unhandledRejection", preFatal);
  const status = await probeStatus();
  process.stderr.write(codexHint(status, Boolean(process.stderr.isTTY)));
  if (status.agentd === "up" && !status.paired) {
    await offerPairing();
  }
  const color = Boolean(process.stderr.isTTY);
  const hintWait = CODEX_HINT_WAIT_MS();
  if (process.stdin.isTTY && !process.stdin.readableEnded && hintWait > 0) {
    process.stderr.write(markCommands([CODEX_WAIT_LINE], color));
    if (await waitForKey(hintWait)) {
      // Ctrl-C is no, as it would be at any prompt: Codex is never started.
      restoreTerminal(saved);
      process.exit(128 + (signalNumber("SIGINT") ?? 2));
    }
  }

  process.off("SIGTERM", preTerm);
  process.off("SIGHUP", preHup);
  process.off("uncaughtException", preFatal);
  process.off("unhandledRejection", preFatal);

  // Codex shares rk's process group and owns the terminal while it runs, so a
  // terminal Ctrl-C or Ctrl-\ must reach Codex and not take rk down with it.
  const ignore = (): void => {};
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);

  const child: ChildProcess = spawnChild(file, args, { stdio: "inherit" });
  let shutdownCode: number | undefined;
  let fatalNote: string | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let hardTimer: NodeJS.Timeout | undefined;
  const leave = (status: number): never => {
    try {
      // Codex restores its own terminal state; this is the safety net.
      restoreTerminal(saved);
      fs.writeSync(2, fatalNote ?? markCommands([CODEX_REMINDER_LINE], color));
    } finally {
      process.exit(status);
    }
  };
  const forward = (signal: NodeJS.Signals): void => {
    shutdownCode ??= 128 + (signalNumber(signal) ?? 15);
    child.kill(signal);
    killTimer ??= setTimeout(() => {
      child.kill("SIGKILL");
      hardTimer = setTimeout(() => leave(shutdownCode ?? 128 + 9), HARD_EXIT_AFTER_KILL_MS);
    }, KILL_AFTER_MS());
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));
  // As for rk claude: an error of rk's own still ends Codex and gives the terminal back.
  const onFatal = (error: unknown): void => {
    fatalNote ??= `rk: unexpected error: ${errorMessage(error)}\n`;
    forward("SIGTERM");
  };
  process.on("uncaughtException", onFatal);
  process.on("unhandledRejection", onFatal);

  child.once("error", (error) => {
    if (child.pid === undefined) {
      restoreTerminal(saved);
      process.stderr.write(`rk: could not start codex: ${errorMessage(error)}\n`);
      process.exit(127);
    }
  });
  child.once("exit", (code, signal) => {
    clearTimeout(killTimer);
    clearTimeout(hardTimer);
    leave(shutdownCode ?? exitStatus(code, signal));
  });
}

function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (command === "claude") {
    runClaude(args).catch((error: unknown) => {
      emergencyCleanup?.();
      process.stderr.write(`rk: ${errorMessage(error)}\n`);
      process.exit(1);
    });
  } else if (command === "codex") {
    runCodex(args).catch((error: unknown) => {
      process.stderr.write(`rk: ${errorMessage(error)}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write("usage: rk claude [args...] | rk codex [args...]\n");
    process.exit(2);
  }
}

main(process.argv.slice(2));
