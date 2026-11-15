import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import path from "node:path";
import type { InstallManifest } from "../manifest";
import { writeDaemonEnv } from "../resolve-cli";
import type { LegacyAutostart, PlatformHooks, PlatformName, PlatformOptions, PortOwner, RetiredRecord } from "./index";

/**
 * The recording PlatformHooks for tests (ROKID_SETUP_TEST=1,
 * ROKID_SETUP_PLATFORM=fake). Everything lives in ROKID_SETUP_FAKE_DIR, so a
 * test and any number of setup processes share one fake machine:
 *
 * - `scenario.json` (written by the test): what the machine looks like
 * - `calls.jsonl`: every hook call, in order
 * - `state.json`: the fake daemons (real processes serving /health) and the autostart
 *
 * A daemon is started the way the agentd wrapper starts it, sourcing
 * `~/.rokid-coder/env`, so its /health also reports the PATH it runs with.
 */
export interface FakeScenario {
  legacy?: { label?: string; plist: string; executable: string; version?: string };
  /** Processes holding the ports that are neither ours nor the legacy agent's. */
  others?: Array<{ port: number; pid: number; exe: string }>;
  /** stopCurrent returns while the product daemon still runs, and portOwners cannot see it. */
  stopLeavesRunning?: boolean;
  autostart?: "running" | "pending_next_login";
  tailscale?: boolean;
  /** A file the legacy daemon keeps rewriting until it is stopped: state written while it runs. */
  daemonWrites?: string;
}

export interface FakeDaemon {
  pid: number;
  port: number;
  version: string;
  execPath: string;
  role: "current" | "legacy";
  hidden?: boolean;
}

interface FakeState {
  daemons: FakeDaemon[];
  autostart?: { bundleDir: string; version: string };
}

export interface FakeHealth {
  ok: boolean;
  agentdVersion: string;
  execPath: string;
  bundleRoot: string | null;
  path?: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(test: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function stopProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (!(await waitUntil(() => !alive(pid), 5000))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
    await waitUntil(() => !alive(pid), 2000);
  }
}

export function fakeDir(env: NodeJS.ProcessEnv): string {
  const dir = env.ROKID_SETUP_FAKE_DIR;
  if (!dir) {
    throw new Error("ROKID_SETUP_FAKE_DIR is required with ROKID_SETUP_PLATFORM=fake");
  }
  return dir;
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : fallback;
}

/** Stops every fake daemon a test left running. */
export async function stopFakeDaemons(dir: string): Promise<void> {
  const state = readJson<FakeState>(path.join(dir, "state.json"), { daemons: [] });
  await Promise.all(state.daemons.map((daemon) => stopProcess(daemon.pid)));
}

export function fakeHealth(port: number): Promise<FakeHealth | undefined> {
  return new Promise((resolve) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path: "/health", timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body) as FakeHealth);
        } catch {
          resolve(undefined);
        }
      });
    });
    outgoing.once("timeout", () => outgoing.destroy());
    outgoing.once("error", () => resolve(undefined));
    outgoing.end();
  });
}

export class FakePlatform implements PlatformHooks {
  private readonly dir: string;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(readonly name: PlatformName, options: PlatformOptions) {
    this.dir = fakeDir(options.env);
    this.home = options.home;
    this.env = options.env;
    mkdirSync(this.dir, { recursive: true });
  }

  private scenario(): FakeScenario {
    return readJson<FakeScenario>(path.join(this.dir, "scenario.json"), {});
  }

  private state(): FakeState {
    const state = readJson<FakeState>(path.join(this.dir, "state.json"), { daemons: [] });
    state.daemons = state.daemons.filter((daemon) => alive(daemon.pid));
    return state;
  }

  private save(state: FakeState): void {
    writeFileSync(path.join(this.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  private record(op: string, detail: Record<string, unknown> = {}): void {
    appendFileSync(path.join(this.dir, "calls.jsonl"), `${JSON.stringify({ op, ...detail })}\n`);
  }

  private async spawnDaemon(role: FakeDaemon["role"], version: string, execPath: string): Promise<void> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const portFile = path.join(this.dir, `port-${id}`);
    const args = JSON.stringify({ portFile, version, execPath, writes: role === "legacy" ? this.scenario().daemonWrites : undefined });
    // Started from a shell that exits at once, so the daemon is reparented and reaped by init when
    // stopped, even while the process that started it is blocked (a test's spawnSync): no zombie
    // stays "alive". It reports its own pid with its port.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        '(if [ -f "$HOME/.rokid-coder/env" ]; then . "$HOME/.rokid-coder/env"; fi; exec "$0" "$@") </dev/null >/dev/null 2>&1 &',
        process.execPath,
        __filename,
        "serve",
        args,
      ],
      { stdio: "ignore", env: { HOME: this.home, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } },
    );
    child.unref();
    if (!(await waitUntil(() => existsSync(portFile), 5000))) {
      throw new Error("the fake daemon did not start");
    }
    const [port, pid] = readFileSync(portFile, "utf8").split(" ").map(Number);
    rmSync(portFile, { force: true });
    const state = this.state();
    state.daemons.push({ pid, port, version, execPath, role });
    this.save(state);
    this.record("daemon_started", { role, version, execPath });
  }

  private async stopDaemons(which: (daemon: FakeDaemon) => boolean): Promise<void> {
    const state = this.state();
    for (const daemon of state.daemons.filter(which)) {
      await stopProcess(daemon.pid);
    }
    this.save(this.state());
  }

  /** The daemon holding the agentd port: the oldest one still running. */
  async health(): Promise<FakeHealth | undefined> {
    const daemon = this.state().daemons[0];
    return daemon ? fakeHealth(daemon.port) : undefined;
  }

