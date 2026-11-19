"use strict";
/**
 * The launcher's half of a background reply: one bracketed paste without Enter,
 * the screen model positively showing the whole text on Claude's input line,
 * agentd's write checks before the paste and before the Enter, and Ctrl+U plus
 * `not_sent` whenever anything is not confirmed. A fake pty and a fake clock;
 * the screen is whatever the test draws.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { Typist, sessionReady } = require("../dist/launcher/typist.js");
const { LaptopInput, sessionBusySince } = require("../dist/launcher/laptop-input.js");
const { ScreenModel, probe } = require("../dist/launcher/screen-probe.js");

const PASTE = (text) => `\x1b[200~${text}\x1b[201~`;
const CTRL_U = "\x15";
const RULE = "─".repeat(60);
const FOOTER = "  ▶▶ auto mode on · ← 1 agent · PR #9";

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

const flush = () => new Promise((resolve) => setImmediate(resolve));

function track(promise) {
  const box = { result: undefined };
  promise.then((result) => {
    box.result = result;
  });
  return box;
}

/** A full repaint of Claude's idle screen. */
function repaint({ above = ["● Done with the review.", "", "✻ Working…"], input = "", footer = [FOOTER] } = {}) {
  return `\x1b[2J\x1b[H${[...above, RULE, `> ${input}`, RULE, ...footer].join("\r\n")}`;
}

function setup({ file = "busy" } = {}) {
  const pty = new FakePty();
  const clock = new FakeClock();
  const session = { status: file, statusUpdatedAt: clock.now() - 10_000 };
  const input = new LaptopInput({ clock, busySince: (at) => sessionBusySince(session, at) });
  const binding = { gen: 1, uncertain: false };
  const screen = new ScreenModel(80, 24);
  const asked = [];
  const written = [];
  const checks = [];
  const shapes = [];
  const typist = new Typist(pty, input, (after) => sessionReady(session, after), clock, {
    binding,
    onWritten: (cmdId, at) => written.push({ cmdId, at }),
    onCheck: (check) => checks.push(check),
    onShape: (shape) => shapes.push(shape),
    bg: {
      screen,
      fileStatus: () => session.status,
      askWrite: (cmdId, phase) => asked.push({ cmdId, phase }),
    },
  });
  const t = { pty, clock, input, session, binding, screen, asked, written, typist, checks, shapes };
  t.draw = (chunk) => pty.emit(chunk);
  t.advance = async (ms) => {
    // A poll's worth at a time, as the typist's own timer would run.
    for (let left = ms; left > 0; left -= 50) {
      clock.advance(Math.min(50, left));
      await flush();
    }
  };
  t.run = (fields = {}) => {
    const box = track(typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, ...fields }));
    return box;
  };
  /** The prompt is up, the reply is dispatched and agentd said yes to the paste. */
  t.toPasted = async (text = "yes do it") => {
    t.draw(repaint());
    const box = t.run({ text });
    await t.advance(150);
    assert.deepEqual(asked.map((a) => a.phase), ["paste"]);
    typist.verdict("c1", "paste", true);
    await t.advance(0);
    return box;
  };
  return t;
}

test("paste_without_enter_then_enter_only_after_the_text_is_seen_and_agentd_allows_it", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(150);
  assert.deepEqual(t.pty.writes, [], "nothing is written before agentd says yes");
  assert.deepEqual(t.asked, [{ cmdId: "c1", phase: "paste" }]);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it")], "one bracketed paste and no Enter");
  assert.equal(t.written.length, 1);
  // Claude echoes the paste into its input box.
  t.draw(repaint({ input: "yes do it" }));
  await t.advance(150);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"]);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it")], "still no Enter before agentd allows it");
  t.typist.verdict("c1", "enter", true);
  await flush();
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), "\r"]);
  assert.deepEqual(box.result, { ok: true });
});

test("the_paste_text_is_sanitised_like_every_other_text", async () => {
  const t = setup();
  t.draw(repaint());
  t.run({ text: "go\x1b[201~now\x03" });
  await t.advance(150);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  assert.deepEqual(t.pty.writes, [PASTE("go[201~now")]);
});

test("no_enter_and_ctrl_u_and_not_sent_when_the_paste_lands_in_a_dialog", async () => {
  const t = setup();
  const box = await t.toPasted();
  // A permission dialog took the screen: the paste is not in a prompt box.
  t.draw(`\x1b[2J\x1b[HBash command\r\n  rm -rf build\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n  esc to cancel`);
  await t.advance(1700);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], "agentd was never asked about an Enter");
});

