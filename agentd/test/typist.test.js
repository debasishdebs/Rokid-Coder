const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Typist, sessionReady } = require("../dist/launcher/typist.js");
const { LaptopInput, sessionBusySince } = require("../dist/launcher/laptop-input.js");
const { readClaudeSession } = require("../dist/launcher/claude-sessions.js");
const { LauncherClient } = require("../dist/launcher/launcher-client.js");
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
  const session = { status: "idle", statusUpdatedAt: clock.now() - 10_000 };
  const input = new LaptopInput({ clock, busySince: (at) => sessionBusySince(session, at) });
  const binding = { gen, uncertain: false };
  const written = [];
  const typist = new Typist(pty, input, (after) => sessionReady(session, after), clock, {
    binding,
    onWritten: (cmdId, at) => written.push({ cmdId, at }),
  });
  // rk's stdin path: a passed key goes to the child; the typist replays what a takeover released.
  const type = (data) => {
    const verdict = input.key(data);
    if (verdict === "pass") {
      pty.write(data);
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
    const clock = scaledClock(20);
    const input = new LaptopInput({ clock });
    const binding = { gen: 1, uncertain: false };
    const typist = new Typist(child, input, (after) => sessionReady(readClaudeSession(sessionsDir, child.pid), after), clock, {
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
    if (clear === "\r") {
      // R145: the Enter counts once Claude's file shows the submit.
      assert.equal(t.input.draft, true, "not before the proof");
      await t.advance(200);
      t.session.status = "busy";
      t.session.statusUpdatedAt = t.clock.now();
      await t.advance(200);
      freshIdle(t);
    }
    assert.equal(t.input.draft, false, JSON.stringify(clear));
    t.pty.writes.length = 0;
    await t.advance(600);
    assert.deepEqual(t.pty.writes, ["/compact\r"]);
    assert.deepEqual(box.result, { ok: true });
    t.typist.dispose();
  }
});

const bareInput = () => new LaptopInput({ clock: new FakeClock() });

test("paste_marks_draft", () => {
  const input = bareInput();
  assert.equal(input.draft, false);
  assert.equal(input.key(PASTE("pasted")), "pass");
  assert.equal(input.draft, true);
  // A Ctrl-C inside a paste is pasted text, not a clear.
  const other = bareInput();
  other.key(PASTE("a\x03b"));
  assert.equal(other.draft, true);
});

test("up_arrow_recall_marks_draft", () => {
  for (const key of ["\x1b[A", "\x1bOA", "\x1b[B", "\t", "\x7f", "\b", "x"]) {
    const input = bareInput();
    input.key(key);
    assert.equal(input.draft, true, JSON.stringify(key));
  }
  // Cursor moves on an empty prompt change nothing.
  const input = bareInput();
  input.key("\x1b[D");
  input.key("\x1b[C");
  assert.equal(input.draft, false);
});

test("ctrl_u_does_not_clear_draft", () => {
  const input = bareInput();
  input.key("abc");
  input.key("\x1b[D");
  input.key("\x15");
  assert.equal(input.draft, true);
  input.key("\x03");
  assert.equal(input.draft, false);
});

test("draft_changes_are_reported", () => {
  const input = bareInput();
  const seen = [];
  input.onDraftChange((draft) => seen.push(draft));
  input.key("a");
  input.key("b");
  input.key("\x03");
  input.key("\x03");
  assert.deepEqual(seen, [true, false]);
});

test("user_esc_marks_draft", async () => {
  // On an empty prompt: Esc may restore queued text or open the rewind selector.
  const input = bareInput();
  input.key("\x1b");
  assert.equal(input.draft, true);
  input.key("\x03");
  assert.equal(input.draft, false);
  // While automation owns input, the Esc that takes over marks it too.
  const t = setup();
  await t.run({ command: "compact" }, 600);
  assert.equal(t.input.draft, false);
  assert.equal(t.type("\x1b"), "pass");
  assert.equal(t.input.draft, true);
  t.typist.dispose();
});

test("enter_with_busy_flip_clears_draft", async () => {
  const t = setup();
  const seen = [];
  t.input.onDraftChange((draft) => seen.push(draft));
  t.type("hello");
  t.type("\r");
  await t.advance(1000);
  assert.equal(t.input.draft, true);
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  await t.advance(100);
  assert.equal(t.input.draft, false);
  assert.deepEqual(seen, [true, false]);
  t.typist.dispose();
});

test("enter_without_busy_flip_keeps_draft", async () => {
  const t = setup();
  t.type("hello");
  // A busy read from before the Enter proves nothing.
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now() - 1;
  t.type("\r");
  await t.advance(1600);
  assert.equal(t.input.draft, true);
  // Nor does a flip after the 1.5 s window.
  t.session.statusUpdatedAt = t.clock.now();
  await t.advance(1000);
  assert.equal(t.input.draft, true);
  t.typist.dispose();
});

test("backslash_enter_keeps_draft", async () => {
  const t = setup();
  t.type("first line \\");
  t.type("\r");
  t.type("second");
  await t.advance(2000);
  assert.equal(t.input.draft, true);
  const box = await t.run({ command: "text", text: "glasses" }, 60_100);
  assert.deepEqual(box.result, { ok: false, error: "laptop_draft" });
  assert.deepEqual(t.pty.writes.filter((w) => w.includes("glasses")), []);
  t.typist.dispose();
});

test("meta_enter_keeps_draft", async () => {
  const t = setup();
  t.type("first line");
  t.type("\x1b\r");
  await t.advance(2000);
  assert.equal(t.input.draft, true);
  t.typist.dispose();
});

test("mouse_reports_type_nothing_and_a_bad_csi_does_not_hide_a_ctrl_c", () => {
  const input = bareInput();
  input.key("\x1b[<0;12;5M");
  input.key("\x1b[<64;12;5m");
  assert.equal(input.draft, false, "a click or a wheel turn is not a draft");
  const other = bareInput();
  other.key("ab");
  other.key("\x1b[1\x03");
  assert.equal(other.draft, false, "the Ctrl-C after a malformed CSI still clears");
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

test("esc_takeover_during_dialog_leaves_the_real_fake_clean", async () => {
  await withFake({}, async ({ child, typist, input, binding, state, writes, hooks }) => {
    // The user presses Esc the moment the command is typed, before the dialog's marker.
    hooks.onWritten = () => {
      if (input.key("\x1b") === "pass") child.write("\x1b");
    };
    const result = await typist.run({ cmdId: "c1", gen: 1, command: "model", model: "haiku" });
    assert.deepEqual(result, { ok: false, error: "taken_over" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(writes, ["/model haiku\r"], "nothing more after the takeover");
    assert.equal(binding.uncertain, false);
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
  // R151: keys typed while the dialog may be open are dropped, never replayed into it.
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"]);
  t.pty.emit("Switch model?\r\nSet model to haiku");
  await t.advance(20_000);
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"]);
  assert.equal(t.binding.uncertain, false);
  // The user owns input again.
  assert.equal(t.type("c"), "pass");
  t.typist.dispose();
});

test("input_free_after_model_ok_without_status_bump_and_dialog_keys_dropped", async () => {
  const t = setup();
  let dropped = 0;
  t.input.onKeysDropped(() => dropped++);
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  // The dialog made the file busy; it never goes idle again after the switch.
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  assert.equal(t.type("he"), "hold");
  t.pty.emit("Switch model?");
  assert.equal(t.type("llo\r"), "hold");
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"], "held while the command owns input");
  t.pty.emit("Set model to haiku");
  // R142: the result frees input at once. R151: nothing typed into the dialog is replayed.
  assert.deepEqual(t.pty.writes, ["/model haiku\r", "\r"]);
  assert.equal(dropped, 1, "the user is told once per hold");
  await flush();
  assert.deepEqual(box.result, { ok: true });
  assert.equal(t.input.holding, false);
  assert.equal(t.input.draft, false, "dropped keys never reached the prompt");
  assert.equal(t.type("!"), "pass");
  t.typist.dispose();
});

test("text_command_does_not_freeze_laptop_keys", async () => {
  const t = setup();
  const box = await t.run({ command: "text", text: "from the glasses" }, 600);
  assert.deepEqual(box.result, { ok: true });
  // Claude's turn: the file reads busy. The user answers a prompt at the laptop.
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  assert.equal(t.type("1"), "pass");
  assert.equal(t.type("\r"), "pass");
  assert.deepEqual(t.pty.writes.slice(1), ["1", "\r"]);
  t.typist.dispose();
});

test("cancel_after_compact_ok_releases_ownership", async () => {
  // Without a cancel the compact owns input until compact_done.
  const t = setup();
  const box = await t.run({ command: "compact" }, 600);
  assert.deepEqual(box.result, { ok: true });
  assert.equal(t.input.holding, true);
  t.typist.dispose();

  // Cancelled with nothing held: the keyboard is free at once.
  const u = setup();
  await u.run({ command: "compact" }, 600);
  u.session.status = "busy";
  u.session.statusUpdatedAt = u.clock.now();
  u.typist.cancel("c1");
  assert.equal(u.input.holding, false);
  assert.equal(u.type("x"), "pass");
  assert.deepEqual(u.pty.writes, ["/compact\r", "x"]);
  const next = await u.run({ cmdId: "c2", command: "compact" });
  assert.equal(next.result, undefined, "the typist is free for the next command");
  u.typist.dispose();

  // Keys already held wait for positive readiness, or a takeover.
  for (const release of ["idle", "takeover"]) {
    const v = setup();
    await v.run({ command: "compact" }, 600);
    v.session.status = "busy";
    v.session.statusUpdatedAt = v.clock.now();
    assert.equal(v.type("q"), "hold");
    v.typist.cancel("c1");
    assert.equal(v.type("w"), "hold", "still behind the held key");
    await v.advance(5000);
    assert.deepEqual(v.pty.writes, ["/compact\r"]);
    if (release === "idle") {
      freshIdle(v);
      await v.advance(200);
      assert.deepEqual(v.pty.writes, ["/compact\r", "qw"]);
    } else {
      assert.equal(v.type("\x03"), "pass");
      await v.advance(100);
      assert.deepEqual(v.pty.writes, ["/compact\r", "\x03", "qw"]);
    }
    v.typist.dispose();
  }
});

test("dispose_fails_a_running_command_exited_and_holds_nothing", async () => {
  const t = setup();
  const box = await t.run({ command: "model", model: "haiku" }, 600);
  t.type("k");
  t.typist.dispose();
  await flush();
  assert.deepEqual(box.result, { ok: false, error: "exited" });
  assert.equal(t.input.holding, false);
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
      await t.advance(100);
      assert.deepEqual(t.pty.writes, ["/compact\r", "\x03", "queuedmore"]);
    }
    // The replayed keys are a draft, so the waiting command never types over them.
    await t.advance(60_000);
    assert.deepEqual(next.result, { ok: false, error: "laptop_draft" });
    t.typist.dispose();
  }
});

test("keys_after_failed_model_recovery_dropped_until_idle_or_takeover", async () => {
  for (const release of ["idle", "takeover"]) {
    const t = setup();
    const box = await t.run({ command: "model", model: "haiku" }, 600);
    t.type("typed");
    await t.advance(5100 + 1100);
    assert.deepEqual(box.result, { ok: false, error: "dialog_not_seen" });
    assert.equal(t.binding.uncertain, true);
    assert.equal(t.type("\r"), "hold", "an uncertain prompt may still show the dialog");
    await t.advance(5000);
    assert.deepEqual(t.pty.writes, ["/model haiku\r", "\x1b"], "an uncertain binding is not positively ready");
    if (release === "idle") {
      // R161: Claude's file shows idle after the write, which is the launcher's own proof.
      freshIdle(t);
      await t.advance(200);
      assert.equal(t.binding.uncertain, false);
      assert.equal(t.input.holding, false);
    } else {
      assert.equal(t.type("\x1b"), "pass");
      await t.advance(200);
    }
    // R151: nothing typed while the dialog may have been open is replayed.
    assert.deepEqual(t.pty.writes.filter((w) => w !== "\x1b"), ["/model haiku\r"]);
    assert.equal(t.type("x"), "pass");
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
    const clock = scaledClock(20);
    const input = new LaptopInput({ clock, busySince: (at) => sessionBusySince(readClaudeSession(sessionsDir, child.pid), at) });
    const typist = new Typist(recording, input, ready, clock, {
      binding,
      onWritten: (cmdId, at) => hooks.onWritten(cmdId, at),
    });
    try {
      await until(() => out.includes("fake-claude ready"), 5000, "the fake");
      await body({ child, typist, input, binding, writes, hooks, state: () => dumpState(child.pid, stateFile) });
    } finally {
      typist.dispose();
      child.kill("SIGKILL");
      await waitDead(child.pid);
    }
  });
}

test("takeover_esc_then_held_keys_after_gap_no_alt_chord", async () => {
  const t = setup();
  await t.run({ command: "compact" }, 600);
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now();
  assert.equal(t.type("ab"), "hold");
  assert.equal(t.type("\x1b"), "pass");
  assert.deepEqual(t.pty.writes, ["/compact\r", "\x1b"], "the Esc goes alone");
  await t.advance(99);
  assert.equal(t.type("c"), "hold", "a key in the gap queues behind the held ones");
  assert.deepEqual(t.pty.writes, ["/compact\r", "\x1b"]);
  await t.advance(1);
  assert.deepEqual(t.pty.writes, ["/compact\r", "\x1b", "abc"], "R151: 100 ms later, so Esc+a is no Alt-a");
  assert.equal(t.input.holding, false);
  assert.equal(t.type("d"), "pass");
  t.typist.dispose();

  // A held Enter never follows an Esc into a /model dialog: it is dropped.
  const u = setup();
  let dropped = 0;
  u.input.onKeysDropped(() => dropped++);
  await u.run({ command: "model", model: "haiku" }, 600);
  assert.equal(u.type("\r"), "hold");
  assert.equal(u.type("\x1b"), "pass");
  await u.advance(500);
  assert.deepEqual(u.pty.writes, ["/model haiku\r", "\x1b"]);
  assert.equal(dropped, 1);
  u.typist.dispose();
});

test("kitty_protocol_esc_and_ctrl_c_take_over", async () => {
  const takeovers = {
    "\x1b[27u": true,
    "\x1b[27;1u": true,
    "\x1b[27;1:1u": true,
    "\x1b[99;5u": false,
    "\x1b[99;5:1u": false,
    "\x1b[99;69u": false, // Ctrl with Caps Lock on
  };
  for (const [key, draftAfter] of Object.entries(takeovers)) {
    const t = setup();
    await t.run({ command: "compact" }, 600);
    t.session.status = "busy";
    t.session.statusUpdatedAt = t.clock.now();
    assert.equal(t.type("x"), "hold");
    assert.equal(t.type(key), "pass", `${JSON.stringify(key)} takes over`);
    await t.advance(100);
    assert.deepEqual(t.pty.writes, ["/compact\r", key, "x"]);
    assert.equal(t.input.holding, false);
    t.typist.dispose();
    // As drafts, the same as the legacy bytes: Esc may leave text, Ctrl-C clears.
    const input = new LaptopInput({ clock: new FakeClock() });
    input.key("abc");
    input.key(key);
    assert.equal(input.draft, true === draftAfter, `${JSON.stringify(key)} as a draft`);
  }
  // A release, or the terminal's answer to a flags query, is no key; a printable is a draft.
  const t = setup();
  await t.run({ command: "compact" }, 600);
  assert.equal(t.type("\x1b[27;1:3u"), "hold", "an Esc release is no takeover");
  t.typist.dispose();
  const input = new LaptopInput({ clock: new FakeClock() });
  input.key("\x1b[?1u");
  input.key("\x1b[99;5:3u");
  assert.equal(input.draft, false);
  input.key("\x1b[97u");
  assert.equal(input.draft, true, "a CSI-u printable is a draft");
});

test("enter_while_busy_cleared_by_prompt_submitted", async () => {
  const t = setup();
  // Claude is already busy, so its file never shows the Enter's submit (R145).
  t.session.status = "busy";
  t.session.statusUpdatedAt = t.clock.now() - 5000;
  t.type("next question");
  t.type("\r");
  await t.advance(2000);
  assert.equal(t.input.draft, true, "conservative until agentd proves the submit");
  t.input.promptSubmitted(t.clock.now() - 2500);
  assert.equal(t.input.draft, true, "a prompt taken before the Enter is not this one");
  t.input.promptSubmitted(t.clock.now());
  assert.equal(t.input.draft, false, "R149");
  // A key typed after the Enter keeps the draft.
  t.type("more");
  t.type("\r");
  t.type("x");
  t.input.promptSubmitted(t.clock.now());
  assert.equal(t.input.draft, true);
  t.typist.dispose();
});

test("link_drop_after_compact_ok_releases_keyboard", async () => {
  await withTempDir(async (dir) => {
    const pty = new FakePty();
    const clock = new FakeClock();
    const file = path.join(dir, `${pty.pid}.json`);
    const write = (status, at) => fs.writeFileSync(file, JSON.stringify({ pid: pty.pid, sessionId: "s1", status, statusUpdatedAt: at }));
    write("idle", clock.now() - 10_000);
    const sent = [];
    const binding = { gen: 1, uncertain: false };
    const client = new LauncherClient({ child: pty, send: (frame) => sent.push(frame), binding, sessionsDir: dir, clock });
    client.setSession({ pid: pty.pid, sessionId: "s1", status: "idle" });
    client.onBound("s1");
    client.onLinkUp();
    try {
      client.onFrame({ type: "type_command", cmdId: "k1", gen: 1, command: "compact" });
      clock.advance(600);
      await flush();
      assert.deepEqual(sent.filter((f) => f.type === "command_result"), [{ type: "command_result", cmdId: "k1", ok: true }]);
      write("busy", clock.now());
      client.onStdin("held");
      assert.deepEqual(pty.writes, ["/compact\r"], "the compact owns input");
      // agentd goes away: no compact_done or cancel_command can ever come.
      client.onLinkDown();
      client.onStdin("!");
      assert.deepEqual(pty.writes, ["/compact\r"], "keys held before the drop wait for positive readiness");
      write("idle", clock.now() + 1);
      clock.advance(1000);
      await flush();
      assert.deepEqual(pty.writes, ["/compact\r", "held!"]);
      client.onStdin("y");
      assert.deepEqual(pty.writes, ["/compact\r", "held!", "y"], "the keyboard echoes at once");
      // And the next command after the reconnect is not refused busy.
      client.onLinkUp();
      client.onStdin("\x03");
      client.onFrame({ type: "type_command", cmdId: "k2", gen: 1, command: "compact" });
      clock.advance(600);
      await flush();
      assert.deepEqual(sent.filter((f) => f.cmdId === "k2" && f.type === "command_result"), [
        { type: "command_result", cmdId: "k2", ok: true },
      ]);

      // With nothing held, the link drop frees the keyboard at once.
      client.onFrame({ type: "compact_done", cmdId: "k2" });
      client.onFrame({ type: "type_command", cmdId: "k3", gen: 1, command: "compact" });
      write("idle", clock.now() + 2);
      clock.advance(600);
      await flush();
      const before = pty.writes.length;
      client.onLinkDown();
      client.onStdin("z");
      assert.deepEqual(pty.writes.slice(before), ["z"]);
    } finally {
      client.dispose();
    }
  });
});

// N3: a non-Latin layout reports Ctrl-C by its own codepoint, with 99 only as
// the base-layout key; report-all-keys mode (flag 8) sends Enter as CSI 13 u.
test("kitty_base_layout_ctrl_c_and_report_all_keys_enter", async () => {
  for (const key of ["\x1b[1089::99;5u", "\x1b[1089:1057:99;5:1u", "\x1b[1089::99;69u"]) {
    const t = setup();
    await t.run({ command: "compact" }, 600);
    t.session.status = "busy";
    t.session.statusUpdatedAt = t.clock.now();
    assert.equal(t.type("x"), "hold");
    assert.equal(t.type(key), "pass", `${JSON.stringify(key)} takes over`);
    t.typist.dispose();
    const input = bareInput();
    input.key("abc");
    input.key(key);
    assert.equal(input.draft, false, `${JSON.stringify(key)} clears like Ctrl-C`);
  }
  // A base-layout Esc is an Esc too.
  const esc = setup();
  await esc.run({ command: "compact" }, 600);
  assert.equal(esc.type("\x1b[1093::27u"), "pass");
  esc.typist.dispose();
  // On a Latin layout the key's own code decides: Ctrl-J there is no clear, though it may take over.
  const latin = bareInput();
  latin.key("abc");
  latin.key("\x1b[106::99;5u");
  assert.equal(latin.draft, true, "an ambiguous Ctrl-C never clears the draft");

  // Flag 8: Enter as CSI 13 u arms the submit proof as "\r" does, and is cleared by R149.
  for (const enter of ["\x1b[13u", "\x1b[13;1u", "\x1b[13;1:1u", "\x1b[13;65u"]) {
    const input = bareInput();
    input.key("\x1b[104u\x1b[105u");
    input.key(enter);
    assert.equal(input.draft, true);
    input.promptSubmitted(Number.MAX_SAFE_INTEGER);
    assert.equal(input.draft, false, `${JSON.stringify(enter)} is an Enter`);
  }
  // Shift-Enter is a newline, and an Enter release is nothing.
  for (const other of ["\x1b[13;2u", "\x1b[13;1:3u"]) {
    const input = bareInput();
    input.key("hi");
    input.key(other);
    input.promptSubmitted(Number.MAX_SAFE_INTEGER);
    assert.equal(input.draft, true, `${JSON.stringify(other)} is no submit`);
  }
});

// N1: an unbound launcher still clears its own uncertainty from Claude's file.
test("unbound_launcher_clears_uncertainty_from_its_polled_session_file", async () => {
  await withTempDir(async (dir) => {
    const pty = new FakePty();
    const clock = new FakeClock();
    const file = path.join(dir, `${pty.pid}.json`);
    const write = (status, at) => fs.writeFileSync(file, JSON.stringify({ pid: pty.pid, sessionId: "s1", status, statusUpdatedAt: at }));
    const since = clock.now() - 1000;
    const binding = { gen: 1, uncertain: true, uncertainSince: since };
    const client = new LauncherClient({ child: pty, send: () => {}, binding, sessionsDir: dir, clock });
    try {
      client.setSession({ pid: pty.pid, sessionId: "s1", status: "idle" });
      client.onBound(undefined);
      write("idle", since - 1);
      assert.equal(client.uncertain(), true, "an idle from before the write proves nothing");
      write("idle", since + 1);
      assert.equal(client.uncertain(), false, "the bind after a link blip carries the launcher's real state");
    } finally {
      client.dispose();
    }
  });
});
