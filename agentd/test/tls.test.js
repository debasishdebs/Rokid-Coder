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
const {
  PinStore,
  ensureAgentCert,
  ensureSteerSecret,
  isSteeringAllowed,
  readSteerSecret,
  rotateSteerSecret,
  secretMatches,
} = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { withDaemon, withTempDir, postHook, settle } = require("./helpers/daemon.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");

const TRANSPORTS = ["phonelink", "wshub"];
const TOKEN = "tls-test-token-do-not-log";
const STEER = "tls-test-steering-secret-do-not-send";
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

function newLink(pins, extra = {}) {
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
    ...extra,
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
    assert.equal((await fsp.stat(tlsDir)).mode & 0o777, 0o700);
    // A new process finds the same identity on disk.
    assert.equal((await ensureAgentCert(tlsDir)).fingerprint256, first.fingerprint256);
  });
});

test("two_starters_racing_on_a_fresh_dir_get_one_matching_key_and_cert", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    const [a, b] = await Promise.all([ensureAgentCert(tlsDir), ensureAgentCert(tlsDir)]);
    assert.equal(a.fingerprint256, b.fingerprint256);
    assert.equal(a.key, b.key);
    assert.equal((await ensureAgentCert(tlsDir)).key, a.key, "and that is what is on disk");
    await assert.rejects(fsp.stat(path.join(tlsDir, "agentd.lock")), { code: "ENOENT" });
  });
});

test("steer_secret_is_32_random_bytes_stored_0600_and_rotates", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    assert.equal(readSteerSecret(tlsDir), undefined);
    const first = ensureSteerSecret(tlsDir);
    assert.equal(Buffer.from(first, "base64url").length, 32);
    assert.equal(ensureSteerSecret(tlsDir), first, "made once");
    assert.equal((await fsp.stat(path.join(tlsDir, "steer.secret"))).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(tlsDir)).mode & 0o777, 0o700);
    const second = rotateSteerSecret(tlsDir);
    assert.notEqual(second, first);
    assert.equal(readSteerSecret(tlsDir), second);
    assert.equal(secretMatches(second, second), true);
    assert.equal(secretMatches(first, second), false);
    assert.equal(secretMatches("", second), false);
    assert.equal(secretMatches(`${second}x`, second), false, "a length mismatch is just a mismatch");
    assert.equal(secretMatches(undefined, second), false);
    assert.equal(secretMatches(second, ""), false);
  });
});

test("pairing_payload_includes_fp", async () => {
  const agent = await agentCert();
  const payload = JSON.parse(pairingPayload({ ...config, wsPort: 8792 }, agent.fingerprint256, STEER));
  assert.equal(payload.fp, agent.fingerprint256);
  assert.equal(payload.steer, STEER);
  assert.equal(payload.token, TOKEN);
  assert.equal(payload.port, 8792);
  assert.equal(payload.kind, "nexus-agentd");
});

test("isSteeringAllowed_is_true_only_for_tls", () => {
  assert.equal(isSteeringAllowed({ tls: true }), true);
  assert.equal(isSteeringAllowed({ tls: false }), false);
});

// ---- the pin store ----

test("pin_store_is_a_set_that_persists_normalises_and_refuses_a_damaged_file", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const fpA = (await phoneCert("a")).fingerprint256;
    const fpB = (await phoneCert("b")).fingerprint256;
    const store = new PinStore(file);
    assert.equal(store.isEmpty(), true);
    store.add(fpA.replace(/:/g, "").toLowerCase());
    store.add(fpB);
    assert.deepEqual(store.list().sort(), [fpA, fpB].sort(), "stored in the form certs report");
    assert.equal(new PinStore(file).has(fpA), true, "and survives a restart");
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fsp.stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.throws(() => store.add("not-a-fingerprint"), /fingerprint/);

    // Another process (the CLI) edits the file; the daemon's store sees it.
    new PinStore(file).forget(fpA.slice(0, 11));
    assert.equal(store.has(fpA), false);
    assert.deepEqual(store.forget(fpB.replace(/:/g, "").slice(0, 16)), [fpB]);
    assert.throws(() => store.forget("AB"), /at least 8/);

    await fsp.writeFile(file, "{ not json");
    assert.throws(() => new PinStore(file), /Cannot read phone pins/);
    await fsp.writeFile(file, JSON.stringify({ version: 2, phones: ["nope"] }));
    assert.throws(() => new PinStore(file), /Invalid phone pins/);
  });
});

