#!/usr/bin/env node
// The controlled run of a bundle, by the bundle's own node, with no toolchain:
//   <bundle>/bin/rokid-node controlled-run.mjs <bundle> [--home <dir>]
// It runs the five checks: the wrapper dir holds exactly the four generated
// user wrappers, `agentd --version --json`, `agentd selfcheck
// --require-bundle`, daemon startup + /health (execPath must be the bundled
// node), and every bundled hook command, piped a rokid:on prompt under a
// controlled env (HOME, PATH=/usr/bin:/bin, LANG, the port; nothing else).
// The daemon config has tailnetDiscovery:false and codex.enabled:false, so it
// has no reason to exec anything. It uses node built-ins only and spawns only
// the bundle's wrappers, the user wrappers it writes, and /bin/sh, so CI can
// trace or sandbox every exec. Prints {ok, checks} as JSON; exit 0 only when ok.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const PLUGINS = [
  { name: "claude-code", rootVar: "CLAUDE_PLUGIN_ROOT", provider: "claude" },
  { name: "codex", rootVar: "PLUGIN_ROOT", provider: "codex" },
];

export function controlledEnv(home, httpPort, extra = {}) {
  return { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NEXUS_AGENTD_HTTP_PORT: String(httpPort), ...extra };
}

/** Runs a file with args, collecting output; resolves {code, stdout, stderr}. */
export function runFile(file, args, { env, input, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timer); resolve({ code: null, stdout, stderr: `${stderr}${error.message}` }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input ?? "");
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function getHealth(port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/health", timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(body) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(undefined));
  });
}

function wrappersModule(bundle) {
  const require = createRequire(path.join(bundle, "app", "package.json"));
  return require(path.join(bundle, "app", "dist", "wrappers.js"));
}

/** Writes the user wrappers into `<home>/.rokid-coder/bin` with the bundle's own wrappers module. */
export function installWrappers(bundle, home) {
  wrappersModule(bundle).installUserWrappers(home, bundle);
}

/**
 * The exec allowlist trusts exactly the four wrapper paths, so their dir must
 * hold those four and nothing else, each a 0755 regular file with the
 * content the bundle's wrappers module renders for this bundle.
 */
export function wrappersCheck(bundle, home) {
  const { WRAPPER_NAMES, renderUserWrapper } = wrappersModule(bundle);
  const bin = path.join(home, ".rokid-coder", "bin");
  const problems = [];
  const names = fs.readdirSync(bin).sort();
  for (const name of names) {
    if (!WRAPPER_NAMES.includes(name)) {
      problems.push(`${name} is not a generated wrapper`);
      continue;
    }
    const file = path.join(bin, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) {
      problems.push(`${name} is not a regular file`);
      continue;
    }
    if ((stat.mode & 0o777) !== 0o755) problems.push(`${name} has mode ${(stat.mode & 0o777).toString(8)}, not 755`);
    if (fs.readFileSync(file, "utf8") !== renderUserWrapper(name, bundle)) problems.push(`${name} is not the wrapper setup generates`);
  }
  for (const name of WRAPPER_NAMES) {
    if (!names.includes(name)) problems.push(`${name} is missing`);
  }
  return { name: "wrappers", ok: problems.length === 0, detail: problems.length === 0 ? names : problems };
}

export async function versionCheck(bundle, env) {
  const result = await runFile(path.join(bundle, "bin", "agentd"), ["--version", "--json"], { env });
  const info = result.code === 0 ? JSON.parse(result.stdout) : undefined;
  const node = fs.realpathSync(path.join(bundle, "node", "bin", "node"));
  const ok = info?.execPath === node && info?.bundleRoot === fs.realpathSync(bundle);
  return { name: "version", ok, detail: info ?? result.stderr };
}

export async function selfcheckCheck(bundle, env) {
  const result = await runFile(path.join(bundle, "bin", "agentd"), ["selfcheck", "--json", "--require-bundle"], { env });
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  return { name: "selfcheck", ok: result.code === 0 && report?.ok === true, detail: report ?? result.stderr };
}

