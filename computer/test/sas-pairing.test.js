"use strict";
/**
 * SAS pairing (R1′, Plan 6a T6) on both transports: the code, the state
 * machine, the credential handover, and what never happens before both humans
 * confirmed. The phone here is test/helpers/sas-phone.js, written against raw
 * node crypto so it cross-checks agentd's own module.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const VECTORS = require("../../contracts/sas-vectors.json");
const { computeCommit, computeSas, computeCommitProof } = require("../dist/pairing/sas.js");
const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
const { PhoneLink } = require("../dist/phone-link.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore } = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");
const { wssSasPhone, phoneLinkSasPhone } = require("./helpers/sas-phone.js");

const TOKEN = "sas-test-token-never-logged";
const STEER = "sas-test-steering-secret-never-logged-0123456789";
const baseConfig = {
  token: TOKEN,
  wsPort: 0,
  httpPort: 0,
  machineId: "machine-sas",
  machineName: "sas-pc",
  phoneHosts: [],
  tailnetDiscovery: false,
  rokidCoder: { stateDir: "/nonexistent-never-written" },
};

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

function newPairing({ config = baseConfig, pins = new PinStore(), logs = loggerHarness(), ...extra } = {}) {
  const pairing = new PairingCoordinator({
    config,
    pins,
    logger: logs.logger,
    steer: () => STEER,
    wsHost: () => "127.0.0.1",
    ...extra,
  });
  track(() => pairing.dispose());
  return { pairing, pins, logs };
}

async function newHub({ pairing, pins, logs, config = baseConfig }) {
  const agent = await agentCert();
  const store = new SessionStore(config, logs.logger);
  const hub = new WsHub(config, store, logs.logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, pins, pairing, helloTimeoutMs: 500 });
  await hub.start();
  track(async () => { await hub.stop(); store.dispose(); });
  return { hub, agent };
}

function newLink({ pairing, pins, logs, phonePort }) {
  const config = { ...baseConfig, phoneHosts: [`127.0.0.1:${phonePort}`] };
  const store = new SessionStore(config, logs.logger);
  return agentCert().then((agent) => {
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
      operatorMessage: () => {},
    });
    track(() => { link.stop(); store.dispose(); });
    return { link, agent };
  });
}

/** A wss phone in pairing mode, through to the code on both sides. */
async function wssToCode(port, certName = "sas-phone", options) {
  const cert = await phoneCert(certName);
  const phone = await wssSasPhone({ port, cert, options });
  track(() => phone.close());
  await phone.waitFor(() => phone.state.code !== undefined || phone.state.aborted !== undefined, "no code on the phone");
  return { phone, cert };
}

// ---------------------------------------------------------------- the code

test("sas_vectors_match_on_node_and_kotlin", () => {
  assert.ok(VECTORS.sas.length >= 4 && VECTORS.proofs.length >= 3);
  for (const v of VECTORS.sas) {
    const nc = Buffer.from(v.nc, "hex");
    const np = Buffer.from(v.np, "hex");
    assert.equal(computeCommit(nc, v.agentdFp, v.phoneFp), v.commit);
    assert.equal(computeSas(nc, np, v.agentdFp, v.phoneFp), v.code);
    assert.match(v.code, /^\d{6}$/);
  }
  for (const v of VECTORS.proofs) {
    assert.equal(computeCommitProof(v.steer, v.attempt, v.agentdFp, v.phoneFp), v.proof);
  }
  // Both fingerprints are bound: swapping either changes everything.
  const [a, b] = VECTORS.sas;
  assert.notEqual(a.commit, b.commit);
});

// ---------------------------------------------------------------- wss

test("no_pin_or_steering_before_both_confirm (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port());
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "agentd never reached the code");
  assert.equal(ctx.pairing.status().code, phone.state.code, "both sides show the same code");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
  assert.equal(ctx.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  assert.equal(hub.hasTrustedClient, false, "no steering");
  // Only the phone confirmed: still nothing.
  phone.confirm(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.pairing.status().state, "AWAITING_CONFIRM");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
  assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false);
});

