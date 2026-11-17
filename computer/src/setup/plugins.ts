import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginRecord, PriorRegistration, Tool } from "./manifest";

/**
 * Plugin provisioning through each CLI's own plugin commands [FR 9]. Setup
 * never edits ~/.claude or ~/.codex itself: every change is the vendor CLI's,
 * run by absolute path with an argv array and no shell. The source is the
 * versioned bundle's read-only `plugins/` dir, never a copy [6b-R11].
 *
 * The verbs are pinned per CLI from the recorded help in
 * test/fixtures/plugin-cli/recorded/ (ADAPTERS). Which of them a CLI has is
 * read from its own `plugin --help` at run time, so a CLI without a
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

/**
 * Each CLI's own plugin verbs. claude 2.1.285: `plugin install|list|uninstall|update`;
 * codex-cli 0.169.0: `plugin add|list|remove`, with no update or disable. Both have
 * `plugin marketplace add|list|remove`.
 */
interface CliAdapter {
  install: string;
  uninstall: string;
  update?: string;
  /** Turns an installed plugin off without removing it. */
  disable?: string;
}

const ADAPTERS: Record<Tool, CliAdapter> = {
  claude: { install: "install", uninstall: "uninstall", update: "update", disable: "disable" },
  codex: { install: "add", uninstall: "remove" },
};

export interface CliVerbs {
  install: boolean;
  update: boolean;
  uninstall: boolean;
  disable: boolean;
}

export interface PluginStatus {
  /** The `rokid-coder` marketplace, when the CLI lists one. */
  marketplace?: { source: string };
  /** Our plugin, when the CLI lists it as installed. */
  /** `enabled` is what the CLI's list says; absent when it does not say. */
  plugin?: { version?: string; installPath?: string; enabled?: boolean };
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
  disablePlugin(): Promise<void>;
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

type Entry = Record<string, unknown>;

function isEntry(value: unknown): value is Entry {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** One list from a CLI's `--json`: its entries, each with the section of the output it came from. */
interface Listed {
  entry: Entry;
  section: string;
}

function entriesIn(list: unknown, section: string, idField: string, out: Listed[]): boolean {
  if (Array.isArray(list)) {
    const entries = list.filter(isEntry);
    if (list.length > 0 && entries.length === 0) {
      throw new Error(`unexpected ${section} list output`);
    }
    for (const entry of entries) out.push({ entry, section });
    return true;
  }
  if (isEntry(list)) {
    // Entries keyed by their id.
    const keyed = Object.entries(list);
    if (keyed.length > 0 && !keyed.every(([, entry]) => isEntry(entry))) {
      return false;
    }
    for (const [key, entry] of keyed) out.push({ entry: { [idField]: key, ...(entry as Entry) }, section });
    return true;
  }
  return false;
}

/**
 * What a CLI's `plugin list --json` and `plugin marketplace list --json` hold, across the shapes
 * the CLIs print: a top-level array; `{plugins|marketplaces: [...]}`; codex 0.169's
 * `{installed: [...]}` (other keys ignored, `available: [...]` read too); entries keyed by id; and
 * marketplaces that carry their own `plugins`. Anything else is not a list and throws.
 */
function listOf(value: unknown, containers: string[], idField: string): Listed[] {
  const out: Listed[] = [];
  if (Array.isArray(value)) {
    entriesIn(value, containers[0], idField, out);
    return out;
  }
  if (!isEntry(value)) {
    throw new Error(`unexpected ${containers[0]} list output`);
  }
  let found = false;
  for (const key of containers) {
    if (key in value && entriesIn(value[key], key, idField, out)) {
      found = true;
    }
  }
  if (!found) {
    // `{"rokid@rokid-coder": {...}}`, or `{"rokid-coder": {"source": ...}}`: every key an id, every value an entry.
    const keyed = Object.entries(value);
    const idLike = (key: string, entry: unknown): boolean =>
      isEntry(entry) && (idField === "id" ? /^[^@\s]+@[^@\s]+$/.test(key) : marketplaceSource(entry) !== undefined);
    if (keyed.length > 0 && keyed.every(([key, entry]) => idLike(key, entry))) {
      entriesIn(value, containers[0], idField, out);
      found = true;
    }
  }
  // `{marketplaces: [{name, plugins: [...]}]}`: the plugins of each marketplace.
  if (idField === "id" && "marketplaces" in value) {
    const marketplaces: Listed[] = [];
    if (entriesIn(value.marketplaces, "marketplaces", "name", marketplaces)) {
      found = true;
    }
    for (const { entry } of marketplaces) {
      const name = typeof entry.name === "string" ? entry.name : undefined;
      const nested: Listed[] = [];
      if (entriesIn(entry.plugins, "plugins", "id", nested)) {
        for (const item of nested) out.push({ entry: { ...(name ? { marketplaceName: name } : {}), ...item.entry }, section: "plugins" });
      }
    }
  }
  if (!found) {
    throw new Error(`unexpected ${containers[0]} list output`);
  }
  return out;
}

function stringOf(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value !== "");
}

function marketplaceSource(entry: Entry): string | undefined {
  const source = entry.source as unknown;
  const located = entry.marketplaceSource as unknown;
  if (typeof entry.path === "string") return entry.path;
  if (typeof source === "string" && path.isAbsolute(source)) return source;
  if (isEntry(source) && typeof source.path === "string") return source.path;
  // codex 0.169 puts it on the plugin entry: {"sourceType":"local","source":"/abs/dir"}.
  if (isEntry(located)) {
    const where = stringOf(located.source, located.path);
    if (where && path.isAbsolute(where)) return where;
  }
  return undefined;
}

function marketplaceNameOf(entry: Entry): string | undefined {
  const named = entry.marketplace;
  return stringOf(entry.marketplaceName, named, isEntry(named) ? named.name : undefined);
}

function isOurPlugin(entry: Entry): boolean {
  return stringOf(entry.pluginId, entry.id) === PLUGIN_ID || (entry.name === PLUGIN_NAME && marketplaceNameOf(entry) === MARKETPLACE);
}

class CliPluginDriver implements PluginDriver {
  private verbs?: CliVerbs;
  private readonly adapter: CliAdapter;

