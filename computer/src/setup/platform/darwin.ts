import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { type InstallManifest, programDir, readManifest, writePrivateFile } from "../manifest";
import { writeDaemonEnv } from "../resolve-cli";
import { stateLocations } from "../state";
import { AUTOSTART, type LegacyAutostart, type PlatformHooks, type PlatformOptions, type PortOwner, type RetiredRecord } from "./index";

/** 0.8.0's LaunchAgent (`agentd/scripts/install-launchagent.sh:10`). */
export const LEGACY_LABEL = "com.anezium.nexus-agentd";
export const LABEL = AUTOSTART.darwin.label;
/** Where the package puts the versioned bundles. */
export const SYSTEM_ROOT = "/Library/Application Support/RokidCoder";

const LAUNCHCTL = "/bin/launchctl";
const LSOF = "/usr/sbin/lsof";
const PLUTIL = "/usr/bin/plutil";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[]) => Promise<RunResult>;

export interface DarwinOptions extends PlatformOptions {
  uid?: number;
  /** How launchctl and lsof are run; tests pass a fake machine. */
  run?: Runner;
  pollMs?: number;
  /** How long to wait for launchd to release a label, and for the ports to free (20 s). */
  timeoutMs?: number;
}

const execRunner: Runner = (command, args) =>
  new Promise((resolve) => {
    execFile(command, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });

// ---- plists ----

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function xmlDecode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_, entity: string) =>
    entity.startsWith("#x") ? String.fromCodePoint(parseInt(entity.slice(2), 16)) : entity.startsWith("#") ? String.fromCodePoint(Number(entity.slice(1))) : ENTITIES[entity],
  );
}

function xmlEncode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A top-level `<key>` whose value is an array of strings, from an XML plist. */
export function readPlistArray(xml: string, key: string): string[] | undefined {
  const match = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(xml);
  if (!match) return undefined;
  return [...match[1].matchAll(/<string>([\s\S]*?)<\/string>|<string\/>/g)].map((m) => xmlDecode(m[1] ?? ""));
}

export function readPlistString(xml: string, key: string): string | undefined {
  const match = new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(xml);
  return match ? xmlDecode(match[1]) : undefined;
}

/**
 * The product's LaunchAgent. It runs the user's agentd wrapper, which sources
 * ~/.rokid-coder/env and execs the versioned bundle, so the plist stays the
 * same across upgrades. No KeepAlive, as in 0.8.0 (install-launchagent.sh:140):
 * a second instance exits on EADDRINUSE and launchd would respawn it in a loop.
 */
export function renderLaunchAgentPlist(home: string): string {
  const logs = path.join(programDir(home), "logs");
  const string = (value: string): string => `<string>${xmlEncode(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${string(path.join(programDir(home), "bin", "agentd"))}
    ${string("run")}
  </array>
  <key>WorkingDirectory</key>
  ${string(home)}
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  ${string("Background")}
  <key>StandardOutPath</key>
  ${string(path.join(logs, "agentd.out.log"))}
  <key>StandardErrorPath</key>
  ${string(path.join(logs, "agentd.err.log"))}
</dict>
</plist>
`;
}

