const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { ApprovalPolicy } = require("../dist/approval-policy.js");
const { claudeApprovalKind } = require("../dist/approval-manager.js");
const { describeCodexApproval, buildCodexApprovalRequest } = require("../dist/codex/monitor.js");
const { silentLogger } = require("../dist/logger.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

function tempFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "approval-policy-"));
  return { dir, file: path.join(dir, "approve-all.json") };
}

function policyAt(file, extra = {}) {
  return new ApprovalPolicy({ file, logger: silentLogger, now: () => 1000, ...extra });
}

const request = (approvalKind) => ({ approvalKind });

test("default_is_ask_and_decide_returns_undefined", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  assert.equal(policy.get("claude:s1"), "ask");
  for (const kind of ["command", "fileChange", "tool"]) {
    assert.equal(policy.decide("claude:s1", request(kind)), undefined);
  }
  assert.equal(existsSync(file), false);
  rmSync(dir, { recursive: true });
});

test("approve_all_requires_confirm", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  assert.deepEqual(policy.set("claude:s1", "approveAll", false), { ok: false, error: "confirm_required" });
  assert.deepEqual(policy.set("claude:s1", "approveAll", undefined), { ok: false, error: "confirm_required" });
  assert.equal(policy.get("claude:s1"), "ask");
  assert.equal(policy.decide("claude:s1", request("command")), undefined);
  assert.deepEqual(policy.set("claude:s1", "approveAll", true), { ok: true });
  assert.equal(policy.get("claude:s1"), "approveAll");
  for (const kind of ["command", "fileChange", "tool"]) {
    assert.equal(policy.decide("claude:s1", request(kind)), "allow");
  }
  // Per session: another session is untouched.
  assert.equal(policy.decide("claude:s2", request("command")), undefined);
  assert.equal(policy.decide("codex:s1", request("command")), undefined);
  // The lower modes never need a confirm.
  assert.deepEqual(policy.set("claude:s1", "acceptEdits", false), { ok: true });
  rmSync(dir, { recursive: true });
});

test("accept_edits_allows_edit_not_bash", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  policy.set("claude:s1", "acceptEdits", false);
  assert.equal(policy.decide("claude:s1", request("fileChange")), "allow");
  assert.equal(policy.decide("claude:s1", request("command")), undefined);
  assert.equal(policy.decide("claude:s1", request("tool")), undefined);
  rmSync(dir, { recursive: true });
});

test("session_end_returns_reset_notice", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  assert.equal(policy.endSession("claude:s1"), undefined);
  policy.set("claude:s1", "approveAll", true);
  assert.deepEqual(policy.endSession("claude:s1"), {
    sessionKey: "claude:s1",
    from: "approveAll",
    reason: "session_ended",
  });
  assert.equal(policy.get("claude:s1"), "ask");
  assert.equal(policy.decide("claude:s1", request("command")), undefined);
  assert.equal(policy.endSession("claude:s1"), undefined);
  policy.set("claude:s2", "acceptEdits", false);
  assert.equal(policy.endSession("claude:s2")?.from, "acceptEdits");
  rmSync(dir, { recursive: true });
});

test("restart_emits_reset_notice_for_prior_approve_all", () => {
  const { dir, file } = tempFile();
  const first = policyAt(file);
  first.set("claude:s1", "approveAll", true);
  first.set("codex:t1", "approveAll", true);
  first.set("claude:s2", "acceptEdits", false);
  first.set("claude:gone", "approveAll", true);
  first.endSession("claude:gone");

  const second = policyAt(file);
  assert.equal(second.get("claude:s1"), "ask");
  assert.equal(second.get("codex:t1"), "ask");
  assert.equal(second.decide("claude:s1", request("command")), undefined);
  const notices = second.takeRestartNotices();
  assert.deepEqual(
    notices.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)),
    [
      { sessionKey: "claude:s1", from: "approveAll", reason: "helper_restarted" },
      { sessionKey: "codex:t1", from: "approveAll", reason: "helper_restarted" },
    ],
  );
  assert.deepEqual(second.takeRestartNotices(), []);
  assert.deepEqual(policyAt(file).takeRestartNotices(), []);
  rmSync(dir, { recursive: true });
});