test("an_unconfirmed_paste_is_cleared_after_the_confirm_window_and_not_sent", async () => {
  const t = setup();
  const box = await t.toPasted();
  // The screen never shows the text (still the placeholder).
  t.draw(repaint({ input: '\x1b[2mTry "fix lint errors"\x1b[22m' }));
  await t.advance(1400);
  assert.equal(box.result, undefined);
  await t.advance(300);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("a_dialog_marker_around_our_text_in_the_box_blocks_the_enter_at_once", async () => {
  const t = setup();
  const box = await t.toPasted();
  t.draw(repaint({ above: ["Do you want to proceed?"], input: "yes do it", footer: ["  esc to cancel"] }));
  await t.advance(100);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(box.result.error, "not_sent");
});

test("an_interrupt_indicator_means_the_main_turn_is_running_again_and_nothing_is_sent", async () => {
  const t = setup();
  const box = await t.toPasted();
  t.draw(repaint({ above: ["✻ Thinking… (3s · esc to interrupt)"], input: "yes do it" }));
  await t.advance(100);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(box.result.error, "not_sent");
});

test("the_cleared_input_line_leaves_the_prompt_certain_and_a_dialog_leaves_it_uncertain", async () => {
  const a = setup();
  await a.toPasted();
  a.draw(repaint({ input: "yes do it" }));
  await a.advance(100);
  // The paste was confirmed but agentd then says no: Ctrl+U, and the box shows the text gone.
  a.typist.verdict("c1", "enter", false);
  a.draw(repaint({ input: 'Try "fix lint errors"' }));
  await a.advance(100);
  assert.deepEqual(a.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(a.binding.uncertain, false);

  const b = setup();
  await b.toPasted();
  b.draw(`\x1b[2J\x1b[HDo you want to proceed?\r\n❯ 1. Yes\r\n  esc to cancel`);
  await b.advance(3300);
  assert.equal(b.binding.uncertain, true, "a clear that cannot be seen is not assumed");
  assert.deepEqual(b.pty.writes, [PASTE("yes do it"), CTRL_U]);
});

test("agentd_saying_no_before_the_paste_writes_nothing", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(150);
  t.typist.verdict("c1", "paste", false);
  await t.advance(0);
  assert.deepEqual(t.pty.writes, []);
  assert.deepEqual(box.result, { ok: false, error: "busy" });
});

test("no_answer_from_agentd_is_a_no", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(2300);
  assert.deepEqual(t.pty.writes, []);
  assert.deepEqual(box.result, { ok: false, error: "busy" });
  const u = setup();
  const pasted = await u.toPasted();
  u.draw(repaint({ input: "yes do it" }));
  await u.advance(2400);
  assert.deepEqual(u.pty.writes, [PASTE("yes do it"), CTRL_U], "no answer to the Enter question clears the paste");
  assert.equal(pasted.result.error, "not_sent");
});

test("the_file_turning_waiting_or_idle_at_the_boundary_stops_the_write_even_with_a_yes", async () => {
  for (const status of ["waiting", "idle", undefined]) {
    const t = setup();
    t.draw(repaint());
    const box = t.run();
    await t.advance(150);
    t.session.status = status;
    t.typist.verdict("c1", "paste", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [], String(status));
    assert.equal(box.result.ok, false, String(status));
  }
  const u = setup();
  await u.toPasted();
  u.draw(repaint({ input: "yes do it" }));
  await u.advance(100);
  u.session.status = "waiting";
  u.typist.verdict("c1", "enter", true);
  await u.advance(100);
  assert.deepEqual(u.pty.writes, [PASTE("yes do it"), CTRL_U], "waiting file at the Enter: no Enter");
});

test("an_idle_file_or_a_screen_that_is_not_the_prompt_never_even_asks", async () => {
  const idle = setup({ file: "idle" });
  idle.draw(repaint());
  const a = idle.run();
  await idle.advance(5000);
  assert.deepEqual(idle.asked, []);
  assert.equal(a.result, undefined, "still waiting; it is for the router to give up");
  const noPrompt = setup();
  noPrompt.draw("some output\r\nand no prompt box at all");
  noPrompt.run();
  await noPrompt.advance(5000);
  assert.deepEqual(noPrompt.asked, []);
  const dialog = setup();
  dialog.draw(`Do you want to proceed?\r\n${RULE}\r\n> \r\n${RULE}\r\n  esc to cancel`);
  dialog.run();
  await dialog.advance(5000);
  assert.deepEqual(dialog.asked, []);
});

test("cancel_before_the_paste_writes_nothing_and_after_it_clears_the_line", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(150);
  t.typist.cancel("c1");
  t.typist.verdict("c1", "paste", true);
  await t.advance(100);
  assert.deepEqual(t.pty.writes, []);
  assert.equal(box.result.error, "cancelled");

  const u = setup();
  const pasted = await u.toPasted();
  u.typist.cancel("c1");
  await u.advance(0);
  assert.deepEqual(u.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(pasted.result.error, "cancelled");
  // A late yes for the Enter does nothing.
  u.typist.verdict("c1", "enter", true);
  await u.advance(100);
  assert.equal(u.pty.writes.includes("\r"), false);
});

test("the_wearer_taking_over_with_esc_after_the_paste_gets_ctrl_u_and_no_enter", async () => {
  const t = setup();
  const box = await t.toPasted();
  const passed = t.input.key("\x1b");
  assert.equal(passed, "\x1b", "the takeover key passes");
  await t.advance(0);
  assert.equal(box.result.error, "taken_over");
  assert.equal(t.pty.writes.includes("\r"), false);
  assert.equal(t.pty.writes.includes(CTRL_U), true);
});

test("an_incomplete_escape_sequence_or_a_switch_of_screens_after_the_paste_fails_closed", async () => {
  const sequence = setup();
  const a = await sequence.toPasted();
  sequence.draw(`${repaint({ input: "yes do it" })}\x1b[`);
  await sequence.advance(1800);
  assert.deepEqual(sequence.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(a.result.error, "not_sent");

  const alt = setup();
  const b = await alt.toPasted();
  alt.draw(`\x1b[?1049h${repaint({ input: "yes do it" })}`);
  await alt.advance(1800);
  assert.deepEqual(alt.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.equal(b.result.error, "not_sent");
});

test("a_resize_after_the_paste_fails_closed", async () => {
  const t = setup();
  const box = await t.toPasted();
  t.screen.resize(100, 30);
  t.draw(repaint({ input: "yes do it" }));
  await t.advance(300);
  assert.equal(t.pty.writes.includes("\r"), false);
  assert.equal(box.result.error, "not_sent");
});

test("a_character_of_uncertain_width_in_the_reply_cannot_be_confirmed_and_is_cleared", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run({ text: "ok 👍" });
  await t.advance(150);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  t.draw(repaint({ input: "ok 👍" }));
  await t.advance(1800);
  assert.equal(t.pty.writes.includes("\r"), false);
  assert.equal(box.result.error, "not_sent");
});

test("a_spinner_animating_every_200ms_does_not_starve_a_ready_write", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  const frames = ["✶", "✢", "✻", "·"];
  let i = 0;
  const animate = async (ms) => {
    for (let left = ms; left > 0; left -= 200) {
      t.draw(`\x1b[s\x1b[3;1H\x1b[2K${frames[i++ % 4]} Working…\x1b[u`);
      await t.advance(200);
    }
  };
  await animate(600);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], "asked despite the output never going quiet");
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  t.draw(`\x1b[s\x1b[5;1H\x1b[2K> yes do it\x1b[u`);
  await animate(600);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"]);
  t.typist.verdict("c1", "enter", true);
  await flush();
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), "\r"]);
  assert.deepEqual(box.result, { ok: true });
});

test("keys_the_screen_does_not_show_are_no_draft_and_held_keys_keep_the_paste_back", async () => {
  const t = setup();
  t.draw(repaint());
  t.input.key("\x1b");
  t.input.key("half a thou");
  assert.equal(t.input.draft, true, "the key stream says draft");
  const box = t.run();
  await t.advance(150);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], "the box is empty, so the guess blocks nothing");
  t.typist.cancel("c1");
  await t.advance(0);
  assert.equal(box.result.error, "cancelled");
  // Keys held for another command's paste keep a new reply back.
  const u = setup();
  u.draw(repaint());
  u.input.hold();
  const held = u.run();
  await u.advance(3000);
  assert.deepEqual(u.asked, []);
  assert.deepEqual(held.result, undefined);
});

