const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { parseAttachCommand } = require("../dist/attach-command.js");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");

test("parses_attach_detach_status", () => {
  assert.deepEqual(parseAttachCommand("/rokid"), { action: "attach" });
  assert.deepEqual(parseAttachCommand("/rokid off"), { action: "detach" });
  assert.deepEqual(parseAttachCommand("/rokid status"), { action: "status" });
  // Leading and trailing whitespace is tolerated, and so is extra space between words.
  assert.deepEqual(parseAttachCommand("   /rokid"), { action: "attach" });
  assert.deepEqual(parseAttachCommand("  /rokid   off  "), { action: "detach" });
  assert.deepEqual(parseAttachCommand("\t/rokid status\n"), { action: "status" });
});

test("non_command_prompt_is_undefined", () => {
  for (const prompt of [
    "/rokidx",
    "please /rokid",
    "/rokid offf",
    "/rokid off now",
    "/rokid  status please",
    "/ROKID",
    "/Rokid off",
    "/rokid OFF",
    "rokid",
    "",
    "/rokid\nsecond line",
  ]) {
    assert.equal(parseAttachCommand(prompt), undefined, JSON.stringify(prompt));
  }
  assert.equal(parseAttachCommand(undefined), undefined);
  assert.equal(parseAttachCommand(42), undefined);
});

const ATTACH_TEXT =
  'Attached to Rokid-Coder (plugin mode). Works: progress, approvals, questions, context, voice follow-ups while waiting. Not available: compact, model change — use "rk claude" for those.';

for (const transport of ["phonelink", "wshub"]) {
  test(`attach_hook_blocks_prompt_and_attaches (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, phone, httpPort, coderDir }) => {
      const reply = await postHook(httpPort, {
        hook_event_name: "UserPromptSubmit",
        session_id: "s1",
        cwd: "/work/demo",
        prompt: "/rokid",
      });
      assert.equal(reply.decision, "block");
      assert.equal(reply.reason, ATTACH_TEXT);
      assert.match(reply.reason, /Not available: compact, model change/);
      assert.equal(daemon.attachRegistry.isAttached("claude", "s1"), true);
      assert.equal(daemon.attachRegistry.mode("claude", "s1"), "plugin");
      assert.equal(
        new AttachRegistry({ file: path.join(coderDir, "attached.json") }).isAttached("claude", "s1"),
        true,
        "the opt-in is persisted",
      );
      // The session shows up on the phone at once, not only at its next hook.
      const upsert = await phone.waitFor("session_upsert", (f) => f.session.id === "s1");
      assert.equal(upsert.session.status, "idle");
      assert.equal(daemon.sessions.get("s1")?.id, "s1");

      // Other prompts from the now-attached session flow as usual.
      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "hi" }),
        {},
      );
    });
  });

  test(`plugin_command_expansion_attaches_status_and_detaches (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, phone, httpPort }) => {
      // Claude Code never sends a slash command to UserPromptSubmit; the plugin's
      // command arrives as UserPromptExpansion with its arguments split out.
      const expansion = (commandArgs) => ({
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "rokid-coder:rokid",
        command_args: commandArgs,
        command_source: "plugin",
        prompt: `/rokid-coder:rokid${commandArgs ? ` ${commandArgs}` : ""}`,
        session_id: "s2",
        cwd: "/work/demo",
      });

      const before = await postHook(httpPort, expansion("status"));
      assert.equal(before.decision, "block");
      assert.match(before.reason, /Not attached/);
      assert.equal(daemon.attachRegistry.isAttached("claude", "s2"), false);

      const attached = await postHook(httpPort, expansion(""));
      assert.deepEqual(attached, { decision: "block", reason: ATTACH_TEXT });
      assert.equal(daemon.attachRegistry.isAttached("claude", "s2"), true);
      await phone.waitFor("session_upsert", (f) => f.session.id === "s2");

      const status = await postHook(httpPort, expansion("status"));
      assert.equal(status.decision, "block");
      assert.match(status.reason, /^Attached to Rokid-Coder \(plugin mode\)/);

      const detached = await postHook(httpPort, expansion("off"));
      assert.equal(detached.decision, "block");
      assert.match(detached.reason, /Detached/);
      assert.equal(daemon.attachRegistry.isAttached("claude", "s2"), false);
      await phone.waitFor("session_removed", (f) => f.sessionId === "s2");

      // Detaching twice is harmless.
      assert.equal((await postHook(httpPort, expansion("off"))).decision, "block");
    });
  });

  test(`attach_command_edge_cases (${transport})`, async () => {
    await withDaemon({ transport }, async ({ daemon, phone, httpPort }) => {
      // Other commands expanding in the session are none of our business.
      assert.deepEqual(
        await postHook(httpPort, {
          hook_event_name: "UserPromptExpansion",
          command_name: "other-plugin:rokid",
          command_args: "",
          session_id: "s3",
        }),
        {},
      );
      // A mistyped argument is told so rather than falling through to the model.
      const usage = await postHook(httpPort, {
        hook_event_name: "UserPromptExpansion",
        command_name: "rokid-coder:rokid",
        command_args: "bogus",
        session_id: "s3",
      });
      assert.equal(usage.decision, "block");
      assert.match(usage.reason, /Usage: \/rokid-coder:rokid \[off\|status\]/);
      // No session id means there is nothing to attach.
      const anonymous = await postHook(httpPort, {
        hook_event_name: "UserPromptSubmit",
        prompt: "/rokid",
      });
      assert.equal(anonymous.decision, "block");
      assert.equal(daemon.attachRegistry.list().length, 0);
      // A non-command prompt from an unattached session is still ignored.
      assert.deepEqual(
        await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: "s3", prompt: "/rokidx" }),
        {},
      );
      await settle();
      assert.equal(phone.frames.some((f) => f.type === "session_upsert"), false);
    });
  });
}
