"use strict";
/**
 * SessionStates and LauncherRouter against a fake launcher port and a sessions
 * file held as a plain object, with the windows shrunk so nothing waits long.
 * The daemon-level routing (real hub, real hooks, the phone) is in
 * launcher-routing.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionStates, LauncherRouter } = require("../dist/launcher/session-state.js");

const KEY = "claude:s1";
const PID = 4242;
const TIMINGS = { readyWaitMs: 400, compactLimitMs: 400, pollMs: 10 };

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 2000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(5);
  }
}

/** The hub as the router sees it, with the launcher's side driven by the test. */
function fakePort() {
  const changes = [];
  const written = [];
  const port = {
    bindings: new Map([[KEY, { gen: 1, claudePid: PID, uncertain: false }]]),
    drafts: new Map(),
    sent: [],
    pending: undefined,
    cancels: [],
    compactDones: [],
    binding: (key) => (port.bindings.has(key) ? { ...port.bindings.get(key) } : undefined),
    boundKeys: () => [...port.bindings.keys()],
    unbound: new Map(),
    unboundReason: (key) => (port.bindings.has(key) ? undefined : port.unbound.get(key)),
    send(key, cmd) {
      const binding = port.bindings.get(key);
      if (!binding) return Promise.resolve({ ok: false, error: "exited" });
      if (port.pending) return Promise.resolve({ ok: false, error: "busy" });
      if (binding.uncertain) return Promise.resolve({ ok: false, error: "uncertain" });
      port.sent.push({ key, gen: binding.gen, ...cmd });
      return new Promise((resolve) => {
        port.pending = { key, cmdId: cmd.cmdId, resolve };
      });
    },
    cancel(key, reason) {
      port.cancels.push(reason);
      port.settle({ ok: false, error: reason });
    },
    commandCancels: [],
    cancelCommand(cmdId) {
      port.commandCancels.push(cmdId);
      if (port.pending?.cmdId === cmdId) port.settle({ ok: false, error: "cancelled" });
    },
    setUncertain(key, uncertain) {
      const binding = port.bindings.get(key);
      if (binding && binding.uncertain !== uncertain) {
        binding.uncertain = uncertain;
        port.emit(key);
      }
    },
    laptopDraft: (key) => port.drafts.get(key) === true,
    submitted: [],
    promptSubmitted: (key, at) => port.submitted.push({ key, at }),
    compactDone: (key, cmdId) => port.compactDones.push(cmdId),
    onChange: (cb) => changes.push(cb),
    onCommandWritten: (cb) => written.push(cb),
    onLateResult: () => undefined,
    // The launcher's side.
    emit: (key) => changes.forEach((cb) => cb(key)),
    written(at) {
      for (const cb of written) cb(port.pending.key, port.pending.cmdId, at);
    },
    settle(result) {
      const pending = port.pending;
      port.pending = undefined;
      pending?.resolve(result);
    },
    /** The same launcher binds anew: the hub settles a pending command cancelled. */
    rebind(key) {
      port.settle({ ok: false, error: "cancelled" });
      port.bindings.get(key).gen += 1;
      port.emit(key);
    },
    /** The launcher's connection closes. */
    drop(key) {
      port.bindings.delete(key);
      port.unbound.set(key, "exited");
      port.settle({ ok: false, error: "exited" });
      port.emit(key);
    },
  };
  return port;
}

function setup({ held = false, asking = false } = {}) {
  const port = fakePort();
  const file = { status: "idle", statusUpdatedAt: Date.now() - 60_000, sessionId: "s1" };
  const flags = { held, asking, subagents: 0, skew: 0 };
  const states = new SessionStates(
    (pid) => (pid === PID ? { ...file } : undefined),
    () => Date.now() + flags.skew,
    {
      binding: (key) => port.binding(key),
      held: () => flags.held,
      asking: () => flags.asking,
      subagents: () => flags.subagents,
      clearUncertain: (key) => port.setUncertain(key, false),
    },
  );
  const router = new LauncherRouter({ port, states, timings: TIMINGS, clock: () => Date.now() + flags.skew });
  return { port, file, flags, states, router };
}

