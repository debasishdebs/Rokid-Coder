// scripts/check-test-results.mjs: tests.yml's android job passes only when
// every JUnit result passes, except the 2 known GlassesFileStoreTest failures.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { checkResults, ALLOWED_FAILURES } from "../check-test-results.mjs";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "check-test-results.mjs");
const STORE = "com.anezium.rokidbus.glasses.GlassesFileStoreTest";

const xml = (cases) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="s" tests="${cases.length}">\n` +
  cases.map(([classname, name, outcome]) => {
    const attrs = `name="${name.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")}" classname="${classname}" time="0.1"`;
    if (outcome === "failure") return `  <testcase ${attrs}>\n    <failure message="boom" type="AssertionError">trace</failure>\n  </testcase>`;
    if (outcome === "error") return `  <testcase ${attrs}>\n    <error message="boom">trace</error>\n  </testcase>`;
    if (outcome === "skipped") return `  <testcase ${attrs}>\n    <skipped/>\n  </testcase>`;
    return `  <testcase ${attrs}/>`;
  }).join("\n") + "\n</testsuite>\n";

function results(t, modules) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-results-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return Object.entries(modules).map(([module, cases]) => {
    const out = path.join(dir, module);
    fs.mkdirSync(out, { recursive: true });
    if (cases) fs.writeFileSync(path.join(out, "TEST-x.xml"), xml(cases));
    return out;
  });
}

test("only the two named GlassesFileStoreTest failures are allowed", (t) => {
  assert.equal(ALLOWED_FAILURES.length, 2);
  for (const id of ALLOWED_FAILURES) assert.ok(id.startsWith(`${STORE}#`), id);
  const [first, second] = ALLOWED_FAILURES.map((id) => id.slice(STORE.length + 1));

  const known = results(t, {
    core: [[STORE, first, "failure"], [STORE, second, "error"], [STORE, "an upload is staged, verified and renamed into place", "pass"]],
    app: [["com.anezium.rokidbus.plugin.agents.AgentsCoreTest", "it's fine & \"quoted\"", "pass"]],
  });
  assert.deepEqual(checkResults(known).problems, []);

  const other = results(t, { core: [[STORE, first, "failure"], [STORE, "aborting an upload removes its staging file", "failure"]] });
  assert.deepEqual(checkResults(other).problems, [`${STORE}#aborting an upload removes its staging file failed`]);

  const elsewhere = results(t, { app: [["com.example.OtherTest", first, "failure"]] });
  assert.equal(checkResults(elsewhere).problems.length, 1, "the allowance is by class and name");
});

test("a module that wrote no results fails, as a compile failure would", (t) => {
  const dirs = results(t, { core: [[STORE, "ok", "pass"]], app: null });
  assert.match(checkResults(dirs).problems.join("\n"), /app.* has no JUnit results/);
  const missing = checkResults([path.join(os.tmpdir(), "does-not-exist-results")]);
  assert.match(missing.problems.join("\n"), /has no JUnit results/);
});

test("the CLI exits 1 and names the failure", (t) => {
  const dirs = results(t, { core: [["com.example.ATest", "breaks", "failure"]] });
  const result = spawnSync(process.execPath, [SCRIPT, ...dirs], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /com\.example\.ATest#breaks failed/);
  const clean = spawnSync(process.execPath, [SCRIPT, ...results(t, { core: [["com.example.ATest", "holds", "pass"]] })], { encoding: "utf8" });
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /1 tests, 0 failed/);
});
