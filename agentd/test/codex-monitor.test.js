const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { ApprovalManager } = require("../dist/approval-manager.js");
const {
  CodexMonitor,
  MAX_CODEX_SESSIONS,
  codexApprovalRequestId,
  codexApprovalResponse,
  codexSpawnSpec,
  codexTerminateSpec,
  describeCodexApproval,
  normalizeCodexThread,
} = require("../dist/codex/monitor.js");
const {
  codexThreadMessages,
  extractCodexMessage,
} = require("../dist/codex/messages.js");
const { silentLogger } = require("../dist/logger.js");
const { SessionStore } = require("../dist/session-store.js");
const {
  CODEX_APP_SERVER_BINDINGS_VERSION,
} = require("../dist/codex/protocol.js");

const identity = {
  machineId: "codex-machine",
  machineName: "codex-pc",
};

function makeThread(overrides = {}) {
  return {
    id: "codex-thread-1",
    sessionId: "codex-session-tree",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Implement the Codex monitor",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: 1_753_000_000,
    updatedAt: 1_753_000_010,
    recencyAt: 1_753_000_020,
    status: { type: "idle" },
    path: "C:\\Users\\test\\.codex\\sessions\\thread.jsonl",
    cwd: "E:\\work\\sample",
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

function turn(status, overrides = {}) {
  return {
    id: "turn-1",
    items: [],
    itemsView: "all",
    status,
    error: status === "failed"
      ? { message: "model failed", codexErrorInfo: null, additionalDetails: null }
      : null,
    startedAt: 1_753_000_030,
    completedAt: status === "inProgress" ? null : 1_753_000_040,
    durationMs: status === "inProgress" ? null : 10_000,
    ...overrides,
  };
}

// Redacted copies of item shapes observed through thread/read on the live
// app-server. Field names and nesting are preserved; user content is not.
const REAL_APP_SERVER_ITEMS = [
  {
    id: "item-user-redacted",
    type: "userMessage",
    content: [{ type: "text", text: "[redacted user request]\r\nsecond line", text_elements: [] }],
    clientId: null,
  },
  {
    id: "item-agent-redacted",
    type: "agentMessage",
    text: "[redacted answer]\n\nwith detail",
    phase: "final_answer",
    memoryCitation: null,
  },
  {
    id: "item-file-redacted",
    type: "fileChange",
    changes: [{ path: "E:\\redacted\\src\\monitor.ts", kind: "update", diff: "[redacted]" }],
    status: "completed",
  },
  {
    id: "item-mcp-redacted",
    type: "mcpToolCall",
    server: "cua-driver",
    tool: "get_window_state",
    arguments: { session: "[redacted]" },
    status: "completed",
    durationMs: 10,
    result: null,
    error: null,
    pluginId: null,
    appContext: null,
  },
  { id: "item-reasoning-redacted", type: "reasoning", content: [], summary: [] },
  { id: "item-search-redacted", type: "webSearch", query: "[redacted]", action: null, results: [] },
];

// Redacted copies of representative JSONL records observed in real rollouts.
const REAL_ROLLOUT_LINES = [
  {
    timestamp: "2026-08-08T10:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "[redacted rollout request]\r\nnext line" }],
    },
  },
  {
    timestamp: "2026-08-08T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "[redacted rollout answer]" }],
    },
  },
  {
    timestamp: "2026-08-08T10:00:02.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "git status", workdir: "E:\\redacted" }),
      call_id: "call-redacted",
    },
  },
  {
    timestamp: "2026-08-08T10:00:03.000Z",
    type: "response_item",
    payload: { type: "reasoning", content: null, summary: [], encrypted_content: null },
  },
];

class FakeApprovalTransport {
  connected = true;
  frames = [];

  sendApprovalRequest(request) {
    if (!this.connected) return false;
    this.frames.push({ ...request });
    return true;
  }

  sendApprovalResolved(requestId, outcome) {
    if (!this.connected) return false;
    this.frames.push({ type: "approval_resolved", v: 1, requestId, outcome });
    return true;
  }
}

async function waitUntil(predicate, message, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
}

