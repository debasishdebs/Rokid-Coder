"use strict";
/**
 * Whatever the wearer settles at the laptop closes the phone's alert for it, so nothing is
 * re-sent as a reminder: a prompt typed there, or Esc killing the hook that a hold waits on.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

const ATTACHED = [{ provider: "claude", id: "s1" }];

/** A hook request the test can kill, as Claude does to a running hook on Esc. */
function killableHook(port, payload) {
  const body = JSON.stringify(payload);
  const request = http.request({ host: "127.0.0.1", port, path: "/hook", method: "POST", headers: { "content-length": Buffer.byteLength(body) } });
  request.on("error", () => undefined);
  request.end(body);
  return { kill: () => request.destroy() };
}

const closedFor = (phone, id) => phone.waitFor("alert_closed", (f) => f.id === id);

test("a_laptop_prompt_closes_the_done_alert_when_stop_is_not_held", async () => {
  await withDaemon({ transport: "wshub", tls: true, stopHold: false, attached: ATTACHED }, async ({ phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    assert.deepEqual(await postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" }), {});
    const done = await phone.waitFor("alert", (f) => f.kind === "done");
    await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "next task" });
    assert.equal((await closedFor(phone, done.id)).reason, "withdrawn");
  });
});

test("a_killed_stop_hook_closes_the_hold_and_its_done_alert", async () => {
  await withDaemon({ transport: "wshub", tls: true, stopHold: true, attached: ATTACHED }, async ({ daemon, phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    const releases = [];
    daemon.stopWait.onRelease((_id, reason) => releases.push(reason));
    const stop = killableHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
    const done = await phone.waitFor("alert", (f) => f.kind === "done");
    await settle();
    assert.equal(daemon.stopWait.state("s1").waiting, true);
    stop.kill();
    assert.equal((await closedFor(phone, done.id)).reason, "withdrawn");
    assert.deepEqual(releases, ["cancelled"]);
    assert.equal((await phone.waitFor("followup_closed")).reason, "cancelled");
  });
});

test("a_killed_question_hook_closes_its_alert", async () => {
  await withDaemon({ transport: "wshub", tls: true, attached: ATTACHED }, async ({ phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    const ask = killableHook(httpPort, {
      hook_event_name: "PreToolUse",
      session_id: "s1",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      tool_input: { questions: [{ question: "Pick", header: "Pick", options: [{ label: "A", description: "a" }, { label: "B", description: "b" }], multiSelect: false }] },
    });
    const alert = await phone.waitFor("alert", (f) => f.kind === "question");
    ask.kill();
    assert.equal((await closedFor(phone, alert.id)).reason, "withdrawn");
  });
});

test("an_approval_answered_at_the_laptop_closes_its_alert", async () => {
  await withDaemon({ transport: "wshub", tls: true, attached: ATTACHED }, async ({ phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    const request = { hook_event_name: "PermissionRequest", session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } };
    // Typing a prompt at the laptop answers the dialog there.
    const held = postHook(httpPort, request);
    const first = await phone.waitFor("alert", (f) => f.kind === "approval");
    await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "never mind" });
    assert.equal((await closedFor(phone, first.id)).reason, "withdrawn");
    await held;
    // Esc kills the hook: the same.
    const killed = killableHook(httpPort, request);
    const second = await phone.waitFor("alert", (f) => f.kind === "approval" && f.id !== first.id);
    killed.kill();
    assert.equal((await closedFor(phone, second.id)).reason, "withdrawn");
  });
});
