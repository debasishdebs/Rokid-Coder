const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { SessionStore } = require("../dist/session-store.js");
const { silentLogger } = require("../dist/logger.js");
const { withTempDir, withDaemon, postHook, settle } = require("./helpers/daemon.js");

function capturingLogger() {
  const events = [];
  const record = (level) => (event, meta) => events.push({ level, event, meta });
  return {
    events,
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
  };
}

test("attach_persists_across_instances", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "nested", "attached.json");
    const first = new AttachRegistry({ file, now: () => 1234 });
    first.attach("claude", "s1", "plugin");
    first.attach("codex", "t1", "launcher");

    const second = new AttachRegistry({ file });
    assert.equal(second.isAttached("claude", "s1"), true);
    assert.equal(second.mode("claude", "s1"), "plugin");
    assert.equal(second.mode("codex", "t1"), "launcher");
    assert.deepEqual(second.list().sort((a, b) => a.id.localeCompare(b.id)), [
      { provider: "claude", id: "s1", mode: "plugin", attachedAt: 1234 },
      { provider: "codex", id: "t1", mode: "launcher", attachedAt: 1234 },
    ]);
    // Writes are atomic: no temp file is left behind.
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["attached.json"]);
  });
});

test("detach_removes", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "attached.json");
    const registry = new AttachRegistry({ file });
    registry.attach("claude", "s1", "plugin");
    registry.detach("claude", "s1");
    assert.equal(registry.isAttached("claude", "s1"), false);
    assert.equal(registry.mode("claude", "s1"), undefined);
    assert.deepEqual(registry.list(), []);
    assert.equal(new AttachRegistry({ file }).isAttached("claude", "s1"), false);
    // Detaching something never attached is a no-op.
    registry.detach("claude", "never");
  });
});

test("ids_are_exact_not_prefix", async () => {
  await withTempDir(async (dir) => {
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json") });
    registry.attach("claude", "s1", "plugin");
    assert.equal(registry.isAttached("claude", "s10"), false);
    assert.equal(registry.isAttached("claude", "s"), false);
    assert.equal(registry.isAttached("claude", "S1"), false);
    // The provider is part of the identity too.
    assert.equal(registry.isAttached("codex", "s1"), false);
    assert.throws(() => registry.attach("claude", "", "plugin"));
  });
});

test("corrupt_file_starts_empty_and_logs", async () => {
  await withTempDir(async (dir) => {
    for (const contents of ["{not json", JSON.stringify({ version: 9, entries: [] }), "[]"]) {
      const file = path.join(dir, "attached.json");
      await fsp.writeFile(file, contents);
      const { events, logger } = capturingLogger();
      const registry = new AttachRegistry({ file, logger });
      assert.deepEqual(registry.list(), [], contents);
      assert.ok(events.some((e) => e.event === "attach_registry_corrupt"), contents);
      // It recovers: the next attach rewrites the file cleanly.
      registry.attach("claude", "s1", "plugin");
      assert.equal(new AttachRegistry({ file }).isAttached("claude", "s1"), true);
    }
    // A file that parses but holds a bad entry keeps the good ones.
    const file = path.join(dir, "mixed.json");
    await fsp.writeFile(file, JSON.stringify({
      version: 1,
      entries: [
        { provider: "claude", id: "ok", mode: "plugin", attachedAt: 1 },
        { provider: "other", id: "bad", mode: "plugin", attachedAt: 1 },
      ],
    }));
    const { events, logger } = capturingLogger();
    const registry = new AttachRegistry({ file, logger });
    assert.deepEqual(registry.list().map((e) => e.id), ["ok"]);
    assert.ok(events.some((e) => e.event === "attach_registry_corrupt"));
  });
});

