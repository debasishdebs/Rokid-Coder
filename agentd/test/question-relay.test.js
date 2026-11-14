const test = require("node:test");
const assert = require("node:assert/strict");
const { QuestionRelay } = require("../dist/question-relay.js");
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
  };
}

function makeRelay(options = {}) {
  const clock = fakeTimers();
  const relay = new QuestionRelay({ waitLimitMs: 30 * 60_000, setTimer: clock.setTimer, ...options });
  const opened = [];
  const closed = [];
  relay.onOpened((event) => opened.push(event));
  relay.onClosed((event) => closed.push(event));
  return { relay, clock, opened, closed };
}

const toolInput = {
  questions: [
    {
      question: "Pick",
      header: "Pick",
      options: [
        { label: "A", description: "first" },
        { label: "B", description: "second" },
      ],
      multiSelect: false,
    },
  ],
};

const hookPayload = (overrides = {}) => ({
  hook_event_name: "PreToolUse",
  session_id: "s1",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_1",
  tool_input: toolInput,
  ...overrides,
});

const open = () => new AbortController();

test("answer_builds_updated_input_with_answers", async () => {
  const { relay } = makeRelay();
  const held = relay.hold(hookPayload(), open().signal);
  assert.equal(relay.answer("toolu_1", { Pick: "B" }, "m1"), true);
  assert.deepEqual(await held, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { ...toolInput, answers: { Pick: "B" } },
    },
  });
  assert.equal(relay.answer("toolu_1", { Pick: "A" }, "m2"), false, "a second answer has nothing to answer");
});

test("claude_question_round_trip", async () => {
  const { relay, opened, closed } = makeRelay();
  const held = relay.hold(hookPayload(), open().signal);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0], {
    sessionKey: "claude:s1",
    sessionId: "s1",
    question: {
      requestRef: "toolu_1",
      source: "claude_tool",
      items: [
        {
          text: "Pick",
          options: [
            { label: "A", description: "first" },
            { label: "B", description: "second" },
          ],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
  });
  // Free text is an answer like any other.
  relay.answer(opened[0].question.requestRef, { Pick: "Purple, because it matches my shirt" }, "m1");
  const response = await held;
  assert.equal(response.hookSpecificOutput.updatedInput.answers.Pick, "Purple, because it matches my shirt");
  assert.deepEqual(closed, [
    { sessionKey: "claude:s1", requestRef: "toolu_1", reason: "answered", msgId: "m1" },
  ]);
});

test("multiselect_answer_joined_for_claude", async () => {
  const { relay } = makeRelay();
  const held = relay.hold(
    hookPayload({
      tool_input: {
        questions: [
          { question: "Which?", options: [{ label: "X" }, { label: "Y" }, { label: "Z" }], multiSelect: true },
          { question: "Why?", options: [{ label: "Because" }], multiSelect: false },
        ],
      },
    }),
    open().signal,
  );
  relay.answer("toolu_1", { "Which?": ["X", "Z"], "Why?": "Because" }, "m1");
  const { answers } = (await held).hookSpecificOutput.updatedInput;
  assert.deepEqual(answers, { "Which?": "X, Z", "Why?": "Because" });
});

test("abort_resolves_empty", async () => {
  const { relay, closed } = makeRelay();
  const controller = open();
  const held = relay.hold(hookPayload(), controller.signal);
  controller.abort("cancelled");
  assert.deepEqual(await held, {});
  assert.equal(relay.isWaiting("toolu_1"), false);
  assert.equal(relay.answer("toolu_1", { Pick: "A" }, "m1"), false);
  assert.deepEqual(closed.map((event) => event.reason), ["cancelled"]);
  assert.deepEqual(await relay.hold(hookPayload({ tool_use_id: "toolu_2" }), controller.signal), {});
});

test("laptop_timeout_and_end_session_resolve_empty", async () => {
  const { relay, clock, closed } = makeRelay({ waitLimitMs: 1234 });
  const timedOut = relay.hold(hookPayload({ tool_use_id: "t1" }), open().signal);
  assert.equal(clock.timers[0].ms, 1234);
  clock.timers[0].fn();
  assert.deepEqual(await timedOut, {});

  const byLaptop = relay.hold(hookPayload({ tool_use_id: "t2" }), open().signal);
  relay.releaseByLaptop("s1");
  assert.deepEqual(await byLaptop, {});

  const other = relay.hold(hookPayload({ tool_use_id: "t3", session_id: "s2" }), open().signal);
  const ending = relay.hold(hookPayload({ tool_use_id: "t4" }), open().signal);
  relay.endSession("s1");
  assert.deepEqual(await ending, {});
  assert.equal(relay.isWaiting("t3"), true, "another session's question is untouched");
  relay.dispose();
  assert.deepEqual(await other, {});
  assert.deepEqual(closed.map((event) => event.reason), ["timeout", "laptop", "cancelled", "cancelled"]);
});

test("anything_that_is_not_an_answerable_ask_user_question_is_not_held", async () => {
  const { relay, opened } = makeRelay();
  const signal = open().signal;
  for (const payload of [
    hookPayload({ tool_name: "Bash" }),
    hookPayload({ hook_event_name: "PermissionRequest" }),
    hookPayload({ tool_use_id: undefined }),
    hookPayload({ session_id: undefined }),
    hookPayload({ tool_input: { questions: [] } }),
    hookPayload({ tool_input: "nope" }),
  ]) {
    assert.deepEqual(await relay.hold(payload, signal), {});
  }
  assert.deepEqual(opened, []);
});

test("no_phone_connected_resolves_empty_at_once_and_a_phone_makes_it_hold", async () => {
  let phone = false;
  const { relay, opened } = makeRelay({ canAsk: () => phone });
  assert.deepEqual(await relay.hold(hookPayload(), open().signal), {});
  assert.deepEqual(opened, []);
  assert.equal(relay.isWaiting("toolu_1"), false);
  phone = true;
  const held = relay.hold(hookPayload(), open().signal);
  assert.equal(relay.isWaiting("toolu_1"), true);
  relay.answer("toolu_1", { Pick: "A" }, "m1");
  assert.equal((await held).hookSpecificOutput.permissionDecision, "allow");
});

test("daemon_holds_ask_user_question_for_attached_sessions_only", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const opened = [];
      daemon.questionRelay.onOpened((event) => opened.push(event));
      const payload = (id) => hookPayload({ session_id: id, tool_use_id: `tu-${id}` });
      assert.deepEqual(await postHook(httpPort, payload("stranger")), {}, "unattached sessions are never held");

      let settled = false;
      const reply = postHook(httpPort, payload("held")).finally(() => { settled = true; });
      await settle();
      assert.equal(settled, false);
      assert.equal(opened.length, 1);
      assert.equal(daemon.questionRelay.answer("tu-held", { Pick: "A" }, "m1"), true);
      assert.deepEqual((await reply).hookSpecificOutput.updatedInput.answers, { Pick: "A" });

      // A laptop prompt takes the question back to the TUI.
      const second = postHook(httpPort, hookPayload({ session_id: "held", tool_use_id: "tu-2" }));
      await settle();
      await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "held", prompt: "hi" });
      assert.deepEqual(await second, {});
    },
  );
});

