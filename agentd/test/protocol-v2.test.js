const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { extractTranscriptUpdate, readTranscriptHeading } = require("../dist/transcript.js");
const { SessionStore } = require("../dist/session-store.js");
const { silentLogger } = require("../dist/logger.js");
const { PhoneSettingsStore, DEFAULT_ALERT_TIMINGS } = require("../dist/phone-settings.js");
const { authorize, classifyFrame, gateFrame } = require("../dist/protocol-v2.js");
const { buildFrame, createFakePhone } = require("./fake-phone.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

const TRANSPORTS = ["phonelink", "wshub"];

const ackFor = (phone, msgId) => phone.waitFor("ack", (frame) => frame.msgId === msgId);
const upsertOf = (phone, id, predicate = () => true) =>
  phone.waitFor("session_upsert", (frame) => frame.session.id === id && predicate(frame.session));

async function exists(file) {
  return fsp.access(file).then(() => true, () => false);
}

function codexThread(id, overrides = {}) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "Refactor the parser",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1_753_000_000,
    updatedAt: 1_753_000_010,
    recencyAt: null,
    status: { type: "idle" },
    path: null,
    cwd: "/work/parser",
    cliVersion: "0.145.0",
    source: "cli",
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [],
    ...overrides,
  };
}

/** Puts an attached Codex thread in front of the monitor without a live app-server. */
function showCodexThread(daemon, id, overrides) {
  daemon.codex.threads.set(id, codexThread(id, overrides));
  daemon.codex.publishThread(id);
}

const codexTurn = (status) => ({
  id: "turn-1",
  items: [],
  itemsView: "all",
  status,
  error: status === "failed"
    ? { message: "model failed", codexErrorInfo: null, additionalDetails: null }
    : null,
  startedAt: 1_753_000_011,
  completedAt: 1_753_000_020,
  durationMs: 9000,
});

const sessionStart = (id) => ({ hook_event_name: "SessionStart", session_id: id, cwd: "/work/demo" });

test("upsert_carries_mode_and_capabilities_for_claude_plugin", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      { transport, attached: [{ provider: "claude", id: "s1" }] },
      async ({ phone, httpPort }) => {
        await postHook(httpPort, {
          hook_event_name: "UserPromptSubmit",
          session_id: "s1",
          cwd: "/work/demo",
          permission_mode: "acceptEdits",
          prompt: "Fix the flaky billing test and then tidy the retry helper afterwards",
        });
        await postHook(httpPort, {
          hook_event_name: "PreToolUse",
          session_id: "s1",
          tool_name: "Edit",
          tool_input: { file_path: "/work/demo/billing.test.js", description: "Stabilise the retry" },
        });
        const frame = await upsertOf(phone, "s1", (s) => s.currentFile !== undefined);
        assert.equal(frame.v, 2);
        assert.equal(frame.session.mode, "plugin");
        assert.deepEqual(frame.session.capabilities, { compact: false, model: false, followup: "unavailable" });
        assert.equal(frame.session.tempMode, "ask");
        assert.equal(frame.session.nativeMode, "acceptEdits");
        assert.equal(frame.session.heading, "Fix the flaky billing test and then tidy the ret");
        assert.equal(frame.session.currentFile, "/work/demo/billing.test.js");
        assert.equal(frame.session.step, "Stabilise the retry");
        // The v1 shape is intact for the plugin that still renders it.
        assert.equal(frame.session.provider, "claude");
        assert.equal(typeof frame.seq, "number");
      },
    );
  }
});

test("unattached_session_never_upserted", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "mine" }] },
      async ({ phone, httpPort }) => {
        await postHook(httpPort, sessionStart("ghost"));
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "ghost", prompt: "hi" });
        await postHook(httpPort, sessionStart("mine"));
        await upsertOf(phone, "mine");
        await settle();
        assert.equal(phone.frames.some((f) => f.session?.id === "ghost"), false);
        const snapshot = phone.frames.find((f) => f.type === "snapshot");
        assert.equal(snapshot.sessions.some((s) => s.id === "ghost"), false);

        // Steering an unattached session is refused, and says nothing else about it.
        const frame = phone.sendFrame("followup", ["claude:ghost", "hello"]);
        const ack = await ackFor(phone, frame.msgId);
        assert.deepEqual([ack.result, ack.error], ["rejected", "not_attached"]);
        phone.sendFrame("models_request", ["claude:ghost"]);
        await settle();
        assert.equal(phone.frames.some((f) => f.type === "models"), false);
      },
    );
  }
});