test("a_text_that_is_not_one_short_line_is_refused_before_anything_is_written", async () => {
  for (const text of ["two\nlines", "x".repeat(601), "   "]) {
    const t = setup();
    t.draw(repaint());
    const box = t.run({ text });
    await flush();
    assert.deepEqual(box.result, { ok: false, error: "not_ready" });
    assert.deepEqual(t.pty.writes, []);
  }
  // Only a text command may be a background reply.
  const u = setup();
  const compact = u.run({ command: "compact", text: undefined });
  await flush();
  assert.deepEqual(compact.result, { ok: false, error: "not_ready" });
});

test("a_typist_without_the_screen_never_types_a_background_reply", async () => {
  const pty = new FakePty();
  const clock = new FakeClock();
  const input = new LaptopInput({ clock });
  const typist = new Typist(pty, input, () => true, clock, { binding: { gen: 1, uncertain: false } });
  const result = await typist.run({ cmdId: "c1", gen: 1, command: "text", text: "hi", bgReply: true });
  assert.deepEqual(result, { ok: false, error: "not_ready" });
  assert.deepEqual(pty.writes, []);
});

test("the_keyboard_is_not_frozen_after_the_enter_though_the_file_stays_busy", async () => {
  const t = setup();
  await t.toPasted();
  t.input.key("a");
  t.draw(repaint({ input: "yes do it" }));
  await t.advance(100);
  t.typist.verdict("c1", "enter", true);
  await flush();
  assert.equal(t.input.holding, false);
  assert.equal(t.pty.writes.at(-1), "a", "the held key was replayed after the Enter");
});

test("an_idle_reply_takes_the_same_two_phases_without_asking_agentd", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw(repaint({ input: "\x1b[2mrun the suite\x1b[22m" }));
  const box = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
  await t.advance(200);
  assert.deepEqual(t.pty.writes, [PASTE("plain")], "the paste, and no Enter yet");
  assert.deepEqual(t.asked, [], "an idle reply needs no word from agentd");
  t.draw(repaint({ input: "plain" }));
  await t.advance(200);
  assert.deepEqual(t.pty.writes, [PASTE("plain"), "\r"]);
  assert.deepEqual(box.result, { ok: true });
});

