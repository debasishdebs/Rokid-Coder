"use strict";
/**
 * The screen model and its probe: ONE job, to say positively that a pasted
 * text is on Claude's input line inside the framed prompt box. Everything
 * else is unknown, and unknown means "do not press Enter".
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { ScreenModel, probe, showsText, showsCleared, showsEmptyPrompt } = require("../dist/launcher/screen-probe.js");
const { bgReplyText } = require("../dist/launcher/paste-text.js");

const RULE = "─".repeat(60);
const FOOTER = "  ▶▶ auto mode on · ← 1 agent · PR #9";

/** A full repaint of Claude's idle screen. */
function repaint({ above = ["● Done with the review.", ""], input = "", footer = [FOOTER], continuation = [] } = {}) {
  const rows = [...above, RULE, `> ${input}`, ...continuation, RULE, ...footer];
  return `\x1b[2J\x1b[H${rows.join("\r\n")}`;
}

function screen(chunk, cols = 80, rows = 24) {
  const model = new ScreenModel(cols, rows);
  if (chunk) model.push(chunk);
  return model;
}

test("an_empty_or_placeholder_box_is_a_prompt_whose_text_is_not_ours", () => {
  const model = screen(repaint({ input: 'Try "fix lint errors"' }));
  const result = probe(model);
  assert.equal(result.kind, "prompt");
  assert.equal(showsText(result, "yes do it"), false);
});

test("a_box_is_visibly_empty_only_when_nothing_in_it_is_solid_text", () => {
  const empty = (input) => showsEmptyPrompt(probe(screen(repaint({ input }))));
  assert.equal(empty(""), true);
  assert.equal(empty("   "), true);
  // Claude's own hint in an empty box.
  assert.equal(empty('Try "fix lint errors"'), true);
  // Placeholders and suggestions are drawn faint or in gray, whatever the way.
  assert.equal(empty("\x1b[2mrun the tests\x1b[22m"), true);
  assert.equal(empty("\x1b[2mrun the tests\x1b[0m"), true);
  assert.equal(empty("\x1b[90mrun the tests\x1b[39m"), true);
  assert.equal(empty("\x1b[38;5;245mrun the tests\x1b[0m"), true);
  assert.equal(empty("\x1b[38;2;128;128;128mrun the tests\x1b[0m"), true);
  // Anything else is text: a draft, a queued message, a follow-up, a style the model cannot read.
  assert.equal(empty("run the tests"), false);
  assert.equal(empty("\x1b[0mrun the tests"), false);
  assert.equal(empty("\x1b[2m\x1b[22mrun the tests"), false);
  assert.equal(empty("\x1b[38;2;215;119;87mrun the tests\x1b[0m"), false);
  assert.equal(empty("\x1b[31mrun the tests\x1b[39m"), false);
  assert.equal(empty("\x1b[38:2::128:128:128mrun the tests\x1b[0m"), false);
  assert.equal(empty("\x1b[2mghost\x1b[22m and a draft"), false);
  // A dialog is not an empty prompt.
  assert.equal(showsEmptyPrompt({ kind: "blocked", reason: "dialog" }), false);
  assert.equal(showsEmptyPrompt({ kind: "unknown", reason: "no_box" }), false);
});

test("the_pasted_text_alone_on_the_input_line_inside_the_box_is_shown", () => {
  const model = screen(repaint({ input: "yes do it" }));
  const result = probe(model);
  assert.deepEqual(result, { kind: "prompt", text: "yesdoit", empty: false });
  assert.equal(showsText(result, "yes do it"), true);
  assert.equal(showsText(result, "yes do it please"), false);
  // Text that is not alone is not what was pasted: a laptop draft in front of it.
  assert.equal(showsText(probe(screen(repaint({ input: "draft yes do it" }))), "yes do it"), false);
});

test("a_long_reply_wrapped_over_rows_is_still_found_whole", () => {
  const text = "please run the full test suite and then summarise every failure you find in the logs";
  const model = screen(repaint({ input: text.slice(0, 40), continuation: [`  ${text.slice(40)}`] }));
  assert.equal(showsText(probe(model), text), true);
});

