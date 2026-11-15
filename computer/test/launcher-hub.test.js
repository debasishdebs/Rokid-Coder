const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { LauncherHub, HELLO_DEADLINE_MS, MAX_FRAME_BYTES } = require("../dist/launcher/launcher-hub.js");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { HookHttpServer } = require("../dist/http-server.js");
const { silentLogger } = require("../dist/logger.js");
const { withTempDir, withDaemon, postHook } = require("./helpers/daemon.js");

const KEY = (id) => `claude:${id}`;

function capturingLogger() {
  const events = [];
  const record = (level) => (event, meta) => events.push({ level, event, meta });
  return { events, logger: { info: record("info"), warn: record("warn"), error: record("error") } };
}

async function until(check, ms = 3000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

function sleeper(t) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  return child;
}

function killAndWait(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  });
}

function sessionFile(dir, pid, sessionId) {
  fs.writeFileSync(
    path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId, status: "idle", statusUpdatedAt: Date.now() }),
  );
}

function connect(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const client = { socket, frames: [], closed: false };
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        client.frames.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
    });
    socket.on("close", () => {
      client.closed = true;
    });
    client.send = (frame) => socket.write(typeof frame === "string" ? frame : `${JSON.stringify(frame)}\n`);
    client.waitFor = (type, predicate = () => true, ms) =>
      until(() => client.frames.find((f) => f.type === type && predicate(f)), ms, type);
    client.waitClosed = (ms) => until(() => client.closed, ms, "close");
    client.close = () => socket.destroy();
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      resolve(client);
    });
    socket.once("error", reject);
  });
}

async function launcher(hub, { launcherId, childPid, provider = "claude" }) {
  const client = await connect(hub.socketPath);
  client.send({ type: "launcher_hello", v: 1, launcherId, provider, childPid });
  return client;
}

async function bind(client, sessionId) {
  const before = client.frames.length;
  client.send({ type: "launcher_bind", sessionId });
  return until(
    () => client.frames.slice(before).find((f) => f.type === "bind_accepted" || f.type === "bind_rejected"),
    3000,
    "bind reply",
  );
}

/**
 * A hub over a fresh config dir (absent, so the hub creates it) with a temp
 * Claude sessions dir. The registry's attached.json lives in the config dir,
 * as it does in the daemon.
 */
async function withHub(body, { logger = silentLogger } = {}) {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "rc");
    const sessionsDir = path.join(dir, "sessions");
    await fsp.mkdir(sessionsDir);
    const file = path.join(configDir, "attached.json");
    const make = () => {
      const registry = new AttachRegistry({ file, logger });
      return { registry, hub: new LauncherHub({ configDir, claudeSessionsDir: sessionsDir, logger, registry }) };
    };
    const first = make();
    await first.hub.start();
    const hubs = [first.hub];
    try {
      await body({
        ...first,
        configDir,
        sessionsDir,
        file,
        restart: async () => {
          await hubs[hubs.length - 1].stop();
          const next = make();
          next.registry.reconcileLaunchers();
          await next.hub.start();
          hubs.push(next.hub);
          return next;
        },
      });
    } finally {
      for (const hub of hubs) await hub.stop();
    }
  });
}

