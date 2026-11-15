import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LineReader } from "./pair-prompt";

/**
 * `rk claude` and `rk codex` with no CLI installed (6b T9): print the vendor's
 * official install command and, after an explicit `y`, run it. Nothing here
 * uses the bundled `rokid-node`: the user's CLI must never depend on our
 * runtime, so `npm` and `brew` are looked for on the user's own PATH only.
 */
export type CliTool = "claude" | "codex";
export type CliInstallResult = "installed" | "skipped" | "failed" | "manual";

export interface InstallRow {
  tool: CliTool;
  platform: "darwin" | "linux";
  /** The command exactly as the vendor documents it, run by `sh -c`. */
  command: string;
  /** The vendor docs page that shows `command`. */
  docsUrl: string;
  /** Commands that must be on PATH to run `command` (including its interpreter). */
  requires: readonly string[];
  /** The date `command` was last checked against `docsUrl`. */
  verified: string;
}

// Claude Code: https://code.claude.com/docs/en/setup ("Install Claude Code", Native Install,
// "macOS, Linux, WSL"). docs.claude.com/en/docs/claude-code/setup redirects there.
// Checked 2026-11-15.
const CLAUDE_DOCS = "https://code.claude.com/docs/en/setup";
// Codex: https://developers.openai.com/codex/cli (308 to https://learn.chatgpt.com/docs/codex/cli),
// "Install the Codex CLI with the standalone installer for macOS and Linux". The npm and Homebrew
// commands are from https://github.com/openai/codex (README, Installing and running).
// Checked 2026-11-15. The vendor's own current order is the standalone script first.
const CODEX_DOCS = "https://developers.openai.com/codex/cli";
const CODEX_REPO = "https://github.com/openai/codex";
const VERIFIED = "2026-11-15";

const rows = (tool: CliTool, rest: Omit<InstallRow, "tool" | "platform" | "verified">): InstallRow[] =>
  (["darwin", "linux"] as const).map((platform) => ({ tool, platform, verified: VERIFIED, ...rest }));

