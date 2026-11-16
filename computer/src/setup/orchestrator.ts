import { accessSync, constants, copyFileSync, existsSync, readFileSync, realpathSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { advertiseChangeFor, advertisePath, clearAdvertise, readAdvertiseBytes, restoreAdvertiseBytes, writeAdvertise } from "../advertise";
import { type CliInstallIo, offerCliInstall, realCliInstallIo, resolveCli } from "../launcher/cli-install";
import { PinStore } from "../tls";
import { WRAPPER_NAMES, installUserWrappers, renderUserWrapper } from "../wrappers";
import type { Answers } from "./answers";
import { MIGRATE_HOOKS_COMMAND, discoverLegacy, migrateInstallHooks } from "./legacy";
import {
  type BindingRecord,
  type InstallManifest,
  type PreviousInstall,
  type PriorRegistration,
  TOOLS,
  type Tool,
  bundleVersion,
  manifestPath,
  programDir,
  readManifest,
  withoutPrevious,
  writeManifest,
  writePrivateFile,
} from "./manifest";
import { pairStep } from "./pair-step";
import { AUTOSTART, type PlatformHooks, type RetiredRecord } from "./platform/index";
import { createDriver, restorePlugin, syncPlugin } from "./plugins";
import { profileFiles, readBlock, renderBlock, writeBlock } from "./profile-path";
import { type ResolvedCli, cliRunEnv, envFilePath, resolveAll, writeDaemonEnv } from "./resolve-cli";
import {
  type StateLocations,
  checkSnapshot,
  hasState,
  isCompleteSnapshot,
  newSnapshotDir,
  pruneSnapshots,
  restoreSnapshot,
  stateLocations,
  writeSnapshot,
} from "./state";

export const MIN_FREE_BYTES = 300 * 1024 * 1024;

export interface SetupIo {
  /** stdin is a terminal: only then is anything asked. */
  interactive: boolean;
  /** What the person sees (and the setup log keeps). */
  write(text: string): void;
  /** The setup log only: where a waiting setup is, for a person or a CI job reading the log. */
  note(text: string): void;
  readLine(): Promise<string | undefined>;
}

export interface Health {
  ok?: boolean;
  agentdVersion?: string;
  execPath?: string;
}

export interface SetupContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformHooks;
  io: SetupIo;
  answers?: Answers;
  /** agentd's /health on loopback, or undefined when nothing answers. */
  health(): Promise<Health | undefined>;
  runPair(bundleDir: string): Promise<number>;
  now(): Date;
  /** How long to wait for the ports to free and for the new agentd to prove its identity (20 s). */
  timeoutMs: number;
  /** ROKID_SETUP_FAIL_AT / ROKID_SETUP_CRASH_AT, honoured only under ROKID_SETUP_TEST=1. */
  failAt?: number;
  crashAt?: number;
}

export class SetupError extends Error {}

// ---- the journal: ~/.rokid-coder/setup-journal.json (TRANSACTION class, survives any restore) ----

interface PluginUndo {
  cliPath: string;
  prior: PriorRegistration;
  /** The PATH its plugin commands ran with (cliRunEnv), so the undo finds the same interpreter. */
  path?: string;
}

export interface Journal {
  schema: 1;
  open: boolean;
  op: "install";
  startedAt: string;
  newManifest: InstallManifest;
  previousManifest?: InstallManifest;
  legacyVersion?: string;
  locations: StateLocations;
  steps: {
    3?: { stopCurrent: boolean; retiredLegacy?: RetiredRecord };
    4?: { snapshot: string };
    /** `settings`: only in a journal from before R217, when install itself removed the install-hooks entries; still undone. `advertise`: advertise.json's bytes (base64) before a WSL binding changed it; null: there was none. */
    5?: { wrappers: Record<string, string | null>; pathBlocks: Record<string, string | null>; settings?: { settingsPath: string; backupPath?: string }; advertise?: { file: string; previous: string | null } };
    7?: { env: string | null };
    8?: { plugins: Partial<Record<Tool, PluginUndo>> };
    9?: { started: true };
  };
}

export function journalPath(home: string): string {
  return path.join(programDir(home), "setup-journal.json");
}

export function readJournal(home: string): Journal | undefined {
  const file = journalPath(home);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Journal) : undefined;
}

