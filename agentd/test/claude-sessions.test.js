const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  readClaudeSession,
  descendantPids,
  findOwnedClaudeSession,
  isPidAlive,
} = require("../dist/launcher/claude-sessions.js");
const { withTempDir } = require("./helpers/daemon.js");

function sessionFile(dir, pid, sessionId, extra = {}) {
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, status: "idle", kind: "interactive", statusUpdatedAt: 5, ...extra }),
  );
}

/** A shell whose `sleep` is a real grandchild of the test: `; :` stops sh from exec'ing it. */
async function shellWithGrandchild(t) {
  const shell = spawn("sh", ["-c", "sleep 30; :"], { stdio: "ignore" });
  t.after(() => shell.kill("SIGKILL"));
  for (let i = 0; i < 100; i += 1) {
    const tree = descendantPids(shell.pid);
    if (tree.length >= 2) {
      return { shell, grandchild: tree.find((pid) => pid !== shell.pid) };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("sh never started its sleep");
}

test("reads_session_file_and_rejects_malformed", async () => {
  await withTempDir(async (dir) => {
    sessionFile(dir, 101, "sess-a", { status: "busy" });
    assert.deepEqual(readClaudeSession(dir, 101), {
      pid: 101,
      sessionId: "sess-a",
      status: "busy",
      statusUpdatedAt: 5,
    });
    assert.equal(readClaudeSession(dir, 102), undefined, "missing file");
    // The file's own pid must be the one it is named for.
    fs.writeFileSync(path.join(dir, "103.json"), JSON.stringify({ pid: 999, sessionId: "x", status: "idle" }));
    assert.equal(readClaudeSession(dir, 103), undefined);
    fs.writeFileSync(path.join(dir, "104.json"), "{not json");
    assert.equal(readClaudeSession(dir, 104), undefined);
    fs.writeFileSync(path.join(dir, "105.json"), JSON.stringify({ pid: 105, status: "idle" }));
    assert.equal(readClaudeSession(dir, 105), undefined, "no sessionId");
    fs.writeFileSync(path.join(dir, "106.json"), JSON.stringify([106]));
    assert.equal(readClaudeSession(dir, 106), undefined);
    assert.equal(readClaudeSession(dir, -1), undefined);
  });
});

test("descendant_pids_include_root_and_grandchildren", async (t) => {
  const { shell, grandchild } = await shellWithGrandchild(t);
  const tree = descendantPids(shell.pid);
  assert.equal(tree[0], shell.pid, "the root comes first");
  assert.ok(tree.includes(grandchild));
  assert.ok(!tree.includes(process.pid), "an ancestor is not a descendant");
});

test("finds_owned_session_only_in_own_tree", async (t) => {
  await withTempDir(async (dir) => {
    const { shell, grandchild } = await shellWithGrandchild(t);
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => stranger.kill("SIGKILL"));
    sessionFile(dir, stranger.pid, "theirs");
    assert.equal(findOwnedClaudeSession(dir, shell.pid), undefined, "a sibling's file is not ours");
    sessionFile(dir, grandchild, "ours");
    assert.equal(findOwnedClaudeSession(dir, shell.pid)?.sessionId, "ours");
    assert.equal(findOwnedClaudeSession(dir, shell.pid)?.pid, grandchild);
    assert.equal(findOwnedClaudeSession(dir, stranger.pid)?.sessionId, "theirs");
  });
});

test("pid_liveness", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  assert.equal(isPidAlive(child.pid), true);
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(isPidAlive(child.pid), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
});
