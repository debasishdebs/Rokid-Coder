#!/usr/bin/env node
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultStateDir } from "./config";
import { claudeSessionsDir, findOwnedClaudeSession } from "./launcher/claude-sessions";
import { LAUNCHER_SOCKET_NAME } from "./launcher/launcher-hub";
import { spawnPty, type PtyChild } from "./launcher/pty";
import { restoreTerminal, saveTerminal } from "./launcher/terminal";

const CLAUDE_BANNER =
  "Rokid-Coder launcher: attached. From the glasses you can reply at any time, compact, and change model (changing model also sets your default for new sessions).";
const UNREACHABLE = "Rokid-Coder: agentd isn't running — this session is not attached.";
const CODEX_REFUSAL =
  "rk codex: -c and --dangerously-bypass-hook-trust move Codex off the shared daemon; run plain codex for those.";
// R133: rk codex cannot bind a thread it owns, so it runs plain codex and points at the plugin attach.
const CODEX_HINT = "Type rokid:on in Codex to attach this session.";

const SESSION_POLL_FAST_MS = 500;
const SESSION_POLL_GIVE_UP_MS = 30_000;
const SESSION_POLL_SLOW_MS = 2000;
const RECONNECT_MS = 2000;
const MAX_FRAME_BYTES = 64 * 1024;
const HARD_EXIT_AFTER_KILL_MS = 2000;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// The brief's windows. The environment overrides exist only so tests need not wait them out.
const EOF_WAIT_MS = (): number => envMs("ROKID_RK_EOF_WAIT_MS", 10_000);
const KILL_AFTER_MS = (): number => envMs("ROKID_RK_KILL_AFTER_MS", 3000);

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

/** The directory holding launcher.sock: the test override, agentd's configured state dir, or ~/.rokid-coder. */
function launcherConfigDir(): string {
  if (process.env.ROKID_RK_CONFIG_DIR) {
    return process.env.ROKID_RK_CONFIG_DIR;
  }
  try {
    const config = JSON.parse(fs.readFileSync(path.join(defaultStateDir(), "config.json"), "utf8")) as {
      rokidCoder?: { stateDir?: unknown };
    };
    const configured = config.rokidCoder?.stateDir;
    if (typeof configured === "string" && configured.length > 0) {
      return configured === "~" || configured.startsWith("~/") ? path.join(os.homedir(), configured.slice(1)) : configured;
    }
  } catch {
    // no readable config: the default applies. rk never creates agentd's files.
  }
  return path.join(os.homedir(), ".rokid-coder");
}