test("an_idle_reply_with_the_wearers_text_appearing_during_the_paste_window_is_cleared_and_not_sent", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw(repaint());
  const box = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
  await t.advance(200);
  assert.deepEqual(t.pty.writes, [PASTE("plain")]);
  // The wearer's own character landed beside the paste.
  t.draw(repaint({ input: "xplain" }));
  await t.advance(1700);
  assert.deepEqual(t.pty.writes, [PASTE("plain"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("an_idle_reply_is_refused_for_a_tainted_screen_and_a_dialog_and_never_pastes", async () => {
  for (const [what, draw] of [
    ["tainted", (t) => t.draw("\x1b[1;20r")],
    ["a dialog", (t) => t.draw(`Do you want to proceed?\r\n${RULE}\r\n> \r\n${RULE}\r\n  esc to cancel`)],
  ]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint());
    draw(t);
    const box = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
    await t.advance(300);
    assert.deepEqual(t.pty.writes, [], what);
    assert.deepEqual(box.result, { ok: false, error: "not_sent" }, what);
  }
});

test("an_idle_reply_waits_for_the_file_to_read_idle", async () => {
  const t = setup({ file: "busy" });
  t.draw(repaint());
  const box = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
  await t.advance(3000);
  assert.deepEqual(t.pty.writes, [], "a busy file lets no ordinary reply through");
  assert.equal(box.result, undefined);
});

test("every_look_of_the_screen_check_is_reported_as_names_and_lengths_only", async () => {
  const t = setup();
  t.draw(repaint({ input: "\x1b[2mrun the suite\x1b[22m" }));
  t.run({ text: "secret words" });
  await t.advance(150);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  t.draw(repaint({ input: "secret words" }));
  await t.advance(100);
  t.typist.verdict("c1", "enter", true);
  await t.advance(0);
  assert.deepEqual(
    t.checks.map((c) => [c.phase, c.probe, c.reason, c.textLen, c.outcome]),
    [
      ["pre", "prompt", "empty", "run the suite".length, "ok"],
      ["post", "prompt", "text", "secret words".length, "ok"],
    ],
  );
  assert.equal(JSON.stringify(t.checks).includes("secret"), false);
  const refused = setup();
  refused.draw(repaint({ input: "typed by the wearer" }));
  refused.run();
  await refused.advance(150);
  assert.deepEqual(
    refused.checks.map((c) => [c.phase, c.reason, c.textLen, c.outcome]),
    [["pre", "text", "typed by the wearer".length, "refused"]],
  );
});

test("a_box_that_is_not_visibly_empty_gets_no_paste_and_the_wearers_text_is_never_touched", async () => {
  for (const [what, screenDraw, error] of [
    ["text in the box", repaint({ input: "something half typed" }), "laptop_draft"],
    ["a queued follow-up", repaint({ input: "\x1b[38;2;215;119;87mfollow up on the failing test\x1b[0m" }), "laptop_draft"],
    ["typed text that looks like the hint", repaint({ input: 'Try "do not overwrite this"' }), "laptop_draft"],
    ["a draft after a reset into an unreadable colour", repaint({ input: "\x1b[2mhint\x1b[0;38:2::255:0:0mprivate draft\x1b[0m" }), "laptop_draft"],
    ["a question beside it", repaint({ above: ["Which suite should I run?"], input: "x", footer: ["  Enter to select · ↑/↓ to navigate"] }), "not_sent"],
    ["a dialog", `Do you want to proceed?\r\n${RULE}\r\n> \r\n${RULE}\r\n  esc to cancel`, "not_sent"],
    ["a running turn", repaint({ above: ["✻ Thinking… (3s · esc to interrupt)"] }), "not_sent"],
  ]) {
    const t = setup();
    t.draw(screenDraw);
    const box = t.run();
    await t.advance(300);
    // Nothing was pasted, so there is nothing to clear: no Ctrl+U, which would take the wearer's text with it.
    assert.deepEqual(t.pty.writes, [], what);
    assert.deepEqual(t.asked, [], `${what}: agentd is not even asked`);
    assert.deepEqual(box.result, { ok: false, error }, what);
  }
});

test("a_screen_the_model_cannot_read_is_refused_after_5_s_not_waited_on_for_a_minute", async () => {
  const t = setup();
  t.draw("Welcome back\r\nResuming…");
  const box = t.run();
  await t.advance(4800);
  assert.equal(box.result, undefined);
  await t.advance(400);
  // Claude may be idle: the launcher only cannot find the box, which is not "busy" and gets its own word.
  assert.deepEqual(box.result, { ok: false, error: "screen_unreadable" });
  assert.deepEqual(t.pty.writes, []);
  assert.equal(t.shapes.length, 1, "and one line says what the screen looked like");
});

test("a_muted_placeholder_or_suggestion_is_an_empty_box_and_the_paste_goes", async () => {
  for (const input of ['\x1b[2mTry "fix lint errors"\x1b[22m', "\x1b[2mrun the test suite\x1b[22m","\x1b[90msuggestion\x1b[39m"]) {
    const t = setup();
    t.draw(repaint({ input }));
    t.run();
    await t.advance(150);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], input);
    t.typist.verdict("c1", "paste", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it")], input);
  }
});

test("a_box_that_fills_between_agentds_yes_and_the_paste_gets_no_paste", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(150);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"]);
  // A subagent's question lands in the box before the yes arrives.
  t.draw(repaint({ above: ["bg agent: should I delete the branch?"], input: "", footer: ["  Enter to select · ↑/↓ to navigate"] }));
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  assert.deepEqual(t.pty.writes, []);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("a_question_that_appears_between_the_paste_and_the_check_is_cleared_and_never_sent", async () => {
  const t = setup();
  const box = await t.toPasted();
  // The paste echoes, and in the same moment a subagent's question takes the footer.
  t.draw(repaint({ input: "yes do it", footer: ["  Enter to select · ↑/↓ to navigate"] }));
  await t.advance(300);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"]);
});

test("text_other_than_ours_in_the_box_after_the_paste_is_cleared_and_never_sent", async () => {
  const t = setup();
  const box = await t.toPasted();
  t.draw(repaint({ input: "yes do it and a follow-up suggestion" }));
  await t.advance(1700);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("an_enter_needs_the_check_to_pass_on_two_looks", async () => {
  const t = setup();
  await t.toPasted();
  t.draw(repaint({ input: "yes do it" }));
  await t.advance(0);
  // One look only: the Enter has not even been asked about.
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"]);
  await t.advance(60);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"]);
});

/** The prompt redrawn row by row in place, with nothing erased, as an app repainting after a resize might. */
function inPlace({ input = "" } = {}) {
  return `\x1b[H${["● Done with the review.", "", "✻ Working…", RULE, `> ${input}`, RULE, FOOTER].map((row) => `${row}\x1b[K`).join("\r\n")}`;
}

test("a_screen_tainted_before_the_paste_gets_no_paste_and_no_baseline_excuses_it", async () => {
  for (const [what, taint] of [
    ["a resize", (t) => t.screen.resize(100, 30)],
    ["a scroll region", (t) => t.draw("\x1b[1;20r")],
    ["DECALN", (t) => t.draw("\x1b#8")],
    ["a reset", (t) => t.draw("\x1bc")],
    ["an alternate screen visit", (t) => t.draw("\x1b[?1049h\x1b[?1049l")],
  ]) {
    const t = setup();
    t.draw(repaint());
    taint(t);
    // The stale grid, redrawn in place, still reads as an empty prompt.
    t.draw(inPlace());
    const box = t.run();
    await t.advance(300);
    assert.deepEqual(t.pty.writes, [], what);
    assert.deepEqual(t.asked, [], `${what}: agentd is not even asked`);
    assert.deepEqual(box.result, { ok: false, error: "not_sent" }, what);
  }
});

test("a_tainted_screen_is_trusted_again_only_after_the_whole_screen_is_erased_and_redrawn", async () => {
  const t = setup();
  t.draw(repaint());
  t.screen.resize(100, 30);
  t.draw(repaint());
  assert.equal(t.screen.tainted, false);
  t.run();
  await t.advance(150);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste"]);
});

test("a_screen_that_taints_after_a_clean_check_still_fails_the_paste_even_with_agentds_yes", async () => {
  const t = setup();
  t.draw(repaint());
  const box = t.run();
  await t.advance(150);
  t.draw("\x1b[1;20r");
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  assert.deepEqual(t.pty.writes, []);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("text_that_differs_from_the_reply_by_a_word_space_is_cleared_and_never_sent", async () => {
  for (const shown of ["yesdo it", "yes doit", "ye s do it"]) {
    const t = setup();
    const box = await t.toPasted("yes do it");
    t.draw(repaint({ input: shown }));
    await t.advance(1700);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U], shown);
    assert.deepEqual(box.result, { ok: false, error: "not_sent" }, shown);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], shown);
  }
});

test("a_background_reply_goes_on_a_shell_file_too_and_on_no_other_status_but_busy", async () => {
  for (const [status, asks] of [["shell", true], ["busy", true], ["waiting", false], ["mystery", false], [undefined, false]]) {
    const t = setup({ file: status ?? "busy" });
    t.session.status = status;
    t.draw(repaint());
    t.run();
    await t.advance(300);
    assert.deepEqual(t.asked.map((a) => a.phase), asks ? ["paste"] : [], String(status));
  }
});

// ---- Codex's five findings against the two-phase typing ------------------------------

test("an_enter_is_never_pressed_for_text_that_differs_in_interior_whitespace", async () => {
  for (const [file, shown] of [["idle", "hello  world"], ["busy", "hello  world"], ["idle", "hello world"]]) {
    const t = setup({ file });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint());
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "hello world", ...(file === "busy" ? { bgReply: true } : {}) }));
    await t.advance(150);
    if (file === "busy") {
      t.typist.verdict("c1", "paste", true);
      await t.advance(0);
    }
    t.draw(repaint({ input: shown }));
    await t.advance(1700);
    assert.deepEqual(t.pty.writes, [PASTE("hello world"), CTRL_U], `${file} ${JSON.stringify(shown)}`);
    assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  }
});

