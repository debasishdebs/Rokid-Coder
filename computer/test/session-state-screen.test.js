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
    for (const status of ["idle", "busy", "shell", "waiting"]) {
      const t = setup({ mode, status, report: "empty" });
      assert.equal(t.router.followupState(KEY), "ready", `${mode} ${status}`);
      assert.equal(t.router.followupWhy(KEY), undefined, `${mode} ${status}`);
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
