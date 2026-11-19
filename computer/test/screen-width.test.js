"use strict";
/**
 * A glyph whose width a terminal does not settle alone (`▶`, `✳`, `⏺`, an emoji) matters where columns matter:
 * in the box's own rows. Anywhere else (the footer, the agents panel, a status line, the transcript) it never
 * makes the box unreadable, and a cell written over or erased is certain again, so a glyph that once stood where
 * the box now is leaves nothing behind. Found on the owner's machine: every verdict said `uncertain_width`
 * because Claude redraws only what changed, and the box moved over rows that had held a `▶▶` footer.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { ScreenModel, probe, boxState, describeVerdict, showsDialog } = require("../dist/launcher/screen-probe.js");
const { layout } = require("./helpers/claude-layouts.js");
const real = require("./helpers/claude-real-turn.js");
const { KEY, setup } = require("./helpers/screen-ready-harness.js");

/** Every glyph of the owner's screens, and the ones whose width is ambiguous. */
const GLYPHS = ["←", "↓", "·", "●", "○", "⊙", "◎", "▶", "⏵", "✱", "✻", "✽", "❯", "└", "⎿", "▎", "⏺", "✳", "⏸", "⚠", "◐"];
const AMBIGUOUS = ["▶", "✳", "⏺", "⏸", "⚠"];

const readyFor = (screen) => ["idle", "busy", "shell"].every((status) => setup({ mode: "auto", status, report: boxState(screen) }).router.followupState(KEY) === "ready");

test("the_probe_reproduces_the_field_bug_when_a_footer_glyph_is_left_on_a_row_the_box_later_covers", () => {
  // The panel shrinks: the box moves down over the row that held the `▶▶` footer. Claude erases to the end of a
  // line and writes over it; nothing erases the whole row.
  for (const glyphs of ["screenshot", "bytes", "ambiguous"]) {
    const screen = new ScreenModel(207, 50);
    screen.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 3, monitors: 2, right: "updateGoalSeconds", glyphs }));
    screen.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 1, monitors: 2, right: "updateGoalSeconds", glyphs, entry: "diff" }));
    const seen = probe(screen, { queued: true });
    assert.deepEqual([seen.kind, seen.empty], ["prompt", true], glyphs);
    assert.equal(boxState(screen), "empty", glyphs);
    assert.equal(readyFor(screen), true, glyphs);
  }
});

test("a_box_is_read_after_any_redraw_from_any_layout_to_any_other_with_the_real_glyphs", () => {
  const shapes = [];
  for (const agents of [0, 1, 3, 8]) {
    for (const phase of ["idle", "working", "waiting"]) {
      shapes.push({ agents, phase });
    }
  }
  let count = 0;
  for (const glyphs of ["screenshot", "bytes", "ambiguous"]) {
    for (const from of shapes) {
      for (const to of shapes) {
        const common = { cols: 207, rows: 50, monitors: 2, right: "updateGoalSeconds", glyphs, cursor: "blank" };
        const screen = new ScreenModel(207, 50);
        screen.push(layout({ ...common, ...from }));
        screen.push(layout({ ...common, ...to, entry: "diff" }));
        const what = `${glyphs} ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;
        assert.equal(screen.tainted, false, what);
        const seen = probe(screen, { queued: true });
        assert.deepEqual([seen.kind, seen.empty], ["prompt", true], what);
        assert.equal(readyFor(screen), true, what);
        count += 1;
      }
    }
  }
  assert.equal(count, 3 * 12 * 12);
});

/** The twelve layouts of the matrix above. */
function twelveShapes() {
  const shapes = [];
  for (const agents of [0, 1, 3, 8]) {
    for (const phase of ["idle", "working", "waiting"]) {
      shapes.push({ agents, phase });
    }
  }
  return shapes;
}

test("a_box_is_read_after_a_redraw_that_erases_only_the_tail_of_a_row_or_overwrites_or_clears_characters", () => {
  // `entry: "diff"` blanks every row from its first cell, which clears the width marks whatever they are. These
  // redraws do not: the old rows keep a glyph far to the right (past where the prompt row is written), and only an
  // erase to the end of the line (`K`), an erase of characters (`X`) or writing over those cells makes them certain.
  const readiness = new Map();
  const ready = (screen) => {
    const box = boxState(screen);
    if (!readiness.has(box)) readiness.set(box, readyFor(screen));
    return readiness.get(box);
  };
  let count = 0;
  for (const redraw of ["k", "x", "overwrite"]) {
    for (const glyphs of ["screenshot", "bytes", "ambiguous"]) {
      for (const from of twelveShapes()) {
        for (const to of twelveShapes()) {
          const common = { cols: 207, rows: 50, monitors: 2, right: "updateGoalSeconds", glyphs, cursor: "blank" };
          const screen = new ScreenModel(207, 50);
          screen.push(layout({ ...common, ...from, trailing: "▶" }));
          screen.push(layout({ ...common, ...to, redraw }));
          const what = `${redraw} ${glyphs} ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;
          assert.equal(screen.tainted, false, what);
          const seen = probe(screen, { queued: true });
          assert.deepEqual([seen.kind, seen.empty], ["prompt", true], what);
          assert.equal(ready(screen), true, what);
          count += 1;
        }
      }
    }
  }
  assert.equal(count, 3 * 3 * 12 * 12);
});

