const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parseCodexAttachPhrase } = require("../dist/attach-command.js");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { withDaemon, postHook } = require("./helpers/daemon.js");

const CODEX = { "x-rokid-provider": "codex" };
const prompt = (sessionId, text) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  cwd: "/work/demo",
  prompt: text,
});

test("parses_codex_attach_phrases", () => {
  assert.deepEqual(parseCodexAttachPhrase("rokid:on"), { action: "attach" });
  assert.deepEqual(parseCodexAttachPhrase("rokid:off"), { action: "detach" });
  assert.deepEqual(parseCodexAttachPhrase("rokid:status"), { action: "status" });
  assert.deepEqual(parseCodexAttachPhrase("  rokid:on \n"), { action: "attach" });
  // The Codex TUI rejects "/rokid:on" before any hook runs, so only the plain
  // words are the phrase; prose and near misses stay ordinary prompts.
  for (const text of [
    "/rokid:on",
    "/rokid",
    "rokid",
    "rokid on",
    "rokid:onn",
    "please rokid:on",
    "rokid:on now",
    "Rokid:on",
    "ROKID:OFF",
    "rokid:on\nrokid:off",
    "",
  ]) {
    assert.equal(parseCodexAttachPhrase(text), undefined, JSON.stringify(text));
  }
  assert.equal(parseCodexAttachPhrase(undefined), undefined);
  assert.equal(parseCodexAttachPhrase(7), undefined);
});

for (const transport of ["phonelink", "wshub"]) {
  test(`codex_attach_uses_thread_id (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, httpPort, coderDir }) => {
      const reply = await postHook(httpPort, prompt("t1", "rokid:on"), CODEX);
      assert.equal(reply.decision, "block");
      assert.equal(daemon.attachRegistry.isAttached("codex", "t1"), true);
      assert.equal(daemon.attachRegistry.mode("codex", "t1"), "plugin");
      assert.equal(daemon.attachRegistry.isAttached("claude", "t1"), false, "the thread id is not a Claude id");
      assert.equal(
        new AttachRegistry({ file: path.join(coderDir, "attached.json") }).isAttached("codex", "t1"),
        true,
        "the opt-in is persisted",
      );
      // The Codex monitor owns the session record; the hook path adds none.
      assert.equal(daemon.sessions.get("t1"), undefined);
    });
  });

  test(`codex_attach_text_says_full_support (${transport})`, async () => {
    await withDaemon({ transport }, async ({ httpPort }) => {
      const reply = await postHook(httpPort, prompt("t1", "rokid:on"), CODEX);
      assert.equal(reply.decision, "block");
      assert.match(reply.reason, /^Attached to Rokid-Coder \(plugin mode\)\./);
      assert.match(reply.reason, /follow-ups, approvals, questions, context, compact, model change/);
      assert.match(reply.reason, /All controls are available/);
      assert.doesNotMatch(reply.reason, /Not available|rk claude/);
    });
  });

  test(`codex_status_and_detach (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, httpPort }) => {
      const before = await postHook(httpPort, prompt("t2", "rokid:status"), CODEX);
      assert.equal(before.decision, "block");
      assert.match(before.reason, /Not attached.*rokid:on/s);
      assert.equal(daemon.attachRegistry.isAttached("codex", "t2"), false);

      await postHook(httpPort, prompt("t2", "rokid:on"), CODEX);
      const status = await postHook(httpPort, prompt("t2", "rokid:status"), CODEX);
      assert.match(status.reason, /^Attached to Rokid-Coder \(plugin mode\)/);

      const detached = await postHook(httpPort, prompt("t2", "rokid:off"), CODEX);
      assert.equal(detached.decision, "block");
      assert.match(detached.reason, /Detached/);
      assert.equal(daemon.attachRegistry.isAttached("codex", "t2"), false);
      assert.equal((await postHook(httpPort, prompt("t2", "rokid:off"), CODEX)).decision, "block");
    });
  });

  test(`codex_attach_is_scoped_to_the_provider_header (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, httpPort }) => {
      // No header means Claude, and Claude's words are not Codex's.
      assert.deepEqual(await postHook(httpPort, prompt("t3", "rokid:on")), {});
      assert.equal(daemon.attachRegistry.isAttached("claude", "t3"), false);
      assert.equal(daemon.attachRegistry.isAttached("codex", "t3"), false);

      // A provider claimed in the body is not the forwarder's header.
      assert.deepEqual(
        await postHook(httpPort, { ...prompt("t3", "rokid:on"), __provider: "codex" }),
        {},
      );
      assert.equal(daemon.attachRegistry.isAttached("codex", "t3"), false);

      // And Codex does not take Claude's command forms.
      for (const text of ["/rokid", "/rokid:on"]) {
        assert.deepEqual(await postHook(httpPort, prompt("t3", text), CODEX), {});
      }
      assert.equal(daemon.attachRegistry.isAttached("codex", "t3"), false);
      assert.equal(daemon.attachRegistry.isAttached("claude", "t3"), false);

      // An unknown provider is treated like none.
      assert.deepEqual(
        await postHook(httpPort, prompt("t3", "rokid:on"), { "x-rokid-provider": "other" }),
        {},
      );

      // Claude's own attach still works next to a codex thread of the same id.
      await postHook(httpPort, prompt("t3", "rokid:on"), CODEX);
      const claude = await postHook(httpPort, prompt("t3", "/rokid"));
      assert.equal(claude.decision, "block");
      assert.match(claude.reason, /Not available: compact, model change/);
      assert.equal(daemon.attachRegistry.isAttached("claude", "t3"), true);
      assert.equal(daemon.attachRegistry.isAttached("codex", "t3"), true);
    });
  });

  test(`codex_hooks_do_nothing_else (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, httpPort }) => {
      const other = { hook_event_name: "UserPromptSubmit", session_id: "t4", prompt: "hello" };
      assert.deepEqual(await postHook(httpPort, other, CODEX), {});
      assert.equal(daemon.sessions.get("t4"), undefined, "an unattached thread leaves no trace");

      await postHook(httpPort, prompt("t4", "rokid:on"), CODEX);
      assert.deepEqual(await postHook(httpPort, other, CODEX), {});
      // Approvals for Codex come over the app-server, never through a hook.
      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "PermissionRequest", session_id: "t4", tool_name: "Bash" }, CODEX),
        {},
      );
      assert.equal(daemon.sessions.get("t4"), undefined);
    });
  });
}

