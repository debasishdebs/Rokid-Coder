"use strict";
/**
 * The opt-in background reply, on the agentd side: SessionStates' hook evidence,
 * and the router that dispatches, revokes and re-checks it at the write
 * boundary, against a fake launcher port. Fakes only; the daemon-level run is
 * in launcher-routing.test.js, the launcher's own half in typist-bg.test.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SessionStates, LauncherRouter, BACKGROUND_STOP_FRESH_MS } = require("../dist/launcher/session-state.js");

const KEY = "claude:s1";
const PID = 4242;
const TIMINGS = { readyWaitMs: 400, compactLimitMs: 400, pollMs: 10, bgAcceptMs: 150 };

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, ms = 2000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(5);
  }
}

function fakePort() {
  const lateListeners = [];
  const changes = [];
  const written = [];
  const port = {
    bindings: new Map([[KEY, { gen: 1, claudePid: PID, uncertain: false }]]),
    drafts: new Map(),
    sent: [],
    pending: undefined,
    commandCancels: [],
    binding: (key) => (port.bindings.has(key) ? { ...port.bindings.get(key) } : undefined),
    boundKeys: () => [...port.bindings.keys()],
    unboundReason: () => undefined,
    send(key, cmd) {
      port.sent.push({ key, ...cmd });
      return new Promise((resolve) => {
        port.pending = { key, cmdId: cmd.cmdId, resolve };
      });
    },
    cancel() {},
    cancelCommand(cmdId) {
      port.commandCancels.push(cmdId);
      if (port.pending?.cmdId === cmdId) port.settle({ ok: false, error: "cancelled" });
    },
    setUncertain(key, uncertain) {
      port.bindings.get(key).uncertain = uncertain;
    },
    laptopDraft: (key) => port.drafts.get(key) === true,
    promptSubmitted() {},
    compactDone() {},
    onChange: (cb) => changes.push(cb),
    onCommandWritten: (cb) => written.push(cb),
    onLateResult: (cb) => lateListeners.push(cb),
    /** The launcher's own result for a command agentd had already cancelled. */
    late(cmdId, ok, error) {
      lateListeners.forEach((cb) => cb(cmdId, ok, error));
    },
    onWriteCheck: (cb) => {
      port.checker = cb;
    },
    emit: (key) => changes.forEach((cb) => cb(key)),
    /** The launcher pastes. */
    wrote(at = Date.now()) {
      for (const cb of written) cb(port.pending.key, port.pending.cmdId, at);
    },
    check: (phase, cmdId = port.pending?.cmdId) => port.checker(KEY, cmdId, phase),
    settle(result) {
      const pending = port.pending;
      port.pending = undefined;
      pending?.resolve(result);
    },
  };
  return port;
}

/** A session at the point a background reply could be typed: file busy, a Stop, a subagent, auto mode, switch on. */
function setup({ mode = "auto", switchOn = true, subagents = 1, stop = true, hookMode, approvalSource = true, log } = {}) {
  const port = fakePort();
  // Real time, but movable: a frozen clock would never reach the readiness deadline.
  const clock = {
    offset: 0,
    get t() {
      return Date.now() + this.offset;
    },
    set t(value) {
      this.offset = value - Date.now();
    },
  };
  const file = { status: "busy", statusUpdatedAt: clock.t - 5000, sessionId: "s1" };
  // `approvals` is what the approval manager reports; `asking` is that or a question.
  const flags = { held: false, asking: false, approvals: false, subagents, bg: switchOn };
  const states = new SessionStates(
    (pid) => (pid === PID ? { ...file } : undefined),
    () => clock.t,
    {
      binding: (key) => port.binding(key),
      held: () => flags.held,
      asking: () => flags.asking || flags.approvals,
      clearUncertain: (key) => port.setUncertain(key, false),
      subagents: () => flags.subagents,
      ...(approvalSource ? { approvalPending: () => flags.approvals } : {}),
    },
  );
  const router = new LauncherRouter({
    port,
    states,
    clock: () => clock.t,
    timings: TIMINGS,
    bgReplies: () => flags.bg,
    ...(log ? { log } : {}),
  });
  const hook = (event, extra = {}) =>
    router.onHook(KEY, event, { permission_mode: hookMode ?? mode, ...extra });
  hook("UserPromptSubmit", { prompt: "go" });
  hook("SubagentStart", { agent_id: "bg1" });
  if (stop) hook("Stop");
  return { port, clock, file, flags, states, router, hook };
}