test("restart_notice_survives_a_second_restart_until_taken", () => {
  const { dir, file } = tempFile();
  policyAt(file).set("claude:s1", "approveAll", true);
  policyAt(file); // restarted again before anything drained the notices
  assert.equal(policyAt(file).takeRestartNotices().length, 1);
  rmSync(dir, { recursive: true });
});

test("a_corrupt_state_file_is_ignored_and_never_grants_anything", () => {
  const { dir, file } = tempFile();
  writeFileSync(file, "{not json");
  const policy = policyAt(file);
  assert.deepEqual(policy.takeRestartNotices(), []);
  assert.equal(policy.get("claude:s1"), "ask");
  assert.deepEqual(policy.set("claude:s1", "approveAll", true), { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).sessions.map((s) => s.sessionKey), ["claude:s1"]);
  rmSync(dir, { recursive: true });
});

test("revoke_all_resets_every_session", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  policy.set("claude:s1", "approveAll", true);
  policy.set("codex:t1", "acceptEdits", false);
  policy.set("claude:s2", "ask", false);
  const notices = policy.revokeAll();
  assert.deepEqual(
    notices.sort((a, b) => a.sessionKey.localeCompare(b.sessionKey)),
    [
      { sessionKey: "claude:s1", from: "approveAll", reason: "revoked" },
      { sessionKey: "codex:t1", from: "acceptEdits", reason: "revoked" },
    ],
  );
  for (const key of ["claude:s1", "codex:t1", "claude:s2"]) {
    assert.equal(policy.get(key), "ask");
  }
  assert.deepEqual(policyAt(file).takeRestartNotices(), []);
  assert.deepEqual(policy.revokeAll(), []);
  rmSync(dir, { recursive: true });
});

test("defaults_apply_at_attach_and_can_only_be_ask_or_accept_edits", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  assert.deepEqual(policy.setDefaults({ claude: "approveAll" }), { ok: false, error: "invalid_default" });
  assert.deepEqual(policy.setDefaults({ codex: "bogus" }), { ok: false, error: "invalid_default" });
  assert.deepEqual(policy.setDefaults({ claude: "acceptEdits", codex: "ask" }), { ok: true });

  policy.applyDefault("claude:s1");
  policy.applyDefault("codex:t1");
  assert.equal(policy.get("claude:s1"), "acceptEdits");
  assert.equal(policy.get("codex:t1"), "ask");

  // A later default change does not touch a session already attached, and a
  // re-attach does not undo a mode the wearer chose.
  policy.set("claude:s1", "approveAll", true);
  policy.setDefaults({ claude: "ask" });
  policy.applyDefault("claude:s1");
  assert.equal(policy.get("claude:s1"), "approveAll");
  policy.applyDefault("claude:s2");
  assert.equal(policy.get("claude:s2"), "ask");
  assert.equal(existsSync(file) && JSON.parse(readFileSync(file, "utf8")).sessions.some((s) => s.sessionKey === "claude:s2"), false);
  rmSync(dir, { recursive: true });
});

test("claude_edit_tools_are_file_changes", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
    assert.equal(claudeApprovalKind(tool), "fileChange");
  }
  for (const tool of ["Bash", "Read", "WebFetch", "edit", "mcp__x__Edit"]) {
    assert.equal(claudeApprovalKind(tool), "tool");
  }
});