  constructor(readonly tool: Tool, private readonly cli: string, private readonly options: DriverOptions) {
    this.adapter = ADAPTERS[tool];
  }

  private run(args: string[]): Promise<string> {
    return runCli(this.cli, ["plugin", ...args], this.options);
  }

  private async cliVerbs(): Promise<CliVerbs> {
    if (!this.verbs) {
      const commands = helpCommands(await this.run(["--help"]));
      if (!commands.has("marketplace") || !commands.has("list")) {
        throw new Error(`${this.tool} has no plugin marketplace or list command`);
      }
      const { install, uninstall, update, disable } = this.adapter;
      this.verbs = {
        install: commands.has(install),
        update: update !== undefined && commands.has(update),
        uninstall: commands.has(uninstall),
        disable: disable !== undefined && commands.has(disable),
      };
    }
    return this.verbs;
  }

  async status(): Promise<PluginStatus> {
    const verbs = await this.cliVerbs();
    const marketplaces = listOf(JSON.parse(await this.run(["marketplace", "list", "--json"])), ["marketplaces", "installed", "available"], "name");
    const plugins = listOf(JSON.parse(await this.run(["list", "--json"])), ["plugins", "installed", "available"], "id");
    const status: PluginStatus = { verbs };
    // Codex lists what its marketplaces offer too: only an entry that is not marked installed:false is installed,
    // and one in its "available" section only when it says installed:true.
    const found = plugins.find(
      ({ entry, section }) => isOurPlugin(entry) && (entry.installed === true || (section !== "available" && entry.installed !== false)),
    )?.entry;
    const listed = marketplaces.find(({ entry }) => stringOf(entry.name, entry.marketplaceName) === MARKETPLACE)?.entry;
    const source =
      (listed && marketplaceSource(listed)) ??
      plugins.filter(({ entry }) => isOurPlugin(entry)).map(({ entry }) => marketplaceSource({ marketplaceSource: entry.marketplaceSource })).find(Boolean);
    if (source) {
      status.marketplace = { source };
    }
    if (found) {
      status.plugin = {
        version: typeof found.version === "string" ? found.version : undefined,
        installPath: stringOf(found.installPath, found.path),
        ...(typeof found.enabled === "boolean" ? { enabled: found.enabled } : {}),
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
    await this.run([this.adapter.install, PLUGIN_ID]);
  }

  async updatePlugin(): Promise<void> {
    if (!this.adapter.update) {
      throw new Error(`${this.tool} has no plugin update command`);
    }
    await this.run([this.adapter.update, PLUGIN_ID]);
  }

  async removePlugin(): Promise<void> {
    await this.run([this.adapter.uninstall, PLUGIN_ID]);
  }

  async disablePlugin(): Promise<void> {
    if (!this.adapter.disable) {
      throw new Error(`${this.tool} has no plugin disable command`);
    }
    await this.run([this.adapter.disable, PLUGIN_ID]);
  }
}

export function createDriver(tool: Tool, cliPath: string, options: DriverOptions): PluginDriver {
  return new CliPluginDriver(tool, cliPath, options);
}

/** Directory entries never part of a plugin's content: dependencies, VCS data, Finder droppings. */
const SKIPPED_NAMES = new Set(["node_modules", ".git", ".DS_Store"]);

/** A plugin's files by relative path (`/`-separated) to the SHA-256 of their bytes. */
export type PluginFiles = Record<string, string>;

/**
 * Every regular file under `dir`, by relative path and content hash, in a deterministic (sorted) order.
 * Symlinks, `node_modules`, `.git` and `.DS_Store` are skipped. A missing dir has no files.
 */
export function pluginFiles(dir: string): PluginFiles {
  const files: PluginFiles = {};
  const visit = (relative: string): void => {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, relative)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIPPED_NAMES.has(name)) continue;
      const child = relative === "" ? name : `${relative}/${name}`;
      const stat = lstatSync(path.join(dir, child));
      if (stat.isDirectory()) {
        visit(child);
      } else if (stat.isFile()) {
        files[child] = createHash("sha256").update(readFileSync(path.join(dir, child))).digest("hex");
      }
    }
  };
  visit("");
  return files;
}

