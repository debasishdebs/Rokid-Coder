"use strict";
/**
 * The screen model against the bytes of the real Claude Code (2.1.285), captured at
 * an empty prompt in a trusted folder, 80x24: its startup (colours, scroll region reset,
 * the alternate screen with an erase right after it, the framed prompt box with a muted
 * placeholder), then one typed character, Ctrl+U, a bracketed paste of "hello world" with
 * no Enter, and Ctrl+U again. The text in the capture is replaced by x of the same length;
 * every escape sequence is the real one. Fixture: fixtures/claude-2.1.285-80x24.json.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { ScreenModel, probe, showsEmptyPrompt, showsText, showsExactly, showsCleared } = require("../dist/launcher/screen-probe.js");

const CAPTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "claude-2.1.285-80x24.json"), "utf8"));

/** The model after the first `count` chunks of the capture. */
function replay(count) {
  const model = new ScreenModel(CAPTURE.cols, CAPTURE.rows);
  CAPTURE.chunks.slice(0, count).forEach((chunk) => model.push(chunk));
  return model;
}
const at = (label) => CAPTURE.marks.find((mark) => mark.label === label).chunks;

test("the_real_startup_screen_is_a_clean_model_showing_an_empty_prompt_box", () => {
  const model = replay(at("startup"));
  assert.equal(model.tainted, false, "the erase Claude sends right after entering the alternate screen heals the entry");
  assert.equal(model.alternate, true, "Claude runs on the alternate screen");
  const result = probe(model);
  assert.equal(result.kind, "prompt");
  assert.equal(result.empty, true, "the placeholder is drawn muted, so the box is empty");
  assert.equal(result.text.length > 0, true, "the placeholder is on the line, and is not our text");
  assert.equal(showsEmptyPrompt(result), true);
  assert.equal(showsText(result, "hello world"), false);
});

test("a_typed_character_a_ctrl_u_and_a_paste_are_each_seen_on_the_real_input_line", () => {
  const typed = probe(replay(at("typed a")));
  assert.deepEqual([typed.kind, typed.empty, typed.text.length], ["prompt", false, 1]);
  const cleared = probe(replay(at("ctrl-u")));
  assert.deepEqual([cleared.kind, cleared.empty], ["prompt", true]);
  const pasted = replay(at("pasted hello world"));
  assert.equal(pasted.tainted, false);
  assert.equal(showsText(probe(pasted), "hello world"), true, "the bracketed paste shows whole on the input line");
  assert.equal(showsText(probe(pasted), "hello  world"), true, "runs of spaces are one");
  assert.equal(showsText(probe(pasted), "helloworld"), false);
  // The check before an Enter is exact: the real line holds the paste with its one space.
  assert.equal(showsExactly(probe(pasted), "hello world"), true);
  assert.equal(showsExactly(probe(pasted), "hello  world"), false);
  assert.equal(showsExactly(probe(pasted), "helloworld"), false);
  const after = probe(replay(at("ctrl-u after paste")));
  assert.equal(showsCleared(after, "hello world"), true);
  assert.equal(showsEmptyPrompt(after), true);
});

test("the_real_layout_is_a_rule_a_prompt_line_a_rule_and_a_footer_with_no_busy_or_dialog_sign", () => {
  const model = replay(at("startup"));
  const rows = model.lines();
  const rule = rows.findIndex((row) => /^─{40,}$/.test(row));
  assert.equal(rule > 0, true);
  // The glyph is followed by a no-break space in the real UI, which `\s` covers.
  assert.match(rows[rule + 1], /^❯\s/);
  assert.match(rows[rule + 2], /^─{40,}$/);
  assert.equal(rows.slice(rule + 3).filter(Boolean).length <= 2, true, "a short footer under the box");
});

test("no_real_startup_sequence_taints_the_model_but_leaving_the_alternate_screen_does", () => {
  const model = new ScreenModel(CAPTURE.cols, CAPTURE.rows);
  const taints = [];
  for (const chunk of CAPTURE.chunks) {
    for (const piece of chunk.match(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[^[\]])|[^\x1b]+|\x1b/g) ?? []) {
      const before = model.taints;
      model.push(piece);
      if (model.taints > before) taints.push(piece);
    }
  }
  // Only the two screen switches count; the scroll region reset, the extra colour and mouse modes, SI and
  // the terminal queries are what the model must follow without doubt.
  assert.deepEqual(taints, ["\x1b[?1049h", "\x1b[?1049l"]);
});

test("the_scroll_region_reset_and_the_real_private_modes_are_benign_but_a_region_is_not", () => {
  const model = new ScreenModel(80, 24);
  model.push("\x1b7\x1b[r\x1b8\x1b[?2031h\x1b[?1016l\x1b(B\x0f\x1b[c\x1b[6n\x1b[>4;2m\x1b[<u\x1b[?u");
  assert.equal(model.taints, 0);
  model.push("\x1b[3;20r");
  assert.equal(model.taints, 1);
  model.push("\x0e");
  assert.equal(model.taints, 2);
});

test("the_alternate_screen_is_followed_as_a_buffer_of_its_own_and_the_main_one_comes_back", () => {
  const model = new ScreenModel(80, 24);
  model.push("main screen text");
  model.push("\x1b[?1049h");
  assert.equal(model.alternate, true);
  assert.equal(model.lines().every((row) => row === ""), true, "the alternate screen starts blank");
  assert.equal(model.tainted, true, "a switch is a taint until the child erases the screen");
  model.push("\x1b[2J\x1b[Halternate text");
  assert.equal(model.tainted, false);
  assert.equal(model.lines()[0], "alternate text");
  model.push("\x1b[?1049l");
  assert.equal(model.alternate, false);
  assert.equal(model.lines()[0], "main screen text");
  assert.equal(model.tainted, true, "what comes back is trusted only after a whole-screen erase");
});

test("a_resize_while_on_the_alternate_screen_keeps_both_buffers_whole", () => {
  const model = new ScreenModel(80, 24);
  model.push("main");
  model.push("\x1b[?1049h\x1b[2Jalt");
  model.resize(100, 30);
  assert.equal(model.tainted, true);
  model.push("\x1b[?1049l");
  assert.equal(model.lines().length, 30);
  assert.equal(model.lines()[0], "main");
});
