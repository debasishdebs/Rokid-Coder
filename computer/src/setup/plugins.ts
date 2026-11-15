import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginRecord, PriorRegistration, Tool } from "./manifest";

/**
 * Plugin provisioning through each CLI's own plugin commands [FR 9]. Setup
 * never edits ~/.claude or ~/.codex itself: every change is the vendor CLI's,
 * run by absolute path with an argv array and no shell. The source is the
 * versioned bundle's read-only `plugins/` dir, never a copy [6b-R11].
 *
 * The verbs are pinned from the recorded help in
 * test/fixtures/plugin-cli/<tool>-<version>/. Which of them a CLI has is read
 * from its own `plugin --help` at run time, so a CLI without a
 * non-interactive install verb gets its marketplace registered and a manual
 * step, rather than a guessed command.
 */
export const MARKETPLACE = "rokid-coder";
export const PLUGIN_NAME = "rokid";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;

const LAYOUT: Record<Tool, { marketplace: string[]; manifest: string[] }> = {
  claude: { marketplace: [".claude-plugin", "marketplace.json"], manifest: [".claude-plugin", "plugin.json"] },
  codex: { marketplace: [".agents", "plugins", "marketplace.json"], manifest: [".codex-plugin", "plugin.json"] },
};

const MANUAL_STEP: Record<Tool, string> = {
  claude: 'In Claude Code, run /plugin and install "rokid" from the rokid-coder marketplace',
  codex: "In Codex, open /plugins and install Rokid-Coder",
};

export interface CliVerbs {
  install: boolean;
  update: boolean;
  uninstall: boolean;
}

export interface PluginStatus {
  /** The `rokid-coder` marketplace, when the CLI lists one. */
  marketplace?: { source: string };
  /** Our plugin, when the CLI lists it as installed. */
  plugin?: { version?: string; installPath?: string };
  verbs: CliVerbs;
}

export interface PluginDriver {
  tool: Tool;
  status(): Promise<PluginStatus>;
  addMarketplace(dir: string): Promise<void>;
  removeMarketplace(): Promise<void>;
  installPlugin(): Promise<void>;
  updatePlugin(): Promise<void>;
  removePlugin(): Promise<void>;
}

export interface DriverOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function runCli(cli: string, args: string[], options: DriverOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cli,
      args,
      { env: { ...options.env, HOME: options.home }, timeout: options.timeoutMs ?? 120_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim().split(/\r?\n/).pop() || error.message;
          reject(new Error(`${path.basename(cli)} ${args.join(" ")} failed: ${detail}`));
        } else {
          resolve(String(stdout));
        }
      },
    );
    child.stdin?.end();
  });
}

/**
 * The command names (and `a|b` aliases) a `--help` lists under `Commands:`.
 * A command row is indented like the first one; a long description wraps
 * onto deeper-indented lines, which are skipped whatever they start with.
 * The list ends at the first line indented less, such as the next heading.
 */
export function helpCommands(help: string): Set<string> {
  const at = help.indexOf("Commands:");
  if (at < 0) {
    return new Set();
  }
  const names = new Set<string>();
  let rowIndent: number | undefined;
  for (const line of help.slice(at + "Commands:".length).split(/\r?\n/).slice(1)) {
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    rowIndent ??= indent;
    if (indent < rowIndent || indent === 0) break;
    if (indent > rowIndent) continue;
    const match = /^([a-z][\w|-]*)(\s|$)/.exec(line.trimStart());
    if (!match) break;
    for (const name of match[1].split("|")) names.add(name);
  }
  return names;
}

function listOf(value: unknown, key: string): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : (value as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(list)) {
    throw new Error(`unexpected ${key} list output`);
  }
  return list.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
}

function marketplaceSource(entry: Record<string, unknown>): string | undefined {
  const source = entry.source as unknown;
  if (typeof entry.path === "string") return entry.path;
  if (typeof source === "string" && path.isAbsolute(source)) return source;
  if (source && typeof source === "object" && typeof (source as Record<string, unknown>).path === "string") {
    return (source as Record<string, string>).path;
  }
  return undefined;
}

class CliPluginDriver implements PluginDriver {
  private verbs?: CliVerbs;

  constructor(readonly tool: Tool, private readonly cli: string, private readonly options: DriverOptions) {}

  private run(args: string[]): Promise<string> {
    return runCli(this.cli, ["plugin", ...args], this.options);
  }

