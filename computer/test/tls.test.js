const test = require("node:test");
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { X509Certificate } = require("node:crypto");
const fs = require("node:fs");
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
const FIXTURES = require("../../contracts/rokid-coder-v2.fixtures.json");


// Whatever a test opens is closed after it, pass or fail, so a failing
// assertion cannot leave a listening server or live socket holding the run open.
const cleanups = [];
const track = (close) => { cleanups.push(close); return close; };
test.afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => close()));
});

function trackedServer(create, ...args) {
  const server = create(...args);
  const sockets = new Set();
  server.on("connection", (socket) => sockets.add(socket));
  server.on("secureConnection", (socket) => sockets.add(socket));
  track(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return server;
}
const netServer = (...args) => trackedServer(net.createServer, ...args);
const tlsServer = (...args) => trackedServer(tls.createServer, ...args);

function fakePhone(options) {
  const phone = createFakePhone(options);
  track(() => phone.close());
  return phone;
}

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
  const seen = { connections: 0, closes: 0, lines: [] };
  const sockets = new Set();
  const server = tlsServer({ key: identity.key, cert: identity.cert }, (socket) => {
    seen.connections += 1;
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { seen.closes += 1; });
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
    /** A frame from the phone to agentd over the live link. */
    send: (frame) => { for (const socket of sockets) socket.write(`${JSON.stringify(frame)}\n`); },
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
  const stop = () => { link.stop(); store.dispose(); };
  track(stop);
  return { link, store, logs, operator, stop };
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
  const payload = JSON.parse(pairingPayload({ ...config, wsPort: 8792 }, agent.fingerprint256));
  assert.equal(payload.fp, agent.fingerprint256);
  assert.equal(payload.port, 8792);
  assert.equal(payload.v, 2);
  assert.equal(payload.kind, "rokid-coder");
  // v2 carries no secret: the credentials come only after the SAS code check.
  assert.equal("steer" in payload || "token" in payload, false);
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

test("ever_pinned_survives_forgetting_and_any_existing_pin_file_counts_as_pinned", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "phone-pins.json");
    const fp = (await phoneCert("a")).fingerprint256;
    const store = new PinStore(file);
    assert.equal(store.everPinned(), false, "no store yet: a fresh install");
    store.add(fp);
    store.forgetAll();
    assert.equal(store.isEmpty(), true);
    assert.equal(store.everPinned(), true, "an empty set after forgetting is not a fresh install");
    assert.equal(new PinStore(file).everPinned(), true);

    await fsp.writeFile(file, JSON.stringify({ version: 2, phones: [fp] })); // written before the flag existed
    assert.equal(new PinStore(file).everPinned(), true);
    // Older builds wrote these after `forget --all`; only no file at all is a fresh install.
    await fsp.writeFile(file, JSON.stringify({ version: 2, phones: [] }));
    assert.equal(new PinStore(file).everPinned(), true);
    await fsp.writeFile(file, JSON.stringify({ version: 2, phones: [], everPinned: false }));
    assert.equal(new PinStore(file).everPinned(), true);
    await fsp.writeFile(file, JSON.stringify({ version: 1, pins: {} }));
    assert.equal(new PinStore(file).everPinned(), true);
  });
});

test("rewrite_with_same_mtime_and_size_is_detected", async () => {
  await withTempDir(async (dir) => {
    const fpA = (await phoneCert("a")).fingerprint256;
    const fpB = (await phoneCert("b")).fingerprint256;
    const when = Math.floor(Date.now() / 1000) - 60;
    // In place keeps the inode, the same length keeps the size, and the mtime is
    // put back: only the bytes say the file changed.
    const rewrite = (file, content) => {
      const before = fs.statSync(file);
      fs.writeFileSync(file, content);
      fs.utimesSync(file, when, when);
      const after = fs.statSync(file);
      assert.deepEqual([after.ino, after.size, after.mtimeMs], [before.ino, before.size, before.mtimeMs]);
    };

    const file = path.join(dir, "phone-pins.json");
    const pinned = (fp) => `${JSON.stringify({ version: 2, everPinned: true, phones: [fp], allowNextUntil: 0 })}\n`;
    fs.writeFileSync(file, pinned(fpA));
    fs.utimesSync(file, when, when);
    const store = new PinStore(file);
    assert.equal(store.has(fpA), true);
    rewrite(file, pinned(fpB));
    assert.equal(store.has(fpA), false, "the forgotten phone is not trusted from a stale read");
    assert.equal(store.has(fpB), true);

    const tlsDir = path.join(dir, "tls");
    const first = ensureSteerSecret(tlsDir);
    const steerFile = path.join(tlsDir, "steer.secret");
    fs.utimesSync(steerFile, when, when);
    assert.equal(readSteerSecret(tlsDir), first);
    const next = "B".repeat(first.length);
    rewrite(steerFile, `${next}\n`);
    assert.equal(readSteerSecret(tlsDir), next);
  });
});

test("a_cli_write_landing_just_after_a_daemon_write_is_seen", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "phone-pins.json");
    const fpA = (await phoneCert("a")).fingerprint256;
    const fpB = (await phoneCert("b")).fingerprint256;
    new PinStore(file).add(fpA);
    // The daemon pins B, and `phones forget A` from the CLI replaces the file
    // right after the daemon's own write, before the daemon reads it again.
    const daemon = new PinStore(file, {
      writeFile: (target, content) => {
        fs.writeFileSync(target, content);
        new PinStore(file).forget(fpA);
      },
    });
    daemon.add(fpB);
    assert.equal(daemon.has(fpA), false, "the revocation is not missed");
    assert.deepEqual(daemon.list(), [fpB]);
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
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).version, 3, "rewritten as version 3");
  });
});

// ---- only TLS gets in, and it may steer, over both transports ----

test("plaintext_phone_is_refused_before_any_frame (phonelink)", async () => {
  await withDaemon(
    { transport: "phonelink", tls: false, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone }) => {
      // agentd dials TLS at a plaintext phone: the handshake is all it ever sends.
      await settle(300);
      assert.deepEqual(phone.frames, [], "no hello, so no token, and no board");
    },
  );
});

test("plaintext_phone_is_refused_before_any_frame (wshub)", async () => {
  await withDaemon(
    { transport: "wshub", attached: [{ provider: "claude", id: "s1" }] },
    async ({ wsPort, token }) => {
      const plain = fakePhone({ transport: "wshub", tls: false });
      await assert.rejects(plain.start({ port: wsPort, host: "127.0.0.1", token }));
      assert.deepEqual(plain.frames, [], "a ws:// client never gets a frame");
    },
  );
});

for (const transport of TRANSPORTS) {
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
}

// ---- PhoneLink: the daemon dials, the phone is the TLS server ----

const short = (fp) => fp.replace(/:/g, "").slice(0, 12).toLowerCase();

function dialTls(link, server, extra = {}) {
  link.connectToPhone({ host: "127.0.0.1", port: server.port, name: "phone", ...extra });
}

test("a_window_never_pins_a_phone_on_its_hello (phonelink)", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    pins.armAllowNext(Date.now()); // a window, but no SAS session to pair through
    const { link, logs, stop } = newLink(pins);
    try {
      dialTls(link, server);
      await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
      await settle(40);
      assert.deepEqual(server.seen.lines, [], "no hello, so no token");
      assert.equal(pins.isEmpty(), true, "a new phone joins only through SAS");
      assert.equal(link.trustedConnected, false);
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
    assert.match(operator[0], /agentd pair/);

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
    link.connectToPhone({ host: "localhost", port: server.port, name: "phone" });
    await waitUntil(() => link.trustedConnected, "a pinned cert is trusted at any address");
    assert.deepEqual(pins.list(), [phoneId.fingerprint256], "and nothing was added");
  } finally {
    stop();
    server.close();
  }
});