test("a_key_typed_in_the_paste_window_is_replayed_once_after_the_enter_whatever_the_file_says", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw(repaint());
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await t.advance(150);
  assert.equal(t.input.holding, true, "held from the paste");
  assert.equal(t.input.key("1"), "", "a key in the window is held");
  t.draw(repaint({ input: "plain" }));
  await t.advance(150);
  assert.deepEqual(box.result, { ok: true });
  assert.deepEqual(t.pty.writes, [PASTE("plain"), "\r", "1"], "the held key follows the Enter, in order, once");
  assert.equal(t.input.holding, false);
  // Claude's file is still idle, then waits on a permission dialog: the next key is the wearer's, not held.
  t.session.status = "waiting";
  assert.equal(t.input.key("2"), "2");
  await t.advance(60_000);
  assert.equal(t.input.key("3"), "3");
});

test("an_aborted_reply_releases_the_keyboard_at_once_and_replays_in_order_or_drops_when_unsure", async () => {
  // A paste that fails the check and is cleared: the held keys are replayed after the Ctrl+U.
  const cleared = setup({ file: "idle" });
  cleared.session.statusUpdatedAt = cleared.clock.now() - 10_000;
  cleared.draw(repaint());
  const a = track(cleared.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await cleared.advance(150);
  assert.equal(cleared.input.key("1"), "");
  assert.equal(cleared.input.key("2"), "");
  cleared.draw(repaint({ input: "other" }));
  await cleared.advance(1700);
  cleared.draw(repaint());
  await cleared.advance(100);
  assert.equal(a.result.error, "not_sent");
  assert.deepEqual(cleared.pty.writes, [PASTE("plain"), CTRL_U, "12"]);
  assert.equal(cleared.input.holding, false);
  // A clear nobody could see: the keyboard is the wearer's at once, and what they typed meanwhile is dropped, not replayed.
  const unsure = setup({ file: "idle" });
  unsure.session.statusUpdatedAt = unsure.clock.now() - 10_000;
  unsure.draw(repaint());
  const b = track(unsure.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await unsure.advance(150);
  assert.equal(unsure.input.key("1"), "");
  // The box is not on screen at all (nothing a wearer could be answering), so the clear cannot be seen.
  unsure.draw("\x1b[2J\x1b[HResuming the session");
  await unsure.advance(4000);
  assert.equal(b.result.error, "screen_unreadable");
  assert.equal(unsure.binding.uncertain, true);
  assert.equal(unsure.input.holding, false, "never left held waiting for a status");
  assert.equal(unsure.pty.writes.includes("1"), false, "nothing replayed into a prompt nobody saw");
  assert.equal(unsure.input.key("y"), "y", "the next key passes");
});

test("the_two_looks_must_be_of_the_same_thing_and_restart_when_the_box_changes", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw(repaint({ input: "half typed" }));
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await t.advance(0);
  // 50 ms later (past the 40 ms gap) the wearer's text is gone: this is the first look at an empty box, not the second.
  t.clock.advance(50);
  t.draw(repaint());
  await t.advance(0);
  assert.deepEqual(t.pty.writes, [], "no paste on the first empty look");
  assert.equal(box.result, undefined, "and no refusal from the old draft either");
  await t.advance(150);
  assert.deepEqual(t.pty.writes, [PASTE("plain")], "pasted on the second empty look");
  // A draft that changes between looks never counts as two looks of a draft.
  const u = setup({ file: "idle" });
  u.session.statusUpdatedAt = u.clock.now() - 10_000;
  u.draw(repaint({ input: "a" }));
  const second = track(u.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await u.advance(0);
  for (const typed of ["ab", "abc", "abcd"]) {
    u.clock.advance(30);
    u.draw(repaint({ input: typed }));
    await u.advance(0);
  }
  assert.equal(second.result, undefined, "a line that keeps changing is never judged on two looks");
  await u.advance(150);
  assert.deepEqual(second.result, { ok: false, error: "laptop_draft" });
});

test("keys_typed_into_a_visible_dialog_during_the_cleanup_reach_the_pty", async () => {
  for (const file of ["idle", "busy"]) {
    const t = setup({ file });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint());
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain", ...(file === "busy" ? { bgReply: true } : {}) }));
    await t.advance(150);
    if (file === "busy") {
      t.typist.verdict("c1", "paste", true);
      await t.advance(0);
    }
    assert.equal(t.pty.writes[0], PASTE("plain"));
    // A permission dialog takes the screen: automation aborts, and the wearer answers it at once.
    t.draw(`\x1b[2J\x1b[HBash command\r\n  rm -rf build\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n  esc to cancel`);
    await t.advance(10);
    assert.equal(t.input.key("y"), "", "held while the reply is still being aborted");
    assert.equal(t.input.key("\r"), "");
    await t.advance(1700);
    assert.equal(box.result.error, "not_sent");
    await t.advance(300);
    assert.equal(t.pty.writes.includes("y\r"), true, `${file}: the answer typed into the dialog reaches the pty`);
    assert.equal(t.input.holding, false);
    assert.equal(t.binding.uncertain, true, "the paste in a dialog is still not assumed cleared");
  }
});

// ---- plan mode on the screen: Shift+Tab at the laptop is no hook ----------------------------

const PLAN_FOOTER = "  ⏸ plan mode on (shift+tab to cycle)";
const AUTO_FOOTER = "  ⏵⏵ auto mode on (shift+tab to cycle)";

test("a_plan_mode_footer_stops_every_reply_before_the_paste", async () => {
  for (const [file, bgReply] of [["idle", false], ["busy", true], ["shell", true]]) {
    for (const footer of [PLAN_FOOTER, "  PLAN MODE ON", "  ⏸⏸ Plan Mode On · ← 1 agent"]) {
      const t = setup({ file });
      t.session.statusUpdatedAt = t.clock.now() - 10_000;
      t.draw(repaint({ footer: [footer] }));
      const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain", ...(bgReply ? { bgReply: true } : {}) }));
      await t.advance(300);
      assert.deepEqual(t.pty.writes, [], `${file} ${footer}`);
      assert.deepEqual(t.asked, [], "agentd is not even asked");
      assert.deepEqual(box.result, { ok: false, error: "not_sent" }, `${file} ${footer}`);
      assert.deepEqual(t.checks.at(-1).reason, "plan_mode");
    }
  }
});

test("plan_mode_coming_on_between_the_paste_and_the_enter_clears_the_line_and_never_enters", async () => {
  for (const [file, bgReply] of [["idle", false], ["busy", true]]) {
    const t = setup({ file });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint({ footer: [AUTO_FOOTER] }));
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain", ...(bgReply ? { bgReply: true } : {}) }));
    await t.advance(150);
    if (bgReply) {
      t.typist.verdict("c1", "paste", true);
      await t.advance(0);
    }
    assert.equal(t.pty.writes[0], PASTE("plain"));
    // The wearer pressed Shift+Tab at the laptop: the box shows our text and the footer now says plan mode.
    t.draw(repaint({ input: "plain", footer: [PLAN_FOOTER] }));
    await t.advance(300);
    assert.deepEqual(t.pty.writes, [PASTE("plain"), CTRL_U], file);
    assert.deepEqual(box.result, { ok: false, error: "not_sent" }, file);
    assert.equal(t.asked.some((a) => a.phase === "enter"), false, "agentd is never asked about an Enter");
  }
});