function makeHarness(port, overrides = {}) {
  const store = new SessionStore(identity, silentLogger);
  const transport = new FakeApprovalTransport();
  const approvals = new ApprovalManager({
    transport,
    logger: silentLogger,
    timeoutMs: overrides.approvalTimeoutMs ?? 1000,
    policy: overrides.policy,
  });
  const monitor = new CodexMonitor({
    config: {
      ...identity,
      codex: {
        enabled: true,
        port,
        useSharedDaemon: overrides.useSharedDaemon ?? false,
        socketPath: overrides.socketPath,
      },
    },
    store,
    approvals,
    logger: silentLogger,
    isAttached: overrides.isAttached ?? (() => true),
    onThreadEnded: overrides.onThreadEnded,
    connectTimeoutMs: 80,
    requestTimeoutMs: 1000,
    startTimeoutMs: 500,
    reconnectDelayMs: 20,
    sweepIntervalMs: overrides.sweepIntervalMs,
    rolloutRetryMs: overrides.rolloutRetryMs,
    launch: overrides.launch ?? (() => {
      throw new Error("codex executable not found");
    }),
    terminate: overrides.terminate,
  });
  return { store, transport, approvals, monitor };
}

function attachProtocol(server, threadFactory = () => makeThread()) {
  const connections = [];
  server.on("connection", (socket) => {
    const record = { socket, messages: [] };
    connections.push(record);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      record.messages.push(message);
      if (message.id === undefined) return;
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/list":
          result = { data: [threadFactory()], nextCursor: null, backwardsCursor: null };
          break;
        case "thread/resume":
          result = {
            thread: threadFactory(),
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: threadFactory().cwd,
          };
          break;
        case "thread/read":
          result = { thread: threadFactory() };
          break;
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  return connections;
}

test("Codex display mapping uses observed app-server items and skips internal chatter", () => {
  const startedAt = 1_753_000_030;
  const threadValue = makeThread({
    turns: [turn("completed", { startedAt, items: structuredClone(REAL_APP_SERVER_ITEMS) })],
  });
  const messages = codexThreadMessages(threadValue, 40);

  assert.deepEqual(messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "tool",
  ]);
  assert.equal(messages[0].text, "[redacted user request]\nsecond line");
  assert.equal(messages[1].text, "[redacted answer]\n\nwith detail");
  assert.match(messages[2].text, /^edit · .*monitor\.ts$/);
  assert.equal(messages[2].tool, "edit");
  assert.equal(messages[3].text, "get_window_state");
  assert.equal(messages[3].tool, "get_window_state");
  assert.equal(messages.every((message) => message.at === startedAt * 1000), true);
  assert.deepEqual(codexThreadMessages(threadValue, 2), messages.slice(-2));
});

test("Codex display mapping accepts real rollout record shapes defensively", () => {
  const messages = REAL_ROLLOUT_LINES
    .map((line) => extractCodexMessage(line, 1))
    .filter(Boolean);

  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "tool"]);
  assert.equal(messages[0].text, "[redacted rollout request]\nnext line");
  assert.equal(messages[1].text, "[redacted rollout answer]");
  assert.equal(messages[2].text, "shell · git status");
  assert.equal(messages[2].tool, "shell");
  assert.equal(messages[2].at, Date.parse("2026-08-08T10:00:02.000Z"));
  assert.equal(extractCodexMessage(null), undefined);
  assert.equal(extractCodexMessage({ type: "response_item", payload: null }), undefined);
});

test("readMessages uses only thread/read and returns the requested display tail", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const currentThread = makeThread({
    turns: [turn("completed", { items: structuredClone(REAL_APP_SERVER_ITEMS) })],
  });
  const connections = attachProtocol(server, () => structuredClone(currentThread));
  const { store, approvals, monitor } = makeHarness(port);
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not connect");
    const requestStart = connections[0].messages.length;

    const messages = await monitor.readMessages(currentThread.id, 3);

    assert.deepEqual(
      connections[0].messages.slice(requestStart).map((message) => message.method),
      ["thread/read"],
    );
    assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "tool"]);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeServer(server);
  }
});

test("Codex normalization has conservative explicit status, title, and path mappings", () => {
  const cases = [
    [{ status: { type: "active", activeFlags: [] }, turns: [turn("inProgress")] }, "working"],
    [{ status: { type: "active", activeFlags: ["waitingOnApproval"] } }, "needs_you"],
    [{ status: { type: "idle" }, turns: [turn("failed")] }, "error"],
    [{ status: { type: "systemError" } }, "error"],
    [{ status: { type: "notLoaded" }, turns: [turn("completed")] }, "idle"],
  ];
  for (const [overrides, expected] of cases) {
    assert.equal(normalizeCodexThread(makeThread(overrides), identity).status, expected);
  }

  const named = normalizeCodexThread(
    makeThread({ name: "  Friendly name  " }),
    identity,
  );
  assert.equal(named.provider, "codex");
  assert.equal(named.title, "Friendly name");
  assert.equal(named.cwd, "E:/work/sample");
  assert.equal(named.project, "sample");

  const pending = normalizeCodexThread(
    makeThread({ status: { type: "idle" }, turns: [turn("failed")] }),
    identity,
    { summary: "Approve npm test", createdAt: 1_753_000_050_000 },
  );
  assert.equal(pending.status, "needs_you", "an active approval takes precedence");
  assert.equal(pending.pendingRequest.kind, "permission");
});

