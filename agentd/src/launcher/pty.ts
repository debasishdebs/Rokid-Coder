import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodePty from "node-pty";

/** A child running on a pseudo-terminal that the launcher owns. */
export interface PtyChild {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Writes the tty EOF character (\x04). */
  endInput(): void;
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
  /** Signals the child's process group. */
  kill(signal?: NodeJS.Signals): void;
}

export interface PtyOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

const TTY_EOF = "\x04";

/**
 * node-pty 1.1.0 ships its macOS spawn-helper without the execute bit, and npm
 * does not run node-pty's install script unless allowed. Without the bit every
 * spawn fails with `posix_spawnp failed`, so restore it once, inside our own
 * node_modules.
 */
let helperChecked = false;
function ensureSpawnHelperExecutable(): void {
  if (helperChecked) {
    return;
  }
  helperChecked = true;
  if (process.platform !== "darwin") {
    return;
  }
  try {
    const root = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0) {
      fs.chmodSync(helper, 0o755);
    }
  } catch {
    // Not fatal here: spawn reports the real failure.
  }
}

function signalName(signal: number | undefined): string | null {
  if (!signal) {
    return null;
  }
  for (const [name, value] of Object.entries(os.constants.signals)) {
    if (value === signal) {
      return name;
    }
  }
  return `SIG${signal}`;
}

export function spawnPty(file: string, args: string[], opts: PtyOptions): PtyChild {
  ensureSpawnHelperExecutable();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(opts.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  const term = nodePty.spawn(file, args, {
    name: env.TERM ?? "xterm-256color",
    cwd: opts.cwd,
    env,
    cols: opts.cols,
    rows: opts.rows,
  });

  let exited = false;
  const dataListeners: Array<(chunk: string) => void> = [];
  const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

  term.onData((chunk) => {
    for (const cb of dataListeners) {
      cb(chunk);
    }
  });
  term.onExit(({ exitCode, signal }) => {
    exited = true;
    const name = signalName(signal);
    for (const cb of exitListeners) {
      cb(name ? null : exitCode, name);
    }
  });

  return {
    pid: term.pid,
    write(data) {
      if (!exited) {
        term.write(data);
      }
    },
    resize(cols, rows) {
      if (!exited) {
        term.resize(cols, rows);
      }
    },
    endInput() {
      this.write(TTY_EOF);
    },
    onData(cb) {
      dataListeners.push(cb);
    },
    onExit(cb) {
      exitListeners.push(cb);
    },
    kill(signal = "SIGTERM") {
      if (exited) {
        return;
      }
      // forkpty makes the child a session and process-group leader, so -pid is the whole group.
      try {
        process.kill(-term.pid, signal);
      } catch {
        try {
          process.kill(term.pid, signal);
        } catch {
          // already gone
        }
      }
    },
  };
}
