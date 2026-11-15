import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import type { InstallManifest } from "../manifest";
import { SetupError } from "../orchestrator";
import { writeDaemonEnv } from "../resolve-cli";
import { stateLocations } from "../state";
import { type LegacyAutostart, type PlatformHooks, type PlatformOptions, type PortOwner, type RetiredRecord, isTestMode } from "./index";

/**
 * The WSL half of setup (6b T8). It runs inside the distro and reaches Windows
 * only through interop: schtasks.exe for the task, and powershell.exe for
 * fixed scripts whose data arrives on stdin as JSON, never in the script.
 *
 * Every path handed to a Windows executable is a Windows path, either the
 * manifest's `win` field or `wslpath -w` [6b-R18]: interop passes argv through
 * untranslated, so a /home/... path names nothing there.
 */

export const TASK_PATH = "\\RokidCoder\\";
export const TASK_NAME = "agentd";
export const TASK = `${TASK_PATH}${TASK_NAME}`;
export const LEGACY_TASK = "NexusAgentd";
const DEFAULT_SYSTEM32 = "/mnt/c/Windows/System32";
const LEGACY_PORTS = [8791, 8792];
/** Host processes that only relay a WSL listener (NAT localhost forwarding): the WSL side says who owns it. */
const RELAY_IMAGES = new Set(["wslrelay.exe", "wslhost.exe", "vmmem", "vmmemwsl", "vmwp.exe"]);

const UTF8_OUT = "[Console]::OutputEncoding = [Text.Encoding]::UTF8";
const READ_INPUT = "$q = [Console]::In.ReadToEnd() | ConvertFrom-Json";

export const SCRIPTS = {
  localAppData: `<# rokid:local-app-data #> ${UTF8_OUT}; [Environment]::GetFolderPath('LocalApplicationData')`,
  listeners:
    `<# rokid:listeners #> ${UTF8_OUT}; ${READ_INPUT}; ` +
    "$c = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $q.ports -contains [int]$_.LocalPort }); " +
    "$r = @(foreach ($x in $c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$x.OwningProcess); " +
    "[pscustomobject]@{ port = [int]$x.LocalPort; pid = [int]$x.OwningProcess; name = [string]$p.Name; executablePath = [string]$p.ExecutablePath; " +
    "commandLine = [string]$p.CommandLine; creationDate = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } }); " +
    "if ($r.Count -gt 0) { ConvertTo-Json -InputObject $r -Compress }",
  stopExact:
    `<# rokid:stop-exact #> ${UTF8_OUT}; ${READ_INPUT}; ` +
    "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$q.pid); " +
    "if (-not $p) { 'gone' } " +
    "elseif ([string]$p.ExecutablePath -cne $q.executablePath -or [string]$p.CommandLine -cne $q.commandLine -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $q.creationDate) { 'mismatch' } " +
    "else { Stop-Process -Id ([int]$q.pid) -Force; 'stopped' }",
  // Export-ScheduledTask, written by .NET as UTF-16LE with a BOM: a pipe from schtasks /Query /XML
  // would carry the console code page and mangle a non-ASCII user name in the paths.
  exportTask:
    `<# rokid:export-task #> ${UTF8_OUT}; ${READ_INPUT}; ` +
    "$t = Get-ScheduledTask -TaskPath $q.taskPath -TaskName $q.taskName -ErrorAction SilentlyContinue; " +
    "if (-not $t) { 'absent' } else { $x = Export-ScheduledTask -TaskPath $q.taskPath -TaskName $q.taskName; " +
    "[IO.File]::WriteAllText($q.file, $x, (New-Object Text.UnicodeEncoding $false, $true)); 'exported' }",
} as const;

export interface HostProcess {
  port: number;
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  creationDate: string;
}

interface RunResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