test("approval projections and responses use the JSON-RPC id and exact stable contracts", () => {
  assert.notEqual(codexApprovalRequestId("rpc-7"), codexApprovalRequestId(7));
  assert.equal(codexApprovalRequestId("rpc-7"), "codex:s:cnBjLTc");

  const command = {
    id: "rpc-7",
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "reused-item-id",
      startedAtMs: 123,
      environmentId: null,
      reason: "Run tests",
      command: "npm test",
      cwd: "E:\\repo",
    },
  };
  assert.deepEqual(describeCodexApproval(command), {
    tool: "Command",
    summary: "Run tests",
    detail: "npm test",
    createdAt: 123,
  });
  assert.deepEqual(codexApprovalResponse(command, "allow"), { decision: "accept" });
  assert.deepEqual(codexApprovalResponse(command, "deny"), { decision: "decline" });

  const permissions = {
    id: 9,
    method: "item/permissions/requestApproval",
    params: {
      threadId: "thread",
      turnId: "turn",
      itemId: "item",
      environmentId: null,
      startedAtMs: 456,
      cwd: "E:\\repo",
      reason: null,
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ["E:\\input"], write: ["E:\\output"] },
      },
    },
  };
  assert.deepEqual(codexApprovalResponse(permissions, "allow"), {
    permissions: permissions.params.permissions,
    scope: "turn",
  });
  assert.deepEqual(codexApprovalResponse(permissions, "deny"), {
    permissions: {},
    scope: "turn",
  });
});

test("spawn command is loopback-only and honors the Windows .cmd shim", () => {
  assert.equal(CODEX_APP_SERVER_BINDINGS_VERSION, "0.145.0");
  const windows = codexSpawnSpec(8390, "win32");
  assert.equal(windows.command, "codex");
  assert.deepEqual(windows.args, [
    "app-server",
    "--listen",
    "ws://127.0.0.1:8390",
  ]);
  assert.equal(windows.options.shell, true);
  assert.equal(windows.options.windowsHide, true);
  assert.equal(windows.args.some((arg) => arg.includes("0.0.0.0")), false);
  assert.deepEqual(codexTerminateSpec(4321, "win32"), {
    command: "taskkill.exe",
    args: ["/pid", "4321", "/t", "/f"],
    options: {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    },
  });

  assert.equal(codexSpawnSpec(8390, "linux").options.shell, false);
  assert.equal(codexTerminateSpec(4321, "linux"), undefined);
});

test("startThread creates, adopts, and optionally starts a turn in binding order", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const messages = [];
  const threads = new Map();
  let threadNumber = 0;
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      messages.push(message);
      if (message.id === undefined) return;
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/list":
          result = { data: [], nextCursor: null, backwardsCursor: null };
          break;
        case "thread/start": {
          if (message.params.cwd.endsWith("rpc-error")) {
            socket.send(JSON.stringify({
              id: message.id,
              error: { code: -32000, message: "Start denied by test" },
            }));
            return;
          }
          const thread = makeThread({
            id: `started-thread-${++threadNumber}`,
            cwd: message.params.cwd,
            preview: "",
          });
          threads.set(thread.id, thread);
          result = { thread };
          break;
        }
        case "thread/resume": {
          const thread = threads.get(message.params.threadId);
          result = {
            thread,
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: thread.cwd,
          };
          break;
        }
        case "thread/read":
          result = { thread: threads.get(message.params.threadId) };
          break;
        case "turn/start":
          result = { turn: turn("inProgress") };
          break;
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const { store, approvals, monitor } = makeHarness(port);
  try {
    assert.deepEqual(await monitor.startThread("E:\\work\\new", "Do work"), {
      ok: false,
      error: "Codex is not available on this computer",
    });
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not connect");

    let requestStart = messages.length;
    assert.deepEqual(await monitor.startThread("E:\\work\\new", "Do work"), {
      ok: true,
      sessionId: "started-thread-1",
    });
    const firstRequests = messages.slice(requestStart);
    // A thread born on this connection is live already: no resume, no read.
    assert.deepEqual(firstRequests.map((message) => message.method), [
      "thread/start",
      "turn/start",
    ]);
    assert.deepEqual(firstRequests[0].params, { cwd: "E:\\work\\new" });
    assert.deepEqual(firstRequests[1].params, {
      threadId: "started-thread-1",
      input: [{ type: "text", text: "Do work", text_elements: [] }],
    });
    assert.equal(store.get("started-thread-1").provider, "codex");

    requestStart = messages.length;
    assert.deepEqual(await monitor.startThread("E:\\work\\empty", ""), {
      ok: true,
      sessionId: "started-thread-2",
    });
    assert.deepEqual(messages.slice(requestStart).map((message) => message.method), [
      "thread/start",
    ]);

    assert.deepEqual(await monitor.startThread("E:\\work\\rpc-error", "ignored"), {
      ok: false,
      error: "Start denied by test",
    });
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeServer(server);
  }
});

