// The advertised endpoint (6b T8, 6b-R3): in WSL's NAT mode the phone must dial the
// Windows host's port proxy (8794), not the WSL VM. One persisted record,
// <stateDir>/advertise.json, is read by every pairing client and by the daemon.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  advertisedEndpoint,
  readAdvertise,
  writeAdvertise,
  refreshAdvertise,
  HOST_IPV4_SCRIPT,
} = require("../dist/advertise.js");
const { pairingPayload } = require("../dist/pairing.js");
const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
const { SessionStore } = require("../dist/session-store.js");
const { WsHub } = require("../dist/ws-server.js");
const { PinStore } = require("../dist/tls.js");
const { ensureConfig, saveConfig } = require("../dist/config.js");
const { freePort } = require("./helpers/daemon.js");
const { agentCert, phoneCert } = require("./helpers/tls.js");
const { wssSasPhone } = require("./helpers/sas-phone.js");

const STEER = "advertise-test-steering-secret-0123456789";
const cleanups = [];
const track = (close) => {
  cleanups.push(close);
  return close;
};
test.afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => close()));
});

function tempDir(prefix = "rokid-advertise-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  track(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function configFor(stateDir, wsPort = 8792) {
  return {
    token: "advertise-token-never-logged",
    wsPort,
    httpPort: 0,
    machineId: "machine-adv",
    machineName: "win-pc",
    phoneHosts: [],
    tailnetDiscovery: false,
    rokidCoder: { stateDir },
  };
}

const logger = { info() {}, warn() {}, error() {} };

