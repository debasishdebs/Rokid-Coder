// upstream-sync.yml's two scripts: the real scripts/upstream-sync.sh against
// 6a's temp-repo fixture (a synthetic upstream and a product vendoring it with
// one recorded patch), and scripts/upstream-sync-decide.mjs mapping the
// outcome to exactly one action, with the fake gh in fixtures/bin.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { syncOutcome, decide, parseShas } from "../upstream-sync-decide.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC = path.resolve(HERE, "..", "upstream-sync.sh");
const DECIDE = path.resolve(HERE, "..", "upstream-sync-decide.mjs");
const FAKE_BIN = path.join(HERE, "fixtures", "bin");
const REPO = "debasishdebs/Rokid-Coder";
const BRANCH = "upstream-sync/2026-11-16";

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-ci-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Sync Test",
    GIT_AUTHOR_EMAIL: "sync@example.invalid",
    GIT_COMMITTER_NAME: "Sync Test",
    GIT_COMMITTER_EMAIL: "sync@example.invalid",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  const upstream = path.join(dir, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  write(path.join(upstream, "hub", "Auth.kt"), "val handshake = \"upstream\"\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-q", "-m", "Upstream base");

  const product = path.join(dir, "product");
  fs.mkdirSync(product);
  git(product, "init", "-q", "-b", "main");
  write(path.join(product, "README.md"), "product\n");
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "Start the product");
  git(product, "subtree", "add", "-q", "--prefix=vendor/nexus", upstream, "main", "--squash");
  write(path.join(product, "vendor", "nexus", "hub", "Auth.kt"), "val handshake = \"ours\"\n");
  git(product, "commit", "-q", "-am", "Patch the vendored handshake");
  const patchSha = git(product, "rev-parse", "--short", "HEAD");
  write(
    path.join(product, "vendor", "nexus", "PATCHES.md"),
    `# Patches\n\n| SHA | Files | Purpose | Must-not-touch? |\n|---|---|---|---|\n| ${patchSha} | \`hub/Auth.kt\` | Our handshake | yes |\n`,
  );
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "Record the vendored patch");

  const sync = (...args) => spawnSync("bash", [SYNC, ...args], { cwd: product, env, encoding: "utf8" });
  /** The script run as the workflow's sync step runs it, through the same outcome parser. */
  const syncAsWorkflow = (...args) => {
    const result = sync(...args);
    return { result, outcome: syncOutcome({ code: result.status, log: result.stdout + result.stderr }) };
  };
  const upstreamCommit = (file, text, message) => {
    write(path.join(upstream, file), text);
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", message);
  };
  return { dir, upstream, product, patchSha, git, sync, syncAsWorkflow, upstreamCommit };
}

/** Runs the report step: decide.mjs with the needs' outputs in its env, and the fake gh. */
function report(t, inputs, world = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-report-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "gh.log");
  const worldFile = path.join(dir, "world.json");
  fs.writeFileSync(log, "");
  fs.writeFileSync(worldFile, JSON.stringify({
    responses: [
      { args: ["issue", "list"], stdout: JSON.stringify(world.issues ?? []) },
      { args: ["pr", "list"], stdout: JSON.stringify(world.prs ?? []) },
      { args: ["issue", "create"], stdout: `https://example.invalid/${REPO}/issues/12\n` },
      { args: ["pr", "create"], stdout: `https://example.invalid/${REPO}/pull/13\n` },
    ],
    pages: { [`repos/${REPO}/actions/runs/777/jobs`]: [{ total_count: (world.jobs ?? []).length, jobs: world.jobs ?? [] }] },
  }));
  const env = {
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
    HOME: dir,
    RUNNER_TEMP: dir,
    FAKE_GH_WORLD: worldFile,
    FAKE_GH_LOG: log,
    GITHUB_REPOSITORY: REPO,
    RUN_ID: "777",
    RUN_URL: `https://example.invalid/${REPO}/actions/runs/777`,
    BASE_BRANCH: "release/1.0.0",
    UPSTREAM_URL: "https://example.invalid/Anezium/Rokid-Nexus.git",
    UPSTREAM_REF: "main",
    SYNC_BRANCH: BRANCH,
    SYNC_RESULT: "success",
    SUITES_RESULT: "skipped",
    UPSTREAM_RESULT: "skipped",
    SUITES_SHAS: "",
    UPSTREAM_SHAS: "",
    ...inputs,
  };
  const result = spawnSync(process.execPath, [DECIDE, "report"], { env, encoding: "utf8" });
  const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const bodyOf = (call) => fs.readFileSync(call[call.indexOf("--body-file") + 1], "utf8");
  return { ...result, calls, bodyOf };
}