test("monitor attaches, resumes, refreshes, streams statuses, and routes approval responses", async () => {
  const server = new WebSocketServer({ noServer: true });
  const port = await new Promise((resolve, reject) => {
    const http = require("node:http").createServer();
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.on("upgrade", (request, socket, head) => {
        server.handleUpgrade(request, socket, head, (ws) => server.emit("connection", ws, request));
      });
      server._httpServer = http;
      resolve(http.address().port);
    });
  });
  let currentThread = makeThread();
  const connections = attachProtocol(server, () => structuredClone(currentThread));
  const { store, transport, approvals, monitor } = makeHarness(port);

  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");
    assert.equal(store.get(currentThread.id).provider, "codex");
    assert.deepEqual(
      connections[0].messages.map((message) => message.method),
      ["initialize", "initialized", "thread/list", "thread/resume", "thread/read"],
    );

    currentThread = makeThread({
      status: { type: "active", activeFlags: [] },
      turns: [turn("inProgress")],
    });
    connections[0].socket.send(JSON.stringify({
      method: "turn/started",
      params: { threadId: currentThread.id, turn: currentThread.turns[0] },
    }));
    await waitUntil(() => store.get(currentThread.id)?.status === "working", "turn did not go working");

    const approvalRpcId = "approval-request-44";
    connections[0].socket.send(JSON.stringify({
      id: approvalRpcId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: currentThread.id,
        turnId: "turn-1",
        itemId: "not-unique",
        startedAtMs: Date.now(),
        environmentId: null,
        reason: "Run the test suite",
        command: "npm test",
        cwd: "E:\\work\\sample",
      },
    }));
    const frame = await waitUntil(
      () => transport.frames.find((entry) => entry.type === "approval_request"),
      "approval was not sent to the phone transport",
    );
    assert.equal(frame.requestId, codexApprovalRequestId(approvalRpcId));
    assert.equal(store.get(currentThread.id).status, "needs_you");

    approvals.handleDecision(frame.requestId, "allow");
    const response = await waitUntil(
      () => connections[0].messages.find(
        (message) => message.id === approvalRpcId && message.result,
      ),
      "approval response was not returned to Codex",
    );
    assert.deepEqual(response.result, { decision: "accept" });

    const droppedRpcId = 45;
    connections[0].socket.send(JSON.stringify({
      id: droppedRpcId,
      method: "item/fileChange/requestApproval",
      params: {
        threadId: currentThread.id,
        turnId: "turn-1",
        itemId: "also-not-a-routing-key",
        startedAtMs: Date.now(),
        reason: "Write the generated report",
        grantRoot: "E:\\work\\sample",
      },
    }));
    await waitUntil(
      () => transport.frames.find(
        (entry) => entry.requestId === codexApprovalRequestId(droppedRpcId),
      ),
      "second approval was not sent to the phone transport",
    );
    transport.connected = false;
    approvals.onLinkDisconnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      connections[0].messages.some((message) => message.id === droppedRpcId && message.result),
      false,
      "phone link loss must not answer the Codex request",
    );
    assert.equal(store.get(currentThread.id).status, "needs_you");
    transport.connected = true;

    connections[0].socket.terminate();
    await waitUntil(() => connections.length === 2, "monitor did not reconnect");
    await waitUntil(
      () => connections[1].messages.some((message) => message.method === "thread/read"),
      "reconnect did not refresh",
    );
    const methods = connections[1].messages.map((message) => message.method);
    assert.ok(
      methods.indexOf("thread/resume") < methods.indexOf("thread/list"),
      "known threads must be re-resumed before the authoritative list refresh",
    );
    assert.ok(methods.indexOf("thread/list") < methods.indexOf("thread/read"));
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server._httpServer.close(resolve));
    server.close();
  }
});