test("onChange reports attach and detach once each and survives a throwing listener", async () => {
  await withTempDir(async (dir) => {
    const { logger } = capturingLogger();
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
    const changes = [];
    registry.onChange(() => {
      throw new Error("listener bug");
    });
    const off = registry.onChange((change) => changes.push(`${change.kind}:${change.entry.id}`));
    registry.attach("claude", "s1", "plugin");
    registry.attach("claude", "s1", "plugin"); // idempotent, no second event
    registry.detach("claude", "s1");
    registry.detach("claude", "s1");
    off();
    registry.attach("claude", "s2", "plugin");
    assert.deepEqual(changes, ["attached:s1", "detached:s1"]);
  });
});

test("a failed write does not leave an unpersisted attach behind", async () => {
  await withTempDir(async (dir) => {
    // The registry's parent path is a regular file, so the write cannot succeed.
    const blocker = path.join(dir, "blocker");
    await fsp.writeFile(blocker, "x");
    const registry = new AttachRegistry({ file: path.join(blocker, "attached.json") });
    assert.throws(() => registry.attach("claude", "s1", "plugin"));
    assert.equal(registry.isAttached("claude", "s1"), false);
  });
});

test("store publication is gated on the attach check at the moment of emit", () => {
  let attached = true;
  const store = new SessionStore(
    { machineId: "m", machineName: "m" },
    silentLogger,
    Date.now,
    { isAttached: () => attached },
  );
  const upserts = [];
  store.onUpsert((session) => upserts.push(session.id));
  store.addDiscovered({ id: "s1", projectDir: "p", lastActivityAt: 1 });
  assert.deepEqual(upserts, ["s1"]);
  attached = false;
  store.applyTranscriptUpdate("s1", { activityAt: 5, lastAssistantText: "hi" });
  assert.deepEqual(upserts, ["s1"], "a detached session must not publish");
  assert.deepEqual(store.list(), [], "and must not appear in a snapshot");
  store.dispose();
});

// ---- daemon-level gating, over both phone transports ----

const TRANSPORTS = ["phonelink", "wshub"];