test("the_marks_move_with_their_row_when_a_line_is_inserted_or_deleted", () => {
  const screen = new ScreenModel(80, 5);
  screen.push("\x1b[2;5H▶ x");
  assert.deepEqual([...Array(5).keys()].filter((i) => screen.rowDubious(i)), [1]);
  screen.push("\x1b[1;1H\x1b[L");
  assert.deepEqual([...Array(5).keys()].filter((i) => screen.rowDubious(i)), [2], "an inserted line pushes the row down");
  screen.push("\x1b[1;1H\x1b[2L");
  assert.deepEqual([...Array(5).keys()].filter((i) => screen.rowDubious(i)), [4], "two of them");
  screen.push("\x1b[1;1H\x1b[L");
  assert.deepEqual([...Array(5).keys()].filter((i) => screen.rowDubious(i)), [], "pushed off the screen, it is gone");
  const deleted = new ScreenModel(80, 5);
  deleted.push("\x1b[4;5H▶ x");
  deleted.push("\x1b[1;1H\x1b[M");
  assert.deepEqual([...Array(5).keys()].filter((i) => deleted.rowDubious(i)), [2], "a deleted line above pulls the row up");
  deleted.push("\x1b[3;1H\x1b[M");
  assert.deepEqual([...Array(5).keys()].filter((i) => deleted.rowDubious(i)), [], "deleted itself, it is gone");
  // The marked cell keeps its column and codepoint as the row moves.
  const moved = new ScreenModel(80, 5);
  moved.push("\x1b[2;7H✳");
  moved.push("\x1b[1;1H\x1b[L");
  assert.deepEqual(moved.dubiousCell(2), { col: 6, codepoint: 0x2733 });
});

test("an_ambiguous_glyph_on_any_row_outside_the_box_never_makes_it_unreadable", () => {
  // Written onto the footer, a panel row, the status line, the right-aligned line, the transcript and the rows between.
  for (const glyph of GLYPHS) {
    for (const [cols, rows, agents] of [[207, 50, 3], [80, 24, 1], [207, 50, 0]]) {
      const base = layout({ cols, rows, phase: "idle", agents, monitors: 2, right: "updateGoalSeconds" });
      const probeRows = [...Array.from({ length: 14 }, (_, i) => i), rows - 1 - (agents > 0 ? 2 + agents : 0), rows - 1];
      for (const row of probeRows) {
        const screen = new ScreenModel(cols, rows);
        screen.push(base);
        const target = screen.lines().findIndex((_, i) => i === row);
        // Over a box row it would (rightly) be read; only rows outside the box are tried.
        const lines = screen.lines();
        const isBoxRow = lines[row]?.startsWith("─") || lines[row]?.startsWith("❯ ");
        if (target < 0 || isBoxRow) continue;
        screen.push(`\x1b[${row + 1};60H${glyph} ${glyph}`);
        const seen = probe(screen, { queued: true });
        assert.deepEqual([seen.kind, seen.empty], ["prompt", true], `${glyph} U+${glyph.codePointAt(0).toString(16)} on row ${row} at ${cols}x${rows}`);
      }
    }
  }
});