  private async cliVerbs(): Promise<CliVerbs> {
    if (!this.verbs) {
      const commands = helpCommands(await this.run(["--help"]));
      if (!commands.has("marketplace") || !commands.has("list")) {
        throw new Error(`${this.tool} has no plugin marketplace or list command`);
      }
      this.verbs = { install: commands.has("install"), update: commands.has("update"), uninstall: commands.has("uninstall") };
    }
    return this.verbs;
  }

  async status(): Promise<PluginStatus> {
    const verbs = await this.cliVerbs();
    const marketplaces = listOf(JSON.parse(await this.run(["marketplace", "list", "--json"])), "marketplaces");
    const plugins = listOf(JSON.parse(await this.run(["list", "--json"])), "plugins");
    const status: PluginStatus = { verbs };
    const marketplace = marketplaces.find((entry) => entry.name === MARKETPLACE);
    const source = marketplace && marketplaceSource(marketplace);
    if (source) {
      status.marketplace = { source };
    }
    const plugin = plugins.find(
      (entry) => entry.id === PLUGIN_ID || (entry.name === PLUGIN_NAME && entry.marketplace === MARKETPLACE),
    );
    if (plugin) {
      status.plugin = {
        version: typeof plugin.version === "string" ? plugin.version : undefined,
        installPath:
          typeof plugin.installPath === "string" ? plugin.installPath : typeof plugin.path === "string" ? plugin.path : undefined,
      };
    }
    return status;
  }

  async addMarketplace(dir: string): Promise<void> {
    await this.run(["marketplace", "add", dir]);
  }

  async removeMarketplace(): Promise<void> {
    await this.run(["marketplace", "remove", MARKETPLACE]);
  }

  async installPlugin(): Promise<void> {
    await this.run(["install", PLUGIN_ID]);
  }

  async updatePlugin(): Promise<void> {
    await this.run(["update", PLUGIN_ID]);
  }

  async removePlugin(): Promise<void> {
    await this.run(["uninstall", PLUGIN_ID]);
  }
}

export function createDriver(tool: Tool, cliPath: string, options: DriverOptions): PluginDriver {
  return new CliPluginDriver(tool, cliPath, options);
}

function digestOf(file: string): string | undefined {
  return existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : undefined;
}

/** What a marketplace dir offers for our plugin: its dir, version and `bin/hook-forward.js` digest. */
export function offeredPlugin(tool: Tool, marketplaceDir: string): { dir: string; version: string; digest?: string } {
  const manifest = JSON.parse(readFileSync(path.join(marketplaceDir, ...LAYOUT[tool].marketplace), "utf8")) as {
    plugins?: Array<{ name?: string; source?: string | { path?: string } }>;
  };
  const entry = manifest.plugins?.find((plugin) => plugin.name === PLUGIN_NAME);
  const relative = typeof entry?.source === "string" ? entry.source : entry?.source?.path;
  if (!relative) {
    throw new Error(`${marketplaceDir} offers no ${PLUGIN_NAME} plugin for ${tool}`);
  }
  const dir = path.resolve(marketplaceDir, relative);
  const { version } = JSON.parse(readFileSync(path.join(dir, ...LAYOUT[tool].manifest), "utf8")) as { version: string };
  return { dir, version, digest: digestOf(path.join(dir, "bin", "hook-forward.js")) };
}

/** The forwarder digest of the copy the CLI installed, when it says where that is. */
export function installedDigest(status: PluginStatus): string | undefined {
  const installPath = status.plugin?.installPath;
  return installPath ? digestOf(path.join(installPath, "bin", "hook-forward.js")) : undefined;
}

