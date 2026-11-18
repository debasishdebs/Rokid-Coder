"use strict";
/**
 * The key stream alone says "draft" after a stray Esc, Tab or arrow (it never
 * sees the prompt). The launcher lets the draft go only when the screen model
 * positively shows the prompt box empty (a muted suggestion is empty), on two
 * looks, and keeps it whenever the screen shows text, is tainted, is not a
 * prompt box or has a dialog up. A fake pty and clock; the screen is drawn by the test.
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

/** `status` is what Claude's own sessions file says for the bound session; "none" means there is no such file. */
function setup({ status = "idle" } = {}) {
  const pty = new FakePty();
  const clock = new FakeClock();
  const frames = [];
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "rk-draft-"));
  const client = new LauncherClient({
    child: pty,
    send: (frame) => frames.push(frame),
    binding: { gen: 1, uncertain: false },
    sessionsDir,
    clock,
  });
  const t = { pty, clock, frames, client, sessionsDir };
  t.setStatus = (value) => {
    const file = path.join(sessionsDir, "4242.json");
    if (value === "none") {
      fs.rmSync(file, { force: true });
    } else {
      fs.writeFileSync(file, JSON.stringify({ pid: 4242, sessionId: "s1", status: value, statusUpdatedAt: 1 }));
    }
  };
  t.setStatus(status);
  client.setSession({ sessionId: "s1", pid: 4242 });
  client.onBound("s1");
  t.draw = (chunk) => pty.emit(chunk);
  t.wait = (ms) => clock.advance(ms);
  t.checks = () => frames.filter((f) => f.type === "draft_check");
  return t;
}

// Keys the tracker treats as possibly typing that Claude never echoes (Right and Ctrl-K only move or erase, so they never set a draft).
for (const key of ["\x1b", "\t", "\x1b[A", "\x1b[B", "\x1b[3~"]) {
  test(`a_stray_${JSON.stringify(key).replace(/\W/g, "_")}_then_an_empty_box_with_a_faint_suggestion_clears_the_draft`, () => {
    const t = setup();
    t.draw(repaint({ input: "\x1b[2mrun the test suite\x1b[22m" }));
    t.client.onStdin(key);
    assert.equal(t.client.input.draft, true, "the key stream says draft");
    // Nothing is drawn for such a key, so only a long quiet with Claude idle lets it go.
    t.wait(600);
    assert.equal(t.client.input.draft, true);
    t.wait(3500);
    assert.equal(t.client.input.draft, true, "not yet 5 s since the key");
    t.wait(1500);
    assert.equal(t.client.input.draft, false);
    const [waiting, check, ...more] = t.checks();
    assert.deepEqual(more, []);
    assert.deepEqual([waiting.decision, waiting.reason], ["kept", "awaiting_quiet_idle"]);
    assert.deepEqual(
      [check.decision, check.probe, check.reason, check.textLen, check.tainted, check.before, check.after],
      // The length counts the faint suggestion too: what is on the line, not what is solid.
      ["cleared", "prompt", "empty", "run the test suite".length, false, true, false],
    );
    // agentd is told the draft is gone.
    assert.deepEqual(t.frames.filter((f) => f.type === "laptop_state").map((f) => f.draft), [true, false]);
  });
}

test("a_gray_placeholder_or_the_try_hint_counts_as_empty_too", () => {
  for (const input of ["\x1b[90msuggestion\x1b[39m", "\x1b[38;5;245msuggestion\x1b[0m", '\x1b[2mTry "fix lint errors"\x1b[22m']) {
    const t = setup();
    t.draw(repaint({ input }));
    t.client.onStdin("\x1b");
    t.wait(6000);
    assert.equal(t.client.input.draft, false, input);
  }
});