const ready = (t) => t.router.followupState(KEY) === "ready";

// ---- the whole matrix of evidence ------------------------------------------------

test("all_evidence_present_means_ready_and_no_reason", () => {
  const t = setup();
  assert.equal(t.router.followupState(KEY), "ready");
  assert.equal(t.router.followupWhy(KEY, 1), undefined);
});

test("switch_off_says_bg_off_and_is_not_ready", () => {
  const t = setup({ switchOn: false });
  assert.equal(t.router.followupState(KEY), "unavailable");
  assert.equal(t.router.followupWhy(KEY, 1), "bg_off");
});

test("auto_bypassPermissions_acceptEdits_dontAsk_and_default_pass_the_mode_gate", () => {
  for (const mode of ["auto", "bypassPermissions", "acceptEdits", "dontAsk", "default"]) {
    const t = setup({ mode });
    assert.equal(ready(t), true, mode);
    assert.equal(t.router.followupWhy(KEY, 1), undefined, mode);
  }
});

test("plan_and_unknown_modes_say_mode_not_allowed", () => {
  for (const mode of ["plan", "mystery", "", "AUTO", "manual"]) {
    const t = setup({ mode });
    assert.equal(ready(t), false, mode);
    assert.equal(t.router.followupWhy(KEY, 1), "mode_not_allowed", mode);
  }
});

test("outside_auto_and_bypassPermissions_the_approval_source_must_exist_and_say_none", () => {
  for (const mode of ["acceptEdits", "dontAsk", "default"]) {
    const missing = setup({ mode, approvalSource: false });
    assert.equal(ready(missing), false, `${mode} without the source`);
    assert.equal(missing.router.followupWhy(KEY, 1), "mode_not_allowed", mode);
    const pending = setup({ mode });
    pending.flags.approvals = true;
    assert.equal(ready(pending), false, `${mode} with an approval pending`);
  }
  // Auto and bypassPermissions never stop to ask, so they need no such source.
  for (const mode of ["auto", "bypassPermissions"]) {
    assert.equal(ready(setup({ mode, approvalSource: false })), true, mode);
  }
});

test("a_pending_approval_from_a_subagent_or_any_permission_prompt_revokes_in_every_mode", () => {
  for (const mode of ["auto", "default", "acceptEdits", "dontAsk"]) {
    for (const [event, extra] of [
      ["PermissionRequest", { tool_name: "Bash", agent_id: "bg1" }],
      ["PermissionRequest", { tool_name: "Bash" }],
      ["Notification", { notification_type: "permission_prompt", agent_id: "bg1" }],
      ["Notification", { notification_type: "elicitation_dialog" }],
      ["Notification", { notification_type: "elicitation_dialog", agent_id: "bg1" }],
    ]) {
      const t = setup({ mode });
      t.hook(event, extra);
      assert.equal(ready(t), false, `${mode} ${event} ${JSON.stringify(extra)}`);
      // Only a Stop after it gives the evidence back.
      t.hook("Stop");
      assert.equal(ready(t), true, `${mode} after a later Stop`);
    }
  }
});

test("an_unknown_or_missing_mode_is_refused_and_the_latest_main_thread_hook_decides", () => {
  const t = setup({ stop: false });
  // The Stop itself carries no permission_mode: the mode is unknown.
  t.router.onHook(KEY, "Stop", {});
  assert.equal(ready(t), false);
  assert.equal(t.router.followupWhy(KEY, 1), "mode_not_allowed");
  // A subagent's hook never tells the main thread's mode.
  t.router.onHook(KEY, "Notification", { permission_mode: "auto", agent_id: "bg1", notification_type: "idle_prompt" });
  assert.equal(ready(t), false);
  // A later main-thread hook that says auto restores it.
  t.router.onHook(KEY, "Notification", { permission_mode: "auto", notification_type: "idle_prompt" });
  assert.equal(ready(t), true);
  // Shift+Tab to plan mode: the next hook says so.
  t.router.onHook(KEY, "Notification", { permission_mode: "plan", notification_type: "idle_prompt" });
  assert.equal(ready(t), false);
  assert.equal(t.router.followupWhy(KEY, 1), "mode_not_allowed");
});