test("an_enter_verdict_that_arrives_after_plan_mode_came_on_is_refused", async () => {
  const t = setup({ file: "busy" });
  t.draw(repaint({ footer: [AUTO_FOOTER] }));
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain", bgReply: true }));
  await t.advance(150);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  t.draw(repaint({ input: "plain", footer: [AUTO_FOOTER] }));
  await t.advance(100);
  assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"]);
  t.draw(repaint({ input: "plain", footer: [PLAN_FOOTER] }));
  t.typist.verdict("c1", "enter", true);
  await t.advance(0);
  assert.equal(t.pty.writes.includes("\r"), false);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("an_auto_footer_or_no_footer_or_an_unknown_one_blocks_nothing", async () => {
  for (const footer of [[AUTO_FOOTER], [], ["  ? for shortcuts"], ["  ⏵⏵ accept edits on (shift+tab to cycle)"], ["  explain plan mode off tonight"]]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint({ footer }));
    const box = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
    await t.advance(150);
    assert.deepEqual(t.pty.writes, [PASTE("plain")], JSON.stringify(footer));
    t.draw(repaint({ input: "plain", footer }));
    await t.advance(150);
    assert.deepEqual(t.pty.writes.at(-1), "\r", JSON.stringify(footer));
    assert.deepEqual(box.result, { ok: true });
  }
});

// ---- the user's real layout: agents panel under the footer, a label in the top rule ----------

const { claudeScreen } = require("./helpers/claude-screen.js");

test("a_reply_goes_through_on_the_real_layout_with_agents_and_a_selection_in_the_panel", async () => {
  for (const [file, bgReply] of [["idle", false], ["busy", true]]) {
    for (const [cols, rows, agents, selected] of [[207, 50, 4, 0], [207, 50, 8, 3], [80, 24, 4, 2]]) {
      const t = setup({ file });
      t.session.statusUpdatedAt = t.clock.now() - 10_000;
      t.screen.resize(cols, rows);
      t.draw(claudeScreen({ cols, rows, agents, selected }));
      assert.equal(t.screen.tainted, false);
      const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", ...(bgReply ? { bgReply: true } : {}) }));
      await t.advance(150);
      if (bgReply) {
        assert.deepEqual(t.asked.map((a) => a.phase), ["paste"]);
        t.typist.verdict("c1", "paste", true);
        await t.advance(0);
      }
      assert.deepEqual(t.pty.writes, [PASTE("yes do it")], `${file} ${cols}x${rows} ${agents}`);
      t.draw(claudeScreen({ cols, rows, agents, selected, input: "yes do it", entry: false }));
      await t.advance(150);
      if (bgReply) {
        t.typist.verdict("c1", "enter", true);
        await t.advance(0);
      }
      assert.deepEqual(t.pty.writes, [PASTE("yes do it"), "\r"], `${file} ${cols}x${rows} ${agents}`);
      assert.deepEqual(box.result, { ok: true });
      assert.deepEqual(t.shapes, []);
    }
  }
});

test("a_screen_with_no_box_is_screen_unreadable_with_one_shape_line_and_no_text_in_it", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw("\x1b[2J\x1b[H● the launch code is 12345\r\n❯ hunter2\r\n  ○ general-purpose  Task\r\n❯ ○ general-purpose  Task");
  const first = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await t.advance(5400);
  assert.deepEqual(first.result, { ok: false, error: "screen_unreadable" });
  assert.deepEqual(t.pty.writes, [], "nothing typed");
  assert.equal(t.shapes.length, 1);
  assert.deepEqual([t.shapes[0].reason, t.shapes[0].cols, t.shapes[0].rows], ["no_box", 80, 24]);
  assert.equal(JSON.stringify(t.shapes).includes("12345"), false);
  assert.equal(JSON.stringify(t.shapes).includes("hunter2"), false);
  // The same screen again says nothing more: one line per change.
  const second = track(t.typist.run({ cmdId: "c2", gen: 1, command: "text", text: "plain" }));
  await t.advance(5400);
  assert.deepEqual(second.result, { ok: false, error: "screen_unreadable" });
  assert.equal(t.shapes.length, 1);
  // A different screen is a different line.
  t.draw("\x1b[2J\x1b[Hsomething else\r\nentirely");
  const third = track(t.typist.run({ cmdId: "c3", gen: 1, command: "text", text: "plain" }));
  await t.advance(5400);
  assert.equal(third.result.error, "screen_unreadable");
  assert.equal(t.shapes.length, 2);
});

test("a_box_that_vanishes_after_the_paste_is_cleared_and_screen_unreadable_not_busy", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  t.draw(repaint());
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await t.advance(150);
  assert.deepEqual(t.pty.writes, [PASTE("plain")]);
  t.draw("\x1b[2J\x1b[HResuming the session");
  await t.advance(1700);
  assert.deepEqual(t.pty.writes, [PASTE("plain"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "screen_unreadable" });
  assert.equal(t.shapes.length, 1);
});

