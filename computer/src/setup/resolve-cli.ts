import { execFile } from "node:child_process";
import { accessSync, closeSync, constants, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { knownBinDirs } from "../launcher/cli-install";
import { TOOLS, type Tool, programDir, writePrivateFile } from "./manifest";

export interface ResolvedCli {
  tool: Tool;
  /** Absolute, as found (not the symlink's target: an npm bin link is how the user runs it). */
  path: string;
  version: string;
  /** The interpreter a `#!` script needs, resolved the same way: the user's own Node, never rokid-node [6b-R20]. */
  interpreter?: string;
}

export interface ResolveOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** What launchd and a scheduled task start agentd with, before setup adds the CLI dirs. */
export const BASE_DAEMON_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const BEGIN = "__rokid_setup_begin__";
const END = "__rokid_setup_end__";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(file, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 127) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end();
  });
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * `command -v <name>` in the user's login shell. Only what is printed between
 * the two sentinel lines counts, so whatever an rc file prints is ignored.
 */
async function loginShellLookup(name: string, flags: string, options: ResolveOptions): Promise<string | undefined> {
  const shell = options.env.SHELL || "/bin/sh";
  const script = `printf '%s\\n' ${BEGIN}; command -v ${name}; printf '%s\\n' ${END}`;
  const result = await run(shell, [flags, script], { ...options.env, HOME: options.home }, options.timeoutMs ?? 15_000);
  const lines = result.stdout.split(/\r?\n/);
  const begin = lines.lastIndexOf(BEGIN);
  const end = lines.indexOf(END, begin + 1);
  if (begin < 0 || end < 0) {
    return undefined;
  }
  return lines
    .slice(begin + 1, end)
    .map((line) => line.trim())
    .find((line) => path.isAbsolute(line) && isExecutableFile(line));
}

/** The resolver order: `$SHELL -lc`, then `$SHELL -lic`, then the known install dirs in T9's order. */
export async function lookupCommand(name: string, options: ResolveOptions): Promise<string | undefined> {
  if (!/^[A-Za-z0-9._+-]+$/.test(name)) {
    return undefined;
  }
  for (const flags of ["-lc", "-lic"]) {
    const found = await loginShellLookup(name, flags, options);
    if (found) {
      return found;
    }
  }
  return knownBinDirs(options.home, options.env)
    .map((dir) => path.join(dir, name))
    .find(isExecutableFile);
}

