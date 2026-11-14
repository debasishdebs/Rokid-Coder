"use strict";
/**
 * The shared wire fixtures (contracts/rokid-coder-v2.fixtures.json) run through
 * the real daemon. The Agents plugin's codec test reads the same file, so the
 * two sides cannot drift apart without one of the suites failing.
 *
 * Every phone -> agent fixture is sent over a trusted (TLS) link on both phone
 * transports and must produce the reply its frame really produces. A fixture
 * that consumes an alert or an approval runs against a fresh alert of its own,
 * in its own daemon. The frames agentd sends are compared with the agent ->
 * phone fixtures field for field.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const net = require("node:net");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { classifyFrame, FRAME_CLASS } = require("../dist/protocol-v2.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

const FIXTURES = JSON.parse(
  require("node:fs").readFileSync(path.join(__dirname, "../../contracts/rokid-coder-v2.fixtures.json"), "utf8"),
);
const TO_AGENT = FIXTURES.phone_to_agent;
const FROM_AGENT = FIXTURES.agent_to_phone;
const FROM_AGENT_VARIANTS = FIXTURES.agent_to_phone_variants;
const TRANSPORTS = ["phonelink", "wshub"];

const CLAUDE = "fx-claude";
const CODEX = "fx-codex";
const REQUEST_REF = "fx-request-ref";
const QUESTION_HOOK = {
  hook_event_name: "PreToolUse",
  session_id: CLAUDE,
  tool_name: "AskUserQuestion",
  tool_use_id: REQUEST_REF,
  tool_input: {
    questions: [
      {
        question: "Which test runner?",
        options: [{ label: "node:test", description: "Built in" }, { label: "vitest" }],
        multiSelect: false,
      },
      { question: "Which suites?", options: [{ label: "unit" }, { label: "contract" }], multiSelect: true },
    ],
  },
};

/** What the approval alert the scenarios raise says, field by field. */
const APPROVAL_ALERT = {
  // Only an approval whose command or path was cut carries it (R128).
  optional: ["truncated"],
  values: {
    kind: "approval",
    sessionKey: "claude:fx-claude",
    title: "Bash",
    body: "npm test",
    actions: ["allow", "deny"],
    waiting: 0,
    reason: "new",
  },
};

const EXPECTED_CLASSES = {
  approval_decision: "steering",
  session_input: "steering",
  thread_start: "steering",
  alert_action: "steering",
  followup: "steering",
  question_answer: "steering",
  mode_set: "steering",
  mode_revoke_all: "steering",
  codex_settings: "steering",
  codex_compact: "steering",
  launcher_command: "steering",
  defaults_set: "steering",
  settings_sync: "steering",
  hello: "monitor",
  hello_ack: "monitor",
  hello_reject: "monitor",
  refresh: "monitor",
  detail_open: "monitor",
  detail_close: "monitor",
  ping: "monitor",
  pong: "monitor",
  fs_list: "monitor",
  alert_shown: "monitor",
  alert_dismissed: "monitor",
  models_request: "monitor",
};

function codexThread(id) {
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
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));

/** The fixture with the ids agentd made swapped in for the placeholders. */
function bind(frame, ids = {}) {
  const swaps = new Map([
    ...(ids.alertId ? [[FROM_AGENT.alert.id, ids.alertId]] : []),
    ...(ids.requestId ? [[FROM_AGENT.approval_request.requestId, ids.requestId]] : []),
  ]);
  const walk = (value) => {
    if (typeof value === "string") return swaps.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
    }
    return value;
  };
  return walk(clone(frame));
}

/**
 * The frame agentd really sent and the fixture agree field for field, in both
 * directions: agentd sends nothing the fixture lacks, and nothing the fixture
 * shows is missing unless the type lists it as `optional`. `values` pins the
 * fields the scenario fixes, since the Kotlin parser reads them.
 */
function assertSameShape(real, fixture, label, { optional = [], values = {} } = {}) {
  assert.equal(real.type, fixture.type, label);
  assert.equal(real.v, fixture.v, `${label}: v`);
  const extra = Object.keys(real).filter((key) => !(key in fixture));
  assert.deepEqual(extra, [], `${label}: fields agentd sends that the fixture lacks`);
  const missing = Object.keys(fixture).filter((key) => !(key in real) && !optional.includes(key));
  assert.deepEqual(missing, [], `${label}: fields the fixture shows that agentd did not send`);
  for (const [key, value] of Object.entries(values)) {
    assert.deepEqual(real[key], value, `${label}: ${key}`);
  }
}