const fromOutcome = (outcome) => ({
  SYNC_CODE: String(outcome.code),
  SYNC_CHANGED: String(outcome.changed),
  SYNC_MERGE_SHA: outcome.merge_sha,
  SYNC_REPORT: outcome.report,
});
const shas = (sha, names) => names.map((name) => `${name}=${sha}`).join("\n");
const SUITE_JOBS = ["scripts", "computer-ubuntu-latest", "computer-macos-latest", "android", "emulator-release-checks", "windows-installer"];
const UPSTREAM_JOBS = ["sdk-and-hubs", "plugins"];
const verbs = (calls) => calls.map((call) => call.slice(0, 2).join(" "));

test("sync_script_honours_remote_and_ref_and_prints_merge_sha", (t) => {
  const s = sandbox(t);
  s.git(s.upstream, "checkout", "-q", "-b", "next");
  s.upstreamCommit("hub/Next.kt", "val next = true\n", "Add a file on next");
  s.git(s.upstream, "checkout", "-q", "main");

  const { result, outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "next");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const head = s.git(s.product, "rev-parse", "HEAD");
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `MERGE_SHA=${head}`);
  assert.deepEqual({ code: outcome.code, changed: outcome.changed, merge_sha: outcome.merge_sha }, { code: 0, changed: true, merge_sha: head });
  assert.ok(fs.existsSync(path.join(s.product, "vendor", "nexus", "hub", "Next.kt")));

  // With no arguments: the `upstream` remote and main.
  s.git(s.product, "remote", "add", "upstream", s.upstream);
  s.upstreamCommit("hub/Main.kt", "val main = true\n", "Add a file on main");
  const defaults = s.sync();
  assert.equal(defaults.status, 0, defaults.stdout + defaults.stderr);
  assert.equal(defaults.stdout.trimEnd().split("\n").at(-1), `MERGE_SHA=${s.git(s.product, "rev-parse", "HEAD")}`);
  assert.ok(fs.existsSync(path.join(s.product, "vendor", "nexus", "hub", "Main.kt")));

  const unknown = s.sync("--bogus");
  assert.equal(unknown.status, 1);
});

