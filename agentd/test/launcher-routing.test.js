"use strict";
/**
 * Task 4 routing through the real daemon: a trusted fake phone, real hooks
 * over HTTP, the real launcher hub, and a launcher played by this test over the
 * launcher socket (its pty child is a `sleep`, whose sessions file the test
 * writes as Claude would). One end-to-end test runs the real `rk claude` with
 * the fake CLI behind it. No real `claude` is ever started.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { withDaemon, postHook, settle } = require("./helpers/daemon.js");
const { RK, waitDead, inPty, readJson } = require("./helpers/rk.js");
const { LAUNCHER_ATTACH_TEXT, LAUNCHER_STATUS_TEXT } = require("../dist/attach-command.js");

const ID = "ls1";
const KEY = `claude:${ID}`;
const READY_WAIT_MS = 1500;

async function until(check, ms = 3000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(10);
  }
}

function connect(sockPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath);
    const client = { socket, frames: [] };
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
    client.send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
    client.of = (type) => client.frames.filter((f) => f.type === type);
    client.waitFor = (type, predicate = () => true, ms) =>
      until(() => client.frames.find((f) => f.type === type && predicate(f)), ms, type);
    client.close = () => socket.destroy();
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      resolve(client);
    });
    socket.once("error", reject);
  });
}

/** What the typist sends for a command it typed: its first write, then its result. */
function answer(launcher, frame, result = { ok: true }) {
  launcher.send({ type: "command_written", cmdId: frame.cmdId, at: Date.now() });
  launcher.send({ type: "command_result", cmdId: frame.cmdId, ...result });
}

async function withEnv(vars, body) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  try {
    return await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const SHORT_WINDOWS = {
  ROKID_LAUNCHER_READY_WAIT_MS: String(READY_WAIT_MS),
  ROKID_LAUNCHER_COMPACT_LIMIT_MS: "1500",
};

/**
 * The daemon, with session ls1 bound to a launcher this test plays. Claude's
 * sessions file starts idle a minute ago, as for a session sitting at its prompt.
 */
async function withBound(body, { attached = [], sessionStart = true, sessionCwd } = {}) {
  await withEnv(SHORT_WINDOWS, () =>
    withDaemon({ transport: "wshub", tls: true, attached, paired: true }, async (ctx) => {
      const sessionsDir = path.join(ctx.claudeDir, "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });
      const child = spawn("sleep", ["60"], { stdio: "ignore" });
      let launcher;
      try {
        let last = Date.now() - 60_000;
        const claude = {
          write(status) {
            last = Math.max(last + 1, Date.now() + 1);
            fs.writeFileSync(
              path.join(sessionsDir, `${child.pid}.json`),
              JSON.stringify({ pid: child.pid, sessionId: ID, status, statusUpdatedAt: last }),
            );
            return last;
          },
        };
        fs.writeFileSync(
          path.join(sessionsDir, `${child.pid}.json`),
          JSON.stringify({ pid: child.pid, sessionId: ID, status: "idle", statusUpdatedAt: last, ...(sessionCwd ? { cwd: sessionCwd } : {}) }),
        );
        launcher = await connect(ctx.daemon.launchers.socketPath);
        launcher.send({ type: "launcher_hello", v: 1, launcherId: "L1", provider: "claude", childPid: child.pid });
        launcher.send({ type: "launcher_bind", sessionId: ID });
        await launcher.waitFor("bind_accepted");
        if (sessionStart) {
          await postHook(ctx.httpPort, { hook_event_name: "SessionStart", session_id: ID, cwd: "/work/demo" });
        }
        const command = (fields, msgId) => {
          const frame = { type: "launcher_command", v: 2, sessionKey: KEY, msgId, ...fields };
          ctx.phone.send(frame);
          return frame;
        };
        const followup = (text, msgId) => ctx.phone.send({ type: "followup", v: 2, sessionKey: KEY, text, msgId });
        const ack = (msgId, ms = 4000) => ctx.phone.waitFor("ack", (f) => f.msgId === msgId, ms);
        // Wrapped, so awaiting the hold does not also await the hook's answer.
        const heldStop = async () => {
          const reply = postHook(ctx.httpPort, { hook_event_name: "Stop", session_id: ID });
          await until(() => ctx.daemon.stopWait.state(ID).waiting, 3000, "the held Stop");
          return { reply };
        };
        /** The launcher moves to another session of the same child, as after a /clear. */
        const rebind = async (sessionId) => {
          fs.writeFileSync(
            path.join(sessionsDir, `${child.pid}.json`),
            JSON.stringify({ pid: child.pid, sessionId, status: "idle", statusUpdatedAt: Date.now() }),
          );
          launcher.send({ type: "launcher_bind", sessionId });
          await launcher.waitFor("bind_accepted", (f) => f.gen > 1);
        };
        const compactHooks = async (trigger, sessionId = ID) => {
          await postHook(ctx.httpPort, { hook_event_name: "PreCompact", session_id: sessionId, trigger });
          await postHook(ctx.httpPort, { hook_event_name: "PostCompact", session_id: sessionId, trigger });
        };
        const noAck = async (msgId, ms = 300) => {
          await settle(ms);
          assert.equal(ctx.phone.frames.some((f) => f.type === "ack" && f.msgId === msgId), false, `no ack yet for ${msgId}`);
        };
        await body({ ...ctx, launcher, claude, command, followup, ack, heldStop, child, rebind, compactHooks, noAck });
      } finally {
        launcher?.close();
        ctx.daemon.stopWait.releaseAll();
        child.kill("SIGKILL");
      }
    }),
  );
}

test("bundled_hooks_json_registers_pre_and_post_compact", () => {
  const { hooks } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "..", "plugins", "claude-code", "hooks", "hooks.json"), "utf8"),
  );
  // R131: the new ones, and every hook that was there before (R62's among them).
  for (const event of [
    "PreCompact", "PostCompact", "SessionStart", "UserPromptSubmit", "UserPromptExpansion", "PreToolUse",
    "PermissionRequest", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "Stop", "SubagentStop",
    "Notification", "SessionEnd",
  ]) {
    const handlers = hooks[event]?.flatMap((group) => group.hooks) ?? [];
    assert.equal(handlers.length, 1, event);
    assert.match(handlers[0].command, /^ROKID_CODER_PROVIDER=claude .*bin\/hook-forward\.js"$/, event);
  }
  assert.equal(hooks.PreCompact[0].matcher, undefined, "manual and auto both reach agentd");
});