test("a_dialog_beside_a_screen_with_no_box_is_not_sent_through_the_unreadable_path_and_logs_its_shape", async () => {
  const t = setup({ file: "idle" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  // No rule pair at all (so the probe says no_box, not blocked) but a dialog's text is on the screen.
  t.draw("\x1b[2J\x1b[HDo you want to proceed?\r\n  1. Yes\r\n  2. No\r\n  Esc to cancel");
  assert.equal(probe(t.screen).kind, "unknown");
  assert.equal(probe(t.screen).reason, "no_box");
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await t.advance(300);
  assert.equal(box.result, undefined, "still waiting: the screen is unreadable, not refused at once");
  await t.advance(5200);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  assert.deepEqual(t.pty.writes, [], "nothing typed");
  assert.equal(t.shapes.length, 1, "the shape of a screen with no box is still logged");
});

test("a_draft_of_many_rows_or_with_a_rule_like_row_is_laptop_draft_and_not_unreadable", async () => {
  const long = ["> first line", ...Array.from({ length: 13 }, (_, i) => `  line ${i + 2} of a long draft`)];
  const ruleLike = ["> first line", `${"─".repeat(12)} foo ─`, "  last"];
  for (const [what, rows] of [["long", long], ["rule-like", ruleLike]]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(`\x1b[2J\x1b[H● Done.\r\n${[RULE, ...rows, RULE, FOOTER].join("\r\n")}`);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
    await t.advance(300);
    assert.deepEqual(box.result, { ok: false, error: "laptop_draft" }, what);
    assert.deepEqual(t.pty.writes, [], what);
    assert.deepEqual(t.shapes, [], `${what}: a box was found`);
  }
});

test("muted_rows_between_two_rules_stay_screen_unreadable_and_a_rule_like_draft_row_is_a_draft", async () => {
  const gray = (text) => `\x1b[38;5;244m${text}\x1b[0m`;
  const faint = (text) => `\x1b[2m${text}\x1b[0m`;
  const grayRule = gray("─".repeat(60));
  const box = [grayRule, `❯ ${faint('Try "fix the tests"')}`, grayRule];
  const agents = Array.from({ length: 12 }, (_, i) => faint(`  ○ agent ${i}`));
  for (const [what, rows] of [
    ["a footer and a lower rule", [...box, faint("  auto mode on"), grayRule]],
    ["twelve agent rows and a lower rule", [...box, faint("  auto mode on"), ...agents, grayRule]],
  ]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(`\x1b[2J\x1b[H● Done.\r\n${rows.join("\r\n")}`);
    const run = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
    await t.advance(5400);
    assert.deepEqual(run.result, { ok: false, error: "screen_unreadable" }, what);
    assert.deepEqual(t.pty.writes, [], `${what}: nothing typed`);
    assert.equal(t.shapes.length, 1, `${what}: one shape line`);
  }
  // The user's own text with a row that reads as a rule: a draft, whatever follows it, and nothing is typed.
  for (const [what, tail] of [["bare glyph", ["  >"]], ["glyph and space", ["  > "]], ["glyph, space and blank row", ["  > ", ""]]]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(`\x1b[2J\x1b[H● Done.\r\n${[RULE, "❯ hello", "  ────────────", ...tail, RULE, FOOTER].join("\r\n")}`);
    const run = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
    await t.advance(300);
    assert.deepEqual(run.result, { ok: false, error: "laptop_draft" }, what);
    assert.deepEqual(t.pty.writes, [], what);
  }
});

test("a_draft_whose_top_scrolled_off_gets_nothing_typed_either_way_the_rule_like_row_is_drawn", async () => {
  const draft = Array.from({ length: 12 }, (_, i) => `  draft line ${i}`);
  const footer = [FOOTER, "", "● main", "  ○ general-purpose  Task one"];
  for (const [what, tail] of [["glyph and space", ["  > "]], ["second glyph", ["  ❯"]], ["glyph and a blank row", ["  > ", ""]], ["bare >", ["  >"]]]) {
    for (const file of ["idle", "busy"]) {
      const t = setup({ file });
      t.session.statusUpdatedAt = t.clock.now() - 10_000;
      t.draw(`\x1b[2J\x1b[H${[...draft, "  ──────────────", ...tail, RULE, ...footer].join("\r\n")}`);
      const run = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain", ...(file === "busy" ? { bgReply: true } : {}) }));
      await t.advance(5400);
      assert.equal(run.result?.ok, false, `${what} ${file}`);
      assert.deepEqual(t.pty.writes, [], `${what} ${file}: nothing typed`);
      assert.deepEqual(t.asked, [], `${what} ${file}: agentd is not even asked`);
    }
  }
});

// ---- a queued reply: typed while a turn runs, on agentd's word about the screen ---------------------------

const real = require("./helpers/claude-real-turn.js");
const { layout } = require("./helpers/claude-layouts.js");

/** The real capture replayed up to chunk `index`, on a 207x50 screen. */
function replay(t, index) {
  t.screen.resize(real.COLS, real.ROWS);
  real.CHUNKS.slice(0, index + 1).forEach((chunk) => t.draw(chunk));
  assert.equal(t.screen.tainted, false);
}

/** What the real UI draws on the prompt row once our text is pasted: the capture's prompt row is the 48th (index 47). */
const typedRow = (text) => `\x1b[48;1H\x1b[K❯ ${text}`;

test("a_queued_reply_is_pasted_and_verified_exactly_on_the_real_mid_turn_screen_and_ends_at_the_enter", async () => {
  for (const file of ["busy", "shell", "idle"]) {
    const t = setup({ file });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    replay(t, real.AFTER.working);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, queued: true }));
    await t.advance(150);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], `${file}: two looks of an empty box, then agentd is asked`);
    t.typist.verdict("c1", "paste", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it")], file);
    // The turn still runs (the spinner and `esc to interrupt` are on screen); the box shows exactly our text.
    t.draw(typedRow("yes do it"));
    assert.equal(t.screen.lines().some((row) => /esc to interrupt/.test(row)), true, "the turn is still running");
    await t.advance(150);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"], file);
    t.typist.verdict("c1", "enter", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it"), "\r"], file);
    assert.deepEqual(box.result, { ok: true }, file);
    assert.deepEqual(t.shapes, [], file);
  }
});

test("a_queued_reply_is_typed_verified_and_entered_beside_the_agents_panel_in_every_shape", async () => {
  const { promptLine } = require("./helpers/claude-layouts.js");
  for (const [cols, rows, agents, selected, phase] of [
    [207, 50, 3, -1, "waiting"],
    [207, 50, 3, "main", "waiting"],
    [207, 50, 3, 1, "working"],
    [80, 24, 8, 0, "waiting"],
    [207, 50, 0, -1, "idle"],
  ]) {
    const what = `${cols}x${rows} agents ${agents} selected ${selected} ${phase}`;
    const t = setup({ file: "shell" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.screen.resize(cols, rows);
    t.draw(layout({ cols, rows, agents, selected, phase, monitors: 2, right: "updateGoalSeconds", cursor: "blank" }));
    assert.equal(t.screen.tainted, false, what);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, queued: true }));
    await t.advance(150);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], what);
    t.typist.verdict("c1", "paste", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it")], what);
    t.draw(`\x1b[${promptLine({ rows, agents })};1H\x1b[K❯ yes do it`);
    await t.advance(150);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste", "enter"], what);
    t.typist.verdict("c1", "enter", true);
    await t.advance(0);
    assert.deepEqual(t.pty.writes, [PASTE("yes do it"), "\r"], what);
    assert.deepEqual(box.result, { ok: true }, what);
  }
});