test("duplicate_followup_acked_once_applied_once", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone, httpPort, coderDir }) => {
        await postHook(httpPort, sessionStart("s1"));
        const reply = postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
        // A held Stop is what makes the follow-up capability "waiting" and raises the done alert.
        await upsertOf(phone, "s1", (s) => s.capabilities.followup === "waiting");
        const done = await phone.waitFor("alert", (f) => f.kind === "done");
        assert.equal(done.sessionKey, "claude:s1");
        assert.equal(done.v, 2);

        const frame = phone.sendFrame("followup", ["claude:s1", "run the tests again"]);
        assert.equal((await ackFor(phone, frame.msgId)).result, "applied");
        const hook = await reply;
        assert.equal(hook.decision, "block");
        assert.match(hook.reason, /run the tests again/);
        assert.equal((await phone.waitFor("followup_closed")).reason, "delivered");

        // The same frame again, as a phone retrying over a flaky link would send it.
        phone.send(frame);
        await phone.waitFor("ack", (f) => f.msgId === frame.msgId && f.result === "duplicate");
        assert.equal(phone.frames.filter((f) => f.type === "ack" && f.msgId === frame.msgId).length, 2);
        assert.equal(daemon.stopWait.state("s1").continuationsLeft, 7, "applied exactly once");
        const recorded = JSON.parse(await fsp.readFile(path.join(coderDir, "applied-ids.json"), "utf8"));
        assert.ok(frame.msgId in recorded.ids);
        // Delivered: the done alert closed as acted.
        assert.equal((await phone.waitFor("alert_closed", (f) => f.id === done.id)).reason, "acted");
      },
    );
  }
});

test("a_frame_that_ran_consumes_its_msgid_and_one_without_an_id_is_refused", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone }) => {
      // Reached apply (and found nobody waiting): the id is spent.
      const frame = phone.sendFrame("followup", ["claude:s1", "nobody is waiting"]);
      assert.equal((await ackFor(phone, frame.msgId)).error, "not_waiting");
      phone.send(frame);
      await phone.waitFor("ack", (f) => f.msgId === frame.msgId && f.result === "duplicate");
      phone.send({ type: "followup", v: 2, sessionKey: "claude:s1", text: "no id" });
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === "")).error, "bad_msg_id");
    },
  );
});

test("a_frame_refused_before_apply_does_not_consume_its_msgid", async () => {
  // Refused at the gate over plaintext, then the same id over a trusted link.
  const msgId = "reused-1";
  const frame = { type: "mode_set", v: 2, sessionKey: "claude:s1", mode: "acceptEdits", confirmed: false, msgId };
  const seeded = { transport: "wshub", attached: [{ provider: "claude", id: "s1" }] };
  await withDaemon({ ...seeded, tls: false }, async ({ phone, coderDir }) => {
    phone.send(frame);
    assert.equal((await ackFor(phone, msgId)).error, "monitor_only");
    assert.equal(await exists(path.join(coderDir, "applied-ids.json")), false);
  });
  await withDaemon({ ...seeded, tls: true }, async ({ daemon, phone }) => {
    // Refused by a check (nothing named "s2" is attached), id still free.
    const stranger = { ...frame, sessionKey: "claude:s2" };
    phone.send(stranger);
    assert.equal((await ackFor(phone, msgId)).error, "not_attached");
    daemon.attachRegistry.attach("claude", "s2", "plugin");
    phone.send(stranger);
    await phone.waitFor("ack", (f) => f.msgId === msgId && f.result === "applied");
    assert.equal(daemon.approvalPolicy.get("claude:s2"), "acceptEdits");
    // Bad shape and an unconfirmed approve-all are refusals too.
    phone.send({ ...frame, msgId: "reused-2", mode: "sudo" });
    assert.equal((await ackFor(phone, "reused-2")).error, "bad_mode");
    phone.send({ ...frame, msgId: "reused-2", mode: "approveAll", confirmed: false });
    await phone.waitFor("ack", (f) => f.msgId === "reused-2" && f.error === "confirm_required");
    phone.send({ ...frame, msgId: "reused-2", mode: "approveAll", confirmed: true });
    await phone.waitFor("ack", (f) => f.msgId === "reused-2" && f.result === "applied");
  });
});

test("the_same_msgid_sent_over_plaintext_then_trusted_is_applied_not_duplicate", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon }) => {
      const frame = { type: "mode_set", v: 2, sessionKey: "claude:s1", mode: "acceptEdits", confirmed: false, msgId: "reused-3" };
      const acks = [];
      const link = (trusted) => ({ transport: "wshub", trusted, send: (f) => acks.push(f) });
      const deliver = (channel) => gateFrame(frame, channel) && daemon.phoneV2.handle(frame, channel);

      deliver(link(false));
      assert.deepEqual([acks[0].result, acks[0].error], ["rejected", "monitor_only"]);
      assert.equal(daemon.approvalPolicy.get("claude:s1"), "ask");

      deliver(link(true));
      await settle();
      assert.deepEqual([acks[1].result, acks[1].error], ["applied", undefined]);
      assert.equal(daemon.approvalPolicy.get("claude:s1"), "acceptEdits");
    },
  );
});