/** Claude writes its sessions file: a strictly newer timestamp than anything so far. */
function claudeWrites(file, status) {
  file.status = status;
  file.statusUpdatedAt = Math.max(file.statusUpdatedAt + 1, Date.now() + 1);
}

test("startup_idle_session_is_ready_without_any_hook", async () => {
  const { port, states, router } = setup();
  // The file's idle is a minute old and no hook ever fired: no latch, so ready.
  assert.equal(states.state(KEY), "ready");
  assert.equal(router.followupState(KEY), "ready");
  const result = router.command(KEY, { command: "model", model: "sonnet" });
  await until(() => port.sent.length === 1, 200, "an immediate dispatch");
  assert.equal("notBefore" in port.sent[0], false);
  port.written(Date.now());
  port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
});

test("first_command_on_idle_session_not_blocked_by_its_own_dispatch", async () => {
  const { port, file, states, router } = setup();
  const result = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1, 200, "the dispatch");
  // Dispatching sets no latch: only the launcher's command_written does, after the write.
  assert.equal(states.latchAt(KEY), undefined);
  assert.equal(port.sent[0].notBefore, undefined);
  const at = Date.now();
  port.written(at);
  assert.equal(states.latchAt(KEY), at);
  port.settle({ ok: true });
  router.onHook(KEY, "PreCompact", { trigger: "manual" });
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  assert.deepEqual(await result, { ok: true });

  // A text command keeps its latch past its ok: the next one waits for a fresh idle.
  const text = router.followup(KEY, "hello", () => assert.fail("not held"));
  await until(() => port.sent.length === 2, 200, "the text dispatch");
  const at2 = Date.now();
  port.written(at2);
  port.settle({ ok: true });
  assert.deepEqual(await text, { ok: true });
  assert.equal(states.state(KEY), "busy", "Claude's last idle is older than the write");
  const next = router.command(KEY, { command: "compact" });
  await settle(60);
  assert.equal(port.sent.length, 2);
  claudeWrites(file, "idle");
  await until(() => port.sent.length === 3, 200, "the next dispatch");
  assert.equal(port.sent[2].notBefore, at2, "the barrier reaches the launcher");
  port.settle({ ok: false, error: "laptop_draft" });
  assert.deepEqual(await next, { ok: false, error: "laptop_draft" });
});

