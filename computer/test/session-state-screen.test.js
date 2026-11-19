"use strict";
/**
 * A text reply on the launcher's own word about its screen (auto and bypassPermissions modes): agentd's
 * readiness, the reason it gives, the dispatch and the write checks, against a fake launcher port. Every other
 * mode and every other command keeps the file's idle rule.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { KEY, setup } = require("./helpers/screen-ready-harness.js");

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

test("an_empty_box_is_ready_in_auto_and_bypass_whatever_the_file_says_and_the_hint_is_gone", () => {
  for (const mode of ["auto", "bypassPermissions"]) {
    for (const status of ["idle", "busy", "shell"]) {
      const t = setup({ mode, status, report: "empty" });
      assert.equal(t.router.followupState(KEY), "ready", `${mode} ${status}`);
      assert.equal(t.router.followupWhy(KEY), undefined, `${mode} ${status}`);
    }
    // `waiting` (Claude waits for the user), a word not known and no status at all are no ground: the file rule.
    for (const status of ["waiting", "starting", "WAITING", "", undefined]) {
      const t = setup({ mode, status, report: "empty" });
      assert.equal(t.router.followupState(KEY), "unavailable", `${mode} ${String(status)}`);
      assert.equal(t.router.followupWhy(KEY), "busy", `${mode} ${String(status)}`);
      assert.equal(t.states.screenVerdict(KEY), "no", `${mode} ${String(status)}`);
    }
  }
});

test("text_in_the_box_a_dialog_the_plan_footer_and_an_unreadable_screen_each_say_what_they_are", () => {
  for (const status of ["idle", "busy", "shell"]) {
    const t = (report) => setup({ mode: "auto", status, report });
    assert.equal(t("text").router.followupState(KEY), "unavailable", status);
    assert.equal(t("text").router.followupWhy(KEY), "draft", status);
    assert.equal(t("dialog").router.followupState(KEY), "unavailable", status);
    assert.equal(t("dialog").router.followupWhy(KEY), "dialog", status);
    assert.equal(t("plan").router.followupState(KEY), "unavailable", status);
    assert.equal(t("plan").router.followupWhy(KEY), "mode_not_allowed", status);
  }
  // Unreadable: with a busy file the screen cannot vouch for it, and says so; an idle file keeps today's rule.
  for (const status of ["busy", "shell"]) {
    const t = setup({ mode: "auto", status, report: "unreadable" });
    assert.equal(t.router.followupState(KEY), "unavailable", status);
    assert.equal(t.router.followupWhy(KEY), "unreadable", status);
  }
  assert.equal(setup({ mode: "auto", status: "idle", report: "unreadable" }).router.followupState(KEY), "ready");
  // The wearer's own draft, as the launcher's draft flag says it, refuses before the box state is read.
  const drafted = setup({ mode: "auto", status: "busy", report: "empty" });
  drafted.port.drafts.set(KEY, true);
  assert.equal(drafted.router.followupState(KEY), "unavailable");
  assert.equal(drafted.router.followupWhy(KEY), "draft");
});

test("a_stale_or_missing_report_falls_back_to_the_file_rule", () => {
  for (const [what, options] of [
    ["stale", { report: "empty", ageMs: 3001 }],
    ["missing", { report: undefined }],
    ["unknown word", { report: "teleport" }],
  ]) {
    const busy = setup({ mode: "auto", status: "busy", ...options });
    assert.equal(busy.router.followupState(KEY), "unavailable", what);
    assert.equal(busy.router.followupWhy(KEY), "busy", what);
    assert.equal(setup({ mode: "auto", status: "idle", ...options }).router.followupState(KEY), "ready", `${what} idle`);
  }
  // The edge: a report just inside the window still counts.
  assert.equal(setup({ mode: "auto", status: "busy", report: "empty", ageMs: 2999 }).router.followupState(KEY), "ready");
  // A stale dialog report is no news either.
  assert.equal(setup({ mode: "auto", status: "idle", report: "dialog", ageMs: 5000 }).router.followupState(KEY), "ready");
});

test("other_modes_and_anything_agentd_knows_of_keep_the_file_rule", () => {
  for (const mode of ["default", "acceptEdits", "dontAsk", "plan", "mystery"]) {
    const t = setup({ mode, status: "busy", report: "empty" });
    assert.equal(t.router.followupState(KEY), "unavailable", mode);
    assert.equal(t.router.followupWhy(KEY), "busy", mode);
    // And the screen's dialog report changes nothing there.
    assert.equal(setup({ mode, status: "idle", report: "dialog" }).router.followupState(KEY), "ready", `${mode} idle with a dialog report`);
  }
  // A pending approval or question of any origin, a held Stop, an uncertain write: the screen is no ground.
  const asking = setup({ mode: "auto", status: "busy", report: "empty", asking: true });
  assert.equal(asking.router.followupState(KEY), "unavailable");
  assert.equal(asking.router.followupWhy(KEY), "busy");
  const held = setup({ mode: "auto", status: "busy", report: "empty", held: true });
  assert.equal(held.router.followupState(KEY), "waiting");
  const uncertain = setup({ mode: "auto", status: "busy", report: "empty" });
  uncertain.port.bindings.get(KEY).uncertain = true;
  assert.equal(uncertain.router.followupState(KEY), "unavailable");
  // No file, or another session's file: nothing to ground it on.
  const other = setup({ mode: "auto", status: "busy", report: "empty" });
  other.file.sessionId = "someone-else";
  assert.equal(other.router.followupState(KEY), "unavailable");
});

test("a_reply_on_the_screens_word_is_queued_typed_on_agentds_checks_and_ends_at_the_enter", async () => {
  for (const status of ["busy", "shell", "idle"]) {
    const t = setup({ mode: "auto", status, report: "empty" });
    const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
    await until(() => t.port.pending, 2000, `the command for ${status}`);
    const sent = t.port.sent.at(-1);
    if (status === "idle") {
      // The file's own rule applies first: an idle session is typed on the ordinary route.
      assert.equal(sent.bgReply, undefined, "idle: ordinary");
      assert.equal(sent.queued, undefined);
      t.port.settle({ ok: true });
      assert.deepEqual(await result, { ok: true });
      continue;
    }
    assert.equal(sent.bgReply, true, status);
    assert.equal(sent.queued, true, status);
    assert.equal(sent.command, "text");
    // The launcher asks before its paste and before its Enter; no hook evidence is needed, and a
    // report that has since gone stale (it sends none while its command runs) does not matter.
    t.flags.ageMs = 60_000;
    assert.equal(t.port.check("paste"), true, status);
    t.port.wrote();
    assert.equal(t.port.check("enter"), true, status);
    t.port.settle({ ok: true });
    // No UserPromptSubmit is waited for: the reply queues behind the turn, and its Enter is the end.
    assert.deepEqual(await result, { ok: true }, status);
  }
});

test("the_screen_route_stops_when_an_approval_appears_before_the_write", async () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => t.port.pending, 2000, "the command");
  t.flags.asking = true;
  assert.equal(t.port.check("paste"), false, "an approval of any origin pending: no paste");
  const outcome = await Promise.race([result, settle(500).then(() => "pending")]);
  // The check answering no does not end the command here (the launcher fails it); the revocation does.
  t.router.onBlocked(KEY);
  assert.equal(outcome === "pending" || outcome.ok === false, true);
  const final = await result;
  assert.equal(final.ok, false);
  assert.equal(final.error, "busy");
});

// ---- a dialog that a hook announces ---------------------------------------------------------------------------

const BASH = { tool_name: "Bash", tool_input: { command: "rm -rf build" } };
const ANNOUNCEMENTS = [
  ["PermissionRequest", "PermissionRequest", BASH],
  ["Elicitation", "Elicitation", { mcp_server_name: "docs" }],
  ["a permission_prompt notification", "Notification", { notification_type: "permission_prompt" }],
  ["an elicitation_dialog notification", "Notification", { notification_type: "elicitation_dialog" }],
  ["a notification of a type nobody knows", "Notification", { notification_type: "something_new" }],
];

/** The reply is dispatched, agentd said yes to the paste and the launcher pasted: the Enter is the next question. */
async function pasted(t) {
  const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => t.port.pending, 2000, "the command");
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  return { result };
}

