const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { StopWait } = require("../dist/stop-wait.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

/** A timer the test fires by hand, so no wait is ever real. */
function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    fireLast() {
      timers.at(-1).fn();
    },
  };
}

function makeWait(options = {}) {
  const clock = fakeTimers();
  const releases = [];
  const wait = new StopWait({
    waitLimitMs: 30 * 60_000,
    continuationCap: 8,
    setTimer: clock.setTimer,
    ...options,
  });
  wait.onRelease((sessionId, reason, msgId) => releases.push({ sessionId, reason, msgId }));
  return { wait, clock, releases };
}

const open = () => new AbortController();

test("delivers_followup_as_block_reason", async () => {
  const { wait, releases } = makeWait();
  const held = wait.hold("s1", open().signal);
  assert.deepEqual(wait.state("s1"), { waiting: true, continuationsLeft: 8 });
  assert.equal(wait.deliver("s1", "Reply BANANA", "m1"), "delivered");
  assert.deepEqual(await held, {
    decision: "block",
    reason: "Follow-up from Rokid glasses:\nReply BANANA",
  });
  assert.deepEqual(wait.state("s1"), { waiting: false, continuationsLeft: 7 });
  assert.deepEqual(releases, [{ sessionId: "s1", reason: "delivered", msgId: "m1" }]);
});

test("no_phone_connected_resolves_stop_at_once_and_a_phone_makes_it_hold", async () => {
  let phone = false;
  const { wait, releases } = makeWait({ canAsk: () => phone });
  assert.deepEqual(await wait.hold("s1", open().signal), {});
  assert.deepEqual(wait.state("s1"), { waiting: false, continuationsLeft: 8 });
  assert.deepEqual(releases, []);
  phone = true;
  const held = wait.hold("s1", open().signal);
  assert.equal(wait.state("s1").waiting, true);
  assert.equal(wait.deliver("s1", "go", "m1"), "delivered");
  assert.equal((await held).decision, "block");
});

test("times_out_to_empty_response", async () => {
  const { wait, clock, releases } = makeWait({ waitLimitMs: 1234 });
  const held = wait.hold("s1", open().signal);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 1234);
  clock.fireLast();
  assert.deepEqual(await held, {});
  assert.deepEqual(releases, [{ sessionId: "s1", reason: "timeout", msgId: undefined }]);
  assert.equal(wait.state("s1").waiting, false);
  assert.equal(wait.state("s1").continuationsLeft, 8);
});

test("laptop_prompt_releases_stop_wait", async () => {
  const { wait, releases } = makeWait();
  const held = wait.hold("s1", open().signal);
  wait.releaseByLaptop("s1");
  assert.deepEqual(await held, {});
  assert.deepEqual(releases.map((r) => r.reason), ["laptop"]);
  // Nothing is waiting any more, so a second release is a no-op.
  wait.releaseByLaptop("s1");
  assert.equal(releases.length, 1);
});

test("abort_signal_releases_as_cancelled", async () => {
  const { wait, releases } = makeWait();
  const controller = open();
  const held = wait.hold("s1", controller.signal);
  controller.abort("cancelled");
  assert.deepEqual(await held, {});
  assert.deepEqual(releases.map((r) => r.reason), ["cancelled"]);
  assert.equal(wait.deliver("s1", "late", "m1"), "not_waiting");
});

test("abort_before_hold_never_waits", async () => {
  const { wait, releases } = makeWait();
  const controller = open();
  controller.abort("cancelled");
  assert.deepEqual(await wait.hold("s1", controller.signal), {});
  assert.equal(wait.state("s1").waiting, false);
  assert.deepEqual(releases, []);
});

test("cap_reached_after_8_then_reset_by_tool_use", async () => {
  const { wait, releases } = makeWait();
  for (let i = 1; i <= 8; i += 1) {
    const held = wait.hold("s1", open().signal);
    assert.equal(wait.deliver("s1", `step ${i}`, `m${i}`), "delivered");
    assert.equal((await held).decision, "block");
    assert.equal(wait.state("s1").continuationsLeft, 8 - i);
  }
  // The ninth Stop is not held: Claude would ignore a ninth block anyway.
  assert.deepEqual(await wait.hold("s1", open().signal), {});
  assert.equal(wait.state("s1").waiting, false);
  assert.equal(wait.deliver("s1", "step 9", "m9"), "cap_reached");
  assert.equal(releases.length, 8);

  wait.noteToolUse("s1");
  assert.equal(wait.state("s1").continuationsLeft, 8);
  const held = wait.hold("s1", open().signal);
  assert.equal(wait.deliver("s1", "again", "m10"), "delivered");
  assert.equal((await held).decision, "block");
});