test("each_other_missing_item_makes_it_not_ready_and_gives_the_ordinary_reason", () => {
  const cases = {
    "no Stop seen": () => setup({ stop: false }),
    "no running subagent": () => setup({ subagents: 0 }),
    "file idle takes the ordinary path": (t = setup()) => {
      t.file.status = "idle";
      return t;
    },
    "file waiting": (t = setup()) => {
      t.file.status = "waiting";
      return t;
    },
    "file of another session": (t = setup()) => {
      t.file.sessionId = "other";
      return t;
    },
    "file without a session id": (t = setup()) => {
      delete t.file.sessionId;
      return t;
    },
    held: (t = setup()) => {
      t.flags.held = true;
      return t;
    },
    asking: (t = setup()) => {
      t.flags.asking = true;
      return t;
    },
    uncertain: (t = setup()) => {
      t.port.bindings.get(KEY).uncertain = true;
      return t;
    },
    unbound: (t = setup()) => {
      t.port.bindings.delete(KEY);
      return t;
    },
    "Stop older than 6 hours": (t = setup()) => {
      t.clock.t += BACKGROUND_STOP_FRESH_MS + 1;
      return t;
    },
    "clock moved back": (t = setup()) => {
      t.clock.t -= 1000;
      return t;
    },
  };
  for (const [what, build] of Object.entries(cases)) {
    const t = build();
    const bgReady = t.router.followupState(KEY) === "ready" && t.file.status === "busy";
    assert.equal(bgReady, false, what);
    assert.notEqual(t.router.followupWhy(KEY, 1), "bg_off", what);
    assert.notEqual(t.router.followupWhy(KEY, 1), "mode_not_allowed", what);
  }
  const draft = setup();
  draft.port.drafts.set(KEY, true);
  assert.equal(draft.router.followupState(KEY), "unavailable");
  assert.equal(draft.router.followupWhy(KEY, 1), "draft");
  const background = setup({ stop: false });
  assert.equal(background.router.followupWhy(KEY, 1), "background");
  const idleOnly = setup({ stop: false, subagents: 0 });
  assert.equal(idleOnly.router.followupWhy(KEY, 0), "busy");
});

test("an_idle_file_takes_the_release_path_and_stays_ready_without_any_hook_evidence", () => {
  const t = setup({ stop: false, switchOn: false, mode: "default" });
  t.file.status = "idle";
  assert.equal(t.router.followupState(KEY), "ready");
  assert.equal(t.router.followupWhy(KEY, 1), undefined);
});

// ---- what takes the Stop evidence away -------------------------------------------

test("main_thread_work_and_non_quiet_notifications_take_the_stop_away", () => {
  const takes = [
    ["UserPromptSubmit", { prompt: "x" }],
    ["PermissionRequest", { tool_name: "Bash" }],
    ["PermissionRequest", { tool_name: "Bash", agent_id: "bg1" }],
    ["Elicitation", { server: "x" }],
    ["PermissionDenied", { tool_name: "Bash" }],
    ["Notification", { notification_type: "permission_prompt" }],
    ["Notification", { notification_type: "elicitation_dialog" }],
    ["Notification", { notification_type: "elicitation_url_dialog" }],
    ["Notification", { notification_type: "agent_needs_input", agent_id: "bg1" }],
    ["Notification", { notification_type: "a_type_nobody_knew" }],
    ["Notification", {}],
    ["Notification", { message: "Claude is waiting for your input" }],
    ["Stop", { stop_hook_active: true }],
    ["Stop", { stop_hook_active: "yes" }],
    ["PreCompact", { trigger: "auto" }],
  ];
  for (const [event, extra] of takes) {
    const t = setup();
    assert.equal(ready(t), true, event);
    t.hook(event, extra);
    assert.equal(ready(t), false, `${event} ${JSON.stringify(extra)}`);
  }
});

test("background_agents_finishing_and_benign_notifications_leave_the_stop_alone", () => {
  const leaves = [
    ["SubagentStop", { agent_id: "bg1" }],
    ["SubagentStop", {}],
    ["Notification", { notification_type: "idle_prompt" }],
    ["Notification", { notification_type: "auth_success" }],
    ["Notification", { notification_type: "agent_completed" }],
    ["Notification", { notification_type: "plugin_notification" }],
    ["Notification", { notification_type: "elicitation_complete" }],
    ["Notification", { notification_type: "quota_auto_resume_fired" }],
    ["PreToolUse", { tool_name: "Bash", agent_id: "bg1" }],
    ["PostToolUse", { agent_id: "bg1" }],
    ["SubagentStart", { agent_id: "bg2" }],
  ];
  for (const mode of ["auto", "default"]) {
    for (const [event, extra] of leaves) {
      const t = setup({ mode });
      t.hook(event, extra);
      assert.equal(ready(t), true, `${mode} ${event} ${JSON.stringify(extra)}`);
    }
  }
});

