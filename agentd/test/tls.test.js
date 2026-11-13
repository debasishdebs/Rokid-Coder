const test = require("node:test");
const assert = require("node:assert/strict");
const { X509Certificate } = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const tls = require("node:tls");
const WebSocket = require("ws");
const { PhoneLink } = require("../dist/phone-link.js");
const { pairingPayload } = require("../dist/pairing.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore, ensureAgentCert, isSteeringAllowed } = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { withDaemon, withTempDir, postHook, settle } = require("./helpers/daemon.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");

const TRANSPORTS = ["phonelink", "wshub"];
const TOKEN = "tls-test-token-do-not-log";
const config = {
  token: TOKEN,
  wsPort: 0,
  httpPort: 0,
  machineId: "machine-tls",
  machineName: "tls-pc",
  phoneHosts: [],
  tailnetDiscovery: false,
  rokidCoder: { stateDir: "/nonexistent-never-written" },
};

function loggerHarness() {
  const entries = [];
  const log = (level) => (event, meta) => entries.push({ level, event, meta });
  return { entries, logger: { info: log("info"), warn: log("warn"), error: log("error") } };
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/** A TLS phone as PhoneLink sees one: records every line it is sent and answers hello. */
async function listenAsPhone(identity) {
  const seen = { connections: 0, lines: [] };
  const sockets = new Set();
  const server = tls.createServer({ key: identity.key, cert: identity.cert }, (socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        seen.lines.push(frame);
        if (frame.type === "hello") socket.write('{"type":"hello_ack","v":1}\n');
      }
    });
  });
  server.on("tlsClientError", () => {});
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return {
    port,
    seen,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

function newLink(pins) {
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const operator = [];
  const link = new PhoneLink({
    config,
    store,
    logger: logs.logger,
    detailProvider: async () => [],
    discoveryPort: 48793,
    pins,
    reconnectDelayMs: 20,
    operatorMessage: (message) => operator.push(message),
  });
  return { link, store, logs, operator, stop: () => { link.stop(); store.dispose(); } };
}

// ---- the agentd certificate ----

test("cert_generated_once_and_stable_fingerprint", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    const first = await ensureAgentCert(tlsDir);
    const second = await ensureAgentCert(tlsDir);
    assert.deepEqual(second, first, "the second call reads what the first wrote");
    assert.match(first.fingerprint256, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const x509 = new X509Certificate(first.cert);
    assert.equal(x509.fingerprint256, first.fingerprint256);
    assert.match(x509.subject, /CN=rokid-coder-agentd/);
    const years = (new Date(x509.validTo) - Date.now()) / (365 * 24 * 3600 * 1000);
    assert.ok(years > 9.9 && years < 10.1, `valid for ten years, got ${years}`);
    assert.equal((await fsp.stat(path.join(tlsDir, "agentd.key"))).mode & 0o777, 0o600);
    // A new process finds the same identity on disk.
    assert.equal((await ensureAgentCert(tlsDir)).fingerprint256, first.fingerprint256);
  });
});

test("pairing_payload_includes_fp", async () => {
  const agent = await agentCert();
  const payload = JSON.parse(pairingPayload({ ...config, wsPort: 8792 }, agent.fingerprint256));
  assert.equal(payload.fp, agent.fingerprint256);
  assert.equal(payload.token, TOKEN);
  assert.equal(payload.port, 8792);
  assert.equal(payload.kind, "nexus-agentd");
});

test("isSteeringAllowed_is_true_only_for_tls", () => {
  assert.equal(isSteeringAllowed({ tls: true }), true);
  assert.equal(isSteeringAllowed({ tls: false }), false);
});

// ---- the pin store ----