test("deliver_when_not_waiting_returns_not_waiting", () => {
  const { wait } = makeWait();
  assert.equal(wait.deliver("nobody", "hello", "m1"), "not_waiting");
  assert.deepEqual(wait.state("nobody"), { waiting: false, continuationsLeft: 8 });
});

test("laptop_prompt_does_not_reset_the_continuation_count", async () => {
  const { wait } = makeWait({ continuationCap: 2 });
  const first = wait.hold("s1", open().signal);
  wait.deliver("s1", "one", "m1");
  await first;
  const second = wait.hold("s1", open().signal);
  wait.releaseByLaptop("s1");
  await second;
  assert.equal(wait.state("s1").continuationsLeft, 1);
});

test("sessions_are_independent", async () => {
  const { wait } = makeWait();
  const a = wait.hold("a", open().signal);
  const b = wait.hold("b", open().signal);
  assert.equal(wait.deliver("a", "for a", "m1"), "delivered");
  assert.equal((await a).decision, "block");
  assert.equal(wait.state("b").waiting, true);
  wait.releaseByLaptop("b");
  assert.deepEqual(await b, {});
});

test("a_second_hold_replaces_the_first_as_cancelled", async () => {
  const { wait, releases } = makeWait();
  const first = wait.hold("s1", open().signal);
  const second = wait.hold("s1", open().signal);
  assert.deepEqual(await first, {});
  assert.deepEqual(releases.map((r) => r.reason), ["cancelled"]);
  assert.equal(wait.deliver("s1", "x", "m1"), "delivered");
  assert.equal((await second).decision, "block");
});

test("end_session_and_dispose_release_as_cancelled", async () => {
  const { wait, releases } = makeWait();
  const a = wait.hold("a", open().signal);
  const b = wait.hold("b", open().signal);
  wait.endSession("a");
  assert.deepEqual(await a, {});
  wait.dispose();
  assert.deepEqual(await b, {});
  assert.deepEqual(releases.map((r) => `${r.sessionId}:${r.reason}`), ["a:cancelled", "b:cancelled"]);
});

test("end_session_forgets_the_continuation_count", async () => {
  const { wait } = makeWait();
  const held = wait.hold("s1", open().signal);
  wait.deliver("s1", "one", "m1");
  await held;
  wait.endSession("s1");
  assert.equal(wait.state("s1").continuationsLeft, 8);
});

test("wait_limit_setter_applies_to_later_holds_and_is_capped_at_an_hour", () => {
  const { wait, clock } = makeWait();
  wait.setWaitLimitMs(5_000);
  wait.hold("s1", open().signal);
  assert.equal(clock.timers.at(-1).ms, 5_000);
  wait.setWaitLimitMs(10 * 3_600_000);
  wait.hold("s2", open().signal);
  assert.equal(clock.timers.at(-1).ms, 3_600_000);
  wait.setWaitLimitMs(Number.NaN);
  wait.hold("s3", open().signal);
  assert.equal(clock.timers.at(-1).ms, 3_600_000);
  wait.dispose();
});

test("a_throwing_release_listener_does_not_stop_the_release", async () => {
  const { wait } = makeWait();
  wait.onRelease(() => { throw new Error("listener bug"); });
  const held = wait.hold("s1", open().signal);
  wait.releaseByLaptop("s1");
  assert.deepEqual(await held, {});
});

// The daemon wiring: which hooks hold, release and count.

function startStop(httpPort, sessionId, headers) {
  let settled = false;
  const reply = postHook(httpPort, { hook_event_name: "Stop", session_id: sessionId }, headers)
    .finally(() => { settled = true; });
  return { reply, isSettled: () => settled };
}

test("daemon_holds_stop_for_attached_claude_and_a_laptop_prompt_releases_it", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const releases = [];
      daemon.stopWait.onRelease((sessionId, reason) => releases.push(`${sessionId}:${reason}`));
      const stop = startStop(httpPort, "held");
      await settle();
      assert.equal(stop.isSettled(), false);
      assert.equal(daemon.stopWait.state("held").waiting, true);

      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "held", prompt: "hi" }),
        {},
      );
      assert.deepEqual(await stop.reply, {});
      assert.deepEqual(releases, ["held:laptop"]);
    },
  );
});

test("daemon_delivery_reaches_the_held_stop_request", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const stop = startStop(httpPort, "held");
      await settle();
      assert.equal(daemon.stopWait.deliver("held", "Reply APPLE", "m1"), "delivered");
      assert.deepEqual(await stop.reply, {
        decision: "block",
        reason: "Follow-up from Rokid glasses:\nReply APPLE",
      });
    },
  );
});