  async legacyAutostart(): Promise<LegacyAutostart | undefined> {
    const legacy = this.scenario().legacy;
    if (!legacy || !existsSync(legacy.plist)) {
      return undefined;
    }
    return {
      kind: "launchd",
      label: legacy.label ?? "com.anezium.nexus-agentd",
      definitionPath: legacy.plist,
      executable: legacy.executable,
      ...(legacy.version ? { version: legacy.version } : {}),
      loaded: this.state().daemons.some((daemon) => daemon.role === "legacy"),
    };
  }

  async retireLegacyAutostart(found: LegacyAutostart): Promise<RetiredRecord> {
    this.record("retireLegacyAutostart", { label: found.label });
    await this.stopDaemons((daemon) => daemon.role === "legacy");
    const retiredDir = path.join(this.home, ".rokid-coder", "backups", "retired-legacy");
    mkdirSync(retiredDir, { recursive: true, mode: 0o700 });
    const retiredPath = path.join(retiredDir, path.basename(found.definitionPath));
    renameSync(found.definitionPath, retiredPath);
    return {
      kind: found.kind,
      label: found.label,
      originalPath: found.definitionPath,
      retiredPath,
      wasLoaded: found.loaded,
      ...(found.executable ? { executable: found.executable } : {}),
      ...(found.version ? { version: found.version } : {}),
    };
  }

  async restoreLegacyAutostart(record: RetiredRecord): Promise<void> {
    this.record("restoreLegacyAutostart", { label: record.label });
    mkdirSync(path.dirname(record.originalPath), { recursive: true });
    renameSync(record.retiredPath, record.originalPath);
  }

  async startLegacyAutostart(record: RetiredRecord): Promise<void> {
    this.record("startLegacyAutostart", { label: record.label, executable: record.executable });
    await this.spawnDaemon("legacy", record.version ?? "legacy", record.executable ?? "legacy");
  }

  async portOwners(ports: number[]): Promise<PortOwner[]> {
    const owners: PortOwner[] = [];
    for (const daemon of this.state().daemons.filter((d) => !d.hidden)) {
      for (const port of ports) owners.push({ port, pid: daemon.pid, exe: daemon.execPath, owner: daemon.role });
    }
    for (const other of this.scenario().others ?? []) {
      if (alive(other.pid)) owners.push({ ...other, owner: "other" });
    }
    return owners;
  }

  async stopCurrent(m: InstallManifest): Promise<void> {
    this.record("stopCurrent", { bundleDir: m.bundleDir, version: m.version });
    if (this.scenario().stopLeavesRunning) {
      const state = this.state();
      for (const daemon of state.daemons) if (daemon.role === "current") daemon.hidden = true;
      this.save(state);
      return;
    }
    await this.stopDaemons((daemon) => daemon.role === "current");
  }

  async installAutostart(m: InstallManifest): Promise<"running" | "pending_next_login"> {
    // What the job will meet when it starts: which bundle the agentd wrapper runs, and who is already up.
    const wrapper = path.join(this.home, ".rokid-coder", "bin", "agentd");
    this.record("installAutostart", {
      bundleDir: m.bundleDir,
      version: m.version,
      wrapper: existsSync(wrapper) ? readFileSync(wrapper, "utf8") : null,
      alive: this.state().daemons.length,
    });
    const state = this.state();
    state.autostart = { bundleDir: m.bundleDir, version: m.version };
    this.save(state);
    if (this.scenario().autostart === "pending_next_login") {
      return "pending_next_login";
    }
    // Replacing the loaded job stops its process; a stray one keeps the port, and the new one cannot bind.
    await this.stopDaemons((daemon) => daemon.role === "current" && !daemon.hidden);
    if (this.state().daemons.length > 0) {
      this.record("bind_failed", { version: m.version });
      return "running";
    }
    await this.spawnDaemon("current", m.version, path.join(realpathSync(m.bundleDir), "node", "bin", "node"));
    return "running";
  }

  async refreshDaemonEnv(m: InstallManifest): Promise<void> {
    this.record("refreshDaemonEnv", { bundleDir: m.bundleDir });
    await writeDaemonEnv({ home: this.home, env: this.env });
    if (this.state().daemons.some((daemon) => daemon.role === "current")) {
      await this.stopDaemons((daemon) => daemon.role === "current");
      await this.spawnDaemon("current", m.version, path.join(realpathSync(m.bundleDir), "node", "bin", "node"));
    }
  }

  async removeAutostart(m: InstallManifest): Promise<void> {
    this.record("removeAutostart", { bundleDir: m.bundleDir });
    const state = this.state();
    delete state.autostart;
    this.save(state);
  }

  async tailscalePresent(): Promise<boolean> {
    return this.scenario().tailscale ?? false;
  }
}

/** `fake.js serve <json>`: a daemon that answers /health as the given version and executable. */
function serve(options: { portFile: string; version: string; execPath: string; writes?: string }): void {
  const bundleRoot = path.resolve(options.execPath, "..", "..", "..");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, sessions: 0, agentdVersion: options.version, execPath: options.execPath, bundleRoot, path: process.env.PATH }),
    );
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const temp = `${options.portFile}.tmp`;
    writeFileSync(temp, `${typeof address === "object" && address ? address.port : 0} ${process.pid}`);
    renameSync(temp, options.portFile);
  });
  if (options.writes) {
    let n = 0;
    setInterval(() => writeFileSync(options.writes!, `write ${++n}\n`), 10);
  }
  process.on("SIGTERM", () => process.exit(0));
}

if (require.main === module && process.argv[2] === "serve") {
  serve(JSON.parse(process.argv[3]));
}