test("pin_store_persists_normalises_and_refuses_a_damaged_file", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const fp = (await phoneCert("a")).fingerprint256;
    const store = new PinStore(file);
    assert.equal(store.pinFor("10.0.0.5"), undefined);
    store.pin("10.0.0.5", fp.replace(/:/g, "").toLowerCase());
    assert.equal(store.pinFor("10.0.0.5"), fp, "stored in the colon-separated form certs report");
    assert.equal(new PinStore(file).pinFor("10.0.0.5"), fp, "and survives a restart");
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    assert.throws(() => store.pin("10.0.0.6", "not-a-fingerprint"), /fingerprint/);

    await fsp.writeFile(file, "{ not json");
    assert.throws(() => new PinStore(file), /Cannot read phone pins/);
    await fsp.writeFile(file, JSON.stringify({ version: 1, pins: { host: "nope" } }));
    assert.throws(() => new PinStore(file), /Invalid phone pins/);
  });
});

// ---- plaintext is monitor-only, TLS may steer, over both transports ----

for (const transport of TRANSPORTS) {
  test(`plaintext_link_rejects_steering_frames (${transport})`, async () => {
    await withDaemon(
      { transport, tls: false, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone, httpPort }) => {
        // Monitoring works: the board arrives and a read-only request is answered.
        await phone.waitFor("snapshot");
        phone.send({ type: "refresh" });
        await phone.waitFor("snapshot", () => phone.frames.filter((f) => f.type === "snapshot").length === 2);

        const steer = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
        const ack = await phone.waitFor("ack", (f) => f.msgId === steer.msgId);
        assert.deepEqual([ack.result, ack.error], ["rejected", "monitor_only"]);
        assert.equal(daemon.approvalPolicy.get("claude:s1"), "ask");
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "hi" });
        await phone.waitFor("session_upsert", (f) => f.session.id === "s1");
      },
    );
  });

  test(`tls_link_accepts_steering (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone }) => {
        const steer = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
        const ack = await phone.waitFor("ack", (f) => f.msgId === steer.msgId);
        assert.deepEqual([ack.result, ack.error], ["applied", undefined]);
        assert.equal(daemon.approvalPolicy.get("claude:s1"), "acceptEdits");
      },
    );
  });

  test(`plaintext_phone_does_not_hold_approvals_questions_or_stop_waits (${transport})`, async () => {
    await withDaemon(
      { transport, tls: false, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone, httpPort }) => {
        // The phone is connected, authenticated and receiving the board...
        assert.ok(phone.frames.some((f) => f.type === "snapshot"));
        // ...yet an approval is not held for it: the laptop prompt gets it at once.
        const permission = await Promise.race([
          postHook(httpPort, {
            hook_event_name: "PermissionRequest",
            session_id: "s1",
            tool_name: "Bash",
            tool_input: { command: "ls" },
          }),
          settle(1000).then(() => "held"),
        ]);
        assert.deepEqual(permission, {}, "falls back to the laptop prompt at once");
        assert.deepEqual(
          await postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" }),
          {},
          "a Stop is not held for a phone that cannot answer",
        );
        assert.deepEqual(
          await postHook(httpPort, {
            hook_event_name: "PreToolUse",
            session_id: "s1",
            tool_name: "AskUserQuestion",
            tool_use_id: "tu-1",
            tool_input: { questions: [{ question: "Pick", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
          }),
          {},
          "a question is left to the laptop",
        );
        assert.equal(daemon.stopWait.state("s1").waiting, false);
        assert.equal(daemon.questionRelay.isWaiting("tu-1"), false);
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "hi" });
        await phone.waitFor("session_upsert", (f) => f.session.id === "s1");
        assert.equal(phone.frames.some((f) => f.type === "approval_request" || f.type === "alert"), false);
      },
    );
  });
}

test("a_trusted_phone_is_asked_while_a_plaintext_one_beside_it_only_watches", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort, wsPort, token }) => {
      const watcher = createFakePhone({ transport: "wshub", tls: false });
      try {
        await watcher.start({ port: wsPort, host: "127.0.0.1", token });
        await watcher.waitFor("snapshot");
        const reply = postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        });
        const request = await phone.waitFor("approval_request");
        phone.send({ type: "approval_decision", requestId: request.requestId, decision: "allow" });
        assert.equal((await reply).hookSpecificOutput.decision.behavior, "allow");
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "hi" });
        await watcher.waitFor("session_upsert", (f) => f.session.id === "s1");
        assert.equal(
          watcher.frames.some((f) => ["approval_request", "approval_resolved", "alert"].includes(f.type)),
          false,
          "the watcher never sees what only a trusted phone can answer",
        );
        // And what the watcher sends stays monitor-only even beside a trusted phone.
        const decision = { type: "approval_decision", v: 1, requestId: "nope", decision: "allow" };
        watcher.send(decision);
        const ack = await watcher.waitFor("ack", (f) => f.msgId === "nope");
        assert.equal(ack.error, "monitor_only");
      } finally {
        watcher.close();
      }
    },
  );
});

// ---- PhoneLink: the daemon dials, the phone is the TLS server ----

test("first_authenticated_hello_pins_the_phone_and_trusts_the_link", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    const { link, logs, stop } = newLink(pins);
    try {
      assert.equal(pins.pinFor("127.0.0.1"), undefined);
      link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone", tls: true });
      await waitUntil(() => link.trustedConnected, "link never became trusted");
      assert.equal(pins.pinFor("127.0.0.1"), phoneId.fingerprint256);
      assert.equal(new PinStore(file).pinFor("127.0.0.1"), phoneId.fingerprint256, "on disk");
      assert.ok(logs.entries.some((e) => e.event === "phone_link_pinned"));
      assert.equal(JSON.stringify(logs.entries).includes(TOKEN), false, "the token is never logged");
    } finally {
      stop();
      server.close();
    }
  });
});

test("tls_link_with_wrong_pin_is_refused", async () => {
  const pinned = await phoneCert("pinned");
  const impostor = await phoneCert("impostor");
  const server = await listenAsPhone(impostor);
  const pins = new PinStore();
  pins.pin("127.0.0.1", pinned.fingerprint256);
  const { link, logs, operator, stop } = newLink(pins);
  try {
    link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone", tls: true });
    await waitUntil(
      () => logs.entries.some((e) => e.event === "phone_link_pin_mismatch"),
      "the mismatch was not logged",
    );
    const mismatch = logs.entries.find((e) => e.event === "phone_link_pin_mismatch");
    const short = (fp) => fp.replace(/:/g, "").slice(0, 12).toLowerCase();
    assert.equal(mismatch.meta.expected, short(pinned.fingerprint256));
    assert.equal(mismatch.meta.actual, short(impostor.fingerprint256));
    assert.equal(link.connected, false);
    assert.equal(link.trustedConnected, false);
    await settle(50);
    assert.deepEqual(server.seen.lines, [], "no hello, so no token, ever reached the impostor");
    assert.equal(JSON.stringify(logs.entries).includes(TOKEN), false);
    assert.equal(pins.pinFor("127.0.0.1"), pinned.fingerprint256, "the pin is not overwritten");
    assert.equal(operator.length, 1);

    // Backed off: an immediate second dial does not even connect.
    const before = server.seen.connections;
    link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone", tls: true });
    await settle(50);
    assert.equal(server.seen.connections, before);
  } finally {
    stop();
    server.close();
  }
});

test("a_pinned_phone_that_announces_plaintext_is_refused_not_downgraded", async () => {
  let dials = 0;
  const plain = net.createServer((socket) => { dials += 1; socket.destroy(); });
  const port = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  const pins = new PinStore();
  pins.pin("127.0.0.1", (await phoneCert("pinned")).fingerprint256);
  const { link, logs, operator, stop } = newLink(pins);
  try {
    link.connectToPhone({ host: "127.0.0.1", port, name: "phone", tls: false });
    await settle(50);
    assert.equal(dials, 0, "no plaintext socket was opened");
    assert.ok(logs.entries.some((e) => e.event === "phone_link_downgrade_refused"));
    assert.equal(operator.length, 1);
    assert.equal(link.connected, false);
  } finally {
    stop();
    plain.close();
  }
});

test("a_pinned_phone_is_dialled_over_tls_even_when_a_static_target_does_not_say_so", async () => {
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.pin("127.0.0.1", phoneId.fingerprint256);
  const { link, stop } = newLink(pins);
  try {
    link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone" });
    await waitUntil(() => link.trustedConnected, "a pinned host must be dialled over TLS");
  } finally {
    stop();
    server.close();
  }
});

test("a_plaintext_phone_connects_but_is_never_trusted_or_pinned", async () => {
  const lines = [];
  const plain = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
        if (JSON.parse(line).type === "hello") socket.write('{"type":"hello_ack","v":1}\n');
      }
    });
    socket.on("error", () => {});
  });
  const port = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  const pins = new PinStore();
  const { link, stop } = newLink(pins);
  try {
    link.connectToPhone({ host: "127.0.0.1", port, name: "phone" });
    await waitUntil(() => link.connected, "plaintext phone did not connect");
    assert.equal(link.trustedConnected, false);
    assert.equal(link.sendApprovalRequest({ type: "approval_request", requestId: "r" }), false);
    assert.equal(link.sendFrame({ type: "alert" }), false);
    assert.equal(pins.pinFor("127.0.0.1"), undefined);
  } finally {
    stop();
    plain.close();
  }
});

test("tls_phone_target_prefix_is_parsed_in_the_config", () => {
  const { parsePhoneTarget } = require("../dist/config.js");
  assert.deepEqual(parsePhoneTarget("tls://100.64.1.2:9000"), { host: "100.64.1.2", port: 9000, tls: true });
  assert.deepEqual(parsePhoneTarget("tls://phone.local"), { host: "phone.local", port: 8792, tls: true });
  assert.deepEqual(parsePhoneTarget("100.64.1.2:9000"), { host: "100.64.1.2", port: 9000 });
  assert.equal(parsePhoneTarget("tls://"), undefined);
});

// ---- WsHub: the phone dials, agentd is the TLS server ----

test("wshub_serves_wss_and_plain_ws_on_one_port_and_only_wss_is_trusted", async () => {
  const agent = await agentCert();
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1", tls: agent });
  await hub.start();
  const secure = createFakePhone({ transport: "wshub", tls: true, pin: agent.fingerprint256 });
  const plain = createFakePhone({ transport: "wshub", tls: false });
  try {
    await secure.start({ port: hub.port(), token: TOKEN });
    await secure.waitFor("hello_ack");
    await plain.start({ port: hub.port(), token: TOKEN });
    await plain.waitFor("hello_ack");
    assert.equal(hub.hasTrustedClient, true);
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r1" }), true);
    await secure.waitFor("approval_request");
    await settle(50);
    assert.equal(plain.frames.some((f) => f.type === "approval_request"), false);
    secure.close();
    await waitUntil(() => !hub.hasTrustedClient, "trusted client did not drop");
    assert.equal(hub.hasAuthenticatedClient, true, "the plaintext phone is still watching");
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r2" }), false);
  } finally {
    secure.close();
    plain.close();
    await hub.stop();
    store.dispose();
  }
});

test("a_wss_phone_with_the_wrong_pin_never_sends_its_token", async () => {
  const agent = await agentCert();
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1", tls: agent });
  await hub.start();
  const wrongPin = (await phoneCert("not-agentd")).fingerprint256;
  const phone = createFakePhone({ transport: "wshub", tls: true, pin: wrongPin });
  try {
    await assert.rejects(phone.start({ port: hub.port(), token: TOKEN }), /pin mismatch/);
    await settle(50);
    assert.equal(hub.hasAuthenticatedClient, false);
    assert.equal(logs.entries.some((e) => e.event === "ws_auth_rejected"), false, "no hello arrived to reject");
  } finally {
    phone.close();
    await hub.stop();
    store.dispose();
  }
});

test("wshub_without_a_cert_drops_a_tls_client_and_serves_plain_ws", async () => {
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1" });
  await hub.start();
  try {
    const secure = new WebSocket(`wss://127.0.0.1:${hub.port()}`, { rejectUnauthorized: false });
    await new Promise((resolve) => {
      secure.once("error", resolve);
      secure.once("open", () => resolve());
    });
    assert.notEqual(secure.readyState, WebSocket.OPEN);
    const phone = createFakePhone({ transport: "wshub", tls: false });
    await phone.start({ port: hub.port(), token: TOKEN });
    await phone.waitFor("hello_ack");
    phone.close();
  } finally {
    await hub.stop();
    store.dispose();
  }
});
