import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

// Nothing here reads or writes a state dir: `agentd --version` and /health use
// it, and the version must print even when the config is corrupt.

/** The package dir: dist/version.js sits one level below it, in the repo and in a bundle's app/. */
export const APP_ROOT = path.join(__dirname, "..");

export function agentdVersion(): string {
  const manifest = JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/**
 * The bundle a node binary belongs to: the real directory holding
 * `node/bin/node` when a `bundle.json` sits there, otherwise null (a repo
 * build or a system Node).
 */
export function bundleRootFor(execPath: string): string | null {
  try {
    const root = path.resolve(realpathSync(execPath), "..", "..", "..");
    return existsSync(path.join(root, "bundle.json")) ? root : null;
  } catch {
    return null;
  }
}

export interface VersionInfo {
  agentd: string;
  node: string;
  platform: string;
  arch: string;
  execPath: string;
  bundleRoot: string | null;
}

export function realExecPath(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

export function versionInfo(): VersionInfo {
  return {
    agentd: agentdVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    execPath: realExecPath(),
    bundleRoot: bundleRootFor(process.execPath),
  };
}

/** Which program answers on /health, so setup can prove the new bundle is the one running [6b-R4]. */
export function healthIdentity(): { agentdVersion: string; execPath: string; bundleRoot: string | null } {
  const info = versionInfo();
  return { agentdVersion: info.agentd, execPath: info.execPath, bundleRoot: info.bundleRoot };
}

export function versionText(info: VersionInfo): string {
  return `agentd ${info.agentd} node ${info.node} ${info.platform}-${info.arch}\n`;
}