test("main_thread_tool_use_revokes_only_where_a_tool_can_open_a_dialog", () => {
  for (const [mode, revokes] of [
    ["auto", false],
    ["bypassPermissions", false],
    ["default", true],
    ["acceptEdits", true],
    ["dontAsk", true],
  ]) {
    for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      const t = setup({ mode });
      t.hook(event, { tool_name: "Bash" });
      assert.equal(ready(t), !revokes, `${mode} ${event}`);
    }
  }
  // A turn of the main thread revokes in every mode, tool use or not.
  for (const mode of ["auto", "bypassPermissions", "default"]) {
    const t = setup({ mode });
    t.hook("UserPromptSubmit", { prompt: "a background task finished" });
    assert.equal(ready(t), false, mode);
  }
});

test("the_file_may_say_busy_or_shell_and_nothing_else", () => {
  for (const status of ["busy", "shell"]) {
    const t = setup();
    t.file.status = status;
    assert.equal(ready(t), true, status);
    assert.equal(t.router.followupWhy(KEY, 1), undefined, status);
  }
  for (const status of ["waiting", "starting", "SHELL", "", "mystery", "idle_busy"]) {
    const t = setup();
    t.file.status = status;
    assert.equal(ready(t), false, JSON.stringify(status));
    assert.equal(t.states.bgPicture(KEY).eligible, false, JSON.stringify(status));
  }
  // No status at all (an unreadable or missing file) is unknown, and unknown is refused.
  const t = setup();
  delete t.file.status;
  assert.equal(ready(t), false);
  // `idle` is the ordinary path, which needs no hook evidence.
  const idle = setup({ stop: false, switchOn: false, mode: "plan" });
  idle.file.status = "idle";
  assert.equal(idle.router.followupState(KEY), "ready");
});

test("a_session_sitting_in_shell_takes_a_background_reply_end_to_end", async () => {
  const t = setup();
  t.file.status = "shell";
  const { result, cmd } = await dispatch(t);
  assert.equal(cmd.bgReply, true);
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  // The file moves from shell to busy while the reply waits for its Enter: still allowed.
  t.file.status = "busy";
  assert.equal(t.port.check("enter"), true);
  t.port.settle({ ok: true });
  t.hook("UserPromptSubmit", { prompt: "yes do it" });
  assert.deepEqual(await result, { ok: true });
});

test("bg_decision_is_logged_once_per_change_with_the_first_failing_rule_and_the_raw_status", () => {
  const logs = [];
  const t = setup({ stop: false, log: (event, meta) => logs.push({ event, ...meta }) });
  const rules = () => logs.filter((l) => l.event === "bg_decision").map((l) => `${l.rule}|${l.fileStatus}`);
  t.router.bgRepliesChanged();
  // The prompt the setup began with took any Stop away, and the log says so.
  assert.equal(rules().at(-1), "stop_revoked_by:UserPromptSubmit|busy");
  // Looking again at the same answer says nothing: not per poll.
  const lines = logs.length;
  t.router.bgRepliesChanged();
  t.router.bgRepliesChanged();
  t.router.onHook(KEY, "Notification", { permission_mode: "auto", notification_type: "idle_prompt" });
  assert.equal(logs.length, lines);
  t.hook("Stop");
  t.router.bgRepliesChanged();
  assert.deepEqual(rules().at(-1), "ready|busy");
  t.file.status = "shell";
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "ready|shell", "the raw status is in the line");
  t.file.status = "starting_up";
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "file_status:starting_up|starting_up");
  t.file.status = "busy";
  t.hook("Notification", { notification_type: "permission_prompt" });
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "stop_revoked_by:Notification:permission_prompt|busy");
  t.hook("Stop");
  t.flags.bg = false;
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "switch_off|busy");
  t.flags.bg = true;
  t.flags.subagents = 0;
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "no_running_subagent|busy");
  t.flags.subagents = 1;
  t.flags.approvals = true;
  t.router.bgRepliesChanged();
  assert.equal(rules().at(-1), "approval_pending|busy");
  const last = logs.at(-1);
  assert.deepEqual(
    [last.session, last.answer, last.mode, last.runningSubagents, typeof last.secondsSinceStop],
    [KEY, "refused", "auto", 1, "number"],
  );
  assert.equal(JSON.stringify(logs).includes("go"), false, "names, a status and numbers; no prompt text");
});