test("a_plaintext_dismiss_only_parks_an_approval_which_a_trusted_action_still_answers", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort }) => {
      const reply = postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const alert = await phone.waitFor("alert", (f) => f.kind === "approval");
      phone.send({ type: "alert_shown", v: 2, id: alert.id });
      phone.send({ type: "alert_dismissed", v: 2, id: alert.id });
      await settle();
      assert.equal(daemon.phoneV2.alerts.get(alert.id).state, "shown");
      assert.equal(daemon.phoneV2.alerts.current(), undefined, "hidden from the glasses");
      assert.equal(phone.frames.some((f) => f.type === "alert_closed" && f.id === alert.id), false);

      const answer = phone.sendFrame("alert_action", [alert.id, "allow"]);
      assert.equal((await ackFor(phone, answer.msgId)).result, "applied");
      assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");
    },
  );
});

test("a_plaintext_dismiss_leaves_an_approval_and_a_question_in_the_queue_but_closes_a_done", async () => {
  await withDaemon(
    // The approval needs a phone that can answer it, so the link is TLS; the
    // dismiss frames are monitor-class and are accepted on either.
    { transport: "phonelink", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort }) => {
      postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      const approval = await phone.waitFor("alert", (f) => f.kind === "approval");
      const question = daemon.phoneV2.alerts.push({
        sessionKey: "claude:s1",
        kind: "done",
        title: "Done",
        body: "x",
        createdAt: Date.now(),
      });
      phone.send({ type: "alert_dismissed", v: 2, id: approval.id });
      await settle();
      assert.equal(daemon.phoneV2.alerts.get(approval.id).state, "shown");
      phone.send({ type: "alert_dismissed", v: 2, id: question });
      await settle();
      assert.equal(daemon.phoneV2.alerts.get(question), undefined);
    },
  );
});

test("mode_set_approve_all_without_confirm_is_rejected", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone, httpPort }) => {
        await postHook(httpPort, sessionStart("s1"));
        const unconfirmed = phone.sendFrame("mode_set", ["claude:s1", "approveAll", "false"]);
        const ack = await ackFor(phone, unconfirmed.msgId);
        assert.deepEqual([ack.result, ack.error], ["rejected", "confirm_required"]);
        assert.equal(daemon.approvalPolicy.get("claude:s1"), "ask");

        // policy.set does not check attachment, so the handler must.
        const stranger = phone.sendFrame("mode_set", ["claude:nope", "acceptEdits", "false"]);
        assert.equal((await ackFor(phone, stranger.msgId)).error, "not_attached");
        assert.equal(daemon.approvalPolicy.get("claude:nope"), "ask");

        const confirmed = phone.sendFrame("mode_set", ["claude:s1", "approveAll", "true"]);
        assert.equal((await ackFor(phone, confirmed.msgId)).result, "applied");
        assert.equal(daemon.approvalPolicy.get("claude:s1"), "approveAll");
        await upsertOf(phone, "s1", (s) => s.tempMode === "approveAll");
      },
    );
  }
});

test("mode_revoke_all_and_session_end_report_mode_reset_and_a_notice", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone }) => {
      daemon.approvalPolicy.set("claude:s1", "approveAll", true);
      const frame = phone.sendFrame("mode_revoke_all");
      assert.equal((await ackFor(phone, frame.msgId)).result, "applied");
      const reset = await phone.waitFor("mode_reset");
      assert.deepEqual(
        [reset.sessionKey, reset.from, reset.reason],
        ["claude:s1", "approveAll", "revoked"],
      );
      const notice = await phone.waitFor("alert", (f) => f.kind === "notice");
      assert.equal(notice.sessionKey, "claude:s1");
      assert.equal(daemon.approvalPolicy.get("claude:s1"), "ask");
    },
  );
});

test("alert_frames_include_waiting_count", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort }) => {
      const permission = (tool) => postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: tool,
        tool_input: { command: tool },
      });
      const first = permission("Bash");
      const alertA = await phone.waitFor("alert", (f) => f.kind === "approval");
      assert.equal(alertA.waiting, 0);
      assert.deepEqual(alertA.actions, ["allow", "deny"]);
      const second = permission("WebFetch");
      permission("Task");
      await settle();

      phone.send({ type: "alert_shown", v: 2, id: alertA.id });
      const answer = phone.sendFrame("alert_action", [alertA.id, "allow"]);
      assert.equal((await ackFor(phone, answer.msgId)).result, "applied");
      assert.equal((await first).hookSpecificOutput.decision.behavior, "allow");
      assert.equal((await phone.waitFor("alert_closed", (f) => f.id === alertA.id)).reason, "acted");

      // The next alert goes out with one still behind it.
      const alertB = await phone.waitFor("alert", (f) => f.kind === "approval" && f.id !== alertA.id);
      assert.equal(alertB.waiting, 1);

      // Deny through the old v1 frame still works, and closes the alert too.
      const request = phone.frames.filter((f) => f.type === "approval_request").find((f) => f.tool === "WebFetch");
      phone.send({ type: "approval_decision", v: 1, requestId: request.requestId, decision: "deny" });
      assert.equal((await second).hookSpecificOutput.decision.behavior, "deny");
      assert.equal((await phone.waitFor("alert_closed", (f) => f.id === alertB.id)).reason, "acted");
      phone.send({ type: "alert_shown", v: 2, id: alertB.id });
    },
  );
});

