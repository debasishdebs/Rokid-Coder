const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionStore } = require("../dist/session-store.js");
const { silentLogger } = require("../dist/logger.js");

const identity = {
  machineId: "machine-test",
  machineName: "test-pc",
};

test("scripted hooks drive normalized status and pending-request transitions", () => {
  let now = 1_753_380_000_000;
  const store = new SessionStore(identity, silentLogger, () => now);
  const base = {
    session_id: "session-123456789",
    transcript_path: "C:\\tmp\\session.jsonl",
    cwd: "E:\\work\\sample",
  };

  store.handleHook({ ...base, hook_event_name: "SessionStart", source: "startup" });
  let session = store.get(base.session_id);
  assert.equal(session.status, "idle");
  assert.equal(session.stale, false);
  assert.equal(session.cwd, "E:/work/sample");
  assert.equal(session.project, "sample");

  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "Implement the monitoring protocol",
  });
  session = store.get(base.session_id);
  assert.equal(session.status, "working");
  assert.equal(session.title, "Implement the monitoring protocol");
  assert.equal(session.turn.activeSince, now);

  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "Notification",
    message: "Permission required to run a command",
  });
  session = store.get(base.session_id);
  assert.equal(session.status, "needs_you");
  assert.deepEqual(session.pendingRequest, {
    kind: "permission",
    summary: "Permission required to run a command",
    createdAt: now,
  });

  // The turn ended with the prompt unanswered here (a laptop "No" reports
  // nothing else), so the permission request is over with it.
  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop" });
  assert.equal(store.get(base.session_id).status, "idle");
  assert.equal(store.get(base.session_id).pendingRequest, undefined);

  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "Continue",
  });
  session = store.get(base.session_id);
  assert.equal(session.status, "working");
  assert.equal(session.pendingRequest, undefined);

  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop" });
  assert.equal(store.get(base.session_id).status, "idle");

  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "Notification",
    message: "Claude is waiting for your input",
  });
  session = store.get(base.session_id);
  assert.equal(session.status, "needs_you");
  assert.equal(session.pendingRequest.kind, "idle_prompt");

  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "Resolve the question",
  });
  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop" });
  assert.equal(store.get(base.session_id).status, "idle");
  assert.equal(store.get(base.session_id).pendingRequest, undefined);

  store.dispose();
});

test("working sessions become stalled errors and session end becomes done", () => {
  let now = 1_753_380_000_000;
  const store = new SessionStore(identity, silentLogger, () => now);
  const base = {
    session_id: "stalled-session",
    cwd: "E:\\work\\sample",
  };
  store.handleHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "Wait" });
  now += 30 * 60 * 1000 + 1;
  store.sweepStalled();
  assert.equal(store.get(base.session_id).status, "error");
  assert.equal(store.get(base.session_id).statusDetail, "stalled?");

  store.handleHook({ ...base, hook_event_name: "SessionEnd", reason: "completed" });
  assert.equal(store.get(base.session_id).status, "done");
  store.dispose();
});

test("synthetic user prompts preserve the human title while keeping status transitions", () => {
  let now = 1_753_380_000_000;
  const store = new SessionStore(identity, silentLogger, () => now);
  const base = {
    session_id: "synthetic-prompt-session",
    cwd: "E:\\work\\sample",
  };
  store.handleHook({
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "Human-written title",
  });
  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "Notification",
    message: "Permission required to continue",
  });
  now += 10;
  store.handleHook({
    ...base,
    hook_event_name: "UserPromptSubmit",
    prompt: "  <task-notification>synthetic wrapper</task-notification>",
  });

  const session = store.get(base.session_id);
  assert.equal(session.title, "Human-written title");
  assert.equal(session.status, "working");
  assert.equal(session.pendingRequest, undefined);
  assert.equal(session.turn.activeSince, now);
  store.dispose();
});

test("a Stop hook's last_assistant_message is the session's latest assistant text, ahead of the transcript tail", () => {
  let now = 1_753_380_000_000;
  const store = new SessionStore(identity, silentLogger, () => now);
  const base = { session_id: "stop-text-session", cwd: "/work/sample" };

  store.handleHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "first" });
  store.applyTranscriptUpdate(base.session_id, { activityAt: now, lastAssistantText: "older answer" });

  // Claude fires Stop before the transcript has the final message, so the tail
  // still holds the previous turn's text; the hook carries the real one.
  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop", last_assistant_message: "BANANA" });
  assert.equal(store.get(base.session_id).lastAssistantText, "BANANA");

  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop", last_assistant_message: "x".repeat(300) });
  assert.equal(store.get(base.session_id).lastAssistantText.length, 140);

  // A Stop without the field (an older Claude) leaves what the tail found.
  now += 10;
  store.handleHook({ ...base, hook_event_name: "Stop" });
  assert.equal(store.get(base.session_id).lastAssistantText.length, 140);
  store.dispose();
});

test("the_mcp_elicitation_hooks_change_nothing_and_are_not_unknown_events", () => {
  const events = [];
  const logger = { info: (event) => events.push(event), warn: (event) => events.push(event), error: (event) => events.push(event) };
  const store = new SessionStore(identity, logger, () => 1_753_380_000_000);
  const base = { session_id: "session-elicit-1", transcript_path: "/tmp/s.jsonl", cwd: "/work/sample" };
  store.handleHook({ ...base, hook_event_name: "SessionStart", source: "startup" });
  const before = JSON.stringify(store.get(base.session_id));
  store.handleHook({ ...base, hook_event_name: "Elicitation", mcp_server_name: "docs" });
  store.handleHook({ ...base, hook_event_name: "ElicitationResult", mcp_server_name: "docs", action: "accept" });
  assert.equal(events.includes("hook_unknown_event"), false);
  assert.equal(JSON.stringify(store.get(base.session_id)), before);
  store.dispose();
});
