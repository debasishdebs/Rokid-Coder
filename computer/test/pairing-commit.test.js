"use strict";
/**
 * The credential handover's two-phase commit (6a-R4′, 6a-R4″) with a fault at
 * every boundary, and one logical pairing per phone on agentd (6a-R3): forget
 * and rotation act on both transports.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
const { computeCommitProof } = require("../dist/pairing/sas.js");
const { PhoneLink } = require("../dist/phone-link.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore, PROVISIONAL_PIN_MS } = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");
const { wssSasPhone, phoneLinkSasPhone } = require("./helpers/sas-phone.js");

const TOKEN = "commit-test-token-never-logged";
const STEER = "commit-test-steering-secret-never-logged-012345";
const baseConfig = {
  token: TOKEN,
  wsPort: 0,
  httpPort: 0,
  machineId: "machine-commit",
  machineName: "commit-pc",
  phoneHosts: [],
  tailnetDiscovery: false,
  rokidCoder: { stateDir: "/nonexistent-never-written" },
};
const REPAIR_NEEDED = { type: "hello_reject", v: 2, reason: "repair_needed" };

const cleanups = [];
const track = (close) => { cleanups.push(close); return close; };
test.afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => close()));
});

function loggerHarness() {
  const entries = [];
  const log = (level) => (event, meta) => entries.push({ level, event, meta });
  return { entries, logger: { info: log("info"), warn: log("warn"), error: log("error") } };
}

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

async function tempDir() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rokid-coder-commit-"));
  track(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** agentd's pairing state on disk, as a daemon (or a restarted one) opens it. */
function stores(dir, now) {
  return {
    pins: new PinStore(path.join(dir, "phone-pins.json"), now ? { now } : {}),
  };
}

function coordinator({ pins, logs = loggerHarness(), now, steer = () => STEER }) {
  const pairing = new PairingCoordinator({ config: baseConfig, pins, logger: logs.logger, steer, wsHost: () => "127.0.0.1", now });
  track(() => pairing.dispose());
  return pairing;
}

async function hubFor({ pins, pairing, logs = loggerHarness(), steer = () => STEER, now }) {
  const agent = await agentCert();
  const store = new SessionStore(baseConfig, logs.logger);
  const hub = new WsHub(baseConfig, store, logs.logger, { host: "127.0.0.1", tls: agent, steer, pins, pairing, now, trustCheckIntervalMs: 20 });
  await hub.start();
  track(async () => { await hub.stop(); store.dispose(); });
  return { hub, agent, logs };
}

async function linkFor({ pins, pairing, phonePort, logs = loggerHarness() }) {
  const agent = await agentCert();
  const config = { ...baseConfig, phoneHosts: [`127.0.0.1:${phonePort}`] };
  const store = new SessionStore(config, logs.logger);
  const link = new PhoneLink({
    config,
    store,
    logger: logs.logger,
    detailProvider: async () => [],
    discoveryPort: 48793,
    pins,
    pairing,
    clientCert: { key: agent.key, cert: agent.cert },
    reconnectDelayMs: 20,
    helloTimeoutMs: 1000,
    trustCheckIntervalMs: 20,
    operatorMessage: () => {},
  });
  track(() => { link.stop(); store.dispose(); });
  return { link, agent, logs };
}