test("launcher_command_on_plugin_session_rejected_not_launcher", async () => {
  await withEnv(SHORT_WINDOWS, () =>
    withDaemon({ transport: "wshub", tls: true, attached: [{ provider: "claude", id: "plain" }] }, async ({ phone }) => {
      for (const sessionKey of ["claude:plain", "claude:ghost", "codex:plain"]) {
        for (let round = 0; round < 2; round += 1) {
          // Same msgId twice: a refusal leaves it free.
          const msgId = `lc-${sessionKey}`;
          phone.send({ type: "launcher_command", v: 2, sessionKey, command: "compact", msgId });
          const acks = await until(() => {
            const found = phone.frames.filter((f) => f.type === "ack" && f.msgId === msgId);
            return found.length === round + 1 && found;
          });
          assert.deepEqual([acks[round].result, acks[round].error], ["rejected", "not_launcher"], sessionKey);
        }
      }
      phone.send({ type: "launcher_command", v: 2, sessionKey: "nonsense", command: "compact", msgId: "lc-bad" });
      assert.equal((await phone.waitFor("ack", (f) => f.msgId === "lc-bad")).error, "bad_session_key");
    }),
  );
});

test("bad_model_rejected", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    for (const [fields, error] of [
      [{ command: "model", model: "gpt-6" }, "bad_model"],
      [{ command: "model" }, "bad_model"],
      [{ command: "model", model: "Opus" }, "bad_model"],
      [{ command: "restart" }, "bad_command"],
      [{ command: "compact", model: "opus" }, "bad_command"],
    ]) {
      const msgId = `bm-${JSON.stringify(fields)}`;
      command(fields, msgId);
      const reply = await ack(msgId);
      assert.deepEqual([reply.result, reply.error], ["rejected", error], msgId);
    }
    await settle(100);
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("model_applied_after_typist_ok", async () => {
  await withBound(async ({ launcher, command, ack, phone }) => {
    command({ command: "model", model: "sonnet" }, "m1");
    const frame = await launcher.waitFor("type_command");
    assert.deepEqual(
      { command: frame.command, model: frame.model, gen: frame.gen, notBefore: frame.notBefore },
      { command: "model", model: "sonnet", gen: 1, notBefore: undefined },
    );
    await settle(100);
    assert.equal(phone.frames.some((f) => f.type === "ack" && f.msgId === "m1"), false, "not before the typist says ok");
    answer(launcher, frame);
    assert.equal((await ack("m1")).result, "applied");
  });
});

test("duplicate_msgId_not_retyped", async () => {
  await withBound(async ({ launcher, command, ack, httpPort, phone }) => {
    command({ command: "compact" }, "dup");
    const frame = await launcher.waitFor("type_command");
    command({ command: "compact" }, "dup");
    assert.equal((await ack("dup")).result, "duplicate");
    answer(launcher, frame);
    await postHook(httpPort, { hook_event_name: "PreCompact", session_id: ID, trigger: "manual" });
    await postHook(httpPort, { hook_event_name: "PostCompact", session_id: ID, trigger: "manual" });
    assert.equal((await phone.waitFor("ack", (f) => f.msgId === "dup" && f.result === "applied")).result, "applied");
    assert.deepEqual(await launcher.waitFor("compact_done"), { type: "compact_done", cmdId: frame.cmdId });
    command({ command: "compact" }, "dup");
    await until(() => phone.frames.filter((f) => f.type === "ack" && f.msgId === "dup" && f.result === "duplicate").length === 2);
    assert.equal(launcher.of("type_command").length, 1);
  });
});

test("delivered_followup_marks_busy_before_hook_returns", async () => {
  await withBound(async ({ daemon, launcher, claude, command, followup, ack, heldStop }) => {
    // Idle on file, with no latch: ready.
    assert.equal(daemon.launcherRouter.state(KEY), "ready");
    const { reply } = await heldStop();
    assert.equal(daemon.launcherRouter.state(KEY), "held");
    const seenInRelease = [];
    // Runs after agentd's own release listener, still inside the release, before the hook responds.
    daemon.stopWait.onRelease(() => seenInRelease.push(daemon.launcherRouter.state(KEY)));
    followup("carry on", "fu1");
    const hook = await reply;
    assert.equal(hook.decision, "block");
    assert.deepEqual(seenInRelease, ["busy"]);
    assert.equal(daemon.launcherRouter.state(KEY), "busy", "Claude's file still shows its old idle");
    assert.equal((await ack("fu1")).result, "applied");

    command({ command: "compact" }, "c1");
    await settle(300);
    claude.write("busy");
    await settle(300);
    assert.deepEqual(launcher.of("type_command"), [], "nothing typed while Claude carries on");
    claude.write("idle");
    const frame = await launcher.waitFor("type_command");
    assert.equal(frame.command, "compact");
    assert.equal(typeof frame.notBefore, "number", "the delivery's latch reaches the launcher");
    launcher.send({ type: "command_result", cmdId: frame.cmdId, ok: false, error: "laptop_draft" });
    assert.equal((await ack("c1")).error, "laptop_draft");
  });
});

test("consecutive_followups_never_type_while_claude_continues", async () => {
  await withBound(async ({ httpPort, launcher, claude, followup, ack, heldStop }) => {
    const { reply: first } = await heldStop();
    followup("one", "fa");
    assert.equal((await first).decision, "block");
    assert.equal((await ack("fa")).result, "applied");
    // The second arrives while Claude works on the first, silently.
    followup("two", "fb");
    await settle(200);
    claude.write("busy");
    await settle(300);
    assert.deepEqual(launcher.of("type_command"), []);
    // Its next Stop is held: the hook takes the second one, nothing is typed.
    // The waiting follow-up may take the hold at once, so await the hook itself.
    const hook = await postHook(httpPort, { hook_event_name: "Stop", session_id: ID });
    assert.equal(hook.decision, "block");
    assert.match(hook.reason, /two/);
    assert.equal((await ack("fb")).result, "applied");
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("followup_while_held_uses_stop_hook", async () => {
  await withBound(async ({ launcher, followup, ack, heldStop, phone }) => {
    const { reply: held } = await heldStop();
    await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.capabilities.followup === "waiting");
    followup("from the glasses", "fh");
    const hook = await held;
    assert.equal(hook.decision, "block");
    assert.match(hook.reason, /from the glasses/);
    assert.equal((await ack("fh")).result, "applied");
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("followup_after_y_types_when_idle", async () => {
  await withBound(async ({ daemon, launcher, claude, followup, ack, heldStop }) => {
    daemon.stopWait.setWaitLimitMs(200);
    const { reply: held } = await heldStop();
    assert.deepEqual(await held, {}, "Y passed: the Stop went ahead at the laptop");
    claude.write("idle");
    followup("late reply", "fy");
    const frame = await launcher.waitFor("type_command");
    assert.deepEqual({ command: frame.command, text: frame.text }, { command: "text", text: "late reply" });
    answer(launcher, frame);
    assert.equal((await ack("fy")).result, "applied");
  });
});

test("cap_reached_unheld_stop_then_late_reply_types", async () => {
  await withBound(async ({ httpPort, launcher, claude, followup, ack, heldStop }) => {
    for (let index = 0; index < 8; index += 1) {
      const { reply: held } = await heldStop();
      followup(`reply ${index}`, `cap-${index}`);
      assert.equal((await held).decision, "block");
      assert.equal((await ack(`cap-${index}`)).result, "applied");
    }
    // The cap: this Stop is not held, and Claude goes idle on its own.
    assert.deepEqual(await postHook(httpPort, { hook_event_name: "Stop", session_id: ID }), {});
    claude.write("idle");
    followup("after the cap", "cap-late");
    const frame = await launcher.waitFor("type_command");
    assert.equal(frame.text, "after the cap");
    answer(launcher, frame);
    assert.equal((await ack("cap-late")).result, "applied");
  });
});

test("uncertain_binding_rejects_until_laptop_prompt", async () => {
  await withBound(async ({ launcher, claude, command, ack, httpPort }) => {
    command({ command: "model", model: "opus" }, "u1");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame, { ok: false, error: "dialog_not_seen" });
    assert.equal((await ack("u1")).error, "dialog_not_seen");
    // R141: the launcher is told.
    await launcher.waitFor("binding_state", (f) => f.uncertain === true);
    command({ command: "compact" }, "u2");
    assert.equal((await ack("u2")).error, "uncertain");
    assert.equal(launcher.of("type_command").length, 1);
    await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: ID, prompt: "/model opus" });
    await launcher.waitFor("binding_state", (f) => f.uncertain === false);
    claude.write("idle");
    command({ command: "compact" }, "u3");
    const next = await launcher.waitFor("type_command", (f) => f.cmdId !== frame.cmdId);
    launcher.send({ type: "command_result", cmdId: next.cmdId, ok: false, error: "busy" });
    assert.equal((await ack("u3")).error, "busy");
  });
});

test("launcher_exit_mid_command_rejects_exited_and_reverts_to_plugin", async () => {
  await withBound(async ({ daemon, launcher, command, ack, phone }) => {
    await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.mode === "launcher");
    const bound = daemon.phoneV2.decorate(daemon.sessions.get(ID));
    assert.deepEqual([bound.mode, bound.capabilities], ["launcher", { compact: true, model: true, followup: "ready" }]);
    command({ command: "model", model: "haiku" }, "x1");
    await launcher.waitFor("type_command");
    launcher.close();
    assert.equal((await ack("x1")).error, "exited");
    const upsert = await phone.waitFor("session_upsert", (f) => f.session.id === ID && f.session.mode === "plugin");
    assert.deepEqual(upsert.session.capabilities, { compact: false, model: false, followup: "unavailable" });
    assert.equal(daemon.attachRegistry.mode("claude", ID), "plugin");
    command({ command: "compact" }, "x2");
    assert.equal((await ack("x2")).error, "not_launcher");
  });
});

test("startup_idle_session_is_ready_without_any_hook", async () => {
  await withBound(async ({ daemon, launcher, command, ack }) => {
    // Bound, and Claude's file idle from before agentd ever heard of it.
    assert.equal(daemon.launcherRouter.state(KEY), "ready");
    command({ command: "model", model: "haiku" }, "st1");
    const frame = await launcher.waitFor("type_command", () => true, 500);
    assert.equal(frame.notBefore, undefined, "no latch, so no barrier");
    answer(launcher, frame);
    assert.equal((await ack("st1")).result, "applied");
  }, { sessionStart: false });
});

test("first_command_on_idle_session_not_blocked_by_its_own_dispatch", async () => {
  await withBound(async ({ launcher, command, ack, compactHooks }) => {
    const started = Date.now();
    command({ command: "compact" }, "f1");
    const frame = await launcher.waitFor("type_command");
    // Its own command_written latches the session, and Claude's file never moves.
    answer(launcher, frame);
    await compactHooks("manual");
    assert.equal((await ack("f1")).result, "applied");
    assert.ok(Date.now() - started < READY_WAIT_MS, "well inside the readiness window");
  });
});

test("two_consecutive_model_commands_both_run", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    command({ command: "model", model: "sonnet" }, "mm1");
    const first = await launcher.waitFor("type_command");
    answer(launcher, first);
    assert.equal((await ack("mm1")).result, "applied");
    // /model may never flip Claude's status: the ok cleared the latch.
    command({ command: "model", model: "opus" }, "mm2");
    const second = await launcher.waitFor("type_command", (f) => f.cmdId !== first.cmdId, 1000);
    assert.equal(second.model, "opus");
    answer(launcher, second);
    assert.equal((await ack("mm2")).result, "applied");
  });
});

test("silent_busy_period_does_not_count_as_idle", async () => {
  await withBound(async ({ daemon, launcher, command, followup, ack, heldStop }) => {
    const { reply } = await heldStop();
    followup("go on", "sb0");
    assert.equal((await reply).decision, "block");
    // Claude works on it and writes nothing: its file still shows the old idle.
    command({ command: "compact" }, "sb1");
    await settle(READY_WAIT_MS / 2);
    assert.equal(daemon.launcherRouter.state(KEY), "busy");
    assert.equal((await ack("sb1")).error, "busy");
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("no_type_command_while_held", async () => {
  await withBound(async ({ daemon, launcher, command, ack, heldStop }) => {
    const { reply } = await heldStop();
    command({ command: "compact" }, "h1");
    assert.equal((await ack("h1")).error, "busy");
    assert.deepEqual(launcher.of("type_command"), []);
    assert.equal(daemon.launcherRouter.state(KEY), "held");
    daemon.stopWait.releaseAll();
    assert.deepEqual(await reply, {});
  });
});

test("auto_compact_does_not_complete_launcher_compact", async () => {
  await withBound(async ({ launcher, command, ack, compactHooks, noAck }) => {
    command({ command: "compact" }, "ac1");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame);
    await compactHooks("auto");
    await noAck("ac1");
    assert.deepEqual(launcher.of("compact_done"), []);
    await compactHooks("manual");
    assert.equal((await ack("ac1")).result, "applied");
    assert.deepEqual(await launcher.waitFor("compact_done"), { type: "compact_done", cmdId: frame.cmdId });
  });
});

test("compact_applied_only_on_post_compact_of_same_generation", async () => {
  await withBound(async ({ httpPort, launcher, command, ack, noAck, compactHooks }) => {
    command({ command: "compact" }, "cg1");
    const frame = await launcher.waitFor("type_command");
    assert.equal(frame.gen, 1);
    answer(launcher, frame);
    // A PostCompact with no manual PreCompact of this compact before it.
    await postHook(httpPort, { hook_event_name: "PostCompact", session_id: ID, trigger: "manual" });
    await noAck("cg1");
    await compactHooks("manual");
    assert.equal((await ack("cg1")).result, "applied");
  });
});

test("compact_timeout_rejected", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    const started = Date.now();
    command({ command: "compact" }, "ct1");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame);
    // The window is shrunk to 1.5 s here; no PostCompact ever comes.
    assert.equal((await ack("ct1")).error, "timeout");
    assert.ok(Date.now() - started >= 1400);
    assert.deepEqual(launcher.of("compact_done"), []);
  });
});

