#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";

// The plugins ship a copy of this file with no node_modules and no sibling
// modules next to it, so it may import only node:* built-ins. The defaults
// below are only the fallback for a forwarder run by hand: the plugins always set
// ROKID_CODER_HOOK_DEADLINE_MS past the wait limit Y (up to an hour). A test pins
// the "no relative require" rule.
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TIMER_MS = 2_147_000_000;

function positiveTimerMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : undefined;
}

// An explicit deadline wins (plugins set it past the longest hook timeout);
// otherwise wait one approval timeout plus slack for the daemon to answer.
const EXIT_AFTER_MS =
  positiveTimerMs(process.env.ROKID_CODER_HOOK_DEADLINE_MS) ??
  (positiveTimerMs(process.env.NEXUS_AGENTD_APPROVAL_TIMEOUT_MS) ?? DEFAULT_APPROVAL_TIMEOUT_MS) + 5000;
const PROVIDER = process.env.ROKID_CODER_PROVIDER?.trim();
const HTTP_PORT = (() => {
  const parsed = Number(process.env.NEXUS_AGENTD_HTTP_PORT);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 8791;
})();
// With agentd down nothing intercepts the plugin's commands. These two still get
// a plain answer rather than reaching the model as a prompt.
const OFFLINE_REPLIES: Record<string, string> = {
  "rokid:pair": 'agentd isn\'t running — run "agentd run" in a terminal',
  "rokid:status": 'Not attached to Rokid-Coder: agentd isn\'t running.\nNext step: run "agentd run" in a terminal.',
};

// R156: the hook port is open to every local user, so the pairing window is
// opened here, over agentd's same-user 0600 launcher socket, and never by the
// hook itself. When that fails the reply says how to open it by hand.
const PAIR_UNAVAILABLE = 'Run "agentd phones allow-next" in a terminal';
const ARM_TIMEOUT_MS = 2000;

/** The plugin command this hook carries, if any: `rokid:pair`, `rokid:status`, ... */
function pluginCommand(body: Buffer): string | undefined {
  try {
    const hook = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
    const command = PROVIDER === "codex"
      ? hook.hook_event_name === "UserPromptSubmit" && typeof hook.prompt === "string" ? hook.prompt.trim() : undefined
      : hook.hook_event_name === "UserPromptExpansion" ? hook.command_name : undefined;
    return typeof command === "string" ? command : undefined;
  } catch {
    return undefined;
  }
}

function blockReply(reason: string): string {
  return JSON.stringify({ decision: "block", reason });
}

/** agentd's Rokid-Coder state dir, resolved as rk resolves it: no sibling module may be loaded here. */
function rokidStateDir(): string {
  if (process.env.ROKID_RK_CONFIG_DIR) {
    return process.env.ROKID_RK_CONFIG_DIR;
  }
  try {
    const stateDir = process.env.NEXUS_AGENTD_STATE_DIR || path.join(homedir(), ".nexus-agentd");
    const config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8")) as {
      rokidCoder?: { stateDir?: unknown };
    };
    const configured = config.rokidCoder?.stateDir;
    if (typeof configured === "string" && configured.length > 0) {
      return configured === "~" || configured.startsWith("~/") ? path.join(homedir(), configured.slice(1)) : configured;
    }
  } catch {
    // no readable config: the default applies
  }
  return path.join(homedir(), ".rokid-coder");
}

/** Asks agentd over the launcher socket to open the pairing window; true once it says it did. */
function armPairing(): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = "";
    const socket = createConnection(path.join(rokidStateDir(), "launcher.sock"));
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ARM_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write('{"type":"arm_pairing"}\n'));
    socket.on("data", (chunk: string) => {
      answer += chunk;
      const newline = answer.indexOf("\n");
      if (newline >= 0) {
        try {
          const frame = JSON.parse(answer.slice(0, newline)) as { type?: unknown; ok?: unknown };
          done(frame.type === "pairing_armed" && frame.ok === true);
        } catch {
          done(false);
        }
      }
    });
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
  });
}

const chunks: Buffer[] = [];
let finished = false;

function finish(output?: string): void {
  if (finished) {
    return;
  }
  finished = true;
  clearTimeout(deadline);
  if (output && output !== "{}") {
    process.stdout.write(output, () => process.exit(0));
    return;
  }
  process.exit(0);
}

const deadline = setTimeout(finish, EXIT_AFTER_MS);

process.stdin.on("data", (chunk: Buffer | string) => {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});
process.stdin.on("error", () => finish());
/** Posts the hook to agentd and prints its answer. `replace` stands in for an answer agentd gave. */
function forward(body: Buffer, command: string | undefined, replace?: string): void {
  try {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: HTTP_PORT,
        path: "/hook",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          ...(PROVIDER ? { "x-rokid-provider": PROVIDER } : {}),
        },
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (responseBody.length <= 64 * 1024) {
            responseBody += chunk;
          }
        });
        response.once("end", () => {
          try {
            const parsed: unknown = JSON.parse(responseBody);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              finish();
              return;
            }
            finish(replace !== undefined ? blockReply(replace) : JSON.stringify(parsed));
          } catch {
            finish();
          }
        });
      },
    );
    outgoing.once("error", (error: NodeJS.ErrnoException) =>
      finish(
        error.code === "ECONNREFUSED" && command !== undefined && Object.hasOwn(OFFLINE_REPLIES, command)
          ? blockReply(OFFLINE_REPLIES[command])
          : undefined,
      ),
    );
    outgoing.end(body);
  } catch {
    finish();
  }
}

process.stdin.on("end", () => {
  if (finished) {
    return;
  }
  const body = Buffer.concat(chunks);
  const command = pluginCommand(body);
  if (command === "rokid:pair") {
    void armPairing().then((armed) => forward(body, command, armed ? undefined : PAIR_UNAVAILABLE));
  } else {
    forward(body, command);
  }
});
process.stdin.resume();

process.once("uncaughtException", () => finish());
process.once("unhandledRejection", () => finish());
process.once("exit", () => clearTimeout(deadline));