test("bind_accepted_for_owned_session_file", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir, configDir, file }) => {
    assert.equal((fs.statSync(configDir).mode & 0o777), 0o700, "the config dir is created private");
    assert.equal((fs.statSync(hub.socketPath).mode & 0o777), 0o600);
    // The session file belongs to a grandchild of the launcher's pty child.
    const shell = spawn("sh", ["-c", "sleep 30; :"], { stdio: "ignore" });
    t.after(() => shell.kill("SIGKILL"));
    const grandchild = await until(() => {
      const out = spawnSync("pgrep", ["-P", String(shell.pid)], { encoding: "utf8" }).stdout.trim();
      return out ? Number(out.split("\n")[0]) : undefined;
    }, 3000, "grandchild");
    sessionFile(sessionsDir, grandchild, "s1");
    const changes = [];
    hub.onChange((key) => changes.push(key));

    const client = await launcher(hub, { launcherId: "L1", childPid: shell.pid });
    assert.deepEqual(await bind(client, "s1"), { type: "bind_accepted", gen: 1 });
    assert.deepEqual(await client.waitFor("binding_state"), { type: "binding_state", gen: 1, uncertain: false });
    assert.deepEqual(hub.binding(KEY("s1")), {
      key: KEY("s1"),
      launcherId: "L1",
      gen: 1,
      childPid: shell.pid,
      claudePid: grandchild,
      uncertain: false,
    });
    assert.equal(registry.mode("claude", "s1"), "launcher");
    assert.equal(new AttachRegistry({ file }).mode("claude", "s1"), "launcher", "persisted");
    assert.ok(changes.includes(KEY("s1")));

    // The uncertain flag rides on binding_state (Task 4 sets it).
    hub.setUncertain(KEY("s1"), true);
    await client.waitFor("binding_state", (f) => f.uncertain === true);
    assert.equal(hub.binding(KEY("s1")).uncertain, true);

    // The laptop draft is tracked per binding.
    assert.equal(hub.laptopDraft(KEY("s1")), false);
    client.send({ type: "laptop_state", draft: true });
    await until(() => hub.laptopDraft(KEY("s1")), 3000, "draft");

    // Launcher mode exists only with a live binding.
    client.close();
    await until(() => !hub.binding(KEY("s1")), 3000, "unbind");
    assert.equal(registry.mode("claude", "s1"), "plugin");
    assert.equal(hub.laptopDraft(KEY("s1")), false);
  });
});

test("bind_rejected_for_other_sessions_id", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const mine = sleeper(t);
    const theirs = sleeper(t);
    sessionFile(sessionsDir, mine.pid, "mine");
    sessionFile(sessionsDir, theirs.pid, "theirs");
    const client = await launcher(hub, { launcherId: "L1", childPid: mine.pid });
    const reply = await bind(client, "theirs");
    assert.equal(reply.type, "bind_rejected");
    assert.equal(reply.reason, "not_owned");
    assert.equal(hub.binding(KEY("theirs")), undefined);
    assert.equal(hub.binding(KEY("mine")), undefined);
    assert.equal(registry.isAttached("claude", "theirs"), false);
    assert.equal(registry.isAttached("claude", "mine"), false);
    assert.equal(client.closed, false, "a refused bind leaves the connection up");
  });
});

test("bind_rejected_when_file_pid_not_descendant", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const mine = sleeper(t);
    const stranger = sleeper(t);
    // The claimed session's file names a pid outside the launcher's tree.
    sessionFile(sessionsDir, stranger.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: mine.pid });
    const reply = await bind(client, "s1");
    assert.deepEqual(reply, { type: "bind_rejected", reason: "not_owned" });
    assert.equal(hub.binding(KEY("s1")), undefined);
    assert.equal(registry.isAttached("claude", "s1"), false);
  });
});

test("bind_rejected_when_child_not_alive", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    await killAndWait(child);
    const reply = await bind(client, "s1");
    assert.deepEqual(reply, { type: "bind_rejected", reason: "child_exited" });
    assert.equal(registry.isAttached("claude", "s1"), false);
  });
});

test("bind_rejected_when_key_owned_by_another_launcher", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const first = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(first, "s1")).type, "bind_accepted");
    const second = await launcher(hub, { launcherId: "L2", childPid: child.pid });
    assert.deepEqual(await bind(second, "s1"), { type: "bind_rejected", reason: "owned" });
    assert.equal(hub.binding(KEY("s1")).launcherId, "L1");
    assert.equal(hub.binding(KEY("s1")).gen, 1);
    assert.equal(registry.mode("claude", "s1"), "launcher");
  });
});

test("duplicate_launcher_id_refused", async (t) => {
  await withHub(async ({ hub, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const first = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(first, "s1")).type, "bind_accepted");
    const second = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    await second.waitClosed();
    assert.equal(first.closed, false);
    assert.equal(hub.binding(KEY("s1")).launcherId, "L1");
    // A second hello on one connection is refused too.
    const third = await launcher(hub, { launcherId: "L3", childPid: child.pid });
    third.send({ type: "launcher_hello", v: 1, launcherId: "L4", provider: "claude", childPid: child.pid });
    await third.waitClosed();
  });
});