test("a_version_1_host_keyed_pin_file_is_migrated_into_the_set", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "phone-pins.json");
    const fp = (await phoneCert("a")).fingerprint256;
    await fsp.writeFile(file, JSON.stringify({ version: 1, pins: { "10.0.0.5": fp } }));
    const store = new PinStore(file);
    assert.deepEqual(store.list(), [fp]);
    store.add((await phoneCert("b")).fingerprint256);
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).version, 2, "rewritten as version 2");
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

const short = (fp) => fp.replace(/:/g, "").slice(0, 12).toLowerCase();

function dialTls(link, server, extra = {}) {
  link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone", tls: true, ...extra });
}

test("first_authenticated_hello_pins_the_phone_and_trusts_the_link", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    const { link, logs, stop } = newLink(pins);
    try {
      assert.equal(pins.isEmpty(), true);
      dialTls(link, server);
      await waitUntil(() => link.trustedConnected, "link never became trusted");
      assert.deepEqual(pins.list(), [phoneId.fingerprint256]);
      assert.deepEqual(new PinStore(file).list(), [phoneId.fingerprint256], "on disk");
      assert.ok(logs.entries.some((e) => e.event === "phone_link_pinned"));
      assert.equal(JSON.stringify(logs.entries).includes(TOKEN), false, "the token is never logged");
    } finally {
      stop();
      server.close();
    }
  });
});

test("second_host_with_unknown_cert_refused_before_hello_no_token_sent", async () => {
  const pinned = await phoneCert("pinned");
  const impostor = await phoneCert("impostor");
  const server = await listenAsPhone(impostor);
  const pins = new PinStore();
  pins.add(pinned.fingerprint256);
  const { link, logs, operator, stop } = newLink(pins);
  try {
    dialTls(link, server);
    await waitUntil(
      () => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"),
      "the refusal was not logged",
    );
    const refusal = logs.entries.find((e) => e.event === "phone_link_untrusted_peer");
    assert.equal(refusal.meta.fingerprint, short(impostor.fingerprint256), "shortened, not whole");
    assert.equal(link.connected, false);
    assert.equal(link.trustedConnected, false);
    await settle(50);
    assert.deepEqual(server.seen.lines, [], "no hello, so no token, ever reached the impostor");
    assert.equal(JSON.stringify(logs.entries).includes(TOKEN), false);
    assert.deepEqual(pins.list(), [pinned.fingerprint256], "the set is untouched");
    assert.equal(operator.length, 1);
    assert.match(operator[0], /phones allow-next/);

    // Backed off: an immediate second dial does not even connect.
    const before = server.seen.connections;
    dialTls(link, server);
    await settle(50);
    assert.equal(server.seen.connections, before);
  } finally {
    stop();
    server.close();
  }
});

test("pinned_cert_at_new_ip_trusted", async () => {
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add(phoneId.fingerprint256);
  const { link, stop } = newLink(pins);
  try {
    // Another name for the same machine stands in for a DHCP change: the set
    // knows the cert, not the address.
    link.connectToPhone({ host: "localhost", port: server.port, name: "phone", tls: true });
    await waitUntil(() => link.trustedConnected, "a pinned cert is trusted at any address");
    assert.deepEqual(pins.list(), [phoneId.fingerprint256], "and nothing was added");
  } finally {
    stop();
    server.close();
  }
});