test("a_side_bordered_box_is_found_too", () => {
  const top = `╭${"─".repeat(58)}╮`;
  const bottom = `╰${"─".repeat(58)}╯`;
  const model = screen(`${["answer above", top, "│ > yes do it".padEnd(59) + "│", bottom, FOOTER].join("\r\n")}`);
  assert.equal(showsText(probe(model), "yes do it"), true);
});

test("the_footer_with_a_pictograph_does_not_spoil_the_box", () => {
  const model = screen(repaint({ input: "ok", footer: [FOOTER, "  ? for shortcuts"] }));
  assert.equal(showsText(probe(model), "ok"), true);
});

test("a_dialog_or_menu_or_running_turn_is_blocked_even_with_our_text_around", () => {
  const dialog = [
    "Bash command",
    "  rm -rf build",
    "Do you want to proceed?",
    RULE,
    "> yes do it",
    RULE,
    "  esc to cancel",
  ];
  assert.equal(probe(screen(dialog.join("\r\n"))).kind, "blocked");
  const menu = ["Allow this?", RULE, "❯ 1. Yes", "  2. No", RULE].join("\r\n");
  assert.equal(probe(screen(menu)).kind, "blocked");
  const running = repaint({ above: ["✻ Thinking… (12s · esc to interrupt)"], input: "yes do it" });
  assert.deepEqual(probe(screen(running)), { kind: "blocked", reason: "busy_indicator" });
  const ctrlc = repaint({ above: [], input: "yes do it", footer: ["  ctrl+c to interrupt"] });
  assert.equal(probe(screen(ctrlc)).kind, "blocked");
  const question = repaint({ above: ["Which suite?"], input: "yes do it", footer: ["  Enter to select · ↑/↓ to navigate"] });
  assert.equal(probe(screen(question)).kind, "blocked");
});

test("no_framed_box_means_unknown_never_a_prompt", () => {
  assert.equal(probe(screen("")).kind, "unknown");
  assert.equal(probe(screen("> yes do it\r\nsomething")).kind, "unknown");
  assert.equal(probe(screen(`${RULE}\r\nnot a prompt\r\n${RULE}`)).kind, "unknown");
  assert.equal(probe(screen(repaint(), 30)).kind, "unknown", "too narrow to be Claude's layout");
});

test("an_incomplete_escape_sequence_is_unknown_until_it_completes", () => {
  const model = screen(repaint({ input: "yes do it" }));
  model.push("\x1b[");
  assert.deepEqual(probe(model), { kind: "unknown", reason: "screen_unsettled" });
  model.push("m");
  assert.equal(showsText(probe(model), "yes do it"), true);
  model.push("\x1b]0;a title that never ends");
  assert.equal(probe(model).kind, "unknown");
  model.push("\x07");
  assert.equal(probe(model).kind, "prompt");
});

test("the_alternate_screen_is_unknown_and_what_comes_back_is_not_trusted_without_a_repaint", () => {
  const model = screen(repaint({ input: "yes do it" }));
  const mark = model.taints;
  model.push("\x1b[?1049h");
  assert.equal(probe(model).kind, "unknown");
  assert.equal(probe(model, { sinceTaints: mark }).kind, "unknown");
  model.push("\x1b[?1049l");
  // The old screen is not ours any more, and anything drawn before the switch is disturbed.
  assert.deepEqual(probe(model, { sinceTaints: mark }), { kind: "unknown", reason: "screen_disturbed" });
  // Drawn again after the switch, it is shown against a fresh mark.
  const fresh = model.taints;
  model.push(repaint({ input: "yes do it" }));
  assert.equal(showsText(probe(model, { sinceTaints: fresh }), "yes do it"), true);
});

