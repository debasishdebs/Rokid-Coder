const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { HookHttpServer } = require("../dist/http-server.js");

function call(port, method, requestPath, body = "") {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: requestPath,
        headers: body ? { "content-length": Buffer.byteLength(body) } : undefined,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { responseBody += chunk; });
        response.on("end", () => resolve({
          status: response.statusCode,
          body: responseBody,
        }));
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

test("loopback HTTP server reports health and returns the completed hook decision", async () => {
  let received;
  let markReceived;
  const receivedHook = new Promise((resolve) => { markReceived = resolve; });
  const warnings = [];
  const logger = {
    info() {},
    warn(event) { warnings.push(event); },
    error() {},
  };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const server = new HookHttpServer({
    port: 0,
    sessionCount: () => 3,
    async onHook(payload) {
      received = payload;
      markReceived();
      await held;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
        },
      };
    },
    logger,
    extraHealth: () => ({
      codex: { enabled: true, available: false, reason: "codex not installed" },
    }),
  });
  await server.start();
  try {
    const health = await call(server.port(), "GET", "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), {
      ok: true,
      sessions: 3,
      uptimeMs: JSON.parse(health.body).uptimeMs,
      codex: { enabled: true, available: false, reason: "codex not installed" },
    });

    const payload = { session_id: "http-session", hook_event_name: "SessionStart" };
    let completed = false;
    const acceptedPromise = call(server.port(), "POST", "/hook", JSON.stringify(payload))
      .then((value) => {
        completed = true;
        return value;
      });
    await receivedHook;
    assert.deepEqual(received, payload);
    assert.equal(completed, false);
    release();
    const accepted = await acceptedPromise;
    assert.equal(accepted.status, 200);
    assert.deepEqual(JSON.parse(accepted.body), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      },
    });

    const malformed = await call(server.port(), "POST", "/hook", "{");
    assert.deepEqual(malformed, { status: 200, body: "{}" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, ["hook_parse_failed"]);
  } finally {
    await server.stop();
  }
});

const silent = { info() {}, warn() {}, error() {} };

test("intact_held_post_is_not_aborted", async () => {
  const signals = [];
  const server = new HookHttpServer({
    port: 0,
    sessionCount: () => 0,
    async onHook(_payload, closed) {
      signals.push(closed);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return { decision: "block", reason: "held" };
    },
    logger: silent,
  });
  await server.start();
  try {
    const reply = await call(server.port(), "POST", "/hook", JSON.stringify({ session_id: "s" }));
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { decision: "block", reason: "held" });
    assert.equal(signals[0].aborted, false);
    // The request-side close that follows a finished exchange must not abort it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(signals[0].aborted, false);
  } finally {
    await server.stop();
  }
});

test("killed_forwarder_aborts_hold", async () => {
  let signal;
  let markHeld;
  const held = new Promise((resolve) => { markHeld = resolve; });
  let finish;
  const server = new HookHttpServer({
    port: 0,
    sessionCount: () => 0,
    onHook(_payload, closed) {
      signal = closed;
      markHeld();
      return new Promise((resolve) => {
        finish = resolve;
        closed.addEventListener("abort", () => resolve({}), { once: true });
      });
    },
    logger: silent,
  });
  await server.start();
  try {
    const body = JSON.stringify({ session_id: "s" });
    const outgoing = http.request({
      hostname: "127.0.0.1",
      port: server.port(),
      method: "POST",
      path: "/hook",
      headers: { "content-length": Buffer.byteLength(body) },
    });
    outgoing.on("error", () => undefined);
    outgoing.end(body);
    await held;
    assert.equal(signal.aborted, false);
    outgoing.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, "cancelled");
    finish?.({});
  } finally {
    await server.stop();
  }
});