/** Runs a wss pairing to PINNED; the phone stores (or does not) as `options.storage` says. */
async function pairOverWss(hub, pairing, certName, options) {
  pairing.openWindow();
  const cert = await phoneCert(certName);
  const phone = await wssSasPhone({ port: hub.port(), cert, options });
  track(() => phone.close());
  await phone.waitFor(() => phone.state.code !== undefined, "no code");
  await waitUntil(() => pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  pairing.confirm(pairing.status().attempt, true);
  phone.confirm(true);
  await phone.waitForFrame("pair_credentials");
  return { phone, cert };
}

async function helloWith(hub, agent, cert, { token = TOKEN, steer = STEER } = {}) {
  const phone = createFakePhone({ transport: "wshub", pin: agent.fingerprint256, steer, cert });
  track(() => phone.close());
  await phone.start({ port: hub.port(), token });
  const first = await Promise.race([phone.waitFor("hello_ack"), phone.waitFor("hello_reject")]);
  return { phone, first };
}

// ---------------------------------------------------------------- the commit

test("phone_storage_failure_aborts_and_agentd_drops_provisional", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub } = await hubFor({ ...s, pairing });
  const { phone, cert } = await pairOverWss(hub, pairing, "full-phone", { storage: "fail" });
  await phone.closed;
  await waitUntil(() => s.pins.provisional(cert.fingerprint256, Date.now()) === undefined, "provisional pin kept");
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.equal(pairing.status().reason, "storage");
});

test("lost_pair_committed_recovered_by_first_valid_hello", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub, agent } = await hubFor({ ...s, pairing });
  // The phone stored the credentials; its pair_committed never arrived.
  const { phone, cert } = await pairOverWss(hub, pairing, "quiet-phone", { storage: "silent" });
  phone.close();
  assert.ok(s.pins.provisional(cert.fingerprint256, Date.now()));
  assert.equal(s.pins.has(cert.fingerprint256), false);
  const { first } = await helloWith(hub, agent, cert, { token: phone.state.credentials.token, steer: phone.state.credentials.steer });
  assert.equal(first.type, "hello_ack");
  assert.equal(first.steering, true);
  assert.equal(s.pins.has(cert.fingerprint256), true, "promoted to durable");
  assert.equal(s.pins.provisional(cert.fingerprint256, Date.now()), undefined);
});

test("agentd_restart_between_send_and_commit_recovers_via_hello", async () => {
  const dir = await tempDir();
  const before = stores(dir);
  const pairing = coordinator(before);
  const first = await hubFor({ ...before, pairing });
  const { phone, cert } = await pairOverWss(first.hub, pairing, "restart-phone", { storage: "silent" });
  phone.close();
  // agentd goes down between step 1 and step 3, and comes back from disk.
  await first.hub.stop();
  pairing.dispose();
  const after = stores(dir);
  assert.ok(after.pins.provisional(cert.fingerprint256, Date.now()), "the provisional pin survived the restart");
  const restarted = coordinator(after);
  const { hub, agent } = await hubFor({ ...after, pairing: restarted });
  const { first: reply } = await helloWith(hub, agent, cert);
  assert.equal(reply.type, "hello_ack");
  assert.equal(after.pins.has(cert.fingerprint256), true);
});

test("provisional_pin_never_admits_without_token_and_steer", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub, agent } = await hubFor({ ...s, pairing });
  const cert = await phoneCert("provisional-phone");
  s.pins.addProvisional(cert.fingerprint256, "0123456789abcdef", Date.now());
  assert.deepEqual((await helloWith(hub, agent, cert, { steer: "not-the-steering-secret-at-all-000000" })).first, REPAIR_NEEDED);
  assert.equal((await helloWith(hub, agent, cert, { token: "wrong-token" })).first.reason, "bad_token");
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.ok(s.pins.provisional(cert.fingerprint256, Date.now()), "a failed hello changes nothing");
  // PhoneLink: no proof, no hello.
  const phone = await phoneLinkSasPhone({ cert });
  track(() => phone.close());
  const { link } = await linkFor({ ...s, pairing, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.closed;
  assert.equal(session.hellos.length, 0);
  assert.equal(session.state.frames[0]?.type, "pair_commit_query");
  assert.equal(s.pins.has(cert.fingerprint256), false);
});