test("codex_launcher_bind_rejected_unsupported", async (t) => {
  await withHub(async ({ hub, registry }) => {
    const child = sleeper(t);
    const client = await launcher(hub, { launcherId: "C1", childPid: child.pid, provider: "codex" });
    assert.deepEqual(await bind(client, "thread-1"), { type: "bind_rejected", reason: "unsupported" });
    assert.equal(registry.isAttached("codex", "thread-1"), false);
    // R133: there is no codex_thread_start frame; it is an unknown type.
    client.send({ type: "codex_thread_start", cwd: "/tmp" });
    await client.waitClosed();
  });
});

test("hello_deadline_5s", async () => {
  assert.equal(HELLO_DEADLINE_MS, 5000);
  await withHub(async ({ hub }) => {
    const silent = await connect(hub.socketPath);
    const started = Date.now();
    await settle(4500);
    assert.equal(silent.closed, false, "still open just before the deadline");
    await silent.waitClosed(2000);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4900 && elapsed < 6500, `closed after ${elapsed} ms`);
    // A frame other than hello first is refused at once.
    const early = await connect(hub.socketPath);
    early.send({ type: "launcher_bind", sessionId: "s1" });
    await early.waitClosed(1000);
  });
});

test("oversize_line_and_bad_json_close_connection", async (t) => {
  assert.equal(MAX_FRAME_BYTES, 64 * 1024);
  await withHub(async ({ hub }) => {
    const child = sleeper(t);
    const hello = { type: "launcher_hello", v: 1, provider: "claude", childPid: child.pid };

    // A line of exactly the limit is accepted (JSON whitespace pads it).
    const exact = await launcher(hub, { ...hello, launcherId: "A" });
    const frame = JSON.stringify({ type: "laptop_state", draft: false });
    const exactLine = `${frame.slice(0, -1)}${" ".repeat(MAX_FRAME_BYTES - frame.length)}}`;
    assert.equal(Buffer.byteLength(exactLine), MAX_FRAME_BYTES);
    exact.send(`${exactLine}\n`);
    await settle(150);
    assert.equal(exact.closed, false, "a line at the limit is fine");
    // One byte more is not.
    exact.send(`${exactLine} \n`);
    await exact.waitClosed();

    // Strict frames: an unknown field closes the connection.
    const extra = await launcher(hub, { ...hello, launcherId: "A2" });
    extra.send({ type: "laptop_state", draft: false, pad: 1 });
    await extra.waitClosed();

    // Over the limit with no newline yet: closed without waiting for the rest.
    const oversize = await launcher(hub, { ...hello, launcherId: "B" });
    await settle(50);
    oversize.send("x".repeat(MAX_FRAME_BYTES + 1));
    await oversize.waitClosed();

    const badJson = await launcher(hub, { ...hello, launcherId: "C" });
    badJson.send("{nope\n");
    await badJson.waitClosed();

    const unknown = await launcher(hub, { ...hello, launcherId: "D" });
    unknown.send({ type: "what" });
    await unknown.waitClosed();

    const badHello = await connect(hub.socketPath);
    badHello.send({ ...hello, launcherId: "E", v: 2 });
    await badHello.waitClosed();

    // A valid connection is unaffected by the others.
    const good = await launcher(hub, { ...hello, launcherId: "F" });
    good.send({ type: "laptop_state", draft: true });
    await settle(150);
    assert.equal(good.closed, false);
  });
});