/** Rows are in the order they are preferred; the first whose `requires` are all present is offered. */
export const INSTALL_TABLE: readonly InstallRow[] = [
  ...rows("claude", { command: "curl -fsSL https://claude.ai/install.sh | bash", docsUrl: CLAUDE_DOCS, requires: ["curl", "bash"] }),
  ...rows("codex", { command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", docsUrl: CODEX_DOCS, requires: ["curl", "sh"] }),
  ...rows("codex", { command: "npm install -g @openai/codex", docsUrl: CODEX_REPO, requires: ["npm"] }),
  ...rows("codex", { command: "brew install --cask codex", docsUrl: CODEX_REPO, requires: ["brew"] }),
];

/** Where to read about installing by hand, for every case with no row to run. */
const MANUAL_DOCS: Record<CliTool, string> = { claude: CLAUDE_DOCS, codex: CODEX_DOCS };
const NAMES: Record<CliTool, string> = { claude: "Claude Code", codex: "Codex" };
const SETUP_FAILED = "Plugin setup failed — run: rokid-setup plugins sync";

export interface CliInstallIo {
  /** stdin is a terminal: only then is anything asked. */
  interactive: boolean;
  platform: NodeJS.Platform;
  write(text: string): void;
  /** The next line typed, or undefined at end of input. */
  readLine(): Promise<string | undefined>;
  /** On the user's PATH, and nowhere else. */
  hasCommand(name: string): boolean;
  /** Runs `command` in `sh -c` with the terminal inherited; resolves to its exit status. */
  run(command: string): Promise<number>;
  /** The CLI as `rk` will find it, after an install. */
  resolve(tool: CliTool): string | undefined;
  /** Runs `<node> <dist>/setup/main.js <args>`; resolves to its exit status. */
  runSetup(args: string[]): Promise<number>;
}

/** What to do for `tool` here: the first row whose tools are all present, else the first row at all. */
function choose(tool: CliTool, io: CliInstallIo): { candidates: InstallRow[]; runnable?: InstallRow } {
  const candidates = INSTALL_TABLE.filter((r) => r.tool === tool && r.platform === io.platform);
  return { candidates, runnable: candidates.find((r) => r.requires.every((name) => io.hasCommand(name))) };
}

async function provision(tool: CliTool, io: CliInstallIo): Promise<void> {
  try {
    const status = await io.runSetup(["cli-installed", "--tool", tool, "--json"]);
    if (status !== 0) {
      io.write(`${SETUP_FAILED}\n`);
    }
  } catch {
    io.write(`${SETUP_FAILED}\n`);
  }
}

/**
 * Offers to install `tool`. It prints the command and runs it only after `y`
 * on a terminal; a pipe never gets a prompt. `rk` itself never fails on what
 * happens after a good install: plugin setup is best effort.
 */
export async function offerCliInstall(tool: CliTool, io: CliInstallIo): Promise<CliInstallResult> {
  const name = NAMES[tool];
  const { candidates, runnable: row } = choose(tool, io);
  if (!row) {
    const needs = candidates.map((r) => r.requires.join(" + ")).join(", or ");
    const what = candidates.length ? `Its installer needs ${needs} on your PATH.` : `rk cannot install it on ${io.platform}.`;
    io.write(`rk: ${name} was not found. ${what}\nInstall it yourself, as described at ${MANUAL_DOCS[tool]}\n`);
    return "manual";
  }
  io.write(`rk: ${name} was not found. The official installer (${row.docsUrl}) is:\n  ${row.command}\n`);
  if (!io.interactive) {
    io.write("Run it, then start rk again.\n");
    return "skipped";
  }
  io.write("Run it now? [y/N] ");
  const answer = await io.readLine();
  if (answer === undefined || !/^\s*y(es)?\s*$/i.test(answer)) {
    io.write(answer === undefined ? "\n" : "");
    return "skipped";
  }
  let status: number;
  try {
    status = await io.run(row.command);
  } catch {
    status = 127;
  }
  if (status !== 0) {
    io.write(`rk: the installer failed (exit ${status}); run it yourself: ${row.command}\n`);
    return "failed";
  }
  // The proof of an install is the CLI itself: `curl ... | bash` exits 0 when curl fails.
  if (!io.resolve(tool)) {
    io.write(`rk: the installer finished but ${tool} was not found; open a new terminal, or run it yourself: ${row.command}\n`);
    return "failed";
  }
  await provision(tool, io);
  return "installed";
}

/** PATH is searched first, then these. `ROKID_RK_KNOWN_BIN_DIRS` (a PATH-style list) replaces them, for tests. */
export function knownBinDirs(home: string, env: NodeJS.ProcessEnv): string[] {
  const override = env.ROKID_RK_KNOWN_BIN_DIRS;
  if (override !== undefined) {
    return override.split(path.delimiter).filter(Boolean);
  }
  return [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

function executable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** The CLI to run: a path as given, or the first match on PATH and then the known install dirs. */
export function resolveCli(bin: string, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (bin.includes("/")) {
    const resolved = path.resolve(bin);
    return executable(resolved) ? resolved : undefined;
  }
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter(Boolean), ...knownBinDirs(home, env)];
  return dirs.map((dir) => path.join(dir, bin)).find(executable);
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((dir) => executable(path.join(dir, name)));
}

function exitOf(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/** `<dist>`: this file is dist/launcher/cli-install.js. */
const DIST = path.join(__dirname, "..");

/** The real effects. `env`, `platform` and `home` are injectable for tests. */
export function realCliInstallIo(
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string; bin?: Partial<Record<CliTool, string>> } = {},
): CliInstallIo & { close(): void } {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  let reader: LineReader | undefined;
  return {
    interactive: Boolean(process.stdin.isTTY),
    platform: options.platform ?? process.platform,
    write: (text) => {
      process.stderr.write(text);
    },
    readLine: () => {
      reader ??= new LineReader(process.stdin);
      return reader.next();
    },
    hasCommand: (name) => onPath(name, env),
    run: (command) => exitOf(spawn("sh", ["-c", command], { stdio: "inherit", env })),
    resolve: (tool) => resolveCli(options.bin?.[tool] ?? tool, env, home),
    runSetup: (args) => {
      const entry = env.ROKID_RK_SETUP_ENTRY || path.join(DIST, "setup", "main.js");
      // stdout is the --json report, which rk has no use for; stderr stays visible.
      return exitOf(spawn(process.execPath, [entry, ...args], { stdio: ["ignore", "ignore", "inherit"], env }));
    },
    close: () => reader?.close(),
  };
}
