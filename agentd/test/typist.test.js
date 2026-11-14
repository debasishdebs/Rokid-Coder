const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { LaptopInput, Typist, sessionReady } = require("../dist/launcher/typist.js");
const { readClaudeSession } = require("../dist/launcher/claude-sessions.js");
const { spawnPty } = require("../dist/launcher/pty.js");
const { withTempDir } = require("./helpers/daemon.js");
const { FAKE_CLAUDE, until, waitDead, rkEnv, readJson } = require("./helpers/rk.js");

const PASTE = (text) => `\x1b[200~${text}\x1b[201~`;

class FakePty {
  constructor() {
    this.pid = 4242;
    this.writes = [];
    this.dataListeners = [];
    this.exitListeners = [];
  }
  write(data) {
    this.writes.push(data);
  }
  resize() {}
  endInput() {}
  kill() {}
  onData(cb) {
    this.dataListeners.push(cb);
  }
  onExit(cb) {
    this.exitListeners.push(cb);
  }
  emit(chunk) {
    for (const cb of this.dataListeners) cb(chunk);
  }
  die() {
    for (const cb of this.exitListeners) cb(0, null);
  }
}

/** Timers run only when the test advances time. */
class FakeClock {
  constructor() {
    this.t = 1_000_000;
    this.timers = [];
    this.seq = 0;
  }
  now() {
    return this.t;
  }
  setTimeout(cb, ms) {
    const id = ++this.seq;
    this.timers.push({ id, at: this.t + ms, cb });
    return id;
  }
  clearTimeout(id) {
    this.timers = this.timers.filter((timer) => timer.id !== id);
  }
  advance(ms) {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.cb();
    }
    this.t = end;
  }
}

