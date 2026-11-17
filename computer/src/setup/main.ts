#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { clearAdvertise, readAdvertise, writeAdvertise } from "../advertise";
import { LineReader } from "../launcher/pair-prompt";
import { type Answers, readAnswers } from "./answers";
import { migrateInstallHooks } from "./legacy";
import { type BindingRecord, type InstallManifest, type PathPair, TOOLS, type Tool, programDir, readManifest, writeManifest } from "./manifest";
import { type Health, type SetupContext, type SetupIo, SetupError, install, rollback } from "./orchestrator";
import { runAgentdPair } from "./pair-step";
import { type PlatformName, isTestMode, loadPlatform } from "./platform/index";
import { type PluginStatus, createDriver, removePlugin, syncPlugin } from "./plugins";
import { cliRunEnv, resolveAll } from "./resolve-cli";
import { stateLocations } from "./state";
import { uninstall } from "./uninstall";

const ROOT_REFUSAL = "Run Rokid Coder setup as yourself, not as root";
const USAGE = `Usage: rokid-setup <command>
  install --platform darwin|wsl --bundle <dir> [--answers <file>] [--binding <file> --task-xml <file>]
  plugins sync [--tool claude|codex] [--json]
  plugins remove [--tool claude|codex]
  plugins status --json
  cli-installed --tool claude|codex --json
  rollback
  migrate-hooks
  uninstall [--purge] [--yes]
  advertise set --hosts <ipv4,...> --port <port> | advertise show | advertise clear`;

const COMMANDS = ["install", "plugins", "cli-installed", "rollback", "migrate-hooks", "uninstall", "advertise"];

/** WSL's NAT mode: the endpoint every pairing client advertises [6b-R3]; user-setup.ps1 and start-agentd.ps1 write it. */
function advertiseCommand(args: string[], home: string, env: NodeJS.ProcessEnv): number {
  const stateDir = stateLocations(home, env).stateDir;
  switch (args[0]) {
    case "set": {
      const hosts = (option(args, "--hosts") ?? "").split(",").filter(Boolean);
      const port = Number(option(args, "--port"));
      writeAdvertise(stateDir, hosts, port);
      return 0;
    }
    case "show":
      process.stdout.write(`${JSON.stringify(readAdvertise(stateDir) ?? { mode: "default" })}\n`);
      return 0;
    case "clear":
      clearAdvertise(stateDir);
      return 0;
    default:
      throw new SetupError(USAGE);
  }
}

function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new SetupError(`${name} needs a value\n${USAGE}`);
  return value;
}

function toolsOption(args: string[]): Tool[] {
  const tool = option(args, "--tool");
  if (tool === undefined) return [...TOOLS];
  if (tool !== "claude" && tool !== "codex") throw new SetupError(`--tool must be claude or codex\n${USAGE}`);
  return [tool];
}

function platformName(value: string | undefined): PlatformName {
  if (value === "darwin" || value === "wsl") return value;
  throw new SetupError(`--platform must be darwin or wsl\n${USAGE}`);
}

function testNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = isTestMode(env) ? env[name] : undefined;
  return value === undefined || value === "" ? undefined : Number(value);
}