test("a_hook_that_announces_a_dialog_aborts_a_pasted_reply_before_the_enter_whoever_fired_it", async () => {
  for (const [what, event, extra] of ANNOUNCEMENTS) {
    for (const agent of [undefined, "sub1"]) {
      const t = setup({ mode: "auto", status: "busy", report: "empty" });
      const { result } = await pasted(t);
      // The hook arrives before agentd's approval manager knows of it (nothing is asking yet) and before Claude draws it.
      assert.equal(t.flags.asking, false);
      t.hook(event, { ...extra, ...(agent ? { agent_id: agent } : {}) });
      assert.equal(t.port.check("enter"), false, `${what} ${agent ?? "main"}: no Enter`);
      assert.deepEqual(await result, { ok: false, error: "not_sent" }, `${what} ${agent ?? "main"}: cleared, nothing sent`);
      assert.equal(t.port.pending, undefined);
    }
  }
});

test("a_dialog_a_hook_announced_refuses_new_replies_until_its_post_or_result_hook_a_prompt_or_a_stop", async () => {
  const closers = [
    ["its tool's PostToolUse", "PermissionRequest", BASH, ["PostToolUse", BASH]],
    ["its tool's PostToolUseFailure", "PermissionRequest", BASH, ["PostToolUseFailure", BASH]],
    ["PermissionDenied", "PermissionRequest", BASH, ["PermissionDenied", BASH]],
    ["ElicitationResult", "Elicitation", {}, ["ElicitationResult", {}]],
    ["an elicitation_complete notification", "Elicitation", {}, ["Notification", { notification_type: "elicitation_complete" }]],
    ["a UserPromptSubmit", "Notification", { notification_type: "permission_prompt" }, ["UserPromptSubmit", { prompt: "go" }]],
    ["the next Stop", "PermissionRequest", BASH, ["Stop", {}]],
  ];
  for (const [what, event, extra, [closer, closing]] of closers) {
    const t = setup({ mode: "auto", status: "busy", report: "empty" });
    t.hook(event, extra);
    assert.equal(t.router.followupState(KEY), "unavailable", `${what}: refused while announced`);
    assert.equal(t.router.followupWhy(KEY), "dialog", what);
    const refused = await t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
    assert.equal(refused.ok, false, what);
    assert.deepEqual(t.port.sent, [], `${what}: nothing sent`);
    t.hook(closer, closing);
    assert.equal(t.router.followupState(KEY), "ready", `${what}: closed by ${closer}`);
  }
  // Another tool's Post hook, a subagent's included, does not close a dialog that is still open; its own does.
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  t.hook("PermissionRequest", BASH);
  t.hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" }, agent_id: "sub1" });
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.hook("PostToolUse", { ...BASH, agent_id: "sub1" });
  assert.equal(t.router.followupState(KEY), "ready", "the same tool call's Post, whoever fired it");
  // Two dialogs: one closing leaves the other.
  t.hook("PermissionRequest", BASH);
  t.hook("Elicitation", {});
  t.hook("ElicitationResult", {});
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.hook("PostToolUse", BASH);
  assert.equal(t.router.followupState(KEY), "ready");
});