/** Real timers, with time running `k` times faster than the wall clock. */
function scaledClock(k) {
  const base = Date.now();
  return {
    now: () => base + (Date.now() - base) * k,
    setTimeout: (cb, ms) => setTimeout(cb, ms / k),
    clearTimeout: (handle) => clearTimeout(handle),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function track(promise) {
  const box = { result: undefined };
  promise.then((result) => {
    box.result = result;
  });
  return box;
}

/** A typist over a fake pty and clock, with the session file as a plain object. */
function setup({ gen = 1 } = {}) {
  const pty = new FakePty();
  const clock = new FakeClock();
  const input = new LaptopInput();
  const session = { status: "idle", statusUpdatedAt: clock.now() - 10_000 };
  const binding = { gen, uncertain: false };
  const written = [];
  const typist = new Typist(pty, input, (after) => sessionReady(session, after), clock, {
    binding,
    onWritten: (cmdId, at) => written.push({ cmdId, at }),
  });
  // rk's stdin path: a passed key goes to the child, then anything a takeover released.
  const type = (data) => {
    const verdict = input.key(data);
    if (verdict === "pass") {
      pty.write(data);
      const held = input.flushHeld();
      if (held) pty.write(held);
    }
    return verdict;
  };
  const run = async (cmd, ms = 0) => {
    const box = track(typist.run({ cmdId: "c1", gen, ...cmd }));
    clock.advance(ms);
    await flush();
    return box;
  };
  const advance = async (ms) => {
    clock.advance(ms);
    await flush();
  };
  return { pty, clock, input, session, binding, written, typist, type, run, advance };
}

/** Moves the session through busy to a fresh idle, as Claude's own file would. */
function freshIdle(t) {
  t.session.status = "idle";
  t.session.statusUpdatedAt = t.clock.now();
}

test("never_types_over_laptop_draft_and_fails_laptop_draft_after_60s", async () => {
  const t = setup();
  t.type("half a thou");
  t.pty.writes.length = 0;
  const box = await t.run({ command: "text", text: "from the glasses" });
  await t.advance(59_900);
  assert.equal(box.result, undefined, "still waiting for the draft");
  assert.deepEqual(t.pty.writes, [], "nothing typed over the draft");
  await t.advance(200);
  assert.deepEqual(box.result, { ok: false, error: "laptop_draft" });
  assert.deepEqual(t.pty.writes, []);
  assert.equal(t.input.draft, true);
  t.typist.dispose();
});

test("a_busy_session_fails_busy_after_60s", async () => {
  const t = setup();
  t.session.status = "busy";
  const box = await t.run({ command: "compact" }, 60_100);
  assert.deepEqual(box.result, { ok: false, error: "busy" });
  assert.deepEqual(t.pty.writes, []);
  t.typist.dispose();
});

test("draft_on_the_real_fake_is_never_appended_to", async () => {
  await withTempDir(async (dir) => {
    const { env, sessionsDir } = await rkEnv(dir, { FAKE_STATE_FILE: path.join(dir, "state.json") });
    const child = spawnPty(process.execPath, [FAKE_CLAUDE], { cwd: dir, env, cols: 100, rows: 40 });
    let out = "";
    child.onData((chunk) => {
      out += chunk;
    });
    const input = new LaptopInput();
    const binding = { gen: 1, uncertain: false };
    const typist = new Typist(child, input, (after) => sessionReady(readClaudeSession(sessionsDir, child.pid), after), scaledClock(20), {
      binding,
    });
    try {
      await until(() => out.includes("fake-claude ready"), 5000, "the fake");
      if (input.key("half") === "pass") child.write("half");
      await until(() => out.includes("half"), 5000, "the echo");
      const result = await typist.run({ cmdId: "c1", gen: 1, command: "compact" });
      assert.deepEqual(result, { ok: false, error: "laptop_draft" });
      const state = await dumpState(child.pid, path.join(dir, "state.json"));
      assert.equal(state.line, "half", "the draft is untouched");
      assert.equal(state.status, "idle");
    } finally {
      typist.dispose();
      child.kill("SIGKILL");
      await waitDead(child.pid);
    }
  });
});

test("draft_cleared_by_enter_or_ctrl_c_then_command_runs", async () => {
  for (const clear of ["\r", "\x03"]) {
    const t = setup();
    t.type("draft");
    const box = await t.run({ command: "compact" }, 5000);
    assert.equal(box.result, undefined);
    t.type(clear);
    assert.equal(t.input.draft, false, JSON.stringify(clear));
    t.pty.writes.length = 0;
    await t.advance(600);
    assert.deepEqual(t.pty.writes, ["/compact\r"]);
    assert.deepEqual(box.result, { ok: true });
    t.typist.dispose();
  }
});

test("paste_marks_draft", () => {
  const input = new LaptopInput();
  assert.equal(input.draft, false);
  assert.equal(input.key(PASTE("pasted")), "pass");
  assert.equal(input.draft, true);
  // A Ctrl-C inside a paste is pasted text, not a clear.
  const other = new LaptopInput();
  other.key(PASTE("a\x03b"));
  assert.equal(other.draft, true);
});

test("up_arrow_recall_marks_draft", () => {
  for (const key of ["\x1b[A", "\x1bOA", "\x1b[B", "\t", "\x7f", "\b", "x"]) {
    const input = new LaptopInput();
    input.key(key);
    assert.equal(input.draft, true, JSON.stringify(key));
  }
  // Cursor moves on an empty prompt change nothing.
  const input = new LaptopInput();
  input.key("\x1b[D");
  input.key("\x1b[C");
  assert.equal(input.draft, false);
});

test("ctrl_u_does_not_clear_draft", () => {
  const input = new LaptopInput();
  input.key("abc");
  input.key("\x1b[D");
  input.key("\x15");
  assert.equal(input.draft, true);
  input.key("\r");
  assert.equal(input.draft, false);
});

test("draft_changes_are_reported", () => {
  const input = new LaptopInput();
  const seen = [];
  input.onDraftChange((draft) => seen.push(draft));
  input.key("a");
  input.key("b");
  input.key("\r");
  input.key("\r");
  assert.deepEqual(seen, [true, false]);
});

test("statusUpdatedAt_older_than_notBefore_is_not_ready", async () => {
  const t = setup();
  const notBefore = t.clock.now();
  t.session.statusUpdatedAt = notBefore - 1;
  const box = await t.run({ command: "compact", notBefore }, 10_000);
  assert.deepEqual(t.pty.writes, [], "an idle read from before the barrier is stale");
  t.session.statusUpdatedAt = notBefore; // equal is not later
  await t.advance(1000);
  assert.deepEqual(t.pty.writes, []);
  freshIdle(t);
  await t.advance(200);
  assert.deepEqual(t.pty.writes, ["/compact\r"]);
  assert.deepEqual(box.result, { ok: true });
  assert.equal(sessionReady(undefined), false, "no file is not ready");
  t.typist.dispose();
});

test("already_idle_session_first_write_allowed_without_new_timestamp", async () => {
  const t = setup();
  const box = await t.run({ command: "compact" }, 600);
  assert.deepEqual(t.pty.writes, ["/compact\r"]);
  assert.deepEqual(box.result, { ok: true });
  assert.equal(t.written.length, 1, "command_written follows the first write");
  assert.equal(t.written[0].cmdId, "c1");
  assert.ok(t.written[0].at <= t.clock.now());
  t.typist.dispose();
});

test("output_quiet_500ms_required_before_first_write", async () => {
  const t = setup();
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "compact" }));
  for (let i = 0; i < 20; i += 1) {
    t.pty.emit("spinner");
    await t.advance(400);
  }
  assert.deepEqual(t.pty.writes, []);
  await t.advance(600);
  assert.deepEqual(t.pty.writes, ["/compact\r"]);
  await flush();
  assert.deepEqual(box.result, { ok: true });
  t.typist.dispose();
});