test("command_result_from_other_connection_ignored", async (t) => {
  await withHub(async ({ hub, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const owner = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(owner, "s1")).type, "bind_accepted");
    const other = await launcher(hub, { launcherId: "L2", childPid: child.pid });

    let settled;
    const result = hub.send(KEY("s1"), { command: "text", text: "hello" }).then((value) => (settled = value));
    const command = await owner.waitFor("type_command");
    assert.equal(command.gen, 1);
    assert.equal(command.command, "text");
    assert.equal(command.text, "hello");
    assert.equal(typeof command.cmdId, "string");

    other.send({ type: "command_result", cmdId: command.cmdId, ok: true });
    owner.send({ type: "command_written", cmdId: command.cmdId, at: Date.now() });
    await settle(150);
    assert.equal(settled, undefined, "another connection's result is ignored");
    assert.equal(other.closed, false);

    owner.send({ type: "command_result", cmdId: command.cmdId, ok: false, error: "busy" });
    await result;
    assert.deepEqual(settled, { ok: false, error: "busy" });

    // Only once: a second result for the same cmdId changes nothing.
    owner.send({ type: "command_result", cmdId: command.cmdId, ok: true });
    await settle(100);
    assert.deepEqual(settled, { ok: false, error: "busy" });
    assert.equal(owner.closed, false);

    // The launcher going away fails what it was given.
    const pending = hub.send(KEY("s1"), { command: "compact" });
    await owner.waitFor("type_command", (f) => f.command === "compact");
    owner.close();
    assert.deepEqual(await pending, { ok: false, error: "exited" });
    assert.deepEqual(await hub.send(KEY("s1"), { command: "compact" }), { ok: false, error: "exited" });
  });
});

test("cancel_sends_cancel_command_and_settles", async (t) => {
  await withHub(async ({ hub, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    await bind(client, "s1");
    const pending = hub.send(KEY("s1"), { command: "model", model: "haiku" });
    const command = await client.waitFor("type_command");
    hub.cancel(KEY("s1"), "taken_over");
    assert.deepEqual(await pending, { ok: false, error: "taken_over" });
    assert.deepEqual(await client.waitFor("cancel_command"), { type: "cancel_command", cmdId: command.cmdId });
  });
});

test("rebind_retires_old_and_cancels_pending", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.deepEqual(await bind(client, "s1"), { type: "bind_accepted", gen: 1 });
    const pending = hub.send(KEY("s1"), { command: "text", text: "hi" });
    const command = await client.waitFor("type_command");

    // /clear: Claude rewrites its own sessions file with the new id.
    sessionFile(sessionsDir, child.pid, "s2");
    assert.deepEqual(await bind(client, "s2"), { type: "bind_accepted", gen: 2 });
    assert.deepEqual(await pending, { ok: false, error: "cancelled" });
    await client.waitFor("cancel_command", (f) => f.cmdId === command.cmdId);
    assert.equal(hub.binding(KEY("s1")), undefined);
    assert.equal(hub.binding(KEY("s2")).gen, 2);
    assert.equal(registry.mode("claude", "s1"), "plugin");
    assert.equal(registry.mode("claude", "s2"), "launcher");

    // A late result for the retired command is ignored.
    client.send({ type: "command_result", cmdId: command.cmdId, ok: true });
    await settle(100);
    assert.equal(client.closed, false);
  });
});

test("refused_rebind_keeps_existing_binding", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    const stranger = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    sessionFile(sessionsDir, stranger.pid, "s2");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.deepEqual(await bind(client, "s1"), { type: "bind_accepted", gen: 1 });
    const pending = hub.send(KEY("s1"), { command: "compact" });
    await client.waitFor("type_command");

    assert.deepEqual(await bind(client, "s2"), { type: "bind_rejected", reason: "not_owned" });
    assert.deepEqual(hub.binding(KEY("s1")), {
      key: KEY("s1"),
      launcherId: "L1",
      gen: 1,
      childPid: child.pid,
      claudePid: child.pid,
      uncertain: false,
    });
    assert.equal(hub.binding(KEY("s2")), undefined);
    assert.equal(registry.mode("claude", "s1"), "launcher");
    assert.equal(registry.isAttached("claude", "s2"), false);
    assert.equal(client.frames.some((f) => f.type === "cancel_command"), false, "the pending command is not cancelled");
    let settled;
    pending.then((value) => (settled = value));
    await settle(100);
    assert.equal(settled, undefined);
  });
});