test("provisional_expiry_purges_and_phone_gets_repair_needed", async () => {
  const dir = await tempDir();
  let now = Date.now();
  const s = stores(dir);
  const pairing = coordinator({ ...s, now: () => now });
  const { hub, agent } = await hubFor({ ...s, pairing });
  const cert = await phoneCert("late-phone");
  s.pins.addProvisional(cert.fingerprint256, "0123456789abcdef", now);
  now += PROVISIONAL_PIN_MS + 1;
  assert.deepEqual(pairing.expire(), [cert.fingerprint256], "the sweep purges it");
  assert.deepEqual(s.pins.provisionalEntries(), []);
  assert.deepEqual((await helloWith(hub, agent, cert)).first, REPAIR_NEEDED);
  assert.equal(s.pins.has(cert.fingerprint256), false);
});

test("phone_crash_before_persist_leaves_no_trust_anywhere", async () => {
  const dir = await tempDir();
  let now = Date.now();
  const s = stores(dir);
  const pairing = coordinator({ ...s, now: () => now });
  const { hub, agent } = await hubFor({ ...s, pairing });
  const { phone, cert } = await pairOverWss(hub, pairing, "crash-phone", { storage: "silent" });
  // The phone dies before it writes anything: it holds no credentials, so it has no way back in.
  phone.close();
  assert.equal(s.pins.has(cert.fingerprint256), false, "agentd trusts it for nothing yet");
  const { first } = await helloWith(hub, agent, cert, { token: "no-token-was-kept", steer: "no-steer-was-kept-000000000000000000" });
  assert.equal(first.type, "hello_reject");
  now += PROVISIONAL_PIN_MS + 1;
  pairing.expire();
  assert.deepEqual(s.pins.provisionalEntries(), []);
  assert.equal(s.pins.isEmpty(), true);
});

test("duplicate_credentials_frame_is_idempotent (pair_committed twice)", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub } = await hubFor({ ...s, pairing });
  const { phone, cert } = await pairOverWss(hub, pairing, "twice-phone", { storage: "silent" });
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
  await waitUntil(() => s.pins.has(cert.fingerprint256), "not durable");
  await phone.closed;
  assert.equal(s.pins.list().length, 1);
});

// ---------------------------------------------------------------- the promotion is bound to its attempt (R207)

/** What a second process (the CLI) sees: the same pins file, opened fresh. */
const cliPins = (dir) => new PinStore(path.join(dir, "phone-pins.json"));

test("late_commit_after_forget_never_restores_trust", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub, agent } = await hubFor({ ...s, pairing });
  const { phone, cert } = await pairOverWss(hub, pairing, "late-forget-phone", { storage: "silent" });
  assert.ok(s.pins.provisional(cert.fingerprint256, Date.now()), "provisional while the commit is in flight");
  // `agentd phones forget` runs before the phone's pair_committed reaches agentd.
  assert.deepEqual(cliPins(dir).forget(cert.fingerprint256.slice(0, 20)), [cert.fingerprint256]);
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
  await phone.closed;
  assert.equal(s.pins.has(cert.fingerprint256), false, "a late commit restored a forgotten pairing");
  assert.equal(s.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  // Nor can the recovery hello bring it back.
  const { first } = await helloWith(hub, agent, cert, { token: phone.state.credentials.token, steer: phone.state.credentials.steer });
  assert.deepEqual(first, REPAIR_NEEDED);
  assert.equal(s.pins.has(cert.fingerprint256), false);
});

test("late_commit_after_rotate_steer_rejected", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  let steer = STEER;
  const pairing = coordinator({ ...s, steer: () => steer });
  const { hub, agent } = await hubFor({ ...s, pairing, steer: () => steer });
  const { phone, cert } = await pairOverWss(hub, pairing, "late-rotate-phone", { storage: "silent" });
  // `agentd pair --rotate-steer`: a new secret, and every pin of either kind forgotten.
  steer = "rotated-steering-secret-the-phone-never-saw-0001";
  cliPins(dir).forgetAll();
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
  await phone.closed;
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.deepEqual(s.pins.provisionalEntries(), []);
  const { first } = await helloWith(hub, agent, cert, { token: phone.state.credentials.token, steer: phone.state.credentials.steer });
  assert.deepEqual(first, REPAIR_NEEDED);
  assert.equal(s.pins.has(cert.fingerprint256), false);
});

