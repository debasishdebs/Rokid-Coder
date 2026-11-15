import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RetiredRecord } from "./platform/index";

export type Tool = "claude" | "codex";
export const TOOLS: readonly Tool[] = ["claude", "codex"];

export interface CliRecord {
  path: string;
  version: string;
  /** The interpreter its `#!` line names, as resolved at install: its plugin commands run with it on PATH. */
  interpreter?: string;
}

/** A CLI's registration of our plugin, as the CLI itself reported it. */
export interface PluginRecord {
  /** The `rokid-coder` marketplace's source dir. */
  source: string;
  pluginVersion?: string;
  status: "ok" | "manual_step_required" | "failed";
  /** The in-CLI step to finish by hand, or why it failed. */
  detail?: string;
}

/** What a CLI had registered before setup re-pointed it [6b-R11]. No `source`: no `rokid-coder` marketplace at all. */
export interface PriorRegistration {
  source?: string;
  pluginVersion?: string;
}

export interface PathPair {
  win: string;
  linux: string;
}

export interface BindingRecord {
  contents: Record<string, unknown>;
  bindingPath: PathPair;
  taskXmlPath: PathPair;
}

export interface PreviousInstall {
  version: string;
  /** Absent when the previous install was a 0.8.0 checkout, not a bundle. */
  bundleDir?: string;
  manifest?: InstallManifest;
  retiredLegacy?: RetiredRecord;
  pluginSources?: Partial<Record<Tool, PriorRegistration>>;
  snapshot?: string;
}

/** `~/.rokid-coder/install.json`, schema 1. Written last: the commit point of an install or upgrade. */
export interface InstallManifest {
  schema: 1;
  version: string;
  platform: "darwin" | "wsl";
  bundleDir: string;
  installedAt: string;
  clis: Partial<Record<Tool, CliRecord>>;
  plugins: Partial<Record<Tool, PluginRecord>>;
  autostart: { kind: "launchd" | "wsl-task"; label: string };
  binding?: BindingRecord;
  previous?: PreviousInstall;
}

/** `~/.rokid-coder`: the user program files and setup's own transaction files, whatever the state dir is. */
export function programDir(home: string): string {
  return path.join(home, ".rokid-coder");
}

export function manifestPath(home: string): string {
  return path.join(programDir(home), "install.json");
}

/** Temp file + rename, mode 0600 unless told otherwise. */
export function writePrivateFile(file: string, content: string, mode = 0o600): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, { mode });
    chmodSync(temp, mode);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function readManifest(home: string): InstallManifest | undefined {
  const file = manifestPath(home);
  if (!existsSync(file)) {
    return undefined;
  }
  const value = JSON.parse(readFileSync(file, "utf8")) as InstallManifest;
  if (!value || value.schema !== 1 || typeof value.version !== "string" || typeof value.bundleDir !== "string") {
    throw new Error(`${file} is not a Rokid Coder install manifest`);
  }
  return value;
}

export function writeManifest(home: string, manifest: InstallManifest): void {
  writePrivateFile(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** The manifest as `previous.manifest` keeps it: one level of history, not a chain. */
export function withoutPrevious(manifest: InstallManifest): InstallManifest {
  const { previous: _previous, ...rest } = manifest;
  return rest;
}

/** The bundle's own version, from `bundle.json` (T7a), falling back to its app's `package.json`. */
export function bundleVersion(bundleDir: string): string {
  for (const file of [path.join(bundleDir, "bundle.json"), path.join(bundleDir, "app", "package.json")]) {
    if (existsSync(file)) {
      const { version } = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
      if (typeof version === "string" && version.length > 0) {
        return version;
      }
    }
  }
  throw new Error(`${bundleDir} is not a Rokid Coder bundle (no bundle.json)`);
}
