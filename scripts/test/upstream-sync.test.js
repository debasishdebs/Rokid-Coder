"use strict";
// Drives scripts/upstream-sync.sh against throwaway git repos: a synthetic
// upstream, and a product repo that vendors it at vendor/nexus with one
// recorded patch. Nothing here touches the real repository or the user's git
// config: HOME points at the temp dir and the system config is ignored.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const SCRIPT = path.resolve(__dirname, "..", "upstream-sync.sh");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "upstream-sync-"));
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
  write(path.join(upstream, "hub", "Other.kt"), "val other = 1\n");
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
    [
      "# Patches",
      "",
      "| SHA | Files | Purpose | Must-not-touch? |",
      "|---|---|---|---|",
      `| ${patchSha} | \`hub/Auth.kt\` | Our handshake | yes |`,
      "| 0000000 | `hub/Unrelated.kt`, `docs/` | A patch elsewhere | no |",
      "",
    ].join("\n"),
  );
  git(product, "add", "-A");
  git(product, "commit", "-q", "-m", "Record the vendored patch");

  const sync = () =>
    spawnSync("bash", [SCRIPT, upstream, "main"], { cwd: product, env, encoding: "utf8" });
  return { upstream, product, patchSha, git, write, sync };
}

test("sync_conflict_opens_issue_naming_patches", (t) => {
  const s = sandbox(t);
  s.write(path.join(s.upstream, "hub", "Auth.kt"), "val handshake = \"upstream v2\"\n");
  s.git(s.upstream, "commit", "-q", "-am", "Change the handshake upstream");
  const before = s.git(s.product, "rev-parse", "HEAD");

  const result = s.sync();

  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stdout, /Conflicted files:\n\s+vendor\/nexus\/hub\/Auth\.kt\n/);
  assert.match(result.stdout, new RegExp(`PATCHES\\.md rows that touch them:\\n\\s+\\| ${s.patchSha} \\| \`hub/Auth\\.kt\``));
  assert.doesNotMatch(result.stdout, /Unrelated\.kt/);
  // The merge is aborted: no half-merged tree is left for a PR to pick up.
  assert.equal(s.git(s.product, "rev-parse", "HEAD"), before);
  assert.equal(s.git(s.product, "status", "--porcelain"), "");
});

test("refuses_when_a_merge_is_already_in_progress", (t) => {
  const s = sandbox(t);
  s.git(s.product, "checkout", "-q", "-b", "other");
  s.write(path.join(s.product, "README.md"), "other\n");
  s.git(s.product, "commit", "-q", "-am", "Diverge on other");
  s.git(s.product, "checkout", "-q", "main");
  s.write(path.join(s.product, "README.md"), "main\n");
  s.git(s.product, "commit", "-q", "-am", "Diverge on main");
  assert.throws(() => s.git(s.product, "merge", "other"));
  const mergeHead = s.git(s.product, "rev-parse", "MERGE_HEAD");
  const head = s.git(s.product, "rev-parse", "HEAD");
  const status = s.git(s.product, "status", "--porcelain");
  const index = s.git(s.product, "ls-files", "--stage");
  const readme = fs.readFileSync(path.join(s.product, "README.md"), "utf8");

  const result = s.sync();

  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /in progress/);
  assert.equal(s.git(s.product, "rev-parse", "MERGE_HEAD"), mergeHead);
  assert.equal(s.git(s.product, "rev-parse", "HEAD"), head);
  assert.equal(s.git(s.product, "status", "--porcelain"), status);
  assert.equal(s.git(s.product, "ls-files", "--stage"), index);
  assert.equal(fs.readFileSync(path.join(s.product, "README.md"), "utf8"), readme);
});

test("refuses_on_dirty_tree", (t) => {
  const s = sandbox(t);
  s.write(path.join(s.upstream, "hub", "New.kt"), "val added = true\n");
  s.git(s.upstream, "add", "-A");
  s.git(s.upstream, "commit", "-q", "-m", "Add a file upstream");
  s.write(path.join(s.product, "README.md"), "edited\n");
  const head = s.git(s.product, "rev-parse", "HEAD");

  const result = s.sync();

  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /uncommitted changes/);
  assert.equal(s.git(s.product, "rev-parse", "HEAD"), head);
  assert.equal(fs.readFileSync(path.join(s.product, "README.md"), "utf8"), "edited\n");
  assert.equal(fs.existsSync(path.join(s.product, "vendor", "nexus", "hub", "New.kt")), false);

  // A staged-only change is dirty too.
  s.git(s.product, "checkout", "--", "README.md");
  s.write(path.join(s.product, "README.md"), "staged\n");
  s.git(s.product, "add", "README.md");
  const staged = s.sync();
  assert.equal(staged.status, 3, staged.stdout + staged.stderr);
  assert.equal(s.git(s.product, "diff", "--cached", "--name-only"), "README.md");
});

test("sync_clean_upstream_commit_exits_0", (t) => {
  const s = sandbox(t);
  s.write(path.join(s.upstream, "hub", "New.kt"), "val added = true\n");
  s.git(s.upstream, "add", "-A");
  s.git(s.upstream, "commit", "-q", "-m", "Add a file upstream");

  const result = s.sync();

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(path.join(s.product, "vendor", "nexus", "hub", "New.kt"), "utf8"), "val added = true\n");
  assert.equal(fs.readFileSync(path.join(s.product, "vendor", "nexus", "hub", "Auth.kt"), "utf8"), "val handshake = \"ours\"\n");
  assert.equal(s.git(s.product, "status", "--porcelain"), "");
});
