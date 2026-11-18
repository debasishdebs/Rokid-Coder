"use strict";
/**
 * The screen model and its probe: ONE job, to say positively that a pasted
 * text is on Claude's input line inside the framed prompt box. Everything
 * else is unknown, and unknown means "do not press Enter".
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { ScreenModel, probe, showsText, showsExactly, showsCleared, showsEmptyPrompt } = require("../dist/launcher/screen-probe.js");
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
  const model = screen(repaint({ input: '\x1b[2mTry "fix lint errors"\x1b[22m' }));
  const result = probe(model);
  assert.equal(result.kind, "prompt");
  assert.equal(showsText(result, "yes do it"), false);
});

test("a_box_is_visibly_empty_only_when_nothing_in_it_is_solid_text", () => {
  const empty = (input) => showsEmptyPrompt(probe(screen(repaint({ input }))));
  assert.equal(empty(""), true);
  assert.equal(empty("   "), true);
  // Claude's own hint in an empty box, drawn muted like any placeholder; typed text that looks like it is text.
  assert.equal(empty('\x1b[2mTry "fix lint errors"\x1b[22m'), true);
  assert.equal(empty('Try "do not overwrite this"'), false);
  assert.equal(empty('\x1b[0mTry "do not overwrite this"'), false);
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

test("a_style_the_model_cannot_read_is_never_muted_and_a_reset_is_honoured_wherever_it_stands", () => {
  const empty = (input) => showsEmptyPrompt(probe(screen(repaint({ input }))));
  // The exact sequence from the review: it resets faint and sets red, so what follows is text.
  assert.equal(empty("\x1b[2mhint\x1b[0;38:2::255:0:0mprivate draft"), false);
  assert.equal(empty("\x1b[2m\x1b[0;38:2::255:0:0mprivate draft"), false);
  // A reset is honoured wherever it stands in the sequence, and an empty parameter is a reset.
  assert.equal(empty("\x1b[2m\x1b[1;0mprivate draft"), false);
  assert.equal(empty("\x1b[2m\x1b[mprivate draft"), false);
  assert.equal(empty("\x1b[2m\x1b[;mprivate draft"), false);
  assert.equal(empty("\x1b[2m\x1b[0;2mrun the tests"), true, "reset first, then faint again");
  // Anything unrecognised in the sequence makes the style unknown, faint or not.
  for (const seq of ["\x1b[2;38:5:245m", "\x1b[2;12m", "\x1b[2;38;9m", "\x1b[2;38;5m", "\x1b[2;38;2;1;2m", "\x1b[2;abcm", "\x1b[2;999m"]) {
    assert.equal(empty(`${seq}private draft`), false, JSON.stringify(seq));
  }
  // The plain suggestions and harmless extra attributes still read as muted.
  assert.equal(empty("\x1b[2mrun the tests\x1b[22m"), true);
  assert.equal(empty("\x1b[2;3mrun the tests\x1b[0m"), true);
  assert.equal(empty("\x1b[2;48;5;17mrun the tests\x1b[0m"), true);
  assert.equal(empty("\x1b[1;90mrun the tests\x1b[0m"), true);
  assert.equal(empty("\x1b[38;5;245;4mrun the tests\x1b[0m"), true);
});

test("a_multi_line_draft_that_looks_like_the_hint_is_text", () => {
  const model = screen(
    `${["● Resumed.", RULE, '> Try "first line', '  second line"', RULE, FOOTER].join("\r\n")}`,
  );
  const result = probe(model);
  assert.equal(result.kind, "prompt");
  assert.equal(result.empty, false);
});

test("the_pasted_text_alone_on_the_input_line_inside_the_box_is_shown", () => {
  const model = screen(repaint({ input: "yes do it" }));
  const result = probe(model);
  assert.deepEqual(result, { kind: "prompt", text: "yes do it", rows: ["yes do it"], empty: false });
  assert.equal(showsText(result, "yes do it"), true);
  assert.equal(showsText(result, "yes do it please"), false);
  // Text that is not alone is not what was pasted: a laptop draft in front of it.
  assert.equal(showsText(probe(screen(repaint({ input: "draft yes do it" }))), "yes do it"), false);
});

test("altered_text_is_not_the_text_a_missing_or_extra_word_space_included", () => {
  const shows = (input, expected = "yes do it") => showsText(probe(screen(repaint({ input }))), expected);
  assert.equal(shows("yes do it"), true);
  // Runs of whitespace are one space, the ends are trimmed.
  assert.equal(shows("yes   do \t it  "), true);
  assert.equal(shows("yesdo it"), false, "a missing space");
  assert.equal(shows("yes doit"), false, "a missing space");
  assert.equal(shows("yesdoit"), false, "no spaces at all");
  assert.equal(shows("ye s do it"), false, "an extra space inside a word");
  assert.equal(shows("yes do it ok"), false);
  assert.equal(shows("yes do", "yes do it"), false);
  assert.equal(showsCleared(probe(screen(repaint({ input: "yesdo it" }))), "yes do it"), true);
  assert.equal(showsCleared(probe(screen(repaint({ input: "yes do it" }))), "yes do it"), false);
});

test("the_check_before_an_enter_is_exact_about_interior_whitespace", () => {
  const exact = (input, expected = "hello world") => showsExactly(probe(screen(repaint({ input }))), expected);
  assert.equal(exact("hello world"), true);
  assert.equal(exact("hello  world"), false, "two spaces are not one");
  assert.equal(exact("hello   world"), false);
  assert.equal(exact("hello world"), false, "a no-break space is not a space");
  assert.equal(exact("helloworld"), false);
  assert.equal(exact("hello world "), true, "the terminal's trailing blank cells are padding");
  assert.equal(exact("hello world", "hello world   "), true, "so is trailing whitespace of what was pasted");
  assert.equal(exact("hello world!"), false);
  assert.equal(exact("hello"), false);
  assert.equal(exact(" hello world", " hello world"), true, "a leading space of the paste is on the line");
  assert.equal(exact("hello world", " hello world"), false);
  // The loose comparison still reads these as the text; it is not the one an Enter relies on.
  assert.equal(showsText(probe(screen(repaint({ input: "hello  world" }))), "hello world"), true);
  assert.equal(showsExactly({ kind: "blocked", reason: "dialog" }, "hello world"), false);
  assert.equal(showsExactly(probe(screen(repaint({ input: "" }))), ""), false);
});

test("a_continuation_row_loses_only_the_uis_indent_and_any_more_leading_space_is_text", () => {
  const rows = (first, second) => probe(screen(`${["● Done.", RULE, `> ${first}`, second, RULE, FOOTER].join("\r\n")}`));
  // The UI indents a wrapped row by the width of `> `.
  assert.equal(showsExactly(rows("hello", "  world"), "hello world"), true);
  assert.equal(showsExactly(rows("hello", "world"), "hello world"), true, "an unindented row is the same");
  // More than that is the text's own: five spaces are two of indent and three of text.
  assert.equal(showsExactly(rows("hello", "     world"), "hello world"), false);
  assert.equal(showsExactly(rows("hello", "     world"), "hello    world"), true, "one the wrap took, three of text");
  assert.equal(showsExactly(rows("hello", "     world"), "hello   world"), false);
  // With the borders of a bordered box the indent is measured the same way.
  const top = `╭${"─".repeat(58)}╮`;
  const bottom = `╰${"─".repeat(58)}╯`;
  const bordered = (second) => probe(screen(["x", top, "│ > hello".padEnd(59) + "│", `│${second}`.padEnd(59) + "│", bottom, FOOTER].join("\r\n")));
  assert.equal(showsExactly(bordered("   world"), "hello world"), true);
  assert.equal(showsExactly(bordered("      world"), "hello world"), false);
});

test("only_a_whole_screen_erase_heals_a_taint_not_the_scrollback_erase_or_a_partial_one", () => {
  // The exact sequence: the alternate screen holds a draft, an unsupported edit taints, the scrollback is erased
  // (which leaves the visible screen alone), and the frame and the `> ` prefix are redrawn without erasing the row.
  const model = screen("");
  model.push("\x1b[?1049h\x1b[2J\x1b[H");
  model.push(["● Resumed.", RULE, "> laptop draft", RULE, FOOTER].join("\r\n"));
  assert.equal(model.tainted, false);
  model.push("\x1b[1@");
  assert.equal(model.tainted, true);
  model.push("\x1b[3J");
  assert.equal(model.tainted, true, "CSI 3 J erases only the saved scrollback");
  model.push("\x1b[2;1H" + RULE + "\x1b[3;1H> ");
  assert.equal(model.lines()[2].includes("laptop draft"), true, "the draft is still on the visible screen");
  const result = probe(model);
  assert.deepEqual([result.kind, result.reason], ["unknown", "screen_disturbed"]);
  assert.equal(showsEmptyPrompt(result), false);
  for (const partial of ["\x1b[J", "\x1b[1J", "\x1b[2K", "\x1b[K"]) {
    model.push(partial);
    assert.equal(model.tainted, true, JSON.stringify(partial));
  }
  // A whole-screen erase and a redraw is what heals it, and then the draft is gone from the screen too.
  model.push(repaint({ input: "" }));
  assert.equal(model.tainted, false);
  assert.equal(showsEmptyPrompt(probe(model)), true);
});

test("a_wrapped_line_is_exact_inside_each_row_and_lets_the_break_take_one_space", () => {
  const text = "please run the full test suite and then summarise every failure you find in the logs";
  const wrapped = (first, second) => probe(screen(repaint({ input: first, continuation: [`  ${second}`] })));
  assert.equal(showsExactly(wrapped(text.slice(0, 40), text.slice(40)), text), true, "the break took the space");
  assert.equal(showsExactly(wrapped(text.slice(0, 39), text.slice(40)), text), true, "the space is still at the end of a row");
  assert.equal(showsExactly(wrapped(text.slice(0, 41), text.slice(41)), text), true, "mid-word break, no space lost");
  assert.equal(showsExactly(wrapped(text.slice(0, 40), `x${text.slice(40)}`), text), false);
  assert.equal(showsExactly(wrapped(text.slice(0, 40).replace("the full", "the  full"), text.slice(40)), text), false);
});

test("a_tainted_screen_is_refused_without_a_baseline_and_a_whole_screen_erase_heals_it", () => {
  for (const seq of ["\x1b[1;20r", "\x1b#8", "\x1b#3", "\x1bc", "\x1b(0", "\x1b[?1049h\x1b[?1049l", "\x1b[?47h\x1b[?47l", "\x1b[?1047h\x1b[?1047l"]) {
    const model = screen(repaint({ input: "yes do it" }));
    assert.equal(model.tainted, false, "clean to start with");
    model.push(seq);
    assert.equal(model.tainted, true, JSON.stringify(seq));
    // Redrawn in place with nothing erased, the stale grid would still read as the prompt.
    model.push(`\x1b[H${["x", "", "", RULE, "> yes do it", RULE, FOOTER].map((row) => `${row}\x1b[K`).join("\r\n")}`);
    assert.deepEqual(probe(model), { kind: "unknown", reason: "screen_disturbed" }, JSON.stringify(seq));
    // Erased and redrawn whole, every cell is the child's again.
    model.push(repaint({ input: "yes do it" }));
    assert.equal(model.tainted, false, JSON.stringify(seq));
    assert.equal(showsText(probe(model), "yes do it"), true, JSON.stringify(seq));
  }
  const resized = screen(repaint());
  resized.resize(100, 30);
  assert.equal(resized.tainted, true);
  assert.equal(probe(resized).kind, "unknown");
  // The alternate screen is a buffer of its own that Claude erases on entry, so that erase heals the switch;
  // what comes back when it is left is the main screen as it was, trusted again only after an erase of its own.
  const alt = screen(repaint());
  alt.push("\x1b[?1049h");
  assert.equal(alt.tainted, true);
  alt.push("\x1b[2J");
  assert.equal(alt.tainted, false);
  alt.push("\x1b[?1049l");
  assert.equal(alt.tainted, true);
});

test("device_status_and_attribute_requests_draw_nothing_and_taint_nothing", () => {
  const model = screen(repaint({ input: "ok" }));
  model.push("\x1b[6n\x1b[c\x1b[>0q\x1b[?u");
  assert.equal(model.tainted, false);
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
  const cleared = probe(screen(repaint({ input: '\x1b[2mTry "fix lint errors"\x1b[22m' })));
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