test("bg_decision_names_each_rule_in_the_documented_order", () => {
  const first = (build) => {
    const logs = [];
    const t = build((event, meta) => logs.push({ event, ...meta }));
    t.router.bgRepliesChanged();
    return logs.at(-1).rule;
  };
  assert.equal(first((log) => setup({ switchOn: false, mode: "plan", subagents: 0, stop: false, log })), "switch_off");
  assert.equal(first((log) => setup({ mode: "plan", subagents: 0, stop: false, log })), "mode_not_allowed:plan");
  assert.equal(first((log) => setup({ subagents: 0, stop: false, log })), "no_running_subagent");
  assert.equal(
    first((log) => {
      const t = setup({ stop: false, log });
      t.file.status = "waiting";
      return t;
    }),
    "file_status:waiting",
  );
  assert.equal(first((log) => setup({ stop: false, log })), "stop_revoked_by:UserPromptSubmit");
  assert.equal(
    first((log) => {
      // A session no hook has spoken for yet has seen no Stop at all.
      const t = setup({ stop: false, log });
      t.states.forget(KEY);
      return t;
    }),
    "mode_not_allowed:unknown",
  );
  assert.equal(
    first((log) => {
      const t = setup({ log });
      t.hook("UserPromptSubmit", { prompt: "x" });
      return t;
    }),
    "stop_revoked_by:UserPromptSubmit",
  );
  assert.equal(
    first((log) => {
      const t = setup({ log });
      t.clock.t += BACKGROUND_STOP_FRESH_MS + 1;
      return t;
    }),
    "stop_too_old",
  );
  assert.equal(
    first((log) => {
      const t = setup({ log });
      t.port.drafts.set(KEY, true);
      return t;
    }),
    "laptop_draft",
  );
  assert.equal(first((log) => setup({ log })), "ready");
});

test("a_continued_stop_is_not_evidence_and_a_later_clean_one_is", () => {
  const t = setup({ stop: false });
  t.hook("Stop", { stop_hook_active: true });
  assert.equal(ready(t), false);
  t.hook("Stop", { stop_hook_active: false });
  assert.equal(ready(t), true);
});

test("a_delivered_stop_or_a_typed_write_uses_the_evidence_up", () => {
  const t = setup();
  t.states.latch(KEY, t.clock.t);
  assert.equal(ready(t), false);
  const u = setup();
  u.router.onStopDelivered(KEY);
  assert.equal(ready(u), false);
});

// ---- dispatch, write checks, revocation ------------------------------------------

async function dispatch(t, text = "yes do it") {
  const result = t.router.followup(KEY, text, () => ({ ok: true }));
  await until(() => t.port.sent.length === 1, 500, "the dispatch");
  return { result, cmd: t.port.sent[0] };
}

test("a_ready_session_dispatches_a_bgReply_text_and_completes_on_a_matching_UserPromptSubmit", async () => {
  const t = setup();
  const { result, cmd } = await dispatch(t);
  assert.equal(cmd.bgReply, true);
  assert.equal(cmd.command, "text");
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  // The paste is not main-thread work: the evidence stays until the Enter is allowed.
  assert.equal(t.port.check("enter"), true);
  t.port.settle({ ok: true });
  // A background task's report is another turn's prompt.
  t.hook("UserPromptSubmit", { prompt: "a background task finished" });
  await settle(40);
  t.hook("UserPromptSubmit", { prompt: "yes  do it" });
  assert.deepEqual(await result, { ok: true });
  // The Stop is used up: nothing more goes out until a new one.
  assert.equal(ready(t), false);
  t.hook("Stop");
  assert.equal(ready(t), true);
});

test("an_enter_without_a_matching_prompt_times_out_consumed_and_is_never_retyped", async () => {
  const t = setup();
  const { result } = await dispatch(t);
  t.port.check("paste");
  t.port.wrote();
  t.port.check("enter");
  t.port.settle({ ok: true });
  const outcome = await result;
  assert.deepEqual([outcome.ok, outcome.error, outcome.consumed], [false, "timeout", true]);
  assert.equal(t.port.sent.length, 1);
});