test("an_ambiguous_glyph_inside_the_box_stays_unreadable_and_the_log_names_its_row_and_codepoint_only", () => {
  for (const glyph of AMBIGUOUS) {
    const hex = glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    // In a draft (the input row) and in the label of the top rule.
    const draft = new ScreenModel(207, 50);
    draft.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 0 }));
    const promptRow = draft.lines().findIndex((row) => row.startsWith("❯"));
    draft.push(`\x1b[${promptRow + 1};3Hdraft ${glyph} text`);
    const inDraft = probe(draft, { queued: true });
    assert.deepEqual([inDraft.kind, inDraft.reason, inDraft.uw], ["unknown", "uncertain_width", `${promptRow}:U+${hex}`], glyph);
    const label = new ScreenModel(207, 50);
    label.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 0, label: ` Rokid ${glyph} app` }));
    const inLabel = probe(label, { queued: true });
    assert.deepEqual([inLabel.kind, inLabel.reason], ["unknown", "uncertain_width"], glyph);
    assert.match(inLabel.uw, new RegExp(`^\\d+:U\\+${hex}$`));
    // The verdict says which row and codepoint and carries nothing of the text.
    const verdict = describeVerdict(draft);
    assert.equal(verdict.uw, `${promptRow}:U+${hex}`);
    assert.equal(JSON.stringify(verdict).includes("draft"), false);
    assert.equal(boxState(draft), "unreadable");
  }
  // Emoji and joiners in a draft, as before.
  for (const text of ["go 👍", "family 👨‍👩‍👧", "heart ❤️", "flag 🇮🇳"]) {
    const screen = new ScreenModel(207, 50);
    screen.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 0 }));
    const promptRow = screen.lines().findIndex((row) => row.startsWith("❯"));
    screen.push(`\x1b[${promptRow + 1};3H${text}`);
    assert.equal(probe(screen, { queued: true }).reason, "uncertain_width", text);
  }
});

test("a_cell_written_over_or_erased_is_certain_again_and_a_half_written_wide_character_is_not", () => {
  const dubiousRow = (screen) => screen.rowDubious(0);
  const fresh = () => {
    const screen = new ScreenModel(80, 5);
    screen.push("\x1b[1;5H▶ ab");
    assert.equal(dubiousRow(screen), true);
    return screen;
  };
  const written = fresh();
  written.push("\x1b[1;5Hx");
  assert.equal(dubiousRow(written), false, "written over");
  const toEnd = fresh();
  toEnd.push("\x1b[1;5H\x1b[K");
  assert.equal(dubiousRow(toEnd), false, "erased to the end of the line");
  const toStart = fresh();
  toStart.push("\x1b[1;9H\x1b[1K");
  assert.equal(dubiousRow(toStart), false, "erased from the start of the line");
  const chars = fresh();
  chars.push("\x1b[1;5H\x1b[3X");
  assert.equal(dubiousRow(chars), false, "erased characters");
  const below = fresh();
  below.push("\x1b[1;1H\x1b[J");
  assert.equal(dubiousRow(below), false, "erased to the end of the screen");
  // A write elsewhere on the row, or an erase that stops short of it, leaves it unsure.
  const after = fresh();
  after.push("\x1b[1;40Hx\x1b[1;20H\x1b[K");
  assert.equal(dubiousRow(after), true, "an erase from a column past it");
  const apart = fresh();
  apart.push("\x1b[1;40Hx");
  assert.equal(dubiousRow(apart), true, "a write elsewhere");
  const short = fresh();
  short.push("\x1b[1;1H\x1b[3X");
  assert.equal(dubiousRow(short), true, "an erase before it");
  // The marks move with their row when the screen scrolls.
  const scrolled = new ScreenModel(80, 3);
  scrolled.push("\x1b[2;1H▶\x1b[3;1H\n");
  assert.equal(scrolled.rowDubious(1), false);
  assert.equal(scrolled.rowDubious(0), true, "the row went up with its glyph");
  // Half of a wide character written over stays unsure until something is written there.
  const wide = new ScreenModel(80, 3);
  wide.push("\x1b[1;1H好\x1b[1;1Hx");
  assert.equal(wide.rowDubious(0), true);
  // What is logged is the wide glyph now half gone, never the character that wrote over it (a letter of a draft).
  assert.deepEqual(wide.dubiousCell(0), { col: 1, codepoint: 0x597d });
  const rightHalf = new ScreenModel(80, 3);
  rightHalf.push("\x1b[1;1H好\x1b[1;2Hq");
  assert.deepEqual(rightHalf.dubiousCell(0), { col: 0, codepoint: 0x597d });
  // And so the verdict line of a draft with a half-overwritten wide glyph names that glyph, not the letter written over it.
  const draft = new ScreenModel(207, 50);
  draft.push(layout({ cols: 207, rows: 50, phase: "idle", agents: 0 }));
  const promptRow = draft.lines().findIndex((row) => row.startsWith("❯"));
  draft.push(`\x1b[${promptRow + 1};3H好\x1b[${promptRow + 1};3Hq`);
  const named = describeVerdict(draft);
  assert.equal(named.reason, "uncertain_width");
  assert.equal(named.uw, `${promptRow}:U+597D`);
  assert.equal(JSON.stringify(named).includes("0071"), false, "the letter written over it is not in the line");
  wide.push("\x1b[1;2Hy");
  assert.equal(wide.rowDubious(0), false);
  // The whole-line erase and the whole-screen erase clear everything.
  const line = fresh();
  line.push("\x1b[1;1H\x1b[2K");
  assert.equal(dubiousRow(line), false);
  const all = fresh();
  all.push("\x1b[2J");
  assert.equal(dubiousRow(all), false);
});