test("two_consecutive_model_commands_both_run", async () => {
  const { port, states, router } = setup();
  const first = router.command(KEY, { command: "model", model: "sonnet" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  port.settle({ ok: true });
  assert.deepEqual(await first, { ok: true });
  // /model may never flip Claude's status; its ok cleared the latch.
  assert.equal(states.latchAt(KEY), undefined);
  const second = router.command(KEY, { command: "model", model: "haiku" });
  await until(() => port.sent.length === 2, 200, "the second dispatch, without a fresh idle");
  assert.equal(port.sent[1].model, "haiku");
  assert.equal("notBefore" in port.sent[1], false);
  port.written(Date.now());
  port.settle({ ok: true });
  assert.deepEqual(await second, { ok: true });
});

test("silent_busy_period_does_not_count_as_idle", async () => {
  const { port, file, states, router } = setup();
  claudeWrites(file, "busy");
  // Busy, no output, no hooks: time alone never makes it ready.
  const result = router.command(KEY, { command: "compact" });
  await settle(200);
  assert.equal(states.state(KEY), "busy");
  assert.equal(port.sent.length, 0);
  claudeWrites(file, "idle");
  await until(() => port.sent.length === 1, 200, "the dispatch once idle");
  port.settle({ ok: false, error: "taken_over" });
  assert.deepEqual(await result, { ok: false, error: "taken_over" });
});

test("busy_until_the_readiness_window_ends_is_rejected_busy", async () => {
  const { port, file, router } = setup();
  claudeWrites(file, "busy");
  const started = Date.now();
  assert.deepEqual(await router.command(KEY, { command: "compact" }), { ok: false, error: "busy" });
  assert.ok(Date.now() - started >= TIMINGS.readyWaitMs);
  assert.equal(port.sent.length, 0);
});

test("pending_approval_or_question_is_busy", async () => {
  const { states, flags } = setup({ asking: true });
  assert.equal(states.state(KEY), "busy");
  flags.asking = false;
  assert.equal(states.state(KEY), "ready");
});

test("auto_compact_does_not_complete_launcher_compact", async () => {
  const { port, router } = setup();
  // A manual compact that started before this dispatch is not this one.
  router.onHook(KEY, "PreCompact", { trigger: "manual" });
  const result = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  port.settle({ ok: true });
  router.onHook(KEY, "PreCompact", { trigger: "auto" });
  router.onHook(KEY, "PostCompact", { trigger: "auto" });
  assert.deepEqual(await result, { ok: false, error: "timeout", consumed: true });
  assert.deepEqual(port.compactDones, []);
});

test("compact_applied_only_on_post_compact_of_same_generation", async () => {
  const { port, states, router } = setup();
  const result = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1);
  const { cmdId } = port.sent[0];
  port.written(Date.now());
  port.settle({ ok: true });
  // A PostCompact with no manual PreCompact before it completes nothing.
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  await settle();
  assert.deepEqual(port.compactDones, []);
  // Another session's hooks are not this one's.
  router.onHook("claude:other", "PreCompact", { trigger: "manual" });
  router.onHook("claude:other", "PostCompact", { trigger: "manual" });
  await settle();
  assert.deepEqual(port.compactDones, []);
  router.onHook(KEY, "PreCompact", { trigger: "manual" });
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  assert.deepEqual(await result, { ok: true });
  assert.deepEqual(port.compactDones, [cmdId], "compact_done names the command");
  assert.equal(states.latchAt(KEY), undefined);

  // The manual PreCompact came under gen 1; the binding is gen 2 before its PostCompact.
  const second = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 2);
  port.written(Date.now());
  port.settle({ ok: true });
  router.onHook(KEY, "PreCompact", { trigger: "manual" });
  port.rebind(KEY);
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  assert.deepEqual(await second, { ok: false, error: "cancelled", consumed: true });
  assert.equal(port.compactDones.length, 1);
});

test("compact_timeout_rejected", async () => {
  const { port, file, router } = setup();
  // The launcher typed it but Claude never reported the compact.
  const typed = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  port.settle({ ok: true });
  assert.deepEqual(await typed, { ok: false, error: "timeout", consumed: true });
  assert.deepEqual(port.compactDones, []);
  // R148: past its ok, the launcher is told agentd gave up on it.
  assert.deepEqual(port.commandCancels, [port.sent[0].cmdId]);

  // The launcher never answers at all: the hub has no timeout, so the router cancels it.
  claudeWrites(file, "idle");
  const silent = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 2);
  assert.deepEqual(await silent, { ok: false, error: "timeout" });
  assert.deepEqual(port.commandCancels.slice(1), [port.sent[1].cmdId]);
  assert.equal(port.pending, undefined);
});

