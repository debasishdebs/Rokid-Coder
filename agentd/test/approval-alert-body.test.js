const test = require("node:test");
const assert = require("node:assert/strict");
const { describeTool, claudeApprovalKind } = require("../dist/approval-manager.js");
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