test("real_typed_text_visible_in_the_box_keeps_the_draft", () => {
  const t = setup();
  t.draw(repaint());
  t.client.onStdin("hello");
  t.draw(repaint({ input: "hello" }));
  t.wait(5000);
  assert.equal(t.client.input.draft, true);
  const checks = t.checks();
  assert.equal(checks.length, 1, "said once, not on every look");
  assert.deepEqual(
    [checks[0].decision, checks[0].reason, checks[0].textLen, checks[0].after],
    ["kept", "text", 5, true],
  );
  assert.equal(JSON.stringify(checks).includes("hello"), false, "lengths only, never the prompt text");
});

test("a_character_not_yet_echoed_is_not_mistaken_for_an_empty_box_however_slow_the_echo", () => {
  const t = setup();
  t.draw(repaint());
  t.client.onStdin("a");
  // Claude takes far longer than the settle time to draw it: both looks read the pre-key screen.
  t.wait(3000);
  assert.equal(t.client.input.draft, true);
  t.wait(30_000);
  assert.equal(t.client.input.draft, true, "a key Claude echoes needs a redraw, however long that takes");
  assert.equal(t.checks().at(-1).reason, "awaiting_echo");
  // The echo arrives and shows the character: handled, the draft is real.
  t.draw(repaint({ input: "a" }));
  t.wait(5000);
  assert.equal(t.client.input.draft, true);
  assert.deepEqual([t.checks().at(-1).decision, t.checks().at(-1).reason], ["kept", "text"]);
});

test("an_echo_that_shows_the_box_empty_again_lets_a_backspaced_draft_go", () => {
  const t = setup();
  t.draw(repaint({ input: "a" }));
  t.client.onStdin("\x7f");
  t.wait(5000);
  assert.equal(t.client.input.draft, true, "no redraw yet");
  t.draw(repaint());
  t.wait(300);
  assert.equal(t.client.input.draft, true, "settle time not yet over since the key");
  t.wait(1500);
  assert.equal(t.client.input.draft, false);
});

test("output_drawn_after_the_key_is_the_evidence_for_a_key_that_draws_nothing_too", () => {
  // Claude is busy, so the file is no evidence, but it drew after the Esc and the box is still empty.
  const t = setup({ status: "busy" });
  t.draw(repaint({ input: "\x1b[2msuggestion\x1b[22m" }));
  t.client.onStdin("\x1b");
  t.draw("\x1b[s\x1b[1;1H\x1b[2K● Working…\x1b[u");
  t.wait(2500);
  assert.equal(t.client.input.draft, false);
});

test("a_key_that_draws_nothing_is_let_go_only_after_5_s_and_only_with_claude_idle", () => {
  for (const [what, status] of [["busy", "busy"], ["waiting", "waiting"], ["unknown", "none"]]) {
    const t = setup({ status });
    t.draw(repaint({ input: "\x1b[2msuggestion\x1b[22m" }));
    t.client.onStdin("\x1b");
    t.wait(60_000);
    assert.equal(t.client.input.draft, true, what);
    assert.equal(t.checks().at(-1).reason, "awaiting_quiet_idle", what);
    // Claude goes idle: now it is let go.
    t.setStatus("idle");
    t.wait(1000);
    assert.equal(t.client.input.draft, false, `${what} then idle`);
  }
  const quick = setup();
  quick.draw(repaint({ input: "\x1b[2msuggestion\x1b[22m" }));
  quick.client.onStdin("\x1b");
  quick.wait(4900);
  assert.equal(quick.client.input.draft, true);
  quick.wait(1000);
  assert.equal(quick.client.input.draft, false);
});

test("each_new_key_starts_the_wait_again", () => {
  const t = setup();
  t.draw(repaint());
  t.client.onStdin("\x1b");
  t.wait(4500);
  t.client.onStdin("\t");
  t.wait(4500);
  assert.equal(t.client.input.draft, true);
  t.wait(1000);
  assert.equal(t.client.input.draft, false);
});