/** The `#!` line's interpreter: `#!/usr/bin/env node` names `node`, `#!/abs/x` names `/abs/x`. */
export function shebangInterpreter(file: string): string | undefined {
  let head: string;
  try {
    const fd = openSync(realpathSync(file), "r");
    try {
      const buffer = Buffer.alloc(256);
      head = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (!head.startsWith("#!")) {
    return undefined;
  }
  const words = head.slice(2).split(/\r?\n/)[0].trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return undefined;
  }
  if (path.basename(words[0]) !== "env") {
    return words[0];
  }
  return words.slice(1).find((word) => !word.startsWith("-") && !word.includes("="));
}

async function versionOf(cli: string, options: ResolveOptions): Promise<string> {
  const result = await run(cli, ["--version"], { ...options.env, HOME: options.home }, options.timeoutMs ?? 15_000);
  const line = result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return result.code === 0 && line ? line : "unknown";
}

export async function resolveTool(tool: Tool, options: ResolveOptions): Promise<ResolvedCli | undefined> {
  const found = await lookupCommand(tool, options);
  if (!found) {
    return undefined;
  }
  const resolved: ResolvedCli = { tool, path: found, version: await versionOf(found, options) };
  const interpreter = shebangInterpreter(found);
  if (interpreter) {
    const interpreterPath = path.isAbsolute(interpreter) ? interpreter : await lookupCommand(interpreter, options);
    if (interpreterPath) {
      resolved.interpreter = interpreterPath;
    }
  }
  return resolved;
}

export async function resolveAll(options: ResolveOptions): Promise<Partial<Record<Tool, ResolvedCli>>> {
  const all: Partial<Record<Tool, ResolvedCli>> = {};
  for (const tool of TOOLS) {
    const resolved = await resolveTool(tool, options);
    if (resolved) {
      all[tool] = resolved;
    }
  }
  return all;
}

/**
 * The daemon's PATH: each CLI's dir and its interpreter's dir, ahead of the
 * four system dirs, as 0.8.0's LaunchAgent script ordered them. Ahead, so a
 * distro's old /usr/bin/node never runs an npm CLI that needs the user's own.
 */
export function daemonPath(resolved: Partial<Record<Tool, CliLocation>>): string {
  return [...new Set([...cliDirs(resolved), ...BASE_DAEMON_PATH])].join(":");
}

/** Where a CLI and the interpreter its `#!` line needs were found. */
export interface CliLocation {
  path: string;
  interpreter?: string;
}

function cliDirs(clis: Partial<Record<Tool, CliLocation>>): string[] {
  const dirs: string[] = [];
  for (const cli of Object.values(clis)) {
    if (!cli) continue;
    for (const file of [cli.path, cli.interpreter]) {
      if (file) dirs.push(path.dirname(file));
    }
  }
  return dirs;
}

/**
 * The env a CLI's plugin commands run with: each CLI's dir and its
 * interpreter's dir ahead of the caller's PATH, as in the daemon PATH, so an
 * npm CLI starts with the Node it was resolved with even when the caller's
 * PATH has none.
 */
export function cliRunEnv(env: NodeJS.ProcessEnv, clis: Partial<Record<Tool, CliLocation>>): NodeJS.ProcessEnv {
  const inherited = (env.PATH ?? "").split(":").filter(Boolean);
  return { ...env, PATH: [...new Set([...cliDirs(clis), ...inherited, ...BASE_DAEMON_PATH])].join(":") };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function envFilePath(home: string): string {
  return path.join(programDir(home), "env");
}

export function renderEnvFile(pathValue: string): string {
  return `# Written by rokid-setup: the PATH agentd starts the CLIs with.\nexport PATH=${shellQuote(pathValue)}\n`;
}

/** `env -i HOME=<home> PATH=<generated> <cli> --version`: what agentd will meet at login. */
export async function verifyUnderDaemonEnv(cli: string, home: string, pathValue: string): Promise<string | undefined> {
  const result = await run("/usr/bin/env", ["-i", `HOME=${home}`, `PATH=${pathValue}`, cli, "--version"], {}, 15_000);
  if (result.code === 0) {
    return undefined;
  }
  const detail = result.stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return detail ? `${detail} (exit ${result.code})` : `exit ${result.code}`;
}

export interface DaemonEnvResult {
  resolved: Partial<Record<Tool, ResolvedCli>>;
  path: string;
  /** One line per CLI agentd could not start under that env, with the fix. */
  warnings: string[];
}

/**
 * Resolves the CLIs again and writes `~/.rokid-coder/env` (0600), then proves
 * each CLI starts under exactly that env. A CLI that does not is a warning,
 * never a failure: both CLIs are optional.
 */
export async function writeDaemonEnv(options: ResolveOptions): Promise<DaemonEnvResult> {
  const resolved = await resolveAll(options);
  const pathValue = daemonPath(resolved);
  writePrivateFile(envFilePath(options.home), renderEnvFile(pathValue));
  const warnings: string[] = [];
  for (const cli of Object.values(resolved)) {
    if (!cli) continue;
    const reason = await verifyUnderDaemonEnv(cli.path, options.home, pathValue);
    if (reason) {
      warnings.push(
        `agentd won't be able to start ${cli.tool} at login: ${reason}. ` +
          `Fix: make sure ${cli.tool}${cli.interpreter ? ` and ${path.basename(cli.interpreter)}` : ""} ` +
          `are found by your login shell, then run: rokid-setup cli-installed --tool ${cli.tool}`,
      );
    }
  }
  return { resolved, path: pathValue, warnings };
}
