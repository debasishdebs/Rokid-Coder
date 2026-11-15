// Tests for scripts/check-docs-secrets.mjs: the docs and install guides must carry no
// secret, no full certificate fingerprint and no real pairing line. The fixtures are
// built at run time from obviously fake pieces, so this file itself stays clean.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scanText, scanFiles, defaultTargets } from "../check-docs-secrets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const script = path.join(root, "scripts", "check-docs-secrets.mjs");

const hex64 = "ab".repeat(32);
const colon = Array.from({ length: 32 }, () => "AB").join(":");
const rules = (text) => scanText(text, "doc.md").map((f) => f.rule);

test("flags_a_64_hex_run", () => {
  assert.deepEqual(rules(`fingerprint ${hex64}`), ["hex64"]);
  assert.deepEqual(rules(`sha256: ${hex64.toUpperCase()}.`), ["hex64"]);
});

test("flags_a_32_pair_colon_hex_run", () => {
  assert.deepEqual(rules(`fp ${colon}`), ["colon-fingerprint"]);
});

test("flags_token_and_steer_values_but_not_placeholders", () => {
  assert.deepEqual(rules(`{"token": "s3cr3t-value-123"}`), ["secret-value"]);
  assert.deepEqual(rules(`{"steer":"s3cr3t-value-123"}`), ["secret-value"]);
  assert.deepEqual(rules(`"token": ""`), []);
  assert.deepEqual(rules(`"token": "<token>"`), []);
  assert.deepEqual(rules(`"steer": "…"`), []);
  assert.deepEqual(rules("The pairing token and the steer secret never appear in output."), []);
});

test("flags_pairing_lines_with_real_looking_hosts", () => {
  const v2 = `{"v":2,"kind":"rokid-coder","host":"192.168.1.20","port":8792,"fp":"<fp>"}`;
  assert.deepEqual(rules(v2), ["pairing-line"]);
  const v1 = `{"v":1,"host":"100.101.102.103","port":8792}`;
  assert.deepEqual(rules(v1), ["pairing-line"]);
  const named = `{"v":2,"host":"my-laptop.tailnet-1234.ts.net","port":8792}`;
  assert.deepEqual(rules(named), ["pairing-line"]);
});

test("allows_pairing_lines_with_placeholder_or_documentation_hosts", () => {
  assert.deepEqual(rules(`{"v":2,"kind":"rokid-coder","host":"<host>","port":8792,"fp":"<fp>"}`), []);
  assert.deepEqual(rules(`{"v":2,"host":"203.0.113.7","port":8792}`), []);
  assert.deepEqual(rules(`{"v":2,"host":"laptop.example.com","port":8792}`), []);
});

test("does_not_flag_git_shas_or_short_hex", () => {
  assert.deepEqual(rules("commit bd04033f and 15cd98ad4f4b8f49c1d2e3a4b5c6d7e8f9a0b1c2"), []);
  assert.deepEqual(rules(`${"ab".repeat(31)} is 62 hex digits`), []);
});

test("reports_file_and_line_and_never_the_value", () => {
  const [finding] = scanText(`one\ntwo ${hex64}\n`, "x.md");
  assert.equal(finding.file, "x.md");
  assert.equal(finding.line, 2);
  assert.ok(!JSON.stringify(finding).includes(hex64), "a finding must not repeat the secret");
});

test("cli_exits_1_without_echoing_the_secret_and_0_when_clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "docs-secrets-"));
  try {
    const dirty = path.join(dir, "dirty.md");
    const clean = path.join(dir, "clean.md");
    fs.writeFileSync(dirty, `fp ${hex64}\n`);
    fs.writeFileSync(clean, "nothing here\n");
    const bad = spawnSync("node", [script, dirty], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.ok(!(bad.stdout + bad.stderr).includes(hex64));
    assert.match(bad.stderr, /hex64/);
    const good = spawnSync("node", [script, clean], { encoding: "utf8" });
    assert.equal(good.status, 0, good.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("default_targets_cover_the_files_task_11_owns_and_the_design_docs", () => {
  const rel = defaultTargets(root).map((p) => path.relative(root, p).split(path.sep).join("/"));
  for (const expected of [
    "PRIVACY.md",
    "README.md",
    "computer/README.md",
    "plugin/README.md",
    "mobile/README.md",
    "glasses/README.md",
    "mobile/app/src/main/res/values/strings_about.xml",
    "docs/coding-agent/claude/plan/2026-11-15-v1-device-checklist.md",
    "docs/coding-agent/releases/1.0.0.md",
  ]) {
    assert.ok(rel.includes(expected), `${expected} is scanned`);
  }
  assert.ok(rel.some((p) => p.startsWith("docs/coding-agent/claude/plan/")), "docs/coding-agent/** is scanned");
  assert.ok(!rel.includes("gradle.properties"), "gradle.properties holds a public certificate digest and is not scanned");
});

test("docs_contain_no_secrets_or_full_fingerprints", () => {
  const findings = scanFiles(defaultTargets(root), root);
  assert.deepEqual(
    findings.map((f) => `${f.file}:${f.line} ${f.rule}`),
    [],
  );
});
