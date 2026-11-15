"use strict";
/**
 * Every computer-side pairing entry point (FR 2) against a real daemon: the
 * launcher-socket IPC (`pair_status` / `pair_confirm`), `agentd pair`,
 * `/rokid:pair`, the v2 pairing line, the pair-ready announcement and
 * `pair --rotate-steer`. The trust boundary (6a-R1): a confirmation on the
 * computer, from anything that can reach the socket, never pins on its own.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { pairingPayload } = require("../dist/pairing.js");
const { PairingCoordinator } = require("../dist/pairing/coordinator.js");
const { PAIR_TEXT } = require("../dist/attach-command.js");
const { PinStore } = require("../dist/tls.js");
const { createFakePhone } = require("./fake-phone.js");
const { withDaemon, settle } = require("./helpers/daemon.js");
const { phoneCert } = require("./helpers/tls.js");
const { wssSasPhone } = require("./helpers/sas-phone.js");

const cleanups = [];
const track = (close) => { cleanups.push(close); return close; };
test.afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).reverse().map(async (close) => close()));
});

const pinsOf = (coderDir) => new PinStore(path.join(coderDir, "tls", "phone-pins.json"));

async function waitUntil(predicate, message, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** A launcher-socket pairing client, as `agentd pair` and the installer are: frames in, frames out. */
function pairClient(coderDir) {
  const socket = net.createConnection(path.join(coderDir, "launcher.sock"));
  const statuses = [];
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const frame = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (frame.type === "pair_status") statuses.push(frame);
    }
  });
  socket.on("error", () => {});
  track(() => socket.destroy());
  return {
    statuses,
    send: (frame) => socket.write(`${JSON.stringify(frame)}\n`),
    last: () => statuses[statuses.length - 1],
    waitForState: (state) => waitUntil(() => statuses.some((s) => s.state === state), `no pair_status ${state}`).then(
      () => statuses.find((s) => s.state === state),
    ),
  };
}

async function sasPhone(wsPort, name) {
  const phone = await wssSasPhone({ port: wsPort, cert: await phoneCert(name) });
  track(() => phone.close());
  await phone.waitFor(() => phone.state.code !== undefined || phone.state.aborted !== undefined, "no code on the phone");
  return phone;
}

function runCli(coderDir, args) {
  const root = path.dirname(coderDir);
  const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "cli.js"), ...args], {
    env: { ...process.env, HOME: root, NEXUS_AGENTD_STATE_DIR: path.join(root, "nexus-agentd") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  track(() => child.kill("SIGKILL"));
  const run = { out: "", child };
  child.stdout.on("data", (chunk) => (run.out += chunk));
  child.stderr.on("data", (chunk) => (run.out += chunk));
  run.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  run.until = (text, timeoutMs = 5000) => waitUntil(() => run.out.includes(text), `CLI never said: ${text}\n${run.out}`, timeoutMs);
  return run;
}

function runForwarder(payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "dist", "hook-forward.js")], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.once("error", reject);
    child.once("exit", () => resolve(stdout ? JSON.parse(stdout) : undefined));
    child.stdin.end(JSON.stringify(payload));
  });
}

// ---------------------------------------------------------------- the trust boundary

test("direct_socket_confirm_without_phone_confirm_never_pins", async () => {
  await withDaemon({ transport: "wshub" }, async ({ wsPort, coderDir }) => {
    const client = pairClient(coderDir);
    client.send({ type: "pair_open" });
    await client.waitForState("WINDOW_OPEN");
    const phone = await sasPhone(wsPort, "boundary-phone");
    const awaiting = await client.waitForState("AWAITING_CONFIRM");
    assert.equal(awaiting.code, phone.state.code, "every client is shown the phone's code");
    // A same-user process, a model-launched one included, confirms on the computer. That is all.
    client.send({ type: "pair_confirm", attempt: awaiting.attempt, ok: true });
    client.send({ type: "pair_confirm", attempt: awaiting.attempt, ok: true });
    await settle(200);
    assert.equal(pinsOf(coderDir).has((await phoneCert("boundary-phone")).fingerprint256), false);
    assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false);
    assert.equal(client.last().state, "AWAITING_CONFIRM");
  });
});