/** One digest of a plugin's whole content: the SHA-256 of its sorted `path NUL hash` lines. */
export function contentDigest(files: PluginFiles): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(`${name}\0${files[name]}\n`);
  }
  return hash.digest("hex");
}

/**
 * What a marketplace dir offers for our plugin: its dir, version, every file's hash and the digest of
 * them all. A change to hooks.json, a command or the manifest changes the digest with the version unchanged.
 */
export function offeredPlugin(tool: Tool, marketplaceDir: string): { dir: string; version: string; files: PluginFiles; digest: string } {
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
  const files = pluginFiles(dir);
  return { dir, version, files, digest: contentDigest(files) };
}

/**
 * The offered files the CLI's installed copy lacks or holds with other bytes, when the CLI says where that copy
 * is; `undefined` only when it says nothing (the version is then trusted). A reported path that does not exist
 * holds none of the files. Extra files in the installed copy, such as the CLI's own cache files, are fine.
 */
export function installedDifferences(status: PluginStatus, offered: PluginFiles): string[] | undefined {
  const installPath = status.plugin?.installPath;
  if (!installPath) {
    return undefined;
  }
  const differing: string[] = [];
  for (const [name, hash] of Object.entries(offered)) {
    const file = path.join(installPath, ...name.split("/"));
    let same = false;
    try {
      same = lstatSync(file).isFile() && createHash("sha256").update(readFileSync(file)).digest("hex") === hash;
    } catch {
      // Missing or unreadable: differs.
    }
    if (!same) differing.push(name);
  }
  return differing;
}