function agentdHealth(home: string, env: NodeJS.ProcessEnv): Promise<Health | undefined> {
  let port = 8791;
  try {
    const config = JSON.parse(readFileSync(path.join(stateLocations(home, env).nexusDir, "config.json"), "utf8")) as { httpPort?: unknown };
    if (Number.isInteger(config.httpPort)) port = config.httpPort as number;
  } catch {
    // the default port
  }
  return new Promise((resolve) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path: "/health", timeout: 1000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? (JSON.parse(body) as Health) : undefined);
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

/** The WSL binding T8's user-setup.ps1 staged: each path kept as Windows wrote it and as `wslpath -u` maps it [6b-R18]. */
function bindingRecord(binding: string, taskXml: string): BindingRecord {
  const pair = (value: string): PathPair =>
    /^[A-Za-z]:\\/.test(value)
      ? { win: value, linux: execFileSync("wslpath", ["-u", value], { encoding: "utf8" }).trim() }
      : { win: execFileSync("wslpath", ["-w", value], { encoding: "utf8" }).trim(), linux: path.resolve(value) };
  const bindingPath = pair(binding);
  return {
    contents: JSON.parse(readFileSync(bindingPath.linux, "utf8")) as Record<string, unknown>,
    bindingPath,
    taskXmlPath: pair(taskXml),
  };
}

function makeIo(home: string, options: { log: boolean; toStderr: boolean }): SetupIo & { close(): void } {
  const logDir = path.join(programDir(home), "logs");
  const log = (text: string): void => {
    if (!options.log) return;
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      appendFileSync(path.join(logDir, "setup.log"), text, { mode: 0o600 });
    } catch {
      // the log is a convenience; setup goes on without it
    }
  };
  let reader: LineReader | undefined;
  return {
    interactive: Boolean(process.stdin.isTTY),
    write: (text) => {
      (options.toStderr ? process.stderr : process.stdout).write(text);
      log(text);
    },
    note: (text) => log(`${text}\n`),
    readLine: () => {
      reader ??= new LineReader(process.stdin);
      return reader.next();
    },
    close: () => reader?.close(),
  };
}

function requireManifest(home: string): InstallManifest {
  const manifest = readManifest(home);
  if (!manifest) throw new SetupError("Rokid Coder setup has not run for this user yet: run rokid-setup install");
  return manifest;
}

async function pluginsSync(ctx: SetupContext, tools: Tool[]): Promise<Record<string, unknown>> {
  const manifest = requireManifest(ctx.home);
  const resolved = await resolveAll({ home: ctx.home, env: ctx.env });
  const pluginEnv = cliRunEnv(ctx.env, resolved);
  const results: Record<string, unknown> = {};
  for (const tool of tools) {
    const cli = resolved[tool];
    if (!cli) {
      results[tool] = { result: "absent" };
      continue;
    }
    const outcome = await syncPlugin(createDriver(tool, cli.path, { home: ctx.home, env: pluginEnv }), path.join(manifest.bundleDir, "plugins"));
    manifest.clis[tool] = { path: cli.path, version: cli.version, ...(cli.interpreter ? { interpreter: cli.interpreter } : {}) };
    manifest.plugins[tool] = outcome.record;
    const detail = outcome.record.detail ?? outcome.warning;
    results[tool] = { result: outcome.result, ...(detail ? { detail } : {}) };
  }
  writeManifest(ctx.home, manifest);
  return results;
}