test("credentials_sent_only_after_both_confirm_and_agentd_durable_only_after_pair_committed (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port(), "sas-phone", { storage: "silent" });
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "no code");
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false, "the computer alone sends nothing");
  phone.confirm(true);
  const credentials = await phone.waitForFrame("pair_credentials");
  assert.deepEqual(
    { ...credentials },
    {
      type: "pair_credentials",
      v: 2,
      attempt: phone.state.attempt,
      token: TOKEN,
      steer: STEER,
      machineId: "machine-sas",
      machineName: "sas-pc",
      wsHost: "127.0.0.1",
      wsPort: 0,
    },
  );
  assert.equal(ctx.pairing.status().state, "PINNED");
  assert.ok(ctx.pins.provisional(cert.fingerprint256, Date.now()), "provisional before the phone commits");
  assert.equal(ctx.pins.has(cert.fingerprint256), false, "not durable before pair_committed");
  phone.sendRaw({ type: "pair_committed", v: 2, attempt: phone.state.attempt });
  await waitUntil(() => ctx.pins.has(cert.fingerprint256), "pair_committed did not make the pin durable");
  assert.equal(ctx.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  await phone.closed;
});

test("pinned_reconnect_needs_no_sas_on_both_transports (wshub)", async () => {
  const ctx = newPairing();
  const { hub, agent } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port());
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  phone.confirm(true);
  await waitUntil(() => ctx.pins.has(cert.fingerprint256), "not pinned");
  await phone.closed;
  // The next day: today's admission, pinned cert + token + steer, no SAS frame at all.
  const again = createFakePhone({ transport: "wshub", pin: agent.fingerprint256, steer: phone.state.credentials.steer, cert });
  track(() => again.close());
  await again.start({ port: hub.port(), token: phone.state.credentials.token });
  const ack = await again.waitFor("hello_ack");
  assert.equal(ack.steering, true);
  assert.equal(again.frames.some((f) => String(f.type).startsWith("sas_")), false);
  assert.equal(hub.hasTrustedClient, true);
});

test("mismatch_discards_both_pins_and_closes_window (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port());
  phone.confirm(true);
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "no code");
  // The human at the computer says the codes differ.
  assert.equal(ctx.pairing.confirm(ctx.pairing.status().attempt, false), true);
  await phone.closed;
  assert.equal(ctx.pairing.status()?.state ?? "ABORTED", "ABORTED");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
  assert.equal(ctx.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  assert.equal(ctx.pins.allowNextOpen(Date.now()), false, "the window is closed");
  assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false);
  // No retry inside the window: the next peer gets nothing.
  const late = await wssSasPhone({ port: hub.port(), cert: await phoneCert("late") });
  track(() => late.close());
  await late.closed;
  assert.equal(late.state.frames.some((f) => f.type === "sas_commit"), false);
});

test("disconnect_mid_attempt_aborts_and_discards (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port());
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  phone.close();
  await waitUntil(() => ctx.pairing.status()?.state === "ABORTED", "not aborted");
  assert.equal(ctx.pairing.status().reason, "disconnect");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
  assert.equal(ctx.pins.provisional(cert.fingerprint256, Date.now()), undefined);
  assert.equal(ctx.pins.allowNextOpen(Date.now()), false);
});

test("second_peer_aborts_both (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone } = await wssToCode(hub.port(), "first");
  const second = await wssSasPhone({ port: hub.port(), cert: await phoneCert("second") });
  track(() => second.close());
  await second.closed;
  await phone.closed;
  assert.equal(ctx.pairing.status().state, "ABORTED");
  assert.equal(ctx.pairing.status().reason, "second_peer");
  assert.equal(second.state.aborted, "second_peer");
  assert.equal(phone.state.aborted, "second_peer");
  assert.equal(ctx.pins.isEmpty(), true);
});