test("rebind_during_wait_cancels_and_rejects_cancelled", async () => {
  await withBound(async ({ launcher, claude, command, ack, rebind }) => {
    claude.write("busy");
    command({ command: "compact" }, "rb1");
    await settle(300);
    await rebind("ls2");
    assert.equal((await ack("rb1")).error, "cancelled");
    assert.deepEqual(launcher.of("type_command"), []);
  });
  // While running: the launcher is told to drop it.
  await withBound(async ({ launcher, command, ack, rebind }) => {
    command({ command: "model", model: "haiku" }, "rb2");
    const frame = await launcher.waitFor("type_command");
    await rebind("ls3");
    assert.equal((await ack("rb2")).error, "cancelled");
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
  });
});

test("compact_timeout_after_ok_sends_cancel_command", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    command({ command: "compact" }, "cx1");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame);
    assert.equal((await ack("cx1")).error, "timeout");
    // R148: the launcher owns input until compact_done; agentd gave up, so it says so.
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId, 1000);
    assert.deepEqual(launcher.of("compact_done"), []);
  });
});

test("rebind_after_compact_ok_sends_cancel_to_old_connection", async () => {
  await withBound(async ({ launcher, command, ack, rebind }) => {
    command({ command: "compact" }, "cx2");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame);
    await settle(100);
    await rebind("ls2");
    assert.equal((await ack("cx2")).error, "cancelled");
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId, 1000);
  });
});