test("codex_normalized_file_change_request_counts_as_file_change", () => {
  const { dir, file } = tempFile();
  const fileChange = {
    id: 7,
    method: "item/fileChange/requestApproval",
    params: { threadId: "t1", turnId: "u1", itemId: "i1", startedAtMs: 5, reason: "patch", grantRoot: "/repo" },
  };
  const command = {
    id: 8,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "t1", turnId: "u1", itemId: "i2", startedAtMs: 6, command: "rm -rf x", cwd: "/repo" },
  };
  const permissions = {
    id: 9,
    method: "item/permissions/requestApproval",
    params: { threadId: "t1", turnId: "u1", itemId: "i3", startedAtMs: 7, cwd: "/repo", permissions: {} },
  };
  // The display label is what the phone shows; the decision must not read it.
  assert.equal(describeCodexApproval(fileChange).tool, "File change");

  const policy = policyAt(file);
  policy.set("codex:t1", "acceptEdits", false);
  const built = buildCodexApprovalRequest(fileChange, "t1");
  assert.equal(built.provider, "codex");
  assert.equal(built.sessionKey, "codex:t1");
  assert.equal(built.approvalKind, "fileChange");
  assert.equal(built.tool, "File change");
  assert.equal(policy.decide(built.sessionKey, built), "allow");

  const builtCommand = buildCodexApprovalRequest(command, "t1");
  assert.equal(builtCommand.approvalKind, "command");
  assert.equal(policy.decide(builtCommand.sessionKey, builtCommand), undefined);
  const builtPermissions = buildCodexApprovalRequest(permissions, "t1");
  assert.equal(builtPermissions.approvalKind, "tool");
  assert.equal(policy.decide(builtPermissions.sessionKey, builtPermissions), undefined);
  rmSync(dir, { recursive: true });
});

test("daemon_resets_approve_all_on_session_end_and_detach_and_reports_restart", async () => {
  await withDaemon(
    {
      transport: "wshub",
      attached: [
        { provider: "claude", id: "ending" },
        { provider: "claude", id: "detached" },
      ],
    },
    async ({ daemon, httpPort, coderDir }) => {
      const policy = daemon.approvalPolicy;
      policy.set("claude:ending", "approveAll", true);
      policy.set("claude:detached", "approveAll", true);
      policy.set("claude:other", "approveAll", true);
      const recorded = JSON.parse(readFileSync(path.join(coderDir, "approve-all.json"), "utf8"));
      assert.equal(recorded.sessions.length, 3);

      await postHook(httpPort, { hook_event_name: "SessionEnd", session_id: "ending" });
      daemon.attachRegistry.detach("claude", "detached");
      await settle();
      assert.equal(policy.get("claude:ending"), "ask");
      assert.equal(policy.get("claude:detached"), "ask");
      assert.equal(policy.get("claude:other"), "approveAll");
      const notices = daemon.takeResetNotices();
      assert.deepEqual(
        notices.map((n) => `${n.sessionKey}:${n.reason}`).sort(),
        ["claude:detached:session_ended", "claude:ending:session_ended"],
      );
      assert.deepEqual(daemon.takeResetNotices(), []);
    },
  );
});

test("approve_all_grant_is_refused_when_its_record_cannot_be_written", () => {
  const { dir } = tempFile();
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "not a directory");
  const policy = policyAt(path.join(blocker, "approve-all.json"));
  assert.throws(() => policy.set("claude:s1", "approveAll", true));
  assert.equal(policy.get("claude:s1"), "ask");
  assert.equal(policy.decide("claude:s1", request("command")), undefined);
  rmSync(dir, { recursive: true });
});

test("downgrade_from_approve_all_sticks_when_its_record_cannot_be_written", () => {
  const { dir, file } = tempFile();
  const policy = policyAt(file);
  assert.deepEqual(policy.set("claude:s1", "approveAll", true), { ok: true });
  // Make the state path unwritable: the directory's parent becomes a file.
  rmSync(dir, { recursive: true });
  writeFileSync(dir, "now a file");
  assert.deepEqual(policy.set("claude:s1", "ask", false), { ok: true });
  assert.equal(policy.get("claude:s1"), "ask");
  assert.equal(policy.decide("claude:s1", request("command")), undefined);

  assert.deepEqual(policy.set("claude:s2", "acceptEdits", false), { ok: true });
  assert.equal(policy.get("claude:s2"), "acceptEdits");
  rmSync(dir);
});
