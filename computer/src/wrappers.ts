import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The user program files in `~/.rokid-coder/bin`, one per bundle `bin/` entry. */
export const WRAPPER_NAMES = ["rokid-node", "agentd", "rk", "rokid-setup"] as const;
export type WrapperName = (typeof WRAPPER_NAMES)[number];

/** `value` as one single-quoted sh word: a quote inside is closed, escaped and reopened. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * A user wrapper: it execs the absolute, versioned bundle path, so an upgrade
 * re-points it by rewriting this file. The agentd wrapper first sources the
 * daemon's PATH from `~/.rokid-coder/env` when setup wrote one.
 */
export function renderUserWrapper(name: string, bundleDir: string): string {
  if (!(WRAPPER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown wrapper '${name}'`);
  }
  if (!path.isAbsolute(bundleDir)) {
    throw new Error(`The bundle path must be absolute: ${bundleDir}`);
  }
  const env = name === "agentd" ? 'if [ -f "$HOME/.rokid-coder/env" ]; then . "$HOME/.rokid-coder/env"; fi\n' : "";
  return `#!/bin/sh\n${env}exec ${shellQuote(path.join(bundleDir, "bin", name))} "$@"\n`;
}

/** Writes every user wrapper under `<home>/.rokid-coder/bin`, each by temp file + rename, mode 0755. */
export function installUserWrappers(home: string, bundleDir: string): string[] {
  const stateDir = path.join(home, ".rokid-coder");
  if (!existsSync(stateDir)) {
    // The same dir holds the tls keys and pins: it is created private.
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }
  const binDir = path.join(stateDir, "bin");
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  const written: string[] = [];
  for (const name of WRAPPER_NAMES) {
    const target = path.join(binDir, name);
    const temp = path.join(binDir, `.${name}.${process.pid}.tmp`);
    try {
      writeFileSync(temp, renderUserWrapper(name, bundleDir), { mode: 0o755 });
      chmodSync(temp, 0o755);
      renameSync(temp, target);
    } catch (error) {
      rmSync(temp, { force: true });
      throw error;
    }
    written.push(target);
  }
  return written;
}
