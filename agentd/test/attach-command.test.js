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

const UNPAIRED_HINT = "No phone paired yet — type /rokid:pair";

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
      assert.equal(reply.reason, `${ATTACH_TEXT}\n${UNPAIRED_HINT}`, "no phone is paired in this setup");
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
      // commands arrive as UserPromptExpansion named after the plugin.
      const expansion = (name) => ({
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: `rokid:${name}`,
        command_args: "",
        command_source: "plugin",
        prompt: `/rokid:${name}`,
        session_id: "s2",
        cwd: "/work/demo",
      });

      const before = await postHook(httpPort, expansion("status"));
      assert.equal(before.decision, "block");
      assert.match(before.reason, /Not attached/);
      assert.equal(daemon.attachRegistry.isAttached("claude", "s2"), false);

      const attached = await postHook(httpPort, expansion("on"));
      assert.deepEqual(attached, { decision: "block", reason: `${ATTACH_TEXT}\n${UNPAIRED_HINT}` });
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
      for (const name of ["other-plugin:on", "rokid-coder:rokid", "rokid:other", "rokid", "toString"]) {
        assert.deepEqual(
          await postHook(httpPort, {
            hook_event_name: "UserPromptExpansion",
            command_name: name,
            command_args: "",
            session_id: "s3",
          }),
          {},
          name,
        );
      }
      assert.equal(daemon.attachRegistry.isAttached("claude", "s3"), false);
      // No session id means there is nothing to attach.
      const anonymous = await postHook(httpPort, {
        hook_event_name: "UserPromptExpansion",
        command_name: "rokid:on",
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

const { PinStore } = require("../dist/tls.js");
const { PAIR_TEXT } = require("../dist/attach-command.js");

const CODEX = { "x-rokid-provider": "codex" };
const claudeCommand = (sessionId, name) => ({
  hook_event_name: "UserPromptExpansion",
  expansion_type: "slash_command",
  command_name: `rokid:${name}`,
  session_id: sessionId,
  cwd: "/work/demo",
});
const codexPhrase = (sessionId, name) => ({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: "/work/demo", prompt: `rokid:${name}` });
const pinsOf = (coderDir) => new PinStore(path.join(coderDir, "tls", "phone-pins.json"));
const PHONE_FP = "CD".repeat(32);

test("rokid_pair_command_opens_window_and_shows_only_phone_step", async () => {
  await withDaemon({ transport: "wshub" }, async ({ httpPort, coderDir }) => {
    assert.equal(pinsOf(coderDir).allowNextOpen(Date.now()), false);
    const reply = await postHook(httpPort, claudeCommand("p1", "pair"));
    assert.deepEqual(reply, { decision: "block", reason: PAIR_TEXT });
    assert.equal(PAIR_TEXT, "Pairing window open: Open Agents on your phone → Add a computer within 2 minutes.");
    assert.equal(pinsOf(coderDir).allowNextOpen(Date.now()), true, "the allow-next window is open");
    assert.equal(pinsOf(coderDir).allowNextOpen(Date.now() + 2 * 60_000 + 1), false, "for two minutes");

    pinsOf(coderDir).closeAllowNext();
    const codex = await postHook(httpPort, codexPhrase("t1", "pair"), CODEX);
    assert.deepEqual(codex, { decision: "block", reason: PAIR_TEXT });
    assert.equal(pinsOf(coderDir).allowNextOpen(Date.now()), true, "rokid:pair in Codex opens it too");
  });
});

test("rokid_pair_reply_never_contains_token_steer_or_fingerprint", async () => {
  await withDaemon({ transport: "wshub", tls: true, paired: true }, async ({ httpPort, token, steer, agentFingerprint }) => {
    const secrets = [token, steer, agentFingerprint, agentFingerprint.replace(/:/g, ""), PHONE_FP];
    const replies = [];
    for (const name of ["pair", "status", "on", "status", "off"]) {
      replies.push((await postHook(httpPort, claudeCommand("s9", name))).reason);
      replies.push((await postHook(httpPort, codexPhrase("t9", name), CODEX)).reason);
    }
    for (const reply of replies) {
      assert.equal(typeof reply, "string");
      for (const secret of secrets) {
        assert.ok(secret.length >= 16, "a real secret value");
        assert.equal(reply.toUpperCase().includes(secret.toUpperCase()), false, `${JSON.stringify(reply)} leaks a secret`);
      }
      assert.equal(/steer|token|fingerprint|[0-9A-F]{2}(:[0-9A-F]{2}){3,}|[0-9a-f]{16,}/i.test(reply), false, reply);
    }
  });
});

test("rokid_status_reports_mode_paired_agentd_next_step", async () => {
  await withDaemon({ transport: "wshub" }, async ({ httpPort, coderDir }) => {
    const status = async () => (await postHook(httpPort, claudeCommand("s5", "status"))).reason;
    assert.equal(
      await status(),
      "Not attached to Rokid-Coder.\nMode: PLUGIN · Phone: not paired · agentd: reachable\nNext step: type /rokid:on to attach, and type /rokid:pair to pair your phone.",
    );
    await postHook(httpPort, claudeCommand("s5", "on"));
    assert.equal(
      await status(),
      "Attached to Rokid-Coder (plugin mode).\nMode: PLUGIN · Phone: not paired · agentd: reachable\nNext step: type /rokid:pair to pair your phone.",
    );
    pinsOf(coderDir).add(PHONE_FP);
    assert.equal(
      await status(),
      "Attached to Rokid-Coder (plugin mode).\nMode: PLUGIN · Phone: paired · agentd: reachable\nNext step: on your glasses, open Agents to see this session.",
    );
    const codex = (await postHook(httpPort, codexPhrase("t5", "status"), CODEX)).reason;
    assert.equal(codex, "Not attached to Rokid-Coder.\nMode: PLUGIN · Phone: paired · agentd: reachable\nNext step: type rokid:on to attach.");
  });
});

test("rokid_on_unpaired_adds_pair_hint", async () => {
  await withDaemon({ transport: "wshub" }, async ({ httpPort, coderDir }) => {
    const claude = (await postHook(httpPort, claudeCommand("s6", "on"))).reason;
    assert.ok(claude.endsWith("\nNo phone paired yet — type /rokid:pair"), claude);
    const codex = (await postHook(httpPort, codexPhrase("t6", "on"), CODEX)).reason;
    assert.ok(codex.endsWith("\nNo phone paired yet — type rokid:pair"), codex);
    pinsOf(coderDir).add(PHONE_FP);
    assert.equal((await postHook(httpPort, claudeCommand("s7", "on"))).reason, ATTACH_TEXT, "no hint once a phone is paired");
  });
});
