"use strict";
/**
 * The prompt box on a screen like the user's real one (a screenshot of Claude Code 2.1.285 with background
 * agents, 207x50): a transcript that holds `❯` rows of its own, an update notice, a top rule that carries a
 * label, the prompt line with a muted suggestion and the cursor on its first letter, a bottom rule, a footer,
 * and an agents panel under it (`● main`, a `○` row per agent, the selection `❯` on one of them). The screens
 * are built by test/helpers/claude-screen.js; nothing here needs a real claude.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ScreenModel,
  probe,
  showsEmptyPrompt,
  showsExactly,
  showsDialog,
  showsPlanMode,
  describeShape,
} = require("../dist/launcher/screen-probe.js");
const { claudeScreen } = require("./helpers/claude-screen.js");

const SIZES = [
  [207, 50],
  [80, 24],
];
const AGENTS = [0, 1, 4, 8];

function model(options) {
  const screen = new ScreenModel(options.cols, options.rows);
  screen.push(claudeScreen(options));
  return screen;
}

test("the_box_is_found_empty_on_every_layout_with_any_number_of_agents_and_any_selection", () => {
  for (const [cols, rows] of SIZES) {
    for (const agents of AGENTS) {
      for (const selected of [-1, 0, Math.floor(agents / 2), agents - 1].filter((v, i, all) => (v === -1 || (v >= 0 && v < agents)) && all.indexOf(v) === i)) {
        for (const label of [undefined, " Rokid app for Claude code integration", " a label that is quite long and takes most of an eighty column row"]) {
          const screen = model({ cols, rows, agents, selected, label: label ?? "" });
          const seen = probe(screen);
          const what = `${cols}x${rows} agents ${agents} selected ${selected} label ${label ? label.length : "none"}`;
          assert.equal(seen.kind, "prompt", what);
          assert.equal(showsEmptyPrompt(seen), true, `${what}: the muted suggestion with the cursor on its first letter is empty`);
          assert.equal(screen.tainted, false, what);
        }
      }
    }
  }
});

test("typed_text_is_text_and_a_pasted_reply_is_verified_exactly_beside_the_panel", () => {
  for (const [cols, rows] of SIZES) {
    for (const agents of AGENTS) {
      const typed = probe(model({ cols, rows, agents, selected: agents > 0 ? 0 : -1, input: "half typed" }));
      assert.equal(typed.kind, "prompt");
      assert.equal(typed.empty, false, `${cols}x${rows} ${agents}`);
      const pasted = probe(model({ cols, rows, agents, selected: agents - 1, input: "yes do it" }));
      assert.equal(showsExactly(pasted, "yes do it"), true, `${cols}x${rows} ${agents}`);
      assert.equal(showsExactly(pasted, "yes  do it"), false);
    }
  }
});

test("a_glyph_row_in_the_panel_or_the_transcript_is_never_the_prompt", () => {
  // The panel's first row carries the selection `❯`, the transcript has a user echo `❯ continue`; the prompt
  // is the line between the two rules, so with an empty line there the box is empty whatever those say.
  const screen = model({ cols: 207, rows: 50, agents: 4, selected: 0, input: "" });
  const rows = screen.lines();
  assert.equal(rows.filter((row) => /^❯/.test(row)).length >= 3, true, "a `❯` in the transcript, in the box and in the panel");
  const seen = probe(screen);
  assert.deepEqual([seen.kind, seen.text, seen.empty], ["prompt", "", true]);
  // Text on the selected panel row (an agent called `continue`) is not what the input line holds.
  const named = new ScreenModel(207, 50);
  named.push(claudeScreen({ cols: 207, rows: 50, agents: 4, selected: 1 }).replace("Task number 2", "continue the work"));
  assert.equal(showsEmptyPrompt(probe(named)), true);
});

test("a_dialog_in_place_of_the_box_and_a_plan_mode_footer_are_still_refused_with_the_panel_present", () => {
  for (const [cols, rows] of SIZES) {
    const dialog = model({ cols, rows, agents: 4, selected: 0, dialog: true });
    assert.equal(showsDialog(dialog), true, `${cols}x${rows}`);
    assert.notEqual(showsEmptyPrompt(probe(dialog)), true, "a dialog is never an empty box");
    const plan = model({ cols, rows, agents: 4, plan: true });
    assert.equal(showsPlanMode(plan), true);
    assert.equal(probe(plan).kind, "prompt", "the box itself is still read");
    const auto = model({ cols, rows, agents: 4 });
    assert.equal(showsPlanMode(auto), false);
    assert.equal(showsDialog(auto), false);
  }
});

test("a_dialog_text_in_the_agents_panel_blocks_the_box_too", () => {
  const screen = new ScreenModel(207, 50);
  screen.push(claudeScreen({ cols: 207, rows: 50, agents: 2 }).replace("Task number 1 on the draft screen check", "Do you want to proceed?"));
  assert.equal(probe(screen).kind, "blocked");
});

test("a_screen_without_a_box_stays_unknown_and_so_does_a_prompt_row_outside_a_rule_pair", () => {
  const screen = new ScreenModel(207, 50);
  screen.push("\x1b[2J\x1b[H● Done.\r\n❯ continue\r\n  ○ general-purpose  Task\r\n❯ ○ general-purpose  Task");
  const seen = probe(screen);
  assert.deepEqual([seen.kind, seen.reason], ["unknown", "no_box"]);
  // A rule with a prompt row above it and nothing below the top: no pair, no box.
  const lone = new ScreenModel(207, 50);
  lone.push(`\x1b[2J\x1b[H❯ continue\r\n${"─".repeat(207)}\r\n  ▶▶ auto mode on`);
  assert.equal(probe(lone).kind, "unknown");
});

test("the_shape_line_describes_rows_by_class_and_length_and_leaks_no_text", () => {
  const screen = new ScreenModel(80, 24);
  screen.push("\x1b[2J\x1b[H● the secret launch code is 12345\r\n\r\n❯ hunter2\r\n" + "─".repeat(80) + "\r\n\x1b[2mmuted words\x1b[22m\r\n✻\r\n  ○ general-purpose  Task");
  const shape = describeShape(screen, probe(screen));
  assert.equal(shape.cols, 80);
  assert.equal(shape.rows, 24);
  assert.match(shape.shape, /^[0-9BRPMGT ]+$/, "classes, numbers and spaces only");
  assert.equal(shape.shape.includes("secret"), false);
  assert.equal(JSON.stringify(shape).includes("hunter2"), false);
  assert.equal(JSON.stringify(shape).includes("12345"), false);
  const tokens = Object.fromEntries(shape.shape.split(" ").map((t) => [t.match(/^\d+/)[0], t.replace(/^\d+/, "")]));
  assert.equal(tokens["0"][0], "T");
  assert.equal(tokens["1"][0], "B");
  assert.equal(tokens["2"][0], "P");
  assert.equal(tokens["3"][0], "R");
  assert.equal(tokens["3"].slice(1), "80");
  assert.equal(tokens["4"][0], "M");
  assert.equal(tokens["5"][0], "G");
  assert.equal(tokens["6"][0], "T");
  assert.equal(shape.reason, "no_box");
  assert.equal(shape.bottom, 3);
});