test("no_upstream_change_does_nothing", (t) => {
  const s = sandbox(t);
  const before = s.git(s.product, "rev-parse", "HEAD");
  const { result, outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(s.git(s.product, "rev-parse", "HEAD"), before);
  assert.doesNotMatch(result.stdout, /MERGE_SHA=/);
  assert.equal(outcome.changed, false);

  const r = report(t, fromOutcome(outcome));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(r.calls, [], "no PR, no issue");
  assert.equal(decide({ sync: { result: "success", ...outcome } }).action, "none");
});

test("upstream_sync_opens_pr_only_when_suites_pass", (t) => {
  const s = sandbox(t);
  s.upstreamCommit("hub/New.kt", "val added = true\n", "Add a file upstream");
  const { outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  assert.equal(outcome.changed, true);
  const passing = {
    ...fromOutcome(outcome),
    SUITES_RESULT: "success",
    UPSTREAM_RESULT: "success",
    SUITES_SHAS: shas(outcome.merge_sha, SUITE_JOBS),
    UPSTREAM_SHAS: shas(outcome.merge_sha, UPSTREAM_JOBS),
  };

  const opened = report(t, passing);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const create = opened.calls.find((call) => call[0] === "pr" && call[1] === "create");
  assert.ok(create, verbs(opened.calls).join(", "));
  assert.equal(create[create.indexOf("--head") + 1], BRANCH);
  assert.equal(create[create.indexOf("--base") + 1], "release/1.0.0");
  const body = opened.bodyOf(create);
  assert.match(body, /actions\/runs\/777/);
  assert.ok(body.includes(outcome.merge_sha));
  assert.ok(!opened.calls.some((call) => call[0] === "issue"), "no issue");

  // A PR already open for the branch is updated, not doubled.
  const updated = report(t, passing, { prs: [{ number: 5, headRefName: BRANCH }] });
  assert.equal(updated.status, 0, updated.stderr);
  assert.ok(updated.calls.some((call) => call[0] === "pr" && call[1] === "edit" && call[2] === "5"));
  assert.ok(!updated.calls.some((call) => call[0] === "pr" && call[1] === "create"));
});

test("sync_conflict_opens_issue_not_pr", (t) => {
  const s = sandbox(t);
  s.upstreamCommit("hub/Auth.kt", "val handshake = \"upstream v2\"\n", "Change the handshake upstream");
  const { result, outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  assert.equal(result.status, 2);
  assert.equal(outcome.changed, false);
  assert.match(outcome.report, /vendor\/nexus\/hub\/Auth\.kt/);

  const r = report(t, fromOutcome(outcome));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find((call) => call[0] === "issue" && call[1] === "create");
  assert.ok(create, verbs(r.calls).join(", "));
  assert.equal(create[create.indexOf("--title") + 1], "Upstream sync conflict");
  assert.equal(create[create.indexOf("--label") + 1], "upstream-sync");
  const body = r.bodyOf(create);
  assert.match(body, /vendor\/nexus\/hub\/Auth\.kt/);
  assert.ok(body.includes(`| ${s.patchSha} | \`hub/Auth.kt\``), "names the patch row");
  assert.ok(!r.calls.some((call) => call[0] === "pr"), "no PR");
});

test("suite_failure_opens_issue_and_keeps_branch", (t) => {
  const s = sandbox(t);
  s.upstreamCommit("hub/New.kt", "val added = true\n", "Add a file upstream");
  const { outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  const jobs = [
    { name: "sync", conclusion: "success" },
    { name: "suites / android", conclusion: "failure" },
    { name: "suites / computer (macos-latest)", conclusion: "success" },
    { name: "upstream / Upstream plugin unit tests", conclusion: "failure" },
  ];
  const r = report(t, {
    ...fromOutcome(outcome),
    SUITES_RESULT: "failure",
    UPSTREAM_RESULT: "failure",
    SUITES_SHAS: shas(outcome.merge_sha, ["scripts", "android"]) + "\ncomputer-macos-latest=",
    UPSTREAM_SHAS: shas(outcome.merge_sha, UPSTREAM_JOBS),
  }, { jobs });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find((call) => call[0] === "issue" && call[1] === "create");
  assert.ok(create, verbs(r.calls).join(", "));
  assert.equal(create[create.indexOf("--title") + 1], "Upstream sync breaks suites");
  const body = r.bodyOf(create);
  assert.match(body, /suites \/ android/);
  assert.match(body, /upstream \/ Upstream plugin unit tests/);
  assert.doesNotMatch(body, /computer \(macos-latest\)/);
  assert.ok(body.includes(BRANCH), "the branch is kept and named");
  assert.ok(!r.calls.some((call) => call[0] === "pr"), "no PR");
  assert.ok(!r.calls.some((call) => call.includes("DELETE") || call.includes("--delete")), "the branch is not deleted");
});

test("repeat_outcome_comments_on_open_issue", (t) => {
  const s = sandbox(t);
  s.upstreamCommit("hub/Auth.kt", "val handshake = \"upstream v3\"\n", "Change the handshake upstream again");
  const { outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  const r = report(t, fromOutcome(outcome), {
    issues: [{ number: 40, title: "Upstream sync breaks suites" }, { number: 41, title: "Upstream sync conflict" }],
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const comment = r.calls.find((call) => call[0] === "issue" && call[1] === "comment");
  assert.ok(comment, verbs(r.calls).join(", "));
  assert.equal(comment[2], "41");
  assert.match(r.bodyOf(comment), /hub\/Auth\.kt/);
  assert.ok(!r.calls.some((call) => call[0] === "issue" && call[1] === "create"));
  const list = r.calls.find((call) => call[0] === "issue" && call[1] === "list");
  assert.equal(list[list.indexOf("--label") + 1], "upstream-sync");
});

test("report_flags_a_job_that_tested_another_commit", (t) => {
  const s = sandbox(t);
  s.upstreamCommit("hub/New.kt", "val added = true\n", "Add a file upstream");
  const { outcome } = s.syncAsWorkflow("--remote", s.upstream, "--ref", "main");
  const other = "b".repeat(40);
  const r = report(t, {
    ...fromOutcome(outcome),
    SUITES_RESULT: "success",
    UPSTREAM_RESULT: "success",
    SUITES_SHAS: `${shas(outcome.merge_sha, ["scripts"])}\nandroid=${other}`,
    UPSTREAM_SHAS: shas(outcome.merge_sha, UPSTREAM_JOBS),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const create = r.calls.find((call) => call[0] === "issue" && call[1] === "create");
  assert.ok(create, verbs(r.calls).join(", "));
  assert.equal(create[create.indexOf("--title") + 1], "Upstream sync error");
  assert.match(r.bodyOf(create), new RegExp(`android tested ${other}`));
  assert.ok(!r.calls.some((call) => call[0] === "pr"), "no PR");

  // A passing job that reported no commit is not evidence either.
  const silent = decide({
    sync: { result: "success", ...outcome },
    suites: { result: "success", shas: parseShas(`scripts=${outcome.merge_sha}\nandroid=`) },
    upstream: { result: "success", shas: parseShas(shas(outcome.merge_sha, UPSTREAM_JOBS)) },
  });
  assert.equal(silent.title, "Upstream sync error");
  assert.match(silent.body, /android reported no commit/);
});

test("any other exit is an Upstream sync error", (t) => {
  for (const inputs of [{ SYNC_CODE: "3", SYNC_CHANGED: "false" }, { SYNC_CODE: "", SYNC_RESULT: "failure" }, { SYNC_CODE: "1", SYNC_CHANGED: "false" }]) {
    const r = report(t, inputs);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const create = r.calls.find((call) => call[0] === "issue" && call[1] === "create");
    assert.equal(create?.[create.indexOf("--title") + 1], "Upstream sync error", JSON.stringify(inputs));
    assert.ok(!r.calls.some((call) => call[0] === "pr"));
  }
});