test("stale_confirm_from_aborted_attempt_rejected", async () => {
  await withDaemon({ transport: "wshub" }, async ({ wsPort, coderDir }) => {
    const client = pairClient(coderDir);
    client.send({ type: "pair_open" });
    const first = await sasPhone(wsPort, "stale-1");
    const old = await client.waitForState("AWAITING_CONFIRM");
    first.close();
    await waitUntil(() => client.last().state === "ABORTED", "first attempt not aborted");
    // A new window, a new attempt; the old id confirms nothing.
    client.send({ type: "pair_open" });
    await waitUntil(() => client.last().state === "WINDOW_OPEN" && client.last().attempt !== old.attempt, "no new window");
    const second = await sasPhone(wsPort, "stale-2");
    await waitUntil(() => client.last().state === "AWAITING_CONFIRM", "no second code");
    const current = client.last();
    second.confirm(true);
    client.send({ type: "pair_confirm", attempt: old.attempt, ok: true });
    await settle(200);
    assert.equal(client.last().state, "AWAITING_CONFIRM", "a stale confirm is ignored");
    client.send({ type: "pair_confirm", attempt: current.attempt, ok: true });
    await client.waitForState("PINNED");
    await waitUntil(() => pinsOf(coderDir).list().length === 2, "the current attempt did not pin");
  });
});

test("rokid_pair_in_session_never_confirms_and_points_to_terminal", async () => {
  await withDaemon({ transport: "wshub" }, async ({ httpPort, wsPort, coderDir }) => {
    const env = { ROKID_CODER_PROVIDER: "claude", NEXUS_AGENTD_HTTP_PORT: String(httpPort), ROKID_RK_CONFIG_DIR: "" };
    const reply = await runForwarder(
      { hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: "rokid:pair", session_id: "p1", cwd: "/w" },
      env,
    );
    assert.deepEqual(reply, { decision: "block", reason: PAIR_TEXT });
    assert.equal(
      PAIR_TEXT,
      "Compare the 6-digit code on your phone with the one in a terminal (run agentd pair) — confirm on the phone",
    );
    assert.equal(pinsOf(coderDir).allowNextOpen(Date.now()), true, "the window is open");
    // The phone confirms; nothing in the session can be the other half.
    const phone = await sasPhone(wsPort, "session-phone");
    phone.confirm(true);
    await settle(300);
    assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false);
    assert.equal(pinsOf(coderDir).list().length, 1, "only the phone paired earlier");
    for (const secret of [phone.state.code]) {
      assert.equal(JSON.stringify(reply).includes(secret), false, "the reply never carries the code");
    }
  });
});

// ---------------------------------------------------------------- agentd pair

test("agentd_pair_shows_the_code_and_confirms_on_y", async () => {
  await withDaemon({ transport: "wshub" }, async ({ wsPort, coderDir, token, steer }) => {
    const run = runCli(coderDir, ["pair"]);
    await run.until("Pairing window open");
    const line = JSON.parse(run.out.split("\n").find((l) => l.startsWith("{")));
    assert.deepEqual(Object.keys(line).sort(), ["fp", "host", "kind", "port", "v"]);
    assert.equal(run.out.includes(token), false);
    assert.equal(run.out.includes(steer), false);
    const phone = await sasPhone(wsPort, "cli-phone");
    await run.until(phone.state.code);
    await run.until("[y/N]");
    phone.confirm(true);
    run.child.stdin.write("y\n");
    await run.until("Paired ✓");
    assert.equal(await run.exited, 0);
    await waitUntil(async () => pinsOf(coderDir).has((await phoneCert("cli-phone")).fingerprint256), "not pinned");
  });
});

test("agentd_pair_answered_n_aborts_as_mismatch", async () => {
  await withDaemon({ transport: "wshub" }, async ({ wsPort, coderDir }) => {
    const run = runCli(coderDir, ["pair"]);
    await run.until("Pairing window open");
    const phone = await sasPhone(wsPort, "cli-no-phone");
    await run.until("[y/N]");
    run.child.stdin.write("\n");
    await phone.closed;
    assert.equal(phone.state.frames.some((f) => f.type === "pair_credentials"), false);
    assert.notEqual(await run.exited, 0);
    assert.equal(pinsOf(coderDir).has((await phoneCert("cli-no-phone")).fingerprint256), false);
  });
});