test("alert_action_only_decides_the_request_of_its_own_alert", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone }) => {
      const missing = phone.sendFrame("alert_action", ["no-such-alert", "allow"]);
      assert.equal((await ackFor(phone, missing.msgId)).error, "unknown_alert");
    },
  );
});

test("question_answer_is_checked_against_the_alerts_own_session", async () => {
  await withDaemon(
    {
      transport: "wshub",
      tls: true,
      attached: [{ provider: "claude", id: "s1" }, { provider: "claude", id: "s2" }],
    },
    async ({ phone, httpPort }) => {
      const reply = postHook(httpPort, {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_1",
        tool_input: { questions: [{ question: "Pick", options: [{ label: "A" }, { label: "B" }], multiSelect: false }] },
      });
      const alert = await phone.waitFor("alert", (f) => f.kind === "question");
      assert.equal(alert.question.requestRef, "toolu_1");
      assert.equal(alert.question.source, "claude_tool");

      const answers = JSON.stringify({ Pick: "B" });
      const wrongSession = phone.sendFrame("question_answer", ["claude:s2", alert.id, "toolu_1", answers]);
      assert.equal((await ackFor(phone, wrongSession.msgId)).error, "wrong_session");
      const wrongRequest = phone.sendFrame("question_answer", ["claude:s1", alert.id, "toolu_other", answers]);
      assert.equal((await ackFor(phone, wrongRequest.msgId)).error, "wrong_request");

      const right = phone.sendFrame("question_answer", ["claude:s1", alert.id, "toolu_1", answers]);
      assert.equal((await ackFor(phone, right.msgId)).result, "applied");
      const hook = await reply;
      assert.equal(hook.hookSpecificOutput.updatedInput.answers.Pick, "B");
      assert.equal((await phone.waitFor("alert_closed", (f) => f.id === alert.id)).reason, "acted");

      // Answered already: a fresh frame for the same alert finds nothing to answer.
      const late = phone.sendFrame("question_answer", ["claude:s1", alert.id, "toolu_1", answers]);
      assert.equal((await ackFor(phone, late.msgId)).error, "unknown_alert");
    },
  );
});

test("a_question_answered_at_the_laptop_withdraws_its_alert", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort }) => {
      const reply = postHook(httpPort, {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_2",
        tool_input: { questions: [{ question: "Pick", options: [{ label: "A" }], multiSelect: false }] },
      });
      const alert = await phone.waitFor("alert", (f) => f.kind === "question");
      await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "never mind" });
      assert.deepEqual(await reply, {});
      assert.equal((await phone.waitFor("alert_closed", (f) => f.id === alert.id)).reason, "withdrawn");
    },
  );
});

test("codex_turn_completed_pushes_done_alert", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "codex", id: "t1" }] },
    async ({ daemon, phone }) => {
      showCodexThread(daemon, "t1");
      const upsert = await upsertOf(phone, "t1");
      assert.deepEqual(upsert.session.capabilities.compact, true);
      assert.deepEqual(upsert.session.capabilities.model, true);
      assert.equal(upsert.session.heading, "Refactor the parser");

      daemon.codex.handleNotification("turn/completed", { threadId: "t1", turn: codexTurn("completed") });
      const done = await phone.waitFor("alert", (f) => f.kind === "done");
      assert.equal(done.sessionKey, "codex:t1");
      phone.send({ type: "alert_shown", v: 2, id: done.id });
      const dismissed = phone.sendFrame("alert_dismissed", [done.id]);
      assert.equal(dismissed.type, "alert_dismissed");

      daemon.codex.handleNotification("turn/completed", { threadId: "t1", turn: codexTurn("failed") });
      const error = await phone.waitFor("alert", (f) => f.kind === "error");
      assert.equal(error.body, "model failed");
      // A glasses dismiss is theirs, so it is not reported back as a close.
      assert.equal(phone.frames.some((f) => f.type === "alert_closed" && f.id === done.id), false);
    },
  );
});

test("codex_settings_are_pending_until_the_thread_confirms_them", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "codex", id: "t1" }] },
    async ({ daemon, phone }) => {
      showCodexThread(daemon, "t1");
      const frame = phone.sendFrame("codex_settings", ["codex:t1", "gpt-6-luna", "low"]);
      assert.equal((await ackFor(phone, frame.msgId)).result, "applied");
      const pending = await upsertOf(phone, "t1", (s) => s.pendingSettings !== undefined);
      assert.deepEqual(pending.session.pendingSettings, { model: "gpt-6-luna", effort: "low" });

      daemon.codex.handleNotification("thread/settings/updated", {
        threadId: "t1",
        threadSettings: { model: "gpt-6-luna", effort: "low" },
      });
      const settled = await upsertOf(phone, "t1", (s) => s.pendingSettings === undefined);
      assert.equal(settled.session.pendingSettings, undefined);

      const claude = phone.sendFrame("codex_settings", ["claude:t1", "x"]);
      assert.equal((await ackFor(phone, claude.msgId)).error, "not_attached");
      const empty = phone.sendFrame("codex_settings", ["codex:t1"]);
      assert.equal((await ackFor(phone, empty.msgId)).error, "bad_settings");
    },
  );
});