test("detach_or_session_end_after_compact_ok_sends_cancel_command", async () => {
  for (const end of ["detach", "SessionEnd"]) {
    await withBound(async ({ daemon, httpPort, launcher, command, ack }) => {
      command({ command: "compact" }, `cx3-${end}`);
      const frame = await launcher.waitFor("type_command");
      answer(launcher, frame);
      await settle(100);
      if (end === "detach") daemon.attachRegistry.detach("claude", ID);
      else await postHook(httpPort, { hook_event_name: "SessionEnd", session_id: ID });
      assert.equal((await ack(`cx3-${end}`)).error, "cancelled", end);
      await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId, 1000);
    });
  }
});

test("laptop_compact_before_the_write_does_not_complete_glasses_compact", async () => {
  await withBound(async ({ launcher, command, ack, compactHooks, noAck }) => {
    command({ command: "compact" }, "lc1");
    const frame = await launcher.waitFor("type_command");
    // The launcher is holding it behind a draft, and the user submits a /compact of their own.
    await compactHooks("manual");
    answer(launcher, frame);
    await noAck("lc1");
    await compactHooks("manual");
    assert.equal((await ack("lc1")).result, "applied");
  });
});

test("written_command_rejected_keeps_its_msgId", async () => {
  await withBound(async ({ launcher, command, ack, phone }) => {
    command({ command: "compact" }, "wk1");
    const frame = await launcher.waitFor("type_command");
    answer(launcher, frame);
    assert.equal((await ack("wk1")).error, "timeout");
    // It was typed: a resend of the same id must not type it again.
    command({ command: "compact" }, "wk1");
    await until(() => phone.frames.some((f) => f.type === "ack" && f.msgId === "wk1" && f.result === "duplicate"));
    assert.equal(launcher.of("type_command").length, 1);
  });
});