/** A registration as an undo puts it back, with whether the user had the plugin turned off. */
export type PriorState = PriorRegistration & { enabled?: false };

/** What a CLI has registered: the marketplace, the plugin's version and, when the user disabled it, that. */
export function priorOf(status: PluginStatus): PriorState {
  return {
    ...(status.marketplace ? { source: status.marketplace.source } : {}),
    ...(status.plugin?.version ? { pluginVersion: status.plugin.version } : {}),
    ...(status.plugin?.enabled === false ? { enabled: false } : {}),
  };
}

/**
 * A reinstall enables the plugin again, so one the user had disabled is disabled again through the CLI's own
 * verb. Returns the manual step to tell the user when that cannot be done (no disable verb, or it failed).
 */
async function keepDisabled(driver: PluginDriver): Promise<string | undefined> {
  const where = driver.tool === "claude" ? "/plugin" : "/plugins";
  let status: PluginStatus;
  try {
    status = await driver.status();
  } catch {
    // The refresh itself is verified; only this extra read failed.
    return `Setup could not check whether the Rokid plugin was disabled before this update; if it was, disable it in ${where} again`;
  }
  if (!status.plugin || status.plugin.enabled === false) {
    return undefined;
  }
  if (status.verbs.disable) {
    try {
      await driver.disablePlugin();
      return undefined;
    } catch {
      // Falls through to the manual step.
    }
  }
  return `The Rokid plugin was disabled before this update; it is enabled again - disable it in ${where} if you want it off`;
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

/** What a plugin must be: its version and, when known, the files (and bytes) its installed copy must hold. */
interface Want {
  version?: string;
  files?: PluginFiles;
}

/** The installed plugin has the wanted version and (when the CLI says where it is) every wanted file, byte for byte. */
function matches(status: PluginStatus, want: Want): boolean {
  if (!status.plugin || status.plugin.version !== want.version) {
    return false;
  }
  return !want.files || (installedDifferences(status, want.files) ?? []).length === 0;
}

/** How long to wait before the one retry of a failed install; a transient CLI failure is the likely cause. */
function retryPauseMs(): number {
  const set = Number(process.env.ROKID_SETUP_PLUGIN_RETRY_MS);
  return process.env.ROKID_SETUP_PLUGIN_RETRY_MS !== undefined && Number.isFinite(set) && set >= 0 ? set : 1500;
}

async function installWithRetry(driver: PluginDriver): Promise<void> {
  try {
    await driver.installPlugin();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, retryPauseMs()));
    await driver.installPlugin();
  }
}