/** Session fields the interfaces mark optional (or v1 omits when empty); everything else must be sent. */
const OPTIONAL_SESSION_FIELDS = [
  "turn", "nativeMode", "currentFile", "step", "context", "pendingSettings", "sandbox",
  "lastAssistantText", "statusDetail", "pendingRequest",
];

/** Claude fx-claude and Codex fx-codex attached, on a trusted link over each transport in turn. */
async function inFixtureDaemon(transport, options, body) {
  await withDaemon(
    {
      transport,
      tls: options.tls ?? true,
      attached: [{ provider: "claude", id: CLAUDE }, { provider: "codex", id: CODEX }],
    },
    async (ctx) => {
      await postHook(ctx.httpPort, { hook_event_name: "SessionStart", session_id: CLAUDE, cwd: "/work/demo" });
      ctx.daemon.codex.threads.set(CODEX, codexThread(CODEX));
      ctx.daemon.codex.publishThread(CODEX);
      await ctx.phone.waitFor("session_upsert", (frame) => frame.session.id === CODEX);
      try {
        await body({ ...ctx, ...helpers(ctx) });
      } finally {
        // A failed test must not leave a hook held, or the daemon cannot stop.
        ctx.daemon.stopWait.releaseByLaptop(CLAUDE);
        ctx.daemon.questionRelay.releaseByLaptop(CLAUDE);
        ctx.daemon.approvals.dispose();
      }
    },
  );
}

function helpers({ daemon, phone, httpPort }) {
  return {
    /** A fresh approval alert, with the held tool call it stands for. */
    async approval() {
      const reply = postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: CLAUDE,
        tool_name: "Bash",
        tool_input: { command: "npm test" },
      });
      const alert = await phone.waitFor("alert", (frame) => frame.kind === "approval");
      const request = await phone.waitFor("approval_request", (frame) => frame.requestId !== undefined);
      return { reply, alert, request };
    },
    /** A fresh question alert, with the AskUserQuestion hold it stands for. */
    async question() {
      const reply = postHook(httpPort, QUESTION_HOOK);
      const alert = await phone.waitFor("alert", (frame) => frame.kind === "question");
      return { reply, alert };
    },
    /** A Stop the phone can answer: the follow-up capability turns "waiting". */
    async heldStop() {
      const reply = postHook(httpPort, { hook_event_name: "Stop", session_id: CLAUDE });
      await phone.waitFor("session_upsert", (frame) => frame.session.id === CLAUDE && frame.session.capabilities.followup === "waiting");
      return { reply };
    },
    ack: (msgId) => phone.waitFor("ack", (frame) => frame.msgId === msgId),
    alertState: (id) => daemon.phoneV2.alerts.get(id)?.state,
    /** The alert holding the glasses right now. */
    occupant: () => daemon.phoneV2.alerts.current()?.id,
  };
}

async function until(predicate, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await settle(20);
  }
}