test("monitor caps discovery at the session cap and never requests an extra page", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const fakePageSize = 40;
  const listRequests = [];
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === undefined) return;
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        return;
      }
      if (message.method === "thread/list") {
        listRequests.push(message.params);
        const offset = (listRequests.length - 1) * fakePageSize;
        const data = Array.from({ length: fakePageSize }, (_, index) =>
          makeThread({
            id: `thread-${offset + index}`,
            updatedAt: 1_753_001_000 - offset - index,
            recencyAt: 1_753_001_000 - offset - index,
          }),
        );
        socket.send(JSON.stringify({
          id: message.id,
          result: {
            data,
            nextCursor: `page-${listRequests.length + 1}-must-not-be-read-past-the-cap`,
            backwardsCursor: null,
          },
        }));
        return;
      }
      const threadId = message.params.threadId;
      const thread = makeThread({ id: threadId });
      const result = message.method === "thread/resume"
        ? {
            thread,
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: thread.cwd,
          }
        : { thread };
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const { store, approvals, monitor } = makeHarness(port);
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not finish discovery", 5000);
    assert.equal(
      store.list().filter((session) => session.provider === "codex").length,
      MAX_CODEX_SESSIONS,
    );
    assert.equal(listRequests.length, Math.ceil(MAX_CODEX_SESSIONS / fakePageSize));
    assert.equal(listRequests[0].limit, MAX_CODEX_SESSIONS);
    assert.equal(listRequests.at(-1).limit, MAX_CODEX_SESSIONS - fakePageSize);
    assert.ok(listRequests.every((params) => params.sortKey === "recency_at"));
    assert.ok(listRequests.every((params) => params.sourceKinds.includes("exec")));
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeServer(server);
  }
});

test("when attach fails the monitor starts and owns a loopback app-server lifecycle", async () => {
  const probe = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => probe.once("listening", resolve));
  const port = probe.address().port;
  await closeServer(probe);

  let ownedServer;
  let killed = false;
  class FakeChild extends EventEmitter {
    pid = 4242;
    stderr = new PassThrough();
    exitCode = null;
    signalCode = null;
    kill() {
      killed = true;
      this.exitCode = 0;
      for (const client of ownedServer.clients) client.terminate();
      ownedServer.close();
      this.emit("exit", 0, null);
      return true;
    }
  }
  const child = new FakeChild();
  const launch = (requestedPort) => {
    assert.equal(requestedPort, port);
    ownedServer = new WebSocketServer({ port: requestedPort, host: "127.0.0.1" });
    attachProtocol(ownedServer);
    return child;
  };
  const { store, approvals, monitor } = makeHarness(port, {
    launch,
    terminate: async (owned) => {
      owned.kill();
    },
  });
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "owned server was not reached");
    assert.equal(store.get("codex-thread-1").provider, "codex");
  } finally {
    await monitor.stop();
    assert.equal(killed, true, "monitor did not terminate the app-server it started");
    approvals.dispose();
    store.dispose();
  }
});

test("missing Codex is an availability reason, not a monitor startup error", async () => {
  const probe = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => probe.once("listening", resolve));
  const port = probe.address().port;
  await closeServer(probe);
  const { store, approvals, monitor } = makeHarness(port);
  try {
    assert.doesNotThrow(() => monitor.start());
    const state = await waitUntil(
      () => {
        const availability = monitor.availability();
        return availability.reason?.includes("could not start") ? availability : undefined;
      },
      "missing Codex reason was not reported",
    );
    assert.equal(state.enabled, true);
    assert.equal(state.available, false);
    assert.match(state.reason, /codex executable not found/);
    assert.equal(store.size, 0);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
  }
});

test("disabled Codex monitoring neither connects nor launches a process", async () => {
  const store = new SessionStore(identity, silentLogger);
  const transport = new FakeApprovalTransport();
  const approvals = new ApprovalManager({ transport, logger: silentLogger });
  let launches = 0;
  const monitor = new CodexMonitor({
    config: { ...identity, codex: { enabled: false, port: 8390 } },
    store,
    approvals,
    logger: silentLogger,
    isAttached: () => true,
    launch() {
      launches += 1;
      throw new Error("must not launch");
    },
  });
  try {
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(monitor.availability(), {
      enabled: false,
      available: false,
      reason: "disabled",
    });
    assert.equal(launches, 0);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
  }
});