test("a_dialog_announcement_expires_so_a_lost_hook_cannot_refuse_replies_for_good", () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  t.hook("PermissionRequest", BASH);
  t.clock.offset += 29_000;
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.clock.offset += 2_000;
  assert.equal(t.router.followupState(KEY), "ready");
  assert.equal(t.router.followupWhy(KEY), undefined);
});

test("a_dialog_announcement_changes_nothing_outside_the_auto_modes", () => {
  const t = setup({ mode: "default", status: "idle", report: "empty" });
  t.hook("PermissionRequest", BASH);
  assert.equal(t.router.followupState(KEY), "ready", "the file rule is as it was: the typist's checks stand at the write");
});

// ---- a reply queued behind a turn and the Stop hold ------------------------------------------------------------

test("a_queued_reply_keeps_the_stop_from_being_held_until_claude_takes_it_as_a_prompt", async () => {
  const { StopWait } = require("../dist/stop-wait.js");
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  const stopWait = new StopWait({
    waitLimitMs: 60_000,
    continuationCap: 3,
    enabled: true,
    skipHold: (id) => t.states.queuedPending(`claude:${id}`),
  });
  const closed = new AbortController().signal;
  assert.equal(t.states.queuedPending(KEY), false);
  const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => t.port.pending, 2000, "the command");
  assert.equal(t.port.check("paste"), true);
  t.port.wrote();
  assert.equal(t.port.check("enter"), true);
  t.port.settle({ ok: true });
  assert.deepEqual(await result, { ok: true });
  assert.equal(t.states.queuedPending(KEY), true, "typed, Claude has not taken it yet");
  // The turn ends: its Stop is not held, so Claude goes on to the queued prompt at once. Checked before anything
  // is awaited: a hold that is opened (and would only end at its 60 s limit) shows as waiting at once.
  const stop = stopWait.hold("s1", closed);
  assert.equal(stopWait.state("s1").waiting, false, "no hold was opened");
  assert.deepEqual(await Promise.race([stop, settle(200).then(() => "still held")]), {});
  // A prompt that is not ours does not end it; ours does.
  t.hook("UserPromptSubmit", { prompt: "something typed at the laptop" });
  assert.equal(t.states.queuedPending(KEY), true);
  t.hook("UserPromptSubmit", { prompt: "yes  do it\n" });
  assert.equal(t.states.queuedPending(KEY), false);
  const held = stopWait.hold("s1", closed);
  assert.equal(stopWait.state("s1").waiting, true, "an ordinary Stop is held again");
  stopWait.deliver("s1", "go on", "m1");
  await held;
  // It expires too, whatever hooks did or did not arrive.
  const u = setup({ mode: "auto", status: "busy", report: "empty" });
  u.states.markQueued(KEY, "yes do it");
  assert.equal(u.states.queuedPending(KEY), true);
  u.clock.offset += 2 * 60_000;
  assert.equal(u.states.queuedPending(KEY), true, "still inside three minutes");
  u.clock.offset += 60_000 + 1000;
  assert.equal(u.states.queuedPending(KEY), false);
});