// What each fixture really does, keyed by the frame type. The v2 steering
// frames are answered with an ack; the legacy v1 ones with their own reply.
const HANDLERS = {
  async approval_decision({ phone, approval }, fixture) {
    const { reply, alert, request } = await approval();
    phone.send(bind(fixture, { requestId: request.requestId }));
    assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");
    assert.equal((await phone.waitFor("alert_closed", (frame) => frame.id === alert.id)).reason, "acted");
    // The phone's own answer is not echoed back as an approval_resolved.
    await settle();
    assert.equal(phone.frames.some((frame) => frame.type === "approval_resolved"), false);
  },

  async session_input({ phone }, fixture) {
    phone.send(fixture);
    const result = await phone.waitFor("session_input_result", (frame) => frame.id === fixture.id);
    // Typing into a terminal is off unless the owner turned it on: the reply says so.
    assert.equal(result.ok, false);
    assert.equal(result.error, "Typing from the glasses is turned off");
  },

  async thread_start({ phone }, fixture, transport) {
    phone.send(fixture);
    if (transport === "wshub") {
      // Only the dialled phone link spawns threads; the WebSocket hub passes the gate and says nothing.
      await settle(300);
      assert.equal(phone.frames.some((frame) => frame.type === "thread_started"), false);
      return;
    }
    const result = await phone.waitFor("thread_started", (frame) => frame.id === fixture.id);
    assert.equal(result.ok, false);
    assert.equal(result.provider, "claude");
    assert.equal(typeof result.error, "string");
    assert.ok(result.error.length > 0);
    assert.equal("sessionId" in result, false, "a refused spawn names no session");
  },

  async alert_shown({ phone, approval, alertState, occupant }, fixture) {
    const { alert } = await approval();
    assert.equal(alertState(alert.id), "sent");
    phone.send(bind(fixture, { alertId: alert.id }));
    await until(() => alertState(alert.id) === "shown", "the alert to be marked shown");
    // Shown is an acknowledgement: the alert keeps the glasses.
    assert.equal(occupant(), alert.id);
  },

  async alert_dismissed({ phone, approval, alertState, occupant }, fixture) {
    const { alert } = await approval();
    assert.equal(occupant(), alert.id);
    phone.send(bind(fixture, { alertId: alert.id }));
    // A dismiss comes over a monitor frame: an approval is parked, not settled. It
    // stays answerable but gives up the glasses, which is what tells it from "shown".
    await until(() => occupant() === undefined, "the approval to leave the glasses");
    assert.equal(alertState(alert.id), "shown");
    await settle();
    assert.equal(phone.frames.some((frame) => frame.type === "alert_closed"), false);
  },

  async alert_action({ phone, approval, ack }, fixture) {
    const { reply, alert } = await approval();
    assertSameShape(alert, FROM_AGENT_VARIANTS.alert_approval, "approval alert", APPROVAL_ALERT);
    phone.send(bind(fixture, { alertId: alert.id }));
    const reply2 = await ack(fixture.msgId);
    assert.equal(reply2.result, "applied");
    assertSameShape(reply2, FROM_AGENT.ack, "ack", { optional: ["error"], values: { msgId: fixture.msgId, result: "applied" } });
    assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");
    assert.equal((await phone.waitFor("alert_closed", (frame) => frame.id === alert.id)).reason, "acted");
  },

  async followup({ phone, heldStop, ack }, fixture) {
    const { reply } = await heldStop();
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    const hook = await reply;
    assert.equal(hook.decision, "block");
    assert.match(hook.reason, new RegExp(fixture.text));
    const closed = await phone.waitFor("followup_closed");
    assert.equal(closed.reason, "delivered");
    assert.equal(closed.sessionKey, fixture.sessionKey);
    assertSameShape(closed, FROM_AGENT.followup_closed, "followup_closed", {
      values: { sessionKey: fixture.sessionKey, reason: "delivered" },
    });
  },

  async question_answer({ phone, question, ack }, fixture) {
    const { reply, alert } = await question();
    assertSameShape(alert, FROM_AGENT.alert, "question alert", {
      optional: ["actions"],
      values: {
        kind: "question",
        sessionKey: "claude:fx-claude",
        title: "Question",
        body: "Which test runner?",
        waiting: 0,
        reason: "new",
        question: FROM_AGENT.alert.question,
      },
    });
    phone.send(bind(fixture, { alertId: alert.id }));
    assert.equal((await ack(fixture.msgId)).result, "applied");
    const hook = await reply;
    assert.equal(hook.hookSpecificOutput.updatedInput.answers["Which test runner?"], "node:test");
    // Claude's AskUserQuestion takes one string per question: a multi-select answer arrives comma-joined.
    assert.equal(hook.hookSpecificOutput.updatedInput.answers["Which suites?"], "unit, contract");
    assert.equal((await phone.waitFor("alert_closed", (frame) => frame.id === alert.id)).reason, "acted");
  },

  async mode_set({ daemon, phone, ack }, fixture) {
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    assert.equal(daemon.approvalPolicy.get(fixture.sessionKey), "approveAll");
    await phone.waitFor("session_upsert", (frame) => frame.session.id === CLAUDE && frame.session.tempMode === "approveAll");
  },

  async mode_revoke_all({ daemon, phone, ack }, fixture) {
    assert.equal(daemon.approvalPolicy.set("claude:fx-claude", "approveAll", true).ok, true);
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    assert.equal(daemon.approvalPolicy.get("claude:fx-claude"), "ask");
    const reset = await phone.waitFor("mode_reset");
    assert.deepEqual([reset.sessionKey, reset.from, reset.reason], ["claude:fx-claude", "approveAll", "revoked"]);
    assertSameShape(reset, FROM_AGENT.mode_reset, "mode_reset", {
      values: { sessionKey: "claude:fx-claude", from: "approveAll", reason: "revoked" },
    });
  },

  async codex_settings({ phone, ack }, fixture) {
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    const pending = await phone.waitFor("session_upsert", (frame) => frame.session.id === CODEX && frame.session.pendingSettings);
    assert.deepEqual(pending.session.pendingSettings, { model: fixture.model, effort: fixture.effort });
  },

  async codex_compact({ daemon, phone, ack }, fixture) {
    const requests = [];
    daemon.codex.request = async (method, params) => {
      requests.push({ method, params });
      return {};
    };
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    assert.deepEqual(requests, [{ method: "thread/compact/start", params: { threadId: CODEX } }]);
  },

  async launcher_command({ daemon, phone, ack, claudeDir }, fixture) {
    phone.send(fixture);
    const refused = await ack(fixture.msgId);
    // R130: a plugin-mode session is refused, and the id stays free.
    assert.deepEqual([refused.result, refused.error, refused.v], ["rejected", "not_launcher", 2]);
    assertSameShape(refused, FROM_AGENT.ack, "ack", {
      values: { msgId: fixture.msgId, result: "rejected", error: "not_launcher" },
    });
    // Bound to an `rk claude` launcher (played here over its socket), the same
    // frame is typed and gets the launcher's real result.
    const sessionsDir = path.join(claudeDir, "sessions");
    await fsp.mkdir(sessionsDir, { recursive: true });
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const socket = net.createConnection(daemon.launchers.socketPath);
    try {
      await fsp.writeFile(
        path.join(sessionsDir, `${child.pid}.json`),
        JSON.stringify({ pid: child.pid, sessionId: CLAUDE, status: "idle", statusUpdatedAt: Date.now() - 60_000 }),
      );
      const frames = [];
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        for (let index; (index = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(index + 1)) {
          frames.push(JSON.parse(buffer.slice(0, index)));
        }
      });
      const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
      const next = async (type) => {
        for (let tries = 0; tries < 300; tries += 1) {
          const found = frames.find((f) => f.type === type);
          if (found) return found;
          await settle(10);
        }
        throw new Error(`no ${type}`);
      };
      send({ type: "launcher_hello", v: 1, launcherId: "fx-launcher", provider: "claude", childPid: child.pid });
      send({ type: "launcher_bind", sessionId: CLAUDE });
      await next("bind_accepted");
      phone.send(fixture);
      const typed = await next("type_command");
      assert.deepEqual([typed.command, typed.model], [fixture.command, fixture.model]);
      send({ type: "command_written", cmdId: typed.cmdId, at: Date.now() });
      send({ type: "command_result", cmdId: typed.cmdId, ok: true });
      const applied = await phone.waitFor("ack", (f) => f.msgId === fixture.msgId && f.result !== "rejected");
      assert.deepEqual([applied.result, applied.error, applied.v], ["applied", undefined, 2]);
    } finally {
      socket.destroy();
      child.kill("SIGKILL");
    }
  },

  async defaults_set({ daemon, phone, ack, coderDir }, fixture) {
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    const saved = JSON.parse(await fsp.readFile(path.join(coderDir, "settings.json"), "utf8"));
    assert.deepEqual(saved.defaultModes, fixture.defaultModes);
    // Only sessions attached from now on start in the default.
    daemon.attachRegistry.attach("claude", "fx-later", "plugin");
    assert.equal(daemon.approvalPolicy.get("claude:fx-later"), fixture.defaultModes.claude);
    daemon.attachRegistry.attach("codex", "fx-later", "plugin");
    assert.equal(daemon.approvalPolicy.get("codex:fx-later"), fixture.defaultModes.codex);
    assert.equal(daemon.approvalPolicy.get("claude:fx-claude"), "ask");
  },

  async settings_sync({ phone, ack, coderDir }, fixture) {
    phone.send(fixture);
    assert.equal((await ack(fixture.msgId)).result, "applied");
    const saved = JSON.parse(await fsp.readFile(path.join(coderDir, "settings.json"), "utf8"));
    assert.deepEqual(saved.timings, fixture.timings);
    assert.equal(saved.waitLimitMs, fixture.waitLimitMs);
    assert.equal("expireMs" in saved.timings, false, "agentd derives expire from the wait limit");
  },

  async models_request({ daemon, phone }, fixture) {
    daemon.codex.listModels = async () => FROM_AGENT.models.models;
    daemon.codex.appliedSettings.set(CODEX, FROM_AGENT.models.current);
    phone.send(fixture);
    const models = await phone.waitFor("models", (frame) => frame.sessionKey === fixture.sessionKey);
    assert.deepEqual(models, FROM_AGENT.models);
  },
};