test("oversize_command_fails_too_long", async (t) => {
  await withHub(async ({ hub, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    await bind(client, "s1");
    assert.deepEqual(
      await hub.send(KEY("s1"), { command: "text", text: "x".repeat(MAX_FRAME_BYTES) }),
      { ok: false, error: "too_long" },
    );
    await settle(100);
    assert.equal(client.frames.some((f) => f.type === "type_command"), false, "nothing was sent");
    // The slot is still free for a command that fits.
    const fits = hub.send(KEY("s1"), { command: "text", text: "x".repeat(1024) });
    const command = await client.waitFor("type_command");
    client.send({ type: "command_result", cmdId: command.cmdId, ok: true });
    assert.deepEqual(await fits, { ok: true });
  });
});

test("explicit_detach_blocks_auto_bind_until_launcher_exits", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(client, "s1")).type, "bind_accepted");
    const pending = hub.send(KEY("s1"), { command: "compact" });
    await client.waitFor("type_command");

    // /rokid:off is a registry detach.
    registry.detach("claude", "s1");
    assert.deepEqual(await pending, { ok: false, error: "cancelled" });
    await client.waitFor("bind_rejected", (f) => f.reason === "detached");
    assert.equal(hub.binding(KEY("s1")), undefined);
    assert.equal(registry.isAttached("claude", "s1"), false);
    assert.deepEqual(registry.explicitDetach(KEY("s1")), { key: KEY("s1"), launcherId: "L1", childPid: child.pid });

    assert.deepEqual(await bind(client, "s1"), { type: "bind_rejected", reason: "detached" });
    assert.equal(registry.isAttached("claude", "s1"), false);

    // /rokid:on clears it, and the launcher's next bind upgrades the session.
    registry.attach("claude", "s1", "plugin");
    assert.equal(registry.explicitDetach(KEY("s1")), undefined);
    assert.equal((await bind(client, "s1")).type, "bind_accepted");
    registry.detach("claude", "s1");
    await until(() => registry.explicitDetach(KEY("s1")), 3000, "second detach");

    // Once that launcher's child is gone the entry no longer applies.
    client.close();
    await killAndWait(child);
    const next = sleeper(t);
    sessionFile(sessionsDir, next.pid, "s1");
    const resumed = await launcher(hub, { launcherId: "L2", childPid: next.pid });
    assert.equal((await bind(resumed, "s1")).type, "bind_accepted");
    assert.equal(registry.explicitDetach(KEY("s1")), undefined);
  });
});

test("explicit_detach_survives_agentd_restart_and_reconnect", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir, restart }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(client, "s1")).type, "bind_accepted");
    registry.detach("claude", "s1");
    await client.waitFor("bind_rejected", (f) => f.reason === "detached");

    const next = await restart();
    await client.waitClosed();
    assert.deepEqual(next.registry.explicitDetach(KEY("s1")), { key: KEY("s1"), launcherId: "L1", childPid: child.pid });
    const again = await launcher(next.hub, { launcherId: "L1", childPid: child.pid });
    assert.deepEqual(await bind(again, "s1"), { type: "bind_rejected", reason: "detached" });
    assert.equal(next.registry.isAttached("claude", "s1"), false);

    // A restart after the child is gone drops the entry at startup.
    again.close();
    await killAndWait(child);
    const third = await restart();
    assert.equal(third.registry.explicitDetach(KEY("s1")), undefined);
  });
});

test("off_while_no_launcher_connected_blocks_rebind_after_restart", async (t) => {
  await withHub(async ({ hub, sessionsDir, restart }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(client, "s1")).type, "bind_accepted");

    // agentd restarts: the session is plugin until its launcher reconnects.
    const second = await restart();
    await client.waitClosed();
    assert.equal(second.registry.mode("claude", "s1"), "plugin");
    // /rokid:off while no launcher holds the session.
    second.registry.detach("claude", "s1");
    assert.deepEqual(second.registry.explicitDetach(KEY("s1")), { key: KEY("s1") });

    // It is saved: another restart keeps it, and the launcher reconnecting is refused.
    const third = await restart();
    assert.deepEqual(third.registry.explicitDetach(KEY("s1")), { key: KEY("s1") });
    const again = await launcher(third.hub, { launcherId: "L1", childPid: child.pid });
    assert.deepEqual(await bind(again, "s1"), { type: "bind_rejected", reason: "detached" });
    assert.equal(third.registry.isAttached("claude", "s1"), false);
    assert.equal(third.hub.binding(KEY("s1")), undefined);
    // That launcher adopted the entry, and stays refused.
    assert.deepEqual(third.registry.explicitDetach(KEY("s1")), { key: KEY("s1"), launcherId: "L1", childPid: child.pid });
    assert.deepEqual(await bind(again, "s1"), { type: "bind_rejected", reason: "detached" });

    // A launcher that does not run the session cannot adopt or consume it.
    const stranger = sleeper(t);
    const other = await launcher(third.hub, { launcherId: "L2", childPid: stranger.pid });
    assert.deepEqual(await bind(other, "s1"), { type: "bind_rejected", reason: "not_owned" });
    assert.equal(third.registry.explicitDetach(KEY("s1")).launcherId, "L1");

    // Once the adopting launcher's child is gone, a new launcher may bind.
    again.close();
    await killAndWait(child);
    const next = sleeper(t);
    sessionFile(sessionsDir, next.pid, "s1");
    const resumed = await launcher(third.hub, { launcherId: "L3", childPid: next.pid });
    assert.equal((await bind(resumed, "s1")).type, "bind_accepted");
    assert.equal(third.registry.explicitDetach(KEY("s1")), undefined);
  });
});