test("readiness_rechecked_before_each_commands_first_write", async () => {
  const t = setup();
  let reads = 0;
  const ready = (after) => {
    reads += 1;
    return sessionReady(t.session, after);
  };
  const typist = new Typist(t.pty, t.input, ready, t.clock, { binding: t.binding });
  const first = track(typist.run({ cmdId: "a", gen: 1, command: "text", text: "one" }));
  await t.advance(600);
  assert.deepEqual(first.result, { ok: true });
  // The first command left the session busy; the second waits for a fresh idle.
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  const before = reads;
  const second = track(typist.run({ cmdId: "b", gen: 1, command: "text", text: "two", notBefore: t.clock.now() }));
  await t.advance(3000);
  assert.ok(reads > before, "the file is read again for the second command");
  assert.equal(t.pty.writes.length, 1);
  assert.equal(second.result, undefined);
  freshIdle(t);
  await t.advance(600);
  assert.equal(t.pty.writes.length, 2);
  assert.deepEqual(second.result, { ok: true });
  typist.dispose();
  t.typist.dispose();
});

test("stale_gen_command_dropped_before_write", async () => {
  const t = setup({ gen: 2 });
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "compact" }));
  await t.advance(1000);
  assert.deepEqual(box.result, { ok: false, error: "cancelled" });
  assert.deepEqual(t.pty.writes, []);

  // A rebind while the command waits drops it too.
  const u = setup({ gen: 1 });
  u.session.status = "busy";
  const waiting = track(u.typist.run({ cmdId: "c2", gen: 1, command: "compact" }));
  await u.advance(1000);
  u.binding.gen = 2;
  u.session.status = "idle";
  await u.advance(1000);
  assert.deepEqual(waiting.result, { ok: false, error: "cancelled" });
  assert.deepEqual(u.pty.writes, []);
  t.typist.dispose();
  u.typist.dispose();
});

test("uncertain_binding_refuses_before_write", async () => {
  const t = setup();
  t.binding.uncertain = true;
  const box = await t.run({ command: "compact" }, 1000);
  assert.deepEqual(box.result, { ok: false, error: "uncertain" });
  assert.deepEqual(t.pty.writes, []);
  t.typist.dispose();
});

test("cancel_while_waiting_writes_nothing", async () => {
  const t = setup();
  t.session.status = "busy";
  const box = await t.run({ command: "model", model: "haiku" }, 2000);
  t.typist.cancel("other");
  await t.advance(100);
  assert.equal(box.result, undefined, "another id cancels nothing");
  t.typist.cancel("c1");
  await flush();
  assert.deepEqual(box.result, { ok: false, error: "cancelled" });
  t.session.status = "idle";
  await t.advance(5000);
  assert.deepEqual(t.pty.writes, []);
  t.typist.dispose();
});

test("concurrent_run_is_busy", async () => {
  const t = setup();
  t.session.status = "busy";
  const first = await t.run({ command: "compact" }, 100);
  const second = await t.run({ cmdId: "c2", command: "compact" });
  assert.deepEqual(second.result, { ok: false, error: "busy" });
  assert.equal(first.result, undefined);
  t.typist.dispose();
});

