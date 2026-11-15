#!/usr/bin/env node
// Every version field of a Rokid Coder release, checked against one version.
//
//   node scripts/check-versions.mjs --expect <version> [--root <dir>]
//   node scripts/check-versions.mjs --tag <tag>      prints version=<v> for an rc tag
//
// --expect lists each field and fails on any that differs. It also fails if a
// tracked file outside docs/, vendor/, lockfiles and LEGACY_MENTIONS still
// says 0.8.0, so a field it does not list cannot slip through; and if a
// workflow checks CxrGlobal out at anything but its one pinned CXRGLOBAL_SHA.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** CxrGlobal v0.3.0, by SHA: every workflow's CXRGLOBAL_SHA. */
export const CXRGLOBAL_SHA = "395be12ef69cf7d46d67c526168b78392a0b5484";

const PREVIOUS = "0.8.0";

/**
 * Files that name 0.8.0 as the release a 1.0 install upgrades from (its LaunchAgent, its state,
 * its checkout), never as their own version.
 */
export const LEGACY_MENTIONS = [
  ".github/workflows/macos-installer.yml",
  "computer/README.md",
  "computer/installer/macos/test/ci/state-check.js",
  "computer/installer/macos/test/state-check.test.js",
  "computer/installer/windows/lib/RokidCoder.psm1",
  "computer/src/setup/legacy.ts",
  "computer/src/setup/manifest.ts",
  "computer/src/setup/platform/darwin.ts",
  "computer/src/setup/platform/index.ts",
  "computer/src/setup/platform/wsl.ts",
  "computer/src/setup/resolve-cli.ts",
  "computer/src/setup/state.ts",
  "computer/test/fixtures/plugin-cli/harness.js",
  "computer/test/setup-install.test.js",
  "computer/test/setup-legacy-hooks.test.js",
  "computer/test/setup-platform-darwin.test.js",
  "computer/test/setup-platform-wsl.test.js",
  "computer/test/setup-plugins.test.js",
  "computer/test/setup-state.test.js",
  "mobile/app/CHANGELOG.md",
  "scripts/check-versions.mjs",
  "scripts/test/publish.test.mjs",
  "scripts/test/versions.test.mjs",
  "scripts/test/workflows.test.mjs",
];

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|gradle\.lockfile)$/;

/** major * 10000 + minor * 100 + patch: the Android versionCode, and what the phone reads a glasses version as (R205). */
export function versionCodeOf(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[2]) > 99 || Number(match[3]) > 99) throw new Error(`${version} is not major.minor.patch with minor and patch below 100`);
  return Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
}

