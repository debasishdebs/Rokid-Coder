const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { ApprovalManager } = require("../dist/approval-manager.js");
const { CodexMonitor } = require("../dist/codex/monitor.js");
const { silentLogger } = require("../dist/logger.js");
const { SessionStore } = require("../dist/session-store.js");
const { createFakePhone } = require("./fake-phone.js");
const { agentCert } = require("./helpers/tls.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

const CODEX = { "x-rokid-provider": "codex" };

const permission = (sessionId, command = "ls") => ({
  hook_event_name: "PermissionRequest",
  session_id: sessionId,
  tool_name: "Bash",
  tool_input: { command },
});

/** A phone that connects to the daemon's WsHub after the first one went away. */
async function reconnectPhone(wsPort, token, steer, tls = true) {
  const phone = createFakePhone({ transport: "wshub", tls, steer, pin: (await agentCert()).fingerprint256 });
  await phone.start({ port: wsPort, host: "127.0.0.1", token });
  await phone.waitFor("snapshot");
  return phone;
}

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

// A hook request the test can hang up on, the way Claude does once the person
// has answered the permission prompt at the laptop.
function abortableHook(port, payload) {
  const body = JSON.stringify(payload);
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/hook",
    method: "POST",
    headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
  });
  request.on("error", () => {});
  request.end(body);
  return request;
}

test("late_decision_after_disconnect_is_ignored", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort, wsPort, token, steer }) => {
      const reply = postHook(httpPort, permission("s1"));
      const alert = await phone.waitFor("alert", (f) => f.kind === "approval");
      phone.close();
      assert.deepEqual(await reply, {}, "the hook falls back to the laptop prompt, with no allow");
      await settle();
      assert.equal(daemon.approvals.size, 0);

      const second = await reconnectPhone(wsPort, token, steer);
      try {
        second.sendFrame("alert_action", [alert.id, "allow"], { msgId: "late-1" });
        const ack = await second.waitFor("ack", (f) => f.msgId === "late-1");
        assert.deepEqual({ result: ack.result, error: ack.error }, { result: "rejected", error: "expired" });
        assert.equal(daemon.approvals.size, 0);
      } finally {
        second.close();
      }
    },
  );
});

test("wshub_disconnect_expires_pending_approval", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort, wsPort, token, steer }) => {
      const reply = postHook(httpPort, permission("s1"));
      const alert = await phone.waitFor("alert", (f) => f.kind === "approval");
      phone.close();
      assert.deepEqual(await reply, {});
      await settle();

      // The approval alert is gone from the queue; what waits for the phone is the notice.
      const waiting = daemon.phoneV2.alerts.current();
      assert.equal(waiting.kind, "notice");
      assert.equal(waiting.body, "Answer on laptop");
      assert.equal(daemon.phoneV2.alerts.get(alert.id), undefined);

      const second = await reconnectPhone(wsPort, token, steer);
      try {
        const notice = await second.waitFor("alert", (f) => f.kind === "notice");
        assert.equal(notice.sessionKey, "claude:s1");
        assert.equal(notice.body, "Answer on laptop");
        assert.equal(second.frames.some((f) => f.type === "alert" && f.kind === "approval"), false);
        assert.equal(second.frames.some((f) => f.type === "approval_request"), false);
      } finally {
        second.close();
      }
    },
  );
});

test("phonelink_disconnect_expires_pending_approval", async () => {
  await withDaemon(
    { transport: "phonelink", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort }) => {
      const reply = postHook(httpPort, permission("s1"));
      await phone.waitFor("alert", (f) => f.kind === "approval");
      phone.close();
      assert.deepEqual(await reply, {});
      await settle();
      assert.equal(daemon.approvals.size, 0);
      assert.equal(daemon.phoneV2.alerts.current().body, "Answer on laptop");
    },
  );
});