function realOrSelf(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

export function samePath(a: string, b: string): boolean {
  return realOrSelf(a) === realOrSelf(b);
}

/** `file` is `root` or inside it. */
export function isUnder(file: string, root: string): boolean {
  const relative = path.relative(realOrSelf(root), realOrSelf(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function matches(status: PluginStatus, want: { version?: string; digest?: string }): boolean {
  if (!status.plugin || status.plugin.version !== want.version) {
    return false;
  }
  const have = installedDigest(status);
  return want.digest === undefined || have === undefined || have === want.digest;
}

/** Installs, updates, or (with no update verb, or when update keeps the same version) uninstalls and reinstalls. */
async function converge(driver: PluginDriver, status: PluginStatus, want: { version?: string; digest?: string }): Promise<void> {
  if (!status.plugin) {
    await driver.installPlugin();
    return;
  }
  if (status.verbs.update && status.plugin.version !== want.version) {
    await driver.updatePlugin();
    if (matches(await driver.status(), want)) {
      return;
    }
  }
  if (!status.verbs.uninstall) {
    throw new Error(`${driver.tool} cannot update the plugin, and has no uninstall to reinstall it with`);
  }
  // Also refreshes the vendor's installed copy (Claude's plugin cache) when the version did not change.
  await driver.removePlugin();
  await driver.installPlugin();
}

async function pointMarketplaceAt(driver: PluginDriver, status: PluginStatus, dir: string): Promise<boolean> {
  if (status.marketplace && samePath(status.marketplace.source, dir)) {
    return false;
  }
  if (status.marketplace) {
    await driver.removeMarketplace();
  }
  await driver.addMarketplace(dir);
  return true;
}

export interface SyncOutcome {
  result: "ok" | "manual_step_required" | "failed";
  /** The registration before this sync: what an undo puts back. */
  prior: PriorRegistration;
  record: PluginRecord;
}

/**
 * The idempotent provisioning: marketplace `rokid-coder` at `marketplaceDir`,
 * plugin `rokid` at the version and forwarder that dir offers. A second run
 * only reads.
 */
export async function syncPlugin(driver: PluginDriver, marketplaceDir: string): Promise<SyncOutcome> {
  let prior: PriorRegistration = {};
  const record = (status: PluginRecord["status"], detail?: string, pluginVersion?: string): PluginRecord => ({
    source: marketplaceDir,
    status,
    ...(pluginVersion ? { pluginVersion } : {}),
    ...(detail ? { detail } : {}),
  });
  try {
    const want = offeredPlugin(driver.tool, marketplaceDir);
    let status = await driver.status();
    prior = {
      ...(status.marketplace ? { source: status.marketplace.source } : {}),
      ...(status.plugin?.version ? { pluginVersion: status.plugin.version } : {}),
    };
    if (await pointMarketplaceAt(driver, status, marketplaceDir)) {
      status = await driver.status();
    }
    if (!matches(status, want)) {
      const canInstall = status.verbs.install && (status.plugin === undefined || status.verbs.update || status.verbs.uninstall);
      if (!canInstall) {
        return { result: "manual_step_required", prior, record: record("manual_step_required", MANUAL_STEP[driver.tool]) };
      }
      await converge(driver, status, want);
      status = await driver.status();
    }
    if (!matches(status, want)) {
      const reason = `${driver.tool} reports plugin version ${status.plugin?.version ?? "none"}, expected ${want.version}`;
      return { result: "failed", prior, record: record("failed", reason) };
    }
    return { result: "ok", prior, record: record("ok", undefined, want.version) };
  } catch (error) {
    return { result: "failed", prior, record: record("failed", error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Puts a recorded registration back [6b-R11]: the marketplace at its old
 * source, then the plugin at its old version, verified by the version and the
 * forwarder digest the CLI's installed copy holds. Throws when it cannot.
 */
export async function restorePlugin(driver: PluginDriver, prior: PriorRegistration, ourRoots: string[]): Promise<void> {
  if (!prior.source) {
    await removePlugin(driver, ourRoots);
    return;
  }
  let status = await driver.status();
  if (await pointMarketplaceAt(driver, status, prior.source)) {
    status = await driver.status();
  }
  if (prior.pluginVersion === undefined) {
    if (status.plugin && status.verbs.uninstall) {
      await driver.removePlugin();
    }
    return;
  }
  const offered = offeredPlugin(driver.tool, prior.source);
  const want = { version: prior.pluginVersion, digest: offered.version === prior.pluginVersion ? offered.digest : undefined };
  if (!matches(status, want)) {
    await converge(driver, status, want);
    status = await driver.status();
  }
  if (!matches(status, want)) {
    throw new Error(`${driver.tool} still reports plugin version ${status.plugin?.version ?? "none"} after restoring ${prior.pluginVersion}`);
  }
}

/**
 * Uninstalls the plugin, then removes the marketplace, only when the
 * marketplace is ours (its source is under one of `ourRoots`). Someone else's
 * `rokid-coder` registration, a developer's checkout say, is left alone.
 */
export async function removePlugin(driver: PluginDriver, ourRoots: string[]): Promise<boolean> {
  const status = await driver.status();
  if (status.marketplace && !ourRoots.some((root) => isUnder(status.marketplace!.source, root))) {
    return false;
  }
  if (status.plugin && status.verbs.uninstall) {
    await driver.removePlugin();
  }
  if (status.marketplace) {
    await driver.removeMarketplace();
  }
  return true;
}