// N2: the hub never binds on a launcher's old word; it asks for a fresh one.
test("rokid_on_asks_the_launcher_again_rather_than_replaying_its_last_uncertainty", async (t) => {
  await withHub(async ({ hub, registry, sessionsDir }) => {
    const child = sleeper(t);
    sessionFile(sessionsDir, child.pid, "s1");
    const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
    assert.equal((await bind(client, "s1")).type, "bind_accepted");
    registry.detach("claude", "s1");
    await client.waitFor("bind_rejected", (f) => f.reason === "detached");
    // Refused while it was uncertain.
    const before = client.frames.length;
    client.send({ type: "launcher_bind", sessionId: "s1", uncertain: true });
    await until(() => client.frames.slice(before).find((f) => f.type === "bind_rejected"), 3000, "the refusal");

    // /rokid:on: the launcher is asked, and nothing is bound until it answers.
    const asked = client.frames.length;
    registry.attach("claude", "s1", "plugin");
    await client.waitFor("bind_retry");
    await settle();
    assert.equal(hub.binding(KEY("s1")), undefined, "no bind on the stale uncertain: true");
    assert.deepEqual(client.frames.slice(asked), [{ type: "bind_retry" }]);
    // It has since seen Claude idle, so its fresh ask is certain.
    client.send({ type: "launcher_bind", sessionId: "s1", uncertain: false });
    await client.waitFor("bind_accepted", (f) => f.gen === 2);
    assert.equal(hub.binding(KEY("s1")).uncertain, false);
  });
});

// M10: a session rk attached by itself is forgotten once Claude ends it.
test("session_end_prunes_the_launcher_attach", async () => {
  await withDaemon({ transport: "wshub" }, async ({ daemon, httpPort, coderDir }) => {
    daemon.attachRegistry.attach("claude", "rk-made", "launcher");
    daemon.attachRegistry.attach("claude", "opted-in", "plugin");
    for (const id of ["rk-made", "opted-in"]) {
      await postHook(httpPort, { hook_event_name: "SessionEnd", session_id: id, reason: "prompt_input_exit" }, { "x-rokid-provider": "claude" });
    }
    assert.equal(daemon.attachRegistry.isAttached("claude", "rk-made"), false);
    assert.equal(daemon.attachRegistry.explicitDetach(KEY("rk-made")), undefined, "an end is no /rokid:off");
    assert.equal(daemon.attachRegistry.mode("claude", "opted-in"), "plugin", "the user's own opt-in stays");
    const saved = JSON.parse(fs.readFileSync(path.join(coderDir, "attached.json"), "utf8"));
    assert.deepEqual(saved.entries.map((e) => e.id), ["opted-in"]);
  });
});