test("a_disconnect_keeps_the_approval_while_the_other_transport_still_has_a_phone", async () => {
  await withDaemon(
    { transport: "phonelink", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort, wsPort, token, steer }) => {
      const hubPhone = await reconnectPhone(wsPort, token, steer);
      try {
        const reply = postHook(httpPort, permission("s1"));
        await phone.waitFor("alert", (f) => f.kind === "approval");

        // The dialled link drops, but a phone is still connected over the hub.
        phone.close();
        const resent = await hubPhone.waitFor("approval_request");
        await settle();
        assert.equal(daemon.approvals.size, 1, "the approval is still pending");

        const alert = await hubPhone.waitFor("alert", (f) => f.kind === "approval");
        hubPhone.sendFrame("alert_action", [alert.id, "allow"], { msgId: "hub-allow" });
        assert.equal((await hubPhone.waitFor("ack", (f) => f.msgId === "hub-allow")).result, "applied");
        assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");
        assert.equal(resent.type, "approval_request");
      } finally {
        hubPhone.close();
      }
    },
  );
});

test("laptop_answer_expires_alert_and_rejects_late_phone_answer", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ daemon, phone, httpPort }) => {
      const request = abortableHook(httpPort, permission("s1"));
      const alert = await phone.waitFor("alert", (f) => f.kind === "approval");

      // Claude hangs up on the hook once the prompt was answered at the laptop.
      request.destroy();
      const closed = await phone.waitFor("alert_closed", (f) => f.id === alert.id);
      assert.equal(closed.reason, "withdrawn");
      assert.equal(daemon.approvals.size, 0);

      phone.sendFrame("alert_action", [alert.id, "allow"], { msgId: "late-laptop" });
      const ack = await phone.waitFor("ack", (f) => f.msgId === "late-laptop");
      assert.deepEqual({ result: ack.result, error: ack.error }, { result: "rejected", error: "expired" });
    },
  );
});

test("approval_timeout_follows_wait_limit", async () => {
  // The limit the phone last synced is the lifetime of the next request.
  await withDaemon(
    {
      transport: "wshub",
      tls: true,
      coderFiles: { "settings.json": { version: 1, waitLimitMs: 90_000 } },
    },
    async ({ daemon, phone }) => {
      assert.equal(daemon.approvals.timeoutMs, 90_000, "the persisted wait limit, not a fixed 120 s");
      const sync = phone.sendFrame("settings_sync", ["45000"], { msgId: "sync-1" });
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === sync.msgId)).result, "applied");
      assert.equal(daemon.approvals.timeoutMs, 45_000);
    },
  );
  const transport = { connected: true, sendApprovalRequest: () => true, sendApprovalResolved: () => true };
  const manager = new ApprovalManager({ transport, logger: silentLogger, timeoutMs: 500 });
  manager.setTimeoutMs(40);
  const started = Date.now();
  const decision = await manager.requestDecision({
    type: "approval_request", v: 1, requestId: "r1", sessionId: "s", provider: "claude",
    sessionKey: "claude:s", approvalKind: "tool", tool: "Bash", summary: "x", detail: "x", createdAt: 1,
  });
  assert.equal(decision, undefined);
  assert.ok(Date.now() - started < 400, "the new limit applies to the next request");
});

test("reconnect_replays_snapshot_and_alerts", async () => {
  await withDaemon(
    {
      transport: "wshub",
      tls: true,
      attached: [{ provider: "claude", id: "s1" }, { provider: "claude", id: "s2" }],
    },
    async ({ daemon, phone, wsPort, token, steer }) => {
      const set = phone.sendFrame("mode_set", ["claude:s2", "approveAll", "true"], { msgId: "ma-1" });
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === set.msgId)).result, "applied");
      phone.close();
      await settle();

      // While nobody is connected: an error alert queues, and a session with approve-all ends.
      daemon.phoneV2.onClaudeError("s1", "API Error: overloaded");
      daemon.attachRegistry.detach("claude", "s2");
      await settle();

      const second = await reconnectPhone(wsPort, token, steer);
      try {
        const reset = await second.waitFor("mode_reset");
        const alert = await second.waitFor("alert", (f) => f.kind === "error");
        assert.deepEqual(
          { sessionKey: reset.sessionKey, from: reset.from, reason: reset.reason },
          { sessionKey: "claude:s2", from: "approveAll", reason: "session_ended" },
        );
        assert.equal(alert.body, "API Error: overloaded");
        const types = second.frames.map((f) => f.type);
        assert.ok(types.indexOf("snapshot") < types.indexOf("alert"), "the snapshot comes first");
        assert.ok(types.indexOf("snapshot") < types.indexOf("mode_reset"));
        assert.equal(second.frames.filter((f) => f.type === "mode_reset").length, 1);
      } finally {
        second.close();
      }
    },
  );
});