test("a_tainted_screen_keeps_the_draft_and_says_why", () => {
  const t = setup();
  t.draw(repaint());
  t.draw("\x1b[1;20r");
  // Redrawn in place with nothing erased: the stale grid would read as an empty box.
  t.draw(`\x1b[H${["● Resumed.", RULE, "> ", RULE, FOOTER].map((row) => `${row}\x1b[K`).join("\r\n")}`);
  t.client.onStdin("\x1b");
  t.wait(6000);
  assert.equal(t.client.input.draft, true);
  assert.deepEqual(
    t.checks().map((c) => [c.decision, c.probe, c.tainted]),
    [["kept", "none", true], ["kept", "unknown", true]],
  );
  // A whole-screen erase and redraw heals the model, and the draft goes at the next looks.
  t.draw(repaint());
  t.wait(1000);
  assert.equal(t.client.input.draft, false);
});

test("a_dialog_or_a_question_keeps_the_draft", () => {
  for (const screen of [
    `Do you want to proceed?\r\n${RULE}\r\n> \r\n${RULE}\r\n  esc to cancel`,
    `Which suite?\r\n${RULE}\r\n❯ 1. unit\r\n  2. contract\r\n${RULE}`,
    repaint({ above: ["✻ Thinking… (3s · esc to interrupt)"] }),
    repaint({ footer: ["  Enter to select · ↑/↓ to navigate"] }),
  ]) {
    const t = setup();
    t.draw(screen);
    t.client.onStdin("\x1b");
    t.wait(6000);
    assert.equal(t.client.input.draft, true, screen.slice(0, 30));
    assert.equal(t.checks().at(-1).decision, "kept");
    assert.equal(t.checks().at(-1).probe, "blocked");
  }
});

test("no_box_at_all_or_an_incomplete_sequence_keeps_the_draft", () => {
  const none = setup();
  none.draw("Welcome back\r\nResuming…");
  none.client.onStdin("\x1b");
  none.wait(6000);
  assert.equal(none.client.input.draft, true);
  assert.equal(none.checks().at(-1).probe, "unknown");
  const cut = setup();
  cut.draw(`${repaint()}\x1b[`);
  cut.client.onStdin("\x1b");
  cut.wait(6000);
  assert.equal(cut.client.input.draft, true);
});

test("the_screen_is_followed_for_the_whole_session_not_only_while_a_reply_is_in_flight", () => {
  const t = setup();
  // Output long before any key or command, and a resume's repaint in between.
  t.draw(repaint({ input: "old" }));
  t.wait(10_000);
  t.draw(repaint({ input: "\x1b[2mrun it\x1b[22m" }));
  t.client.onStdin("\x1b");
  t.wait(6000);
  assert.equal(t.client.input.draft, false);
});

test("a_draft_the_keys_hold_for_a_glasses_command_is_never_cleared_from_the_screen", () => {
  const t = setup();
  t.draw(repaint());
  t.client.onStdin("\x1b");
  t.client.input.hold();
  t.wait(5000);
  assert.equal(t.client.input.draft, true);
  assert.deepEqual(t.checks(), []);
});

test("agentd_logs_the_decision_as_flags_and_lengths_and_refuses_a_malformed_one", async () => {
  const net = require("node:net");
  const path = require("node:path");
  const fs = require("node:fs");
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
      const good = {
        type: "draft_check", probe: "prompt", reason: "empty", textLen: 18, tainted: false,
        before: true, after: false, decision: "cleared",
      };
      send(good);
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_draft_check"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const line = logs.find((l) => l.event === "launcher_draft_check");
      assert.deepEqual(
        { ...line.meta },
        { session: undefined, probe: "prompt", reason: "empty", textLen: 18, tainted: false, draftBefore: true, draftAfter: false, decision: "cleared" },
      );
      // A frame that carries anything more, or a reason that is not a word, is dropped with the connection.
      send({ ...good, text: "the prompt text" });
      for (let i = 0; i < 100 && !logs.some((l) => l.event === "launcher_connection_dropped"); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(logs.filter((l) => l.event === "launcher_draft_check").length, 1);
      assert.equal(logs.some((l) => l.event === "launcher_connection_dropped"), true);
      socket.destroy();
    } finally {
      await hub.stop();
    }
  });
});