test("startup_rewrites_launcher_mode_to_plugin", async (t) => {
  const deadPid = spawnSync("true").pid;
  // A live Claude still runs "offlive"; nothing runs "offgone".
  const sessionsDir = await fsp.mkdtemp(path.join(require("node:os").tmpdir(), "rokid-sessions-"));
  const savedEnv = process.env.ROKID_CLAUDE_SESSIONS_DIR;
  process.env.ROKID_CLAUDE_SESSIONS_DIR = sessionsDir;
  t.after(async () => {
    if (savedEnv === undefined) delete process.env.ROKID_CLAUDE_SESSIONS_DIR;
    else process.env.ROKID_CLAUDE_SESSIONS_DIR = savedEnv;
    await fsp.rm(sessionsDir, { recursive: true, force: true });
  });
  const live = sleeper(t);
  sessionFile(sessionsDir, live.pid, "offlive");
  const running = sleeper(t);
  sessionFile(sessionsDir, running.pid, "s1");
  await withDaemon(
    {
      transport: "wshub",
      coderFiles: {
        "attached.json": {
          version: 1,
          entries: [
            { provider: "claude", id: "s1", mode: "launcher", attachedAt: 1 },
            { provider: "claude", id: "s2", mode: "plugin", attachedAt: 2 },
            // M10: rk attached it by itself, and no Claude runs it any more.
            { provider: "claude", id: "s3", mode: "launcher", attachedAt: 3 },
          ],
          explicitDetaches: [
            { key: "claude:gone", launcherId: "L9", childPid: deadPid },
            { key: "claude:live", launcherId: "L8", childPid: process.pid },
            { key: "claude:offgone" },
            { key: "claude:offlive" },
          ],
        },
      },
    },
    async ({ daemon, coderDir }) => {
      assert.equal(daemon.attachRegistry.mode("claude", "s1"), "plugin");
      assert.equal(daemon.attachRegistry.mode("claude", "s2"), "plugin");
      assert.equal(daemon.launchers.binding(KEY("s1")), undefined);
      assert.equal(daemon.attachRegistry.isAttached("claude", "s3"), false);
      const saved = JSON.parse(fs.readFileSync(path.join(coderDir, "attached.json"), "utf8"));
      assert.deepEqual(saved.entries.map((e) => e.mode), ["plugin", "plugin"]);
      assert.deepEqual(saved.explicitDetaches, [
        { key: "claude:live", launcherId: "L8", childPid: process.pid },
        { key: "claude:offlive" },
      ]);
    },
  );
});

test("socket_dir_wrong_mode_or_symlink_disables_launchers", async () => {
  await withTempDir(async (dir) => {
    const sessionsDir = path.join(dir, "sessions");
    // Not looser than 0700 (so not tightened), but no use for a socket.
    const readOnly = path.join(dir, "readonly");
    await fsp.mkdir(readOnly);
    await fsp.chmod(readOnly, 0o500);
    const real = path.join(dir, "real");
    await fsp.mkdir(real, { mode: 0o700 });
    const link = path.join(dir, "link");
    await fsp.symlink(real, link);
    const file = path.join(dir, "notadir");
    await fsp.writeFile(file, "");

    for (const configDir of [readOnly, link, file]) {
      const { events, logger } = capturingLogger();
      const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
      const hub = new LauncherHub({ configDir, claudeSessionsDir: sessionsDir, logger, registry });
      await hub.start();
      try {
        assert.equal(hub.enabled, false, configDir);
        const warning = events.find((e) => e.event.startsWith("launcher socket disabled: "));
        assert.ok(warning, `logged for ${configDir}`);
        assert.equal(fs.existsSync(path.join(configDir, "launcher.sock")), false);
        assert.equal(fs.existsSync(path.join(real, "launcher.sock")), false);
        assert.deepEqual(await hub.send(KEY("s1"), { command: "compact" }), { ok: false, error: "exited" });
      } finally {
        await hub.stop();
      }
    }
    assert.equal((fs.statSync(real).mode & 0o777), 0o700, "a symlink's target is left alone");
  });
});

test("loose_own_socket_dir_tightened_to_0700", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "loose");
    await fsp.mkdir(configDir);
    await fsp.chmod(configDir, 0o755);
    const { events, logger } = capturingLogger();
    const registry = new AttachRegistry({ file: path.join(configDir, "attached.json"), logger });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: dir, logger, registry });
    await hub.start();
    try {
      assert.equal(hub.enabled, true);
      assert.equal((fs.statSync(configDir).mode & 0o777), 0o700);
      assert.ok(events.some((e) => e.event === "launcher socket dir permissions tightened to 0700"));
      assert.equal(events.some((e) => e.event.startsWith("launcher socket disabled: ")), false);
    } finally {
      await hub.stop();
    }
  });
});