test("reset_notices_wait_for_a_phone_instead_of_being_drained", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s2" }] },
    async ({ daemon, phone, wsPort, token, steer }) => {
      const set = phone.sendFrame("mode_set", ["claude:s2", "approveAll", "true"], { msgId: "ma-2" });
      await phone.waitFor("ack", (f) => f.msgId === set.msgId);
      phone.close();
      await settle();
      daemon.attachRegistry.detach("claude", "s2");
      await settle();
      // Nothing was announced into the void: the notice is still there to be taken.
      assert.deepEqual(
        daemon.takeResetNotices().map((n) => [n.sessionKey, n.reason]),
        [["claude:s2", "session_ended"]],
      );
      assert.equal(daemon.takeResetNotices().length, 0);
      const second = await reconnectPhone(wsPort, token, steer);
      second.close();
    },
  );
});

test("codex_attach_subscribes_and_detach_unsubscribes_through_the_hook_path", async () => {
  await withDaemon({ transport: "wshub" }, async ({ daemon, httpPort }) => {
    const calls = [];
    daemon.codex.subscribe = async (id) => { calls.push(["subscribe", id]); };
    daemon.codex.unsubscribe = (id) => { calls.push(["unsubscribe", id]); };
    const prompt = (text) => ({ hook_event_name: "UserPromptSubmit", session_id: "t1", cwd: "/work/demo", prompt: text });

    await postHook(httpPort, prompt("rokid:on"), CODEX);
    assert.deepEqual(calls, [["subscribe", "t1"]]);
    await postHook(httpPort, prompt("rokid:off"), CODEX);
    assert.deepEqual(calls, [["subscribe", "t1"], ["unsubscribe", "t1"]]);
  });
});

test("claude_attach_mid_session_rebuilds_recent_messages", async () => {
  await withDaemon({ transport: "wshub", tls: true }, async ({ phone, httpPort, claudeDir }) => {
    const file = path.join(claudeDir, "projects", "-work-demo", "mid.jsonl");
    const at = (n) => new Date(Date.UTC(2026, 10, 14, 10, 0, n)).toISOString();
    const lines = [
      { type: "user", timestamp: at(1), message: { role: "user", content: "Add retries" } },
      { type: "assistant", timestamp: at(2), message: { role: "assistant", content: [{ type: "text", text: "Looking at the uploader." }] } },
      { type: "user", timestamp: at(3), message: { role: "user", content: "Go ahead" } },
      { type: "assistant", timestamp: at(4), message: { role: "assistant", content: [{ type: "text", text: "Retries added with backoff." }] } },
    ];
    await fsp.writeFile(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    // The command attaches a session that is already under way; tailing would start at the end of the file.
    const reply = await postHook(httpPort, {
      hook_event_name: "UserPromptExpansion",
      command_name: "rokid:on",
      session_id: "mid",
      cwd: "/work/demo",
      transcript_path: file,
    });
    assert.equal(reply.decision, "block");

    const upsert = await phone.waitFor(
      "session_upsert",
      (f) => f.session.id === "mid" && f.session.lastAssistantText === "Retries added with backoff.",
    );
    assert.equal(upsert.session.lastAssistantText, "Retries added with backoff.");

    phone.send({ type: "detail_open", sessionId: "mid" });
    const detail = await phone.waitFor("detail", (f) => f.sessionId === "mid");
    assert.deepEqual(
      detail.messages.map((m) => m.text),
      ["Add retries", "Looking at the uploader.", "Go ahead", "Retries added with backoff."],
    );
  });
});

// ---- Codex: a stand-in for the shared daemon, with turn history ----

const identity = { machineId: "reconnect-machine", machineName: "reconnect-pc" };

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

function codexTurn(id, question, answer, startedAt) {
  return {
    id,
    items: [
      { type: "userMessage", id: `${id}-u`, content: [{ type: "text", text: question }] },
      { type: "agentMessage", id: `${id}-a`, text: answer },
    ],
    itemsView: "full",
    status: "completed",
    error: null,
    startedAt,
    completedAt: startedAt + 1,
    durationMs: 1000,
  };
}

async function listenUnix() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc10-"));
  const socketPath = path.join(dir, "s.sock");
  const server = http.createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    server,
    sockets,
    socketPath,
    dir,
    async close() {
      for (const client of sockets.clients) client.terminate();
      await new Promise((resolve) => sockets.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
    },
    /** Drops every client, as a restarted Codex daemon would. */
    dropClients() {
      for (const client of sockets.clients) client.terminate();
    },
  };
}

