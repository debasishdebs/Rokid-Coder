const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { LauncherHub } = require("../dist/launcher/launcher-hub.js");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { silentLogger } = require("../dist/logger.js");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, until, waitDead, rkEnv, inPty, readJson } = require("./helpers/rk.js");

/** rk claude, with the fake behind it, bound to a real hub; everything is killed afterwards. */
async function withBoundRk(dir, extra, body) {
  const { env, sessionsDir, configDir } = await rkEnv(dir, { FAKE_PIDFILE: path.join(dir, "pids.json"), ...extra });
  const registry = new AttachRegistry({ file: path.join(configDir, "attached.json"), logger: silentLogger });
  const hub = new LauncherHub({ configDir, claudeSessionsDir: sessionsDir, logger: silentLogger, registry });
  await hub.start();
  let run;
  let pids;
  try {
    run = inPty(process.execPath, [RK, "claude"], env);
    await run.until("fake-claude ready");
    pids = await until(() => readJson(path.join(dir, "pids.json")), 5000, "the fake's pid file");
    await until(() => hub.binding("claude:sess-e2e"), 5000, "the bind");
    await body({ hub, run, key: "claude:sess-e2e" });
  } finally {
    if (pids) {
      try {
        process.kill(pids.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (run) {
      run.child.kill("SIGKILL");
      await run.exited;
    }
    if (pids) await waitDead(pids.pid);
    await hub.stop();
  }
}

test("rk_claude_types_glasses_text_and_compact_through_the_hub", async () => {
  await withTempDir(async (dir) => {
    await withBoundRk(dir, { FAKE_SESSION_ID: "sess-e2e" }, async ({ hub, run, key }) => {
      assert.deepEqual(await hub.send(key, { command: "text", text: "hello glasses" }), { ok: true });
      await run.until("reply: hello glasses");
      assert.deepEqual(await hub.send(key, { command: "compact" }), { ok: true });
      await run.until("Compacted");
    });
  });
});

test("rk_claude_reports_laptop_draft_to_the_hub", async () => {
  await withTempDir(async (dir) => {
    await withBoundRk(dir, { FAKE_SESSION_ID: "sess-e2e" }, async ({ hub, run, key }) => {
      assert.equal(hub.laptopDraft(key), false);
      run.write("half");
      await until(() => hub.laptopDraft(key), 3000, "laptop_state draft:true");
      run.write("\r");
      await until(() => !hub.laptopDraft(key), 3000, "laptop_state draft:false");
    });
  });
});

test("rk_claude_hub_cancel_while_waiting_types_nothing", async () => {
  await withTempDir(async (dir) => {
    await withBoundRk(dir, { FAKE_SESSION_ID: "sess-e2e" }, async ({ hub, run, key }) => {
      run.write("draft");
      await until(() => hub.laptopDraft(key), 3000, "the draft");
      const pending = hub.send(key, { command: "text", text: "never typed" });
      await new Promise((resolve) => setTimeout(resolve, 800));
      hub.cancel(key, "cancelled");
      assert.deepEqual(await pending, { ok: false, error: "cancelled" });
      // With the draft submitted the prompt is ready again; a live command would type now.
      run.write("\r");
      await run.until("reply: draft");
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(run.out.includes("never typed"), false);
      // And the typist is free for the next one.
      assert.deepEqual(await hub.send(key, { command: "text", text: "next one" }), { ok: true });
      await run.until("reply: next one");
    });
  });
});
