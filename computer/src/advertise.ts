import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { bestHostGuess } from "./pairing";
import type { AgentConfig } from "./types";

/**
 * Where a phone should dial agentd [6b-R3]. In WSL's NAT mode that is the
 * Windows host's port proxy (8794 -> WSL's localhost forwarding -> 8792), not
 * the WSL VM, whose address the phone cannot reach. The one record of it is
 * `<rokidCoder.stateDir>/advertise.json`, so every process (the daemon, an
 * `agentd pair` from any terminal) advertises the same endpoint. It exists
 * only in NAT mode; without it the endpoint is today's guess and wsPort.
 */

export const ADVERTISE_FILE = "advertise.json";
export const REFRESH_MS = 5 * 60_000;
export const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const INTEROP_TIMEOUT_MS = 15_000;

/** The Windows host's IPv4s: Tailscale's first (stable, like bestHostGuess prefers), then each adapter with a default gateway. */
export const HOST_IPV4_SCRIPT =
  "<# rokid:host-ipv4 #> [Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
  "$ts = Join-Path $env:ProgramFiles 'Tailscale\\tailscale.exe'; if (Test-Path -LiteralPath $ts) { & $ts ip -4 2>$null }; " +
  "Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress }";

export interface AdvertiseRecord {
  mode: "nat";
  hosts: string[];
  port: number;
  updatedAt: string;
}

export interface AdvertisedEndpoint {
  hosts: string[];
  port: number;
}

/** WSL_DISTRO_NAME, or the interop handler WSL registers: true inside any WSL distro. */
export function isWsl(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = existsSync): boolean {
  return Boolean(env.WSL_DISTRO_NAME) || exists("/proc/sys/fs/binfmt_misc/WSLInterop");
}

function isUsableIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a !== 0 && a !== 127 && !(a === 169 && b === 254) && a < 224;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

export function advertisePath(stateDir: string): string {
  return path.join(stateDir, ADVERTISE_FILE);
}

export function readAdvertise(stateDir: string): AdvertiseRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(advertisePath(stateDir), "utf8")) as Partial<AdvertiseRecord>;
    if (
      value?.mode === "nat" &&
      Array.isArray(value.hosts) &&
      value.hosts.length > 0 &&
      value.hosts.every((host) => typeof host === "string" && isUsableIpv4(host)) &&
      typeof value.port === "number" &&
      validPort(value.port)
    ) {
      return { mode: "nat", hosts: value.hosts, port: value.port, updatedAt: String(value.updatedAt ?? "") };
    }
  } catch {
    // absent or damaged: the default endpoint
  }
  return undefined;
}

/** Writes the NAT record, 0600, by temp file and rename. */
export function writeAdvertise(stateDir: string, hosts: string[], port: number, now = new Date()): AdvertiseRecord {
  if (hosts.length === 0) throw new Error("advertise needs at least one host");
  for (const host of hosts) {
    if (!isUsableIpv4(host)) throw new Error(`${host} is not a usable IPv4 address`);
  }
  if (!validPort(port)) throw new Error(`${port} is not a port`);
  const record: AdvertiseRecord = { mode: "nat", hosts: [...new Set(hosts)], port, updatedAt: now.toISOString() };
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = advertisePath(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return record;
}

export function clearAdvertise(stateDir: string): void {
  rmSync(advertisePath(stateDir), { force: true });
}

/** The record for this config's state dir; a config without one (a partial test config) has none. */
function recordFor(config: AgentConfig): AdvertiseRecord | undefined {
  const stateDir = config.rokidCoder?.stateDir;
  return stateDir ? readAdvertise(stateDir) : undefined;
}

/** The ONLY source of the pairing line's host, `pair-ready` and `pair_credentials{wsHost,wsPort}`. */
export function advertisedEndpoint(config: AgentConfig, guess: () => string = () => bestHostGuess()): AdvertisedEndpoint {
  const record = recordFor(config);
  return record ? { hosts: record.hosts, port: record.port } : { hosts: [guess()], port: config.wsPort };
}

export function parseHostIpv4s(stdout: string): string[] {
  const hosts = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isUsableIpv4);
  return [...new Set(hosts)];
}

export interface RefreshOptions {
  powershell?: string;
  /** Running inside WSL; detected when not given. */
  wsl?: boolean;
  now?: () => Date;
}

type RefreshResult = "skipped" | "unchanged" | "rewritten";

function applyRefresh(config: AgentConfig, stdout: string | undefined, now: () => Date): RefreshResult {
  const record = recordFor(config);
  if (!record || stdout === undefined) return record ? "unchanged" : "skipped";
  const hosts = parseHostIpv4s(stdout);
  if (hosts.length === 0 || hosts.join(",") === record.hosts.join(",")) return "unchanged";
  writeAdvertise(config.rokidCoder.stateDir, hosts, record.port, now());
  return "rewritten";
}

function refreshApplies(config: AgentConfig, options: RefreshOptions): boolean {
  return (options.wsl ?? isWsl()) && recordFor(config) !== undefined;
}

const ARGV = (script: string): string[] => ["-NoProfile", "-NonInteractive", "-Command", script];

/** NAT mode only: re-reads the Windows host's IPv4s through interop, and rewrites the record when they changed. */
export function refreshAdvertise(config: AgentConfig, options: RefreshOptions = {}): Promise<RefreshResult> {
  if (!refreshApplies(config, options)) return Promise.resolve("skipped");
  return new Promise((resolve) => {
    execFile(options.powershell ?? WINDOWS_POWERSHELL, ARGV(HOST_IPV4_SCRIPT), { encoding: "utf8", timeout: INTEROP_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      try {
        resolve(applyRefresh(config, error ? undefined : stdout, options.now ?? (() => new Date())));
      } catch {
        resolve("unchanged");
      }
    });
  });
}

/** The same, for `agentd pair`, which prints the line at once. */
export function refreshAdvertiseSync(config: AgentConfig, options: RefreshOptions = {}): RefreshResult {
  if (!refreshApplies(config, options)) return "skipped";
  let stdout: string | undefined;
  try {
    stdout = execFileSync(options.powershell ?? WINDOWS_POWERSHELL, ARGV(HOST_IPV4_SCRIPT), { encoding: "utf8", timeout: INTEROP_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    stdout = undefined;
  }
  try {
    return applyRefresh(config, stdout, options.now ?? (() => new Date()));
  } catch {
    return "unchanged";
  }
}

/** The daemon's refresh, every 5 minutes; a no-op outside NAT mode. Returns its stop. */
export function startAdvertiseRefresh(config: AgentConfig, options: RefreshOptions & { intervalMs?: number } = {}): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void refreshAdvertise(config, options).finally(() => {
      running = false;
    });
  }, options.intervalMs ?? REFRESH_MS);
  timer.unref();
  return () => clearInterval(timer);
}