test("child_exit_fails_the_pending_command_exited", async () => {
  const t = setup();
  t.session.status = "busy";
  const box = await t.run({ command: "compact" }, 100);
  t.pty.die();
  await flush();
  assert.deepEqual(box.result, { ok: false, error: "exited" });
  t.typist.dispose();
});

test("text_is_one_bracketed_paste_then_enter_and_cannot_break_out", async () => {
  const t = setup();
  const box = await t.run({ command: "text", text: "line one\r\nline two\x1b[201~\x03 tail" }, 600);
  assert.deepEqual(box.result, { ok: true });
  assert.deepEqual(t.pty.writes, [`${PASTE("line one\nline two[201~ tail")}\r`]);
  t.typist.dispose();

  const u = setup();
  const long = await u.run({ command: "text", text: "x".repeat(16 * 1024 + 1) }, 600);
  assert.deepEqual(long.result, { ok: false, error: "not_ready" });
  assert.deepEqual(u.pty.writes, []);
  u.typist.dispose();
});

test("model_outside_the_offered_aliases_is_never_typed", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "opus\r/exit" }, 600);
  assert.deepEqual(box.result, { ok: false, error: "not_ready" });
  assert.deepEqual(t.pty.writes, []);
  t.typist.dispose();
});

test("confirm_write_gated_by_scanner_not_by_file", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  assert.deepEqual(t.pty.writes, ["/model haiku\r"]);
  // The dialog makes the file read busy; the confirm still goes, on the marker alone.
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  await t.advance(1000);
  assert.deepEqual(t.pty.writes, ["/model haiku\r"], "no confirm before the marker");
  t.pty.emit("\x1b[1mSwitch model?\x1b[0m\r\n");
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"]);
  t.pty.emit("Set model to haiku\r\n");
  await flush();
  assert.deepEqual(box.result, { ok: true });
  t.typist.dispose();
});

test("scanner_starts_at_first_write", async () => {
  const t = setup();
  t.session.status = "busy";
  const box = await t.run({ command: "model", model: "sonnet" }, 30_000);
  assert.deepEqual(t.pty.writes, []);
  t.session.status = "idle";
  await t.advance(600);
  assert.deepEqual(t.pty.writes, ["/model sonnet\r"]);
  // The 5 s dialog window runs from the write, not from when the command arrived.
  await t.advance(4000);
  t.pty.emit("Switch model?");
  assert.deepEqual(t.pty.writes, ["/model sonnet\r", "\r"]);
  t.pty.emit("Set model to sonnet");
  await flush();
  assert.deepEqual(box.result, { ok: true });
  t.typist.dispose();
});

test("stale_marker_before_write_not_accepted", async () => {
  const t = setup();
  t.type("x");
  const box = await t.run({ command: "model", model: "haiku" }, 1000);
  // A dialog from earlier, seen while the command waits for the draft.
  t.pty.emit("Switch model?\r\nSet model to opus\r\n");
  t.type("\x03");
  t.pty.writes.length = 0;
  await t.advance(600);
  assert.deepEqual(t.pty.writes, ["/model haiku\r"]);
  await t.advance(5100);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"], "no confirm on the stale marker; recovery instead");
  await t.advance(1100);
  assert.deepEqual(box.result, { ok: false, error: "dialog_not_seen" });
  t.typist.dispose();
});

test("failed_model_recovery_marks_uncertain", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  t.pty.emit("Switch model?");
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"]);
  // The result never shows: Esc, a second of quiet, then dialog_not_seen.
  await t.advance(10_100);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r", "\x1b"]);
  assert.equal(box.result, undefined, "it waits for quiet first");
  t.pty.emit("redraw");
  await t.advance(900);
  assert.equal(box.result, undefined, "output resets the quiet second");
  await t.advance(200);
  assert.deepEqual(box.result, { ok: false, error: "dialog_not_seen" });
  assert.equal(t.binding.uncertain, true, "Esc success is never assumed");
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r", "\x1b"], "Esc only");
  const next = await t.run({ cmdId: "c2", command: "text", text: "hi" }, 1000);
  assert.deepEqual(next.result, { ok: false, error: "uncertain" });
  t.typist.dispose();
});

test("cancel_between_model_writes_sends_esc_only_and_marks_uncertain", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  t.typist.cancel("c1");
  await flush();
  assert.deepEqual(box.result, { ok: false, error: "cancelled" });
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"]);
  assert.equal(t.binding.uncertain, true);
  t.pty.emit("Switch model?");
  await t.advance(20_000);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"], "nothing after the Esc");
  t.typist.dispose();
});