test("phone_link_never_dials_plaintext", async () => {
  // A plaintext listener that would take a hello, and a TLS phone, both announcing over UDP.
  let plainDials = 0;
  const plain = netServer((socket) => { plainDials += 1; socket.on("error", () => {}); });
  const plainPort = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add(phoneId.fingerprint256);
  const { link, logs, operator } = newLink(pins);
  link.start();
  const discoveryPort = () => { try { return link.discovery.address().port; } catch { return 0; } };
  await waitUntil(() => discoveryPort() > 0, "the discovery socket never bound");
  const udp = require("node:dgram").createSocket("udp4");
  track(() => udp.close());
  const announce = (fields) => new Promise((resolve) => udp.send(
    Buffer.from(JSON.stringify({ nexus: "agents-phone", name: "phone", ...fields })),
    discoveryPort(),
    "127.0.0.1",
    resolve,
  ));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await announce({ port: plainPort, tls: false });
    await announce({ port: plainPort }); // no `tls` at all is plaintext too
  }
  await waitUntil(
    () => logs.entries.some((e) => e.event === "phone_announcement_plaintext_ignored"),
    "the plaintext announcement was not logged",
  );
  await settle(100);
  assert.equal(plainDials, 0, "no socket was opened to the plaintext announcer");
  assert.equal(logs.entries.filter((e) => e.event === "phone_announcement_plaintext_ignored").length, 1, "said once");
  assert.deepEqual(operator, []);
  // The same path does dial a phone that announces TLS.
  await announce({ port: server.port, tls: true });
  await waitUntil(() => link.trustedConnected, "a TLS announcement was not dialled");
  assert.equal(plainDials, 0);
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

test("allow_next_window_without_sas_still_refuses_an_unknown_phone", async () => {
  const first = await phoneCert("first");
  const second = await phoneCert("second");
  const secondServer = await listenAsPhone(second);
  const pins = new PinStore();
  pins.add(first.fingerprint256);
  let clock = 1_000_000;
  const { link, logs, stop } = newLink(pins, { now: () => clock });
  try {
    // Closed: an unknown phone is refused.
    dialTls(link, secondServer);
    await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
    assert.equal(pins.has(second.fingerprint256), false);

    // Armed: still refused before any hello, since trust comes only from a SAS pairing.
    clock += 100_000; // past the refusal backoff
    pins.armAllowNext(clock);
    const refusals = () => logs.entries.filter((e) => e.event === "phone_link_untrusted_peer").length;
    dialTls(link, secondServer);
    await waitUntil(() => refusals() === 2, "the armed window let an unknown phone in");
    await settle(40);
    assert.equal(pins.has(second.fingerprint256), false);
    assert.deepEqual(secondServer.seen.lines, []);
  } finally {
    stop();
    secondServer.close();
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

test("fresh_install_without_window_refuses_tls_peer", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    const { link, logs, operator, stop } = newLink(pins);
    assert.equal(pins.everPinned(), false, "a fresh install: no pin file at all");
    dialTls(link, server);
    await waitUntil(
      () => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"),
      "a stranger on a fresh install was not refused",
    );
    await settle(40);
    assert.equal(link.trustedConnected, false);
    assert.deepEqual(server.seen.lines, [], "refused before hello: no token went to it");
    assert.equal(pins.isEmpty(), true, "and nothing was pinned");
    assert.match(operator[0], /agentd pair/);
    stop();
  });
});

test("pair_without_a_running_agentd_says_so_and_admits_nobody", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, "nexus-agentd");
    const coderDir = path.join(dir, "rokid-coder");
    const { ensureConfig, saveConfig } = require("../dist/config.js");
    saveConfig({ ...ensureConfig(stateDir), rokidCoder: { stateDir: coderDir } }, stateDir);
    // The code check runs in agentd, so `pair` is its client and needs it running.
    const failure = await runCli(coderDir, ["pair"]).then(() => undefined, (error) => error);
    assert.ok(failure, "pair exits non-zero without agentd");
    assert.match(failure.stderr, /agentd isn't running/);
    assert.equal(failure.stdout.includes("<"), false, "no placeholder is printed");
    const line = JSON.parse(failure.stdout.split("\n")[0]);
    assert.deepEqual(Object.keys(line).sort(), ["fp", "host", "kind", "port", "v"]);
    assert.equal(new PinStore(path.join(coderDir, "tls", "phone-pins.json")).isEmpty(), true);
  });
});

test("forget_only_phone_does_not_retofu_on_redial", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    let clock = 1_000_000;
    pins.add(phoneId.fingerprint256, clock); // paired earlier, by SAS
    const { link, logs, stop } = newLink(pins, { now: () => clock });
    dialTls(link, server);
    await waitUntil(() => link.trustedConnected, "link never became trusted");
    const hellos = () => server.seen.lines.filter((f) => f.type === "hello").length;
    assert.equal(hellos(), 1);

    new PinStore(file).forget(phoneId.fingerprint256); // the only phone, from the CLI
    await waitUntil(() => !link.connected, "the forgotten phone was not dropped");
    assert.equal(new PinStore(file).isEmpty(), true);

    // The same phone dials again. The set is empty but this is not a fresh install.
    clock += 100_000;
    dialTls(link, server);
    await waitUntil(
      () => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"),
      "the redial was not refused",
    );
    await settle(40);
    assert.equal(link.connected, false);
    assert.equal(hellos(), 1, "refused before hello: no token went to it");
    assert.equal(new PinStore(file).isEmpty(), true, "nothing was re-pinned");
    stop();
  });
});

test("forget_all_then_allow_next_still_needs_sas", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const first = await phoneCert("first");
    const second = await phoneCert("second");
    const firstServer = await listenAsPhone(first);
    const secondServer = await listenAsPhone(second);
    const pins = new PinStore(file);
    pins.add(first.fingerprint256);
    new PinStore(file).forgetAll();
    let clock = 2_000_000;
    const one = newLink(pins, { now: () => clock });
    dialTls(one.link, firstServer);
    await waitUntil(() => one.logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
    assert.deepEqual(firstServer.seen.lines, [], "no hello without allow-next");

    // `phones allow-next` opens a window, but a phone gets in only through a SAS pairing in it.
    clock += 100_000;
    new PinStore(file).armAllowNext(clock);
    const refusals = () => one.logs.entries.filter((e) => e.event === "phone_link_untrusted_peer").length;
    dialTls(one.link, firstServer);
    await waitUntil(() => refusals() === 2, "allow-next alone admitted the phone");
    await settle(40);
    assert.deepEqual(firstServer.seen.lines, []);
    assert.equal(pins.isEmpty(), true);
    one.link.stop();

    const two = newLink(pins, { now: () => clock });
    dialTls(two.link, secondServer);
    await waitUntil(() => two.logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "second not refused");
    assert.deepEqual(secondServer.seen.lines, []);
  });
});