test("claude_context_from_transcript_usage", () => {
  const line = (model) => ({
    type: "assistant",
    timestamp: "2026-11-14T10:00:00Z",
    message: {
      role: "assistant",
      model,
      usage: { input_tokens: 10, cache_read_input_tokens: 36348, cache_creation_input_tokens: 443, output_tokens: 99 },
      content: [{ type: "text", text: "done" }],
    },
  });
  assert.deepEqual(extractTranscriptUpdate(line("claude-opus-4-7"), 0).context, { used: 36801, window: 200000 });
  assert.deepEqual(extractTranscriptUpdate(line("claude-opus-4-7[1m]"), 0).context, { used: 36801, window: 1000000 });
  assert.equal(extractTranscriptUpdate({ type: "user", message: { role: "user", content: "hi" } }, 0).context, undefined);

  const update = extractTranscriptUpdate({ type: "ai-title", aiTitle: "Billing retries" }, 0);
  assert.equal(update.heading, "Billing retries");

  // The store carries both onto the published session.
  const store = new SessionStore({ machineId: "m", machineName: "m" }, silentLogger);
  store.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "first prompt here" });
  assert.equal(store.get("s1").heading, "first prompt here");
  store.applyTranscriptUpdate("s1", extractTranscriptUpdate(line("claude-opus-4-7"), 0));
  assert.deepEqual(store.get("s1").context, { used: 36801, window: 200000 });
  store.applyTranscriptUpdate("s1", update);
  assert.equal(store.get("s1").heading, "Billing retries");
  store.dispose();
});

test("settings_sync_updates_wait_limit_and_caps_at_3600s", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon({ transport, tls: false }, async ({ daemon, phone, coderDir }) => {
      // Not steering: a plaintext link may carry it.
      assert.equal(classifyFrame("settings_sync"), "monitor");
      const timings = { ...DEFAULT_ALERT_TIMINGS, dwellMs: 3000, reminderMs: 120000, retryBackoffMs: [1000, 2000] };
      const frame = { type: "settings_sync", v: 2, timings, waitLimitMs: 7_200_000, msgId: "sync-1" };
      phone.send(frame);
      assert.equal((await ackFor(phone, "sync-1")).result, "applied");
      assert.equal(daemon.stopWait.currentWaitLimitMs, 3_600_000);
      assert.equal(daemon.questionRelay.currentWaitLimitMs, 3_600_000);
      const saved = JSON.parse(await fsp.readFile(path.join(coderDir, "settings.json"), "utf8"));
      assert.equal(saved.waitLimitMs, 3_600_000);
      assert.deepEqual(saved.timings, timings);
      assert.deepEqual(saved.defaultModes, { claude: "ask", codex: "ask" });

      phone.send({ ...frame, msgId: "sync-2", waitLimitMs: 600_000 });
      await ackFor(phone, "sync-2");
      assert.equal(daemon.stopWait.currentWaitLimitMs, 600_000);

      phone.send({ ...frame, msgId: "sync-3", timings: { ...timings, dwellMs: -1 } });
      assert.equal((await ackFor(phone, "sync-3")).error, "bad_settings");
      assert.equal(daemon.stopWait.currentWaitLimitMs, 600_000);
      phone.send({ ...frame, msgId: "sync-4", waitLimitMs: "forever" });
      assert.equal((await ackFor(phone, "sync-4")).error, "bad_settings");

      // What was saved is what the next start reads.
      const reread = new PhoneSettingsStore(path.join(coderDir, "settings.json"));
      assert.equal(reread.get().waitLimitMs, 600_000);
      assert.equal(reread.get().timings.dwellMs, 3000);
    });
  }
});

test("settings_sync_with_default_modes_key_is_rejected", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon({ transport, tls: true }, async ({ daemon, phone, coderDir }) => {
      const base = { type: "settings_sync", v: 2, timings: DEFAULT_ALERT_TIMINGS, waitLimitMs: 900_000 };
      phone.send({ ...base, msgId: "dm-1", defaultModes: { claude: "acceptEdits", codex: "ask" } });
      assert.equal((await ackFor(phone, "dm-1")).error, "default_modes_not_allowed");
      phone.send({ ...base, msgId: "dm-2", timings: { ...DEFAULT_ALERT_TIMINGS, defaultModes: {} } });
      assert.equal((await ackFor(phone, "dm-2")).error, "default_modes_not_allowed");
      assert.equal(await exists(path.join(coderDir, "settings.json")), false);
      assert.equal(daemon.stopWait.currentWaitLimitMs, 1_800_000);
    });
  }
});