test("cancel_between_model_writes_leaves_the_real_fake_clean", async () => {
  await withFake({}, async ({ typist, binding, state, hooks }) => {
    hooks.onWritten = () => typist.cancel("c1");
    const done = typist.run({ cmdId: "c1", gen: 1, command: "model", model: "haiku" });
    assert.deepEqual(await done, { ok: false, error: "cancelled" });
    assert.equal(binding.uncertain, true);
    const end = await until(async () => {
      const s = await state();
      return s.status === "idle" ? s : undefined;
    }, 5000, "the fake to settle");
    assert.deepEqual({ dialogOpen: end.dialogOpen, line: end.line, model: end.model }, { dialogOpen: false, line: "", model: "opus" });
  });
});

test("model_no_dialog_recovers_and_fake_state_clean", async () => {
  await withFake({ FAKE_NO_DIALOG: "1" }, async ({ typist, binding, state, writes }) => {
    const result = await typist.run({ cmdId: "c1", gen: 1, command: "model", model: "haiku" });
    assert.deepEqual(result, { ok: false, error: "dialog_not_seen" });
    assert.equal(binding.uncertain, true);
    assert.deepEqual(writes, ["/model haiku\r", "\x1b"]);
    const end = await state();
    assert.deepEqual({ dialogOpen: end.dialogOpen, line: end.line, model: end.model }, { dialogOpen: false, line: "", model: "opus" });
  });
});

test("model_switch_on_the_real_fake_succeeds", async () => {
  await withFake({}, async ({ typist, binding, state, writes }) => {
    const result = await typist.run({ cmdId: "c1", gen: 1, command: "model", model: "sonnet" });
    assert.deepEqual(result, { ok: true });
    assert.equal(binding.uncertain, false);
    assert.deepEqual(writes, ["/model sonnet\r", "\r"]);
    const end = await state();
    assert.deepEqual({ dialogOpen: end.dialogOpen, line: end.line, model: end.model }, { dialogOpen: false, line: "", model: "sonnet" });
  });
});

test("esc_during_model_takes_over_and_writes_nothing_more", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  t.type("ab");
  assert.deepEqual(t.pty.writes, ["/model haiku\r"], "keys are held while automation owns input");
  assert.equal(t.type("\x1b"), "pass");
  await flush();
  assert.deepEqual(box.result, { ok: false, error: "taken_over" });
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b", "ab"], "Esc, then the held keys");
  t.pty.emit("Switch model?\r\nSet model to haiku");
  await t.advance(20_000);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b", "ab"]);
  assert.equal(t.binding.uncertain, false);
  // The user owns input again.
  assert.equal(t.type("c"), "pass");
  t.typist.dispose();
});

test("user_keys_held_during_model_and_replayed_after_positive_idle", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  const firstWrite = t.clock.now();
  t.session.status = "busy";
  t.session.statusUpdatedAt = firstWrite;
  assert.equal(t.type("he"), "hold");
  t.pty.emit("Switch model?");
  assert.equal(t.type("llo"), "hold");
  t.pty.emit("Set model to haiku");
  await t.advance(100);
  assert.deepEqual(box.result, { ok: true });
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"]);
  await t.advance(5000);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"], "busy: still held");
  assert.equal(t.type("!"), "hold", "and still owned");
  freshIdle(t);
  await t.advance(200);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r", "hello!"]);
  assert.equal(t.type("x"), "pass");
  assert.equal(t.input.draft, true, "the replayed keys are a draft");
  t.typist.dispose();
});

test("keys_held_through_compact_until_compact_done", async () => {
  const t = setup();
  const box = await t.run({ command: "compact" }, 600);
  assert.deepEqual(box.result, { ok: true }, "ok once written");
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  assert.equal(t.type("next"), "hold");
  await t.advance(30_000);
  freshIdle(t); // the file goes idle before agentd has correlated the PostCompact
  await t.advance(5000);
  assert.deepEqual(t.pty.writes, ["/compact\r"], "held until compact_done");
  const next = await t.run({ cmdId: "c2", command: "compact" });
  assert.deepEqual(next.result, { ok: false, error: "busy" }, "the compact still runs");
  t.typist.compactDone("other");
  await t.advance(500);
  assert.deepEqual(t.pty.writes, ["/compact\r"]);
  t.typist.compactDone("c1");
  await t.advance(200);
  assert.deepEqual(t.pty.writes, ["/compact\r", "next"]);
  t.typist.dispose();
});