test("stalled_tls_handshake_times_out_and_redial_resumes", async () => {
  const sockets = [];
  const silent = netServer((socket) => { sockets.push(socket); socket.on("error", () => {}); });
  const silentPort = await new Promise((resolve) => silent.listen(0, "127.0.0.1", () => resolve(silent.address().port)));
  const phoneId = await phoneCert("phone");
  const real = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add(phoneId.fingerprint256);
  const { link, logs, stop } = newLink(pins, { helloTimeoutMs: 60 });
  try {
    link.connectToPhone({ host: "127.0.0.1", port: silentPort, name: "stall" });
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
  const server = tlsServer({ key: phoneId.key, cert: phoneId.cert }, (socket) => {
    socket.on("error", () => {});
    socket.on("data", () => {}); // reads whatever comes, never answers
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const pins = new PinStore();
  pins.armAllowNext(Date.now());
  const { link, stop } = newLink(pins, { helloTimeoutMs: 60 });
  try {
    link.connectToPhone({ host: "127.0.0.1", port, name: "phone" });
    await waitUntil(() => link.socket === undefined, "the dial was not ended");
    assert.equal(pins.isEmpty(), true, "an unauthenticated peer is never pinned");
    assert.equal(link.trustedConnected, false);
  } finally {
    stop();
    server.close();
  }
});

test("a_pin_store_that_cannot_save_a_promotion_leaves_the_link_untrusted_and_closed", async () => {
  // The one write left on this path: a provisional phone's proof makes its pin durable.
  const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
  const { ProvisionalPins } = require("../dist/pairing/provisional-pins.js");
  const { commitProof } = require("./helpers/sas-phone.js");
  const agent = await agentCert();
  const phoneId = await phoneCert("phone");
  const provisional = new ProvisionalPins();
  provisional.add(phoneId.fingerprint256, "0123456789abcdef", Date.now());
  const pins = new PinStore();
  pins.add = () => { throw new Error("disk full"); };
  const logs = loggerHarness();
  const pairing = new PairingCoordinator({ config, pins, provisional, logger: logs.logger, steer: () => STEER, wsHost: () => "127.0.0.1" });
  track(() => pairing.dispose());
  const server = await listenAsPhone(phoneId);
  const { link, logs: linkLogs, stop } = newLink(pins, { pairing, clientCert: { key: agent.key, cert: agent.cert } });
  try {
    dialTls(link, server);
    await waitUntil(() => server.seen.lines.some((f) => f.type === "pair_commit_query"), "no commit query");
    server.send({ type: "pair_committed", v: 2, attempt: "0123456789abcdef", proof: commitProof(STEER, "0123456789abcdef", agent.fingerprint256, phoneId.fingerprint256) });
    await waitUntil(() => logs.entries.some((e) => e.event === "pairing_promote_failed"), "not reported");
    await waitUntil(() => link.socket === undefined, "the link was not closed");
    assert.equal(server.seen.lines.some((f) => f.type === "hello"), false, "no hello for a pin that was not saved");
    assert.equal(linkLogs.entries.some((e) => e.event === "phone_link_pins_unreadable"), false, "its own event, not a read failure");
    assert.equal(link.trustedConnected, false);
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

test("unprefixed_target_dials_tls", async () => {
  // A fresh install, with nothing pinned, and a configured target with no prefix.
  const wire = [];
  const plain = netServer((socket) => {
    socket.on("data", (chunk) => {
      wire.push(chunk);
      socket.write('{"type":"hello_ack","v":1}\n');
    });
    socket.on("error", () => {});
  });
  const port = await new Promise((resolve) => plain.listen(0, "127.0.0.1", () => resolve(plain.address().port)));
  const pins = new PinStore();
  const { link } = newLink(pins, { config: { ...config, phoneHosts: [`127.0.0.1:${port}`] } });
  link.start();
  await waitUntil(() => wire.length > 0, "the configured target was not dialled");
  await settle(80);
  const sent = Buffer.concat(wire);
  assert.equal(sent[0], 0x16, "the first byte is a TLS handshake record");
  assert.equal(sent.toString("latin1").includes(TOKEN), false, "the token never went out in the clear");
  assert.equal(sent.toString("latin1").includes('"hello"'), false);
  assert.equal(link.connected, false);
  assert.equal(pins.isEmpty(), true);
});

test("phonelink_channel_is_bound_to_its_connection", async () => {
  const phoneId = await phoneCert("phone");
  const server = await listenAsPhone(phoneId);
  const pins = new PinStore();
  pins.add(phoneId.fingerprint256);
  const channels = [];
  const v2 = { handle: (_frame, channel) => { channels.push(channel); return true; }, decorate: (s) => ({ ...s }) };
  const { link, stop } = newLink(pins, { v2 });
  try {
    dialTls(link, server);
    await waitUntil(() => link.trustedConnected, "link never became trusted");
    server.send({ type: "models_request", v: 2, sessionKey: "codex:t1" });
    await waitUntil(() => channels.length === 1, "the frame did not reach the handler");
    const first = channels[0];
    assert.equal(first.trusted, true);

    // The link drops and comes back while a reply to the first frame is still being made.
    link.socket.destroy();
    await waitUntil(() => !link.connected, "the link did not drop");
    await settle(40);
    dialTls(link, server);
    await waitUntil(() => link.trustedConnected, "the link did not come back");
    first.send({ type: "models", v: 2, sessionKey: "codex:t1", models: ["late"] });
    assert.equal(first.trusted, false, "an old connection's channel is not trusted on the new one");
    await settle(60);
    assert.equal(server.seen.lines.some((f) => f.type === "models"), false, "the late reply went nowhere");
  } finally {
    stop();
    server.close();
  }
});

test("tls_phone_target_prefix_is_still_accepted_and_means_nothing", () => {
  const { parsePhoneTarget } = require("../dist/config.js");
  assert.deepEqual(parsePhoneTarget("tls://100.64.1.2:9000"), { host: "100.64.1.2", port: 9000 });
  assert.deepEqual(parsePhoneTarget("tls://phone.local"), { host: "phone.local", port: 8792 });
  assert.deepEqual(parsePhoneTarget("100.64.1.2:9000"), { host: "100.64.1.2", port: 9000 });
  assert.equal(parsePhoneTarget("tls://"), undefined);
});

test("forget_disconnects_live_phonelink_and_refuses_steering", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const otherId = await phoneCert("other");
    const server = await listenAsPhone(phoneId);
    try {
      // First: the gate alone. An in-memory set has no file to watch and the
      // timer is far off, so only the live check can be what stops the phone.
      const memory = new PinStore();
      memory.add(otherId.fingerprint256);
      memory.add(phoneId.fingerprint256);
      const gate = newLink(memory, { trustCheckIntervalMs: 3_600_000 });
      try {
        dialTls(gate.link, server);
        await waitUntil(() => gate.link.trustedConnected, "link never became trusted");
        memory.forget(phoneId.fingerprint256); // `agentd phones forget`
        assert.equal(gate.link.trustedConnected, false, "monitor-only the moment the pin is gone");
        assert.equal(gate.link.sendApprovalRequest({ type: "approval_request", requestId: "r" }), false);
        assert.equal(gate.link.sendFrame({ type: "alert" }), false);
        server.send({ type: "approval_decision", v: 1, requestId: "r", decision: "allow" });
        await waitUntil(
          () => server.seen.lines.some((f) => f.type === "ack" && f.result === "rejected" && f.error === "monitor_only"),
          "a steering frame from a forgotten phone was not refused",
        );
        assert.equal(gate.link.connected, true, "the gate does not need the drop");
      } finally {
        gate.stop();
      }

      // Then the drop: with the pin file watched, the live link is closed.
      const pins = new PinStore(file);
      pins.add(otherId.fingerprint256);
      pins.add(phoneId.fingerprint256);
      const live = newLink(pins);
      try {
        const closesBefore = server.seen.closes;
        dialTls(live.link, server);
        await waitUntil(() => live.link.trustedConnected, "link never became trusted again");
        new PinStore(file).forget(phoneId.fingerprint256.replace(/:/g, "").slice(0, 16)); // from the CLI
        await waitUntil(() => server.seen.closes > closesBefore && !live.link.connected, "the link was not dropped");
        const revoked = live.logs.entries.find((e) => e.event === "phone_link_trust_revoked");
        assert.ok(revoked, "logged");
        assert.equal(revoked.meta.fingerprint, short(phoneId.fingerprint256), "shortened");
      } finally {
        live.stop();
      }
    } finally {
      server.close();
    }
  });
});

test("forget_all_disconnects_all", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    pins.add(phoneId.fingerprint256);
    const { link, stop } = newLink(pins);
    try {
      dialTls(link, server);
      await waitUntil(() => link.trustedConnected, "link never became trusted");
      new PinStore(file).forgetAll();
      await waitUntil(() => !link.connected && server.seen.closes >= 1, "forget --all did not drop the live link");
      assert.equal(link.trustedConnected, false);
    } finally {
      stop();
      server.close();
    }
  });
});

test("allow_next_alone_admits_nobody_through_the_empty_set", async () => {
  const first = await phoneCert("first");
  const firstServer = await listenAsPhone(first);
  const pins = new PinStore();
  pins.armAllowNext(Date.now());
  const one = newLink(pins);
  try {
    dialTls(one.link, firstServer);
    await waitUntil(() => one.logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "first phone was admitted");
    await settle(40);
    assert.deepEqual(firstServer.seen.lines, []);
    assert.equal(pins.isEmpty(), true);
  } finally {
    one.stop();
    firstServer.close();
  }
});

test("a_stalling_tls_peer_is_backed_off_not_retried_in_seconds_while_a_phone_is_trusted", async () => {
  const sockets = [];
  const silent = netServer((socket) => { sockets.push(socket); socket.on("error", () => {}); });
  const port = await new Promise((resolve) => silent.listen(0, "127.0.0.1", () => resolve(silent.address().port)));
  const pins = new PinStore();
  pins.add((await phoneCert("trusted")).fingerprint256);
  const { link, stop } = newLink(pins, { helloTimeoutMs: 40 });
  try {
    link.connectToPhone({ host: "127.0.0.1", port, name: "stall" });
    await waitUntil(() => sockets.length === 1 && link.socket === undefined, "the stall did not time out");
    await settle(60); // far past reconnectDelayMs (20 ms) that would have allowed a redial
    link.connectToPhone({ host: "127.0.0.1", port, name: "stall" });
    await settle(60);
    assert.equal(sockets.length, 1, "refusal backoff, not the short reconnect delay");
  } finally {
    stop();
    for (const socket of sockets) socket.destroy();
    silent.close();
  }
});

// ---- WsHub: the phone dials agentd, which is the TLS server ----