/** Starts the bundled `agentd run` on free ports under `home`; resolves once /health answers. */
export async function startDaemon(bundle, home, { timeoutMs = 20_000 } = {}) {
  const httpPort = await freePort();
  const wsPort = await freePort();
  const stateDir = path.join(home, ".nexus-agentd");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
    token: randomBytes(32).toString("base64url"),
    wsPort,
    httpPort,
    machineId: randomBytes(16).toString("base64url"),
    machineName: "rokid-controlled-run",
    phoneHosts: [],
    tailnetDiscovery: false,
    allowTerminalInput: false,
    codex: { enabled: false, port: await freePort(), useSharedDaemon: true },
    rokidCoder: { stateDir: path.join(home, ".rokid-coder") },
  }, null, 2), { mode: 0o600 });
  const child = spawn(path.join(bundle, "bin", "agentd"), ["run"], {
    env: controlledEnv(home, httpPort),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { log += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { log += chunk; });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const health = await getHealth(httpPort);
    if (health?.ok === true) return { httpPort, health, stop, log: () => log };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stop();
  throw new Error(`agentd did not answer /health: ${log}`);
}

export function daemonCheck(bundle, health) {
  const node = fs.realpathSync(path.join(bundle, "node", "bin", "node"));
  return {
    name: "daemon",
    ok: health.execPath === node && health.bundleRoot === fs.realpathSync(bundle),
    detail: { agentdVersion: health.agentdVersion, execPath: health.execPath, bundleRoot: health.bundleRoot },
  };
}

/** Every command in a bundled hooks.json. */
export function bundledHookCommands(bundle) {
  return PLUGINS.flatMap((plugin) => {
    const { hooks } = JSON.parse(fs.readFileSync(path.join(bundle, "plugins", plugin.name, "hooks", "hooks.json"), "utf8"));
    return Object.entries(hooks).flatMap(([event, groups]) =>
      groups.flatMap((group) => group.hooks.map((hook) => ({ plugin, event, command: hook.command }))));
  });
}

/**
 * The opt-in each provider really sends: Codex types rokid:on as a prompt
 * (UserPromptSubmit); Claude Code hands its plugin command to the hook as
 * UserPromptExpansion with command_name rokid:on.
 */
export function rokidOnPayload(provider, sessionId, cwd) {
  return provider === "codex"
    ? { hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "rokid:on", cwd }
    : { hook_event_name: "UserPromptExpansion", session_id: sessionId, command_name: "rokid:on", command_args: "", prompt: "/rokid:on", cwd };
}

/** Runs one hook command through /bin/sh -c with only the controlled env, piping `payload`. */
export function runHook(bundle, home, httpPort, { plugin, command }, payload) {
  const env = controlledEnv(home, httpPort, { [plugin.rootVar]: path.join(bundle, "plugins", plugin.name) });
  return runFile("/bin/sh", ["-c", command], { env, input: JSON.stringify(payload) });
}

export async function hooksCheck(bundle, home, httpPort) {
  const results = [];
  for (const [index, hook] of bundledHookCommands(bundle).entries()) {
    const sessionId = `controlled-${hook.plugin.provider}-${index}`;
    const result = await runHook(bundle, home, httpPort, hook, rokidOnPayload(hook.plugin.provider, sessionId, home));
    results.push({
      plugin: hook.plugin.name,
      event: hook.event,
      ok: result.code === 0 && result.stdout.includes("Attached to Rokid-Coder"),
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  return { name: "hooks", ok: results.length > 0 && results.every((result) => result.ok), detail: results };
}

export async function controlledRun(bundle, { home } = {}) {
  const root = fs.realpathSync(bundle);
  const ownHome = !home;
  const dir = home ?? fs.mkdtempSync(path.join(os.tmpdir(), "rokid-controlled-"));
  const realHome = fs.realpathSync(dir);
  const checks = [];
  try {
    installWrappers(root, realHome);
    const wrappers = wrappersCheck(root, realHome);
    checks.push(wrappers);
    if (!wrappers.ok) throw new Error("the wrapper dir holds more or other than the four generated wrappers");
    const env = controlledEnv(realHome, 1);
    checks.push(await versionCheck(root, env));
    checks.push(await selfcheckCheck(root, env));
    const daemon = await startDaemon(root, realHome);
    try {
      checks.push(daemonCheck(root, daemon.health));
      checks.push(await hooksCheck(root, realHome, daemon.httpPort));
    } finally {
      await daemon.stop();
    }
  } catch (error) {
    checks.push({ name: "error", ok: false, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    if (ownHome) fs.rmSync(realHome, { recursive: true, force: true });
  }
  return { ok: checks.length === 5 && checks.every((check) => check.ok), checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const bundle = args[0];
  const homeIndex = args.indexOf("--home");
  if (!bundle) {
    process.stderr.write("Usage: controlled-run.mjs <bundle-dir> [--home <dir>]\n");
    process.exit(2);
  }
  const result = await controlledRun(bundle, { home: homeIndex >= 0 ? args[homeIndex + 1] : undefined });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