test("held_keys_not_replayed_after_compact_timeout_until_idle_or_takeover", async () => {
  for (const release of ["idle", "takeover"]) {
    const t = setup();
    await t.run({ command: "compact" }, 600);
    t.session.status = "busy";
    t.session.statusUpdatedAt = t.clock.now();
    t.type("queued");
    await t.advance(180_000 + 1000);
    assert.equal(t.type("more"), "hold", "past the compact window the keys stay held");
    // A new command waits behind the held keys.
    const next = await t.run({ cmdId: "c2", command: "text", text: "glasses" }, 2000);
    assert.equal(next.result, undefined);
    assert.deepEqual(t.pty.writes, ["/compact\r"]);
    if (release === "idle") {
      freshIdle(t);
      await t.advance(200);
      assert.deepEqual(t.pty.writes, ["/compact\r", "queuedmore"]);
    } else {
      assert.equal(t.type("\x03"), "pass");
      assert.deepEqual(t.pty.writes, ["/compact\r", "\x03", "queuedmore"]);
    }
    // The replayed keys are a draft, so the waiting command never types over them.
    await t.advance(60_000);
    assert.deepEqual(next.result, { ok: false, error: "laptop_draft" });
    t.typist.dispose();
  }
});

test("held_keys_not_replayed_after_failed_model_recovery_until_idle_or_takeover", async () => {
  for (const release of ["idle", "takeover"]) {
    const t = setup();
    const box = await t.run({ command: "model", model: "haiku" }, 600);
    t.type("typed");
    await t.advance(5100 + 1100);
    assert.deepEqual(box.result, { ok: false, error: "dialog_not_seen" });
    assert.equal(t.binding.uncertain, true);
    freshIdle(t);
    await t.advance(5000);
    assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"], "an uncertain binding is not positively ready");
    if (release === "idle") {
      // agentd's binding_state clears it once the prompt is shown usable.
      t.binding.uncertain = false;
      await t.advance(200);
      assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b", "typed"]);
    } else {
      assert.equal(t.type("\x1b"), "pass");
      assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b", "\x1b", "typed"]);
    }
    t.typist.dispose();
  }
});

/** Asks the fake for its state and reads the dump. */
async function dumpState(pid, file) {
  fs.rmSync(file, { force: true });
  process.kill(pid, "SIGUSR2");
  return until(() => readJson(file), 5000, "the fake's state dump");
}

/** A typist on the real fake, with a 20x clock so the 5 s and 1 s windows pass quickly. */
async function withFake(extra, body) {
  await withTempDir(async (dir) => {
    const stateFile = path.join(dir, "state.json");
    const { env, sessionsDir } = await rkEnv(dir, { FAKE_STATE_FILE: stateFile, ...extra });
    const child = spawnPty(process.execPath, [FAKE_CLAUDE], { cwd: dir, env, cols: 100, rows: 40 });
    let out = "";
    child.onData((chunk) => {
      out += chunk;
    });
    const writes = [];
    const recording = {
      get pid() {
        return child.pid;
      },
      write: (data) => {
        writes.push(data);
        child.write(data);
      },
      resize: (c, r) => child.resize(c, r),
      endInput: () => child.endInput(),
      kill: (s) => child.kill(s),
      onData: (cb) => child.onData(cb),
      onExit: (cb) => child.onExit(cb),
    };
    const binding = { gen: 1, uncertain: false };
    const hooks = { onWritten: () => {} };
    const ready = (after) => sessionReady(readClaudeSession(sessionsDir, child.pid), after);
    const typist = new Typist(recording, new LaptopInput(), ready, scaledClock(20), {
      binding,
      onWritten: (cmdId, at) => hooks.onWritten(cmdId, at),
    });
    try {
      await until(() => out.includes("fake-claude ready"), 5000, "the fake");
      await body({ child, typist, binding, writes, hooks, state: () => dumpState(child.pid, stateFile) });
    } finally {
      typist.dispose();
      child.kill("SIGKILL");
      await waitDead(child.pid);
    }
  });
}