test("promotion_is_atomic_single_write", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "phone-pins.json");
  let now = Date.now();
  const writes = [];
  let failNext = false;
  const { writeFileSync } = require("node:fs");
  const pins = new PinStore(file, {
    now: () => now,
    writeFile: (target, content) => {
      if (failNext) {
        failNext = false;
        throw new Error("disk full");
      }
      writes.push(JSON.parse(content));
      writeFileSync(target, content, { mode: 0o600 });
    },
  });
  const cert = await phoneCert("atomic-phone");
  const fp = cert.fingerprint256;
  pins.addProvisional(fp, "0123456789abcdef", now);
  assert.equal(pins.has(fp), false, "a provisional pin is not a pin");
  assert.equal(pins.isTrusted(fp, now, 14 * 86_400_000), false);
  writes.length = 0;

  // Not this attempt's, or not live: nothing moves, nothing is written.
  assert.equal(pins.promote(fp, "fedcba9876543210", now), false);
  assert.equal(writes.length, 0);

  // A write that fails leaves the provisional entry exactly as it was, on disk and in memory.
  failNext = true;
  assert.throws(() => pins.promote(fp, "0123456789abcdef", now));
  assert.equal(pins.has(fp), false);
  assert.ok(pins.provisional(fp, now));
  assert.ok(new PinStore(file).provisional(fp, now));

  // The transition itself: one write, which both removes the provisional entry and adds the durable one.
  assert.equal(pins.promote(fp, "0123456789abcdef", now), true);
  assert.equal(writes.length, 1);
  const [written] = writes;
  assert.equal(written.version, 4);
  assert.deepEqual(written.phones.map((entry) => [entry.fp, entry.state]), [[fp, "durable"]]);
  assert.equal(new PinStore(file).has(fp), true);
  assert.equal(new PinStore(file).provisional(fp, now), undefined);
  // A second promotion of the same attempt is refused: it is no longer provisional.
  assert.equal(pins.promote(fp, "0123456789abcdef", now), false);

  // An expired attempt can never become durable.
  const other = (await phoneCert("expired-phone")).fingerprint256;
  pins.addProvisional(other, "1111111111111111", now);
  now += PROVISIONAL_PIN_MS + 1;
  assert.equal(pins.promote(other, "1111111111111111", now), false);
  assert.equal(pins.has(other), false);
  // There is no second store to fall out of step with.
  await assert.rejects(fsp.stat(path.join(dir, "phone-pins-provisional.json")), { code: "ENOENT" });
});

test("concurrent_forget_and_commit", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const { hub, agent } = await hubFor({ ...s, pairing });

  // The forget and the commit sent together: whichever lands first, the phone ends up forgotten.
  const first = await pairOverWss(hub, pairing, "race-one", { storage: "silent" });
  phone_commit(first.phone);
  cliPins(dir).forget(first.cert.fingerprint256.slice(0, 20));
  await first.phone.closed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(s.pins.has(first.cert.fingerprint256), false);
  assert.equal(s.pins.provisional(first.cert.fingerprint256, Date.now()), undefined);

  // The commit wins outright, then the forget: still forgotten, and the hello is refused.
  const second = await pairOverWss(hub, pairing, "race-two", { storage: "silent" });
  phone_commit(second.phone);
  await waitUntil(() => s.pins.has(second.cert.fingerprint256), "not durable");
  cliPins(dir).forget(second.cert.fingerprint256.slice(0, 20));
  assert.equal(s.pins.has(second.cert.fingerprint256), false);
  const { first: reply } = await helloWith(hub, agent, second.cert, {
    token: second.phone.state.credentials.token,
    steer: second.phone.state.credentials.steer,
  });
  assert.deepEqual(reply, REPAIR_NEEDED);

  // A forget of one phone never touches another phone's attempt.
  const third = await pairOverWss(hub, pairing, "race-three", { storage: "silent" });
  cliPins(dir).forget(second.cert.fingerprint256.slice(0, 20));
  phone_commit(third.phone);
  await waitUntil(() => s.pins.has(third.cert.fingerprint256), "the other phone's commit was lost");
});