/** Installs, updates, or (with no update verb, or when update keeps the same version) uninstalls and reinstalls. */
async function converge(driver: PluginDriver, status: PluginStatus, want: Want): Promise<void> {
  if (!status.plugin) {
    await installWithRetry(driver);
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
  await installWithRetry(driver);
}

/**
 * After a failed install or update: what is true now, for the user. A plugin that was installed before and is gone
 * is put back from its previous registration when that is known; whatever happens, the warning says whether the
 * plugin is installed, with the command that retries.
 */
async function afterFailedConverge(driver: PluginDriver, prior: PriorState): Promise<string | undefined> {
  const retry = `Run: rokid-setup plugins sync --tool ${driver.tool}`;
  const installed = async (): Promise<boolean | undefined> => {
    try {
      return (await driver.status()).plugin !== undefined;
    } catch {
      return undefined;
    }
  };
  const now = await installed();
  if (now === undefined || now) {
    return undefined;
  }
  if (prior.source && prior.pluginVersion) {
    try {
      await restorePlugin(driver, prior, []);
    } catch {
      // Whether it came back is read next.
    }
    if ((await installed()) !== false) {
      return `The Rokid plugin could not be updated in ${driver.tool}; the previous registration was put back. ${retry}`;
    }
  }
  return `The Rokid plugin is currently NOT installed in ${driver.tool}. ${retry}`;
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
  /** A step for the user that does not fail the sync, such as a plugin that is enabled again. */
  warning?: string;
  /** The registration before this sync: what an undo puts back. */
  prior: PriorState;
  record: PluginRecord;
}

/**
 * The idempotent provisioning: marketplace `rokid-coder` at `marketplaceDir`,
 * plugin `rokid` at the version and content that dir offers: every file of the
 * plugin, not only its version, so a release that changes hooks.json or a
 * command without bumping the version still refreshes the installed copy. A
 * second run only reads.
 */
export async function syncPlugin(driver: PluginDriver, marketplaceDir: string): Promise<SyncOutcome> {
  let prior: PriorState = {};
  const record = (status: PluginRecord["status"], detail?: string, pluginVersion?: string): PluginRecord => ({
    source: marketplaceDir,
    status,
    ...(pluginVersion ? { pluginVersion } : {}),
    ...(detail ? { detail } : {}),
  });
  try {
    const offered = offeredPlugin(driver.tool, marketplaceDir);
    const want: Want = { version: offered.version, files: offered.files };
    let status = await driver.status();
    prior = priorOf(status);
    if (await pointMarketplaceAt(driver, status, marketplaceDir)) {
      status = await driver.status();
    }
    if (!matches(status, want)) {
      const canInstall = status.verbs.install && (status.plugin === undefined || status.verbs.update || status.verbs.uninstall);
      if (!canInstall) {
        return { result: "manual_step_required", prior, record: record("manual_step_required", MANUAL_STEP[driver.tool]) };
      }
      try {
        await converge(driver, status, want);
      } catch (error) {
        const warning = await afterFailedConverge(driver, prior);
        return {
          result: "failed",
          prior,
          ...(warning ? { warning } : {}),
          record: record("failed", error instanceof Error ? error.message : String(error)),
        };
      }
      status = await driver.status();
    }
    if (!matches(status, want)) {
      const differing = status.plugin?.version === want.version ? want.files ? installedDifferences(status, want.files) ?? [] : [] : [];
      const reason =
        differing.length > 0
          ? `${driver.tool}'s installed plugin differs from the offered one in ${differing.slice(0, 5).join(", ")}${differing.length > 5 ? ", ..." : ""}`
          : `${driver.tool} reports plugin version ${status.plugin?.version ?? "none"}, expected ${want.version}`;
      return { result: "failed", prior, record: record("failed", reason) };
    }
    const warning = prior.enabled === false ? await keepDisabled(driver) : undefined;
    return { result: "ok", prior, ...(warning ? { warning } : {}), record: record("ok", undefined, want.version) };
  } catch (error) {
    return { result: "failed", prior, record: record("failed", error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * Puts a recorded registration back [6b-R11]: the marketplace at its old
 * source, then the plugin at its old version, verified by the version and the
 * file contents the CLI's installed copy holds. Throws when it cannot.
 */
export async function restorePlugin(driver: PluginDriver, prior: PriorState, ourRoots: string[]): Promise<void> {
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
  const want: Want = { version: prior.pluginVersion, files: offered.version === prior.pluginVersion ? offered.files : undefined };
  if (!matches(status, want)) {
    await converge(driver, status, want);
    status = await driver.status();
  }
  if (!matches(status, want)) {
    throw new Error(`${driver.tool} still reports plugin version ${status.plugin?.version ?? "none"} after restoring ${prior.pluginVersion}`);
  }
  const manual = prior.enabled === false ? await keepDisabled(driver) : undefined;
  if (manual) {
    throw new Error(`the ${driver.tool} plugin was restored, but setup could not keep it disabled: ${manual}`);
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