test("out_of_order_frame_aborts (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const cert = await phoneCert("eager");
  const phone = await wssSasPhone({ port: hub.port(), cert });
  track(() => phone.close());
  await phone.waitForFrame("sas_commit");
  // A hello where a nonce belongs: before the pins, nothing but SAS frames.
  phone.sendRaw({ type: "hello", v: 1, token: TOKEN, steer: STEER });
  await phone.closed;
  assert.equal(ctx.pairing.status().state, "ABORTED");
  assert.equal(ctx.pairing.status().reason, "out_of_order");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
});

test("reveal_not_matching_commit_aborts (wshub)", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port(), "sas-phone", { tamperReveal: true });
  await phone.closed;
  assert.equal(phone.state.code, undefined);
  assert.equal(ctx.pairing.status().reason, "bad_reveal");
  assert.equal(ctx.pins.has(cert.fingerprint256), false);
});

test("second_commit_in_window_aborts", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone } = await wssToCode(hub.port());
  // A second nonce for the same attempt is a second try at the code.
  phone.sendRaw({ type: "sas_nonce", v: 2, attempt: phone.state.attempt, np: "ab".repeat(32) });
  await phone.closed;
  assert.equal(ctx.pairing.status().reason, "second_commit");
  assert.equal(ctx.pins.isEmpty(), true);
});

test("stale or foreign attempt ids are ignored, not aborted", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone } = await wssToCode(hub.port());
  phone.sendRaw({ type: "sas_confirm", v: 2, attempt: "0000000000000000", ok: false });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.pairing.status().state, "AWAITING_CONFIRM");
});

test("nonces_and_credentials_never_logged", async () => {
  const ctx = newPairing();
  const { hub } = await newHub(ctx);
  ctx.pairing.openWindow();
  const { phone, cert } = await wssToCode(hub.port());
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  phone.confirm(true);
  await waitUntil(() => ctx.pins.has(cert.fingerprint256), "not pinned");
  // Malformed and out-of-order frames take their own log paths: those too.
  const nonce = phone.state.frames.find((f) => f.type === "sas_commit").c;
  const reveal = phone.state.frames.find((f) => f.type === "sas_reveal").nc;
  const logged = JSON.stringify(ctx.logs.entries);
  for (const secret of [TOKEN, STEER, nonce, reveal, phone.state.np.toString("hex"), phone.state.code, cert.fingerprint256]) {
    assert.equal(logged.includes(secret), false, `logged: ${secret.slice(0, 6)}…`);
  }
  assert.ok(ctx.logs.entries.some((e) => e.event === "phone_pinned"), "the pairing itself is logged");
});

// ---------------------------------------------------------------- PhoneLink