test("plaintext_from_new_ip_after_pinning_refused_no_token_sent", async () => {
  const wire = [];
  let dials = 0;
  const plain = net.createServer((socket) => {
    dials += 1;
    socket.on("data", (chunk) => wire.push(chunk.toString()));
    socket.on("error", () => {});
  });
  const port = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  const pins = new PinStore();
  pins.add((await phoneCert("pinned")).fingerprint256);
  const { link, logs, operator, stop } = newLink(pins);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      link.connectToPhone({ host: "127.0.0.1", port, name: "phone", tls: false });
    }
    await settle(50);
    assert.equal(dials, 0, "no plaintext socket was opened");
    assert.deepEqual(wire, []);
    assert.ok(logs.entries.some((e) => e.event === "phone_link_plaintext_refused"));
    assert.equal(operator.length, 1, "told once, not on every announcement");
    assert.equal(link.connected, false);
  } finally {
    stop();
    plain.close();
  }
});

test("an_unprefixed_target_is_dialled_over_tls_once_a_phone_is_trusted", async () => {
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add(phoneId.fingerprint256);
  const { link, stop } = newLink(pins);
  try {
    link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone" });
    await waitUntil(() => link.trustedConnected, "static and tailnet targets must be dialled over TLS");
  } finally {
    stop();
    server.close();
  }
});

test("allow_next_window_admits_one_new_phone_then_closes", async () => {
  const first = await phoneCert("first");
  const second = await phoneCert("second");
  const third = await phoneCert("third");
  const secondServer = await listenAsPhone(second);
  const thirdServer = await listenAsPhone(third);
  const pins = new PinStore();
  pins.add(first.fingerprint256);
  let clock = 1_000_000;
  const { link, logs, stop } = newLink(pins, { now: () => clock });
  try {
    // Closed: an unknown phone is refused.
    dialTls(link, secondServer);
    await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
    assert.equal(pins.has(second.fingerprint256), false);

    // Armed: it is admitted, once.
    clock += 100_000; // past the refusal backoff
    pins.armAllowNext(clock);
    dialTls(link, secondServer);
    await waitUntil(() => link.trustedConnected, "the window did not admit the phone");
    assert.equal(pins.has(second.fingerprint256), true);
    assert.equal(pins.allowNextOpen(clock), false, "admitting one phone closes the window");
    link.stop();

    // A third phone is refused: the window was for one.
    const again = newLink(pins, { now: () => clock });
    dialTls(again.link, thirdServer);
    await waitUntil(
      () => again.logs.entries.some((e) => e.event === "phone_link_untrusted_peer"),
      "the third phone was not refused",
    );
    assert.equal(pins.has(third.fingerprint256), false);
    assert.deepEqual(thirdServer.seen.lines, []);
    again.stop();
  } finally {
    stop();
    secondServer.close();
    thirdServer.close();
  }
});

test("an_expired_allow_next_window_admits_nobody", async () => {
  const second = await phoneCert("second");
  const server = await listenAsPhone(second);
  const pins = new PinStore();
  pins.add((await phoneCert("first")).fingerprint256);
  const clock = 5_000_000;
  pins.armAllowNext(clock - 3 * 60_000);
  const { link, logs, stop } = newLink(pins, { now: () => clock });
  try {
    dialTls(link, server);
    await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
    assert.deepEqual(server.seen.lines, []);
  } finally {
    stop();
    server.close();
  }
});

test("forget_all_reopens_tofu", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const first = await phoneCert("first");
    const second = await phoneCert("second");
    const secondServer = await listenAsPhone(second);
    const pins = new PinStore(file);
    pins.add(first.fingerprint256);
    const { link, logs, stop } = newLink(pins);
    try {
      dialTls(link, secondServer);
      await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
      // `phones forget --all`, from another process.
      new PinStore(file).forgetAll();
      assert.equal(pins.isEmpty(), true);
      const fresh = newLink(pins);
      try {
        dialTls(fresh.link, secondServer);
        await waitUntil(() => fresh.link.trustedConnected, "the next phone was not trusted on first use");
        assert.deepEqual(pins.list(), [second.fingerprint256]);
      } finally {
        fresh.stop();
      }
    } finally {
      stop();
      secondServer.close();
    }
  });
});