/** A hub whose pin set already holds the default fake phone's cert, unless `pins` is given. */
async function newHub(options = {}) {
  const agent = await agentCert();
  const logs = loggerHarness();
  const store = new SessionStore(config, logs.logger);
  const pins = options.pins ?? new PinStore();
  if (!options.pins) pins.add((await phoneCert("phone")).fingerprint256);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, ...options, pins });
  await hub.start();
  const stop = async () => { await hub.stop(); store.dispose(); };
  track(stop);
  return { hub, logs, agent, pins, stop };
}

async function connectPhone(hub, agent, options) {
  const phone = fakePhone({ transport: "wshub", pin: agent.fingerprint256, steer: STEER, ...options });
  await phone.start({ port: hub.port(), token: TOKEN });
  await phone.waitFor("hello_ack");
  return phone;
}

/** Dials, says hello and waits for agentd to refuse it: the reject frame, then the close. */
async function refusedHello(hub, agent, options, token = TOKEN) {
  const phone = fakePhone({ transport: "wshub", pin: agent.fingerprint256, steer: STEER, ...options });
  const closes = phone.closes;
  await phone.start({ port: hub.port(), token });
  const reject = await phone.waitFor("hello_reject");
  await phone.waitForClose(closes);
  assert.equal(phone.frames.some((f) => f.type === "hello_ack" || f.type === "snapshot"), false, "nothing past the reject");
  return { phone, reject, code: phone.closeCode };
}

const REPAIR_NEEDED = { type: "hello_reject", v: 2, reason: "repair_needed" };

/** Sends a steering frame and says whether agentd refused it. */
async function steeringRefused(phone) {
  const frame = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
  const ack = await phone.waitFor("ack", (f) => f.msgId === frame.msgId);
  return ack.error === "monitor_only";
}

test("wshub_requires_a_cert", async () => {
  const store = new SessionStore(config, loggerHarness().logger);
  try {
    assert.throws(() => new WsHub(config, store, loggerHarness().logger, { host: "127.0.0.1", steer: () => STEER }), /TLS/);
  } finally {
    store.dispose();
  }
});

test("plain_ws_on_8792_is_refused_and_logged", async () => {
  const { hub, logs } = await newHub();
  const received = [];
  const socket = net.connect(hub.port(), "127.0.0.1");
  track(() => socket.destroy());
  socket.on("data", (chunk) => received.push(chunk));
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.write(
    "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  await closed;
  assert.deepEqual(received, [], "not one byte back: no 101, no 426, no TLS alert");
  assert.equal(socket.destroyed, true);
  await waitUntil(() => logs.entries.some((e) => e.event === "ws_plaintext_refused"), "the refusal was not logged");
  assert.equal(hub.hasAuthenticatedClient, false);
});

test("bad_token_gets_hello_reject_bad_token_and_4403", async () => {
  const { hub, logs, agent, pins } = await newHub();
  const before = pins.list();
  const { reject, code } = await refusedHello(hub, agent, {}, "not-the-token");
  assert.deepEqual(reject, { type: "hello_reject", v: 2, reason: "bad_token" });
  assert.equal(code, 4403);
  assert.deepEqual(pins.list(), before);
  assert.equal(JSON.stringify(logs.entries).includes("not-the-token"), false, "the token is never logged");
});

test("wss_without_client_cert_gets_repair_needed", async () => {
  const { hub, logs, agent, pins } = await newHub();
  const before = pins.list();
  const { reject, code } = await refusedHello(hub, agent, { cert: null });
  assert.deepEqual(reject, REPAIR_NEEDED);
  assert.equal(code, 4403);
  assert.deepEqual(pins.list(), before);
  assert.ok(logs.entries.some((e) => e.event === "ws_auth_rejected" && e.meta.reason === "no_client_cert"));
});

test("wss_upgrade_without_any_client_cert_reaches_hello_and_gets_repair_needed", async () => {
  const pins = new PinStore();
  pins.armAllowNext(Date.now());
  const { hub, agent } = await newHub({ pins });
  // The handshake and the upgrade both succeed without a cert: the refusal is the hello's, where it can say why.
  const socket = new WebSocket(`wss://127.0.0.1:${hub.port()}`, { rejectUnauthorized: false });
  track(() => socket.terminate());
  const frames = [];
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const opened = await new Promise((resolve) => {
    socket.once("open", () => resolve(true));
    socket.once("error", () => resolve(false));
  });
  assert.equal(opened, true, "a cert-less client reaches the WebSocket");
  assert.equal(socket._socket.getPeerCertificate().fingerprint256, agent.fingerprint256);
  const code = new Promise((resolve) => socket.once("close", resolve));
  socket.send(JSON.stringify({ type: "hello", v: 1, token: TOKEN, steer: STEER }));
  assert.equal(await code, 4403);
  assert.deepEqual(frames, [REPAIR_NEEDED]);
  assert.equal(pins.allowNextOpen(Date.now()), true, "an open window is not spent on a phone with no cert");
  assert.deepEqual(pins.list(), []);
});

test("wss_with_unpinned_cert_outside_window_gets_repair_needed", async () => {
  const { hub, logs, agent, pins } = await newHub();
  const stranger = await phoneCert("stranger");
  const { reject, code } = await refusedHello(hub, agent, { cert: stranger });
  assert.deepEqual(reject, REPAIR_NEEDED);
  assert.equal(code, 4403);
  assert.equal(pins.has(stranger.fingerprint256), false);
  const refusal = logs.entries.find((e) => e.event === "ws_auth_rejected");
  assert.deepEqual(refusal.meta, { reason: "unpinned_cert", fingerprint: short(stranger.fingerprint256) });
  assert.equal(JSON.stringify(logs.entries).includes(stranger.fingerprint256), false, "never the full fingerprint");
});

test("wss_with_unpinned_cert_inside_window_is_never_pinned_by_its_hello", async () => {
  const pins = new PinStore();
  pins.add((await phoneCert("first")).fingerprint256);
  pins.armAllowNext(Date.now());
  const { hub, agent } = await newHub({ pins });
  const newcomer = await phoneCert("newcomer");
  const { reject } = await refusedHello(hub, agent, { cert: newcomer });
  assert.deepEqual(reject, REPAIR_NEEDED, "a new phone pairs by SAS, never by a hello");
  assert.equal(pins.has(newcomer.fingerprint256), false);
  assert.equal(hub.hasTrustedClient, false);
});

test("wss_with_pinned_cert_but_wrong_steer_gets_repair_needed", async () => {
  const { hub, agent } = await newHub();
  for (const steer of [undefined, "wrong-secret", STEER.slice(0, -1), `${STEER}x`, ""]) {
    const { reject, code } = await refusedHello(hub, agent, { steer });
    assert.deepEqual(reject, REPAIR_NEEDED, `steer ${JSON.stringify(steer)}`);
    assert.equal(code, 4403);
  }
  assert.equal(hub.hasAuthenticatedClient, false);
});

test("failed_hello_inside_window_leaves_pins_and_window_unchanged", async () => {
  const pins = new PinStore();
  pins.add((await phoneCert("first")).fingerprint256);
  pins.armAllowNext(Date.now());
  const { hub, agent } = await newHub({ pins });
  const before = pins.list();
  const newcomer = await phoneCert("newcomer");
  const wrongSteer = await refusedHello(hub, agent, { cert: newcomer, steer: "wrong-secret" });
  assert.deepEqual(wrongSteer.reject, REPAIR_NEEDED);
  assert.deepEqual(pins.list(), before, "a wrong steer pins nothing");
  assert.equal(pins.allowNextOpen(Date.now()), true, "and leaves the window open");
  const wrongToken = await refusedHello(hub, agent, { cert: newcomer }, "not-the-token");
  assert.deepEqual(wrongToken.reject, { type: "hello_reject", v: 2, reason: "bad_token" });
  assert.deepEqual(pins.list(), before, "a wrong token pins nothing");
  assert.equal(pins.allowNextOpen(Date.now()), true, "and leaves the window open");
});

test("steer_rotation_during_admission_leaves_pins_and_window_unchanged", async () => {
  const pins = new PinStore();
  const newcomer = await phoneCert("newcomer");
  // A pinned phone whose secret is rotated mid-hello: refused at the commit point.
  pins.add(newcomer.fingerprint256);
  pins.armAllowNext(Date.now());
  // The secret is rotated just after the hello's first read of it, while the phone is being admitted.
  let reads = 0;
  const { hub, agent } = await newHub({
    pins,
    steer: () => (++reads === 1 ? STEER : "a-secret-rotated-mid-admission"),
    trustCheckIntervalMs: 3_600_000,
  });
  const before = pins.list();
  const { reject, code } = await refusedHello(hub, agent, { cert: newcomer });
  assert.ok(reads >= 2, "the secret was read again at the commit point");
  assert.deepEqual(reject, REPAIR_NEEDED);
  assert.equal(code, 4403);
  assert.deepEqual(pins.list(), before, "the pins are unchanged");
  assert.equal(pins.allowNextOpen(Date.now()), true, "and the window is still open");
});

test("hello_ack_steering_is_always_true_for_an_accepted_wss_phone", async () => {
  const { hub, agent } = await newHub();
  const phone = await connectPhone(hub, agent);
  // R126: the phone binds steering from this flag; a hello that would not steer gets no ack at all.
  assert.equal(phone.frames.find((f) => f.type === "hello_ack").steering, true);
});

test("link_trust_frame_on_rotation", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    const first = ensureSteerSecret(tlsDir);
    const { hub, agent, stop } = await newHub({
      steer: () => readSteerSecret(tlsDir),
      steerFile: path.join(tlsDir, "steer.secret"),
    });
    const steering = await connectPhone(hub, agent, { steer: first });
    try {
      const closesBefore = steering.closes;
      rotateSteerSecret(tlsDir);
      await steering.waitForClose(closesBefore, 3000);
      const trust = steering.frames.filter((f) => f.type === "link_trust");
      assert.deepEqual(trust, [{ type: "link_trust", v: 2, steering: false }]);
      assert.deepEqual(trust[0], FIXTURES.agent_to_phone.link_trust, "the shared fixture is what agentd sends");
      assert.equal(steering.closeCode, 4403);
    } finally {
      steering.close();
      await stop();
    }
  });
});