async function waitUntil(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

/** A fake interop powershell.exe: prints `ips.txt`, and records its argv. */
function fakePowershell(dir) {
  const file = path.join(dir, "powershell.exe");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(path.join(dir, "ps-argv.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, "ips.txt"))}, "utf8"));
`,
    { mode: 0o755 },
  );
  return {
    file,
    ips: (lines) => fs.writeFileSync(path.join(dir, "ips.txt"), `${lines.join("\r\n")}\r\n`),
    argv: () => fs.readFileSync(path.join(dir, "ps-argv.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)),
  };
}

test("advertised_endpoint_is_windows_host_in_nat_mode", () => {
  const stateDir = tempDir();
  writeAdvertise(stateDir, ["192.168.1.40", "100.101.102.103"], 8794, new Date("2026-11-15T10:00:00Z"));
  const file = path.join(stateDir, "advertise.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    mode: "nat",
    hosts: ["192.168.1.40", "100.101.102.103"],
    port: 8794,
    updatedAt: "2026-11-15T10:00:00.000Z",
  });
  assert.deepEqual(advertisedEndpoint(configFor(stateDir), () => "172.28.1.5"), { hosts: ["192.168.1.40", "100.101.102.103"], port: 8794 });
  assert.throws(() => writeAdvertise(stateDir, ["not-an-ip"], 8794), /IPv4/);
  assert.throws(() => writeAdvertise(stateDir, [], 8794), /at least one/);
});

test("advertised_endpoint_defaults_unchanged_elsewhere", () => {
  const stateDir = tempDir();
  // No file (macOS, or WSL in mirrored mode): today's guess and the config's port.
  assert.deepEqual(advertisedEndpoint(configFor(stateDir, 8792), () => "10.0.0.7"), { hosts: ["10.0.0.7"], port: 8792 });
  // A damaged file is the same as none: the default, never a crash.
  fs.writeFileSync(path.join(stateDir, "advertise.json"), "{nope");
  assert.equal(readAdvertise(stateDir), undefined);
  assert.deepEqual(advertisedEndpoint(configFor(stateDir, 9000), () => "10.0.0.7"), { hosts: ["10.0.0.7"], port: 9000 });
});

test("qr_and_pair_ready_use_advertised_endpoint", () => {
  const stateDir = tempDir();
  writeAdvertise(stateDir, ["192.168.1.40"], 8794);
  const config = configFor(stateDir);
  const payload = JSON.parse(pairingPayload(config, "AA:BB"));
  assert.equal(payload.host, "192.168.1.40");
  assert.equal(payload.port, 8794);
  const pairing = new PairingCoordinator({ config, pins: new PinStore(), logger, steer: () => STEER, wsHost: () => "172.28.1.5" });
  track(() => pairing.dispose());
  pairing.openWindow();
  const ready = pairing.pairReady();
  assert.equal(ready.host, "192.168.1.40");
  assert.equal(ready.wsPort, 8794);
  // Back to mirrored: the file goes, and the guess is advertised again.
  fs.rmSync(path.join(stateDir, "advertise.json"));
  assert.equal(pairing.pairReady().host, "172.28.1.5");
  assert.equal(pairing.pairReady().wsPort, 8792);
});

test("pair_from_another_terminal_uses_persisted_endpoint", async () => {
  const root = tempDir("rokid-advertise-cli-");
  const coderDir = path.join(root, "rokid-coder");
  const stateDir = path.join(root, "nexus-agentd");
  const httpPort = await freePort();
  saveConfig({ ...ensureConfig(stateDir), httpPort, rokidCoder: { stateDir: coderDir } }, stateDir);
  writeAdvertise(coderDir, ["192.168.1.40"], 8794);
  // A fresh terminal: nothing inherited, no ROKID_* or NEXUS_* endpoint variables.
  const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "cli.js"), "pair"], {
    env: { HOME: root, PATH: "/usr/bin:/bin", NEXUS_AGENTD_STATE_DIR: stateDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  track(() => child.kill("SIGKILL"));
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await waitUntil(() => out.includes("\n"), `pair printed nothing: ${out}`, 10000);
  const payload = JSON.parse(out.split("\n")[0]);
  assert.equal(payload.host, "192.168.1.40");
  assert.equal(payload.port, 8794);
});

test("pair_credentials_carry_advertised_endpoint", async () => {
  const stateDir = tempDir();
  writeAdvertise(stateDir, ["192.168.1.40"], 8794);
  const config = { ...configFor(stateDir, 0) };
  const pins = new PinStore();
  const pairing = new PairingCoordinator({ config, pins, logger, steer: () => STEER, wsHost: () => "172.28.1.5" });
  track(() => pairing.dispose());
  const agent = await agentCert();
  const store = new SessionStore(config, logger);
  const hub = new WsHub(config, store, logger, { host: "127.0.0.1", tls: agent, steer: () => STEER, pins, pairing, helloTimeoutMs: 500 });
  await hub.start();
  track(async () => {
    await hub.stop();
    store.dispose();
  });
  pairing.openWindow();
  const phone = await wssSasPhone({ port: hub.port(), cert: await phoneCert("advertise-phone"), options: { storage: "silent" } });
  track(() => phone.close());
  await phone.waitFor(() => phone.state.code !== undefined, "no code on the phone");
  await waitUntil(() => pairing.status()?.state === "AWAITING_CONFIRM", "no code on agentd");
  pairing.confirm(pairing.status().attempt, true);
  phone.confirm(true);
  const credentials = await phone.waitForFrame("pair_credentials");
  assert.equal(credentials.wsHost, "192.168.1.40", "the phone stores the Windows host");
  assert.equal(credentials.wsPort, 8794, "and the port proxy");
});

test("nat_refresh_rewrites_advertise_when_host_ips_change", async () => {
  const stateDir = tempDir();
  const fake = fakePowershell(tempDir("rokid-advertise-ps-"));
  const config = configFor(stateDir);
  // Mirrored (no record): the refresh does nothing and runs nothing.
  fake.ips(["192.168.1.40"]);
  assert.equal(await refreshAdvertise(config, { powershell: fake.file, wsl: true }), "skipped");
  assert.equal(fs.existsSync(path.join(stateDir, "advertise.json")), false);

  writeAdvertise(stateDir, ["192.168.1.40"], 8794, new Date("2026-11-15T10:00:00Z"));
  fake.ips(["192.168.1.40"]);
  assert.equal(await refreshAdvertise(config, { powershell: fake.file, wsl: true }), "unchanged");
  assert.equal(readAdvertise(stateDir).updatedAt, "2026-11-15T10:00:00.000Z", "an unchanged set is not rewritten");

  // The laptop moved to another Wi-Fi: noise lines and link-local addresses are ignored.
  fake.ips(["WARNING: something", "10.5.0.12", "169.254.3.4", "127.0.0.1", "100.101.102.103"]);
  assert.equal(await refreshAdvertise(config, { powershell: fake.file, wsl: true, now: () => new Date("2026-11-15T11:00:00Z") }), "rewritten");
  assert.deepEqual(readAdvertise(stateDir), { mode: "nat", hosts: ["10.5.0.12", "100.101.102.103"], port: 8794, updatedAt: "2026-11-15T11:00:00.000Z" });

  // The interop call is argv only: a fixed script, never a string built from data.
  for (const argv of fake.argv()) {
    assert.deepEqual(argv, ["-NoProfile", "-NonInteractive", "-Command", HOST_IPV4_SCRIPT]);
  }
  // Interop that answers nothing usable keeps the last good record.
  fake.ips(["garbage"]);
  assert.equal(await refreshAdvertise(config, { powershell: fake.file, wsl: true }), "unchanged");
  assert.deepEqual(readAdvertise(stateDir).hosts, ["10.5.0.12", "100.101.102.103"]);
  // Outside WSL nothing runs, whatever the file says.
  assert.equal(await refreshAdvertise(config, { powershell: fake.file, wsl: false }), "skipped");
});

test("rokid_setup_advertise_set_show_and_clear", () => {
  const root = tempDir("rokid-advertise-setup-");
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const main = path.join(__dirname, "..", "dist", "setup", "main.js");
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const run = (...args) => spawnSync(process.execPath, [main, "advertise", ...args], { env, encoding: "utf8" });
  const set = run("set", "--hosts", "192.168.1.40,100.101.102.103", "--port", "8794");
  assert.equal(set.status, 0, set.stderr);
  const stateDir = path.join(home, ".rokid-coder");
  assert.deepEqual(readAdvertise(stateDir).hosts, ["192.168.1.40", "100.101.102.103"]);
  const show = run("show");
  assert.equal(show.status, 0, show.stderr);
  assert.deepEqual(JSON.parse(show.stdout).hosts, ["192.168.1.40", "100.101.102.103"]);
  assert.notEqual(run("set", "--hosts", "192.168.1.40;rm -rf /", "--port", "8794").status, 0);
  assert.notEqual(run("set", "--hosts", "192.168.1.40", "--port", "99999").status, 0);
  assert.equal(run("clear").status, 0);
  assert.equal(fs.existsSync(path.join(stateDir, "advertise.json")), false);
  assert.equal(JSON.parse(run("show").stdout).mode, "default");
});