/** rokid-coder-v<v>-rc.<n> → <v>. A tag without -rc.<n> is a final tag, which only publish-release makes. */
export function versionFromTag(tag) {
  const match = /^rokid-coder-v(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/.exec(tag);
  if (!match) throw new Error(`${tag} is not a release tag (rokid-coder-v<major.minor.patch>-rc.<n>)`);
  if (match[2] === undefined) throw new Error(`${tag}: Final releases are created by publish-release from a tested rc`);
  return match[1];
}

const readJson = (root, file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const readText = (root, file) => fs.readFileSync(path.join(root, file), "utf8");

function gradleProperty(root, key) {
  const line = readText(root, "gradle.properties").split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

/** Every `version` key anywhere in a JSON value, with its path. */
function versionKeys(value, at = "") {
  if (Array.isArray(value)) return value.flatMap((item, i) => versionKeys(item, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => {
    const here = at ? `${at}.${key}` : key;
    return key === "version" && typeof item === "string" ? [{ at: here, value: item }] : versionKeys(item, here);
  });
}

/** Each field: what it is, how to read it, and what it must be for `expect`. */
export const VERSION_FIELDS = [
  { label: "gradle.properties rokid.versionName", read: (root) => gradleProperty(root, "rokid.versionName") },
  { label: "gradle.properties rokid.versionCode", read: (root) => gradleProperty(root, "rokid.versionCode"), expected: (v) => String(versionCodeOf(v)) },
  ...["mobile/app/build.gradle.kts", "glasses/app/build.gradle.kts"].map((file) => ({
    label: `${file} versionName and versionCode`,
    reads: file,
    check: (root) => {
      const text = readText(root, file);
      const problems = [];
      for (const key of ["rokid.versionName", "rokid.versionCode"]) if (!text.includes(`"${key}"`)) problems.push(`${file} does not read ${key}`);
      if (/version(Name|Code)\s*=\s*("|\d)/.test(text)) problems.push(`${file} sets a version literal`);
      return { value: problems.length ? "(literal)" : "reads gradle.properties", problems };
    },
  })),
  { label: "computer/package.json version (the bundle, .pkg/.dmg and .exe version 6b's installers stamp)", read: (root) => readJson(root, "computer/package.json").version },
  { label: "package-lock.json packages.computer.version", read: (root) => readJson(root, "package-lock.json").packages?.computer?.version },
  { label: "plugin/claude-code/.claude-plugin/plugin.json version", read: (root) => readJson(root, "plugin/claude-code/.claude-plugin/plugin.json").version },
  { label: "plugin/codex/.codex-plugin/plugin.json version", read: (root) => readJson(root, "plugin/codex/.codex-plugin/plugin.json").version },
  ...[".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"].map((file) => ({
    label: `${file} (a marketplace: no version, or the release's)`,
    check: (root, expect) => {
      const found = versionKeys(readJson(root, file));
      const problems = found.filter((entry) => entry.value !== expect).map((entry) => `${file} ${entry.at} is ${entry.value}, expected ${expect}`);
      return { value: found.length ? found.map((entry) => `${entry.at}=${entry.value}`).join(", ") : "(no version)", problems };
    },
  })),
  {
    label: "computer/src/codex/monitor.ts CLIENT_VERSION",
    check: (root) => {
      const line = readText(root, "computer/src/codex/monitor.ts").split("\n").find((entry) => /\bCLIENT_VERSION\b.*=/.test(entry)) ?? "";
      // agentdVersion() is computer/src/version.ts's reader of computer/package.json.
      const ok = /package\.json|agentdVersion\(\)/.test(line) && !/CLIENT_VERSION\s*(:\s*\w+\s*)?=\s*["'`]/.test(line);
      return { value: ok ? "reads computer/package.json" : line.trim() || "(missing)", problems: ok ? [] : ["computer/src/codex/monitor.ts CLIENT_VERSION does not read computer/package.json"] };
    },
  },
];

/** Workflows that check CxrGlobal out: by `${{ env.CXRGLOBAL_SHA }}`, set once to CXRGLOBAL_SHA. */
function checkCxrGlobal(root, files) {
  const problems = [];
  for (const file of files.filter((entry) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry))) {
    const text = readText(root, file);
    if (!/repository:\s*Anezium\/CxrGlobal/.test(text)) continue;
    const name = path.basename(file);
    const pins = [...text.matchAll(/^\s*CXRGLOBAL_SHA:\s*["']?([^"'\s]+)/gm)].map((match) => match[1]);
    if (pins.length !== 1) problems.push(`${name} sets CXRGLOBAL_SHA ${pins.length} times`);
    for (const pin of pins) if (pin !== CXRGLOBAL_SHA) problems.push(`${name} CXRGLOBAL_SHA is ${pin}, expected ${CXRGLOBAL_SHA}`);
    const lines = text.split("\n");
    lines.forEach((line, at) => {
      if (!/repository:\s*Anezium\/CxrGlobal/.test(line)) return;
      const level = line.length - line.trimStart().length;
      const siblings = [];
      for (const other of [...lines.slice(Math.max(0, at - 3), at).reverse(), ...lines.slice(at + 1, at + 4)]) {
        if (other.length - other.trimStart().length === level) siblings.push(other.trim());
      }
      const ref = siblings.find((entry) => entry.startsWith("ref:"))?.replace(/^ref:\s*/, "").replace(/^["']|["']$/g, "");
      if (ref !== "${{ env.CXRGLOBAL_SHA }}") problems.push(`${name} checks out CxrGlobal at ${ref ?? "its default branch"}, not \${{ env.CXRGLOBAL_SHA }}`);
    });
  }
  return problems;
}

function strays(root, files) {
  const allowed = new Set(LEGACY_MENTIONS);
  return files
    .filter((file) => !file.startsWith("docs/") && !file.startsWith("vendor/") && !LOCKFILE.test(file) && !allowed.has(file))
    .filter((file) => {
      const full = path.join(root, file);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
      const bytes = fs.readFileSync(full);
      return !bytes.includes(0) && bytes.toString("utf8").includes(PREVIOUS);
    })
    .map((file) => `${file} still says ${PREVIOUS}`);
}

const trackedFiles = (root) => execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);

export function checkVersions({ root, expect, files = trackedFiles(root) }) {
  versionCodeOf(expect);
  const fields = [];
  const problems = [];
  for (const field of VERSION_FIELDS) {
    if (field.check) {
      const result = field.check(root, expect);
      fields.push({ label: field.label, value: result.value });
      problems.push(...result.problems);
      continue;
    }
    const value = field.read(root);
    const expected = field.expected ? field.expected(expect) : expect;
    fields.push({ label: field.label, value: value ?? "(missing)" });
    if (value !== expected) problems.push(`${field.label.split(" (")[0]} is ${value ?? "missing"}, expected ${expected}`);
  }
  problems.push(...checkCxrGlobal(root, files), ...strays(root, files));
  return { fields, problems };
}

function main(argv) {
  const option = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const tag = option("--tag");
  if (tag !== undefined) {
    process.stdout.write(`version=${versionFromTag(tag)}\n`);
    return 0;
  }
  const expect = option("--expect");
  if (!expect) {
    process.stderr.write("usage: check-versions.mjs --expect <version> [--root <dir>] | --tag <tag>\n");
    return 2;
  }
  const root = path.resolve(option("--root") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
  const { fields, problems } = checkVersions({ root, expect });
  for (const field of fields) process.stdout.write(`${field.label}: ${field.value}\n`);
  if (problems.length) {
    for (const problem of problems) process.stderr.write(`check-versions: ${problem}\n`);
    return 1;
  }
  process.stdout.write(`check-versions: every field is ${expect}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`check-versions: ${error.message}\n`);
    process.exitCode = 1;
  }
}