function tryConnect(socketPath: string): Promise<net.Socket | undefined> {
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
    private readonly handlers: { onFrame: (frame: Frame) => void; onUp: () => void },
  ) {}

  attach(socket: net.Socket): void {
    this.socket = socket;
    this.up = true;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const parsed: unknown = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.handlers.onFrame(parsed as Frame);
          }
        } catch {
          // a malformed frame from agentd is ignored
        }
      }
      if (buffer.length > MAX_FRAME_BYTES) {
        socket.destroy();
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.up = false;
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
  const socketPath = path.join(launcherConfigDir(), LAUNCHER_SOCKET_NAME);

  // Probe before the TUI starts, so the unattached notice cannot land in the middle of it.
  const probe = await tryConnect(socketPath);
  if (!probe) {
    process.stderr.write(`${UNREACHABLE}\n`);
  }

  const saved = saveTerminal();
  let child: PtyChild;
  try {
    const file = resolveExecutable(bin);
    if (!file) {
      throw new Error(`${bin}: command not found`);
    }
    if (process.stdin.isTTY) {
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

  // ---- exit handling (R53) ----
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
        restoreTerminal(saved);
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
  const binding = { gen: 0, uncertain: false };
  let boundId: string | undefined;
  let requestedId: string | undefined;
  let announced = false;

  const link: LauncherLink = new LauncherLink(
    socketPath,
    { type: "launcher_hello", v: 1, launcherId: randomUUID(), provider: "claude", childPid: child.pid },
    {
      onUp: () => {
        boundId = undefined;
        requestedId = undefined;
      },
      onFrame: (frame) => {
        switch (frame.type) {
          case "bind_accepted":
            boundId = requestedId ?? boundId;
            binding.gen = typeof frame.gen === "number" ? frame.gen : binding.gen;
            if (!announced) {
              announced = true;
              process.stdout.write(`\r\n${CLAUDE_BANNER}\r\n`);
            }
            break;
          case "bind_rejected":
            requestedId = undefined;
            if (frame.reason === "detached") {
              boundId = undefined;
            }
            break;
          case "binding_state":
            if (typeof frame.gen === "number" && typeof frame.uncertain === "boolean") {
              binding.gen = frame.gen;
              binding.uncertain = frame.uncertain;
            }
            break;
          default:
            // type_command and cancel_command arrive with the typist (Task 3).
            break;
        }
      },
    },
  );
  if (probe) {
    link.attach(probe);
  } else {
    link.scheduleReconnect();
  }

  const startedAt = Date.now();
  let everFound = false;
  const pollSession = (): void => {
    pollTimer = undefined;
    if (finished) {
      return;
    }
    if (link.up) {
      const session = findOwnedClaudeSession(sessionsDir, child.pid);
      if (session) {
        everFound = true;
        if (session.sessionId !== boundId && session.sessionId !== requestedId) {
          requestedId = session.sessionId;
          link.send({ type: "launcher_bind", sessionId: session.sessionId });
        }
      }
    }
    if (!everFound && Date.now() - startedAt >= SESSION_POLL_GIVE_UP_MS) {
      return; // give up and stay unattached
    }
    pollTimer = setTimeout(pollSession, everFound ? SESSION_POLL_SLOW_MS : SESSION_POLL_FAST_MS);
  };
  pollTimer = setTimeout(pollSession, SESSION_POLL_FAST_MS);

  // ---- wiring: data and exit are subscribed in the same tick as the spawn ----
  child.onData((chunk) => {
    process.stdout.write(chunk);
  });
  child.onExit((code, signal) => finish(code, signal));

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => child.write(data));
  process.stdin.on("error", () => {});
  process.stdin.on("end", () => {
    if (shutdown || eofStarted) {
      return;
    }
    eofStarted = true;
    child.endInput();
    eofTimer = setTimeout(() => {
      sweepGroup = true;
      child.kill("SIGHUP");
      armKill();
    }, EOF_WAIT_MS());
  });
  process.stdin.resume();

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

function runCodex(args: string[]): void {
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
  process.stdout.write(`${CODEX_HINT}\n`);

  // Codex shares rk's process group and owns the terminal while it runs, so a
  // terminal Ctrl-C or Ctrl-\ must reach Codex and not take rk down with it.
  const ignore = (): void => {};
  process.on("SIGINT", ignore);
  process.on("SIGQUIT", ignore);

  const child: ChildProcess = spawnChild(file, args, { stdio: "inherit" });
  let shutdownCode: number | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    shutdownCode ??= 128 + (signalNumber(signal) ?? 15);
    child.kill(signal);
    killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS());
  };
  process.on("SIGTERM", () => forward("SIGTERM"));
  process.on("SIGHUP", () => forward("SIGHUP"));

  child.once("error", (error) => {
    if (child.pid === undefined) {
      restoreTerminal(saved);
      process.stderr.write(`rk: could not start codex: ${errorMessage(error)}\n`);
      process.exit(127);
    }
  });
  child.once("exit", (code, signal) => {
    clearTimeout(killTimer);
    // Codex restores its own terminal state; this is the safety net.
    restoreTerminal(saved);
    process.exit(shutdownCode ?? exitStatus(code, signal));
  });
}

function main(argv: string[]): void {
  const [command, ...args] = argv;
  if (command === "claude") {
    runClaude(args).catch((error: unknown) => {
      process.stderr.write(`rk: ${errorMessage(error)}\n`);
      process.exit(1);
    });
  } else if (command === "codex") {
    runCodex(args);
  } else {
    process.stderr.write("usage: rk claude [args...] | rk codex [args...]\n");
    process.exit(2);
  }
}

main(process.argv.slice(2));
