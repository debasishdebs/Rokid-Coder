import { existsSync } from "node:fs";
import path from "node:path";
import type { InstallManifest } from "../manifest";

export type PlatformName = "darwin" | "wsl";

/** The 0.8.0 autostart as found, before anything changed it. */
export interface LegacyAutostart {
  kind: "launchd" | "wsl-task";
  /** `com.anezium.nexus-agentd` or `NexusAgentd`. */
  label: string;
  /** The plist, or the exported task definition. */
  definitionPath: string;
  /** What it runs (the plist's `ProgramArguments[0]`), for telling its process apart in `portOwners`. */
  executable?: string;
  /** The version it runs, when its checkout says (the `package.json` next to its `dist/cli.js`). */
  version?: string;
  loaded: boolean;
}

/** Enough to put a retired legacy autostart back exactly. */
export interface RetiredRecord {
  kind: "launchd" | "wsl-task";
  label: string;
  originalPath: string;
  retiredPath: string;
  wasLoaded: boolean;
  executable?: string;
  version?: string;
}

export interface PortOwner {
  port: number;
  pid: number;
  exe: string;
  owner: "current" | "legacy" | "other";
}

/** The OS-specific half of setup: darwin.ts (T7b) and wsl.ts (T8), and fake.ts for tests. */
export interface PlatformHooks {
  name: PlatformName;
  legacyAutostart(): Promise<LegacyAutostart | undefined>;
  /** Stops and unregisters it, reversibly; resolves once its process has exited. */
  retireLegacyAutostart(found: LegacyAutostart): Promise<RetiredRecord>;
  /** Puts the definition back ONLY. It never starts it: recovery starts exactly one service, last [6b-R16]. */
  restoreLegacyAutostart(record: RetiredRecord): Promise<void>;
  /** Starts a restored legacy autostart (`launchctl bootstrap`, `schtasks /run`): recovery step 6, at most once. */
  startLegacyAutostart(record: RetiredRecord): Promise<void>;
  portOwners(ports: number[]): Promise<PortOwner[]>;
  /** Stops the recorded product daemon and its autostart job; resolves only after it exited and the ports are free. */
  stopCurrent(m: InstallManifest): Promise<void>;
  /** Writes and starts the autostart for `m`, REPLACING a loaded job of the same name. */
  installAutostart(m: InstallManifest): Promise<"running" | "pending_next_login">;
  /** Rewrites `~/.rokid-coder/env` (`writeDaemonEnv`), then restarts agentd. */
  refreshDaemonEnv(m: InstallManifest): Promise<void>;
  removeAutostart(m: InstallManifest): Promise<void>;
  tailscalePresent(): Promise<boolean>;
}

export interface PlatformOptions {
  home: string;
  env: NodeJS.ProcessEnv;
}

export const AUTOSTART: Record<PlatformName, InstallManifest["autostart"]> = {
  darwin: { kind: "launchd", label: "io.github.debasishdebs.rokidcoder.agentd" },
  wsl: { kind: "wsl-task", label: "\\RokidCoder\\agentd" },
};

export function isTestMode(env: NodeJS.ProcessEnv): boolean {
  return env.ROKID_SETUP_TEST === "1";
}

/**
 * The hooks for `name`. `ROKID_SETUP_PLATFORM=fake` swaps in the recording
 * fake, and only when `ROKID_SETUP_TEST=1`.
 */
export function loadPlatform(name: PlatformName, options: PlatformOptions): PlatformHooks {
  if (isTestMode(options.env) && options.env.ROKID_SETUP_PLATFORM === "fake") {
    const { FakePlatform } = require("./fake") as typeof import("./fake");
    return new FakePlatform(name, options);
  }
  // darwin.ts and wsl.ts arrive with the installers (6b T7b, T8).
  const file = path.join(__dirname, `${name}.js`);
  const loaded = (existsSync(file) ? require(file) : {}) as {
    createPlatform?: (options: PlatformOptions) => PlatformHooks;
  };
  if (typeof loaded.createPlatform !== "function") {
    throw new Error(`This build of rokid-setup has no ${name} support`);
  }
  return loaded.createPlatform(options);
}
