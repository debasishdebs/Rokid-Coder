#!/usr/bin/env node
// The lockfile gate: every package the workspace lockfile installs from the
// registry must carry its registry URL and a sha512 integrity digest, so
// `npm ci` checks each tarball the bundle ships against the repository.
//   node lockfile.mjs [<package-lock.json>]   (default: the repo root's)
// build.mjs runs the same check before it installs anything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LOCKFILE = path.resolve(HERE, "..", "..", "..", "package-lock.json");
const REGISTRY = "https://registry.npmjs.org/";

/** One line per locked package that is not pinned to a registry tarball by digest. */
export function unhashedPackages(lock) {
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object") {
    return ["the lockfile is not an npm lockfileVersion 3 lockfile"];
  }
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    // The root and the workspaces are this repo's own sources; a link points at one of them.
    if (key === "" || !key.includes("node_modules/") || entry.link === true) continue;
    if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(REGISTRY)) {
      problems.push(`${key}@${entry.version ?? "?"} has no registry resolved URL`);
    }
    if (typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
      problems.push(`${key}@${entry.version ?? "?"} has no sha512 integrity`);
    }
  }
  return problems;
}

/** Throws, listing every unhashed package, unless the lockfile passes. */
export function assertHashedLockfile(file = DEFAULT_LOCKFILE) {
  const problems = unhashedPackages(JSON.parse(fs.readFileSync(file, "utf8")));
  if (problems.length > 0) {
    throw new Error(`${file} has unhashed registry dependencies; refusing to build:\n  ${problems.join("\n  ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    assertHashedLockfile(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_LOCKFILE);
    process.stdout.write("Every locked registry package has its resolved URL and sha512 integrity\n");
  } catch (error) {
    process.stderr.write(`lockfile.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