test("a_resize_disturbs_what_was_drawn_before_it", () => {
  const model = screen(repaint({ input: "yes do it" }));
  const mark = model.taints;
  assert.equal(showsText(probe(model, { sinceTaints: mark }), "yes do it"), true);
  model.resize(100, 30);
  assert.deepEqual(probe(model, { sinceTaints: mark }), { kind: "unknown", reason: "screen_disturbed" });
});

test("sequences_the_model_does_not_understand_disturb_it", () => {
  for (const seq of ["\x1b[1;20r", "\x1b[3@", "\x1b[2P", "\x1b[?6h", "\x1b(0", "\x0e", "\x1b[?1h\x1b[?7l", "\x1b[4h", "\x1b[2K\x1b[?2K"]) {
    const model = screen(repaint({ input: "yes do it" }));
    const mark = model.taints;
    model.push(seq);
    assert.equal(probe(model, { sinceTaints: mark }).kind, "unknown", JSON.stringify(seq));
  }
  for (const seq of ["\x1b[?25l", "\x1b[?2004h", "\x1b[?2026h", "\x1b[38;5;99m", "\x1b[>1u", "\x1b[?u", "\x1b(B", "\x1b[0 q"]) {
    const model = screen(repaint({ input: "yes do it" }));
    const mark = model.taints;
    model.push(seq);
    assert.equal(probe(model, { sinceTaints: mark }).kind, "prompt", JSON.stringify(seq));
  }
});

test("wide_characters_take_two_cells_and_combining_marks_none", () => {
  const model = screen("漢字");
  model.push("\x1b[1;3HX");
  assert.equal(model.lines()[0], "漢X");
  const combined = screen(repaint({ input: "café ok" }));
  assert.equal(showsText(probe(combined), "café ok"), true);
  const wide = screen(repaint({ input: "好的 谢谢" }));
  assert.equal(showsText(probe(wide), "好的 谢谢"), true);
});

test("a_character_of_uncertain_width_on_the_input_line_makes_it_unknown", () => {
  for (const text of ["go 👍", "family 👨‍👩‍👧", "heart ❤️", "flag 🇮🇳"]) {
    const model = screen(repaint({ input: text }));
    assert.deepEqual(probe(model), { kind: "unknown", reason: "uncertain_width" }, text);
  }
  // The same character far from the box is not a problem.
  assert.equal(probe(screen(repaint({ above: ["Looks good 👍"], input: "ok" }))).kind, "prompt");
});

test("a_spinner_redrawn_every_frame_does_not_disturb_the_screen", () => {
  const model = screen(repaint({ above: ["", "✻ Working…"], input: "yes do it" }));
  const mark = model.taints;
  for (const frame of ["✶", "✢", "✻", "·"]) {
    model.push(`\x1b[s\x1b[2;1H\x1b[2K${frame} Working…\x1b[u`);
  }
  assert.equal(showsText(probe(model, { sinceTaints: mark }), "yes do it"), true);
});

test("a_cleared_line_is_shown_cleared_and_a_still_present_text_is_not", () => {
  const cleared = probe(screen(repaint({ input: 'Try "fix lint errors"' })));
  assert.equal(showsCleared(cleared, "yes do it"), true);
  assert.equal(showsCleared(probe(screen(repaint({ input: "yes do it" }))), "yes do it"), false);
  assert.equal(showsCleared({ kind: "unknown", reason: "no_box" }, "yes do it"), false);
  assert.equal(showsCleared({ kind: "blocked", reason: "dialog" }, "yes do it"), false);
});

test("a_background_reply_text_is_one_short_line_with_nothing_that_acts_as_a_key", () => {
  assert.equal(bgReplyText("yes do it"), "yes do it");
  assert.equal(bgReplyText("a\x1b[201~b\x03c"), "a[201~bc");
  assert.equal(bgReplyText("two\nlines"), undefined);
  assert.equal(bgReplyText("a\r\nb"), undefined);
  assert.equal(bgReplyText("x".repeat(601)), undefined);
  assert.equal(bgReplyText("x".repeat(600)), "x".repeat(600));
  assert.equal(bgReplyText("   "), undefined);
  assert.equal(bgReplyText(42), undefined);
});
