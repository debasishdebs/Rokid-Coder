"use strict";
/**
 * What the launcher tells agentd is a laptop draft is what its screen model shows
 * in the prompt box (visible text), never what the key stream suggests: a stray
 * Esc or Tab is no draft, and a draft the keys never saw still is one. Replies
 * are checked on the screen by the typist (typist-bg.test.js); here the client
 * reports the draft, forwards the checks, and agentd logs them.
 * A fake pty and clock; the screen is drawn by the test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { LauncherClient } = require("../dist/launcher/launcher-client.js");

const RULE = "─".repeat(60);
const FOOTER = "  ▶▶ auto mode on · ← 1 agent";

class FakePty {
  constructor() {
    this.pid = 4242;
    this.writes = [];
    this.dataListeners = [];
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
  onExit() {}
  emit(chunk) {
    for (const cb of this.dataListeners) cb(chunk);
  }
}

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

function repaint({ above = ["● Resumed."], input = "", footer = [FOOTER] } = {}) {
  return `\x1b[2J\x1b[H${[...above, RULE, `> ${input}`, RULE, ...footer].join("\r\n")}`;
}

function setup() {
  const pty = new FakePty();
  const clock = new FakeClock();
  const frames = [];
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-draft-"));
  fs.writeFileSync(
    path.join(sessionsDir, "4242.json"),
    JSON.stringify({ pid: 4242, sessionId: "s1", status: "idle", statusUpdatedAt: 1 }),
  );
  const client = new LauncherClient({
    child: pty,
    send: (frame) => frames.push(frame),
    binding: { gen: 1, uncertain: false },
    sessionsDir,
    clock,
  });
  client.setSession({ sessionId: "s1", pid: 4242 });
  client.onBound("s1");
  const t = { pty, clock, frames, client };
  t.draw = (chunk) => pty.emit(chunk);
  t.wait = (ms) => clock.advance(ms);
  // The draft as agentd hears it changes: laptop_state also carries the box state and is repeated while
  // unchanged (see t.states), so only a change of `draft` from what agentd already believed (false) counts.
  t.states = () => frames.filter((f) => f.type === "laptop_state");
  t.drafts = () => {
    const changes = [];
    let last = false;
    for (const f of t.states()) {
      if (f.draft !== last) {
        last = f.draft;
        changes.push(f.draft);
      }
    }
    return changes;
  };
  t.checks = () => frames.filter((f) => f.type === "screen_check");
  return t;
}

test("a_stray_key_with_nothing_in_the_box_is_never_a_draft", () => {
  for (const key of ["\x1b", "\t", "\x1b[A", "\x7f", "\x1b[3~"]) {
    const t = setup();
    t.draw(repaint({ input: "\x1b[2mrun the test suite\x1b[22m" }));
    t.client.onStdin(key);
    t.wait(5000);
    assert.deepEqual(t.drafts(), [], JSON.stringify(key));
  }
});

test("text_visible_in_the_box_is_the_draft_and_it_ends_when_the_box_is_empty_again", () => {
  const t = setup();
  t.draw(repaint());
  t.wait(500);
  assert.deepEqual(t.drafts(), []);
  t.draw(repaint({ input: "half a thou" }));
  t.wait(500);
  assert.deepEqual(t.drafts(), [true]);
  t.draw(repaint());
  t.wait(500);
  assert.deepEqual(t.drafts(), [true, false]);
});

test("a_draft_the_keys_never_saw_is_still_a_draft", () => {
  const t = setup();
  // A restored or pasted draft: no key of the wearer's went through.
  t.draw(repaint({ input: "restored from the last session" }));
  t.wait(500);
  assert.deepEqual(t.drafts(), [true]);
});

test("a_faint_suggestion_a_dialog_and_a_tainted_screen_are_no_draft", () => {
  const faint = setup();
  faint.draw(repaint({ input: "\x1b[2mTry \"fix lint errors\"\x1b[22m" }));
  faint.wait(500);
  assert.deepEqual(faint.drafts(), []);
  const dialog = setup();
  dialog.draw(`Do you want to proceed?\r\n${RULE}\r\n> yes\r\n${RULE}\r\n  esc to cancel`);
  dialog.wait(500);
  assert.deepEqual(dialog.drafts(), [], "a dialog is not text at the laptop prompt; the reply is refused for it elsewhere");
  const tainted = setup();
  tainted.draw(repaint());
  tainted.draw("\x1b[1;20r");
  tainted.draw(`\x1b[H${["● Resumed.", RULE, "> typed", RULE, FOOTER].map((row) => `${row}\x1b[K`).join("\r\n")}`);
  tainted.wait(500);
  assert.deepEqual(tainted.drafts(), []);
});

test("the_wearers_keys_alone_never_report_a_draft_and_what_is_reported_is_throttled", () => {
  const t = setup();
  t.draw(repaint());
  t.client.onStdin("hello");
  t.wait(500);
  assert.deepEqual(t.drafts(), [], "the key stream says draft; the screen has not shown it");
  t.draw(repaint({ input: "hello" }));
  t.draw(repaint({ input: "hello w" }));
  t.wait(500);
  assert.deepEqual(t.drafts(), [true]);
});

test("our_own_paste_is_no_draft_while_a_reply_is_in_flight", async () => {
  const t = setup();
  t.draw(repaint());
  t.client.onFrame({ type: "type_command", cmdId: "c1", gen: 1, command: "text", text: "yes do it" });
  t.wait(100);
  assert.equal(t.pty.writes.at(-1), "\x1b[200~yes do it\x1b[201~", "pasted after the two looks");
  t.draw(repaint({ input: "yes do it" }));
  t.wait(100);
  assert.deepEqual(t.drafts(), [], "the box shows our own text; agentd must not think it a draft");
  t.wait(100);
  assert.equal(t.pty.writes.at(-1), "\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(t.frames.some((f) => f.type === "command_result" && f.ok === true), true);
  // Enter was pressed, and Claude clears the box.
  t.draw(repaint());
  t.wait(500);
  assert.deepEqual(t.drafts(), []);
});

test("the_screen_checks_are_forwarded_to_agentd_as_names_and_lengths", async () => {
  const t = setup();
  t.draw(repaint({ input: "the wearer's own words" }));
  t.client.onFrame({ type: "type_command", cmdId: "c1", gen: 1, command: "text", text: "yes do it" });
  t.wait(200);
  await new Promise((resolve) => setImmediate(resolve));
  const result = t.frames.find((f) => f.type === "command_result");
  assert.deepEqual([result.ok, result.error], [false, "laptop_draft"]);
  assert.deepEqual(
    t.checks().map((c) => [c.phase, c.probe, c.reason, c.textLen, c.tainted, c.outcome]),
    [["pre", "prompt", "text", "the wearer's own words".length, false, "refused"]],
  );
  assert.equal(JSON.stringify(t.checks()).includes("wearer"), false, "lengths only, never prompt text");
  assert.equal(t.pty.writes.length, 0, "nothing was written, so the wearer's text is untouched");
});

test("agentd_logs_a_screen_check_as_flags_and_lengths_and_refuses_a_malformed_one", async () => {
  const net = require("node:net");
  const { LauncherHub } = require("../dist/launcher/launcher-hub.js");
  const { AttachRegistry } = require("../dist/attach-registry.js");
  const { withTempDir } = require("./helpers/daemon.js");
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "cfg");
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const logs = [];
    const logger = {
      info: (event, meta) => logs.push({ event, meta }),
      warn: (event, meta) => logs.push({ event, meta }),
      error: (event, meta) => logs.push({ event, meta }),
    };
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: path.join(dir, "sessions"), logger, registry });
    await hub.start();
    try {
      const socket = net.createConnection(hub.socketPath);
      await new Promise((resolve) => socket.once("connect", resolve));
      const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
      send({ type: "launcher_hello", v: 1, launcherId: "L-draft", provider: "claude", childPid: 4242 });
      const good = { type: "screen_check", phase: "pre", probe: "prompt", reason: "text", textLen: 18, tainted: false, outcome: "refused" };
      send(good);
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_screen_check"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const line = logs.find((l) => l.event === "launcher_screen_check");
      assert.deepEqual(
        { ...line.meta },
        { session: undefined, phase: "pre", probe: "prompt", reason: "text", textLen: 18, tainted: false, outcome: "refused" },
      );
      // A frame that carries anything more is dropped with the connection.
      send({ ...good, text: "the prompt text" });
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_connection_dropped"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(logs.filter((l) => l.event === "launcher_screen_check").length, 1);
      assert.equal(logs.some((l) => l.event === "launcher_connection_dropped"), true);
      socket.destroy();
    } finally {
      await hub.stop();
    }
  });
});

test("agentd_logs_a_screen_shape_as_classes_and_numbers_and_refuses_anything_else", async () => {
  const net = require("node:net");
  const { LauncherHub } = require("../dist/launcher/launcher-hub.js");
  const { AttachRegistry } = require("../dist/attach-registry.js");
  const { withTempDir } = require("./helpers/daemon.js");
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "cfg");
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const logs = [];
    const logger = {
      info: (event, meta) => logs.push({ event, meta }),
      warn: (event, meta) => logs.push({ event, meta }),
      error: (event, meta) => logs.push({ event, meta }),
    };
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
    const hub = new LauncherHub({ configDir, claudeSessionsDir: path.join(dir, "sessions"), logger, registry });
    await hub.start();
    try {
      const socket = net.createConnection(hub.socketPath);
      await new Promise((resolve) => socket.once("connect", resolve));
      const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);
      send({ type: "launcher_hello", v: 1, launcherId: "L-shape", provider: "claude", childPid: 4242 });
      const good = { type: "screen_shape", cols: 207, rows: 50, shape: "0T120 1B0 46R207 47P35", reason: "no_box", top: 46, bottom: 48 };
      send(good);
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_screen_shape"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const line = logs.find((l) => l.event === "launcher_screen_shape");
      assert.deepEqual(
        { ...line.meta },
        { session: undefined, cols: 207, rows: 50, reason: "no_box", top: 46, bottom: 48, shape: "0T120 1B0 46R207 47P35" },
      );
      // Anything but classes and numbers in the shape drops the connection, and nothing more is logged.
      send({ ...good, shape: "0T12 the launch code" });
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_connection_dropped"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(logs.filter((l) => l.event === "launcher_screen_shape").length, 1);
      assert.equal(logs.some((l) => l.event === "launcher_connection_dropped"), true);
      socket.destroy();
    } finally {
      await hub.stop();
    }
  });
});

test("the_client_forwards_the_shape_of_a_screen_it_could_not_read_once", async () => {
  const t = setup();
  t.draw("\x1b[2J\x1b[H● something with a secret in it\r\n❯ hunter2");
  t.client.onFrame({ type: "type_command", cmdId: "c1", gen: 1, command: "text", text: "yes do it" });
  t.wait(5400);
  await new Promise((resolve) => setImmediate(resolve));
  const result = t.frames.find((f) => f.type === "command_result");
  assert.deepEqual([result.ok, result.error], [false, "screen_unreadable"]);
  const shapes = t.frames.filter((f) => f.type === "screen_shape");
  assert.equal(shapes.length, 1);
  assert.equal(JSON.stringify(shapes).includes("secret"), false);
  assert.equal(JSON.stringify(shapes).includes("hunter2"), false);
  assert.match(shapes[0].shape, /^[0-9BRPMGT ]+$/);
  assert.equal(shapes[0].reason, "no_box");
});

// ---- the box state, its repeats, and the verdict line that lets a new real layout be read from the log ----------

test("the_box_state_is_reported_with_the_draft_and_repeated_while_unchanged_and_never_in_flight", async () => {
  const t = setup();
  t.draw(repaint());
  t.wait(500);
  const first = t.states().at(-1);
  assert.deepEqual([first.draft, first.box, typeof first.at], [false, "empty", "number"]);
  // Unchanged: repeated about every second, so agentd can tell it is still true.
  const before = t.states().length;
  t.wait(3200);
  assert.equal(t.states().length - before >= 2, true, "refreshed");
  assert.equal(t.states().every((f) => f.box === "empty" && f.draft === false), true);
  // Changes are reported as they happen.
  t.draw(repaint({ input: "half" }));
  t.wait(500);
  assert.deepEqual([t.states().at(-1).draft, t.states().at(-1).box], [true, "text"]);
  t.draw(`Do you want to proceed?\r\n${RULE}\r\n> yes\r\n${RULE}\r\n  esc to cancel`);
  t.wait(500);
  assert.equal(t.states().at(-1).box, "dialog");
  t.draw(repaint({ footer: ["  ⏸ plan mode on (shift+tab to cycle)"] }));
  t.wait(500);
  assert.equal(t.states().at(-1).box, "plan");
  t.draw(repaint());
  t.draw("\x1b[1;20r");
  t.wait(500);
  assert.equal(t.states().at(-1).box, "unreadable", "a tainted screen");
  // While our own command has the prompt nothing is reported, so the paste is never read as a draft or a dialog.
  const quiet = setup();
  quiet.draw(repaint());
  quiet.wait(500);
  quiet.client.onFrame({ type: "type_command", cmdId: "c1", gen: 1, command: "text", text: "yes do it" });
  quiet.wait(100);
  const count = quiet.states().length;
  quiet.draw(repaint({ input: "yes do it" }));
  quiet.wait(50);
  assert.equal(quiet.pty.writes.includes("\x1b[200~yes do it\x1b[201~"), true, "the paste went in");
  assert.equal(quiet.states().length, count, "no report while the command is in flight");
  await new Promise((resolve) => setImmediate(resolve));
});

test("the_verdict_frame_is_sent_on_change_at_most_every_thirty_seconds_and_holds_no_screen_text", () => {
  const t = setup();
  t.draw(repaint({ above: ["● the secret launch code is 12345"], input: "\x1b[2mTry \"fix lint errors\"\x1b[22m" }));
  t.wait(500);
  const verdicts = () => t.frames.filter((f) => f.type === "screen_verdict");
  assert.equal(verdicts().length, 1, "once at the start");
  const first = verdicts()[0];
  assert.deepEqual([first.probe, first.reason, first.box, first.tainted, first.cols, first.rows], ["prompt", "none", "empty", false, 80, 24]);
  assert.equal(first.file, "idle");
  assert.equal(first.unknown, false);
  assert.deepEqual([first.top, first.prompt, first.bottom], [1, 2, 3]);
  assert.match(first.below, /^[0-9BRPMGT ]*$/);
  assert.match(first.shape, /^[0-9BRPMGT ]+$/);
  assert.equal(first.layouts >= 1, true);
  assert.equal(JSON.stringify(first).includes("secret"), false);
  assert.equal(JSON.stringify(first).includes("12345"), false);
  // Nothing changed: nothing sent, however long it goes on.
  t.wait(20_000);
  assert.equal(verdicts().length, 1);
  // A change inside the thirty seconds waits for them.
  t.draw(repaint({ input: "hunter2 the wearer's own words" }));
  t.wait(2000);
  assert.equal(verdicts().length, 1, "rate limited");
  t.wait(5000);
  assert.equal(verdicts().length, 1, "still inside thirty seconds");
  t.wait(4000);
  assert.equal(verdicts().length, 2);
  assert.equal(verdicts()[1].box, "text");
  assert.equal(JSON.stringify(verdicts()).includes("hunter2"), false);
  assert.equal(JSON.stringify(verdicts()).includes("wearer"), false);
  // A flapping screen cannot raise the volume: many changes, one line per window.
  for (let i = 0; i < 20; i += 1) {
    t.draw(repaint({ input: i % 2 ? "x" : "" }));
    t.wait(600);
  }
  assert.equal(verdicts().length <= 3, true, `at most one more line in twelve seconds, saw ${verdicts().length}`);
});

test("the_sessions_file_and_the_verdict_are_looked_at_about_once_a_second_not_at_every_redraw", () => {
  const claudeSessions = require("../dist/launcher/claude-sessions.js");
  const original = claudeSessions.readClaudeSession;
  let reads = 0;
  claudeSessions.readClaudeSession = (...args) => {
    reads += 1;
    return original(...args);
  };
  try {
    const t = setup();
    t.draw(repaint());
    t.wait(200);
    reads = 0;
    // A spinner redrawing about five times a second for ten seconds.
    for (let i = 0; i < 50; i += 1) {
      t.draw(`\x1b[1;1H● Working… ${i}s`);
      t.wait(200);
    }
    assert.equal(reads <= 12, true, `the sessions file is read about once a second, not per redraw: ${reads} reads in ten seconds`);
    assert.equal(reads >= 1, true);
  } finally {
    claudeSessions.readClaudeSession = original;
  }
});

test("a_layout_with_a_prompt_glyph_row_the_probe_cannot_read_is_told_at_once_and_only_the_first_time", () => {
  const t = setup();
  const odd = (word) => `\x1b[2J\x1b[H● ${word}\r\n❯ hunter2\r\n  ○ general-purpose  Task\r\n❯ ○ general-purpose  Task`;
  t.draw(odd("one"));
  t.wait(500);
  const verdicts = () => t.frames.filter((f) => f.type === "screen_verdict");
  assert.equal(verdicts().length, 1);
  assert.deepEqual([verdicts()[0].unknown, verdicts()[0].box, verdicts()[0].reason], [true, "unreadable", "no_box"]);
  // The same layout again: not new, and nothing changed.
  t.draw(odd("two"));
  t.wait(500);
  assert.equal(verdicts().length, 1);
  // A different one inside the thirty seconds is told at once, not held back.
  t.draw(`\x1b[2J\x1b[H● x\r\n● y\r\n❯ hunter2\r\n  ○ general-purpose  Task`);
  t.wait(500);
  assert.equal(verdicts().length, 2);
  assert.equal(verdicts()[1].unknown, true);
  assert.equal(verdicts()[1].layouts >= 2, true, "the number of distinct layouts seen grows");
  // A readable screen is no unknown layout; the verdict changed, so it is told once the window has passed.
  t.draw(repaint());
  t.wait(40_000);
  assert.equal(verdicts().at(-1).unknown, false);
  assert.equal(verdicts().at(-1).box, "empty");
  // At most twenty are told at once per session.
  for (let i = 0; i < 40; i += 1) {
    t.draw(`\x1b[2J\x1b[H${"● row\r\n".repeat(i + 3)}❯ hunter2`);
    t.wait(300);
  }
  assert.equal(verdicts().filter((f) => f.unknown).length <= 20, true);
});

test("agentd_logs_the_verdict_with_its_own_decision_a_warning_for_an_unknown_layout_and_refuses_anything_outside_the_alphabet", async () => {
  const net = require("node:net");
  const { LauncherHub } = require("../dist/launcher/launcher-hub.js");
  const { AttachRegistry } = require("../dist/attach-registry.js");
  const { withTempDir } = require("./helpers/daemon.js");
  await withTempDir(async (dir) => {
    const logs = [];
    const logger = {
      info: (event, meta) => logs.push({ level: "info", event, meta }),
      warn: (event, meta) => logs.push({ level: "warn", event, meta }),
      error: (event, meta) => logs.push({ level: "error", event, meta }),
    };
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const registry = new AttachRegistry({ file: path.join(dir, "attached.json"), logger });
    const hub = new LauncherHub({
      configDir: path.join(dir, "cfg"),
      claudeSessionsDir: path.join(dir, "sessions"),
      logger,
      registry,
    });
    await hub.start();
    const good = {
      type: "screen_verdict", probe: "unknown", reason: "no_box", box: "unreadable", tainted: false, cols: 207, rows: 50,
      top: 46, prompt: 47, bottom: 48, below: "B1 M1 T3", shape: "0T120 1B0 46R207 47P35", file: "busy", layouts: 3, unknown: false,
    };
    const attempt = async (frame, id) => {
      const socket = net.createConnection(hub.socketPath);
      await new Promise((resolve) => socket.once("connect", resolve));
      const dropped = new Promise((resolve) => socket.once("close", () => resolve(true)));
      socket.on("error", () => undefined);
      socket.write(`${JSON.stringify({ type: "launcher_hello", v: 1, launcherId: id, provider: "claude", childPid: 4242 })}\n`);
      socket.write(`${JSON.stringify(frame)}\n`);
      const result = await Promise.race([dropped, new Promise((resolve) => setTimeout(() => resolve(false), 250))]);
      socket.destroy();
      return result;
    };
    try {
      assert.equal(await attempt(good, "L-v0"), false, "a good frame keeps the connection");
      const line = logs.find((l) => l.event === "launcher_screen_verdict");
      assert.equal(line.level, "info");
      assert.deepEqual(
        { ...line.meta },
        {
          session: undefined, probe: "unknown", reason: "no_box", box: "unreadable", tainted: false, cols: 207, rows: 50,
          top: 46, prompt: 47, bottom: 48, below: "B1 M1 T3", file: "busy", layoutSeen: 3, shape: "0T120 1B0 46R207 47P35",
        },
      );
      assert.equal(logs.some((l) => l.event === "launcher_screen_unknown_layout"), false);
      assert.equal(await attempt({ ...good, unknown: true }, "L-v1"), false);
      const warn = logs.find((l) => l.event === "launcher_screen_unknown_layout");
      assert.equal(warn.level, "warn");
      assert.equal(warn.meta.shape, good.shape);
      // The optional rows may be left out; everything else is required, and nothing outside the alphabet passes.
      const { top, prompt, bottom, ...bare } = good;
      assert.equal(await attempt(bare, "L-v2"), false);
      let n = 3;
      for (const [what, bad] of [
        ["shape with words", { shape: "0T12 the launch code" }],
        ["shape with a path", { shape: "0T12 /Users/me" }],
        ["below with words", { below: "B1 secret" }],
        ["below too long", { below: "B1 ".repeat(100) }],
        ["shape too long", { shape: "1T1 ".repeat(2100) }],
        ["reason with words", { reason: "no box at all" }],
        ["reason with a path", { reason: "/etc/passwd" }],
        ["probe unknown word", { probe: "teleport" }],
        ["box unknown word", { box: "secret" }],
        ["file with a path", { file: "/Users/me/x" }],
        ["file too long", { file: "a".repeat(30) }],
        ["cols too large", { cols: 5000 }],
        ["rows zero", { rows: 0 }],
        ["row a string", { top: "46" }],
        ["row negative", { bottom: -1 }],
        ["layouts huge", { layouts: 5000 }],
        ["tainted a string", { tainted: "no" }],
        ["unknown a string", { unknown: "yes" }],
        ["an extra field", { title: "my secret project" }],
      ]) {
        n += 1;
        assert.equal(await attempt({ ...good, ...bad }, `L-v${n}`), true, `${what}: the connection is dropped`);
      }
      assert.equal(logs.filter((l) => l.event === "launcher_screen_verdict").length, 3, "only the good ones were logged");
      assert.equal(JSON.stringify(logs).includes("secret"), false);
    } finally {
      await hub.stop();
    }
  });
});
