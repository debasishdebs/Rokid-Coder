import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureConfig } from "../config";
import { PinStore, ensureAgentCert, readSteerSecret } from "../tls";
import { programDir, writePrivateFile } from "./manifest";

/**
 * The path inventory [6b-R5]. Every path under the two state locations is in
 * exactly one class, and snapshot and restore touch only STATE:
 *
 * - STATE: `~/.nexus-agentd/**` except `*.log`; `<rokidCoder.stateDir>/**`
 *   except `logs/`, `*.sock` and, under `~/.rokid-coder`, the PROGRAM and
 *   TRANSACTION paths
 * - PROGRAM: `bin/`, `env`, `install.json` under `~/.rokid-coder`
 * - TRANSACTION: `setup-journal.json`, `backups/` under `~/.rokid-coder`
 *
 * The new agentd uses the same two locations as 0.8.0, so an upgrade moves
 * nothing: a snapshot exists only to be put back.
 */
export type PathClass = "STATE" | "PROGRAM" | "TRANSACTION" | "OTHER";

const PROGRAM_ENTRIES = new Set(["bin", "env", "install.json"]);
const TRANSACTION_ENTRIES = new Set(["setup-journal.json", "backups"]);

export interface StateLocations {
  home: string;
  nexusDir: string;
  stateDir: string;
  programDir: string;
}

type Root = "nexus" | "state";

interface InventoryEntry {
  root: Root;
  rel: string;
  type: "file" | "dir" | "symlink";
  mode: number;
}

interface Inventory {
  schema: 1;
  fromVersion: string;
  createdAt: string;
  roots: Partial<Record<Root, string>>;
  paths: InventoryEntry[];
}

function expandHome(value: string, home: string): string {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

/** Where the state is: `rokidCoder.stateDir` from the existing config, so a custom 0.8.0 dir is honoured. */
export function stateLocations(home: string, env: NodeJS.ProcessEnv): StateLocations {
  const nexusDir = env.NEXUS_AGENTD_STATE_DIR || path.join(home, ".nexus-agentd");
  let stateDir = path.join(home, ".rokid-coder");
  try {
    const config = JSON.parse(readFileSync(path.join(nexusDir, "config.json"), "utf8")) as {
      rokidCoder?: { stateDir?: unknown };
    };
    const custom = config?.rokidCoder?.stateDir;
    if (typeof custom === "string" && custom.length > 0) {
      stateDir = path.resolve(expandHome(custom, home));
    }
  } catch {
    // No config (a fresh install) or an unreadable one: check() reports the latter.
  }
  return { home, nexusDir: path.resolve(nexusDir), stateDir, programDir: path.resolve(programDir(home)) };
}

/** The class of a path inside one of the two locations; OTHER for anything outside them. */
export function classify(locations: StateLocations, file: string): PathClass {
  const absolute = path.resolve(file);
  const inside = (root: string): string | undefined => {
    const relative = path.relative(root, absolute);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : undefined;
  };
  const programRel = inside(locations.programDir);
  if (programRel !== undefined) {
    const top = programRel.split(path.sep)[0];
    if (PROGRAM_ENTRIES.has(top)) return "PROGRAM";
    if (TRANSACTION_ENTRIES.has(top)) return "TRANSACTION";
  }
  const stateRel = inside(locations.stateDir);
  if (stateRel !== undefined) {
    if (stateRel.split(path.sep)[0] === "logs" || absolute.endsWith(".sock")) return "OTHER";
    return "STATE";
  }
  const nexusRel = inside(locations.nexusDir);
  if (nexusRel !== undefined) {
    return absolute.endsWith(".log") ? "OTHER" : "STATE";
  }
  return "OTHER";
}

function rootDirs(locations: StateLocations): Array<[Root, string]> {
  return locations.stateDir === locations.nexusDir
    ? [["nexus", locations.nexusDir]]
    : [["nexus", locations.nexusDir], ["state", locations.stateDir]];
}

/** Every STATE path under `rootDir`, parents before children. */
function walk(locations: StateLocations, root: Root, rootDir: string): InventoryEntry[] {
  const entries: InventoryEntry[] = [];
  const visit = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      if (classify(locations, file) !== "STATE") continue;
      const stat = lstatSync(file);
      const rel = path.relative(rootDir, file);
      const mode = stat.mode & 0o7777;
      if (stat.isSymbolicLink()) {
        entries.push({ root, rel, type: "symlink", mode });
      } else if (stat.isDirectory()) {
        entries.push({ root, rel, type: "dir", mode });
        visit(file);
      } else if (stat.isFile()) {
        entries.push({ root, rel, type: "file", mode });
      }
    }
  };
  visit(rootDir);
  return entries;
}