test("qr_v2_has_no_secrets_and_still_requires_sas", async () => {
  const fp = "AB:".repeat(31) + "AB";
  const line = JSON.parse(pairingPayload({ machineName: "pc", wsPort: 8792, token: "TOKEN-X" }, fp));
  assert.deepEqual(Object.keys(line).sort(), ["fp", "host", "kind", "port", "v"]);
  assert.equal(line.v, 2);
  assert.equal(line.kind, "rokid-coder");
  assert.equal(JSON.stringify(line).includes("TOKEN-X"), false);
  await withDaemon({ transport: "wshub" }, async ({ wsPort, coderDir, agentFingerprint }) => {
    const client = pairClient(coderDir);
    client.send({ type: "pair_open" });
    await client.waitForState("WINDOW_OPEN");
    // A phone that read the line: the cert matches its fp, and still the first thing is a commitment.
    const phone = await wssSasPhone({ port: wsPort, cert: await phoneCert("qr-phone") });
    track(() => phone.close());
    assert.equal(phone.state.agentdFp, agentFingerprint);
    const first = await phone.waitForFrame("sas_commit");
    assert.equal(phone.state.frames[0], first);
    assert.equal(pinsOf(coderDir).has((await phoneCert("qr-phone")).fingerprint256), false);
  });
});

test("pair_ready_announcement_carries_no_secrets_and_stops_once_a_peer_arrives", () => {
  const logs = [];
  const logger = { info: (e, m) => logs.push([e, m]), warn: (e, m) => logs.push([e, m]), error: (e, m) => logs.push([e, m]) };
  const config = { token: "TOKEN-Y", wsPort: 8792, machineId: "m", machineName: "desk" };
  const pins = new PinStore();
  const pairing = new PairingCoordinator({ config, pins, logger, steer: () => "STEER-Y", wsHost: () => "10.0.0.2" });
  track(() => pairing.dispose());
  assert.equal(pairing.pairReady(), undefined, "nothing while no window is open");
  const opened = pairing.openWindow();
  const ready = pairing.pairReady();
  assert.deepEqual(ready, { nexus: "agentd-pair-ready", v: 1, machineName: "desk", host: "10.0.0.2", wsPort: 8792, attempt: opened.attempt });
  assert.match(ready.attempt, /^[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(ready).includes("TOKEN-Y"), false);
  assert.equal(JSON.stringify(ready).includes("STEER-Y"), false);
  pairing.beginSession({ transport: "wshub", agentdFp: "CD".repeat(32), phoneFp: "EF".repeat(32), send: () => {}, close: () => {} });
  assert.equal(pairing.pairReady(), undefined, "one attempt per window: the announcement stops");
});

// ---------------------------------------------------------------- rotation

test("rotate_steer_requires_new_sas_pairing", async () => {
  await withDaemon({ transport: "wshub" }, async ({ phone, wsPort, coderDir, token, steer, agentFingerprint }) => {
    const closes = phone.closes;
    const run = runCli(coderDir, ["pair", "--rotate-steer"]);
    await run.until("Pairing window open");
    run.child.stdin.end();
    await run.exited;
    await phone.waitForClose(closes, 3000);
    assert.equal(pinsOf(coderDir).isEmpty(), true, "rotation forgets every phone pin");
    const fresh = (await fsp.readFile(path.join(coderDir, "tls", "steer.secret"), "utf8")).trim();
    assert.notEqual(fresh, steer);
    // Even with the new secret, the old cert is no longer pinned: only a new SAS pairing brings it back.
    const back = createFakePhone({ transport: "wshub", pin: agentFingerprint, steer: fresh, cert: await phoneCert("phone") });
    track(() => back.close());
    await back.start({ port: wsPort, token });
    assert.equal((await back.waitFor("hello_reject")).reason, "repair_needed");
    const client = pairClient(coderDir);
    client.send({ type: "pair_open" });
    const again = await sasPhone(wsPort, "phone");
    const awaiting = await client.waitForState("AWAITING_CONFIRM");
    again.confirm(true);
    client.send({ type: "pair_confirm", attempt: awaiting.attempt, ok: true });
    await waitUntil(async () => pinsOf(coderDir).has((await phoneCert("phone")).fingerprint256), "re-pairing failed");
    assert.equal(again.state.credentials.steer, fresh, "the phone is handed the new secret");
  });
});

test("phones_forget_also_drops_a_provisional_pin", async () => {
  await withDaemon({ transport: "wshub" }, async ({ coderDir }) => {
    const fp = (await phoneCert("half-phone")).fingerprint256;
    pinsOf(coderDir).addProvisional(fp, "0123456789abcdef", Date.now());
    const run = runCli(coderDir, ["phones", "forget", fp.slice(0, 23)]);
    assert.equal(await run.exited, 0, run.out);
    assert.deepEqual(pinsOf(coderDir).provisionalEntries(), []);
  });
});