test("daemon_without_a_phone_leaves_question_and_stop_to_the_laptop", async () => {
  await withDaemon(
    { transport: "wshub", attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, phone, httpPort }) => {
      phone.close();
      await settle(200);
      assert.deepEqual(await postHook(httpPort, hookPayload({ session_id: "held", tool_use_id: "tu-np" })), {});
      assert.deepEqual(await postHook(httpPort, { hook_event_name: "Stop", session_id: "held" }), {});
      assert.equal(daemon.questionRelay.isWaiting("tu-np"), false);
      assert.equal(daemon.stopWait.state("held").waiting, false);
    },
  );
});

test("daemon_permission_request_for_ask_user_question_never_reaches_the_phone", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, phone, httpPort }) => {
      daemon.approvalPolicy.set("claude:held", "approveAll", true);
      const permission = (tool) => postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "held",
        tool_name: tool,
        tool_input: {},
      });
      assert.deepEqual(await permission("AskUserQuestion"), {});
      // ExitPlanMode is still the phone's to decide, and approve-all does not answer it.
      let settled = false;
      const plan = permission("ExitPlanMode").finally(() => { settled = true; });
      const request = await phone.waitFor("approval_request");
      assert.equal(request.tool, "ExitPlanMode");
      assert.equal(settled, false, "approve-all must not auto-allow ExitPlanMode");
      phone.send({ type: "approval_decision", v: 1, requestId: request.requestId, decision: "deny" });
      assert.equal((await plan).hookSpecificOutput.decision.behavior, "deny");
      assert.equal(
        phone.frames.some((frame) => frame.type === "approval_request" && frame.tool === "AskUserQuestion"),
        false,
      );
    },
  );
});

test("daemon_detach_releases_a_held_question", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "held" }] },
    async ({ daemon, httpPort }) => {
      const reply = postHook(httpPort, hookPayload({ session_id: "held", tool_use_id: "tu-d" }));
      await settle();
      assert.equal(daemon.questionRelay.isWaiting("tu-d"), true);
      daemon.attachRegistry.detach("claude", "held");
      assert.deepEqual(await reply, {});
      assert.equal(daemon.questionRelay.isWaiting("tu-d"), false);
    },
  );
});

test("claude_questions_are_capped_and_one_past_the_cap_goes_to_the_tui", async () => {
  const { MAX_PENDING_QUESTIONS } = require("../dist/question-relay.js");
  const relay = new QuestionRelay({ waitLimitMs: 60_000 });
  const ask = (id) => relay.hold({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    tool_name: "AskUserQuestion",
    tool_use_id: id,
    tool_input: { questions: [{ question: "Pick", options: [{ label: "A" }] }] },
  }, new AbortController().signal);
  const held = [];
  for (let i = 0; i < MAX_PENDING_QUESTIONS; i += 1) held.push(ask(`tu-${i}`));
  assert.deepEqual(await ask("tu-over"), {}, "left to the TUI at once");
  assert.equal(relay.isWaiting("tu-over"), false);
  relay.dispose();
  await Promise.all(held);
});