test("codex_plugin_package_is_wired", () => {
  const fs = require("node:fs");
  const root = path.resolve(__dirname, "..", "..");
  const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(root, ...parts), "utf8"));

  const marketplace = readJson(".agents", "plugins", "marketplace.json");
  const entry = marketplace.plugins.find((plugin) => plugin.name === "rokid");
  assert.equal(entry.source.path, "./plugin/codex");
  assert.ok(entry.policy.installation && entry.policy.authentication && entry.category, "Codex requires these entry fields");

  const manifest = readJson("plugin", "codex", ".codex-plugin", "plugin.json");
  assert.equal(manifest.name, "rokid");

  // The hook is the only part of the plugin that talks to agentd, and the
  // header it sends is what makes the daemon read the payload as Codex's.
  const handlers = readJson("plugin", "codex", "hooks", "hooks.json").hooks.UserPromptSubmit.flatMap((group) => group.hooks);
  assert.equal(handlers.length, 1);
  assert.match(handlers[0].command, /^ROKID_CODER_PROVIDER=codex "\$HOME\/\.rokid-coder\/bin\/rokid-node" "\$\{PLUGIN_ROOT\}\/bin\/hook-forward\.js"$/);

  const built = fs.readFileSync(path.resolve(__dirname, "..", "dist", "hook-forward.js"), "utf8");
  assert.equal(
    fs.readFileSync(path.join(root, "plugin", "codex", "bin", "hook-forward.js"), "utf8"),
    built,
    "plugin/codex/bin/hook-forward.js is stale; run npm run build",
  );
});