/**
 * `thread/read` answers without turns on purpose (history is paginated), so
 * anything the monitor knows about the conversation came from thread/turns/list,
 * which this serves newest first in pages of at most `pageCap` turns.
 */
function fakeCodex(daemon, { threads, turns, pageCap = 100 }) {
  const requests = [];
  const connections = [];
  daemon.sockets.on("connection", (socket) => {
    connections.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === undefined) return;
      requests.push({ method: message.method, params: message.params });
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/loaded/list":
          result = { data: [...threads.keys()] };
          break;
        case "thread/resume":
          result = { thread: { ...threads.get(message.params.threadId), turns: [] }, model: "gpt-5", modelProvider: "openai", serviceTier: null, cwd: "/work/parser" };
          break;
        case "thread/read":
          result = { thread: { ...threads.get(message.params.threadId), turns: [] } };
          break;
        case "thread/turns/list": {
          const all = [...(turns.get(message.params.threadId) ?? [])].reverse();
          const offset = Number(message.params.cursor ?? 0);
          const size = Math.min(message.params.limit ?? pageCap, pageCap);
          const page = all.slice(offset, offset + size);
          result = {
            data: page,
            nextCursor: offset + size < all.length ? String(offset + size) : null,
            backwardsCursor: page.length ? "back" : null,
          };
          break;
        }
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  return { requests, connections };
}

function codexHarness(daemon, overrides = {}) {
  const store = new SessionStore(identity, silentLogger);
  const transport = { connected: false, sendApprovalRequest: () => false, sendApprovalResolved: () => false };
  const approvals = new ApprovalManager({ transport, logger: silentLogger, timeoutMs: 1000 });
  const monitor = new CodexMonitor({
    config: {
      ...identity,
      codex: { enabled: true, port: 0, useSharedDaemon: true, socketPath: daemon.socketPath },
    },
    store,
    approvals,
    logger: silentLogger,
    isAttached: () => true,
    connectTimeoutMs: 80,
    requestTimeoutMs: 1000,
    startTimeoutMs: 500,
    reconnectDelayMs: 20,
    rolloutRetryMs: 15,
    launch: () => { throw new Error("must never spawn"); },
    ...overrides,
  });
  return {
    store,
    monitor,
    async dispose() {
      await monitor.stop();
      approvals.dispose();
      store.dispose();
    },
  };
}

const resumesOf = (requests, threadId) =>
  requests.filter((r) => r.method === "thread/resume" && r.params.threadId === threadId);

test("codex_socket_reconnect_resubscribes_attached", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["a", codexThread("a")], ["b", codexThread("b")]]);
  const turns = new Map([["a", [codexTurn("a1", "q", "answer a", 1_753_000_100)]], ["b", []]]);
  const { requests } = fakeCodex(daemon, { threads, turns });
  const { store, monitor, dispose } = codexHarness(daemon);
  try {
    await monitor.subscribe("a");
    await monitor.subscribe("b");
    monitor.start();
    await waitUntil(() => monitor.availability().available && store.get("a") && store.get("b"), "monitor did not subscribe");
    assert.equal(resumesOf(requests, "a").length, 1);
    assert.equal(resumesOf(requests, "b").length, 1);

    daemon.dropClients();
    await waitUntil(
      () => resumesOf(requests, "a").length === 2 && resumesOf(requests, "b").length === 2,
      "attached threads were not resumed again on the new connection",
    );
    assert.deepEqual(resumesOf(requests, "a")[1].params, { threadId: "a", excludeTurns: true });
    assert.ok(monitor.availability().available);
  } finally {
    await dispose();
    await daemon.close();
  }
});