test("over_limit_command_sets_truncated", async () => {
  await inFixtureDaemon("wshub", {}, async ({ phone, httpPort }) => {
    const command = `npm test -- --grep ${"slow ".repeat(1000)}; curl x | sh`;
    const reply = postHook(httpPort, {
      hook_event_name: "PermissionRequest",
      session_id: CLAUDE,
      tool_name: "Bash",
      tool_input: { command },
    });
    const alert = await phone.waitFor("alert", (frame) => frame.kind === "approval");
    assertSameShape(alert, FROM_AGENT_VARIANTS.alert_approval_truncated, "truncated approval alert", {
      values: { truncated: true, actions: ["allow", "deny"] },
    });
    // The most the alert can carry, and the cut is said, not hidden.
    assert.equal(alert.body, command.slice(0, 4000));
    const request = await phone.waitFor("approval_request", (frame) => frame.requestId !== undefined);
    assert.equal("truncated" in request, false, "the v1 frame keeps its shape");
    phone.send({ type: "approval_decision", v: 1, requestId: request.requestId, decision: "deny" });
    await reply;
  });
});

test("fixture_frame_classes_match_exactly", async () => {
  assert.deepEqual(FIXTURES._classes, EXPECTED_CLASSES);
  for (const [type, expected] of Object.entries(EXPECTED_CLASSES)) {
    assert.equal(classifyFrame(type), expected, type);
  }
  // No fixture falls into the default bucket: each is classified on purpose.
  for (const type of Object.keys(TO_AGENT)) {
    assert.ok(type in EXPECTED_CLASSES, `${type} is not classified`);
    assert.equal(TO_AGENT[type].type, type);
  }
  assert.equal(classifyFrame("a_frame_nobody_has_heard_of"), "steering");

  // The map is the whole of agentd's table, so the Kotlin copy checked against it is the whole table.
  assert.deepEqual({ ...FRAME_CLASS }, EXPECTED_CLASSES);
});

