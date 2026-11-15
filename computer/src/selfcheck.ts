import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { APP_ROOT, bundleRootFor, realExecPath } from "./version";

// `agentd selfcheck` proves the runtime, not the config: it spawns a real PTY
// and lists the node binary and every native object it loaded, so a bundle
// can show that all of them are its own. It reads and writes no state dir.

const PTY_TIMEOUT_MS = 5000;
const PTY_MARKER = "rokid-pty-ok";

export interface SelfcheckResult {
  ok: boolean;
  node: string;
  execPath: string;
  bundleRoot: string | null;
  pty: { output: string; exitCode: number | null };
  natives: string[];
  outside: string[];
}

export interface SelfcheckReport {
  result: SelfcheckResult;
  problems: string[];
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/** A real PTY running `/bin/sh -c 'printf rokid-pty-ok'`, through the launcher's own spawn path. */
async function ptyProbe(): Promise<{ output: string; exitCode: number | null; error?: string }> {
  let spawnPty: typeof import("./launcher/pty").spawnPty;
  try {
    // Loaded here, not at the top: a node-pty that fails to load is a finding, not a crash.
    ({ spawnPty } = require("./launcher/pty") as typeof import("./launcher/pty"));
  } catch (error) {
    return { output: "", exitCode: null, error: `node-pty did not load: ${error instanceof Error ? error.message : String(error)}` };
  }
  return new Promise((resolve) => {
    let output = "";
    let child: ReturnType<typeof spawnPty>;
    try {
      child = spawnPty("/bin/sh", ["-c", `printf ${PTY_MARKER}`], { cwd: "/", env: process.env, cols: 80, rows: 24 });
    } catch (error) {
      resolve({ output, exitCode: null, error: `the pty did not spawn: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ output, exitCode: null, error: `the pty did not exit within ${PTY_TIMEOUT_MS / 1000} s` });
    }, PTY_TIMEOUT_MS);
    child.onData((chunk) => {
      output += chunk;
    });
    child.onExit((code) => {
      clearTimeout(timer);
      // The last output can trail the exit on Linux: give it a moment.
      setTimeout(() => resolve({ output, exitCode: code }), output.includes(PTY_MARKER) ? 0 : 200);
    });
  });
}

/** Every loaded `.node` object, plus node-pty's spawn-helper beside it on darwin. */
function loadedNatives(): string[] {
  const report = process.report?.getReport() as { sharedObjects?: string[] } | undefined;
  const natives = new Set<string>();
  for (const file of report?.sharedObjects ?? []) {
    if (!file.endsWith(".node")) continue;
    const native = real(file);
    natives.add(native);
    if (process.platform === "darwin") {
      const helper = path.join(path.dirname(native), "spawn-helper");
      if (existsSync(helper)) natives.add(real(helper));
    }
  }
  return [...natives].sort();
}

function inside(file: string, root: string): boolean {
  return file.startsWith(root + path.sep);
}

export async function runSelfcheck({ requireBundle = false } = {}): Promise<SelfcheckReport> {
  const problems: string[] = [];
  const execPath = realExecPath();
  const bundleRoot = bundleRootFor(process.execPath);
  const probe = await ptyProbe();
  const output = probe.output.replace(/\r?\n$/, "");
  if (probe.error) problems.push(probe.error);
  if (output !== PTY_MARKER || probe.exitCode !== 0) {
    problems.push(`the pty printed ${JSON.stringify(output)} and exited ${probe.exitCode}`);
  }
  const natives = loadedNatives();
  if (!natives.some((file) => path.basename(file) === "pty.node")) problems.push("node-pty's pty.node is not loaded");
  const outside = [execPath, ...natives].filter((file) => bundleRoot === null || !inside(file, bundleRoot));

  if (bundleRoot !== null) {
    const pinFile = path.join(APP_ROOT, "runtime", "node-version.txt");
    const pin = existsSync(pinFile) ? readFileSync(pinFile, "utf8").trim() : undefined;
    if (process.version !== `v${pin}`) problems.push(`node ${process.version} is not the pinned ${pin ? `v${pin}` : "(no node-version.txt)"}`);
  }
  if (requireBundle) {
    if (bundleRoot === null) problems.push("not running from a bundle");
    else if (outside.length > 0) problems.push(`${outside.length} path(s) load from outside ${bundleRoot}`);
  }
  return {
    result: {
      ok: problems.length === 0,
      node: process.version,
      execPath,
      bundleRoot,
      pty: { output, exitCode: probe.exitCode },
      natives,
      outside,
    },
    problems,
  };
}

export function selfcheckText({ result, problems }: SelfcheckReport): string {
  const lines = [
    `selfcheck: ${result.ok ? "ok" : "FAILED"}`,
    `node ${result.node} at ${result.execPath}`,
    `bundle: ${result.bundleRoot ?? "none"}`,
    `pty: ${JSON.stringify(result.pty.output)} (exit ${result.pty.exitCode})`,
    ...result.natives.map((file) => `native: ${file}`),
    ...(result.bundleRoot ? result.outside.map((file) => `outside the bundle: ${file}`) : []),
    ...problems.map((problem) => `problem: ${problem}`),
  ];
  return `${lines.join("\n")}\n`;
}