function phone_commit(phone) {
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
}

// ---------------------------------------------------------------- the pin writer lock: the hook port (R209)

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { freePort } = require("./helpers/daemon.js");
const { holdHookPort, writePinsDirectly } = require("../dist/pairing/pin-writer.js");
const TLS_JS = path.join(__dirname, "..", "dist", "tls.js");
const PIN_WRITER_JS = path.join(__dirname, "..", "dist", "pairing", "pin-writer.js");

/** A second node process, as the CLI is; `script` sees PinStore, holdHookPort, writePinsDirectly, fs and sleep. */
function secondProcess(script) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs");
       const { PinStore } = require(${JSON.stringify(TLS_JS)});
       const { holdHookPort, writePinsDirectly } = require(${JSON.stringify(PIN_WRITER_JS)});
       const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
       (async () => { ${script} })().catch((error) => { console.error(error); process.exit(1); });`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, output })));
  track(() => child.kill("SIGKILL"));
  return { child, exited };
}

/** Blocks this process, as a paused writer does, until `file` exists. */
function blockUntilExists(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/** A CLI's direct forget of `prefix`, holding the hook port; it records its outcome in `outcome`. */
const directForget = (port, file, prefix, outcome) => secondProcess(`
  try {
    const removed = await writePinsDirectly(${port}, () => new PinStore(${JSON.stringify(file)}).forget(${JSON.stringify(prefix)}));
    fs.writeFileSync(${JSON.stringify(outcome)}, "removed " + removed.length);
  } catch (error) {
    fs.writeFileSync(${JSON.stringify(outcome)}, "refused " + error.message);
  }