test("every_phone_to_agent_fixture_is_accepted_by_its_handler", async (t) => {
  assert.deepEqual(Object.keys(HANDLERS).sort(), Object.keys(TO_AGENT).sort(), "a fixture without a handler is untested");
  for (const transport of TRANSPORTS) {
    for (const [type, fixture] of Object.entries(TO_AGENT)) {
      await t.test(`${transport} ${type}`, async () => {
        await inFixtureDaemon(transport, {}, async (ctx) => {
          await HANDLERS[type](ctx, clone(fixture), transport);
        });
      });
    }
  }
});

test("the_snapshot_and_upserts_agentd_sends_match_the_fixtures", async () => {
  for (const transport of TRANSPORTS) {
    await inFixtureDaemon(transport, {}, async ({ phone, daemon, approval }) => {
      phone.send({ type: "refresh" });
      const snapshot = await phone.waitFor("snapshot", (frame) => frame.sessions.length > 0);
      assertSameShape(snapshot, FROM_AGENT.snapshot, "snapshot");
      const upsertFields = Object.keys(FROM_AGENT.session_upsert.session);
      const claude = snapshot.sessions.find((session) => session.id === CLAUDE);
      for (const session of snapshot.sessions) {
        const extra = Object.keys(session).filter((key) => !upsertFields.includes(key));
        assert.deepEqual(extra, [], "snapshot session fields the fixture lacks");
      }
      const missing = Object.keys(FROM_AGENT.snapshot.sessions[0]).filter((key) => !(key in claude));
      assert.deepEqual(missing, [], "snapshot session fields the fixture shows that agentd did not send");

      daemon.codex.threads.get(CODEX).cwd = "/work/parser2";
      daemon.codex.publishThread(CODEX);
      const upsert = await phone.waitFor("session_upsert", (frame) => frame.session.id === CODEX && frame.session.cwd === "/work/parser2");
      assertSameShape(upsert, FROM_AGENT.session_upsert, "session_upsert");
      assertSameShape(
        { type: "session", v: 2, ...upsert.session },
        { type: "session", v: 2, ...FROM_AGENT.session_upsert.session },
        "session_upsert session",
        {
          optional: OPTIONAL_SESSION_FIELDS,
          values: {
            id: CODEX,
            provider: "codex",
            mode: "plugin",
            // No live Codex app-server here, so a follow-up is not available.
            capabilities: { compact: true, model: true, followup: "unavailable" },
            tempMode: "ask",
            heading: "Refactor the parser",
          },
        },
      );

      // The laptop answers a held approval: the phone is told, and the alert withdrawn.
      const { alert, request } = await approval();
      assertSameShape(alert, FROM_AGENT_VARIANTS.alert_approval, "approval alert", APPROVAL_ALERT);
      assertSameShape(request, FROM_AGENT.approval_request, "approval_request", {
        values: {
          sessionId: CLAUDE,
          tool: "Bash",
          summary: "npm test",
        },
      });
      daemon.approvals.resolveRequest(request.requestId);
      const resolved = await phone.waitFor("approval_resolved", (frame) => frame.requestId === request.requestId);
      assertSameShape(resolved, FROM_AGENT.approval_resolved, "approval_resolved", { values: { outcome: "local" } });
      const closed = await phone.waitFor("alert_closed", (frame) => frame.id === alert.id);
      assertSameShape(closed, FROM_AGENT.alert_closed, "alert_closed", { values: { id: alert.id, reason: "withdrawn" } });

      phone.send({ type: "detail_open", sessionId: "ghost" });
      const rejected = await phone.waitFor("detail_rejected");
      assert.deepEqual(rejected, { ...FROM_AGENT.detail_rejected, sessionId: "ghost" });
    });
  }
});