test("laptop_draft_holds_dispatch_in_agentd", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    launcher.send({ type: "laptop_state", draft: true });
    await settle(100);
    command({ command: "compact" }, "ld1");
    assert.equal((await ack("ld1")).error, "laptop_draft");
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("hub_send_refuses_an_uncertain_binding", async () => {
  await withBound(async ({ daemon, launcher }) => {
    daemon.launchers.setUncertain(KEY, true);
    assert.deepEqual(await daemon.launchers.send(KEY, { command: "compact" }), { ok: false, error: "uncertain" });
    await settle(50);
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("rokid_on_keeps_a_bound_session_in_launcher_mode", async () => {
  await withBound(async ({ daemon, httpPort }) => {
    const reply = await postHook(httpPort, { hook_event_name: "UserPromptExpansion", command_name: "rokid:on", session_id: ID });
    assert.deepEqual(reply, { decision: "block", reason: LAUNCHER_ATTACH_TEXT });
    assert.equal(daemon.attachRegistry.mode("claude", ID), "launcher");
    assert.equal(daemon.phoneV2.decorate(daemon.sessions.get(ID)).mode, "launcher");
    const status = await postHook(httpPort, { hook_event_name: "UserPromptExpansion", command_name: "rokid:status", session_id: ID });
    assert.equal(status.decision, "block");
    assert.ok(status.reason.startsWith(`${LAUNCHER_STATUS_TEXT}\nMode: LAUNCHER · Phone: paired`), status.reason);
  });
});

test("detach_mid_command_cancels_and_rejects_cancelled", async () => {
  await withBound(async ({ daemon, launcher, command, ack }) => {
    command({ command: "model", model: "haiku" }, "d1");
    const frame = await launcher.waitFor("type_command");
    daemon.attachRegistry.detach("claude", ID);
    assert.equal((await ack("d1")).error, "cancelled");
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
  });
});

test("session_end_while_waiting_rejects_cancelled", async () => {
  await withBound(async ({ launcher, claude, command, ack, httpPort }) => {
    claude.write("busy");
    command({ command: "compact" }, "e1");
    await settle(200);
    await postHook(httpPort, { hook_event_name: "SessionEnd", session_id: ID });
    assert.equal((await ack("e1")).error, "cancelled");
    assert.deepEqual(launcher.of("type_command"), []);
  });
});

test("rk_claude_compact_and_model_from_the_glasses_end_to_end", async () => {
  await withEnv(SHORT_WINDOWS, () =>
    withDaemon({ transport: "wshub", tls: true, paired: true }, async ({ daemon, phone, httpPort, claudeDir, coderDir }) => {
      const dir = path.dirname(coderDir);
      const sessionsDir = path.join(claudeDir, "sessions");
      await fsp.mkdir(sessionsDir, { recursive: true });
      const stateFile = path.join(dir, "fake-state.json");
      const env = {
        ...process.env,
        TERM: "xterm",
        ROKID_RK_CLAUDE_BIN: path.join(__dirname, "fixtures", "fake-claude.js"),
        ROKID_RK_CONFIG_DIR: coderDir,
        ROKID_CLAUDE_SESSIONS_DIR: sessionsDir,
        NEXUS_AGENTD_HTTP_PORT: String(httpPort),
        FAKE_SESSION_ID: "e2e",
        FAKE_PIDFILE: path.join(dir, "pids.json"),
        FAKE_STATE_FILE: stateFile,
      };
      let run;
      let pids;
      try {
        run = inPty(process.execPath, [RK, "claude"], env);
        await run.until("fake-claude ready");
        pids = await until(() => readJson(env.FAKE_PIDFILE), 5000, "the fake's pid file");
        await until(() => daemon.launchers.binding("claude:e2e"), 5000, "the bind");
        const send = (fields, msgId) => phone.send({ type: "launcher_command", v: 2, sessionKey: "claude:e2e", msgId, ...fields });
        const ack = (msgId) => phone.waitFor("ack", (f) => f.msgId === msgId, 8000);

        // The fake runs the real hook-forward for PreCompact and PostCompact.
        send({ command: "compact" }, "e2e-compact");
        assert.equal((await ack("e2e-compact")).result, "applied");
        await run.until("Compacted");
        send({ command: "model", model: "sonnet" }, "e2e-model");
        assert.equal((await ack("e2e-model")).result, "applied");
        process.kill(pids.pid, "SIGUSR2");
        const state = await until(() => readJson(stateFile), 3000, "the fake's state");
        assert.deepEqual([state.model, state.dialogOpen, state.line], ["sonnet", false, ""]);
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
      }
    }),
  );
});

test("bind_before_any_hook_shows_the_session_in_launcher_mode", async () => {
  // Live smoke: Claude's own SessionStart reaches agentd before the launcher's bind, so it is
  // dropped as unattached. The bind itself must make the phone see the session, not the first prompt.
  await withBound(async ({ phone }) => {
    const upsert = await until(
      () => phone.frames.find((f) => f.type === "session_upsert" && f.session.id === ID && f.session.mode === "launcher"),
      3000,
      "an upsert at bind",
    );
    assert.equal(upsert.session.capabilities.compact, true);
    assert.equal(upsert.session.status, "idle");
    assert.equal(upsert.session.cwd, "/work/demo");
  }, { sessionStart: false, sessionCwd: "/work/demo" });
});

// R163: the launcher holds the dispatched reply (a laptop draft, say) and has
// typed nothing; whatever then waits on the wearer or the laptop cancels it.
test("stop_hold_opening_cancels_queued_command", async () => {
  await withBound(async ({ daemon, launcher, followup, ack, heldStop }) => {
    followup("R1", "sq1");
    const frame = await launcher.waitFor("type_command");
    const { reply } = await heldStop();
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    assert.equal((await ack("sq1")).error, "cancelled");
    // The launcher answers the cancel as the typist would; the hold ends at the laptop.
    launcher.send({ type: "command_result", cmdId: frame.cmdId, ok: false, error: "cancelled" });
    daemon.stopWait.releaseByLaptop(ID);
    assert.deepEqual(await reply, {});
    await settle(300);
    assert.equal(launcher.of("type_command").length, 1, "nothing is sent again");
  });
});

test("pending_approval_cancels_queued_command", async () => {
  await withBound(async ({ daemon, httpPort, launcher, followup, ack }) => {
    followup("R1", "pa1");
    const frame = await launcher.waitFor("type_command");
    const asked = postHook(httpPort, {
      hook_event_name: "PermissionRequest",
      session_id: ID,
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    assert.equal((await ack("pa1")).error, "cancelled");
    daemon.approvals.resolveSession(ID);
    await asked;
  });
  // A question waiting on the wearer does the same.
  await withBound(async ({ daemon, httpPort, launcher, followup, ack }) => {
    followup("R1", "pa2");
    const frame = await launcher.waitFor("type_command");
    const asked = postHook(httpPort, {
      hook_event_name: "PreToolUse",
      session_id: ID,
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_q1",
      tool_input: { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }] },
    });
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    assert.equal((await ack("pa2")).error, "cancelled");
    daemon.questionRelay.releaseByLaptop(ID);
    await asked;
  });
});

test("queued_reply_never_typed_after_a_later_laptop_turn", async () => {
  await withBound(async ({ httpPort, launcher, claude, followup, ack }) => {
    followup("yes, do it", "qr1");
    const frame = await launcher.waitFor("type_command");
    // The wearer's laptop turn T2 starts before the launcher could type R1.
    await postHook(httpPort, { hook_event_name: "UserPromptSubmit", session_id: ID, prompt: "T2" });
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    assert.equal((await ack("qr1")).error, "cancelled");
    // R149: the launcher hears of the prompt.
    const submitted = await launcher.waitFor("prompt_submitted");
    assert.equal(typeof submitted.at, "number");
    claude.write("busy");
    claude.write("idle");
    await settle(400);
    assert.equal(launcher.of("type_command").length, 1, "R1 is never sent again");
  });
});

// M7: the SessionStart replay on bind is for a session the store has never seen.
test("rebind_does_not_reset_an_existing_session_record", async () => {
  await withBound(async ({ daemon, httpPort, launcher, child }) => {
    await postHook(httpPort, { hook_event_name: "Notification", session_id: ID, message: "Claude needs your permission to use Bash" });
    assert.equal(daemon.sessions.get(ID).status, "needs_you");
    // The launcher's link blips; Claude's file still reads idle.
    launcher.close();
    await until(() => daemon.launchers.binding(KEY) === undefined, 3000, "the unbind");
    const again = await connect(daemon.launchers.socketPath);
    try {
      again.send({ type: "launcher_hello", v: 1, launcherId: "L2", provider: "claude", childPid: child.pid });
      again.send({ type: "launcher_bind", sessionId: ID });
      await again.waitFor("bind_accepted");
      assert.equal(daemon.sessions.get(ID).status, "needs_you");
      assert.equal(daemon.sessions.get(ID).pendingRequest?.kind, "permission");
    } finally {
      again.close();
    }
  });
});

// M9 and M5: /rokid:on in an rk claude session /rokid:off detached rebinds it
// there and then, so the reply is the launcher's and no retry is waited for.
// N2: the launcher is asked, and binds with its uncertainty as it is now.
test("rokid_on_after_off_rebinds_at_once_with_the_launcher_text", async () => {
  await withBound(async ({ daemon, httpPort, launcher }) => {
    await postHook(httpPort, { hook_event_name: "UserPromptExpansion", command_name: "rokid:off", session_id: ID });
    await launcher.waitFor("bind_rejected", (f) => f.reason === "detached");
    assert.equal(daemon.launchers.binding(KEY), undefined);
    const accepted = launcher.of("bind_accepted").length;
    const pending = postHook(httpPort, { hook_event_name: "UserPromptExpansion", command_name: "rokid:on", session_id: ID });
    await launcher.waitFor("bind_retry");
    launcher.send({ type: "launcher_bind", sessionId: ID, uncertain: false });
    const reply = await pending;
    assert.deepEqual(reply, { decision: "block", reason: LAUNCHER_ATTACH_TEXT });
    assert.ok(daemon.launchers.binding(KEY), "bound before the reply");
    assert.equal(daemon.attachRegistry.mode("claude", ID), "launcher");
    await until(() => launcher.of("bind_accepted").length > accepted, 2000, "the launcher told of it");
  });
});

// R165: a cancel crossing the launcher's first write on the socket.
test("late_command_written_after_cancel_consumes_msgid_and_acks_typed_after_cancel", async () => {
  await withBound(async ({ daemon, launcher, followup, ack, heldStop, noAck }) => {
    followup("R1", "lw1");
    const frame = await launcher.waitFor("type_command");
    const { reply } = await heldStop();
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    await noAck("lw1", 150);
    // The launcher had typed it already: its command_written was on the way.
    launcher.send({ type: "command_written", cmdId: frame.cmdId, at: Date.now() });
    launcher.send({ type: "command_result", cmdId: frame.cmdId, ok: true });
    assert.equal((await ack("lw1")).error, "typed_after_cancel");
    daemon.stopWait.releaseByLaptop(ID);
    await reply;
  });
});

test("resend_after_typed_after_cancel_is_duplicate_never_retyped", async () => {
  await withBound(async ({ daemon, phone, launcher, followup, ack, heldStop }) => {
    followup("R1", "lw2");
    const frame = await launcher.waitFor("type_command");
    const { reply } = await heldStop();
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    launcher.send({ type: "command_written", cmdId: frame.cmdId, at: Date.now() });
    assert.equal((await ack("lw2")).error, "typed_after_cancel");
    daemon.stopWait.releaseByLaptop(ID);
    await reply;
    phone.frames.length = 0;
    followup("R1", "lw2");
    assert.equal((await ack("lw2")).result, "duplicate");
    await settle(300);
    assert.equal(launcher.of("type_command").length, 1, "never typed again");
  });
});

test("cancel_without_write_still_rejected_cancelled_and_retryable", async () => {
  await withBound(async ({ daemon, phone, launcher, followup, ack, heldStop }) => {
    followup("R1", "lw3");
    const frame = await launcher.waitFor("type_command");
    const { reply } = await heldStop();
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    const cancelledAt = Date.now();
    // The launcher confirms it typed nothing; the ack need not wait out the window.
    launcher.send({ type: "command_result", cmdId: frame.cmdId, ok: false, error: "cancelled" });
    assert.equal((await ack("lw3")).error, "cancelled");
    assert.ok(Date.now() - cancelledAt < 450, "answered on the launcher's word");
    daemon.stopWait.releaseByLaptop(ID);
    await reply;
    // The msgId was not spent: the same reply may be sent again, and is typed.
    phone.frames.length = 0;
    followup("R1", "lw3");
    const again = await launcher.waitFor("type_command", (f) => f.cmdId !== frame.cmdId);
    answer(launcher, again);
    assert.equal((await ack("lw3")).result, "applied");
  });
});

test("timeout_cancel_then_late_command_written_acks_typed_after_cancel", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    command({ command: "compact" }, "lw4");
    const frame = await launcher.waitFor("type_command");
    // No answer within the 1.5 s compact window: agentd cancels.
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId, 4000);
    launcher.send({ type: "command_written", cmdId: frame.cmdId, at: Date.now() });
    assert.equal((await ack("lw4")).error, "typed_after_cancel");
  });
  // Nothing from the launcher at all: after the settle window it is a plain timeout.
  await withBound(async ({ launcher, command, ack }) => {
    command({ command: "compact" }, "lw5");
    const frame = await launcher.waitFor("type_command");
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId, 4000);
    assert.equal((await ack("lw5")).error, "timeout");
  });
});