test("a_queued_marker_ends_when_a_prompt_holds_the_reply_or_a_stop_follows_any_prompt", () => {
  // A prompt that CONTAINS the reply (joined with one typed at the laptop) is Claude taking it.
  const joined = setup({ mode: "auto", status: "busy", report: "empty" });
  joined.states.markQueued(KEY, "yes do it");
  joined.hook("UserPromptSubmit", { prompt: "first fix the tests\n\nyes   do it" });
  assert.equal(joined.states.queuedPending(KEY), false, "joined with another prompt");
  // A prompt that is not ours changes nothing yet; the Stop that ends that turn ends the marker (Esc put the reply back, or
  // Claude took it without a hook).
  const other = setup({ mode: "auto", status: "busy", report: "empty" });
  other.states.markQueued(KEY, "yes do it");
  other.hook("Stop", {});
  assert.equal(other.states.queuedPending(KEY), true, "the turn we queued behind ends: the reply is next");
  other.hook("UserPromptSubmit", { prompt: "something else entirely" });
  assert.equal(other.states.queuedPending(KEY), true);
  other.hook("Stop", { stop_hook_active: true });
  assert.equal(other.states.queuedPending(KEY), true, "a continued Stop is not the end of that turn");
  other.hook("Stop", {});
  assert.equal(other.states.queuedPending(KEY), false, "the next main-thread Stop after a prompt of another kind");
  // A subagent's Stop is no end of anything.
  const sub = setup({ mode: "auto", status: "busy", report: "empty" });
  sub.states.markQueued(KEY, "yes do it");
  sub.hook("UserPromptSubmit", { prompt: "other" });
  sub.hook("Stop", { agent_id: "sub1" });
  assert.equal(sub.states.queuedPending(KEY), true);
});