test("malformed_fixture_variants_are_rejected", async (t) => {
  const steeringWithMsgId = Object.entries(TO_AGENT).filter(([, frame]) => frame.type !== "approval_decision" && "msgId" in frame);
  for (const transport of TRANSPORTS) {
    await t.test(`${transport} a missing msgId`, async () => {
      await inFixtureDaemon(transport, {}, async ({ phone }) => {
        let expected = 0;
        for (const [type, fixture] of steeringWithMsgId) {
          const frame = clone(fixture);
          delete frame.msgId;
          phone.send(frame);
          expected += 1;
          await until(
            () => phone.frames.filter((f) => f.type === "ack" && f.error === "bad_msg_id").length === expected,
            `${type} without a msgId to be refused`,
          );
        }
        assert.equal(phone.frames.filter((f) => f.type === "ack" && f.result === "applied").length, 0);
      });
    });

    await t.test(`${transport} a wrong sessionKey`, async () => {
      await inFixtureDaemon(transport, {}, async ({ phone, ack }) => {
        const keyed = steeringWithMsgId.filter(([type]) => !["question_answer", "launcher_command"].includes(type) && "sessionKey" in TO_AGENT[type]);
        assert.deepEqual(keyed.map(([type]) => type).sort(), ["codex_compact", "codex_settings", "followup", "mode_set"]);
        for (const [type, fixture] of keyed) {
          for (const [sessionKey, error] of [
            ["claude:ghost", "not_attached"],
            ["codex:ghost", "not_attached"],
            ["nonsense", "bad_session_key"],
            [`claude:${CODEX}`, "not_attached"],
          ]) {
            const frame = { ...clone(fixture), sessionKey, msgId: `bad-${type}-${sessionKey}` };
            phone.send(frame);
            const reply = await ack(frame.msgId);
            assert.deepEqual([reply.result, reply.error], ["rejected", error], `${type} ${sessionKey}`);
          }
        }
      });
    });

    await t.test(`${transport} question_answer over the limits`, async () => {
      await inFixtureDaemon(transport, {}, async ({ phone, question, ack }) => {
        const { reply, alert } = await question();
        const base = bind(TO_AGENT.question_answer, { alertId: alert.id });
        const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`q${index}`, "a"]));
        const bad = [
          ["wrong_session", { sessionKey: `claude:${CODEX}` }],
          ["wrong_request", { requestRef: "toolu_other" }],
          ["unknown_alert", { alertId: "no-such-alert" }],
          ["bad_answers", { answers: {} }],
          ["bad_answers", { answers: tooMany }],
          ["bad_answers", { answers: { ["k".repeat(4001)]: "x" } }],
          ["bad_answers", { answers: { q: "v".repeat(4001) } }],
          ["bad_answers", { answers: { q: Array.from({ length: 33 }, () => "x") } }],
          ["bad_answers", { answers: { q: [1] } }],
          ["bad_answers", { answers: JSON.parse('{"__proto__":"x"}') }],
          ["bad_answers", { answers: "node:test" }],
        ];
        for (const [index, [error, patch]] of bad.entries()) {
          const frame = { ...base, ...patch, msgId: `qa-bad-${index}` };
          phone.send(frame);
          const result = await ack(frame.msgId);
          assert.deepEqual([result.result, result.error], ["rejected", error], JSON.stringify(patch).slice(0, 60));
        }
        // Exactly at the limits is accepted, and every refusal left the question open and its id free.
        const edge = { ...base, answers: { ["k".repeat(4000)]: "v".repeat(4000) }, msgId: "qa-edge" };
        phone.send(edge);
        assert.equal((await ack("qa-edge")).result, "applied");
        assert.ok((await reply).hookSpecificOutput.updatedInput.answers["k".repeat(4000)]);
      });
    });

    await t.test(`${transport} followup text at and over 16 KiB`, async () => {
      await inFixtureDaemon(transport, {}, async ({ phone, heldStop, ack }) => {
        const { reply } = await heldStop();
        const send = (msgId, text) => phone.send({ ...TO_AGENT.followup, msgId, text });
        // 5462 three-byte characters are 16 386 bytes: over the limit though under 16 384 characters.
        for (const [msgId, text] of [["fu-big", "a".repeat(16385)], ["fu-wide", "€".repeat(5462)], ["fu-empty", ""], ["fu-blank", "  \n "]]) {
          send(msgId, text);
          const result = await ack(msgId);
          assert.deepEqual([result.result, result.error], ["rejected", "bad_text"], msgId);
        }
        send("fu-edge", "a".repeat(16384));
        assert.equal((await ack("fu-edge")).result, "applied");
        assert.equal((await reply).decision, "block");
      });
    });
  }
});