for (const transport of TRANSPORTS) {
  test(`unattached_hook_is_ignored (${transport})`, async () => {
    await withDaemon({ transport, attached: [{ provider: "claude", id: "attached-1" }] }, async ({ daemon, phone, httpPort }) => {
      const response = await postHook(httpPort, {
        hook_event_name: "UserPromptSubmit",
        session_id: "stranger-1",
        cwd: "/work/demo",
        prompt: "do things",
      });
      assert.deepEqual(response, {});
      // Not even a permission request is held for an unattached session.
      const permission = await postHook(httpPort, {
        hook_event_name: "PermissionRequest",
        session_id: "stranger-1",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      });
      assert.deepEqual(permission, {});
      await settle();
      assert.equal(daemon.sessions.get("stranger-1"), undefined);
      assert.equal(phone.frames.some((f) => f.type === "session_upsert"), false);
      assert.equal(phone.frames.some((f) => f.type === "approval_request"), false);

      // The same hook for an attached session flows as before.
      await postHook(httpPort, {
        hook_event_name: "UserPromptSubmit",
        session_id: "attached-1",
        cwd: "/work/demo",
        prompt: "hello",
      });
      const upsert = await phone.waitFor("session_upsert", (f) => f.session.id === "attached-1");
      assert.equal(upsert.session.status, "working");
    });
  });

  test(`unattached_discovered_session_not_published (${transport})`, async () => {
    await withDaemon(
      {
        transport,
        attached: [{ provider: "claude", id: "disc-attached" }],
        discovered: ["disc-attached", "disc-stranger"],
      },
      async ({ daemon, phone }) => {
        const snapshot = phone.frames.find((f) => f.type === "snapshot");
        assert.deepEqual(snapshot.sessions.map((s) => s.id), ["disc-attached"]);
        assert.equal(daemon.sessions.get("disc-stranger"), undefined);
        assert.ok(daemon.sessions.get("disc-attached"));
        phone.send({ type: "refresh" });
        await phone.waitFor("snapshot", () => phone.frames.filter((f) => f.type === "snapshot").length === 2);
        const refreshed = phone.frames.filter((f) => f.type === "snapshot")[1];
        assert.deepEqual(refreshed.sessions.map((s) => s.id), ["disc-attached"]);
      },
    );
  });

  test(`detail_open_for_unattached_rejected (${transport})`, async () => {
    await withDaemon(
      {
        transport,
        attached: [{ provider: "claude", id: "disc-attached" }],
        discovered: ["disc-attached"],
      },
      async ({ phone }) => {
        phone.send({ type: "detail_open", sessionId: "disc-stranger" });
        const rejected = await phone.waitFor("detail_rejected");
        assert.deepEqual(
          { sessionId: rejected.sessionId, error: rejected.error },
          { sessionId: "disc-stranger", error: "not_attached" },
        );
        assert.equal(phone.frames.some((f) => f.type === "detail"), false);

        phone.send({ type: "detail_open", sessionId: "disc-attached" });
        assert.equal((await phone.waitFor("detail", (f) => f.sessionId === "disc-attached")).sessionId, "disc-attached");
      },
    );
  });

  test(`detach_stops_tailing_and_removes_session (${transport})`, async () => {
    await withDaemon(
      { transport, tls: true, attached: [{ provider: "claude", id: "disc-attached" }], discovered: ["disc-attached"] },
      async ({ daemon, phone, httpPort }) => {
        // A permission request is pending for the session when it is detached.
        const held = postHook(httpPort, {
          hook_event_name: "PermissionRequest",
          session_id: "disc-attached",
          tool_name: "Bash",
          tool_input: { command: "npm test" },
        });
        await phone.waitFor("approval_request", (f) => f.sessionId === "disc-attached");
        phone.send({ type: "detail_open", sessionId: "disc-attached" });
        await phone.waitFor("detail");
        assert.equal(daemon.isTailing("disc-attached"), true);

        daemon.attachRegistry.detach("claude", "disc-attached");

        await phone.waitFor("session_removed", (f) => f.sessionId === "disc-attached");
        assert.deepEqual(await held, {}, "the held approval resolves empty");
        assert.equal(daemon.isTailing("disc-attached"), false);
        assert.equal(daemon.sessions.get("disc-attached"), undefined);

        // Later hooks for the detached session are ignored again.
        const before = phone.frames.length;
        await postHook(httpPort, {
          hook_event_name: "UserPromptSubmit",
          session_id: "disc-attached",
          cwd: "/work/demo",
          prompt: "again",
        });
        await settle();
        assert.equal(phone.frames.slice(before).some((f) => f.type === "session_upsert"), false);
        assert.equal(new AttachRegistry({ file: path.join(daemon.config.rokidCoder.stateDir, "attached.json") })
          .isAttached("claude", "disc-attached"), false);
      },
    );
  });
}

test("startup_prunes_launcher_sessions_no_live_claude_runs", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "attached.json");
    const first = new AttachRegistry({ file });
    first.attach("claude", "ended", "launcher");
    first.attach("claude", "running", "launcher");
    first.attach("claude", "opted-in", "plugin");
    const second = new AttachRegistry({ file });
    second.reconcileLaunchers({ isSessionLive: (key) => key === "claude:running" });
    assert.equal(second.isAttached("claude", "ended"), false, "M10: rk attached it, and it is over");
    assert.equal(second.mode("claude", "running"), "plugin", "a live one waits for its launcher to rebind");
    assert.equal(second.mode("claude", "opted-in"), "plugin", "an explicit opt-in is kept");
    assert.equal(new AttachRegistry({ file }).isAttached("claude", "ended"), false, "and the file says so");
    // Without a readable sessions dir nothing is known to be over.
    const third = new AttachRegistry({ file });
    third.attach("claude", "unknown", "launcher");
    third.reconcileLaunchers();
    assert.equal(third.mode("claude", "unknown"), "plugin");
  });
});