test("a_reply_is_marked_queued_at_the_enters_grant_and_unmarked_when_it_then_fails", async () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => t.port.pending, 2000, "the command");
  assert.equal(t.port.check("paste"), true);
  assert.equal(t.states.queuedPending(KEY), false, "not before the Enter is allowed");
  t.port.wrote();
  assert.equal(t.port.check("enter"), true);
  assert.equal(t.states.queuedPending(KEY), true, "from the grant, before the launcher's ok: a Stop now is not held");
  t.port.settle({ ok: false, error: "typed_after_cancel" });
  assert.equal((await result).ok, false);
  assert.equal(t.states.queuedPending(KEY), false, "a reply that then failed or was cancelled is not counted as waiting");
  // A reply that never got to the Enter leaves an earlier reply's marker alone.
  const u = setup({ mode: "auto", status: "busy", report: "empty" });
  u.states.markQueued(KEY, "earlier reply");
  const later = u.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => u.port.pending, 2000, "the command");
  u.port.settle({ ok: false, error: "not_sent" });
  assert.equal((await later).ok, false);
  assert.equal(u.states.queuedPending(KEY), true);
});

test("a_dialog_notification_is_closed_by_its_completion_and_an_askuserquestion_by_its_answered_post_hook", () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  t.hook("Notification", { notification_type: "elicitation_dialog" });
  assert.equal(t.router.followupWhy(KEY), "dialog");
  t.hook("Notification", { notification_type: "elicitation_complete" });
  assert.equal(t.router.followupState(KEY), "ready", "the completion closes the notification's marker too");
  // The Post hook of an AskUserQuestion carries the answers in tool_input: not the request's input, and still its.
  const asked = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "Pick", options: ["A", "B"] }] } };
  t.hook("PermissionRequest", asked);
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.hook("PostToolUse", { tool_name: "AskUserQuestion", tool_input: { ...asked.tool_input, answers: { Pick: "A" } } });
  assert.equal(t.router.followupState(KEY), "ready", "closed though the input differs");
  // With two dialogs of one tool open, a Post hook that matches neither exactly cannot say which it is: nothing closes.
  t.hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "a" } });
  t.hook("PermissionRequest", { tool_name: "Bash", tool_input: { command: "b" } });
  t.hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "c" } });
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "a" } });
  t.hook("PostToolUse", { tool_name: "Bash", tool_input: { command: "b" } });
  assert.equal(t.router.followupState(KEY), "ready");
  // Another tool's Post hook never closes it by the name fallback.
  t.hook("PermissionRequest", asked);
  t.hook("PostToolUse", { tool_name: "Read", tool_input: { file_path: "/x" } });
  assert.equal(t.router.followupState(KEY), "unavailable");
});

test("two_requests_for_the_same_tool_call_are_two_dialogs_and_each_post_hook_closes_one", () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  t.hook("PermissionRequest", BASH);
  t.hook("PermissionRequest", BASH);
  t.hook("PostToolUse", BASH);
  assert.equal(t.router.followupState(KEY), "unavailable", "one is still open");
  t.hook("PostToolUse", BASH);
  assert.equal(t.router.followupState(KEY), "ready");
  // The two elicitations likewise.
  t.hook("Elicitation", {});
  t.hook("Elicitation", {});
  t.hook("ElicitationResult", {});
  assert.equal(t.router.followupState(KEY), "unavailable");
  t.hook("ElicitationResult", {});
  assert.equal(t.router.followupState(KEY), "ready");
});

test("every_hook_agentd_tracks_for_a_dialog_is_registered_by_the_claude_plugin_through_the_forwarder", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const { BLOCKING_HOOKS, DIALOG_TRACKING_HOOKS } = require("../dist/launcher/session-state.js");
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "plugin", "claude-code", "hooks", "hooks.json"), "utf8")).hooks;
  for (const name of [...BLOCKING_HOOKS, ...DIALOG_TRACKING_HOOKS]) {
    assert.equal(Array.isArray(hooks[name]), true, `${name} is registered in the plugin's hooks.json`);
    const commands = hooks[name].flatMap((group) => group.hooks.map((hook) => hook.command));
    assert.equal(commands.some((command) => /hook-forward\.js/.test(command)), true, `${name} goes through the forwarder`);
  }
  // The MCP elicitation hooks are the ones Claude Code 2.1.285 names (its own hook-input descriptions say so).
  assert.deepEqual([...BLOCKING_HOOKS].sort(), ["Elicitation", "ElicitationResult", "PermissionRequest"]);
});