test("the_same_reply_without_the_queued_flag_is_refused_by_a_running_turn_and_nothing_is_typed", async () => {
  const t = setup({ file: "busy" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  replay(t, real.AFTER.working);
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true }));
  await t.advance(300);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  assert.deepEqual(t.pty.writes, []);
  assert.deepEqual(t.asked, []);
});

test("a_queued_reply_is_refused_on_a_dialog_a_plan_footer_text_in_the_box_and_a_tainted_screen", async () => {
  for (const [what, prepare, error] of [
    ["a dialog", (t) => t.draw(claudeScreen({ cols: 80, rows: 24, agents: 0, dialog: true })), "not_sent"],
    ["a dialog replacing a working screen", (t) => t.draw(`\x1b[2J\x1b[HDo you want to proceed?\r\n${RULE}\r\n❯ 1. Yes\r\n${RULE}\r\n  esc to interrupt`), "not_sent"],
    ["the plan footer", (t) => t.draw(layout({ cols: 80, rows: 24, footer: "plan", phase: "working" })), "not_sent"],
    ["text in the box", (t) => t.draw(claudeScreen({ cols: 80, rows: 24, agents: 0, input: "half typed" })), "laptop_draft"],
    ["a tainted screen", (t) => {
      t.draw(layout({ cols: 80, rows: 24, phase: "working" }));
      t.draw("\x1b[1;20r");
    }, "not_sent"],
  ]) {
    const t = setup({ file: "busy" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    prepare(t);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, queued: true }));
    await t.advance(5400);
    assert.deepEqual(box.result, { ok: false, error: error }, what);
    assert.deepEqual(t.pty.writes, [], `${what}: nothing typed`);
    assert.deepEqual(t.asked, [], `${what}: agentd is not asked`);
  }
});

test("a_queued_reply_whose_text_never_shows_is_cleared_and_not_sent_while_the_turn_runs", async () => {
  const t = setup({ file: "shell" });
  t.session.statusUpdatedAt = t.clock.now() - 10_000;
  replay(t, real.AFTER.working);
  const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, queued: true }));
  await t.advance(150);
  t.typist.verdict("c1", "paste", true);
  await t.advance(0);
  // The box shows something else than what was pasted.
  t.draw(typedRow("something else"));
  await t.advance(1700);
  assert.deepEqual(t.pty.writes, [PASTE("yes do it"), CTRL_U]);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
});

test("a_queued_reply_is_typed_only_on_a_file_that_says_idle_busy_or_shell", async () => {
  for (const file of ["waiting", "starting", "BUSY", ""]) {
    const t = setup({ file });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    replay(t, real.AFTER.working);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "yes do it", bgReply: true, queued: true }));
    await t.advance(3000);
    assert.deepEqual(t.pty.writes, [], `${JSON.stringify(file)}: nothing typed`);
    assert.deepEqual(t.asked, [], file);
    assert.equal(box.result, undefined, `${JSON.stringify(file)}: it waits for a file it can go on`);
    t.session.status = "shell";
    await t.advance(400);
    assert.deepEqual(t.asked.map((a) => a.phase), ["paste"], `${JSON.stringify(file)}: and goes once it says shell`);
  }
});

test("a_queued_flag_needs_a_background_reply_and_a_text", async () => {
  const t = setup({ file: "busy" });
  replay(t, real.AFTER.working);
  const compact = track(t.typist.run({ cmdId: "c1", gen: 1, command: "compact", bgReply: true, queued: true }));
  await t.advance(100);
  assert.deepEqual(compact.result, { ok: false, error: "not_ready" });
  assert.deepEqual(t.pty.writes, []);
});

test("a_tainted_screen_refusal_logs_no_shape_and_a_huge_terminal_logs_one_the_hub_accepts", async () => {
  const tainted = setup({ file: "idle" });
  tainted.session.statusUpdatedAt = tainted.clock.now() - 10_000;
  tainted.draw(repaint());
  tainted.draw("\x1b[1;20r");
  const box = track(tainted.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await tainted.advance(5400);
  assert.deepEqual(box.result, { ok: false, error: "not_sent" });
  assert.deepEqual(tainted.shapes, [], "a disturbed screen says nothing about its layout");

  const huge = setup({ file: "idle" });
  huge.session.statusUpdatedAt = huge.clock.now() - 10_000;
  huge.screen.resize(2100, 1100);
  huge.draw("\x1b[2J\x1b[H" + Array.from({ length: 1100 }, (_, i) => `row ${i} of nothing`).join("\r\n"));
  const big = track(huge.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
  await huge.advance(5400);
  assert.equal(big.result.ok, false);
  assert.equal(huge.shapes.length, 1);
  const [shape] = huge.shapes;
  assert.equal(shape.cols >= 1 && shape.cols <= 2000, true);
  assert.equal(shape.rows >= 1 && shape.rows <= 1000, true);
  assert.match(shape.shape, /^[0-9BRPMGT ]{0,8000}$/);
});

test("the_busy_cases_keep_not_sent_and_a_draft_keeps_laptop_draft", async () => {
  // A tainted (changing) screen, a dialog, plan mode: Claude is busy or in the way, not unreadable.
  for (const [what, draw, error] of [
    ["tainted", (t) => t.draw("\x1b[1;20r"), "not_sent"],
    ["dialog", (t) => t.draw(`Do you want to proceed?\r\n${RULE}\r\n> \r\n${RULE}\r\n  esc to cancel`), "not_sent"],
    ["plan mode", (t) => t.draw(repaint({ footer: ["  ⏸ plan mode on (shift+tab to cycle)"] })), "not_sent"],
    ["text in the box", (t) => t.draw(repaint({ input: "half typed" })), "laptop_draft"],
  ]) {
    const t = setup({ file: "idle" });
    t.session.statusUpdatedAt = t.clock.now() - 10_000;
    t.draw(repaint());
    draw(t);
    const box = track(t.typist.run({ cmdId: "c1", gen: 1, command: "text", text: "plain" }));
    await t.advance(300);
    assert.equal(box.result?.error, error, what);
  }
});