test("models_request_returns_codex_models", async () => {
  await withDaemon(
    {
      transport: "wshub",
      tls: false,
      attached: [{ provider: "codex", id: "t1" }, { provider: "claude", id: "c1" }],
    },
    async ({ daemon, phone }) => {
      daemon.codex.listModels = async () => ["gpt-6-luna", "gpt-6"];
      daemon.codex.appliedSettings.set("t1", { model: "gpt-6-luna", effort: "low" });
      // A monitor frame: fine over plaintext.
      phone.send({ type: "models_request", v: 2, sessionKey: "codex:t1" });
      const models = await phone.waitFor("models", (f) => f.sessionKey === "codex:t1");
      assert.deepEqual(models.models, ["gpt-6-luna", "gpt-6"]);
      assert.deepEqual(models.efforts, ["low", "medium", "high"]);
      assert.deepEqual(models.current, { model: "gpt-6-luna", effort: "low" });
      assert.equal(models.v, 2);

      phone.send({ type: "models_request", v: 2, sessionKey: "claude:c1" });
      const claude = await phone.waitFor("models", (f) => f.sessionKey === "claude:c1");
      assert.deepEqual([claude.models, claude.efforts], [[], []]);
    },
  );
});

test("default_mode_applied_at_attach", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon({ transport, tls: true }, async ({ daemon, phone, httpPort, coderDir }) => {
      const frame = phone.sendFrame("defaults_set", ["acceptEdits", "ask"]);
      assert.equal((await ackFor(phone, frame.msgId)).result, "applied");
      const saved = JSON.parse(await fsp.readFile(path.join(coderDir, "settings.json"), "utf8"));
      assert.deepEqual(saved.defaultModes, { claude: "acceptEdits", codex: "ask" });

      daemon.attachRegistry.attach("claude", "fresh", "plugin");
      await postHook(httpPort, sessionStart("fresh"));
      const upsert = await upsertOf(phone, "fresh");
      assert.equal(upsert.session.tempMode, "acceptEdits");
      daemon.attachRegistry.attach("codex", "t9", "plugin");
      assert.equal(daemon.approvalPolicy.get("codex:t9"), "ask");

      const bad = phone.sendFrame("defaults_set", ["approveAll", "ask"]);
      assert.equal((await ackFor(phone, bad.msgId)).error, "invalid_default");
    });
  }
});

test("persisted_defaults_reach_sessions_attached_before_the_start", async () => {
  await withDaemon(
    {
      transport: "wshub",
      tls: true,
      attached: [{ provider: "claude", id: "old" }],
      coderFiles: { "settings.json": { version: 1, defaultModes: { claude: "acceptEdits", codex: "ask" } } },
    },
    async ({ daemon, phone, httpPort }) => {
      assert.equal(daemon.approvalPolicy.get("claude:old"), "acceptEdits");
      await postHook(httpPort, sessionStart("old"));
      assert.equal((await upsertOf(phone, "old")).session.tempMode, "acceptEdits");
    },
  );
});

test("plaintext_defaults_set_rejected_and_not_persisted_on_both_transports", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon({ transport, tls: false }, async ({ daemon, phone, coderDir }) => {
      const frame = buildFrame("defaults_set", ["acceptEdits", "acceptEdits"]);
      phone.send(frame);
      const ack = await ackFor(phone, frame.msgId);
      assert.deepEqual([ack.result, ack.error], ["rejected", "monitor_only"]);
      assert.equal(await exists(path.join(coderDir, "settings.json")), false);

      daemon.attachRegistry.attach("claude", "fresh", "plugin");
      assert.equal(daemon.approvalPolicy.get("claude:fresh"), "ask");
      daemon.attachRegistry.attach("codex", "t1", "plugin");
      assert.equal(daemon.approvalPolicy.get("codex:t1"), "ask");
    });
  }
});

const STEERING_FRAMES = [
  { type: "approval_decision", v: 1, requestId: "r-1", decision: "allow" },
  { type: "session_input", id: "r-2", sessionId: "s1", text: "rm -rf" },
  { type: "thread_start", id: "r-3", provider: "claude", path: "/tmp", prompt: "hi" },
  { type: "alert_action", v: 2, id: "a-1", action: "allow", msgId: "r-4" },
  { type: "followup", v: 2, sessionKey: "claude:s1", text: "hi", msgId: "r-5" },
  { type: "question_answer", v: 2, sessionKey: "claude:s1", alertId: "a-1", requestRef: "q", answers: { q: "a" }, msgId: "r-6" },
  { type: "mode_set", v: 2, sessionKey: "claude:s1", mode: "approveAll", confirmed: true, msgId: "r-7" },
  { type: "mode_revoke_all", v: 2, msgId: "r-8" },
  { type: "codex_settings", v: 2, sessionKey: "codex:t1", model: "m", msgId: "r-9" },
  { type: "codex_compact", v: 2, sessionKey: "codex:t1", msgId: "r-10" },
  { type: "defaults_set", v: 2, defaultModes: { claude: "acceptEdits", codex: "acceptEdits" }, msgId: "r-11" },
  { type: "a_frame_nobody_has_heard_of", v: 2, msgId: "r-12" },
];

