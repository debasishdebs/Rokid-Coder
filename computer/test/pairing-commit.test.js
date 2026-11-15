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
const { ProvisionalPins, PROVISIONAL_PIN_MS } = require("../dist/pairing/provisional-pins.js");
const { computeCommitProof } = require("../dist/pairing/sas.js");
const { PhoneLink } = require("../dist/phone-link.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore } = require("../dist/tls.js");
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
    provisional: new ProvisionalPins(path.join(dir, "phone-pins-provisional.json")),
  };
}

function coordinator({ pins, provisional, logs = loggerHarness(), now, steer = () => STEER }) {
  const pairing = new PairingCoordinator({ config: baseConfig, pins, provisional, logger: logs.logger, steer, wsHost: () => "127.0.0.1", now });
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
  await waitUntil(() => s.provisional.get(cert.fingerprint256, Date.now()) === undefined, "provisional pin kept");
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
  assert.ok(s.provisional.get(cert.fingerprint256, Date.now()));
  assert.equal(s.pins.has(cert.fingerprint256), false);
  const { first } = await helloWith(hub, agent, cert, { token: phone.state.credentials.token, steer: phone.state.credentials.steer });
  assert.equal(first.type, "hello_ack");
  assert.equal(first.steering, true);
  assert.equal(s.pins.has(cert.fingerprint256), true, "promoted to durable");
  assert.equal(s.provisional.get(cert.fingerprint256, Date.now()), undefined);
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
  assert.ok(after.provisional.get(cert.fingerprint256, Date.now()), "the provisional pin survived the restart");
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
  s.provisional.add(cert.fingerprint256, "0123456789abcdef", Date.now());
  assert.deepEqual((await helloWith(hub, agent, cert, { steer: "not-the-steering-secret-at-all-000000" })).first, REPAIR_NEEDED);
  assert.equal((await helloWith(hub, agent, cert, { token: "wrong-token" })).first.reason, "bad_token");
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.ok(s.provisional.get(cert.fingerprint256, Date.now()), "a failed hello changes nothing");
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
  s.provisional.add(cert.fingerprint256, "0123456789abcdef", now);
  now += PROVISIONAL_PIN_MS + 1;
  assert.deepEqual(pairing.expire(), [cert.fingerprint256], "the sweep purges it");
  assert.deepEqual(s.provisional.entries(), []);
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
  assert.deepEqual(s.provisional.entries(), []);
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

test("phonelink_recovery_promotes_with_valid_proof_only", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const agent = await agentCert();
  const cert = await phoneCert("proof-phone");
  s.provisional.add(cert.fingerprint256, "fedcba9876543210", Date.now());
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
  assert.equal(s.provisional.get(cert.fingerprint256, Date.now()), undefined);
  await waitUntil(() => link.trustedConnected, "recovered link is not trusted");
});

test("phonelink_wrong_proof_closes_without_hello", async () => {
  const dir = await tempDir();
  const s = stores(dir);
  const pairing = coordinator(s);
  const cert = await phoneCert("bad-proof-phone");
  s.provisional.add(cert.fingerprint256, "fedcba9876543210", Date.now());
  const phone = await phoneLinkSasPhone({ cert, options: { proofSteer: "a-steering-secret-the-phone-never-got-00" } });
  track(() => phone.close());
  const { link } = await linkFor({ ...s, pairing, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.closed;
  assert.equal(session.hellos.length, 0);
  assert.equal(s.pins.has(cert.fingerprint256), false);
  assert.ok(s.provisional.get(cert.fingerprint256, Date.now()), "a wrong proof promotes nothing");
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
  ctx.provisional.forgetAll();
  await waitUntil(() => !ctx.link.trustedConnected, "PhoneLink survived the rotation");
  // PhoneLink checks the pin, not the secret, and the pin is gone.
  await redialRefused(ctx);
});