function writeJournal(home: string, journal: Journal): void {
  writePrivateFile(journalPath(home), `${JSON.stringify(journal, null, 2)}\n`);
}

function readText(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

// ---- shared helpers ----

function agentdPorts(locations: StateLocations): number[] {
  try {
    const config = JSON.parse(readFileSync(path.join(locations.nexusDir, "config.json"), "utf8")) as {
      httpPort?: unknown;
      wsPort?: unknown;
    };
    const ports = [config.httpPort, config.wsPort].filter((port): port is number => Number.isInteger(port));
    if (ports.length === 2) return ports;
  } catch {
    // fresh: the defaults
  }
  return [8791, 8792];
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForPortsFree(ctx: SetupContext, ports: number[]): Promise<void> {
  let last: Awaited<ReturnType<PlatformHooks["portOwners"]>> = [];
  const free = await waitFor(async () => {
    last = await ctx.platform.portOwners(ports);
    return last.length === 0 ? true : undefined;
  }, ctx.timeoutMs);
  if (!free) {
    const holder = last[0];
    throw new SetupError(`port ${holder.port} is still held by pid ${holder.pid} (${holder.exe})`);
  }
}

function insideDir(file: string | undefined, dir: string): boolean {
  if (!file) return false;
  let root = dir;
  try {
    root = realpathSync(dir);
  } catch {
    // compare as given
  }
  return file.startsWith(`${root}${path.sep}`);
}

/** /health must report `m`'s version from an executable inside `m`'s bundle [6b-R4]. */
async function verifyIdentity(ctx: SetupContext, m: InstallManifest): Promise<Health | undefined> {
  let last: Health | undefined;
  const proven = await waitFor(async () => {
    last = await ctx.health();
    return last?.agentdVersion === m.version && insideDir(last.execPath, m.bundleDir) ? last : undefined;
  }, ctx.timeoutMs);
  if (!proven) {
    const seen = last ? `agentd ${last.agentdVersion ?? "?"} from ${last.execPath ?? "?"}` : "nothing";
    throw new SetupError(`the new agentd did not take over: /health answered ${seen}`);
  }
  return proven;
}

function inject(ctx: SetupContext, step: number): void {
  if (ctx.crashAt === step) {
    process.exit(70);
  }
  if (ctx.failAt === step) {
    throw new SetupError(`injected failure at step ${step}`);
  }
}

function bundleRoots(...manifests: Array<{ bundleDir?: string } | undefined>): string[] {
  const roots = new Set<string>();
  for (const m of manifests) {
    if (m?.bundleDir) {
      roots.add(m.bundleDir);
      roots.add(path.dirname(m.bundleDir));
    }
  }
  return [...roots];
}

function wrapperFiles(home: string): string[] {
  return WRAPPER_NAMES.map((name) => path.join(programDir(home), "bin", name));
}

// ---- the one fixed restore sequence [6b-R12] ----

export interface RestorePlan {
  /** 1: the replacement to stop. */
  stop?: InstallManifest;
  ports: number[];
  /** 2 */
  snapshot?: string;
  locations: StateLocations;
  /** 2, after the state: the advertised endpoint's exact previous bytes. */
  advertise?: { file: string; previous: string | null };
  /** 3: each program file's previous content; null removes it. */
  wrappers?: Record<string, string | null>;
  pathBlocks?: Record<string, string | null>;
  env?: { content: string | null };
  settings?: { settingsPath: string; backupPath: string };
  /** 4 */
  plugins?: Partial<Record<Tool, PluginUndo>>;
  ourRoots: string[];
  /** 5: a retired legacy autostart, restored without starting it. */
  legacy?: RetiredRecord;
  /** 6: the one start. */
  start?: { manifest: InstallManifest } | { legacy: RetiredRecord };
  label: string;
}

/**
 * Recovery, rollback and a re-run after a crash all run this, in this order,
 * each action only when there is something recorded for it. Nothing starts
 * before step 6, so the replacement never runs against restored state.
 */
export async function runRestore(ctx: SetupContext, plan: RestorePlan): Promise<string[]> {
  const problems: string[] = [];
  const attempt = async (what: string, action: () => Promise<void> | void): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };
  // 1
  let stopped = true;
  if (plan.stop) {
    const replacement = plan.stop;
    stopped = await attempt("stopping the new agentd", async () => {
      await ctx.platform.stopCurrent(replacement);
      // Without an earlier install to start again, nothing may bring the new one back at the next login.
      if (!(plan.start && "manifest" in plan.start)) await ctx.platform.removeAutostart(replacement);
      await waitForPortsFree(ctx, plan.ports);
    });
  }
  // 2
  let stateRestored = true;
  if (isCompleteSnapshot(plan.snapshot)) {
    const snapshot = plan.snapshot;
    stateRestored = stopped && (await attempt("restoring the state", () => void restoreSnapshot(plan.locations, snapshot, ctx.now())));
  }
  if (plan.advertise) {
    const { file, previous } = plan.advertise;
    stateRestored = stopped && (await attempt("restoring the advertised endpoint", () => restoreAdvertiseBytes(file, previous))) && stateRestored;
  }
  // 3
  await attempt("restoring the program files", () => {
    for (const [file, content] of Object.entries(plan.wrappers ?? {})) {
      if (content === null) {
        rmSync(file, { force: true });
      } else {
        writePrivateFile(file, content, 0o755);
      }
    }
    for (const [file, block] of Object.entries(plan.pathBlocks ?? {})) writeBlock(file, block);
    if (plan.env) {
      if (plan.env.content === null) rmSync(envFilePath(ctx.home), { force: true });
      else writePrivateFile(envFilePath(ctx.home), plan.env.content);
    }
    if (plan.settings) copyFileSync(plan.settings.backupPath, plan.settings.settingsPath);
  });
  // 4
  for (const tool of TOOLS) {
    const undo = plan.plugins?.[tool];
    if (undo) {
      await attempt(`restoring the ${tool} plugin`, () =>
        restorePlugin(
          createDriver(tool, undo.cliPath, { home: ctx.home, env: undo.path ? { ...ctx.env, PATH: undo.path } : ctx.env }),
          undo.prior,
          plan.ourRoots,
        ),
      );
    }
  }
  // 5
  if (plan.legacy) {
    const legacy = plan.legacy;
    await attempt("restoring the old autostart", () => ctx.platform.restoreLegacyAutostart(legacy));
  }
  // 6
  if (plan.start && stopped && stateRestored) {
    const start = plan.start;
    await attempt("starting the previous agentd", async () => {
      if ("manifest" in start) {
        if ((await ctx.platform.installAutostart(start.manifest)) === "running") {
          await verifyIdentity(ctx, start.manifest);
        }
      } else {
        await ctx.platform.startLegacyAutostart(start.legacy);
        const up = await waitFor(async () => {
          const health = await ctx.health();
          const owners = await ctx.platform.portOwners(plan.ports);
          return health?.ok && owners.some((owner) => owner.owner === "legacy") ? true : undefined;
        }, ctx.timeoutMs);
        if (!up) throw new SetupError("the old agent did not answer on /health");
      }
    });
  } else if (plan.start) {
    problems.push("the previous agentd was not started, because the state could not be put back first");
  }
  return problems;
}

function restorePlanFromJournal(journal: Journal): RestorePlan {
  const steps = journal.steps;
  const previous = journal.previousManifest;
  const retired = steps[3]?.retiredLegacy;
  const step5 = steps[5];
  const plan: RestorePlan = {
    ports: agentdPorts(journal.locations),
    locations: journal.locations,
    ourRoots: bundleRoots(journal.newManifest, previous),
    label: previous ? previous.version : retired ? `your ${retired.version ?? journal.legacyVersion ?? "earlier"} setup` : "how this computer was before setup",
  };
  if (steps[9]) plan.stop = journal.newManifest;
  if (steps[4]) plan.snapshot = steps[4].snapshot;
  if (step5) {
    plan.wrappers = step5.wrappers;
    plan.pathBlocks = step5.pathBlocks;
    if (step5.settings?.backupPath) plan.settings = { settingsPath: step5.settings.settingsPath, backupPath: step5.settings.backupPath };
    if (step5.advertise) plan.advertise = step5.advertise;
  }
  if (steps[7]) plan.env = { content: steps[7].env };
  if (steps[8]) plan.plugins = steps[8].plugins;
  if (retired) plan.legacy = retired;
  if (steps[3]?.stopCurrent && previous) plan.start = { manifest: previous };
  else if (retired) plan.start = { legacy: retired };
  return plan;
}

/**
 * Undoes exactly what an open journal shows ran, and closes it only when
 * every restore succeeded. Otherwise the journal stays open, so the next
 * setup run undoes it again before it changes anything.
 */
export async function recover(ctx: SetupContext, journal: Journal): Promise<boolean> {
  const plan = restorePlanFromJournal(journal);
  const problems = await runRestore(ctx, plan);
  for (const problem of problems) ctx.io.write(`  ${problem}\n`);
  if (problems.length > 0) {
    ctx.io.write(`The rollback to ${plan.label} did not finish. Fix the problems above, then run setup again to finish it.\n`);
    return false;
  }
  writeJournal(ctx.home, { ...journal, open: false });
  ctx.io.write(`Rolled back to ${plan.label}\n`);
  return true;
}

// ---- install ----

const TOOL_NAMES: Record<Tool, string> = { claude: "Claude Code", codex: "Codex" };

export interface InstallOptions {
  platformName: "darwin" | "wsl";
  bundleDir: string;
  binding?: BindingRecord;
}

function preconditions(ctx: SetupContext): void {
  try {
    accessSync(ctx.home, constants.W_OK);
  } catch {
    throw new SetupError(`Your home folder (${ctx.home}) is not writable`);
  }
  const stats = statfsSync(ctx.home);
  if (Number(stats.bavail) * Number(stats.bsize) < MIN_FREE_BYTES) {
    throw new SetupError("Rokid Coder needs 300 MB of free disk space");
  }
}

async function ask(ctx: SetupContext, question: string, defaultYes: boolean): Promise<boolean> {
  ctx.io.write(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `);
  const line = await ctx.io.readLine();
  if (line === undefined) {
    ctx.io.write("\n");
    return false;
  }
  const answer = line.trim().toLowerCase();
  return answer === "" ? defaultYes : answer === "y" || answer === "yes";
}

async function cliStep(ctx: SetupContext, resolved: Partial<Record<Tool, ResolvedCli>>): Promise<void> {
  const real = realCliInstallIo({ env: ctx.env, home: ctx.home });
  for (const tool of TOOLS) {
    if (resolved[tool]) continue;
    const choice = ctx.answers?.cli?.[tool];
    if (choice === "skip") continue;
    ctx.io.note("awaiting: cli_step");
    const io: CliInstallIo = {
      interactive: choice === "install" || ctx.io.interactive,
      platform: process.platform,
      write: (text) => ctx.io.write(text.replace(/^rk: /gm, "")),
      readLine: choice === "install" ? async () => "y" : () => ctx.io.readLine(),
      hasCommand: real.hasCommand,
      run: real.run,
      resolve: (name) => resolveCli(name, ctx.env, ctx.home),
      // Setup provisions the plugins itself, at step 8.
      runSetup: async () => 0,
    };
    await offerCliInstall(tool, io);
  }
}

function alreadyPaired(locations: StateLocations): boolean {
  try {
    return new PinStore(path.join(locations.stateDir, "tls", "phone-pins.json")).list().length > 0;
  } catch {
    return false;
  }
}

export async function install(ctx: SetupContext, options: InstallOptions): Promise<number> {
  // 0
  preconditions(ctx);
  const advertise = options.binding ? advertiseChangeFor(options.binding.contents) : undefined;
  const open = readJournal(ctx.home);
  if (open?.open) {
    ctx.io.write("An earlier setup did not finish. Undoing it first.\n");
    if (!(await recover(ctx, open))) {
      throw new SetupError("The earlier setup could not be undone, so this one did not start");
    }
  }
  const bundleDir = path.resolve(options.bundleDir);
  const version = bundleVersion(bundleDir);
  // 1
  const current = readManifest(ctx.home);
  const locations = stateLocations(ctx.home, ctx.env);
  const ports = agentdPorts(locations);
  let legacy = await discoverLegacy(ctx.home, ctx.platform, ports);
  while (legacy.others.length > 0) {
    const other = legacy.others[0];
    ctx.io.write(`Stop the agentd running in another terminal (pid ${other.pid}), then press Enter\n`);
    if (!ctx.io.interactive || (await ctx.io.readLine()) === undefined) {
      throw new SetupError(`pid ${other.pid} (${other.exe}) holds port ${other.port}; setup never stops it for you`);
    }
    legacy = await discoverLegacy(ctx.home, ctx.platform, ports);
  }
  // 2
  let retire = false;
  if (legacy.autostart) {
    retire =
      ctx.answers?.legacy?.retireAutostart ??
      (ctx.io.interactive &&
        (await ask(ctx, `Replace the old Rokid-Coder agent (${legacy.autostart.label})? It is stopped now and put back if setup fails.`, true)));
    if (!retire) {
      throw new SetupError(`The old agent (${legacy.autostart.label}) has to be retired first: it holds agentd's ports. Run setup again and agree to replace it.`);
    }
  }
  const newManifest: InstallManifest = {
    schema: 1,
    version,
    platform: options.platformName,
    bundleDir,
    installedAt: ctx.now().toISOString(),
    clis: {},
    plugins: {},
    autostart: AUTOSTART[options.platformName],
    ...(options.binding ? { binding: options.binding } : {}),
  };
  const journal: Journal = {
    schema: 1,
    open: true,
    op: "install",
    startedAt: ctx.now().toISOString(),
    newManifest,
    ...(current ? { previousManifest: withoutPrevious(current) } : {}),
    ...(legacy.autostart?.version ? { legacyVersion: legacy.autostart.version } : {}),
    locations,
    steps: {},
  };
  const record = (): void => writeJournal(ctx.home, journal);
  record();
  const warnings: string[] = [];
  const manual: string[] = [];
  let autostart: "running" | "pending_next_login";
  const pluginSources: Partial<Record<Tool, PriorRegistration>> = {};
  try {
    // 3: quiesce
    journal.steps[3] = { stopCurrent: Boolean(current) };
    record();
    if (current) {
      ctx.io.write("Stopping the running agentd…\n");
      await ctx.platform.stopCurrent(current);
    }
    if (legacy.autostart && retire) {
      journal.steps[3].retiredLegacy = await ctx.platform.retireLegacyAutostart(legacy.autostart);
      record();
    }
    await waitForPortsFree(ctx, ports);
    inject(ctx, 3);

    // 4: snapshot + check
    if (hasState(locations)) {
      ctx.io.write("Saving a backup of your settings…\n");
      const fromVersion = current?.version ?? legacy.autostart?.version ?? "legacy";
      const dir = newSnapshotDir(locations, fromVersion, ctx.now());
      journal.steps[4] = { snapshot: dir };
      record();
      writeSnapshot(locations, dir, fromVersion, ctx.now());
      const check = await checkSnapshot(dir);
      if (!check.ok) {
        throw new SetupError(`${check.reason}; your setup was left as it was`);
      }
    }
    inject(ctx, 4);

    // 5: wrappers, PATH block (the install-hooks entries are the user's own step, after the commit point [R217])
    ctx.io.write("Installing the rk and agentd commands…\n");
    const profiles = profileFiles(options.platformName, ctx.home, ctx.env.SHELL);
    journal.steps[5] = {
      wrappers: Object.fromEntries(wrapperFiles(ctx.home).map((file) => [file, readText(file)])),
      pathBlocks: Object.fromEntries(profiles.map((file) => [file, readBlock(file)])),
    };
    record();
    installUserWrappers(ctx.home, bundleDir);
    for (const file of profiles) writeBlock(file, renderBlock());
    // The WSL endpoint [6b-R3]: after the quiesce and the snapshot, its previous bytes journaled first.
    if (advertise) {
      const file = advertisePath(locations.stateDir);
      journal.steps[5].advertise = { file, previous: readAdvertiseBytes(file) };
      record();
      if (advertise === "clear") clearAdvertise(locations.stateDir);
      else writeAdvertise(locations.stateDir, advertise.hosts, advertise.port, ctx.now());
    }
    inject(ctx, 5);

    // 6: the CLI step (a vendor install is never undone)
    await cliStep(ctx, await resolveAll({ home: ctx.home, env: ctx.env }));
    inject(ctx, 6);

    // 7: resolve again, so a CLI step 6 just installed is found, and only now write the env [6b-R13]
    ctx.io.write("Finding Claude Code and Codex…\n");
    journal.steps[7] = { env: readText(envFilePath(ctx.home)) };
    record();
    const daemonEnv = await writeDaemonEnv({ home: ctx.home, env: ctx.env });
    warnings.push(...daemonEnv.warnings);
    for (const cli of Object.values(daemonEnv.resolved)) {
      if (cli) newManifest.clis[cli.tool] = { path: cli.path, version: cli.version, ...(cli.interpreter ? { interpreter: cli.interpreter } : {}) };
    }
    inject(ctx, 7);

    // 8: plugins, recording each CLI's registration before touching it [6b-R11]
    journal.steps[8] = { plugins: {} };
    const pluginEnv = cliRunEnv(ctx.env, newManifest.clis);
    for (const tool of TOOLS) {
      const cli = newManifest.clis[tool];
      if (!cli) continue;
      ctx.io.write(`Setting up the ${TOOL_NAMES[tool]} plugin…\n`);
      const driver = createDriver(tool, cli.path, { home: ctx.home, env: pluginEnv });
      let prior: PriorRegistration = {};
      try {
        const status = await driver.status();
        prior = {
          ...(status.marketplace ? { source: status.marketplace.source } : {}),
          ...(status.plugin?.version ? { pluginVersion: status.plugin.version } : {}),
        };
      } catch {
        // syncPlugin reports it
      }
      journal.steps[8].plugins[tool] = { cliPath: cli.path, prior, path: pluginEnv.PATH };
      record();
      const outcome = await syncPlugin(driver, path.join(bundleDir, "plugins"));
      newManifest.plugins[tool] = outcome.record;
      pluginSources[tool] = prior;
      if (outcome.result === "manual_step_required") manual.push(`${outcome.record.detail}.`);
      if (outcome.result === "failed") warnings.push(`The ${tool} plugin could not be set up (${outcome.record.detail}). Try again with: rokid-setup plugins sync --tool ${tool}`);
    }
    inject(ctx, 8);

    // 9: autostart, then prove the new agentd is the one answering
    journal.steps[9] = { started: true };
    record();
    ctx.io.write("Starting agentd…\n");
    autostart = await ctx.platform.installAutostart(newManifest);
    if (autostart === "running") {
      ctx.io.write("Checking it answers…\n");
      await verifyIdentity(ctx, newManifest);
    }
    inject(ctx, 9);
  } catch (error) {
    ctx.io.write(`Setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await recover(ctx, journal);
    return 1;
  }

  // 10: the commit point
  const retired = journal.steps[3]?.retiredLegacy;
  const snapshot = journal.steps[4]?.snapshot;
  let previous: PreviousInstall | undefined;
  if (current) {
    previous = { version: current.version, bundleDir: current.bundleDir, manifest: withoutPrevious(current) };
  } else if (retired || snapshot) {
    previous = { version: retired?.version ?? legacy.autostart?.version ?? "legacy" };
  }
  if (previous) {
    if (retired) previous.retiredLegacy = retired;
    if (Object.keys(pluginSources).length > 0) previous.pluginSources = pluginSources;
    if (snapshot) previous.snapshot = snapshot;
  }
  writeManifest(ctx.home, { ...newManifest, ...(previous ? { previous } : {}) });
  writeJournal(ctx.home, { ...journal, open: false });
  pruneSnapshots(locations, snapshot ? [snapshot] : []);

  ctx.io.write(`Rokid Coder ${version} is installed.\n`);
  ctx.io.write(autostart === "running" ? "agentd is running.\n" : "agentd starts at your next login.\n");
  const clis = TOOLS.filter((tool) => newManifest.clis[tool]);
  if (clis.length === 0) {
    ctx.io.write("Neither Claude Code nor Codex is installed; `rk claude` and `rk codex` offer to install them.\n");
  }
  for (const line of [...warnings, ...manual]) ctx.io.write(`${line}\n`);
  if (legacy.installHooks) {
    // An answers file may decline this step, never agree to it: only a person at a terminal can.
    try {
      await migrateInstallHooks(ctx.home, ctx.io, { decline: ctx.answers?.legacy?.removeInstallHooks === false });
    } catch (error) {
      ctx.io.write(`The install-hooks entries were left as they are (${error instanceof Error ? error.message : String(error)}). Run later: ${MIGRATE_HOOKS_COMMAND}\n`);
    }
  }

  // 11: pairing, after the commit point
  if (ctx.answers?.pairing === "skip" || !ctx.io.interactive) {
    ctx.io.write("Pair your phone whenever you are ready: run ~/.rokid-coder/bin/agentd pair\n");
  } else if (alreadyPaired(locations)) {
    ctx.io.write("Your phone is already paired.\n");
  } else {
    ctx.io.note("awaiting: pairing");
    await pairStep(() => ctx.runPair(bundleDir), ctx.io);
  }
  // 12
  if (!(await ctx.platform.tailscalePresent())) {
    ctx.io.write("Optional: Tailscale lets the phone reach this computer away from home: https://tailscale.com/download\n");
  }
  // Last, so it is what stays on screen: a terminal opened before setup has no rk on its PATH yet.
  const binDir = path.join(programDir(ctx.home), "bin");
  if (!(ctx.env.PATH ?? "").split(path.delimiter).includes(binDir)) {
    const shown = binDir.startsWith(ctx.home + path.sep) ? `~${binDir.slice(ctx.home.length)}` : binDir;
    ctx.io.write(`Open a new terminal tab to use rk (or run ${shown}/rk now).\n`);
  }
  return 0;
}

// ---- rollback ----

/** Puts the install recorded as `previous` back: bundle, wrappers, plugin sources, autostart, state. */
export async function rollback(ctx: SetupContext): Promise<number> {
  const open = readJournal(ctx.home);
  if (open?.open) {
    return (await recover(ctx, open)) ? 0 : 1;
  }
  const current = readManifest(ctx.home);
  const previous = current?.previous;
  if (!current || !previous || (!previous.manifest && !previous.retiredLegacy)) {
    throw new SetupError("There is no previous install to roll back to");
  }
  if (previous.manifest && (!previous.bundleDir || !existsSync(previous.bundleDir))) {
    throw new SetupError(`The previous version's files are gone (${previous.bundleDir ?? "no bundle"}); it cannot be restored`);
  }
  const locations = stateLocations(ctx.home, ctx.env);
  const profiles = profileFiles(current.platform, ctx.home, ctx.env.SHELL);
  const plan: RestorePlan = {
    stop: current,
    ports: agentdPorts(locations),
    locations,
    ourRoots: bundleRoots(current, previous),
    label: previous.manifest ? previous.version : `your ${previous.version} setup`,
    ...(previous.snapshot ? { snapshot: previous.snapshot } : {}),
  };
  if (previous.manifest) {
    plan.wrappers = Object.fromEntries(
      WRAPPER_NAMES.map((name) => [path.join(programDir(ctx.home), "bin", name), renderUserWrapper(name, previous.bundleDir!)]),
    );
    plan.pathBlocks = Object.fromEntries(profiles.map((file) => [file, renderBlock()]));
    plan.start = { manifest: previous.manifest };
  } else {
    plan.wrappers = Object.fromEntries(wrapperFiles(ctx.home).map((file) => [file, null]));
    plan.pathBlocks = Object.fromEntries(profiles.map((file) => [file, null]));
    plan.env = { content: null };
    plan.legacy = previous.retiredLegacy;
    plan.start = { legacy: previous.retiredLegacy! };
  }
  plan.plugins = {};
  const pluginPath = cliRunEnv(ctx.env, current.clis).PATH;
  for (const tool of TOOLS) {
    const cli = current.clis[tool];
    const prior = previous.pluginSources?.[tool];
    if (cli && prior) plan.plugins[tool] = { cliPath: cli.path, prior, path: pluginPath };
  }
  const problems = await runRestore(ctx, plan);
  for (const problem of problems) ctx.io.write(`  ${problem}\n`);
  if (problems.length > 0) {
    // The manifest still names this install and its previous, so running rollback again retries every restore.
    ctx.io.write(`The rollback to ${plan.label} did not finish. Fix the problems above, then run rokid-setup rollback again.\n`);
    return 1;
  }
  if (previous.manifest) {
    writeManifest(ctx.home, previous.manifest);
  } else {
    rmSync(manifestPath(ctx.home), { force: true });
  }
  ctx.io.write(`Rolled back to ${plan.label}\n`);
  return 0;
}