test("revocation_before_the_write_cancels_the_command_busy_and_unconsumed", async () => {
  for (const [what, revoke] of [
    ["a permission request from a subagent", (t) => t.hook("PermissionRequest", { tool_name: "Bash", agent_id: "bg1" })],
    ["permission notification", (t) => t.hook("Notification", { notification_type: "permission_prompt" })],
    ["elicitation", (t) => t.hook("Notification", { notification_type: "elicitation_dialog" })],
    ["a prompt of the main thread", (t) => t.hook("UserPromptSubmit", { prompt: "a background task finished" })],
    ["another Stop hook continues", (t) => t.hook("Stop", { stop_hook_active: true })],
    [
      "mode changed",
      (t) => {
        t.hook("Notification", { permission_mode: "plan", notification_type: "idle_prompt" });
      },
    ],
    [
      "switch turned off",
      (t) => {
        t.flags.bg = false;
        t.router.bgRepliesChanged();
      },
    ],
    [
      "asking",
      (t) => {
        t.flags.asking = true;
        t.router.onBlocked(KEY);
      },
    ],
    [
      "laptop draft",
      (t) => {
        t.port.drafts.set(KEY, true);
        t.port.emit(KEY);
      },
    ],
    [
      "file turned waiting",
      (t) => {
        t.file.status = "waiting";
        t.port.emit(KEY);
      },
    ],
  ]) {
    const t = setup();
    const { result, cmd } = await dispatch(t);
    revoke(t);
    const outcome = await result;
    assert.deepEqual([outcome.ok, outcome.error, "consumed" in outcome], [false, "busy", false], what);
    assert.deepEqual(t.port.commandCancels, [cmd.cmdId], what);
    // The launcher's late question is a no: nothing is typed after a revocation.
    assert.equal(t.port.check("paste", cmd.cmdId), false, what);
  }
});

test("the_write_boundary_rechecks_everything_even_when_no_revocation_reached_it", async () => {
  const mutate = {
    "file turned waiting": (t) => {
      t.file.status = "waiting";
    },
    "file went idle": (t) => {
      t.file.status = "idle";
    },
    "mode changed with no hook yet": (t) => {
      t.states.onHook(KEY, "Stop", { permission_mode: "plan" });
    },
    "switch off": (t) => {
      t.flags.bg = false;
    },
    "subagents gone": (t) => {
      t.flags.subagents = 0;
    },
    "stale evidence": (t) => {
      t.clock.t += BACKGROUND_STOP_FRESH_MS + 1;
    },
    "approval pending": (t) => {
      t.flags.asking = true;
    },
  };
  for (const [what, change] of Object.entries(mutate)) {
    const t = setup();
    const { result } = await dispatch(t);
    change(t);
    assert.equal(t.port.check("paste"), false, what);
    t.port.settle({ ok: false, error: "busy" });
    assert.equal((await result).ok, false, what);
  }
});

test("a_revocation_after_the_paste_but_before_the_enter_fails_not_sent_and_stays_unconsumed", async () => {
  const t = setup();
  const { result } = await dispatch(t);
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  t.hook("Notification", { notification_type: "elicitation_dialog" });
  const outcome = await result;
  assert.deepEqual([outcome.ok, outcome.error, "consumed" in outcome], [false, "not_sent", false]);
  assert.equal(t.port.check("enter"), false);
});

test("once_the_enter_is_allowed_a_cancel_is_a_consumed_typed_after_cancel", async () => {
  const t = setup();
  const { result } = await dispatch(t);
  t.port.check("paste");
  t.port.wrote();
  assert.equal(t.port.check("enter"), true);
  // Nothing revokes an Enter already allowed, and it is allowed only once.
  t.hook("PreToolUse", { tool_name: "Bash" });
  assert.equal(t.port.check("enter"), false);
  t.router.endSession(KEY);
  const outcome = await result;
  assert.deepEqual([outcome.ok, outcome.consumed], [false, true]);
});

test("write_checks_are_only_answered_yes_in_order_for_the_running_command", async () => {
  const t = setup();
  assert.equal(t.port.checker(KEY, "nobody", "paste"), false);
  const { result, cmd } = await dispatch(t);
  assert.equal(t.port.check("enter", cmd.cmdId), false, "the Enter before the paste");
  assert.equal(t.port.check("paste", "someone-else"), false);
  assert.equal(t.port.check("paste", cmd.cmdId), true);
  t.port.wrote();
  assert.equal(t.port.check("paste", cmd.cmdId), false, "a second paste");
  t.router.endSession(KEY);
  await result;
});

