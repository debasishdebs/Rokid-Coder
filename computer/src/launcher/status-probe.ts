import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { defaultStateDir } from "../config";
import { LAUNCHER_SOCKET_NAME } from "./socket-name";

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

/**
 * M6: the socket and the directory holding it are this user's, the directory
 * a real one closed to everybody else, as agentd itself insists (R52). Any
 * other socket at the path could belong to another local user, who could then
 * type into this user's Claude.
 */
export function launcherSocketTrusted(socketPath: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) {
    return true;
  }
  try {
    const dir = fs.lstatSync(path.dirname(socketPath));
    const socket = fs.lstatSync(socketPath);
    return dir.isDirectory() && dir.uid === uid && (dir.mode & 0o077) === 0 && socket.isSocket() && socket.uid === uid;
  } catch {
    return false;
  }
}

function socketAnswers(socketPath: string): Promise<boolean> {
  if (!launcherSocketTrusted(socketPath)) {
    return Promise.resolve(false);
  }
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

/**
 * Whether the pin store holds a phone, read straight from the file: loading
 * ./tls would pull in the certificate generator on every rk start. An absent
 * file is no phone; one that cannot be read or parsed counts as paired, so rk
 * never prompts on a guess.
 */
export function phonePaired(): boolean {
  let text: string;
  try {
    text = fs.readFileSync(phonePinsFile(), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  try {
    const record = JSON.parse(text) as { phones?: unknown; pins?: unknown } | null;
    const phones = Array.isArray(record?.phones)
      ? record.phones
      : record?.pins && typeof record.pins === "object"
        ? Object.values(record.pins)
        : undefined;
    // A provisional pin (v4) is a pairing still being committed, not a paired phone.
    return phones === undefined || phones.some((entry) => (entry as { state?: unknown } | null)?.state !== "provisional");
  } catch {
    return true;
  }
}

export async function probeStatus(): Promise<StatusProbe> {
  const [healthy, socket] = await Promise.all([agentdHealthy(), socketAnswers(launcherSocketPath())]);
  return { agentd: healthy ? "up" : "down", paired: phonePaired(), launcherSocket: socket };
}