test("wss_with_steer_is_trusted", async () => {
  const { hub, agent, stop } = await newHub();
  const phone = await connectPhone(hub, agent);
  try {
    assert.equal(hub.hasTrustedClient, true);
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r" }), true);
    await phone.waitFor("approval_request");
  } finally {
    phone.close();
    await stop();
  }
});

test("a_dialled_plaintext_listener_never_learns_the_token_and_a_token_alone_gets_nobody_in", async () => {
  // The old attack: answer agentd's dial to learn the token, then use it on wss.
  const wire = [];
  const trap = netServer((socket) => {
    socket.on("data", (chunk) => wire.push(chunk));
    socket.on("error", () => {});
  });
  const trapPort = await new Promise((resolve) => trap.listen(0, "127.0.0.1", () => resolve(trap.address().port)));
  const { link, stop: stopLink } = newLink(new PinStore());
  const { hub, agent, stop } = await newHub();
  try {
    link.connectToPhone({ host: "127.0.0.1", port: trapPort, name: "impostor" });
    await waitUntil(() => wire.length > 0, "the dial never arrived");
    await settle(50);
    assert.equal(Buffer.concat(wire).toString("latin1").includes(TOKEN), false, "the dial is TLS: no token to take");
    // Even holding the token and the secret, an unpinned cert is refused.
    const { reject } = await refusedHello(hub, agent, { cert: await phoneCert("attacker") });
    assert.deepEqual(reject, REPAIR_NEEDED);
    assert.equal(hub.hasTrustedClient, false);
  } finally {
    stopLink();
    await stop();
    trap.close();
  }
});

test("rotating_the_steer_secret_cuts_off_the_old_secret_everywhere", async () => {
  let current = STEER;
  // No file to watch and no timer worth waiting for: this is the gate alone.
  const { hub, agent, stop } = await newHub({ steer: () => current, trustCheckIntervalMs: 3_600_000 });
  const before = await connectPhone(hub, agent);
  try {
    assert.equal(hub.hasTrustedClient, true);
    current = "a-freshly-rotated-secret";
    // The phone that was steering is refused from this moment, before the re-check drops it.
    assert.equal(hub.hasTrustedClient, false);
    assert.equal(await steeringRefused(before), true, "its steering frames are refused");
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r0" }), false);
    const { reject } = await refusedHello(hub, agent, { steer: STEER });
    assert.deepEqual(reject, REPAIR_NEEDED, "the old secret no longer gets in at the next hello either");
    const fresh = await connectPhone(hub, agent, { steer: current });
    assert.equal(hub.sendApprovalRequest({ type: "approval_request", requestId: "r" }), true);
    await fresh.waitFor("approval_request");
    await settle(30);
    assert.equal(before.frames.some((f) => f.type === "approval_request"), false);
    fresh.close();
  } finally {
    before.close();
    await stop();
  }
});

test("rotate_steer_cuts_off_connected_wss_phone", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    const first = ensureSteerSecret(tlsDir);
    const { hub, logs, agent, stop } = await newHub({
      steer: () => readSteerSecret(tlsDir),
      steerFile: path.join(tlsDir, "steer.secret"),
    });
    const steering = await connectPhone(hub, agent, { steer: first });
    try {
      assert.equal(hub.hasTrustedClient, true);
      const closesBefore = steering.closes;
      rotateSteerSecret(tlsDir); // `agentd pair --rotate-steer`, from another process
      await steering.waitForClose(closesBefore, 3000);
      assert.equal(hub.hasTrustedClient, false);
      assert.ok(logs.entries.some((e) => e.event === "ws_trust_revoked" && e.meta.reason === "steer_rotated"));
      assert.equal(JSON.stringify(logs.entries).includes(first), false);
    } finally {
      steering.close();
      await stop();
    }
  });
});

test("revocation_logged_once (wshub)", async () => {
  await withTempDir(async (dir) => {
    const tlsDir = path.join(dir, "tls");
    const first = ensureSteerSecret(tlsDir);
    const { hub, logs, agent } = await newHub({
      steer: () => readSteerSecret(tlsDir),
      steerFile: path.join(tlsDir, "steer.secret"),
      trustCheckIntervalMs: 5,
    });
    const phone = await connectPhone(hub, agent, { steer: first });
    assert.equal(hub.hasTrustedClient, true);
    phone.stall(); // a hung phone never answers the close frame
    rotateSteerSecret(tlsDir);
    await waitUntil(() => !hub.hasAuthenticatedClient, "the revoked client was not dropped at once");
    await settle(150); // many re-check passes
    assert.equal(logs.entries.filter((e) => e.event === "ws_trust_revoked").length, 1);
  });
});

test("revocation_logged_once (phonelink)", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "tls", "phone-pins.json");
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore(file);
    pins.add(phoneId.fingerprint256);
    const { link, logs } = newLink(pins, { trustCheckIntervalMs: 5 });
    dialTls(link, server);
    await waitUntil(() => link.trustedConnected, "link never became trusted");
    new PinStore(file).forget(phoneId.fingerprint256);
    await waitUntil(() => !link.connected, "the forgotten phone was not dropped");
    await settle(150);
    assert.equal(logs.entries.filter((e) => e.event === "phone_link_trust_revoked").length, 1);
  });
});

test("wss_without_a_configured_secret_admits_nobody", async () => {
  const { hub, agent } = await newHub({ steer: () => undefined });
  const { reject } = await refusedHello(hub, agent);
  assert.deepEqual(reject, REPAIR_NEEDED);
  assert.equal(hub.hasTrustedClient, false);
});