test("uncertain_binding_rejects_until_laptop_prompt", async () => {
  const { port, file, states, router } = setup();
  const model = router.command(KEY, { command: "model", model: "opus" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  port.settle({ ok: false, error: "dialog_not_seen" });
  assert.deepEqual(await model, { ok: false, error: "dialog_not_seen", consumed: true });
  assert.equal(port.binding(KEY).uncertain, true, "R141: the launcher is told");

  for (const cmd of [{ command: "compact" }, { command: "model", model: "sonnet" }]) {
    assert.deepEqual(await router.command(KEY, cmd), { ok: false, error: "uncertain" });
  }
  assert.deepEqual(await router.followup(KEY, "hi", () => assert.fail("not held")), { ok: false, error: "uncertain" });
  assert.equal(port.sent.length, 1, "nothing more was typed");
  assert.equal(router.followupState(KEY), "unavailable");

  // The wearer types at the laptop: that clears it.
  router.onHook(KEY, "UserPromptSubmit", { prompt: "/model sonnet" });
  assert.equal(port.binding(KEY).uncertain, false);
  claudeWrites(file, "idle");
  const after = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 2, 200, "a command once certain again");
  port.settle({ ok: false, error: "busy" });
  await after;

  // So does Claude's own idle newer than the write that left it uncertain.
  const again = router.command(KEY, { command: "model", model: "opus" });
  await until(() => port.sent.length === 3);
  port.written(Date.now());
  port.settle({ ok: false, error: "taken_over" });
  await again;
  assert.equal(port.binding(KEY).uncertain, true, "taken_over after the write is uncertain too");
  assert.equal(states.state(KEY), "busy");
  claudeWrites(file, "idle");
  assert.equal(states.state(KEY), "ready");
  assert.equal(port.binding(KEY).uncertain, false);
});

test("model_failure_before_any_write_is_not_uncertain", async () => {
  const { port, router } = setup();
  const model = router.command(KEY, { command: "model", model: "opus" });
  await until(() => port.sent.length === 1);
  port.settle({ ok: false, error: "cancelled" });
  assert.deepEqual(await model, { ok: false, error: "cancelled" });
  assert.equal(port.binding(KEY).uncertain, false);
});

test("model_applied_after_typist_ok", async () => {
  const { port, router } = setup();
  const result = router.command(KEY, { command: "model", model: "sonnet" });
  await until(() => port.sent.length === 1);
  assert.deepEqual(
    { command: port.sent[0].command, model: port.sent[0].model, gen: port.sent[0].gen },
    { command: "model", model: "sonnet", gen: 1 },
  );
  let done = false;
  void result.then(() => (done = true));
  port.written(Date.now());
  await settle();
  assert.equal(done, false, "the write alone is not applied");
  port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
});

test("no_type_command_while_held", async () => {
  const { port, flags, states, router } = setup({ held: true });
  assert.equal(states.state(KEY), "held");
  assert.equal(router.followupState(KEY), "waiting");
  assert.deepEqual(await router.command(KEY, { command: "compact" }), { ok: false, error: "busy" });
  assert.deepEqual(await router.command(KEY, { command: "model", model: "opus" }), { ok: false, error: "busy" });
  assert.equal(port.sent.length, 0);
  flags.held = false;
  assert.equal(states.state(KEY), "ready");
});

test("followup_while_held_uses_stop_hook", async () => {
  const { port, router } = setup({ held: true });
  let delivered = 0;
  assert.deepEqual(await router.followup(KEY, "go on", () => (delivered += 1, { ok: true })), { ok: true });
  assert.equal(delivered, 1);
  assert.equal(port.sent.length, 0);
});

test("followup_after_y_types_when_idle", async () => {
  const { port, router } = setup();
  const result = router.followup(KEY, "late reply", () => assert.fail("nothing is held"));
  await until(() => port.sent.length === 1);
  assert.deepEqual({ command: port.sent[0].command, text: port.sent[0].text }, { command: "text", text: "late reply" });
  port.written(Date.now());
  port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
});

test("busy_followup_waits_for_a_held_stop_or_idle", async () => {
  const { port, file, flags, router } = setup();
  claudeWrites(file, "busy");
  let delivered = 0;
  const result = router.followup(KEY, "next", () => (delivered += 1, { ok: true }));
  await settle(80);
  // Claude's turn ends and its Stop is held: the hook takes it, nothing is typed.
  flags.held = true;
  assert.deepEqual(await result, { ok: true });
  assert.equal(delivered, 1);
  assert.equal(port.sent.length, 0);
});

test("rebind_during_wait_cancels_and_rejects_cancelled", async () => {
  const { port, file, router } = setup();
  claudeWrites(file, "busy");
  const waiting = router.command(KEY, { command: "compact" });
  await settle(50);
  port.rebind(KEY);
  assert.deepEqual(await waiting, { ok: false, error: "cancelled" });
  assert.equal(port.sent.length, 0);

  // While running, the hub settles it cancelled; nothing waits on.
  claudeWrites(file, "idle");
  const running = router.command(KEY, { command: "model", model: "opus" });
  await until(() => port.sent.length === 1);
  port.rebind(KEY);
  assert.deepEqual(await running, { ok: false, error: "cancelled" });

  // A session end while waiting, too.
  claudeWrites(file, "busy");
  const ended = router.command(KEY, { command: "compact" });
  await settle(50);
  router.endSession(KEY);
  assert.deepEqual(await ended, { ok: false, error: "cancelled" });
});

test("launcher_exit_while_waiting_or_compacting_is_exited", async () => {
  const { port, file, router } = setup();
  const compact = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  port.settle({ ok: true });
  port.drop(KEY);
  assert.deepEqual(await compact, { ok: false, error: "exited", consumed: true });
  assert.equal(router.isBound(KEY), false);
  assert.deepEqual(await router.command(KEY, { command: "compact" }), { ok: false, error: "not_launcher" });

  port.bindings.set(KEY, { gen: 5, claudePid: PID, uncertain: false });
  claudeWrites(file, "busy");
  const waiting = router.command(KEY, { command: "compact" });
  await settle(50);
  port.drop(KEY);
  assert.deepEqual(await waiting, { ok: false, error: "exited" });
});

test("commands_are_serialised_through_completion", async () => {
  const { port, router } = setup();
  const first = router.command(KEY, { command: "compact" });
  await until(() => port.sent.length === 1);
  port.written(Date.now());
  port.settle({ ok: true });
  // The compact is typed but not yet complete: the model change waits for it.
  const second = router.command(KEY, { command: "model", model: "haiku" });
  await settle(80);
  assert.equal(port.sent.length, 1);
  router.onHook(KEY, "PreCompact", { trigger: "manual" });
  router.onHook(KEY, "PostCompact", { trigger: "manual" });
  assert.deepEqual(await first, { ok: true });
  await until(() => port.sent.length === 2, 200, "the model change after the compact");
  port.settle({ ok: true });
  assert.deepEqual(await second, { ok: true });
});

test("a_session_file_for_another_session_is_not_ready", async () => {
  const { file, states } = setup();
  file.sessionId = "someone-else";
  assert.equal(states.state(KEY), "busy");
});

test("laptop_draft_makes_followup_unavailable", async () => {
  const { port, router } = setup();
  port.drafts.set(KEY, true);
  assert.equal(router.followupState(KEY), "unavailable");
  port.drafts.set(KEY, false);
  assert.equal(router.followupState(KEY), "ready");
});

test("model_ok_keeps_a_latch_newer_than_its_own_write", async () => {
  const { port, states, router } = setup();
  const result = router.command(KEY, { command: "model", model: "opus" });
  await until(() => port.sent.length === 1, 200, "the dispatch");
  const at = Date.now();
  port.written(at);
  // A Stop delivery while the model command runs latches later than its write.
  states.latch(KEY, at + 500);
  port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
  assert.equal(states.latchAt(KEY), at + 500);

  // With nothing newer, the ok clears the command's own latch.
  const { port: port2, states: states2, router: router2 } = setup();
  const second = router2.command(KEY, { command: "model", model: "haiku" });
  await until(() => port2.sent.length === 1, 200, "the dispatch");
  port2.written(Date.now());
  port2.settle({ ok: true });
  assert.deepEqual(await second, { ok: true });
  assert.equal(states2.latchAt(KEY), undefined);
});

// The background-subagent exception: Claude's file says busy while a subagent
// runs, the main prompt is free, and agentd knows it from hooks.

const backgroundSession = (flags = { subagents: 1 }) => {
  const ctx = setup();
  claudeWrites(ctx.file, "busy");
  ctx.flags.subagents = flags.subagents;
  return ctx;
};
const stopAfterPrompt = (router) => {
  router.onHook(KEY, "UserPromptSubmit", { prompt: "go" });
  router.onHook(KEY, "Stop", {});
};

test("busy_file_with_a_stop_after_the_prompt_and_a_running_subagent_is_ready", () => {
  const { states, router } = backgroundSession();
  assert.equal(states.state(KEY), "busy", "no Stop seen yet");
  stopAfterPrompt(router);
  assert.equal(states.state(KEY), "ready");
  assert.equal(router.followupState(KEY), "ready");
  assert.equal(router.followupWhy(KEY), undefined);
});

test("busy_file_with_no_stop_since_the_prompt_is_not_ready", () => {
  const { states, router } = backgroundSession();
  router.onHook(KEY, "Stop", {});
  router.onHook(KEY, "UserPromptSubmit", { prompt: "again" });
  assert.equal(states.state(KEY), "busy");
  assert.equal(router.followupState(KEY), "unavailable");
  assert.equal(router.followupWhy(KEY), "busy");
});

test("busy_file_with_no_running_subagent_is_not_ready", () => {
  const { states, router } = backgroundSession({ subagents: 0 });
  stopAfterPrompt(router);
  assert.equal(states.state(KEY), "busy");
  assert.equal(router.followupWhy(KEY), "busy");
});

test("main_thread_work_after_the_stop_makes_it_busy_again", () => {
  for (const [event, payload] of [
    ["UserPromptSubmit", { prompt: "more" }],
    ["PreToolUse", { tool_name: "Bash" }],
    ["PermissionRequest", { tool_name: "Bash" }],
    ["Notification", { message: "Claude needs your permission to use Bash" }],
    ["SubagentStop", { agent_id: "a1" }],
  ]) {
    const { states, router } = backgroundSession();
    stopAfterPrompt(router);
    assert.equal(states.state(KEY), "ready", event);
    router.onHook(KEY, event, payload);
    assert.equal(states.state(KEY), "busy", `${event} after the Stop`);
    router.onHook(KEY, "Stop", {});
    assert.equal(states.state(KEY), "ready", `${event}, then a new Stop`);
  }
});

test("a_subagents_own_tool_calls_and_the_idle_notice_do_not_end_readiness", () => {
  const { states, router } = backgroundSession();
  stopAfterPrompt(router);
  router.onHook(KEY, "PreToolUse", { tool_name: "Grep", agent_id: "a1" });
  router.onHook(KEY, "PermissionRequest", { tool_name: "Bash", agent_id: "a1" });
  router.onHook(KEY, "Notification", { message: "Claude is waiting for your input" });
  assert.equal(states.state(KEY), "ready");
});

test("a_stop_older_than_six_hours_is_not_trusted", () => {
  const { states, router, flags } = backgroundSession();
  stopAfterPrompt(router);
  flags.skew = 6 * 60 * 60_000 + 1000;
  assert.equal(states.state(KEY), "busy");
});

test("laptop_draft_and_other_conditions_still_block_the_background_ready_state", () => {
  const { states, router, port, flags, file } = backgroundSession();
  stopAfterPrompt(router);
  port.drafts.set(KEY, true);
  assert.equal(router.followupState(KEY), "unavailable");
  assert.equal(router.followupWhy(KEY), "draft");
  port.drafts.set(KEY, false);
  flags.asking = true;
  assert.equal(states.state(KEY), "busy");
  flags.asking = false;
  port.bindings.get(KEY).uncertain = true;
  assert.equal(states.state(KEY), "busy");
  assert.equal(router.followupWhy(KEY), "busy");
  port.bindings.get(KEY).uncertain = false;
  assert.equal(states.state(KEY), "ready");
  file.sessionId = "someone-else";
  assert.equal(states.state(KEY), "busy");
});

test("a_file_that_is_neither_idle_nor_busy_never_takes_the_exception", () => {
  const { states, router, file } = backgroundSession();
  stopAfterPrompt(router);
  file.status = "waiting";
  assert.equal(states.state(KEY), "busy");
});

test("compact_and_model_still_need_the_files_own_idle", async () => {
  const { port, states, router } = backgroundSession();
  stopAfterPrompt(router);
  assert.equal(states.state(KEY), "ready");
  assert.deepEqual(await router.command(KEY, { command: "model", model: "opus" }), { ok: false, error: "busy" });
  assert.equal(port.sent.length, 0);
});

test("text_typed_on_hook_evidence_is_accepted_by_a_prompt_and_ready_again_after_the_next_stop", async () => {
  const { port, states, router } = backgroundSession();
  stopAfterPrompt(router);
  const result = router.followup(KEY, "from the glasses", () => assert.fail("nothing is held"));
  await until(() => port.sent.length === 1, 200, "the dispatch");
  assert.equal(port.sent[0].viaHooks, true, "the launcher may type with the file busy");
  assert.equal("notBefore" in port.sent[0], false);
  const at = Date.now();
  port.written(at);
  port.settle({ ok: true });
  // Typed, but not seen accepted: no success is claimed yet, and no second command is let in.
  await settle(60);
  let done = false;
  result.then(() => (done = true));
  await settle(30);
  assert.equal(done, false);
  assert.equal(states.state(KEY), "busy");
  router.onHook(KEY, "UserPromptSubmit", { prompt: "something else entirely" });
  assert.deepEqual(await result, { ok: true });
  assert.equal(states.state(KEY), "busy", "the file stays busy and the turn has not stopped");
  router.onHook(KEY, "Stop", {});
  assert.equal(states.state(KEY), "ready");
  assert.equal(router.followupState(KEY), "ready");
});

test("typed_on_hook_evidence_but_never_accepted_fails_as_consumed_timeout_and_is_not_retyped", async () => {
  const { port, states, flags } = backgroundSession();
  const router = new LauncherRouter({ port, states, timings: { ...TIMINGS, resultSlackMs: 60, cancelSettleMs: 10 } });
  stopAfterPrompt(router);
  const result = router.followup(KEY, "lost", () => assert.fail("nothing is held"));
  await until(() => port.sent.length === 1, 200, "the dispatch");
  port.written(Date.now());
  port.settle({ ok: true });
  // No UserPromptSubmit ever shows: the command was typed, so it is consumed, and success is not claimed.
  assert.deepEqual(await result, { ok: false, error: "timeout", consumed: true });
  assert.equal(port.sent.length, 1, "never retyped");
  assert.equal(states.claimed(KEY), false);
  assert.equal(flags.subagents, 1);
});

test("failure_paths_of_a_hook_typed_command_are_the_existing_ones", async () => {
  const { port, router } = backgroundSession();
  stopAfterPrompt(router);
  const result = router.followup(KEY, "refused", () => assert.fail("nothing is held"));
  await until(() => port.sent.length === 1, 200, "the dispatch");
  port.settle({ ok: false, error: "laptop_draft" });
  assert.deepEqual(await result, { ok: false, error: "laptop_draft" });
});

test("delivering_a_held_stop_ends_background_readiness_at_once", async () => {
  const { states, router } = backgroundSession();
  stopAfterPrompt(router);
  router.onStopDelivered(KEY);
  assert.equal(states.state(KEY), "busy");
});

test("a_write_newer_than_the_stop_ends_background_readiness", () => {
  const { states, router } = backgroundSession();
  stopAfterPrompt(router);
  states.latch(KEY, Date.now());
  assert.equal(states.state(KEY), "busy");
  router.onHook(KEY, "Stop", {});
  assert.equal(states.state(KEY), "ready");
});