export interface WslDeps {
  /** The Linux path of Windows' System32 (normally /mnt/c/Windows/System32). */
  system32: string;
  procRoot: string;
  /** How long a stopped process gets before SIGKILL, and the old agent before setup gives up. */
  stopTimeoutMs: number;
  /** A person can stop a stuck old agent themselves while setup waits. */
  interactive: boolean;
  env: NodeJS.ProcessEnv;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { encoding: "buffer", env, maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        status: error ? (typeof code === "number" ? code : 127) : 0,
        stdout: stdout ?? Buffer.alloc(0),
        stderr: `${stderr ?? ""}${error && typeof code !== "number" ? error.message : ""}`,
      });
    });
    child.stdin?.end(input ?? "");
  });
}

/** JSON with every non-ASCII character escaped: stdin to a Windows process has no reliable encoding. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function decodeXml(bytes: Buffer): string {
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** A `node.exe` running `…\dist\cli.js run`: 0.8.0's agentd, started by run-hidden.vbs. */
export function isLegacyDaemon(proc: Pick<HostProcess, "name" | "commandLine">): boolean {
  return proc.name.toLowerCase() === "node.exe" && /\\dist\\cli\.js"?\s+run(\s|$)/i.test(proc.commandLine);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(test: () => Promise<boolean> | boolean, ms: number, every = 100): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await test()) return true;
    if (Date.now() > deadline) return false;
    await sleep(every);
  }
}

function agentdPorts(home: string, env: NodeJS.ProcessEnv): number[] {
  try {
    const config = JSON.parse(readFileSync(path.join(stateLocations(home, env).nexusDir, "config.json"), "utf8")) as { httpPort?: unknown; wsPort?: unknown };
    const ports = [config.httpPort, config.wsPort].filter((port): port is number => Number.isInteger(port));
    if (ports.length === 2) return ports;
  } catch {
    // the defaults
  }
  return [8791, 8792];
}

export class WslPlatform implements PlatformHooks {
  readonly name = "wsl" as const;
  private journal?: { linux: string; win: string };
  private legacyIdentity?: HostProcess;

  constructor(
    private readonly options: PlatformOptions,
    private readonly deps: WslDeps,
  ) {}

  // ---- interop ----

  private schtasks(args: string[]): Promise<RunResult> {
    return run(path.join(this.deps.system32, "schtasks.exe"), args, this.deps.env);
  }