test("every_steering_frame_rejected_over_plaintext_on_both_transports", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      {
        transport,
        tls: false,
        attached: [{ provider: "claude", id: "s1" }, { provider: "codex", id: "t1" }],
      },
      async ({ daemon, phone, httpPort, wsPort, token, steer, agentFingerprint, coderDir }) => {
        await postHook(httpPort, sessionStart("s1"));
        // A monitor-only phone cannot answer a Stop, so nothing is held for it.
        assert.deepEqual(await postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" }), {});
        // A second, trusted phone (wss with the steering secret) can, so the Stop
        // is held for it: a steerable state the plaintext phone must not be able to touch.
        const trusted = createFakePhone({ transport: "wshub", tls: true, pin: agentFingerprint, steer });
        await trusted.start({ port: wsPort, host: "127.0.0.1", token });
        await trusted.waitFor("snapshot");
        const held = postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
        await settle();
        assert.equal(daemon.stopWait.state("s1").waiting, true, "held for the trusted phone");
        for (const frame of STEERING_FRAMES) {
          assert.equal(classifyFrame(frame.type), "steering", frame.type);
          assert.deepEqual(authorize(frame, { trusted: false }), { ok: false, error: "monitor_only" });
          phone.send(frame);
          const id = frame.msgId ?? frame.id ?? frame.requestId;
          const ack = await ackFor(phone, id);
          assert.deepEqual([ack.result, ack.error, ack.v], ["rejected", "monitor_only", 2], frame.type);
        }
        // v1 frames that expect their own reply do not wait for one that never comes.
        assert.equal((await phone.waitFor("session_input_result", (f) => f.id === "r-2")).ok, false);
        assert.equal((await phone.waitFor("thread_started", (f) => f.id === "r-3")).ok, false);

        // Nothing ran: no mode, no delivery, no recorded id.
        assert.equal(daemon.approvalPolicy.get("claude:s1"), "ask");
        assert.deepEqual(
          daemon.stopWait.state("s1"),
          { waiting: true, continuationsLeft: 8 },
          "still held: no follow-up from the plaintext phone was delivered into it",
        );
        assert.equal(await exists(path.join(coderDir, "applied-ids.json")), false);
        assert.equal(await exists(path.join(coderDir, "settings.json")), false);
        daemon.stopWait.releaseByLaptop("s1");
        assert.deepEqual(await held, {});
        trusted.close();
      },
    );
  }
});

test("the_same_frames_run_when_the_link_is_trusted", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ phone, httpPort }) => {
        await postHook(httpPort, sessionStart("s1"));
        // A permission request is on the phone's desk; the v1 decision answers it.
        const reply = postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        });
        const request = await phone.waitFor("approval_request");
        phone.send({ type: "approval_decision", v: 1, requestId: request.requestId, decision: "allow" });
        assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");

        const unknown = { type: "a_frame_nobody_has_heard_of", v: 2, msgId: "u-1" };
        phone.send(unknown);
        assert.equal((await ackFor(phone, "u-1")).error, "unknown_frame");
      },
    );
  }
});

test("v1_session_input_is_still_gated_by_attachment_after_the_trust_gate", async () => {
  await withDaemon({ transport: "wshub", tls: true }, async ({ phone }) => {
    phone.send({ type: "session_input", id: "i-1", sessionId: "nope", text: "x" });
    const result = await phone.waitFor("session_input_result", (f) => f.id === "i-1");
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_attached");
  });
});

test("approval_expired_by_a_dropped_phone_leaves_a_notice", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort }) => {
      const reply = postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      });
      await phone.waitFor("alert", (f) => f.kind === "approval");
      // The phone goes away without answering: the approval falls back to the laptop.
      phone.close();
      assert.deepEqual(await reply, {});
      await settle();
      // The notice waits in the queue for the phone to come back.
      const waiting = daemon.phoneV2.alerts.current();
      assert.equal(waiting.kind, "notice");
      assert.match(waiting.title, /Approval expired/);
      assert.equal(waiting.sessionKey, "claude:s1");
    },
  );
});

test("a_claude_transcript_error_pushes_an_error_alert_only_for_attached_sessions", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone }) => {
      daemon.phoneV2.onClaudeError("stranger", "should not be seen");
      daemon.phoneV2.onClaudeError("s1", "API Error: overloaded");
      const alert = await phone.waitFor("alert", (f) => f.kind === "error");
      assert.equal(alert.sessionKey, "claude:s1");
      assert.equal(alert.body, "API Error: overloaded");
      assert.equal(phone.frames.some((f) => f.type === "alert" && f.sessionKey === "claude:stranger"), false);
    },
  );
});

test("heading_is_read_from_a_transcript_attached_mid_conversation", async () => {
  await withDaemon({ transport: "wshub", tls: true }, async ({ claudeDir }) => {
    const file = path.join(claudeDir, "projects", "-work-demo", "mid.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "<command-name>/init</command-name>" } },
      { type: "user", message: { role: "user", content: "Add retries to the uploader" } },
      { type: "ai-title", aiTitle: "Old title" },
      { type: "ai-title", aiTitle: "Uploader retries" },
    ];
    await fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    assert.deepEqual(await readTranscriptHeading(file), {
      aiTitle: "Uploader retries",
      firstPrompt: "Add retries to the uploader",
    });
    assert.deepEqual(await readTranscriptHeading(path.join(claudeDir, "missing.jsonl")), {});
  });
});

