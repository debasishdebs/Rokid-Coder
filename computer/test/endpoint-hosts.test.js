// The hosts a phone may dial agentd on: LAN first, this computer's Tailscale
// address last, so a phone paired at home still connects away from home.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { advertisedEndpoint, writeAdvertise } = require("../dist/advertise.js");
const {
  TailnetHostCache,
  ensureTailnet,
  lanThenTailnet,
  parseTailnetIpv4,
  startTailnetHostRefresh,
  tailnetHostFor,
} = require("../dist/endpoint-hosts.js");
const { bestHostGuess, pairingPayload } = require("../dist/pairing.js");
const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
const { endpointFrame } = require("../dist/protocol-v2.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore } = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");
const { wssSasPhone } = require("./helpers/sas-phone.js");

const TOKEN = "endpoint-token-never-logged";
const STEER = "endpoint-steering-secret-never-logged-0123456789";
const logger = { info() {}, warn() {}, error() {} };
const TAILNET = "100.78.52.6";

const cleanups = [];
const track = (close) => cleanups.push(close);
test.afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => close()));
});

function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-endpoint-")));
  track(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const config = (extra = {}) => ({
  token: TOKEN,
  wsPort: 8792,
  httpPort: 0,
  machineId: "machine-ep",
  machineName: "ep-mac",
  phoneHosts: [],
  tailnetDiscovery: false,
  rokidCoder: { stateDir: "/nonexistent-never-written" },
  ...extra,
});

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/** A Tailscale CLI that answers from a script, one entry per call: a string is stdout, "missing" is ENOENT, an Error fails. */
function probeOf(answers, clock) {
  const calls = [];
  const answer = (binary, timeoutMs) => {
    calls.push({ binary, timeoutMs });
    const next = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (clock && typeof next === "object" && next.spend) clock.t += next.spend;
    if (next === "missing") return { missing: true };
    if (next instanceof Error) throw next;
    if (typeof next === "object") return { missing: false };
    return { missing: false, stdout: next };
  };
  return { calls, runSync: answer, runAsync: async (b, t) => answer(b, t) };
}

// ---------------------------------------------------------------- assembly

test("tailnet_address_is_100_64_slash_10_only", () => {
  assert.equal(parseTailnetIpv4(`${TAILNET}\n`), TAILNET);
  assert.equal(parseTailnetIpv4("100.64.0.1"), "100.64.0.1");
  assert.equal(parseTailnetIpv4("100.127.255.254"), "100.127.255.254");
  for (const bad of ["100.63.255.255", "100.128.0.1", "10.0.0.5", "192.168.68.104", "fd7a:115c:a1e0::1", "", "not an address", "100.78.52"]) {
    assert.equal(parseTailnetIpv4(bad), undefined, bad);
  }
  assert.equal(parseTailnetIpv4(undefined), undefined);
  // Noise lines around the address do not hide it.
  assert.equal(parseTailnetIpv4(`warning\n${TAILNET}\nfd7a:115c:a1e0::6\n`), TAILNET);
});

test("hosts_are_lan_first_tailnet_last_deduped_and_capped", () => {
  assert.deepEqual(lanThenTailnet(["192.168.68.104"], TAILNET), ["192.168.68.104", TAILNET]);
  // No Tailscale: exactly today's single host.
  assert.deepEqual(lanThenTailnet(["192.168.68.104"], undefined), ["192.168.68.104"]);
  // A guess that is already the tailnet address is not listed twice and still goes last.
  assert.deepEqual(lanThenTailnet(["192.168.68.104", TAILNET], TAILNET), ["192.168.68.104", TAILNET]);
  assert.deepEqual(lanThenTailnet([TAILNET], undefined), [TAILNET]);
  assert.deepEqual(lanThenTailnet(["10.0.0.2", "10.0.0.2", "10.0.0.3"], undefined), ["10.0.0.2", "10.0.0.3"]);
  // At most four, and the cap never costs the tailnet address its place.
  const many = ["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4", "10.0.0.5"];
  assert.deepEqual(lanThenTailnet(many, TAILNET), ["10.0.0.1", "10.0.0.2", "10.0.0.3", TAILNET]);
  assert.deepEqual(lanThenTailnet(many, undefined), many.slice(0, 4));
});

test("wsl_record_keeps_its_order_and_gains_the_tailnet_address", () => {
  // Windows put Tailscale first already: untouched, so old phones dial what they did.
  assert.deepEqual(ensureTailnet([TAILNET, "192.168.1.40"], TAILNET), [TAILNET, "192.168.1.40"]);
  assert.deepEqual(ensureTailnet([TAILNET, "192.168.1.40"], undefined), [TAILNET, "192.168.1.40"]);
  // A record without one gets it appended; hosts[0] stays.
  assert.deepEqual(ensureTailnet(["192.168.1.40"], TAILNET), ["192.168.1.40", TAILNET]);
  assert.deepEqual(ensureTailnet(["192.168.1.40"], undefined), ["192.168.1.40"]);
  assert.deepEqual(
    ensureTailnet(["10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.4"], TAILNET),
    ["10.0.0.1", "10.0.0.2", "10.0.0.3", TAILNET],
  );
});

test("the_lan_guess_beats_a_tailnet_interface_whatever_it_is_called", () => {
  const nic = (address, internal = false) => [{ family: "IPv4", address, internal }];
  // macOS names the tailnet interface utunN, and it can enumerate first.
  assert.equal(bestHostGuess({ utun4: nic(TAILNET), en0: nic("192.168.68.104"), lo0: nic("127.0.0.1", true) }), "192.168.68.104");
  assert.equal(bestHostGuess({ tailscale0: nic(TAILNET), eth0: nic("10.0.0.5") }), "10.0.0.5");
  // Only a tailnet interface: it is the host, as before.
  assert.equal(bestHostGuess({ tailscale0: nic(TAILNET) }), TAILNET);
  assert.equal(bestHostGuess({}), "PASTE-YOUR-TAILNET-IP");
});

// ---------------------------------------------------------------- discovery

test("no_tailscale_or_a_failing_cli_means_no_tailnet_host_and_never_throws", () => {
  for (const answers of [["missing"], [new Error("boom")], [""], ["garbage\n"], [{}]]) {
    const cache = new TailnetHostCache({ probe: probeOf(answers), candidates: () => ["tailscale", "/app/Tailscale"] });
    assert.equal(cache.get(), undefined);
  }
  // A candidate list that itself throws is the same.
  assert.equal(new TailnetHostCache({ probe: probeOf(["x"]), candidates: () => { throw new Error("nope"); } }).get(), undefined);
});

test("next_candidate_is_tried_when_the_first_has_no_answer", () => {
  const probe = probeOf(["missing", `${TAILNET}\n`]);
  const cache = new TailnetHostCache({ probe, candidates: () => ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"] });
  assert.equal(cache.get(), TAILNET);
  assert.deepEqual(probe.calls.map((c) => c.binary), ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
});

test("answers_are_cached_for_30_seconds_and_so_are_absences", () => {
  const clock = { t: 1_000_000 };
  const probe = probeOf([`${TAILNET}\n`]);
  const cache = new TailnetHostCache({ probe, candidates: () => ["tailscale"], now: () => clock.t });
  assert.equal(cache.get(), TAILNET);
  clock.t += 29_000;
  assert.equal(cache.get(), TAILNET);
  assert.equal(probe.calls.length, 1, "no second run inside the TTL");
  clock.t += 2_000;
  cache.get();
  assert.equal(probe.calls.length, 2, "asked again after the TTL");

  const absent = probeOf(["missing"]);
  const none = new TailnetHostCache({ probe: absent, candidates: () => ["tailscale"], now: () => clock.t });
  none.get();
  none.get();
  assert.equal(absent.calls.length, 1, "an absent Tailscale is not asked again inside the TTL");
});

test("a_slow_cli_cannot_hold_the_pairing_path_past_its_budget", () => {
  const clock = { t: 0 };
  // Each candidate burns the whole budget it is given.
  const probe = probeOf([{ spend: 2_000 }], clock);
  const cache = new TailnetHostCache({ probe, candidates: () => ["a", "b", "c"], now: () => clock.t, budgetMs: 2_000 });
  assert.equal(cache.get(), undefined);
  assert.equal(probe.calls.length, 1, "the budget is spent: later candidates are not tried");
  assert.ok(probe.calls[0].timeoutMs <= 2_000, "the run is bounded by the budget");
});

test("refresh_primes_the_cache_so_the_sync_path_never_runs_the_cli", async () => {
  const probe = probeOf([`${TAILNET}\n`]);
  const cache = new TailnetHostCache({ probe, candidates: () => ["tailscale"] });
  assert.equal(await cache.refresh(), TAILNET);
  assert.equal(cache.get(), TAILNET);
  assert.equal(probe.calls.length, 1);
  // The refresh does not throw either.
  const bad = new TailnetHostCache({ probe: { runSync: () => ({ missing: true }), runAsync: async () => { throw new Error("x"); } }, candidates: () => ["t"] });
  assert.equal(await bad.refresh(), undefined);
});

test("tailnet_discovery_off_never_runs_the_cli", () => {
  let asked = 0;
  const cache = { get: () => { asked++; return TAILNET; }, refresh: async () => { asked++; } };
  assert.equal(tailnetHostFor({ tailnetDiscovery: false }, cache), undefined);
  assert.equal(startTailnetHostRefresh({ tailnetDiscovery: false }, 10, cache)(), undefined);
  assert.equal(asked, 0);
  assert.equal(tailnetHostFor({ tailnetDiscovery: true }, cache), TAILNET);
});

// ---------------------------------------------------------------- advertised endpoint

test("advertised_endpoint_lists_lan_then_tailnet", () => {
  const cfg = config();
  assert.deepEqual(advertisedEndpoint(cfg, () => "192.168.68.104", () => TAILNET), { hosts: ["192.168.68.104", TAILNET], port: 8792 });
  // Without Tailscale: the single host it always was.
  assert.deepEqual(advertisedEndpoint(cfg, () => "192.168.68.104", () => undefined), { hosts: ["192.168.68.104"], port: 8792 });
  assert.deepEqual(advertisedEndpoint(cfg, () => "192.168.68.104"), { hosts: ["192.168.68.104"], port: 8792 }, "discovery off: no CLI");
});

test("nat_record_endpoint_keeps_hosts_first_and_gains_a_tailnet_host", () => {
  const stateDir = tempDir();
  writeAdvertise(stateDir, ["192.168.1.40"], 8794);
  const cfg = config({ rokidCoder: { stateDir } });
  assert.deepEqual(advertisedEndpoint(cfg, () => "172.28.1.5", () => TAILNET), { hosts: ["192.168.1.40", TAILNET], port: 8794 });
  writeAdvertise(stateDir, [TAILNET, "192.168.1.40"], 8794);
  assert.deepEqual(advertisedEndpoint(cfg, () => "172.28.1.5", () => TAILNET), { hosts: [TAILNET, "192.168.1.40"], port: 8794 });
});

// ---------------------------------------------------------------- the pairing line and pair_credentials

test("pairing_line_carries_host_and_hosts_and_an_old_phone_still_parses_it", () => {
  const stateDir = tempDir();
  writeAdvertise(stateDir, ["192.168.1.40", TAILNET], 8794);
  const fp = "AB:".repeat(31) + "AB";
  const text = pairingPayload(config({ rokidCoder: { stateDir } }), fp);
  const line = JSON.parse(text);
  assert.equal(line.host, "192.168.1.40", "old phones dial the first host");
  assert.deepEqual(line.hosts, ["192.168.1.40", TAILNET]);
  assert.equal(line.port, 8794);
  assert.equal(line.v, 2);
  assert.equal(line.kind, "rokid-coder");
  assert.equal(line.fp, fp);
  // An old phone reads only host/port/fp and ignores the rest.
  const { host, port, fp: seen, kind, v, ...rest } = line;
  assert.deepEqual({ host, port, seen, kind, v }, { host: "192.168.1.40", port: 8794, seen: fp, kind: "rokid-coder", v: 2 });
  assert.deepEqual(Object.keys(rest), ["hosts"]);
});

test("pairing_line_without_tailscale_has_one_host_in_both_fields", () => {
  const line = JSON.parse(pairingPayload(config({ wsPort: 8792 }), "AA:BB"));
  assert.deepEqual(line.hosts, [line.host]);
});

test("pair_credentials_carry_wsHost_and_wsHosts", async () => {
  const cfg = config({ wsPort: 0 });
  const pins = new PinStore();
  const pairing = new PairingCoordinator({ config: cfg, pins, logger, steer: () => STEER, wsHost: () => "192.168.68.104", tailnetHost: () => TAILNET });
  track(() => pairing.dispose());
  const agent = await agentCert();
  const store = new SessionStore(cfg, logger);
  const hub = new WsHub(cfg, store, logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, pins, pairing, helloTimeoutMs: 500 });
  await hub.start();
  track(async () => { await hub.stop(); store.dispose(); });
  pairing.openWindow();
  assert.equal(pairing.pairReady().host, "192.168.68.104", "pair-ready keeps its single host");
  const phone = await wssSasPhone({ port: hub.port(), cert: await phoneCert("endpoint-phone"), options: { storage: "silent" } });
  track(() => phone.close());
  await phone.waitFor(() => phone.state.code !== undefined, "no code on the phone");
  await waitUntil(() => pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  pairing.confirm(pairing.status().attempt, true);
  phone.confirm(true);
  const credentials = await phone.waitForFrame("pair_credentials");
  assert.equal(credentials.wsHost, "192.168.68.104", "old phones store the first host");
  assert.deepEqual(credentials.wsHosts, ["192.168.68.104", TAILNET]);
  assert.equal(credentials.wsPort, 0);
});

// ---------------------------------------------------------------- the endpoint frame

async function hubWith(options) {
  const cfg = config({ wsPort: 0 });
  const agent = await agentCert();
  const store = new SessionStore(cfg, logger);
  const pins = new PinStore();
  pins.add((await phoneCert("phone")).fingerprint256);
  const hub = new WsHub(cfg, store, logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, pins, ...options });
  await hub.start();
  track(async () => { await hub.stop(); store.dispose(); });
  return { hub, agent };
}

async function connect(hub, agent) {
  const phone = createFakePhone({ transport: "wshub", pin: agent.fingerprint256, steer: STEER });
  await phone.start({ port: hub.port(), token: TOKEN });
  track(() => phone.close());
  await phone.waitFor("hello_ack");
  return phone;
}

test("endpoint_frame_follows_the_snapshot_after_hello", async () => {
  const { hub, agent } = await hubWith({ endpoint: () => ({ hosts: ["192.168.68.104", TAILNET], port: 8792 }) });
  const phone = await connect(hub, agent);
  const frame = await phone.waitFor("endpoint");
  assert.deepEqual(frame, { type: "endpoint", v: 2, hosts: ["192.168.68.104", TAILNET], port: 8792 });
  assert.deepEqual(frame, endpointFrame({ hosts: ["192.168.68.104", TAILNET], port: 8792 }));
  const order = phone.frames.map((f) => f.type);
  assert.ok(order.indexOf("hello_ack") < order.indexOf("endpoint"), "after hello_ack");
  // The frame carries nothing secret.
  const text = JSON.stringify(frame);
  assert.equal(text.includes(TOKEN) || text.includes(STEER), false);
});

test("endpoint_frame_is_resent_when_the_hosts_change_and_not_otherwise", async () => {
  let hosts = ["192.168.68.104"];
  const { hub, agent } = await hubWith({ endpoint: () => ({ hosts, port: 8792 }), endpointCheckIntervalMs: 20 });
  const phone = await connect(hub, agent);
  await phone.waitFor("endpoint");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(phone.frames.filter((f) => f.type === "endpoint").length, 1, "an unchanged list is not repeated");
  hosts = ["192.168.68.104", TAILNET];
  await waitUntil(() => phone.frames.filter((f) => f.type === "endpoint").length === 2, "the new list never arrived");
  assert.deepEqual(phone.frames.filter((f) => f.type === "endpoint")[1].hosts, ["192.168.68.104", TAILNET]);
});

test("no_endpoint_frame_without_an_endpoint_source", async () => {
  const bare = await hubWith({});
  const phone = await connect(bare.hub, bare.agent);
  await phone.waitFor("snapshot");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(phone.frames.some((f) => f.type === "endpoint"), false, "a hub with no endpoint source sends none");
});

test("a_failing_endpoint_source_costs_a_hint_never_the_link", async () => {
  const { hub, agent } = await hubWith({ endpoint: () => { throw new Error("no interfaces"); } });
  const phone = await connect(hub, agent);
  await phone.waitFor("snapshot");
  assert.equal(phone.frames.some((f) => f.type === "endpoint"), false);
  assert.equal(hub.hasAuthenticatedClient, true);
});