test("a_text_that_cannot_be_echoed_whole_never_takes_the_background_route", async () => {
  for (const text of ["two\nlines", "x".repeat(601), "   "]) {
    const t = setup();
    const outcome = await t.router.followup(KEY, text, () => ({ ok: true }));
    assert.deepEqual([outcome.ok, outcome.error], [false, "busy"], JSON.stringify(text).slice(0, 20));
    assert.deepEqual(t.port.sent, []);
  }
});

test("compact_and_model_never_take_the_background_route", async () => {
  const t = setup();
  const outcome = await t.router.command(KEY, { command: "model", model: "opus" });
  assert.deepEqual([outcome.ok, outcome.error], [false, "busy"]);
  assert.deepEqual(t.port.sent, []);
});

test("an_idle_file_dispatches_the_ordinary_way_without_bgReply", async () => {
  const t = setup({ switchOn: false, mode: "default" });
  t.file.status = "idle";
  t.file.statusUpdatedAt = t.clock.t;
  const result = t.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => t.port.sent.length === 1, 500, "the dispatch");
  assert.equal("bgReply" in t.port.sent[0], false);
  t.port.wrote();
  t.port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
});

test("the_switch_off_makes_a_queued_reply_wait_and_fail_busy_without_typing", async () => {
  const t = setup({ switchOn: false });
  const outcome = await t.router.followup(KEY, "hi", () => ({ ok: true }));
  assert.deepEqual([outcome.ok, outcome.error], [false, "busy"]);
  assert.deepEqual(t.port.sent, []);
});

test("a_reply_waits_for_the_evidence_to_arrive_and_then_goes", async () => {
  const t = setup({ stop: false });
  const result = t.router.followup(KEY, "later", () => ({ ok: true }));
  await settle(60);
  assert.deepEqual(t.port.sent, []);
  t.hook("Stop");
  await until(() => t.port.sent.length === 1, 500, "the dispatch");
  assert.equal(t.port.sent[0].bgReply, true);
  t.router.endSession(KEY);
  await result;
});

// ---- Codex's findings on the latch and the msgId ---------------------------------------

/** A session sitting idle at its prompt, long enough ago that only a write can make it busy. */
function idleSession() {
  const t = setup({ switchOn: false, mode: "plan" });
  t.file.status = "idle";
  t.file.statusUpdatedAt = t.clock.t - 60_000;
  return t;
}

test("a_reply_the_launcher_cleared_away_puts_the_readiness_state_back", async () => {
  for (const error of ["not_sent", "laptop_draft", "taken_over"]) {
    const t = idleSession();
    assert.equal(ready(t), true, "ready before");
    const result = t.router.followup(KEY, "hi", () => ({ ok: true }));
    await until(() => t.port.sent.length === 1, 500, "the dispatch");
    t.port.wrote();
    assert.equal(ready(t), false, "the paste set the barrier");
    t.port.settle({ ok: false, error });
    const outcome = await result;
    assert.deepEqual([outcome.ok, outcome.error], [false, error]);
    assert.equal(ready(t), true, `${error}: nothing was submitted, so a retry sees the state from before the paste`);
    assert.equal(t.states.notBefore(KEY), undefined, error);
  }
});

test("a_background_reply_revoked_after_its_paste_puts_the_latch_back_but_never_the_revoked_stop", async () => {
  const t = setup();
  const before = t.states.snapshotLatch(KEY);
  const { result } = await dispatch(t);
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  assert.notEqual(t.states.latchAt(KEY), undefined, "the paste set the barrier");
  t.hook("Notification", { notification_type: "permission_prompt" });
  const outcome = await result;
  assert.deepEqual([outcome.ok, outcome.error, "consumed" in outcome], [false, "not_sent", false]);
  assert.deepEqual(t.states.snapshotLatch(KEY), before, "only the latch is restored");
  // The permission prompt took the Stop away, and the restore does not give it back.
  assert.equal(t.states.bgPicture(KEY).eligible, false);
  assert.equal(ready(t), false);
  assert.equal(t.router.followupWhy(KEY, 1), "background");
  // A new Stop is what makes it ready again.
  t.hook("Stop");
  assert.equal(ready(t), true);
});