test("daemon_attach_commands_are_not_laptop_prompts", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const stop = startStop(httpPort, "held");
      await settle();
      const status = await postHook(httpPort, {
        hook_event_name: "UserPromptExpansion",
        command_name: "rokid:status",
        session_id: "held",
      });
      assert.equal(status.decision, "block");
      const typed = await postHook(httpPort, {
        hook_event_name: "UserPromptSubmit",
        session_id: "held",
        prompt: "/rokid status",
      });
      assert.equal(typed.decision, "block");
      await settle();
      assert.equal(stop.isSettled(), false);
      assert.equal(daemon.stopWait.state("held").waiting, true);
      daemon.stopWait.releaseByLaptop("held");
      await stop.reply;
    },
  );
});

test("daemon_does_not_hold_unattached_or_codex_stops", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      assert.deepEqual(await postHook(httpPort, { hook_event_name: "Stop", session_id: "stranger" }), {});
      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "Stop", session_id: "held" }, { "x-rokid-provider": "codex" }),
        {},
      );
      assert.equal(daemon.stopWait.state("held").waiting, false);
    },
  );
});

test("daemon_pre_tool_use_resets_the_continuation_cap", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const stop = startStop(httpPort, "held");
      await settle();
      daemon.stopWait.deliver("held", "one", "m1");
      await stop.reply;
      assert.equal(daemon.stopWait.state("held").continuationsLeft, 7);
      await postHook(httpPort, { hook_event_name: "PreToolUse", session_id: "held", tool_name: "Read" });
      assert.equal(daemon.stopWait.state("held").continuationsLeft, 8);
    },
  );
});

test("daemon_detach_releases_the_hold_as_cancelled", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const releases = [];
      daemon.stopWait.onRelease((sessionId, reason) => releases.push(`${sessionId}:${reason}`));
      const stop = startStop(httpPort, "held");
      await settle();
      daemon.attachRegistry.detach("claude", "held");
      assert.deepEqual(await stop.reply, {});
      assert.deepEqual(releases, ["held:cancelled"]);
    },
  );
});

test("daemon_stop_does_not_hang_on_a_held_request", { timeout: 5000 }, async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const stop = startStop(httpPort, "held");
      await settle();
      assert.equal(daemon.stopWait.state("held").waiting, true, "the Stop is really held");
      // The held request must not keep the HTTP server from closing; the
      // harness's own stop afterwards is then a no-op.
      await daemon.stop();
      assert.deepEqual(await stop.reply, {});
    },
  );
});

test("daemon_forwarder_that_dies_releases_the_hold_as_cancelled", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const releases = [];
      daemon.stopWait.onRelease((sessionId, reason) => releases.push(`${sessionId}:${reason}`));
      const body = JSON.stringify({ hook_event_name: "Stop", session_id: "held" });
      const request = http.request({
        host: "127.0.0.1",
        port: httpPort,
        path: "/hook",
        method: "POST",
        headers: { "content-length": Buffer.byteLength(body) },
      });
      request.on("error", () => undefined);
      request.end(body);
      await settle();
      assert.equal(daemon.stopWait.state("held").waiting, true);
      request.destroy();
      await settle();
      assert.equal(daemon.stopWait.state("held").waiting, false);
      assert.deepEqual(releases, ["held:cancelled"]);
    },
  );
});

test("claude_plugin_forwards_every_slash_command_and_the_tool_outcomes", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { hooks } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "plugins", "claude-code", "hooks", "hooks.json"), "utf8"),
  );
  // Any slash command typed at the laptop is the wearer taking over, not only rokid's own.
  assert.equal(hooks.UserPromptExpansion.every((group) => group.matcher === undefined), true);
  for (const event of ["PostToolUse", "PostToolUseFailure", "PermissionDenied"]) {
    const handlers = hooks[event]?.flatMap((group) => group.hooks) ?? [];
    assert.equal(handlers.length, 1, event);
    assert.match(handlers[0].command, /ROKID_CODER_PROVIDER=claude .*hook-forward\.js/, event);
  }
});

test("daemon_another_plugins_slash_command_releases_the_hold_as_laptop", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const releases = [];
      daemon.stopWait.onRelease((sessionId, reason) => releases.push(`${sessionId}:${reason}`));
      const stop = startStop(httpPort, "held");
      await settle();
      assert.equal(daemon.stopWait.state("held").waiting, true);
      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "UserPromptExpansion", command_name: "review:pr", session_id: "held" }),
        {},
      );
      assert.deepEqual(await stop.reply, {});
      assert.deepEqual(releases, ["held:laptop"]);
    },
  );
});