// R152: the phone keeps a consumed command's id, so the ack must say it was consumed.
test("consumed_launcher_failure_ack_says_consumed", async () => {
  await withBound(async ({ launcher, command, ack }) => {
    // Typed, then the launcher reports a failure: the id is spent.
    command({ command: "compact" }, "cs1");
    const typed = await launcher.waitFor("type_command");
    launcher.send({ type: "command_written", cmdId: typed.cmdId, at: Date.now() });
    launcher.send({ type: "command_result", cmdId: typed.cmdId, ok: false, error: "dialog_not_seen" });
    const consumed = await ack("cs1");
    assert.deepEqual([consumed.result, consumed.error, consumed.consumed], ["rejected", "dialog_not_seen", true]);
  });
  await withBound(async ({ launcher, command, ack }) => {
    // Refused before anything was typed: the id is freed and the ack carries no `consumed`.
    command({ command: "compact" }, "cs2");
    const typed = await launcher.waitFor("type_command");
    launcher.send({ type: "command_result", cmdId: typed.cmdId, ok: false, error: "laptop_draft" });
    const freed = await ack("cs2");
    assert.deepEqual([freed.result, freed.error, "consumed" in freed], ["rejected", "laptop_draft", false]);
  });
  await withBound(async ({ launcher, ack, heldStop, daemon, followup }) => {
    // typed_after_cancel is consumed too.
    followup("R1", "cs3");
    const frame = await launcher.waitFor("type_command");
    const { reply } = await heldStop();
    await launcher.waitFor("cancel_command", (f) => f.cmdId === frame.cmdId);
    launcher.send({ type: "command_written", cmdId: frame.cmdId, at: Date.now() });
    const late = await ack("cs3");
    assert.deepEqual([late.error, late.consumed], ["typed_after_cancel", true]);
    daemon.stopWait.releaseByLaptop(ID);
    await reply;
  });
  await withBound(async ({ command, ack }) => {
    // A refusal that never reached the launcher carries no `consumed`.
    command({ command: "nonsense" }, "cs4");
    const bad = await ack("cs4");
    assert.deepEqual([bad.error, "consumed" in bad], ["bad_command", false]);
  });
});
