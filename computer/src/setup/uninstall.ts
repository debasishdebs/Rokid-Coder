import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import path from "node:path";
import { WRAPPER_NAMES } from "../wrappers";
import { TOOLS, manifestPath, programDir, readManifest } from "./manifest";
import type { SetupContext } from "./orchestrator";
import { SetupError } from "./orchestrator";
import { createDriver, isUnder, removePlugin } from "./plugins";
import { profileFiles, writeBlock } from "./profile-path";
import { cliRunEnv, envFilePath } from "./resolve-cli";
import { stateLocations } from "./state";

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // not there, or not empty
  }
}

/**
 * The per-user removal [FR 15]: the service, the plugins (while their bundle
 * still exists), the program files and, on WSL, the bundles. State is kept,
 * unless `purge`, which needs a typed `purge` or `--yes`.
 */
export async function uninstall(ctx: SetupContext, options: { purge: boolean; yes: boolean }): Promise<number> {
  const locations = stateLocations(ctx.home, ctx.env);
  if (options.purge && !options.yes) {
    if (!ctx.io.interactive) {
      throw new SetupError("--purge deletes your pairings and settings: confirm with --yes, or run it in a terminal");
    }
    ctx.io.write(`This also deletes ${locations.nexusDir}, ${locations.stateDir} and the backups. Type purge to confirm: `);
    if ((await ctx.io.readLine())?.trim() !== "purge") {
      ctx.io.write("Nothing was removed.\n");
      return 1;
    }
  }
  const manifest = readManifest(ctx.home);
  // 1
  if (manifest) {
    await ctx.platform.stopCurrent(manifest);
    await ctx.platform.removeAutostart(manifest);
  }
  // 2
  const roots = [manifest?.bundleDir, manifest?.previous?.bundleDir]
    .filter((dir): dir is string => Boolean(dir))
    .flatMap((dir) => [dir, path.dirname(dir)]);
  const pluginEnv = cliRunEnv(ctx.env, manifest?.clis ?? {});
  for (const tool of TOOLS) {
    const cli = manifest?.clis[tool];
    if (!cli) continue;
    try {
      await removePlugin(createDriver(tool, cli.path, { home: ctx.home, env: pluginEnv }), roots);
    } catch (error) {
      ctx.io.write(`The ${tool} plugin could not be removed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  // 3
  const bin = path.join(programDir(ctx.home), "bin");
  for (const name of WRAPPER_NAMES) rmSync(path.join(bin, name), { force: true });
  removeIfEmpty(bin);
  for (const file of profileFiles(manifest?.platform ?? ctx.platform.name, ctx.home, ctx.env.SHELL)) writeBlock(file, null);
  rmSync(envFilePath(ctx.home), { force: true });
  rmSync(manifestPath(ctx.home), { force: true });
  // 4: on macOS the system dir is the package's to remove (T7b's uninstall.sh --system)
  if (manifest?.platform === "wsl") {
    const share = path.join(ctx.home, ".local", "share", "rokid-coder");
    for (const dir of [manifest.bundleDir, manifest.previous?.bundleDir]) {
      if (dir && existsSync(dir) && isUnder(dir, share)) rmSync(dir, { recursive: true, force: true });
    }
    removeIfEmpty(share);
  }
  // 5
  if (options.purge) {
    for (const dir of [locations.nexusDir, locations.stateDir, path.join(programDir(ctx.home), "backups")]) {
      rmSync(dir, { recursive: true, force: true });
    }
    rmSync(path.join(programDir(ctx.home), "setup-journal.json"), { force: true });
    removeIfEmpty(programDir(ctx.home));
    ctx.io.write("Rokid Coder and its state were removed.\n");
  } else {
    ctx.io.write(
      `Rokid Coder was removed. Your pairings and settings were kept in ${locations.nexusDir} and ${locations.stateDir}; ` +
        "delete them with: rokid-setup uninstall --purge\n",
    );
  }
  return 0;
}