function realpathOr(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** The macOS half of setup: launchd in the user's GUI domain, and lsof for who holds the ports. */
export class DarwinPlatform implements PlatformHooks {
  readonly name = "darwin" as const;
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly uid: number;
  private readonly run: Runner;
  private readonly pollMs: number;
  private readonly timeoutMs: number;

  constructor(options: DarwinOptions) {
    this.home = options.home;
    this.env = options.env;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.run = options.run ?? execRunner;
    this.pollMs = options.pollMs ?? 200;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private get domain(): string {
    return `gui/${this.uid}`;
  }

  private agentPlist(): string {
    return path.join(this.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  }

  private legacyPlist(): string {
    return path.join(this.home, "Library", "LaunchAgents", `${LEGACY_LABEL}.plist`);
  }

  private ports(): number[] {
    try {
      const config = JSON.parse(readFileSync(path.join(stateLocations(this.home, this.env).nexusDir, "config.json"), "utf8")) as { httpPort?: unknown; wsPort?: unknown };
      const ports = [config.httpPort, config.wsPort].filter((port): port is number => Number.isInteger(port));
      if (ports.length === 2) return ports;
    } catch {
      // the defaults
    }
    return [8791, 8792];
  }

  private async until(probe: () => Promise<boolean>): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      if (await probe()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  private async job(label: string): Promise<{ loaded: boolean; pid?: number }> {
    const result = await this.run(LAUNCHCTL, ["print", `${this.domain}/${label}`]);
    if (result.code !== 0) return { loaded: false };
    const pid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout);
    return { loaded: true, ...(pid ? { pid: Number(pid[1]) } : {}) };
  }

  /**
   * bootout returns before launchd has released the label, and a bootstrap
   * into that gap fails with "Bootstrap failed: 5", so wait until `print`
   * fails (the loop in install-launchagent.sh:155-161).
   */
  private async bootout(label: string): Promise<void> {
    if (!(await this.job(label)).loaded) return;
    await this.run(LAUNCHCTL, ["bootout", `${this.domain}/${label}`]);
    if (!(await this.until(async () => !(await this.job(label)).loaded))) {
      throw new Error(`launchd did not let go of ${label}`);
    }
  }

  private async listeners(ports: number[]): Promise<Array<{ pid: number; port: number }>> {
    const result = await this.run(LSOF, ["-nP", `-iTCP:${ports.join(",")}`, "-sTCP:LISTEN", "-Fpn"]);
    const found: Array<{ pid: number; port: number }> = [];
    let pid: number | undefined;
    for (const line of result.stdout.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("n") && pid !== undefined) {
        const port = Number(line.slice(line.lastIndexOf(":") + 1));
        if (ports.includes(port) && !found.some((f) => f.pid === pid && f.port === port)) found.push({ pid, port });
      }
    }
    return found;
  }

  private async portsFree(ports: number[]): Promise<boolean> {
    return this.until(async () => (await this.listeners(ports)).length === 0);
  }

  private async stopJob(): Promise<void> {
    await this.bootout(LABEL);
    const ports = this.ports();
    if (!(await this.portsFree(ports))) {
      const [held] = await this.listeners(ports);
      throw new Error(`port ${held?.port ?? ports[0]} is still held by pid ${held?.pid ?? "?"} after agentd was stopped`);
    }
  }

  /** The executable lsof reports for pid: its first `txt` file. */
  private async executable(pid: number): Promise<string> {
    const result = await this.run(LSOF, ["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
    const line = result.stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? realpathOr(line.slice(1)) : "";
  }

  private readPlistXml(file: string): Promise<string> | string {
    const raw = readFileSync(file, "utf8");
    if (raw.trimStart().startsWith("<")) return raw;
    return this.run(PLUTIL, ["-convert", "xml1", "-o", "-", file]).then((result) => (result.code === 0 ? result.stdout : ""));
  }

  /** What the 0.8.0 plist runs (`ProgramArguments[0]`), wherever the plist is now. */
  private legacyExecutables(): Set<string> {
    const executables = new Set<string>();
    for (const file of [this.legacyPlist(), path.join(this.retiredDir(), `${LEGACY_LABEL}.plist`)]) {
      try {
        const executable = readPlistArray(readFileSync(file, "utf8"), "ProgramArguments")?.[0];
        if (executable) executables.add(realpathOr(executable));
      } catch {
        // not there
      }
    }
    return executables;
  }

  private retiredDir(): string {
    return path.join(programDir(this.home), "backups", "retired-legacy");
  }

  async legacyAutostart(): Promise<LegacyAutostart | undefined> {
    const plist = this.legacyPlist();
    if (!existsSync(plist)) return undefined;
    const args = readPlistArray(await this.readPlistXml(plist), "ProgramArguments") ?? [];
    const executable = args[0];
    let version: string | undefined;
    const cli = args.find((arg) => arg.endsWith(path.join("dist", "cli.js")));
    if (cli) {
      try {
        const manifest = JSON.parse(readFileSync(path.resolve(cli, "..", "..", "package.json"), "utf8")) as { version?: unknown };
        if (typeof manifest.version === "string") version = manifest.version;
      } catch {
        // a checkout without its package.json
      }
    }
    return {
      kind: "launchd",
      label: LEGACY_LABEL,
      definitionPath: plist,
      ...(executable ? { executable } : {}),
      ...(version ? { version } : {}),
      loaded: (await this.job(LEGACY_LABEL)).loaded,
    };
  }

  async retireLegacyAutostart(found: LegacyAutostart): Promise<RetiredRecord> {
    await this.bootout(found.label);
    mkdirSync(this.retiredDir(), { recursive: true, mode: 0o700 });
    const retiredPath = path.join(this.retiredDir(), path.basename(found.definitionPath));
    renameSync(found.definitionPath, retiredPath);
    // The record is returned even if a straggler still holds a port: setup's own wait then fails
    // with the record journaled, so recovery can put this plist back.
    await this.portsFree(this.ports());
    return {
      kind: "launchd",
      label: found.label,
      originalPath: found.definitionPath,
      retiredPath,
      wasLoaded: found.loaded,
      ...(found.executable ? { executable: found.executable } : {}),
      ...(found.version ? { version: found.version } : {}),
    };
  }

  async restoreLegacyAutostart(record: RetiredRecord): Promise<void> {
    if (existsSync(record.retiredPath)) {
      mkdirSync(path.dirname(record.originalPath), { recursive: true });
      renameSync(record.retiredPath, record.originalPath);
    } else if (!existsSync(record.originalPath)) {
      throw new Error(`the retired ${record.label} plist is gone (${record.retiredPath})`);
    }
  }

  async startLegacyAutostart(record: RetiredRecord): Promise<void> {
    const result = await this.run(LAUNCHCTL, ["bootstrap", this.domain, record.originalPath]);
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap ${record.label} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
  }

  async portOwners(ports: number[]): Promise<PortOwner[]> {
    const listening = await this.listeners(ports);
    if (listening.length === 0) return [];
    const current = await this.job(LABEL);
    const legacy = await this.job(LEGACY_LABEL);
    const ourNodes = new Set<string>();
    try {
      const manifest = readManifest(this.home);
      for (const dir of [manifest?.bundleDir, manifest?.previous?.bundleDir]) {
        if (dir) ourNodes.add(realpathOr(path.join(dir, "node", "bin", "node")));
      }
    } catch {
      // an unreadable manifest: the system root still identifies our bundles
    }
    const legacyExecutables = this.legacyExecutables();
    const exes = new Map<number, string>();
    const owners: PortOwner[] = [];
    for (const { pid, port } of listening) {
      if (!exes.has(pid)) exes.set(pid, await this.executable(pid));
      const exe = exes.get(pid)!;
      const ours = ourNodes.has(exe) || (exe.startsWith(`${SYSTEM_ROOT}/`) && exe.endsWith("/node/bin/node"));
      const owner = pid === current.pid || ours ? "current" : pid === legacy.pid || legacyExecutables.has(exe) ? "legacy" : "other";
      owners.push({ port, pid, exe, owner });
    }
    return owners;
  }

  async stopCurrent(_m: InstallManifest): Promise<void> {
    // The plist stays, so an undo can bootstrap it again.
    await this.stopJob();
  }

  async installAutostart(_m: InstallManifest): Promise<"running" | "pending_next_login"> {
    mkdirSync(path.join(programDir(this.home), "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(path.dirname(this.agentPlist()), { recursive: true });
    writePrivateFile(this.agentPlist(), renderLaunchAgentPlist(this.home), 0o644);
    if ((await this.run(LAUNCHCTL, ["print", this.domain])).code !== 0) {
      // No GUI session for this user: launchd loads the plist at their next login.
      return "pending_next_login";
    }
    // A bare bootstrap would not replace a loaded label [6b-R4].
    if ((await this.job(LABEL)).loaded) await this.stopJob();
    const result = await this.run(LAUNCHCTL, ["bootstrap", this.domain, this.agentPlist()]);
    if (result.code !== 0) {
      throw new Error(`launchctl bootstrap ${LABEL} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
    return "running";
  }

  async refreshDaemonEnv(_m: InstallManifest): Promise<void> {
    await writeDaemonEnv({ home: this.home, env: this.env });
    if (!(await this.job(LABEL)).loaded) return;
    const result = await this.run(LAUNCHCTL, ["kickstart", "-k", `${this.domain}/${LABEL}`]);
    if (result.code !== 0) {
      throw new Error(`launchctl kickstart ${LABEL} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
    }
  }

  async removeAutostart(_m: InstallManifest): Promise<void> {
    await this.bootout(LABEL);
    rmSync(this.agentPlist(), { force: true });
  }

  async tailscalePresent(): Promise<boolean> {
    return ["/Applications/Tailscale.app", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"].some((file) => existsSync(file));
  }
}

export function createPlatform(options: PlatformOptions): PlatformHooks {
  return new DarwinPlatform(options);
}