test("stalled_tls_handshake_times_out_and_redial_resumes", async () => {
  const sockets = [];
  const silent = net.createServer((socket) => { sockets.push(socket); socket.on("error", () => {}); });
  const silentPort = await new Promise((resolve) => silent.listen(0, "127.0.0.1", () => resolve(silent.address().port)));
  const phoneId = await phoneCert("phone");
  const real = await listenAsPhone(phoneId);
  const pins = new PinStore();
  const { link, logs, stop } = newLink(pins, { helloTimeoutMs: 60 });
  try {
    link.connectToPhone({ host: "127.0.0.1", port: silentPort, name: "stall", tls: true });
    await waitUntil(() => sockets.length === 1, "the stalled peer was not dialled");
    assert.ok(link.socket, "dialling");
    await waitUntil(() => link.socket === undefined, "the handshake never timed out");
    assert.ok(logs.entries.some((e) => e.event === "phone_link_hello_timeout"));
    // Nothing is wedged: the next dial goes out and completes.
    await settle(40);
    dialTls(link, real);
    await waitUntil(() => link.trustedConnected, "the redial did not resume");
  } finally {
    stop();
    for (const socket of sockets) socket.destroy();
    silent.close();
    real.close();
  }
});

test("a_hello_that_is_never_acknowledged_pins_nothing", async () => {
  const phoneId = await phoneCert("phone");
  const server = tls.createServer({ key: phoneId.key, cert: phoneId.cert }, (socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {}); // reads the hello, never answers
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const pins = new PinStore();
  const { link, stop } = newLink(pins, { helloTimeoutMs: 60 });
  try {
    link.connectToPhone({ host: "127.0.0.1", port, name: "phone", tls: true });
    await waitUntil(() => link.socket === undefined, "the hello deadline did not fire");
    assert.equal(pins.isEmpty(), true, "an unauthenticated peer is never pinned");
    assert.equal(link.trustedConnected, false);
  } finally {
    stop();
    server.close();
  }
});

test("a_pin_store_that_cannot_save_leaves_the_link_untrusted_and_closed", async () => {
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add = () => { throw new Error("disk full"); };
  const { link, logs, stop } = newLink(pins);
  try {
    dialTls(link, server);
    await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_pins_unreadable"), "not reported");
    await settle(30);
    assert.equal(link.trustedConnected, false);
    assert.equal(link.connected, false);
  } finally {
    stop();
    server.close();
  }
});

test("an_unreadable_pins_file_refuses_every_dial", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "phone-pins.json");
    const pins = new PinStore(file);
    await fsp.writeFile(file, "{ damaged");
    const server = await listenAsPhone(await phoneCert("phone"));
    const { link, logs, stop } = newLink(pins);
    try {
      dialTls(link, server);
      link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone" });
      await settle(80);
      assert.ok(logs.entries.some((e) => e.event === "phone_link_pins_unreadable"));
      assert.equal(server.seen.connections, 0, "not even a TCP connection when the set cannot be read");
    } finally {
      stop();
      server.close();
    }
  });
});

test("a_plaintext_phone_connects_while_the_set_is_empty_but_is_never_trusted_or_pinned", async () => {
  const plain = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n").filter(Boolean)) {
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
    assert.equal(pins.isEmpty(), true);
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

// ---- WsHub: the phone dials agentd, which is the TLS server ----

async function newHub(options = {}) {
  const agent = await agentCert();
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, ...options });
  await hub.start();
  return { hub, logs, agent, stop: async () => { await hub.stop(); store.dispose(); } };
}

async function connectPhone(hub, agent, options) {
  const phone = createFakePhone({ transport: "wshub", pin: agent.fingerprint256, ...options });
  await phone.start({ port: hub.port(), token: TOKEN });
  await phone.waitFor("hello_ack");
  return phone;
}

/** Sends a steering frame and says whether agentd refused it as monitor-only. */
async function steeringRefused(phone) {
  const frame = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
  const ack = await phone.waitFor("ack", (f) => f.msgId === frame.msgId);
  return ack.error === "monitor_only";
}