test("steering_fixtures_rejected_monitor_only_over_plaintext", async (t) => {
  for (const transport of TRANSPORTS) {
    await t.test(transport, async () => {
      await inFixtureDaemon(transport, { tls: false }, async ({ phone, daemon, coderDir }) => {
        for (const [type, fixture] of Object.entries(TO_AGENT)) {
          if (EXPECTED_CLASSES[type] !== "steering") continue;
          const id = fixture.msgId ?? fixture.id ?? fixture.requestId;
          phone.send(fixture);
          const ack = await phone.waitFor("ack", (frame) => frame.msgId === id);
          assert.deepEqual([ack.result, ack.error, ack.v], ["rejected", "monitor_only", 2], type);
        }
        // The v1 frames that expect their own reply get it, so the old plugin never waits on silence.
        const input = await phone.waitFor("session_input_result", (frame) => frame.id === TO_AGENT.session_input.id);
        assert.deepEqual([input.ok, input.error], [false, "monitor_only"]);
        const started = await phone.waitFor("thread_started", (frame) => frame.id === TO_AGENT.thread_start.id);
        assert.deepEqual([started.ok, started.error], [false, "monitor_only"]);

        // Nothing ran.
        assert.equal(daemon.approvalPolicy.get("claude:fx-claude"), "ask");
        for (const file of ["applied-ids.json", "settings.json"]) {
          assert.equal(await fsp.access(path.join(coderDir, file)).then(() => true, () => false), false, file);
        }

        // The monitor frames are fine over a plaintext link.
        daemon.codex.listModels = async () => FROM_AGENT.models.models;
        phone.send(TO_AGENT.models_request);
        assert.deepEqual((await phone.waitFor("models")).models, FROM_AGENT.models.models);
        for (const type of ["alert_shown", "alert_dismissed"]) {
          assert.equal(classifyFrame(type), "monitor");
          phone.send(TO_AGENT[type]);
        }
        await settle();
        assert.equal(phone.frames.filter((frame) => frame.type === "ack" && frame.error !== "monitor_only").length, 0);
      });
    });
  }
});