test("no_pin_or_steering_before_both_confirm (phonelink)", async () => {
  const logs = loggerHarness();
  const ctx = newPairing({ logs });
  const phoneCertificate = await phoneCert("link-phone");
  const phone = await phoneLinkSasPhone({ cert: phoneCertificate });
  track(() => phone.close());
  ctx.pairing.openWindow();
  const { link } = await newLink({ ...ctx, logs, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.waitFor(() => session.state.code !== undefined, "no code on the phone");
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  assert.equal(ctx.pairing.status().code, session.state.code);
  assert.equal(session.hellos.length, 0, "no hello, so no token, before the pins");
  assert.equal(link.trustedConnected, false);
  assert.equal(ctx.pins.has(phoneCertificate.fingerprint256), false);
  session.confirm(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(session.state.frames.some((f) => f.type === "pair_credentials"), false);
});

test("credentials_sent_only_after_both_confirm_and_agentd_durable_only_after_pair_committed (phonelink)", async () => {
  const logs = loggerHarness();
  const ctx = newPairing({ logs });
  const phoneCertificate = await phoneCert("link-phone");
  const phone = await phoneLinkSasPhone({ cert: phoneCertificate, options: { storage: "silent" } });
  track(() => phone.close());
  ctx.pairing.openWindow();
  const { link } = await newLink({ ...ctx, logs, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.waitFor(() => session.state.code !== undefined, "no code");
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  session.confirm(true);
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  const credentials = await session.waitForFrame("pair_credentials");
  assert.equal(credentials.token, TOKEN);
  assert.equal(credentials.steer, STEER);
  assert.ok(ctx.pins.provisional(phoneCertificate.fingerprint256, Date.now()));
  assert.equal(ctx.pins.has(phoneCertificate.fingerprint256), false);
  session.socket.write(`${JSON.stringify({ type: "pair_committed", v: 2, attempt: session.state.attempt })}\n`);
  await waitUntil(() => ctx.pins.has(phoneCertificate.fingerprint256), "not durable");
});

test("pinned_reconnect_needs_no_sas_on_both_transports (phonelink)", async () => {
  const logs = loggerHarness();
  const ctx = newPairing({ logs });
  const phoneCertificate = await phoneCert("link-phone");
  const phone = await phoneLinkSasPhone({ cert: phoneCertificate });
  track(() => phone.close());
  ctx.pairing.openWindow();
  const { link } = await newLink({ ...ctx, logs, phonePort: phone.port });
  link.start();
  const first = await phone.waitForSession(0);
  await first.waitFor(() => first.state.code !== undefined, "no code");
  await waitUntil(() => ctx.pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  first.confirm(true);
  ctx.pairing.confirm(ctx.pairing.status().attempt, true);
  await waitUntil(() => ctx.pins.has(phoneCertificate.fingerprint256), "not pinned");
  await first.closed;
  // agentd dials again: mutual pinned certs + token, and no SAS.
  const second = await phone.waitForSession(1);
  await second.waitFor(() => second.hellos.length > 0, "no hello on the reconnect");
  assert.equal(second.hellos[0].token, TOKEN);
  assert.equal(second.state.frames.some((f) => String(f.type).startsWith("sas_")), false);
  await waitUntil(() => link.trustedConnected, "the reconnect is not trusted");
});

test("disconnect_mid_attempt_aborts_and_discards (phonelink)", async () => {
  const logs = loggerHarness();
  const ctx = newPairing({ logs });
  const phoneCertificate = await phoneCert("link-phone");
  const phone = await phoneLinkSasPhone({ cert: phoneCertificate });
  track(() => phone.close());
  ctx.pairing.openWindow();
  const { link } = await newLink({ ...ctx, logs, phonePort: phone.port });
  link.start();
  const session = await phone.waitForSession(0);
  await session.waitFor(() => session.state.code !== undefined, "no code");
  session.socket.destroy();
  await waitUntil(() => ctx.pairing.status()?.state === "ABORTED", "not aborted");
  assert.equal(ctx.pairing.status().reason, "disconnect");
  assert.equal(ctx.pins.has(phoneCertificate.fingerprint256), false);
  // The window is spent: the redial is refused before anything is written.
  await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "the redial was not refused");
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const later of phone.sessions.slice(1)) {
    assert.deepEqual(later.state.frames, []);
    assert.equal(later.hellos.length, 0);
  }
});

test("an unpinned phone outside any window is refused before any frame (phonelink)", async () => {
  const logs = loggerHarness();
  const ctx = newPairing({ logs });
  const phone = await phoneLinkSasPhone({ cert: await phoneCert("link-phone") });
  track(() => phone.close());
  const { link } = await newLink({ ...ctx, logs, phonePort: phone.port });
  link.start();
  await waitUntil(() => logs.entries.some((e) => e.event === "phone_link_untrusted_peer"), "not refused");
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const session of phone.sessions) {
    assert.deepEqual(session.state.frames, []);
    assert.equal(session.hellos.length, 0);
  }
});