test("words_a_dialog_also_holds_in_a_title_a_message_or_a_footer_hint_are_no_dialog_and_its_chrome_is", () => {
  const rows = (options, extra = "") => {
    const screen = new ScreenModel(207, 50);
    screen.push(layout({ cols: 207, rows: 50, phase: "waiting", monitors: 2, right: "clipboard", ...options }) + extra);
    return screen;
  };
  // Real panel and footer text, and a numbered list in the last message right above the box.
  for (const [what, screen] of [
    ["agent titles", rows({ agents: 3, titles: ["Writing NexusRealHubTest.kt", "Audit the tests: do you want to keep them?", "Press enter on the diff"] })],
    ["the footer and panel as they are", rows({ agents: 3 })],
    ["a numbered list above the box", rows({ agents: 1 }, "\x1b[40;1H  1. First fix the probe\x1b[41;1H  2. Then the router\x1b[42;1H  3) And the log")],
    ["an indented list and `ctrl+v to paste`", rows({ agents: 0, right: "clipboard" }, "\x1b[41;3H1. one\x1b[42;3H2. two")],
    ["waiting for input in a title", rows({ agents: 2, titles: ["Waiting for your input on the schema"] })],
  ]) {
    assert.equal(boxState(screen), "empty", what);
    assert.equal(showsDialog(screen), false, what);
    assert.equal(readyFor(screen), true, what);
  }
  // A real dialog: its chrome, or a selected menu row, anywhere around the box or in it.
  for (const [what, extra] of [
    ["chrome above", "\x1b[40;1H  Esc to cancel · Tab to amend"],
    ["a selected menu row above", "\x1b[40;1H❯ 1. Yes\x1b[41;1H  2. No"],
    ["enter to confirm", "\x1b[40;1H  Enter to confirm · Esc to cancel"],
  ]) {
    const seen = rows({ agents: 1 }, extra);
    assert.equal(boxState(seen), "dialog", what);
    const look = probe(seen, { queued: true });
    assert.deepEqual([look.kind, look.reason], ["blocked", "dialog"], what);
    assert.match(look.at, /^\d+:(chrome|menu)$/, what);
    assert.equal(describeVerdict(seen).dlg, look.at, what);
  }
});

test("the_real_capture_replayed_row_by_row_into_a_screen_with_stale_glyphs_still_reads_empty", () => {
  // The capture's own glyphs (`⏺`, `✳`, `⏵⏵`) were all drawn somewhere on this screen before it was redrawn smaller.
  const screen = new ScreenModel(real.COLS, real.ROWS);
  real.CHUNKS.forEach((chunk) => screen.push(chunk));
  let marked = 0;
  for (let i = 0; i < real.ROWS; i += 1) {
    if (screen.rowDubious(i)) marked += 1;
  }
  assert.equal(marked >= 1, true, "the capture has rows with cells whose width a terminal does not settle alone");
  // The agents panel appears: the box moves up three rows, over rows that held other things.
  screen.push(layout({ cols: 207, rows: 50, phase: "waiting", agents: 3, monitors: 2, right: "updateGoalSeconds", glyphs: "bytes", entry: "diff" }));
  const seen = probe(screen, { queued: true });
  assert.deepEqual([seen.kind, seen.empty], ["prompt", true]);
});