`);

test("two_process_forget_during_promotion_never_restores_trust", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "phone-pins.json");
  const port = await freePort();
  const fp = (await phoneCert("two-process-phone")).fingerprint256;
  const prefix = fp.slice(0, 20);
  const attempt = "0123456789abcdef";
  const during = path.join(dir, "forget-during");
  let paused = false;
  const pins = new PinStore(file, {
    afterReload: (operation) => {
      if (operation !== "promote" || paused) return;
      paused = true;
      // Paused after the reload: a CLI's direct forget arrives exactly now, and cannot get the port.
      blockUntilExists(during);
      assert.match(fs.readFileSync(during, "utf8"), /^refused agentd is running or starting/);
    },
  });

  // 1. agentd holds the hook port; the forget arrives between the promotion's read and its write.
  let release = await holdHookPort(port);
  assert.ok(release, "the port was not free");
  pins.addProvisional(fp, attempt);
  const cli = directForget(port, file, prefix, during);
  assert.equal(pins.promote(fp, attempt), true);
  await cli.exited;
  // The forget was refused, out loud, not lost: the pairing is as the promotion left it, and a retry wins.
  assert.equal(new PinStore(file).has(fp), true);
  await release();
  const after = path.join(dir, "forget-after");
  await directForget(port, file, prefix, after).exited;
  assert.equal(fs.readFileSync(after, "utf8"), "removed 1");
  assert.equal(new PinStore(file).has(fp), false);

  // 2. A CLI writes first and holds the port: agentd's promotion, which needs the port, waits for it and then finds nothing.
  pins.addProvisional(fp, attempt);
  const held = path.join(dir, "cli-held");
  const holder = secondProcess(`
    await writePinsDirectly(${port}, () => {
      new PinStore(${JSON.stringify(file)}).forget(${JSON.stringify(prefix)});
      fs.writeFileSync(${JSON.stringify(held)}, "1");
      sleep(400);
    });
  `);
  await waitUntil(() => fs.existsSync(held), "the CLI never took the port");
  assert.equal(await holdHookPort(port), undefined, "the port was free while the CLI wrote");
  await waitUntil(async () => (release = await holdHookPort(port)) !== undefined, "the port was never freed");
  assert.equal(pins.promote(fp, attempt), false);
  await release();
  assert.equal((await holder.exited).code, 0);
  assert.equal(new PinStore(file).has(fp), false);
  assert.deepEqual(new PinStore(file).provisionalEntries(), []);
});

test("crashed_holder_releases_lock_automatically", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "phone-pins.json");
  const port = await freePort();
  const fp = (await phoneCert("crash-holder")).fingerprint256;
  const held = path.join(dir, "held");
  const holder = secondProcess(`
    await holdHookPort(${port});
    fs.writeFileSync(${JSON.stringify(held)}, "1");
    setInterval(() => {}, 1000);
  `);
  await waitUntil(() => fs.existsSync(held), "the holder never took the port");
  await assert.rejects(writePinsDirectly(port, () => new PinStore(file).add(fp)), /127\.0\.0\.1:\d+ is taken/);
  assert.equal(new PinStore(file).has(fp), false);
  // The holder dies mid-write: the kernel frees the port, and there is nothing on disk to recover.
  holder.child.kill("SIGKILL");
  assert.equal((await holder.exited).signal, "SIGKILL");
  const started = Date.now();
  await writePinsDirectly(port, () => new PinStore(file).add(fp));
  assert.ok(Date.now() - started < 1000, "the next writer waited");
  assert.equal(new PinStore(file).has(fp), true);
  assert.equal(fs.existsSync(path.join(dir, "phone-pins.lock")), false);
});

test("legacy_provisional_file_migrates_into_pin_store", async () => {
  const dir = await tempDir();
  const now = Date.now();
  const live = (await phoneCert("legacy-live")).fingerprint256;
  const durable = (await phoneCert("legacy-durable")).fingerprint256;
  const legacy = path.join(dir, "phone-pins-provisional.json");
  const entry = (fp, attempt) => ({ fp, addedAt: now, lastUsedAt: now, state: "provisional", attempt, provisionalUntil: now + 60_000 });
  new PinStore(path.join(dir, "phone-pins.json")).add(durable, now);
  await fsp.writeFile(legacy, JSON.stringify({ version: 4, phones: [entry(live, "0123456789abcdef"), entry(durable, "fedcba9876543210")] }));
  const pins = new PinStore(path.join(dir, "phone-pins.json"));
  assert.equal(pins.provisional(live, now)?.attempt, "0123456789abcdef");
  // A durable pin is never downgraded by a leftover provisional one.
  assert.equal(pins.has(durable), true);
  assert.equal(pins.provisional(durable, now), undefined);
  await assert.rejects(fsp.stat(legacy), { code: "ENOENT" });
});

test("v3_pins_migrate_to_v4_as_durable", async () => {
  const dir = await tempDir();
  const file = path.join(dir, "phone-pins.json");
  const fp = (await phoneCert("v3-phone")).fingerprint256;
  await fsp.writeFile(file, JSON.stringify({ version: 3, everPinned: true, phones: [{ fp, addedAt: 1, lastUsedAt: 2 }], allowNextUntil: 0 }));
  const pins = new PinStore(file, { now: () => 3 });
  assert.equal(pins.isTrusted(fp, 3, 14 * 86_400_000), true);
  const written = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.equal(written.version, 4);
  assert.deepEqual(written.phones, [{ fp, addedAt: 1, lastUsedAt: 2, state: "durable" }]);
});

test("phonelink_recovery_promotes_with_valid_proof_only", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const agent = await agentCert();
  const cert = await phoneCert("proof-phone");
  s.pins.addProvisional(cert.fingerprint256, "fedcba9876543210", Date.now());
  // The phone kept the steering secret it was handed, so it can prove it.
  const phone = await phoneLinkSasPhone({ cert, options: { proofSteer: STEER } });
  track(() => phone.close());
  const { link } = await linkFor({ ...s, pairing, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.waitFor(() => session.hellos.length > 0, "no hello after a valid proof");
  const query = session.state.frames[0];
  assert.deepEqual(query, { type: "pair_commit_query", v: 2, attempt: "fedcba9876543210" });
  assert.equal(
    computeCommitProof(STEER, "fedcba9876543210", agent.fingerprint256, cert.fingerprint256).length,
    64,
  );
  assert.equal(s.pins.has(cert.fingerprint256), true);
  assert.equal(s.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  await waitUntil(() => link.trustedConnected, "recovered link is not trusted");
});

test("phonelink_wrong_proof_closes_without_hello", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const cert = await phoneCert("bad-proof-phone");
  s.pins.addProvisional(cert.fingerprint256, "fedcba9876543210", Date.now());
  const phone = await phoneLinkSasPhone({ cert, options: { proofSteer: "a-steering-secret-the-phone-never-got-00" } });
  track(() => phone.close());
  const { link } = await linkFor({ ...s, pairing, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.closed;
  assert.equal(session.hellos.length, 0);
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.ok(s.pins.provisional(cert.fingerprint256, Date.now()), "a wrong proof promotes nothing");
});

// ---------------------------------------------------------------- one pairing, both transports

/** A phone pinned on agentd and live on both transports at once. */
async function liveOnBoth(dir) {
  const s = stores(dir);
  const pairing = coordinator(s);
  const cert = await phoneCert("both-phone");
  s.pins.add(cert.fingerprint256);
  const { hub, agent } = await hubFor({ ...s, pairing });
  const { phone: wss } = await helloWith(hub, agent, cert);
  await wss.waitFor("snapshot");
  const linkPhone = await phoneLinkSasPhone({ cert });
  track(() => linkPhone.close());
  const linkLogs = loggerHarness();
  const { link } = await linkFor({ ...s, pairing, phonePort: linkPhone.port, logs: linkLogs });
  link.start();
  await waitUntil(() => link.trustedConnected, "PhoneLink not up");
  return { ...s, pairing, cert, hub, agent, wss, link, linkPhone, linkLogs };
}

/** agentd dialled the phone again and refused it before writing anything: no hello, no frame. */
async function redialRefused(ctx) {
  const hellos = ctx.linkPhone.sessions.reduce((count, session) => count + session.hellos.length, 0);
  await waitUntil(() => ctx.linkLogs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "the redial was not refused");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.linkPhone.sessions.reduce((count, session) => count + session.hellos.length, 0), hellos, "no new hello");
}

test("forget_on_agentd_revokes_both_transports", async () => {
  const dir = await tempDir();
  const ctx = await liveOnBoth(dir);
  const closes = ctx.wss.closes;
  ctx.pins.forget(ctx.cert.fingerprint256.slice(0, 20));
  await ctx.wss.waitForClose(closes);
  await waitUntil(() => !ctx.link.trustedConnected, "PhoneLink still trusted");
  assert.equal(ctx.hub.hasTrustedClient, false);
});

test("revoked_pairing_cannot_reconnect_in_either_direction", async () => {
  const dir = await tempDir();
  const ctx = await liveOnBoth(dir);
  ctx.pins.forget(ctx.cert.fingerprint256.slice(0, 20));
  await waitUntil(() => !ctx.link.trustedConnected && !ctx.hub.hasTrustedClient, "still trusted");
  assert.deepEqual((await helloWith(ctx.hub, ctx.agent, ctx.cert)).first, REPAIR_NEEDED);
  // agentd's redial of the forgotten phone writes nothing at all.
  await redialRefused(ctx);
});

test("rotate_steer_forgets_pins_and_blocks_phonelink_too", async () => {
  const dir = await tempDir();
  const ctx = await liveOnBoth(dir);
  // What `agentd pair --rotate-steer` does to the pin stores.
  ctx.pins.forgetAll();
  await waitUntil(() => !ctx.link.trustedConnected, "PhoneLink survived the rotation");
  // PhoneLink checks the pin, not the secret, and the pin is gone.
  await redialRefused(ctx);
});