test("foreign_owner_still_disables", { skip: process.getuid() === 0 && "running as root" }, async () => {
  // A real directory owned by root, loose by design: it must be refused, not tightened.
  const configDir = "/usr";
  const before = fs.lstatSync(configDir);
  assert.notEqual(before.uid, process.getuid());
  const { events, logger } = capturingLogger();
  await withTempDir(async (dir) => {
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: dir, logger, registry });
    await hub.start();
    await hub.stop();
    assert.equal(hub.enabled, false);
  });
  assert.ok(events.some((e) => e.event === "launcher socket disabled: config dir is not owned by this user"));
  assert.equal(events.some((e) => e.event.includes("tightened")), false);
  assert.equal(fs.lstatSync(configDir).mode, before.mode);
});

test("live_foreign_socket_not_unlinked", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "rc");
    await fsp.mkdir(configDir, { mode: 0o700 });
    const sockPath = path.join(configDir, "launcher.sock");
    // The hub's liveness probe hangs up at once; on Linux that resets this side, so swallow it.
    const foreign = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.end("foreign\n");
    });
    await new Promise((resolve) => foreign.listen(sockPath, resolve));
    try {
      const { events, logger } = capturingLogger();
      const registry = new AttachRegistry({ file: path.join(configDir, "attached.json"), logger });
      const hub = new LauncherHub({ configDir, claudeSessionsDir: dir, logger, registry });
      await hub.start();
      assert.equal(hub.enabled, false);
      assert.ok(events.some((e) => e.event.startsWith("launcher socket disabled: ")));
      await hub.stop();
      const reply = await new Promise((resolve, reject) => {
        const socket = net.createConnection(sockPath);
        socket.setEncoding("utf8");
        socket.once("data", resolve);
        socket.once("error", reject);
      });
      assert.equal(reply, "foreign\n", "the other agentd still owns its socket");
    } finally {
      await new Promise((resolve) => foreign.close(resolve));
    }

    // Anything at the path that is not a socket is left alone too.
    await fsp.writeFile(sockPath, "keep");
    const registry = new AttachRegistry({ file: path.join(configDir, "attached.json") });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: dir, logger: silentLogger, registry });
    await hub.start();
    assert.equal(hub.enabled, false);
    await hub.stop();
    assert.equal(fs.readFileSync(sockPath, "utf8"), "keep");
  });
});

test("stale_socket_unlinked", async (t) => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "rc");
    await fsp.mkdir(configDir, { mode: 0o700 });
    const sockPath = path.join(configDir, "launcher.sock");
    // A process that dies while listening leaves its socket file behind.
    spawnSync(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(sockPath)}, () => process.exit(0))`,
    ]);
    assert.equal(fs.lstatSync(sockPath).isSocket(), true);
    const sessionsDir = path.join(dir, "sessions");
    await fsp.mkdir(sessionsDir);
    const registry = new AttachRegistry({ file: path.join(configDir, "attached.json") });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: sessionsDir, logger: silentLogger, registry });
    await hub.start();
    try {
      assert.equal(hub.enabled, true);
      const child = sleeper(t);
      sessionFile(sessionsDir, child.pid, "s1");
      const client = await launcher(hub, { launcherId: "L1", childPid: child.pid });
      assert.equal((await bind(client, "s1")).type, "bind_accepted");
    } finally {
      await hub.stop();
    }
    assert.equal(fs.existsSync(sockPath), false, "stop removes our socket");
  });
});

test("hook_payload_launcher_id_stripped", async () => {
  const seen = [];
  const server = new HookHttpServer({
    port: 0,
    sessionCount: () => 0,
    onHook: (payload) => {
      seen.push(payload);
      return {};
    },
    logger: silentLogger,
  });
  await server.start();
  try {
    const body = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "s1",
      prompt: "hi",
      launcherId: "L1",
    });
    await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.port(),
          path: "/hook",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-rokid-provider": "claude" },
        },
        (response) => {
          response.resume();
          response.on("end", resolve);
        },
      );
      request.once("error", reject);
      request.end(body);
    });
    assert.equal(seen.length, 1);
    assert.equal(Object.hasOwn(seen[0], "launcherId"), false);
    assert.equal(seen[0].session_id, "s1");
  } finally {
    await server.stop();
  }
});