  private async powershell(script: string, input?: unknown): Promise<string> {
    const file = path.join(this.deps.system32, "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = await run(file, ["-NoProfile", "-NonInteractive", "-Command", script], this.deps.env, input === undefined ? undefined : asciiJson(input));
    if (result.status !== 0) {
      throw new SetupError(`powershell.exe failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout.toString("utf8").trim();
  }

  private async wslpath(flag: "-u" | "-w", value: string): Promise<string> {
    const result = await run("wslpath", [flag, value], this.deps.env);
    if (result.status !== 0) throw new SetupError(`wslpath ${flag} failed for ${value}: ${result.stderr.trim()}`);
    return result.stdout.toString("utf8").trim();
  }

  /** `%LOCALAPPDATA%\RokidCoder\journal`, both ways: the Windows-side home of the exported task definitions. */
  private async journalDir(): Promise<{ linux: string; win: string }> {
    if (!this.journal) {
      const localAppData = (await this.powershell(SCRIPTS.localAppData)).split(/\r?\n/)[0].trim();
      if (!/^[A-Za-z]:\\/.test(localAppData)) throw new SetupError(`Windows reported no local app data folder (${localAppData})`);
      const win = `${localAppData.replace(/\\+$/, "")}\\RokidCoder\\journal`;
      const linux = await this.wslpath("-u", win);
      mkdirSync(linux, { recursive: true });
      this.journal = { linux, win };
    }
    return this.journal;
  }

  private async exportTask(taskPath: string, taskName: string, file: string): Promise<boolean> {
    return (await this.powershell(SCRIPTS.exportTask, { taskPath, taskName, file })) === "exported";
  }

  private async hostListeners(ports: number[]): Promise<HostProcess[]> {
    const out = await this.powershell(SCRIPTS.listeners, { ports });
    if (!out) return [];
    const parsed = JSON.parse(out) as HostProcess | HostProcess[];
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  // ---- the distro's processes ----

  private pids(): number[] {
    try {
      return readdirSync(this.deps.procRoot)
        .filter((name) => /^\d+$/.test(name))
        .map(Number)
        .filter(alive);
    } catch {
      return [];
    }
  }

  private exeOf(pid: number): string | undefined {
    try {
      return readlinkSync(path.join(this.deps.procRoot, String(pid), "exe"));
    } catch {
      return undefined;
    }
  }

  private cmdlineOf(pid: number): string[] {
    try {
      return readFileSync(path.join(this.deps.procRoot, String(pid), "cmdline"), "utf8").split("\0").filter((part, i, all) => part !== "" || i < all.length - 1);
    } catch {
      return [];
    }
  }

  /** Listening sockets on `ports` in the distro: inode -> port. */
  private listeningInodes(ports: number[]): Map<string, number> {
    const inodes = new Map<string, number>();
    for (const table of ["tcp", "tcp6"]) {
      let text = "";
      try {
        text = readFileSync(path.join(this.deps.procRoot, "net", table), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n").slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[3] !== "0A") continue;
        const port = parseInt(fields[1].split(":").pop() ?? "", 16);
        if (ports.includes(port)) inodes.set(fields[9], port);
      }
    }
    return inodes;
  }

  private distroOwners(ports: number[]): PortOwner[] {
    const inodes = this.listeningInodes(ports);
    if (inodes.size === 0) return [];
    const bundles = path.join(this.options.home, ".local", "share", "rokid-coder");
    const owners: PortOwner[] = [];
    const seen = new Set<string>();
    for (const pid of this.pids()) {
      let fds: string[] = [];
      try {
        fds = readdirSync(path.join(this.deps.procRoot, String(pid), "fd"));
      } catch {
        continue;
      }
      for (const fd of fds) {
        let link = "";
        try {
          link = readlinkSync(path.join(this.deps.procRoot, String(pid), "fd", fd));
        } catch {
          continue;
        }
        const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1];
        const port = inode ? inodes.get(inode) : undefined;
        if (port === undefined || !inode) continue;
        seen.add(inode);
        const exe = this.exeOf(pid) ?? "unknown";
        owners.push({ port, pid, exe, owner: exe.startsWith(`${bundles}${path.sep}`) ? "current" : "other" });
      }
    }
    // A socket whose process this user cannot see belongs to someone else.
    for (const [inode, port] of inodes) {
      if (!seen.has(inode)) owners.push({ port, pid: 0, exe: "a process of another user", owner: "other" });
    }
    return owners;
  }

  /** The PIDs of `m`'s own agentd: the bundle's node running the bundle's `app/dist/cli.js run`. */
  private productPids(m: InstallManifest): number[] {
    let root = m.bundleDir;
    try {
      root = realpathSync(m.bundleDir);
    } catch {
      // compare as recorded
    }
    const node = path.join(root, "node", "bin", "node");
    const cli = path.join(root, "app", "dist", "cli.js");
    return this.pids().filter((pid) => {
      if (this.exeOf(pid) !== node) return false;
      const [, script, command] = this.cmdlineOf(pid);
      if (command !== "run" || !script) return false;
      try {
        return realpathSync(script) === cli;
      } catch {
        return path.resolve(script) === cli;
      }
    });
  }

  // ---- PlatformHooks ----

  async legacyAutostart(): Promise<LegacyAutostart | undefined> {
    if ((await this.schtasks(["/Query", "/TN", LEGACY_TASK])).status !== 0) {
      return undefined;
    }
    const identity = (await this.hostListeners(LEGACY_PORTS)).find(isLegacyDaemon);
    this.legacyIdentity = identity;
    return {
      kind: "wsl-task",
      label: LEGACY_TASK,
      definitionPath: `\\${LEGACY_TASK}`,
      ...(identity ? { executable: identity.executablePath } : {}),
      ...(identity ? await this.legacyVersion(identity) : {}),
      loaded: Boolean(identity),
    };
  }

  /** 0.8.0's version, from the package.json beside the `dist\cli.js` its node runs. */
  private async legacyVersion(identity: HostProcess): Promise<{ version?: string }> {
    const cli = /([A-Za-z]:\\[^"]*\\dist\\cli\.js)/i.exec(identity.commandLine)?.[1];
    if (!cli) return {};
    try {
      const linux = await this.wslpath("-u", cli);
      const { version } = JSON.parse(readFileSync(path.join(path.dirname(path.dirname(linux)), "package.json"), "utf8")) as { version?: unknown };
      return typeof version === "string" ? { version } : {};
    } catch {
      return {};
    }
  }

  private async legacyHolders(): Promise<HostProcess[]> {
    return (await this.hostListeners(LEGACY_PORTS)).filter((proc) => !RELAY_IMAGES.has(proc.name.toLowerCase()) && isLegacyDaemon(proc));
  }

  async retireLegacyAutostart(found: LegacyAutostart): Promise<RetiredRecord> {
    const journal = await this.journalDir();
    const file = { linux: path.join(journal.linux, `${LEGACY_TASK}.xml`), win: `${journal.win}\\${LEGACY_TASK}.xml` };
    if (!(await this.exportTask("\\", LEGACY_TASK, file.win))) {
      throw new SetupError(`The old ${LEGACY_TASK} task could not be exported, so it was left as it was`);
    }
    const deleted = await this.schtasks(["/Delete", "/TN", LEGACY_TASK, "/F"]);
    if (deleted.status !== 0) throw new SetupError(`The old ${LEGACY_TASK} task could not be removed: ${deleted.stderr.trim()}`);
    try {
      // Deleting the task leaves its detached node running (run-hidden.vbs:8): stop that exact process.
      const identity = this.legacyIdentity ?? (await this.legacyHolders())[0];
      if (identity) {
        const outcome = await this.powershell(SCRIPTS.stopExact, {
          pid: identity.pid,
          executablePath: identity.executablePath,
          commandLine: identity.commandLine,
          creationDate: identity.creationDate,
        });
        if (outcome === "mismatch") throw new SetupError(`Stop the old agentd (pid ${identity.pid}) yourself: it is no longer the process setup found`);
      }
      const free = async (): Promise<boolean> => (await this.hostListeners(LEGACY_PORTS)).filter((proc) => !RELAY_IMAGES.has(proc.name.toLowerCase())).length === 0;
      if (!(await waitUntil(free, this.deps.stopTimeoutMs, 250))) {
        const holder = (await this.hostListeners(LEGACY_PORTS))[0];
        const message = `Stop the old agentd (pid ${holder?.pid ?? identity?.pid ?? "?"}), then setup continues`;
        if (!this.deps.interactive) throw new SetupError(message);
        process.stderr.write(`${message}\n`);
        await waitUntil(free, Number.POSITIVE_INFINITY, 1000);
      }
    } catch (error) {
      // Nothing records the retire until this returns: put the definition back before failing.
      await this.schtasks(["/Create", "/TN", LEGACY_TASK, "/XML", file.win, "/F"]);
      throw error;
    }
    return {
      kind: "wsl-task",
      label: LEGACY_TASK,
      originalPath: found.definitionPath,
      retiredPath: file.linux,
      wasLoaded: found.loaded,
      ...(found.executable ? { executable: found.executable } : {}),
      ...(found.version ? { version: found.version } : {}),
    };
  }

  async restoreLegacyAutostart(record: RetiredRecord): Promise<void> {
    const created = await this.schtasks(["/Create", "/TN", LEGACY_TASK, "/XML", await this.wslpath("-w", record.retiredPath), "/F"]);
    if (created.status !== 0) throw new SetupError(`The old ${LEGACY_TASK} task could not be re-created: ${created.stderr.trim()}`);
  }

  async startLegacyAutostart(_record: RetiredRecord): Promise<void> {
    const started = await this.schtasks(["/Run", "/TN", LEGACY_TASK]);
    if (started.status !== 0) throw new SetupError(`The old ${LEGACY_TASK} task did not start: ${started.stderr.trim()}`);
  }

  async portOwners(ports: number[]): Promise<PortOwner[]> {
    const owners = this.distroOwners(ports);
    for (const proc of await this.hostListeners(ports)) {
      if (RELAY_IMAGES.has(proc.name.toLowerCase())) continue;
      owners.push({ port: proc.port, pid: proc.pid, exe: proc.executablePath || proc.name, owner: isLegacyDaemon(proc) ? "legacy" : "other" });
    }
    return owners;
  }

  async stopCurrent(m: InstallManifest): Promise<void> {
    // The task's own process (powershell, wsl.exe) ends here; the Linux agentd it started may not.
    await this.schtasks(["/End", "/TN", TASK]);
    const pids = this.productPids(m);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // gone already
      }
    }
    const ports = agentdPorts(this.options.home, this.options.env);
    const stopped = (): boolean => pids.every((pid) => !alive(pid)) && this.distroOwners(ports).every((owner) => !pids.includes(owner.pid));
    if (await waitUntil(stopped, this.deps.stopTimeoutMs)) return;
    for (const pid of pids.filter(alive)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone already
      }
    }
    await waitUntil(stopped, 2000);
  }

  async installAutostart(m: InstallManifest): Promise<"running" | "pending_next_login"> {
    const binding = m.binding;
    if (!binding) throw new SetupError("This WSL install has no binding: run the Windows installer again");
    const journal = await this.journalDir();
    const previous = { linux: path.join(journal.linux, "task-previous.xml"), win: `${journal.win}\\task-previous.xml` };
    let source = binding.taskXmlPath.win;
    if (existsSync(previous.linux) && decodeXml(readFileSync(previous.linux)).includes(xmlEscape(binding.bindingPath.win))) {
      // Recovery or rollback to the install the definition was exported from: re-create it exactly.
      source = previous.win;
    } else if (!(await this.exportTask(TASK_PATH, TASK_NAME, previous.win))) {
      rmSync(previous.linux, { force: true });
    }
    // /F replaces the registered definition; with IgnoreNew, a still-running old agentd is stopCurrent's to end.
    const created = await this.schtasks(["/Create", "/TN", TASK, "/XML", source, "/F"]);
    if (created.status !== 0) throw new SetupError(`The ${TASK} task could not be registered: ${created.stderr.trim()}`);
    const started = await this.schtasks(["/Run", "/TN", TASK]);
    if (started.status !== 0) throw new SetupError(`The ${TASK} task did not start: ${started.stderr.trim()}`);
    return "running";
  }

  async refreshDaemonEnv(m: InstallManifest): Promise<void> {
    await writeDaemonEnv({ home: this.options.home, env: this.options.env });
    await this.stopCurrent(m);
    const started = await this.schtasks(["/Run", "/TN", TASK]);
    if (started.status !== 0) throw new SetupError(`The ${TASK} task did not start: ${started.stderr.trim()}`);
  }

  async removeAutostart(_m: InstallManifest): Promise<void> {
    // Absent already is fine: uninstall may run twice.
    await this.schtasks(["/Delete", "/TN", TASK, "/F"]);
  }

  async tailscalePresent(): Promise<boolean> {
    const drive = path.dirname(path.dirname(this.deps.system32));
    return existsSync(path.join(drive, "Program Files", "Tailscale", "tailscale.exe")) || existsSync("/usr/bin/tailscale");
  }
}

export function createPlatform(options: PlatformOptions, overrides: Partial<WslDeps> = {}): PlatformHooks {
  const test = isTestMode(options.env);
  const deps: WslDeps = {
    system32: (test && options.env.ROKID_SETUP_WSL_SYSTEM32) || DEFAULT_SYSTEM32,
    procRoot: (test && options.env.ROKID_SETUP_PROC_ROOT) || "/proc",
    stopTimeoutMs: (test && Number(options.env.ROKID_SETUP_STOP_TIMEOUT_MS)) || 10_000,
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    env: options.env,
    ...overrides,
  };
  return new WslPlatform(options, deps);
}