test("fake_phone_cli_pairs_prints_frames_and_sends_a_frame_from_argv", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, httpPort, wsPort, token, steer, agentFingerprint }) => {
      await postHook(httpPort, sessionStart("s1"));
      const child = spawn(process.execPath, [
        path.join(__dirname, "fake-phone.js"),
        "--transport", "wshub", "--port", String(wsPort), "--token", token, "--tls", "true",
        "--pin", agentFingerprint, "--wait", "1500",
        "mode_set", "claude:s1", "acceptEdits",
      ], { env: { ...process.env, FAKE_PHONE_STEER: steer } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      await new Promise((resolve) => child.once("exit", resolve));
      const printed = out.trim().split("\n").map((line) => JSON.parse(line));
      assert.ok(printed.some((frame) => frame.type === "snapshot"));
      assert.ok(printed.some((frame) => frame.type === "ack" && frame.result === "applied"));
      assert.equal(daemon.approvalPolicy.get("claude:s1"), "acceptEdits");
    },
  );
});

test("approve_all_left_by_a_previous_run_is_reported_when_the_phone_connects", async () => {
  await withDaemon(
    {
      transport: "wshub",
      tls: true,
      attached: [{ provider: "claude", id: "old" }],
      coderFiles: { "approve-all.json": { version: 1, sessions: [{ sessionKey: "claude:old", since: 1 }] } },
    },
    async ({ daemon, phone }) => {
      const reset = await phone.waitFor("mode_reset");
      assert.deepEqual(
        [reset.sessionKey, reset.from, reset.reason],
        ["claude:old", "approveAll", "helper_restarted"],
      );
      assert.equal((await phone.waitFor("alert", (f) => f.kind === "notice")).sessionKey, "claude:old");
      assert.equal(daemon.approvalPolicy.get("claude:old"), "ask");
      assert.deepEqual(daemon.takeResetNotices(), []);
    },
  );
});

test("settings_sync_floors_reject_values_below_them_and_change_nothing", async () => {
  for (const transport of TRANSPORTS) {
    await withDaemon({ transport, tls: false }, async ({ daemon, phone, coderDir }) => {
      const good = { ...DEFAULT_ALERT_TIMINGS };
      const cases = [
        ["floor-1", { ...good, dwellMs: 999 }, 600_000],
        ["floor-2", { ...good, ackTimeoutMs: 0 }, 600_000],
        ["floor-3", { ...good, retryBackoffMs: [5000, 500] }, 600_000],
        ["floor-4", { ...good, reminderMs: 29_999 }, 600_000],
        ["floor-5", { ...good, expireMs: 999 }, 600_000],
        ["floor-6", good, 29_999],
        ["floor-7", good, 0],
      ];
      for (const [msgId, timings, waitLimitMs] of cases) {
        phone.send({ type: "settings_sync", v: 2, timings, waitLimitMs, msgId });
        const ack = await ackFor(phone, msgId);
        assert.deepEqual([ack.result, ack.error], ["rejected", "bad_settings"], msgId);
      }
      assert.equal(await exists(path.join(coderDir, "settings.json")), false);
      assert.equal(daemon.stopWait.currentWaitLimitMs, 1_800_000);

      // Exactly on the floors is fine.
      phone.send({
        type: "settings_sync",
        v: 2,
        timings: { ...good, dwellMs: 1000, reminderMs: 30_000 },
        waitLimitMs: 30_000,
        msgId: "floor-ok",
      });
      assert.equal((await ackFor(phone, "floor-ok")).result, "applied");
      assert.equal(daemon.stopWait.currentWaitLimitMs, 30_000);
    });
  }
});

test("question_answer_keys_cannot_reach_a_prototype_or_grow_unbounded", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort }) => {
      const reply = postHook(httpPort, {
        hook_event_name: "PreToolUse",
        session_id: "s1",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_p",
        tool_input: { questions: [{ question: "Pick", options: [{ label: "A" }], multiSelect: false }] },
      });
      const alert = await phone.waitFor("alert", (f) => f.kind === "question");
      for (const bad of [
        '{"__proto__":"x"}',
        '{"constructor":"x"}',
        '{"prototype":["x"]}',
        JSON.stringify({ ["k".repeat(4001)]: "x" }),
      ]) {
        const frame = phone.sendFrame("question_answer", ["claude:s1", alert.id, "toolu_p", bad]);
        assert.equal((await ackFor(phone, frame.msgId)).error, "bad_answers", bad.slice(0, 30));
      }
      // The refusals left the question open and their ids free.
      const ok = phone.sendFrame("question_answer", ["claude:s1", alert.id, "toolu_p", '{"Pick":"A"}']);
      assert.equal((await ackFor(phone, ok.msgId)).result, "applied");
      const hook = await reply;
      assert.equal(Object.getPrototypeOf(hook.hookSpecificOutput.updatedInput.answers), Object.prototype);
      assert.equal(hook.hookSpecificOutput.updatedInput.answers.Pick, "A");
    },
  );
});