test("wss_with_token_but_no_steer_is_monitor_only", async () => {
  const { hub, agent, stop } = await newHub();
  const phone = await connectPhone(hub, agent, { tls: true });
  try {
    assert.equal(hub.hasAuthenticatedClient, true);
    assert.equal(hub.hasTrustedClient, false);
    assert.equal(await steeringRefused(phone), true);
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r" }), false);
  } finally {
    phone.close();
    await stop();
  }
});

test("wss_with_wrong_steer_is_monitor_only", async () => {
  const { hub, agent, stop } = await newHub();
  const phones = [];
  try {
    for (const steer of ["wrong-secret", STEER.slice(0, -1), `${STEER}x`, ""]) {
      const phone = await connectPhone(hub, agent, { tls: true, steer });
      phones.push(phone);
      assert.equal(await steeringRefused(phone), true, `steer ${JSON.stringify(steer)}`);
    }
    assert.equal(hub.hasTrustedClient, false);
  } finally {
    for (const phone of phones) phone.close();
    await stop();
  }
});

test("wss_with_steer_is_trusted", async () => {
  const { hub, agent, stop } = await newHub();
  const phone = await connectPhone(hub, agent, { tls: true, steer: STEER });
  try {
    assert.equal(hub.hasTrustedClient, true);
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r" }), true);
    await phone.waitFor("approval_request");
  } finally {
    phone.close();
    await stop();
  }
});

test("plaintext_ws_with_steer_is_still_monitor_only", async () => {
  const { hub, logs, agent, stop } = await newHub();
  const phone = await connectPhone(hub, agent, { tls: false, steer: STEER });
  try {
    assert.equal(hub.hasAuthenticatedClient, true);
    assert.equal(hub.hasTrustedClient, false);
    assert.equal(await steeringRefused(phone), true);
    assert.ok(logs.entries.some((e) => e.event === "ws_steer_over_plaintext"), "a leaked secret is noticed");
    assert.equal(JSON.stringify(logs.entries).includes(STEER), false, "and never logged");
  } finally {
    phone.close();
    await stop();
  }
});

