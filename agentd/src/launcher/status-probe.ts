import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultStateDir } from "../config";

// Defined here, not in the hub: rk loads this file, and the hub pulls in ./tls.
export const LAUNCHER_SOCKET_NAME = "launcher.sock";
const DEFAULT_HTTP_PORT = 8791;
const HEALTH_PROBE_MS = 700;

export interface StatusProbe {
  /** agentd's hook port answers /health. */
  agentd: "up" | "down";
  /** The pin store holds a phone. An unreadable pin file counts as paired: rk never guesses. */
  paired: boolean;
  /** The launcher socket accepts a connection. */
  launcherSocket: boolean;
}

/** The directory holding launcher.sock: the test override, agentd's configured state dir, or ~/.rokid-coder. */
export function launcherConfigDir(): string {
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

export function launcherSocketPath(): string {
  return path.join(launcherConfigDir(), LAUNCHER_SOCKET_NAME);
}

/** The pin store `agentd pair` and `agentd phones` edit, and the daemon reads. */
export function phonePinsFile(): string {
  return path.join(launcherConfigDir(), "tls", "phone-pins.json");
}

/** agentd's hook port: the same override the hooks use, then its config.json, then the default. */
function agentdHttpPort(): number {
  const fromEnv = Number(process.env.NEXUS_AGENTD_HTTP_PORT);
  if (Number.isSafeInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65_535) {
    return fromEnv;
  }
  try {
    const config = JSON.parse(fs.readFileSync(path.join(defaultStateDir(), "config.json"), "utf8")) as {
      httpPort?: unknown;
    };
    if (typeof config.httpPort === "number" && Number.isSafeInteger(config.httpPort) && config.httpPort > 0) {
      return config.httpPort;
    }
  } catch {
    // no readable config: the default port applies
  }
  return DEFAULT_HTTP_PORT;
}

function agentdHealthy(): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port: agentdHttpPort(), path: "/health", timeout: HEALTH_PROBE_MS }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** Whether the pin store holds a phone. ./tls pulls in the certificate generator, so it loads only here. */
export async function phonePaired(): Promise<boolean> {
  const { PinStore } = await import("../tls.js");
  try {
    return !new PinStore(phonePinsFile()).isEmpty();
  } catch {
    return true;
  }
}

export async function probeStatus(): Promise<StatusProbe> {
  const [healthy, socket, paired] = await Promise.all([agentdHealthy(), socketAnswers(launcherSocketPath()), phonePaired()]);
  return { agentd: healthy ? "up" : "down", paired, launcherSocket: socket };
}