test("a_wss_phone_with_the_wrong_pin_never_sends_its_token", async () => {
  const { hub, logs, stop } = await newHub();
  const phone = fakePhone({
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

test("forgetting_a_pin_closes_its_wss_peer_live", async () => {
  await withDaemon(
    { transport: "wshub", attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, wsPort, token, steer, coderDir, agentFingerprint, pins }) => {
      const otherId = await phoneCert("other");
      pins.add(otherId.fingerprint256);
      const other = fakePhone({ transport: "wshub", pin: agentFingerprint, cert: otherId, steer });
      await other.start({ port: wsPort, host: "127.0.0.1", token });
      await other.waitFor("hello_ack");
      const seen = phone.frames.length;
      const closesBefore = phone.closes;
      const { stdout } = await runCli(coderDir, ["phones", "forget", phone.fingerprint.replace(/:/g, "").slice(0, 16)]);
      assert.equal(stdout, "Forgotten. That phone's links close now; it must pair again to reconnect.\n");
      await phone.waitForClose(closesBefore, 3000);
      // R126: the phone heard the trust go before the link did.
      assert.deepEqual(phone.frames.slice(seen).filter((f) => f.type === "link_trust"), [FIXTURES.agent_to_phone.link_trust]);
      assert.equal(phone.closeCode, 4403);
      await settle(100);
      assert.equal(other.closes, 0, "the phone still pinned stays connected");
      const frame = other.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
      assert.equal((await other.waitFor("ack", (f) => f.msgId === frame.msgId)).result, "applied");
    },
  );
});

// ---- the steering secret is never sent ----

for (const transport of TRANSPORTS) {
  test(`steer_never_appears_in_any_frame_agentd_sends (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ phone, httpPort, steer }) => {
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
        await settle(100);
        assert.ok(phone.frames.length >= 6);
        assert.equal(JSON.stringify(phone.frames).includes(steer), false, "the phone received the steering secret");
      },
    );
  });
}

test("steer_never_appears_on_the_dialled_link_or_in_logs", async () => {
  await withTempDir(async (dir) => {
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const pins = new PinStore();
    pins.add(phoneId.fingerprint256);
    const { link, logs, stop } = newLink(pins);
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

test("revoked_phone_receives_no_alerts_after_revocation (wshub, secret rotated)", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort, coderDir }) => {
      const seen = phone.frames.length;
      rotateSteerSecret(path.join(coderDir, "tls")); // `agentd pair --rotate-steer`
      const reply = await Promise.race([
        postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        settle(1000).then(() => "held"),
      ]);
      assert.deepEqual(reply, {}, "not held for a phone that can no longer answer");
      await settle(50);
      assert.equal(
        phone.frames.slice(seen).some((f) => f.type === "approval_request" || f.type === "alert"),
        false,
      );
    },
  );
});

test("revoked_phone_receives_no_alerts_after_revocation (phonelink, pin forgotten)", async () => {
  await withDaemon(
    { transport: "phonelink", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort, coderDir }) => {
      const file = path.join(coderDir, "tls", "phone-pins.json");
      const store = new PinStore(file);
      assert.deepEqual(store.list(), [phone.fingerprint]);
      store.add((await phoneCert("other")).fingerprint256);
      const seen = phone.frames.length;
      const closesBefore = phone.closes;
      store.forget(phone.fingerprint);
      const reply = await Promise.race([
        postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        settle(1000).then(() => "held"),
      ]);
      assert.deepEqual(reply, {}, "not held for a forgotten phone");
      await phone.waitForClose(closesBefore, 3000);
      // R126: the phone heard the trust go before the link did.
      assert.ok(phone.frames.slice(seen).some((f) => f.type === "link_trust" && f.steering === false));
      assert.equal(
        phone.frames.slice(seen).some((f) => f.type === "approval_request" || f.type === "alert"),
        false,
      );
    },
  );
});

// ---- revocation hands everything held for the phone back to the laptop ----

/** `phones forget` for the dialled phone, `pair --rotate-steer` for a wss one; both from another process. */
function revoke(transport, phone, coderDir) {
  const tlsDir = path.join(coderDir, "tls");
  if (transport === "wshub") rotateSteerSecret(tlsDir);
  else new PinStore(path.join(tlsDir, "phone-pins.json")).forget(phone.fingerprint);
}

const askUserQuestion = (sessionId, toolUseId) => ({
  hook_event_name: "PreToolUse",
  session_id: sessionId,
  tool_name: "AskUserQuestion",
  tool_use_id: toolUseId,
  tool_input: { questions: [{ question: "Pick", header: "Pick", options: [{ label: "A" }, { label: "B" }] }] },
});

for (const transport of TRANSPORTS) {
  test(`revocation_releases_held_approval_to_laptop_immediately (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }] },
      async ({ phone, httpPort, coderDir }) => {
        const reply = postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        });
        await phone.waitFor("approval_request");
        phone.stall(); // from here the phone answers nothing, not even a close frame
        revoke(transport, phone, coderDir);
        const outcome = await Promise.race([reply, settle(3000).then(() => "held")]);
        assert.deepEqual(outcome, {}, "the laptop prompt gets it, without waiting for the phone to hang up");
      },
    );
  });

  test(`revocation_releases_held_stop_wait_and_question (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "s1" }, { provider: "claude", id: "s2" }] },
      async ({ daemon, phone, httpPort, coderDir }) => {
        const stop = postHook(httpPort, { hook_event_name: "Stop", session_id: "s1" });
        const question = postHook(httpPort, askUserQuestion("s2", "tu-1"));
        await waitUntil(
          () => daemon.stopWait.state("s1").waiting && daemon.questionRelay.isWaiting("tu-1"),
          "the Stop and the question were not held for the trusted phone",
          3000,
        );
        phone.stall();
        revoke(transport, phone, coderDir);
        const outcome = await Promise.race([Promise.all([stop, question]), settle(3000).then(() => "held")]);
        assert.deepEqual(outcome, [{}, {}], "both go back to the laptop");
        assert.equal(daemon.stopWait.state("s1").waiting, false);
        assert.equal(daemon.questionRelay.isWaiting("tu-1"), false);
      },
    );
  });
}

// ---- the `phones forget` CLI ----

/** Runs the real CLI against a withDaemon state dir, with HOME there too so nothing real is touched. */
function runCli(coderDir, args) {
  const root = path.dirname(coderDir);
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, "..", "dist", "cli.js"), ...args],
      { env: { ...process.env, HOME: root, NEXUS_AGENTD_STATE_DIR: path.join(root, "nexus-agentd") }, timeout: 10_000 },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })),
    );
  });
}

const steerOnDisk = async (coderDir) => (await fsp.readFile(path.join(coderDir, "tls", "steer.secret"), "utf8")).trim();

test("forget_all_rotates_steer_and_cuts_wss", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, httpPort, coderDir, steer }) => {
      const before = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === before.msgId)).result, "applied");
      const closesBefore = phone.closes;
      const { stdout } = await runCli(coderDir, ["phones", "forget", "--all"]);
      assert.match(stdout, /steering secret was rotated/);
      assert.match(stdout, /pair again/);
      assert.notEqual(await steerOnDisk(coderDir), steer, "forgetting everything also rotates the steering secret");
      await phone.waitForClose(closesBefore, 3000);
      const reply = await Promise.race([
        postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "s1",
          tool_name: "Bash",
          tool_input: { command: "ls" },
        }),
        settle(1000).then(() => "held"),
      ]);
      assert.deepEqual(reply, {}, "no phone can steer now");
    },
  );
});

test("forget_one_says_its_links_close_and_keeps_steer", async () => {
  await withDaemon(
    { transport: "wshub", tls: true, attached: [{ provider: "claude", id: "s1" }] },
    async ({ phone, coderDir, steer }) => {
      const lost = (await phoneCert("lost")).fingerprint256;
      new PinStore(path.join(coderDir, "tls", "phone-pins.json")).add(lost);
      const closesBefore = phone.closes;
      const { stdout } = await runCli(coderDir, ["phones", "forget", lost]);
      assert.ok(
        stdout.startsWith("Forgotten. That phone's links close now; it must pair again to reconnect.\n"),
        stdout,
      );
      assert.equal(await steerOnDisk(coderDir), steer, "one phone forgotten keeps the secret");
      await settle(100);
      assert.equal(phone.closes, closesBefore);
      const frame = phone.sendFrame("mode_set", ["claude:s1", "acceptEdits"]);
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === frame.msgId)).result, "applied");
    },
  );
});

// ---- usage-based pairing TTL ----

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const pinsFileOf = (dir) => path.join(dir, "tls", "phone-pins.json");

test("v2_pins_migrate_to_v3_with_now_as_last_used", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const fpA = (await phoneCert("a")).fingerprint256;
    const fpB = (await phoneCert("b")).fingerprint256;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ version: 2, everPinned: true, phones: [fpA, fpB], allowNextUntil: 0 }));
    const store = new PinStore(file, { now: () => 5_000_000 });
    assert.deepEqual(
      store.entries(),
      [fpA, fpB].map((fp) => ({ fp, addedAt: 5_000_000, lastUsedAt: 5_000_000 })),
    );
    assert.deepEqual(store.list(), [fpA, fpB], "the same phones, so nobody is signed out by the upgrade");
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).version, 2, "reading alone does not rewrite");
    // The first expiry run writes the migration down, so a restart does not start the clock over.
    assert.deepEqual(store.expire(5_000_000 + 1, 14 * DAY), []);
    const written = JSON.parse(await fsp.readFile(file, "utf8"));
    assert.equal(written.version, 3);
    assert.deepEqual(written.phones, [
      { fp: fpA, addedAt: 5_000_000, lastUsedAt: 5_000_000 },
      { fp: fpB, addedAt: 5_000_000, lastUsedAt: 5_000_000 },
    ]);
    assert.deepEqual(new PinStore(file, { now: () => 99_000_000 }).entries()[0].lastUsedAt, 5_000_000);
  });
});

test("a_version_3_file_with_a_bad_entry_is_refused", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const fp = (await phoneCert("a")).fingerprint256;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    for (const phones of [[fp], [{ fp, addedAt: 1 }], [{ fp: "nope", addedAt: 1, lastUsedAt: 1 }]]) {
      await fsp.writeFile(file, JSON.stringify({ version: 3, phones }));
      assert.throws(() => new PinStore(file), /Invalid phone pins/);
    }
  });
});

test("touch_writes_at_most_hourly", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const fp = (await phoneCert("a")).fingerprint256;
    const other = (await phoneCert("b")).fingerprint256;
    let writes = 0;
    const counting = (target, content) => {
      writes += 1;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };
    const t0 = 10 * DAY;
    const store = new PinStore(file, { writeFile: counting });
    store.add(fp, t0);
    store.add(other, t0);
    assert.equal(writes, 2);
    store.touch(fp, t0 + 1_000);
    store.touch(fp, t0 + 30 * 60_000);
    store.touch(fp, t0 + HOUR - 1);
    assert.equal(writes, 2, "within the hour of its last use: nothing is written");
    store.touch(fp, t0 + HOUR);
    assert.equal(writes, 3, "an hour on: written");
    assert.equal(store.entries().find((e) => e.fp === fp).lastUsedAt, t0 + HOUR);
    store.touch(fp, t0 + HOUR + 59 * 60_000);
    assert.equal(writes, 3, "the hour counts from the last write");
    store.touch(fp, t0 + 2 * HOUR);
    assert.equal(writes, 4);
    assert.equal(new PinStore(file).entries().find((e) => e.fp === fp).lastUsedAt, t0 + 2 * HOUR, "on disk");
    assert.equal(new PinStore(file).entries().find((e) => e.fp === other).lastUsedAt, t0, "the other phone is untouched");
    store.touch((await phoneCert("stranger")).fingerprint256, t0 + 9 * HOUR);
    assert.equal(writes, 4, "an unpinned fingerprint is ignored");
  });
});

test("future_last_used_is_clamped_to_now", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const fp = (await phoneCert("a")).fingerprint256;
    const now = 100 * DAY;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // The clock went back: last used a year from now.
    const future = { version: 3, phones: [{ fp, addedAt: now - DAY, lastUsedAt: now + 365 * DAY }] };
    await fsp.writeFile(file, JSON.stringify(future));
    const store = new PinStore(file, { now: () => now });
    assert.equal(store.entries()[0].lastUsedAt, now, "reads as now, never the future");
    assert.equal(store.isTrusted(fp, now, 14 * DAY), true);
    // Not the immortal pin a future time would make: 14 days on it is as stale as any other.
    assert.equal(store.isTrusted(fp, now + 14 * DAY - 1, 14 * DAY), true);
    assert.deepEqual(store.expire(now + 14 * DAY, 14 * DAY), [fp]);

    // The first use after the load puts the corrected time on disk, even inside the hour.
    await fsp.writeFile(file, JSON.stringify(future));
    store.touch(fp, now + 1_000);
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).phones[0].lastUsedAt, now);
  });
});

test("clock_rollback_after_load_does_not_extend_ttl", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const fp = (await phoneCert("a")).fingerprint256;
    const ttl = 14 * DAY;
    const t0 = 100 * DAY;
    let clock = t0;
    const store = new PinStore(file, { now: () => clock });
    store.add(fp, t0);
    // The clock goes back five days after the pin was loaded and written.
    clock = t0 - 5 * DAY;
    assert.equal(store.isTrusted(fp, clock, ttl), true, "still inside the TTL");
    assert.equal(
      JSON.parse(await fsp.readFile(file, "utf8")).phones[0].lastUsedAt,
      clock,
      "the correction is on disk, not only in memory",
    );
    // Unused since the clamped time: the TTL runs from there, not from the future time.
    assert.equal(store.isTrusted(fp, clock + ttl - 1, ttl), true);
    clock += ttl;
    assert.equal(store.isTrusted(fp, clock, ttl), false, "expired 14 days after the clamped time");
    assert.deepEqual(store.list(), []);

    // The same through expire and touch.
    clock = t0;
    store.add(fp, t0);
    clock = t0 - 5 * DAY;
    assert.deepEqual(store.expire(clock + ttl, ttl), [fp]);
    clock = t0;
    store.add(fp, t0);
    clock = t0 - 5 * DAY;
    store.touch(fp, clock);
    assert.equal(JSON.parse(await fsp.readFile(file, "utf8")).phones[0].lastUsedAt, clock);
  });
});

test("expire_forgets_only_the_stale_and_isTrusted_forgets_on_the_spot", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const old = (await phoneCert("old")).fingerprint256;
    const fresh = (await phoneCert("fresh")).fingerprint256;
    const t0 = 50 * DAY;
    const { entries, logger } = loggerHarness();
    const store = new PinStore(file, { logger });
    store.add(old, t0);
    store.add(fresh, t0 + 10 * DAY);
    const now = t0 + 15 * DAY;
    assert.deepEqual(store.expire(now, 14 * DAY), [old]);
    assert.deepEqual(store.list(), [fresh]);
    assert.deepEqual(new PinStore(file).list(), [fresh], "on disk");
    const logged = entries.find((e) => e.event === "phone_pairing_expired");
    assert.deepEqual(logged.meta, { fingerprint: short(old), unused_days: 15 });
    assert.equal(new PinStore(file).everPinned(), true, "forgetting is not a fresh install");
    assert.deepEqual(store.expire(now, 14 * DAY), [], "nothing more to forget");

    assert.equal(store.isTrusted(fresh, t0 + 24 * DAY - 1, 14 * DAY), true);
    assert.equal(store.isTrusted(fresh, t0 + 24 * DAY, 14 * DAY), false, "stale: not trusted");
    assert.deepEqual(store.list(), [], "and forgotten on the spot");
    assert.equal(store.isTrusted("not a fingerprint", now, DAY), false);
  });
});

for (const transport of TRANSPORTS) {
  test(`pin_unused_for_ttl_is_expired_and_link_revoked (${transport})`, async () => {
    await withDaemon(
      { transport, attached: [{ provider: "claude", id: "s1" }] },
      async ({ daemon, phone, pins, coderDir }) => {
        const connectedAt = Date.now();
        assert.equal(pins.entries().length, 1);
        assert.ok(pins.entries()[0].lastUsedAt <= connectedAt, "the phone's pairing was used when it connected");
        const seen = phone.frames.length;
        const closesBefore = phone.closes;
        // 15 days later with nothing used it since: the hourly sweep runs.
        const forgotten = daemon.sweepPairings(connectedAt + 15 * DAY);
        assert.deepEqual(forgotten, [phone.fingerprint]);
        await phone.waitForClose(closesBefore, 4000);
        assert.deepEqual(
          phone.frames.slice(seen).filter((f) => f.type === "link_trust"),
          [FIXTURES.agent_to_phone.link_trust],
          "told before the link went",
        );
        assert.equal(new PinStore(path.join(coderDir, "tls", "phone-pins.json")).list().length, 0, "gone from the file");
      },
    );
  });
}

test("connected_phone_never_expires (phonelink)", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    let clock = Date.now();
    const pins = new PinStore(file, { now: () => clock });
    pins.add(phoneId.fingerprint256, clock);
    const { link, stop } = newLink(pins, { now: () => clock, pingIntervalMs: 10, trustCheckIntervalMs: 20 });
    try {
      dialTls(link, server);
      await waitUntil(() => link.trustedConnected, "link never became trusted");
      const lastUsed = () => new PinStore(file, { now: () => clock }).entries()[0].lastUsedAt;
      assert.equal(lastUsed(), clock);
      // Ten days at a time, three times: longer than the TTL in all, but never idle for it.
      for (let step = 1; step <= 3; step += 1) {
        clock += 10 * DAY;
        await waitUntil(() => lastUsed() === clock, `the live link did not renew its pairing (step ${step})`);
        assert.equal(pins.expire(clock, 14 * DAY).length, 0, "so the sweep forgets nothing");
      }
      await settle(80);
      assert.equal(link.trustedConnected, true);
      assert.equal(server.seen.closes, 0, "never dropped");
    } finally {
      stop();
      server.close();
    }
  });
});

test("connected_phone_never_expires (wshub)", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    let clock = Date.now();
    const phoneId = await phoneCert("phone");
    const pins = new PinStore(file, { now: () => clock });
    pins.add(phoneId.fingerprint256, clock);
    const { hub, agent } = await newHub({ pins, now: () => clock, keepaliveIntervalMs: 10, trustCheckIntervalMs: 20 });
    const phone = await connectPhone(hub, agent, { cert: phoneId });
    const lastUsed = () => new PinStore(file, { now: () => clock }).entries()[0].lastUsedAt;
    assert.equal(lastUsed(), clock);
    for (let step = 1; step <= 3; step += 1) {
      clock += 10 * DAY;
      await waitUntil(() => lastUsed() === clock, `the live link did not renew its pairing (step ${step})`);
      assert.equal(pins.expire(clock, 14 * DAY).length, 0, "so the sweep forgets nothing");
    }
    await settle(80);
    assert.equal(hub.hasTrustedClient, true);
    assert.equal(phone.closes, 0, "never dropped");
    assert.equal(phone.frames.some((f) => f.type === "link_trust"), false);
  });
});

test("a_link_is_not_touched_on_every_tick", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const clock = Date.now();
    let writes = 0;
    const pins = new PinStore(file, {
      now: () => clock,
      writeFile: (target, content) => {
        writes += 1;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      },
    });
    pins.add(phoneId.fingerprint256, clock);
    const { link, stop } = newLink(pins, { now: () => clock, pingIntervalMs: 5 });
    try {
      dialTls(link, server);
      await waitUntil(() => link.trustedConnected, "link never became trusted");
      await settle(100); // twenty pings
      assert.equal(writes, 1, "only the pin itself was written; no touch inside the hour");
    } finally {
      stop();
      server.close();
    }
  });
});

test("expired_phone_reconnecting_before_sweep_is_refused (phonelink)", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const phoneId = await phoneCert("phone");
    const server = await listenAsPhone(phoneId);
    const now = Date.now();
    let writes = 0;
    const pins = new PinStore(file, {
      writeFile: (target, content) => {
        writes += 1;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      },
    });
    pins.add(phoneId.fingerprint256, now - 15 * DAY);
    pins.add((await phoneCert("fresh")).fingerprint256, now);
    const writesBefore = writes;
    const { link, logs, stop } = newLink(pins, { now: () => now });
    try {
      // 15 days idle, and no sweep has run: the phone dials in.
      dialTls(link, server);
      await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "the stale phone was admitted");
      await settle(40);
      assert.equal(link.connected, false);
      assert.deepEqual(server.seen.lines, [], "refused before hello: no token went to it");
      assert.equal(pins.has(phoneId.fingerprint256), false, "the entry is removed");
      assert.equal(new PinStore(file).has(phoneId.fingerprint256), false, "on disk");
      assert.equal(writes, writesBefore + 1, "one write, the removal; it was never touched");
      assert.equal(pins.entries().length, 1, "the fresh phone stays");
    } finally {
      stop();
      server.close();
    }
  });
});

test("expired_phone_reconnecting_before_sweep_is_refused (wshub)", async () => {
  await withTempDir(async (dir) => {
    const file = pinsFileOf(dir);
    const phoneId = await phoneCert("phone");
    const now = Date.now();
    let writes = 0;
    const pins = new PinStore(file, {
      writeFile: (target, content) => {
        writes += 1;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      },
    });
    pins.add(phoneId.fingerprint256, now - 15 * DAY);
    pins.add((await phoneCert("fresh")).fingerprint256, now);
    const writesBefore = writes;
    const { hub, agent, logs } = await newHub({ pins, now: () => now });
    const { reject, code } = await refusedHello(hub, agent, { cert: phoneId });
    assert.deepEqual(reject, REPAIR_NEEDED);
    assert.equal(code, 4403);
    assert.deepEqual(
      logs.entries.find((e) => e.event === "ws_auth_rejected").meta,
      { reason: "unpinned_cert", fingerprint: short(phoneId.fingerprint256) },
    );
    assert.equal(hub.hasTrustedClient, false);
    assert.equal(new PinStore(file).has(phoneId.fingerprint256), false, "the entry is removed");
    assert.equal(writes, writesBefore + 1, "one write, the removal; it was never touched");
    assert.equal(pins.entries().length, 1, "the fresh phone stays");
  });
});

test("a_phone_that_expired_can_pair_again_through_the_window", async () => {
  await withTempDir(async (dir) => {
    const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
    const { ProvisionalPins } = require("../dist/pairing/provisional-pins.js");
    const { wssSasPhone } = require("./helpers/sas-phone.js");
    const file = pinsFileOf(dir);
    const phoneId = await phoneCert("phone");
    const now = Date.now();
    const pins = new PinStore(file);
    pins.add(phoneId.fingerprint256, now - 20 * DAY);
    const logs = loggerHarness();
    const pairing = new PairingCoordinator({ config, pins, provisional: new ProvisionalPins(), logger: logs.logger, steer: () => STEER, wsHost: () => "127.0.0.1" });
    track(() => pairing.dispose());
    const { hub, agent } = await newHub({ pins, pairing, now: () => now });
    // The expired phone's own hello is refused (and forgets it on the spot); it pairs again by SAS.
    assert.deepEqual((await refusedHello(hub, agent, { cert: phoneId })).reject, REPAIR_NEEDED);
    assert.equal(pins.has(phoneId.fingerprint256), false);
    pairing.openWindow();
    const phone = await wssSasPhone({ port: hub.port(), cert: phoneId });
    track(() => phone.close());
    await phone.waitFor(() => phone.state.code !== undefined, "no code");
    await waitUntil(() => pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
    pairing.confirm(pairing.status().attempt, true);
    phone.confirm(true);
    await waitUntil(() => new PinStore(file).has(phoneId.fingerprint256), "not pinned again");
    const [entry] = new PinStore(file).entries();
    assert.ok(entry.addedAt >= now, "pinned afresh, as new");
  });
});

test("phones_list_shows_last_used_and_sign_out_in", async () => {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, "nexus-agentd");
    const coderDir = path.join(dir, "rokid-coder");
    const { ensureConfig, saveConfig } = require("../dist/config.js");
    saveConfig({ ...ensureConfig(stateDir), rokidCoder: { stateDir: coderDir } }, stateDir);
    const a = (await phoneCert("a")).fingerprint256;
    const b = (await phoneCert("b")).fingerprint256;
    const c = (await phoneCert("c")).fingerprint256;
    const now = Date.now();
    const file = pinsFileOf(coderDir);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      version: 3,
      everPinned: true,
      allowNextUntil: 0,
      phones: [
        { fp: a, addedAt: now - 40 * DAY, lastUsedAt: now - 3 * DAY - HOUR },
        { fp: b, addedAt: now - 40 * DAY, lastUsedAt: now - 1 * DAY - HOUR },
        { fp: c, addedAt: now - 40 * DAY, lastUsedAt: now - 20 * DAY },
      ],
    }));
    let { stdout } = await runCli(coderDir, ["phones", "list"]);
    assert.deepEqual(stdout.trim().split("\n"), [
      `${a}  last used 3 days ago · signs out in 11 days`,
      `${b}  last used 1 day ago · signs out in 13 days`,
      `${c}  last used 20 days ago · signs out in 0 days`,
    ]);
    // The phone's synced setting is what it counts down to.
    await fsp.writeFile(path.join(coderDir, "settings.json"), JSON.stringify({ version: 1, pairingTtlDays: 30 }));
    ({ stdout } = await runCli(coderDir, ["phones", "list"]));
    assert.ok(stdout.includes(`${a}  last used 3 days ago · signs out in 27 days`), stdout);
  });
});

test("daemon_expires_stale_pairings_at_startup", async () => {
  const stale = "CD".repeat(32);
  await withDaemon(
    {
      transport: "wshub",
      coderFiles: {
        "tls/phone-pins.json": {
          version: 3,
          everPinned: true,
          allowNextUntil: 0,
          phones: [{ fp: stale.match(/../g).join(":"), addedAt: 1, lastUsedAt: Date.now() - 20 * DAY }],
        },
      },
    },
    async ({ phone, pins }) => {
      assert.deepEqual(pins.list(), [phone.fingerprint], "only the phone that is connected is left");
    },
  );
});