test("codex_resubscribe_rebuilds_missed_output_from_turns_list", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["a", codexThread("a")]]);
  const turns = new Map([["a", [codexTurn("t1", "first question", "first answer", 1_753_000_100)]]]);
  const { requests } = fakeCodex(daemon, { threads, turns });
  const { store, monitor, dispose } = codexHarness(daemon);
  try {
    await monitor.subscribe("a");
    monitor.start();
    await waitUntil(() => store.get("a")?.lastAssistantText === "first answer", "history was not rebuilt on attach");
    assert.deepEqual((await monitor.readMessages("a", 40)).map((m) => m.text), ["first question", "first answer"]);

    // Two turns happen while the connection is down; resume replays nothing.
    daemon.dropClients();
    turns.get("a").push(
      codexTurn("t2", "second question", "second answer", 1_753_000_200),
      codexTurn("t3", "third question", "third answer", 1_753_000_300),
    );
    await waitUntil(() => resumesOf(requests, "a").length === 2, "thread was not resumed again");
    await waitUntil(() => store.get("a")?.lastAssistantText === "third answer", "missed output was not rebuilt");
    assert.deepEqual(
      (await monitor.readMessages("a", 40)).map((m) => m.text),
      ["first question", "first answer", "second question", "second answer", "third question", "third answer"],
    );
  } finally {
    await dispose();
    await daemon.close();
  }
});

test("codex_history_pages_until_forty_messages", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["a", codexThread("a")]]);
  const many = Array.from({ length: 30 }, (_, i) => codexTurn(`t${i}`, `q${i}`, `a${i}`, 1_753_000_000 + i * 10));
  const turns = new Map([["a", many]]);
  const { requests } = fakeCodex(daemon, { threads, turns, pageCap: 5 });
  const { store, monitor, dispose } = codexHarness(daemon);
  try {
    await monitor.subscribe("a");
    monitor.start();
    await waitUntil(() => store.get("a")?.lastAssistantText === "a29", "history was not rebuilt");
    const messages = await monitor.readMessages("a", 40);
    assert.equal(messages.length, 40);
    assert.deepEqual([messages[0].text, messages.at(-1).text], ["q10", "a29"]);
    // 20 turns hold the 40 messages: four pages of five, and no page past that.
    const listings = requests.filter((r) => r.method === "thread/turns/list");
    assert.ok(listings.length >= 4);
    assert.ok(listings.every((r) => r.params.sortDirection === "desc" && r.params.itemsView === "full"));
    assert.equal(listings.filter((r) => r.params.cursor === "20").length, 0, "no page past the 40th message");
  } finally {
    await dispose();
    await daemon.close();
  }
});

test("codex_live_context_is_cleared_on_socket_close_and_reseeded_from_the_rollout", async () => {
  const daemon = await listenUnix();
  const rollout = path.join(daemon.dir, "rollout.jsonl");
  const writeRollout = (tokens) => fs.writeFileSync(rollout, `${JSON.stringify({
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, model_context_window: 1000 } },
  })}\n`);
  writeRollout(100);
  const threads = new Map([["a", codexThread("a", { path: rollout })]]);
  const { requests, connections } = fakeCodex(daemon, { threads, turns: new Map() });
  const { monitor, dispose } = codexHarness(daemon);
  try {
    await monitor.subscribe("a");
    monitor.start();
    await waitUntil(() => monitor.contextUsage("a")?.used === 100, "rollout was not read");

    connections[0].send(JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: { threadId: "a", tokenUsage: { last: { totalTokens: 500 }, modelContextWindow: 1000 } },
    }));
    await waitUntil(() => monitor.contextUsage("a")?.used === 500, "live update was not applied");

    // The conversation moved on while the link was down; the rollout knows, the stale live value does not.
    writeRollout(700);
    daemon.dropClients();
    await waitUntil(() => resumesOf(requests, "a").length === 2, "thread was not resumed again");
    await waitUntil(() => monitor.contextUsage("a")?.used === 700, "stale live context beat the re-read rollout");
  } finally {
    await dispose();
    await daemon.close();
  }
});
