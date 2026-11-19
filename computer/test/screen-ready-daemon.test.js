"use strict";
/**
 * The daemon's own wiring of the screen route: a glasses reply queued behind a turn keeps that turn's Stop from
 * being held for the glasses (stopHold on, a phone connected, so a Stop would otherwise be held), and the
 * hook endpoint takes the MCP elicitation hooks the plugin registers.
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

test("the_daemon_does_not_hold_the_stop_of_a_turn_a_glasses_reply_is_queued_behind", async () => {
  await withDaemon({ transport: "wshub", tls: true, stopHold: true, attached: ATTACHED }, async ({ daemon, phone, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    // Without a queued reply the Stop is held for the glasses (a phone is connected and stopHold is on).
    const held = killableHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
    await phone.waitFor("alert", (f) => f.kind === "done");
    await settle();
    assert.equal(daemon.stopWait.state("s1").waiting, true, "the control: an ordinary Stop is held");
    held.kill();
    await settle();
    assert.equal(daemon.stopWait.state("s1").waiting, false);
    // With a reply queued behind the turn, the Stop answers at once and nothing is held.
    daemon.launcherRouter.states.markQueued("claude:s1", "yes do it");
    const answered = await Promise.race([
      postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" }),
      settle(3000).then(() => "held"),
    ]);
    assert.deepEqual(answered, {});
    assert.equal(daemon.stopWait.state("s1").waiting, false, "no hold was opened");
    // Claude takes the reply as a prompt: the next Stop is held again.
    await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "yes do it" });
    assert.equal(daemon.launcherRouter.states.queuedPending("claude:s1"), false);
    const again = killableHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
    await settle();
    await settle();
    assert.equal(daemon.stopWait.state("s1").waiting, true, "held again");
    again.kill();
  });
});

test("the_hook_endpoint_takes_the_elicitation_hooks_and_answers_them_with_nothing_to_decide", async () => {
  await withDaemon({ transport: "wshub", tls: true, attached: ATTACHED }, async ({ daemon, httpPort }) => {
    await postHook(httpPort, { hook_event_name: "SessionStart", session_id: "s1", cwd: "/work/demo" });
    const states = daemon.launcherRouter.states;
    assert.equal(states.dialogAnnounced("claude:s1"), false);
    // `{}` is no decision: Claude shows its own dialog.
    assert.deepEqual(await postHook(httpPort, { hook_event_name: "Elicitation", session_id: "s1", mcp_server_name: "docs", message: "Pick" }), {});
    assert.equal(states.dialogAnnounced("claude:s1"), true, "announced");
    assert.deepEqual(await postHook(httpPort, { hook_event_name: "ElicitationResult", session_id: "s1", mcp_server_name: "docs", action: "accept" }), {});
    assert.equal(states.dialogAnnounced("claude:s1"), false, "closed by its result");
  });
});