test("a_restore_leaves_a_latch_somebody_else_moved_alone", async () => {
  const t = idleSession();
  const result = t.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => t.port.sent.length === 1, 500, "the dispatch");
  t.port.wrote();
  // A Stop delivery (another turn started) sets a newer barrier while the reply is being cleared away.
  t.clock.t += 5;
  t.router.onStopDelivered(KEY);
  const newer = t.states.latchAt(KEY);
  assert.notEqual(newer, undefined);
  t.port.settle({ ok: false, error: "not_sent" });
  assert.equal((await result).error, "not_sent");
  assert.equal(t.states.latchAt(KEY), newer, "the newer latch was not erased by the restore");
  // The barrier a plain `not_sent` leaves nobody else's is restored (see the test above).
  const plain = idleSession();
  const second = plain.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => plain.port.sent.length === 1, 500, "the dispatch");
  plain.port.wrote();
  plain.port.settle({ ok: false, error: "not_sent" });
  await second;
  assert.equal(plain.states.latchAt(KEY), undefined);
});

test("a_cancel_after_the_paste_and_before_the_enter_does_not_consume_the_msgId", async () => {
  // The launcher cleared the paste when asked to stop and says so: cancelled, Enter never pressed.
  const t = idleSession();
  const result = t.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => t.port.sent.length === 1, 500, "the dispatch");
  t.port.wrote();
  t.port.settle({ ok: false, error: "cancelled" });
  const outcome = await result;
  assert.deepEqual(outcome, { ok: false, error: "cancelled" });
  assert.equal(ready(t), true, "and the readiness state is back");
  // A compact that was cancelled after it was typed stays spent.
  const compact = idleSession();
  const c = compact.router.command(KEY, { command: "compact" });
  await until(() => compact.port.sent.length === 1, 500, "the dispatch");
  compact.port.wrote();
  compact.port.settle({ ok: false, error: "cancelled" });
  assert.deepEqual(await c, { ok: false, error: "cancelled", consumed: true });
  // Agentd stopped waiting first: the launcher's late result is what says whether the Enter was pressed.
  const unheard = idleSession();
  const u = unheard.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => unheard.port.sent.length === 1, 500, "the dispatch");
  unheard.port.wrote();
  const cmdId = unheard.port.pending.cmdId;
  unheard.router.endSession(KEY);
  unheard.port.late(cmdId, false, "cancelled");
  assert.deepEqual(await u, { ok: false, error: "cancelled" });
  const silent = idleSession();
  const s = silent.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => silent.port.sent.length === 1, 500, "the dispatch");
  silent.port.wrote();
  silent.router.endSession(KEY);
  const heard = await s;
  assert.deepEqual([heard.error, heard.consumed], ["typed_after_cancel", true], "no word from the launcher: presumed pressed");
});

test("only_a_write_that_pressed_enter_consumes_the_msgId", async () => {
  // Esc during the check: Ctrl+U and taken_over, Enter never pressed, so a retry of the same message is not a duplicate.
  const idle = idleSession();
  const a = idle.router.followup(KEY, "hi", () => ({ ok: true }));
  await until(() => idle.port.sent.length === 1, 500, "the dispatch");
  idle.port.wrote();
  idle.port.settle({ ok: false, error: "taken_over" });
  const outcome = await a;
  assert.deepEqual(outcome, { ok: false, error: "taken_over" });
  assert.equal("consumed" in outcome, false);
  // The same for a background reply, whose Enter was never allowed.
  const bg = setup();
  const { result } = await dispatch(bg);
  bg.port.check("paste");
  bg.port.wrote();
  bg.port.settle({ ok: false, error: "taken_over" });
  assert.equal("consumed" in (await result), false);
  // The launcher's own word wins over agentd's grant: it presses the Enter only after the verdict, so a
  // takeover it reports after one means the Esc came first and the Enter was not pressed.
  const granted = setup();
  const { result: pressed } = await dispatch(granted);
  granted.port.check("paste");
  granted.port.wrote();
  granted.port.check("enter");
  granted.port.settle({ ok: false, error: "taken_over" });
  assert.equal("consumed" in (await pressed), false);
  // Without a word from the launcher the Enter is presumed pressed: a cancel after the grant is spent.
  const cancelled = setup();
  const { result: unheard } = await dispatch(cancelled);
  cancelled.port.check("paste");
  cancelled.port.wrote();
  cancelled.port.check("enter");
  cancelled.router.endSession(KEY);
  assert.equal((await unheard).consumed, true);
  // A compact or a model change that was taken over had been typed: it stays spent.
  const model = idleSession();
  const m = model.router.command(KEY, { command: "model", model: "opus" });
  await until(() => model.port.sent.length === 1, 500, "the dispatch");
  model.port.wrote();
  model.port.settle({ ok: false, error: "taken_over" });
  assert.deepEqual(await m, { ok: false, error: "taken_over", consumed: true });
});