test("a_reply_that_failed_marks_nothing_queued", async () => {
  const t = setup({ mode: "auto", status: "busy", report: "empty" });
  const result = t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => t.port.pending, 2000, "the command");
  t.port.settle({ ok: false, error: "not_sent" });
  assert.equal((await result).ok, false);
  assert.equal(t.states.queuedPending(KEY), false);
  // And an ordinary reply on an idle file queues nothing either.
  const idle = setup({ mode: "auto", status: "idle", report: "empty" });
  const ordinary = idle.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  await until(() => idle.port.pending, 2000, "the command");
  idle.port.settle({ ok: true });
  assert.equal((await ordinary).ok, true);
  assert.equal(idle.states.queuedPending(KEY), false);
});

test("a_refused_screen_never_reaches_the_launcher_and_the_reply_fails_busy", async () => {
  for (const report of ["text", "dialog", "plan", "unreadable"]) {
    const t = setup({ mode: "auto", status: "busy", report });
    const result = await t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
    assert.equal(result.ok, false, report);
    assert.deepEqual(t.port.sent, [], `${report}: nothing sent`);
  }
  // A dialog on screen refuses even when the file says idle (the screen asks).
  const t = setup({ mode: "auto", status: "idle", report: "dialog" });
  const result = await t.router.followup(KEY, "yes do it", () => ({ ok: false, error: "not_held" }));
  assert.equal(result.ok, false);
  assert.deepEqual(t.port.sent, []);
});

test("the_readiness_diagnosis_names_the_route_or_the_reason_and_the_mode_and_nothing_else", () => {
  const diag = (options) => setup(options).router.readiness(KEY);
  assert.deepEqual(diag({ mode: "auto", status: "idle", report: "empty" }), { ready: true, why: "file_idle", mode: "auto" });
  assert.deepEqual(diag({ mode: "auto", status: "shell", report: "empty" }), { ready: true, why: "screen_empty", mode: "auto" });
  assert.deepEqual(diag({ mode: "bypassPermissions", status: "busy", report: "empty" }), { ready: true, why: "screen_empty", mode: "bypassPermissions" });
  assert.deepEqual(diag({ mode: "auto", status: "busy", report: "dialog" }), { ready: false, why: "screen_dialog", mode: "auto" });
  assert.deepEqual(diag({ mode: "auto", status: "busy", report: "text" }), { ready: false, why: "screen_text", mode: "auto" });
  assert.deepEqual(diag({ mode: "auto", status: "busy", report: "unreadable" }), { ready: false, why: "unreadable", mode: "auto" });
  assert.deepEqual(diag({ mode: "auto", status: "busy", report: undefined }), { ready: false, why: "busy", mode: "auto" });
  assert.deepEqual(diag({ mode: "default", status: "busy", report: "empty" }), { ready: false, why: "busy", mode: "default" });
  assert.deepEqual(diag({ mode: "default", status: "idle", report: "empty" }), { ready: true, why: "file_idle", mode: "default" });
  for (const value of Object.values(diag({ mode: "auto", status: "busy", report: "empty" }))) {
    assert.equal(/^(true|false|[A-Za-z_]{1,40})$/.test(String(value)), true, "names and flags only");
  }
});

test("compact_and_model_keep_the_idle_rule_whatever_the_screen_says", async () => {
  for (const command of [{ command: "compact" }, { command: "model", model: "sonnet" }]) {
    const t = setup({ mode: "auto", status: "busy", report: "empty" });
    const result = await t.router.command(KEY, command);
    assert.equal(result.ok, false, command.command);
    assert.deepEqual(t.port.sent, [], `${command.command}: nothing typed while the file is busy`);
  }
  // And with a dialog reported but the file idle, they still go (today's rule): the typist's own checks decide.
  const t = setup({ mode: "auto", status: "idle", report: "dialog" });
  const pending = t.router.command(KEY, { command: "compact" });
  await until(() => t.port.pending, 2000, "compact dispatched on an idle file");
  t.port.settle({ ok: false, error: "not_ready" });
  assert.equal((await pending).ok, false);
});