export function statePaths(locations: StateLocations): InventoryEntry[] {
  return rootDirs(locations).flatMap(([root, dir]) => walk(locations, root, dir));
}

export function hasState(locations: StateLocations): boolean {
  return statePaths(locations).length > 0;
}

function backupsDir(locations: StateLocations): string {
  const dir = path.join(locations.programDir, "backups");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function freshDir(parent: string, name: string): string {
  let dir = path.join(parent, name);
  for (let n = 1; existsSync(dir); n++) {
    dir = path.join(parent, `${name}-${n}`);
  }
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/** Names (and creates, empty) the next snapshot dir: `backups/<UTC ts>-<fromVersion>/`. */
export function newSnapshotDir(locations: StateLocations, fromVersion: string, now: Date): string {
  return freshDir(backupsDir(locations), `${stamp(now)}-${fromVersion.replace(/[^\w.+-]/g, "_")}`);
}

/**
 * Copies every STATE path into `dir` (0700 dirs, 0600 files), file to file:
 * nothing is read into memory as text, so no secret can reach a log. Run only
 * once the daemon is quiesced.
 */
export function writeSnapshot(locations: StateLocations, dir: string, fromVersion: string, now: Date): void {
  const roots = Object.fromEntries(rootDirs(locations)) as Partial<Record<Root, string>>;
  const paths = statePaths(locations);
  for (const entry of paths) {
    const source = path.join(roots[entry.root]!, entry.rel);
    const target = path.join(dir, "files", entry.root, entry.rel);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (entry.type === "dir") {
      mkdirSync(target, { recursive: true, mode: 0o700 });
    } else if (entry.type === "symlink") {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
      chmodSync(target, 0o600);
    }
  }
  const inventory: Inventory = { schema: 1, fromVersion, createdAt: now.toISOString(), roots, paths };
  writePrivateFile(path.join(dir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
}

export function readInventory(snapshotDir: string): Inventory {
  return JSON.parse(readFileSync(path.join(snapshotDir, "inventory.json"), "utf8")) as Inventory;
}

export function isCompleteSnapshot(snapshotDir: string | undefined): snapshotDir is string {
  return Boolean(snapshotDir) && existsSync(path.join(snapshotDir!, "inventory.json"));
}

export interface CheckResult {
  ok: boolean;
  pins: number;
  machineId?: string;
  /** Which loader failed; never a value from the files. */
  reason?: string;
}

/**
 * Runs the NEW code's loaders against a temp COPY of the snapshot, with
 * `rokidCoder.stateDir` re-pointed into the copy: `ensureConfig`, the
 * PinStore load (6a's v4 migration included, written back in the copy only),
 * `ensureAgentCert` and the steer read. Non-destructive by construction.
 */
export async function checkSnapshot(snapshotDir: string): Promise<CheckResult> {
  const temp = mkdtempSync(path.join(os.tmpdir(), "rokid-setup-check-"));
  let step = "the snapshot copy";
  try {
    const nexus = path.join(temp, "nexus");
    const state = path.join(temp, "state");
    for (const [root, dir] of [["nexus", nexus], ["state", state]] as const) {
      const source = path.join(snapshotDir, "files", root);
      if (existsSync(source)) {
        cpSync(source, dir, { recursive: true, verbatimSymlinks: true });
      } else {
        mkdirSync(dir, { recursive: true });
      }
    }
    step = "the agentd config";
    const configFile = path.join(nexus, "config.json");
    if (existsSync(configFile)) {
      const record = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
      const rokidCoder = record.rokidCoder && typeof record.rokidCoder === "object" ? record.rokidCoder : {};
      record.rokidCoder = { ...rokidCoder, stateDir: state };
      writeFileSync(configFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    }
    const config = ensureConfig(nexus);
    const tlsDir = path.join(config.rokidCoder.stateDir, "tls");
    step = "the phone pins";
    const pinsFile = path.join(tlsDir, "phone-pins.json");
    let pins = 0;
    if (existsSync(pinsFile)) {
      const store = new PinStore(pinsFile);
      store.expire(Date.now(), Number.MAX_SAFE_INTEGER);
      pins = store.list().length;
    }
    step = "the agentd certificate";
    await ensureAgentCert(tlsDir);
    step = "the steering secret";
    readSteerSecret(tlsDir);
    return { ok: true, pins, machineId: config.machineId };
  } catch {
    return { ok: false, pins: 0, reason: `the new version cannot read ${step}` };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function moveAside(source: string, discardRoot: string, rel: string): void {
  const target = path.join(discardRoot, rel);
  mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  renameSync(source, target);
}

/**
 * Puts the snapshot back, STATE paths only: PROGRAM and TRANSACTION paths are
 * never touched, even when the state dir is `~/.rokid-coder` itself.
 *
 * 1. A STATE path the snapshot lacks (the new version made it) moves into
 *    `backups/<ts>-discarded/`.
 * 2. Every snapshot path is replaced by rename-swap; the replaced copies are
 *    kept until all swaps succeeded, and swapped back if one fails.
 */
export function restoreSnapshot(locations: StateLocations, snapshotDir: string, now: Date): { discarded?: string } {
  const inventory = readInventory(snapshotDir);
  const known = new Set(inventory.paths.map((entry) => `${entry.root}:${entry.rel}`));
  let discardDir: string | undefined;
  const discard = (): string => (discardDir ??= freshDir(backupsDir(locations), `${stamp(now)}-discarded`));

  for (const [root, rootDir] of Object.entries(inventory.roots) as Array<[Root, string]>) {
    const nexusDir = inventory.roots.nexus ?? locations.nexusDir;
    const current = walk({ ...locations, nexusDir, stateDir: inventory.roots.state ?? nexusDir }, root, rootDir);
    const movedDirs: string[] = [];
    for (const entry of current) {
      if (known.has(`${root}:${entry.rel}`) || movedDirs.some((dir) => entry.rel.startsWith(`${dir}${path.sep}`))) continue;
      moveAside(path.join(rootDir, entry.rel), path.join(discard(), root), entry.rel);
      if (entry.type === "dir") movedDirs.push(entry.rel);
    }
  }

  const swapped: Array<{ target: string; replaced?: string }> = [];
  const suffix = `.rokid-restore-${process.pid}`;
  try {
    for (const entry of inventory.paths) {
      const target = path.join(inventory.roots[entry.root]!, entry.rel);
      if (entry.type === "dir") {
        if (!existsSync(target)) mkdirSync(target, { recursive: true });
        chmodSync(target, entry.mode);
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true });
      const staged = `${target}${suffix}`;
      const source = path.join(snapshotDir, "files", entry.root, entry.rel);
      rmSync(staged, { force: true });
      if (entry.type === "symlink") {
        symlinkSync(readlinkSync(source), staged);
      } else {
        copyFileSync(source, staged);
        chmodSync(staged, entry.mode);
      }
      let replaced: string | undefined;
      if (existsSync(target) || isDanglingLink(target)) {
        replaced = `${target}.rokid-replaced-${process.pid}`;
        renameSync(target, replaced);
      }
      swapped.push({ target, replaced });
      renameSync(staged, target);
    }
  } catch (error) {
    for (const { target, replaced } of swapped.reverse()) {
      rmSync(target, { force: true });
      if (replaced) renameSync(replaced, target);
    }
    throw error;
  }
  for (const { replaced } of swapped) {
    if (replaced) rmSync(replaced, { force: true });
  }
  return discardDir ? { discarded: discardDir } : {};
}

function isDanglingLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** After the commit point: every older snapshot goes, except those in `keep`. */
export function pruneSnapshots(locations: StateLocations, keep: string[]): void {
  const dir = path.join(locations.programDir, "backups");
  const kept = new Set(keep.map((file) => path.resolve(file)));
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const candidate = path.join(dir, name);
    if (!kept.has(candidate) && isCompleteSnapshot(candidate)) {
      rmSync(candidate, { recursive: true, force: true });
    }
  }
}
