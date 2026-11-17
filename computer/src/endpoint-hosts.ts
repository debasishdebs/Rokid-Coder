import { execFile, execFileSync } from "node:child_process";
import { isTailnetIpv4, tailscaleExecutableCandidates } from "./tailnet-discovery";
import type { AgentConfig } from "./types";

/**
 * The hosts a phone may dial agentd on: the LAN address first, the computer's
 * Tailscale IPv4 (100.64.0.0/10) last, so a phone that paired at home still
 * reaches the computer away from home. The address comes from the Tailscale
 * CLI (`tailscale ip -4`), the same executables tailnet discovery uses, never
 * from an interface name: macOS calls the tailnet interface `utunN`.
 */

export const MAX_ADVERTISED_HOSTS = 4;
export const TAILNET_HOST_TTL_MS = 30_000;
/** The most a pairing path may wait, in all, for the Tailscale CLI. */
export const TAILNET_HOST_BUDGET_MS = 2_000;
export const TAILNET_HOST_REFRESH_MS = 15_000;

export interface CliResult {
  missing: boolean;
  stdout?: string;
}

export interface TailnetHostProbe {
  runSync(binary: string, timeoutMs: number): CliResult;
  runAsync(binary: string, timeoutMs: number): Promise<CliResult>;
}

const ARGS = ["ip", "-4"];

const realProbe: TailnetHostProbe = {
  runSync(binary, timeoutMs) {
    try {
      const stdout = execFileSync(binary, ARGS, {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { missing: false, stdout };
    } catch (error) {
      return { missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
    }
  },
  runAsync(binary, timeoutMs) {
    return new Promise((resolve) => {
      execFile(
        binary,
        ARGS,
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", windowsHide: true, shell: false },
        (error, stdout) => {
          resolve({
            missing: (error as NodeJS.ErrnoException | null)?.code === "ENOENT",
            stdout: error ? undefined : stdout,
          });
        },
      );
    });
  },
};

/** The first Tailscale IPv4 in `tailscale ip -4`'s output; anything else is no address. */
export function parseTailnetIpv4(stdout: string | undefined): string | undefined {
  return stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(isTailnetIpv4);
}

export interface TailnetHostCacheOptions {
  probe?: TailnetHostProbe;
  candidates?: () => string[];
  now?: () => number;
  ttlMs?: number;
  budgetMs?: number;
}

/**
 * This computer's Tailscale IPv4, cached (an absent answer too). It never
 * throws: no CLI, a failing CLI and a slow one all mean "no tailnet host".
 * `get` is for the synchronous pairing path and waits at most the budget on a
 * cold cache; `refresh` keeps the cache warm without blocking the daemon.
 */
export class TailnetHostCache {
  private value?: string;
  private at = Number.NEGATIVE_INFINITY;
  private inflight?: Promise<string | undefined>;
  private readonly probe: TailnetHostProbe;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly budgetMs: number;
  private readonly candidates: () => string[];

  constructor(options: TailnetHostCacheOptions = {}) {
    this.probe = options.probe ?? realProbe;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? TAILNET_HOST_TTL_MS;
    this.budgetMs = options.budgetMs ?? TAILNET_HOST_BUDGET_MS;
    this.candidates = options.candidates ?? (() => tailscaleExecutableCandidates());
  }

  private fresh(): boolean {
    return this.now() - this.at < this.ttlMs;
  }

  private store(value: string | undefined): string | undefined {
    this.value = value;
    this.at = this.now();
    return value;
  }

  get(): string | undefined {
    if (this.fresh()) {
      return this.value;
    }
    try {
      const deadline = this.now() + this.budgetMs;
      for (const binary of this.candidates()) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          break;
        }
        const found = parseTailnetIpv4(this.probe.runSync(binary, remaining).stdout);
        if (found) {
          return this.store(found);
        }
      }
    } catch {
      // Whatever went wrong, the answer is no tailnet host.
    }
    return this.store(undefined);
  }

  refresh(): Promise<string | undefined> {
    this.inflight ??= this.probeAsync().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async probeAsync(): Promise<string | undefined> {
    try {
      const deadline = this.now() + this.budgetMs;
      for (const binary of this.candidates()) {
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          break;
        }
        const found = parseTailnetIpv4((await this.probe.runAsync(binary, remaining)).stdout);
        if (found) {
          return this.store(found);
        }
      }
    } catch {
      // see get()
    }
    return this.store(undefined);
  }
}

const sharedCache = new TailnetHostCache();

/** The tailnet host to advertise, or none; `tailnetDiscovery: false` also means "do not run the Tailscale CLI". */
export function tailnetHostFor(config: AgentConfig, cache: Pick<TailnetHostCache, "get"> = sharedCache): string | undefined {
  return config.tailnetDiscovery === false ? undefined : cache.get();
}

/** The daemon keeps the shared cache warm in the background so pairing never waits on the CLI. Returns its stop. */
export function startTailnetHostRefresh(config: AgentConfig, intervalMs = TAILNET_HOST_REFRESH_MS, cache: Pick<TailnetHostCache, "refresh"> = sharedCache): () => void {
  if (config.tailnetDiscovery === false) {
    return () => undefined;
  }
  void cache.refresh();
  const timer = setInterval(() => void cache.refresh(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function dedupe(hosts: string[]): string[] {
  return [...new Set(hosts.filter((host) => host.length > 0))];
}

/**
 * The LAN way: LAN address(es) first, the tailnet address last. A LAN guess
 * that is itself a tailnet address (a machine with only Tailscale) moves to the
 * end, and the cap never costs the tailnet address its place.
 */
export function lanThenTailnet(lan: string[], tailnet: string | undefined, max = MAX_ADVERTISED_HOSTS): string[] {
  const last = tailnet ?? lan.find(isTailnetIpv4);
  const front = dedupe(lan).filter((host) => host !== last && !isTailnetIpv4(host));
  return last ? [...front.slice(0, max - 1), last] : front.slice(0, max);
}

/**
 * The Windows/WSL way: the record's hosts keep their order (the first one is
 * what old phones dial), and the tailnet address is appended when the list
 * lacks one, taking the last place if the list is full.
 */
export function ensureTailnet(hosts: string[], tailnet: string | undefined, max = MAX_ADVERTISED_HOSTS): string[] {
  const unique = dedupe(hosts);
  if (!tailnet || unique.some(isTailnetIpv4)) {
    return unique.slice(0, max);
  }
  return [...unique.slice(0, max - 1), tailnet];
}