function report(ctx: SetupContext, json: boolean, results: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(results)}\n`);
    return;
  }
  for (const [tool, value] of Object.entries(results)) {
    const { result, detail } = value as { result: string; detail?: string };
    ctx.io.write(`${tool}: ${result}${detail ? ` (${detail})` : ""}\n`);
  }
}

const failedAny = (results: Record<string, unknown>): boolean =>
  Object.values(results).some((value) => (value as { result: string }).result === "failed");

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const uid = isTestMode(env) && env.ROKID_SETUP_FAKE_UID !== undefined ? Number(env.ROKID_SETUP_FAKE_UID) : process.getuid?.();
  if (uid === 0) {
    process.stderr.write(`${ROOT_REFUSAL}\n`);
    return 1;
  }
  const [command, ...args] = argv;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const home = env.HOME || os.homedir();
  if (command === "advertise") {
    try {
      return advertiseCommand(args, home, env);
    } catch (error) {
      process.stderr.write(`rokid-setup: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  const json = args.includes("--json");
  const io = makeIo(home, { log: command !== "uninstall", toStderr: json });
  try {
    if (command === "migrate-hooks") {
      if ((await migrateInstallHooks(home, io)) === "none") {
        io.write("~/.claude/settings.json has no hooks from `agentd install-hooks`.\n");
      }
      return 0;
    }
    let answers: Answers | undefined;
    const answersFile = option(args, "--answers");
    if (answersFile) answers = readAnswers(answersFile);
    const manifest = command === "install" ? undefined : readManifest(home);
    const name =
      command === "install"
        ? platformName(option(args, "--platform"))
        : manifest?.platform ?? platformName(option(args, "--platform") ?? (process.platform === "darwin" ? "darwin" : "wsl"));
    const platform = loadPlatform(name, { home, env });
    const ctx: SetupContext = {
      home,
      env,
      platform,
      io,
      ...(answers ? { answers } : {}),
      // The fake's daemons answer on ports of their own.
      health: isTestMode(env) && "health" in platform
        ? () => (platform as { health(): Promise<Health | undefined> }).health()
        : () => agentdHealth(home, env),
      runPair: (bundleDir) => runAgentdPair(bundleDir, env),
      now: () => new Date(),
      timeoutMs: testNumber(env, "ROKID_SETUP_TIMEOUT_MS") ?? 20_000,
      failAt: testNumber(env, "ROKID_SETUP_FAIL_AT"),
      crashAt: testNumber(env, "ROKID_SETUP_CRASH_AT"),
    };
    switch (command) {
      case "install": {
        const bundle = option(args, "--bundle");
        if (!bundle) throw new SetupError(`install needs --bundle\n${USAGE}`);
        const binding = option(args, "--binding");
        const taskXml = option(args, "--task-xml");
        if ((binding || taskXml) && (name !== "wsl" || !binding || !taskXml)) {
          throw new SetupError("--binding and --task-xml go together, and only with --platform wsl");
        }
        return await install(ctx, { platformName: name, bundleDir: bundle, ...(binding && taskXml ? { binding: bindingRecord(binding, taskXml) } : {}) });
      }
      case "plugins": {
        const action = args[0];
        const tools = toolsOption(args);
        if (action === "sync") {
          const results = await pluginsSync(ctx, tools);
          report(ctx, json, results);
          return failedAny(results) ? 1 : 0;
        }
        if (action === "remove") {
          const current = requireManifest(home);
          const roots = [current.bundleDir, current.previous?.bundleDir].filter((d): d is string => Boolean(d)).flatMap((d) => [d, path.dirname(d)]);
          const results: Record<string, unknown> = {};
          const pluginEnv = cliRunEnv(env, current.clis);
          for (const tool of tools) {
            const cli = current.clis[tool];
            if (!cli) {
              results[tool] = { result: "absent" };
              continue;
            }
            const removed = await removePlugin(createDriver(tool, cli.path, { home, env: pluginEnv }), roots);
            delete current.plugins[tool];
            results[tool] = { result: removed ? "removed" : "kept", ...(removed ? {} : { detail: "the rokid-coder marketplace is not ours" }) };
          }
          writeManifest(home, current);
          report(ctx, json, results);
          return 0;
        }
        if (action === "status") {
          const resolved = await resolveAll({ home, env });
          const pluginEnv = cliRunEnv(env, resolved);
          const results: Record<string, PluginStatus | { result: "absent" }> = {};
          for (const tool of tools) {
            const cli = resolved[tool];
            results[tool] = cli ? await createDriver(tool, cli.path, { home, env: pluginEnv }).status() : { result: "absent" };
          }
          process.stdout.write(`${JSON.stringify(results)}\n`);
          return 0;
        }
        throw new SetupError(USAGE);
      }
      case "cli-installed": {
        const tool = option(args, "--tool");
        if (tool !== "claude" && tool !== "codex") throw new SetupError(`cli-installed needs --tool claude|codex\n${USAGE}`);
        const results = await pluginsSync(ctx, [tool]);
        await platform.refreshDaemonEnv(requireManifest(home));
        report(ctx, json, results);
        const result = (results[tool] as { result: string }).result;
        return result === "ok" || result === "manual_step_required" ? 0 : 1;
      }
      case "rollback":
        return await rollback(ctx);
      case "uninstall":
        return await uninstall(ctx, { purge: args.includes("--purge") || answers?.purge === true, yes: args.includes("--yes") || answers?.purge === true });
      default:
        throw new SetupError(USAGE);
    }
  } catch (error) {
    process.stderr.write(`rokid-setup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    io.close();
  }
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