test("a_token_taken_over_plaintext_does_not_steer_over_wss", async () => {
  // The attack: answer agentd's plaintext dial to learn the token, then use it on wss.
  const stolen = [];
  const trap = net.createServer((socket) => {
    socket.on("data", (chunk) => stolen.push(...chunk.toString().split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    socket.on("error", () => {});
  });
  const trapPort = await new Promise((resolve) => trap.listen(0, "127.0.0.1", () => resolve(trap.address().port)));
  const { link, stop: stopLink } = newLink(new PinStore());
  const { hub, agent, stop } = await newHub();
  try {
    link.connectToPhone({ host: "127.0.0.1", port: trapPort, name: "impostor" });
    await waitUntil(() => stolen.some((f) => f.type === "hello"), "the plaintext dial never sent hello");
    const token = stolen.find((f) => f.type === "hello").token;
    assert.equal(token, TOKEN, "monitor-only is what a plaintext dial costs");
    assert.equal(JSON.stringify(stolen).includes(STEER), false);

    const attacker = createFakePhone({ transport: "wshub", tls: true, pin: agent.fingerprint256 });
    await attacker.start({ port: hub.port(), token });
    await attacker.waitFor("hello_ack");
    assert.equal(hub.hasTrustedClient, false);
    assert.equal(await steeringRefused(attacker), true);
    attacker.close();
  } finally {
    stopLink();
    await stop();
    trap.close();
  }
});

test("rotating_the_steer_secret_takes_effect_at_the_next_hello", async () => {
  let current = STEER;
  const { hub, agent, stop } = await newHub({ steer: () => current });
  const before = await connectPhone(hub, agent, { tls: true, steer: STEER });
  try {
    assert.equal(hub.hasTrustedClient, true);
    current = "a-freshly-rotated-secret";
    const stale = await connectPhone(hub, agent, { tls: true, steer: STEER });
    assert.equal(await steeringRefused(stale), true, "the old secret no longer steers");
    const fresh = await connectPhone(hub, agent, { tls: true, steer: current });
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r" }), true);
    await fresh.waitFor("approval_request");
    await before.waitFor("approval_request");
    await settle(30);
    assert.equal(stale.frames.some((f) => f.type === "approval_request"), false);
    stale.close();
    fresh.close();
  } finally {
    before.close();
    await stop();
  }
});

test("wss_without_a_configured_secret_trusts_nobody", async () => {
  const { hub, agent, stop } = await newHub({ steer: () => undefined });
  const phone = await connectPhone(hub, agent, { tls: true, steer: STEER });
  try {
    assert.equal(hub.hasTrustedClient, false);
  } finally {
    phone.close();
    await stop();
  }
});

test("wshub_serves_wss_and_plain_ws_on_one_port_and_only_a_steering_wss_phone_is_trusted", async () => {
  const { hub, agent, stop } = await newHub();
  const secure = await connectPhone(hub, agent, { tls: true, steer: STEER });
  const plain = await connectPhone(hub, agent, { tls: false });
  try {
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
    await stop();
  }
});

test("a_wss_phone_with_the_wrong_pin_never_sends_its_token", async () => {
  const { hub, logs, agent, stop } = await newHub();
  const phone = createFakePhone({
    transport: "wshub",
    tls: true,
    pin: (await phoneCert("not-agentd")).fingerprint256,
    steer: STEER,
  });
  try {
    await assert.rejects(phone.start({ port: hub.port(), token: TOKEN }), /pin mismatch/);
    await settle(50);
    assert.equal(hub.hasAuthenticatedClient, false);
    assert.equal(logs.entries.some((e) => e.event === "ws_auth_rejected"), false, "no hello arrived to reject");
  } finally {
    phone.close();
    await stop();
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

// ---- the steering secret is never sent ----

for (const transport of TRANSPORTS) {
  test(`steer_never_appears_in_any_frame_agentd_sends (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ phone, httpPort, wsPort, token, steer }) => {
        // A full session: board, detail, a held approval answered, steering, a refresh.
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/w", prompt: "hi" });
        await phone.waitFor("session_upsert", (f) => f.session.id === "s1");
        phone.send({ type: "detail_open", sessionId: "s1" });
        await phone.waitFor("detail");
        const mode = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
        await phone.waitFor("ack", (f) => f.msgId === mode.msgId);
        phone.send({ type: "refresh" });
        const reply = postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
        });
        const approval = await phone.waitFor("approval_request");
        phone.send({ type: "approval_decision", v: 1, requestId: approval.requestId, decision: "allow" });
        await reply;
        // And a second, plaintext watcher on the same hub sees nothing of it either.
        const watcher = createFakePhone({ transport: "wshub", tls: false });
        await watcher.start({ port: wsPort, host: "127.0.0.1", token });
        await watcher.waitFor("snapshot");
        await settle(100);
        for (const [who, frames] of [["trusted", phone.frames], ["watcher", watcher.frames]]) {
          assert.ok(frames.length >= (who === "trusted" ? 6 : 2), who);
          assert.equal(JSON.stringify(frames).includes(steer), false, `${who} phone received the steering secret`);
        }
        watcher.close();
      },
    );
  });
}

test("steer_never_appears_on_the_dialled_link_or_in_logs", async () => {
  await withTempDir(async (dir) => {
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const { link, logs, stop } = newLink(new PinStore());
    try {
      dialTls(link, server);
      await waitUntil(() => link.trustedConnected, "no link");
      await waitUntil(() => server.seen.lines.some((f) => f.type === "snapshot"), "no snapshot");
      assert.equal(JSON.stringify(server.seen.lines).includes(STEER), false);
      assert.equal(JSON.stringify(logs.entries).includes(STEER), false);
    } finally {
      stop();
      server.close();
    }
  });
});