test("the periodic sweep adopts threads born outside the app-server connection", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const threads = new Map([["thread-a", makeThread({ id: "thread-a" })]]);
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === undefined) return;
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/list":
          result = { data: [...threads.values()], nextCursor: null, backwardsCursor: null };
          break;
        case "thread/resume":
          result = {
            thread: threads.get(message.params.threadId) ?? makeThread(),
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: "E:\work\sample",
          };
          break;
        case "thread/read":
          result = { thread: threads.get(message.params.threadId) ?? makeThread() };
          break;
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const { store, approvals, monitor } = makeHarness(port, { sweepIntervalMs: 40 });
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not connect");
    assert.equal(store.get("thread-b"), undefined);

    // A terminal-only run appears in storage without any server notification.
    threads.set("thread-b", makeThread({ id: "thread-b", preview: "CLI run" }));
    const adopted = await waitUntil(
      () => store.get("thread-b"),
      "sweep did not adopt the CLI thread",
    );
    assert.equal(adopted.provider, "codex");
    assert.equal(adopted.title, "CLI run");
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeServer(server);
  }
});

test("codex_broadcast_thread_not_adopted_unless_attached", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.once("listening", resolve));
  const port = server.address().port;
  const threads = new Map([
    ["thread-a", makeThread({ id: "thread-a" })],
    ["thread-stranger", makeThread({ id: "thread-stranger", preview: "not opted in" })],
  ]);
  const requests = [];
  const sockets = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === undefined) return;
      requests.push({ method: message.method, threadId: message.params?.threadId });
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/list":
          result = { data: [...threads.values()], nextCursor: null, backwardsCursor: null };
          break;
        case "thread/resume":
          result = {
            thread: threads.get(message.params.threadId),
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: "E:\\work\\sample",
          };
          break;
        case "thread/read":
          result = { thread: threads.get(message.params.threadId) };
          break;
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  const attached = new Set(["thread-a"]);
  const { store, transport, approvals, monitor } = makeHarness(port, {
    isAttached: (threadId) => attached.has(threadId),
    sweepIntervalMs: 40,
  });
  const broadcast = (threadId) => sockets[0].send(JSON.stringify({
    method: "thread/started",
    params: { thread: threads.get(threadId) },
  }));
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not connect");
    // Connect-time listing adopts only what is attached, and never subscribes the rest.
    assert.ok(store.get("thread-a"));
    assert.equal(store.get("thread-stranger"), undefined);

    broadcast("thread-stranger");
    // Several sweep intervals: neither the broadcast nor the sweep may adopt it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(store.get("thread-stranger"), undefined);
    assert.equal(
      requests.some((request) => request.threadId === "thread-stranger"),
      false,
      "an unattached thread must never be resumed (subscribed) or read",
    );

    // Its approval requests are not forwarded to the phone either.
    sockets[0].send(JSON.stringify({
      id: "approval-stranger",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-stranger",
        turnId: "turn-1",
        itemId: "i",
        startedAtMs: Date.now(),
        environmentId: null,
        reason: "Run it",
        command: "rm -rf /",
        cwd: "E:\\work\\sample",
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(transport.frames.some((frame) => frame.type === "approval_request"), false);

    // Once attached, the same broadcast is adopted.
    attached.add("thread-stranger");
    broadcast("thread-stranger");
    const adopted = await waitUntil(() => store.get("thread-stranger"), "attached thread was not adopted");
    assert.equal(adopted.provider, "codex");
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeServer(server);
  }
});

// ---- shared Codex daemon (WebSocket over a unix socket) ----

async function listenUnix() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-"));
  const socketPath = path.join(dir, "s.sock");
  const http = require("node:http").createServer();
  const server = new WebSocketServer({ server: http });
  await new Promise((resolve) => http.listen(socketPath, resolve));
  return { server, http, socketPath, dir };
}

async function closeUnix({ server, http, dir }) {
  for (const client of server.clients) client.terminate();
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => http.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}

// A stand-in for the shared daemon: loaded threads, per-thread resume failures,
// and a log of every request so tests can assert what was (not) asked.
function sharedDaemon(server, { threads, loaded, resumeError = () => undefined }) {
  const requests = [];
  const sockets = [];
  server.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === undefined) {
        requests.push({ method: message.method });
        return;
      }
      requests.push({ method: message.method, params: message.params });
      let result;
      switch (message.method) {
        case "initialize":
          result = { userAgent: "fake-codex" };
          break;
        case "thread/loaded/list":
          result = { data: loaded() };
          break;
        case "thread/resume": {
          const failure = resumeError(message.params.threadId);
          if (failure) {
            socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: failure } }));
            return;
          }
          result = {
            thread: threads.get(message.params.threadId),
            model: "gpt-5",
            modelProvider: "openai",
            serviceTier: null,
            cwd: "/work/sample",
          };
          break;
        }
        case "thread/read":
          result = { thread: threads.get(message.params.threadId) };
          break;
        default:
          return;
      }
      socket.send(JSON.stringify({ id: message.id, result }));
    });
  });
  return { requests, sockets };
}

