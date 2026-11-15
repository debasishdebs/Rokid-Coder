// scripts/check-versions.mjs: every version field of the release says the same
// version, and nothing outside docs/, vendor/, lockfiles and the named legacy
// mentions still says 0.8.0.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkVersions, versionFromTag, versionCodeOf, VERSION_FIELDS } from "../check-versions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "check-versions.mjs");

/** A tree holding every version field at `version`, as the real one lays them out. */
function fixture(t, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "check-versions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  const code = versionCodeOf(version);
  write("gradle.properties", `rokid.versionName=${version}\nrokid.versionCode=${code}\nrokid.releaseSignerSha256=\n`);
  const reads = 'versionName = providers.gradleProperty("rokid.versionName").get()\n' +
    'versionCode = providers.gradleProperty("rokid.versionCode").get().toInt()\n';
  write("mobile/app/build.gradle.kts", reads);
  write("glasses/app/build.gradle.kts", reads);
  write("computer/package.json", JSON.stringify({ name: "nexus-agentd", version }, null, 2));
  // A dependency at 0.8.0 is not ours: lockfiles are outside the stray scan.
  write("package-lock.json", JSON.stringify({ packages: { computer: { name: "nexus-agentd", version }, "node_modules/x": { version: "0.8.0" } } }));
  write("plugin/claude-code/.claude-plugin/plugin.json", JSON.stringify({ name: "rokid", version }));
  write("plugin/codex/.codex-plugin/plugin.json", JSON.stringify({ name: "rokid", version }));
  write(".claude-plugin/marketplace.json", JSON.stringify({ name: "rokid-coder", plugins: [{ name: "rokid" }] }));
  write(".agents/plugins/marketplace.json", JSON.stringify({ name: "rokid-coder", plugins: [{ name: "rokid" }] }));
  write("computer/src/codex/monitor.ts", 'const CLIENT_VERSION: string = require("../../package.json").version;\n');
  write("docs/history.md", "Upgrading from 0.8.0 is described here.\n");
  write("vendor/nexus/build.gradle.kts", 'versionName = "0.8.0"\n');
  return { dir, write };
}

const filesOf = (dir) => {
  const out = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(path.join(dir, at), { withFileTypes: true })) {
      const rel = at ? `${at}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else out.push(rel);
    }
  };
  walk("");
  return out;
};

test("every_version_field_is_1_0_0: the real tree passes", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--expect", "1.0.0"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const field of VERSION_FIELDS) assert.ok(result.stdout.includes(field.label), `lists ${field.label}`);
  assert.match(result.stdout, /rokid\.versionCode.*10000/);
});

test("every_version_field_is_1_0_0: a stray 0.8.0 fails, naming the file", (t) => {
  const { dir, write } = fixture(t, "1.0.0");
  assert.deepEqual(checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) }).problems, []);

  write("computer/src/banner.ts", 'export const BANNER = "Rokid Coder 0.8.0";\n');
  const { problems } = checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) });
  assert.deepEqual(problems, ["computer/src/banner.ts still says 0.8.0"]);
});

test("every_version_field_is_1_0_0: each field that differs is named", (t) => {
  const { dir, write } = fixture(t, "1.0.0");
  write("plugin/codex/.codex-plugin/plugin.json", JSON.stringify({ name: "rokid", version: "1.0.1" }));
  write(".claude-plugin/marketplace.json", JSON.stringify({ name: "rokid-coder", plugins: [{ name: "rokid", version: "0.9.0" }] }));
  write("gradle.properties", "rokid.versionName=1.0.0\nrokid.versionCode=800\n");
  write("glasses/app/build.gradle.kts", 'versionName = "1.0.0"\n');
  write("computer/src/codex/monitor.ts", 'const CLIENT_VERSION = "1.0.0";\n');
  const { problems } = checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) });
  const named = problems.join("\n");
  assert.match(named, /plugin\/codex\/\.codex-plugin\/plugin\.json version is 1\.0\.1/);
  assert.match(named, /\.claude-plugin\/marketplace\.json plugins\[0\]\.version is 0\.9\.0/);
  assert.match(named, /rokid\.versionCode is 800, expected 10000/);
  assert.match(named, /glasses\/app\/build\.gradle\.kts does not read rokid\.versionName/);
  assert.match(named, /CLIENT_VERSION/);
});

test("every_version_field_is_1_0_0: the marketplace files carry no version, and that is fine", (t) => {
  const { dir } = fixture(t, "1.0.0");
  const { fields } = checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) });
  const market = fields.filter((field) => field.label.includes("marketplace"));
  assert.equal(market.length, 2);
  for (const field of market) assert.equal(field.value, "(no version)");
});

test("every_version_field_is_1_0_0: each workflow pins CxrGlobal by one CXRGLOBAL_SHA", (t) => {
  const { dir, write } = fixture(t, "1.0.0");
  const workflow = (sha, ref) =>
    `env:\n  CXRGLOBAL_SHA: ${sha}\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v6\n        with:\n          repository: Anezium/CxrGlobal\n          ref: ${ref}\n`;
  write(".github/workflows/good.yml", workflow("395be12ef69cf7d46d67c526168b78392a0b5484", "${{ env.CXRGLOBAL_SHA }}"));
  assert.deepEqual(checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) }).problems, []);

  write(".github/workflows/tag.yml", workflow("395be12ef69cf7d46d67c526168b78392a0b5484", "v0.3.0"));
  write(".github/workflows/other.yml", workflow("1111111111111111111111111111111111111111", "${{ env.CXRGLOBAL_SHA }}"));
  const named = checkVersions({ root: dir, expect: "1.0.0", files: filesOf(dir) }).problems.join("\n");
  assert.match(named, /tag\.yml checks out CxrGlobal at v0\.3\.0, not \$\{\{ env\.CXRGLOBAL_SHA \}\}/);
  assert.match(named, /other\.yml CXRGLOBAL_SHA is 1111111111111111111111111111111111111111/);
});

test("rc_tag_expects_plain_version_and_final_tag_is_refused", () => {
  assert.equal(versionFromTag("rokid-coder-v1.0.0-rc.3"), "1.0.0");
  assert.equal(versionFromTag("rokid-coder-v1.0.0-rc.12"), "1.0.0");
  assert.throws(() => versionFromTag("rokid-coder-v1.0.0"), /Final releases are created by publish-release from a tested rc/);
  for (const bad of ["rokid-coder-v1.0", "rokid-coder-v1.0.0-rc", "rokid-coder-v1.0.0-rc.x", "v1.0.0-rc.1", "rokid-coder-v1.0.0-beta.1"]) {
    assert.throws(() => versionFromTag(bad), /not a release tag/, bad);
  }

  const final = spawnSync(process.execPath, [SCRIPT, "--tag", "rokid-coder-v1.0.0"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(final.status, 1);
  assert.match(final.stderr, /Final releases are created by publish-release from a tested rc/);
  const rc = spawnSync(process.execPath, [SCRIPT, "--tag", "rokid-coder-v1.0.0-rc.3"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(rc.status, 0, rc.stderr);
  assert.equal(rc.stdout, "version=1.0.0\n");
});

test("versionCode is major * 10000 + minor * 100 + patch", () => {
  assert.equal(versionCodeOf("1.0.0"), 10000);
  assert.equal(versionCodeOf("1.2.3"), 10203);
  assert.throws(() => versionCodeOf("1.100.0"));
});