function sharedHarness(daemon, overrides = {}) {
  let launches = 0;
  const harness = makeHarness(0, {
    useSharedDaemon: true,
    socketPath: daemon.socketPath,
    rolloutRetryMs: 15,
    ...overrides,
    launch: () => {
      launches += 1;
      throw new Error("must never spawn");
    },
  });
  harness.launches = () => launches;
  return harness;
}

test("shared_daemon_never_spawns", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["a", makeThread({ id: "a" })]]);
  const { requests } = sharedDaemon(daemon.server, { threads, loaded: () => ["a"] });
  const { store, approvals, monitor, launches } = sharedHarness(daemon);
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach to the daemon");
    assert.equal(launches(), 0);
    const init = requests.find((request) => request.method === "initialize");
    assert.equal(init.params.clientInfo.name, "rokid-coder-agentd");
    assert.equal(init.params.clientInfo.title, "Rokid-Coder");
    assert.equal(init.params.capabilities.experimentalApi, true);
    assert.deepEqual(
      requests.map((request) => request.method).slice(0, 3),
      ["initialize", "initialized", "thread/loaded/list"],
    );
    assert.equal(requests.some((request) => request.method === "thread/list"), false);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("shared daemon that is not running is unavailable, not spawned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc3-"));
  const { store, approvals, monitor, launches } = sharedHarness(
    { socketPath: path.join(dir, "missing.sock") },
    { startTimeoutMs: 50 },
  );
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().reason, "no unavailable reason reported");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(monitor.availability().available, false);
    assert.match(monitor.availability().reason, /shared daemon/i);
    assert.equal(launches(), 0);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("subscribes_only_attached_threads", async () => {
  const daemon = await listenUnix();
  const threads = new Map([
    ["a", makeThread({ id: "a" })],
    ["b", makeThread({ id: "b" })],
  ]);
  const { requests } = sharedDaemon(daemon.server, { threads, loaded: () => ["a", "b"] });
  const { store, approvals, monitor } = sharedHarness(daemon, {
    isAttached: (threadId) => threadId === "b",
  });
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");
    const resumes = requests.filter((request) => request.method === "thread/resume");
    assert.deepEqual(resumes.map((request) => request.params), [{ threadId: "b", excludeTurns: true }]);
    assert.ok(store.get("b"));
    assert.equal(store.get("a"), undefined);
    assert.equal(
      requests.some((request) => request.params?.threadId === "a"),
      false,
      "an unattached live thread must never be resumed or read",
    );
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("an attached thread outside the live list is resumed explicitly, not found through thread/list", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["old", makeThread({ id: "old" })]]);
  const { requests } = sharedDaemon(daemon.server, { threads, loaded: () => [] });
  const { store, approvals, monitor } = sharedHarness(daemon, { isAttached: (id) => id === "old" });
  try {
    // Attached before the monitor connected (the registry loads from disk).
    await monitor.subscribe("old");
    monitor.start();
    await waitUntil(() => store.get("old"), "attached thread was not resumed on connect");
    assert.equal(requests.some((request) => request.method === "thread/list"), false);
    assert.deepEqual(
      requests.filter((request) => request.method === "thread/resume").map((request) => request.params),
      [{ threadId: "old", excludeTurns: true }],
    );
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("no rollout found is retried until the thread has its first turn", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["fresh", makeThread({ id: "fresh" })]]);
  let failures = 2;
  const { requests } = sharedDaemon(daemon.server, {
    threads,
    loaded: () => ["fresh"],
    resumeError: () => (failures-- > 0 ? "no rollout found for thread id fresh" : undefined),
  });
  const { store, approvals, monitor } = sharedHarness(daemon);
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");
    await waitUntil(() => store.get("fresh"), "thread was never subscribed after retries");
    assert.equal(requests.filter((request) => request.method === "thread/resume").length, 3);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("subscribe seeds context from the rollout; unsubscribe forgets the thread", async () => {
  const daemon = await listenUnix();
  const rollout = path.join(daemon.dir, "rollout.jsonl");
  fs.writeFileSync(rollout, `${JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: { total_tokens: 18578 }, model_context_window: 258400 },
    },
  })}\n`);
  const threads = new Map([["live", makeThread({ id: "live", path: rollout })]]);
  const { requests, sockets } = sharedDaemon(daemon.server, { threads, loaded: () => [] });
  const attached = new Set();
  const { store, approvals, monitor } = sharedHarness(daemon, { isAttached: (id) => attached.has(id) });
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");

    await monitor.subscribe("live");
    assert.equal(store.get("live"), undefined, "subscribing an unattached thread must do nothing");
    assert.equal(requests.some((request) => request.params?.threadId === "live"), false);

    attached.add("live");
    await monitor.subscribe("live");
    assert.ok(store.get("live"));
    assert.deepEqual(monitor.contextUsage("live"), { used: 18578, window: 258400 });

    attached.delete("live");
    monitor.unsubscribe("live");
    assert.equal(store.get("live"), undefined);
    assert.equal(monitor.contextUsage("live"), undefined);
    sockets[0].send(JSON.stringify({
      method: "thread/status/changed",
      params: { threadId: "live", status: { type: "active", activeFlags: [] } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.get("live"), undefined, "events for a detached thread must not republish it");
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("detached_thread_pending_approval_left_for_tui", async () => {
  const daemon = await listenUnix();
  const threads = new Map([["t", makeThread({ id: "t" })]]);
  const { requests, sockets } = sharedDaemon(daemon.server, { threads, loaded: () => ["t"] });
  const replies = [];
  const attached = new Set(["t"]);
  const { store, transport, approvals, monitor } = sharedHarness(daemon, {
    isAttached: (id) => attached.has(id),
  });
  try {
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");
    sockets[0].on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id === "approval-9" && message.method === undefined) replies.push(message);
    });
    sockets[0].send(JSON.stringify({
      id: "approval-9",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t",
        turnId: "turn-1",
        itemId: "i",
        startedAtMs: Date.now(),
        environmentId: null,
        reason: "Run it",
        command: "npm test",
        cwd: "/work/sample",
      },
    }));
    const frame = await waitUntil(
      () => transport.frames.find((entry) => entry.type === "approval_request"),
      "approval did not reach the phone",
    );

    // The daemon's detach path: registry says no first, then the monitor is told.
    attached.delete("t");
    monitor.unsubscribe("t");
    approvals.resolveSession("t");

    assert.ok(
      transport.frames.some((entry) => entry.type === "approval_resolved" && entry.requestId === frame.requestId),
      "the phone must be told the request is no longer its to answer",
    );
    // A late phone decision has nothing left to answer.
    approvals.handleDecision(frame.requestId, "allow");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(replies, [], "no response may be sent: the request stays pending for the TUI");
    assert.equal(
      requests.some((request) => request.id === "approval-9"),
      false,
    );
    assert.equal(store.get("t"), undefined);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});

test("codex_policy_answers_approvals_itself_and_thread_end_is_reported", async () => {
  const { ApprovalPolicy } = require("../dist/approval-policy.js");
  const daemon = await listenUnix();
  const threads = new Map([["t", makeThread({ id: "t" })]]);
  const { requests, sockets } = sharedDaemon(daemon.server, { threads, loaded: () => ["t"] });
  const policy = new ApprovalPolicy();
  const ended = [];
  const { store, transport, approvals, monitor } = sharedHarness(daemon, {
    policy,
    onThreadEnded: (id) => ended.push(id),
  });
  const replies = [];
  const approvalParams = {
    threadId: "t",
    turnId: "turn-1",
    itemId: "i",
    startedAtMs: Date.now(),
    environmentId: null,
    reason: "Run it",
    command: "npm test",
    cwd: "/work/sample",
  };
  try {
    policy.set("codex:t", "approveAll", true);
    monitor.start();
    await waitUntil(() => monitor.availability().available, "monitor did not attach");
    sockets[0].on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === undefined && String(message.id).startsWith("approval-")) replies.push(message);
    });
    sockets[0].send(JSON.stringify({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: approvalParams,
    }));
    await waitUntil(() => replies.length === 1, "agentd did not answer the approval itself");
    assert.deepEqual(replies[0], { id: "approval-1", result: { decision: "accept" } });
    assert.equal(transport.frames.some((frame) => frame.type === "approval_request"), false);
    // Nothing about approve-all ever reaches Codex as native configuration.
    assert.equal(
      requests.some((request) => JSON.stringify(request).includes("approvalPolicy")),
      false,
    );

    for (const method of ["thread/closed", "thread/archived"]) {
      sockets[0].send(JSON.stringify({ method, params: { threadId: "t" } }));
    }
    await waitUntil(() => ended.length === 2, "thread end was not reported");
    assert.deepEqual(ended, ["t", "t"]);
  } finally {
    await monitor.stop();
    approvals.dispose();
    store.dispose();
    await closeUnix(daemon);
  }
});
