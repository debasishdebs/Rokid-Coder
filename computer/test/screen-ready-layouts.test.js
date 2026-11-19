"use strict";
/**
 * The layouts of Claude Code 2.1.285 seen on the user's machine (idle with a background monitor, mid-turn with
 * the spinner and `esc to interrupt`, a plan footer, a dialog, a real captured turn): the probe finds the box
 * and reads it empty whatever the status lines, footer words, right-aligned line, label and cursor shape,
 * and agentd calls a text reply ready in auto and bypassPermissions modes whatever Claude's file says.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { ScreenModel, probe, boxState, showsDialog, showsPlanMode } = require("../dist/launcher/screen-probe.js");
const { layout } = require("./helpers/claude-layouts.js");
const { claudeScreen } = require("./helpers/claude-screen.js");
const real = require("./helpers/claude-real-turn.js");
const { KEY, setup } = require("./helpers/screen-ready-harness.js");

const SIZES = [
  [207, 50],
  [80, 24],
];

function draw(options) {
  const screen = new ScreenModel(options.cols, options.rows);
  screen.push(layout(options));
  return screen;
}

function* variants() {
  for (const [cols, rows] of SIZES) {
    for (const phase of ["idle", "working", "none"]) {
      for (const verb of ["Baked", "Churned"]) {
        for (const right of ["update", "clipboard", "goal", "none"]) {
          for (const label of ["", " Rokid app for Claude code integration"]) {
            for (const cursor of ["blank", "none", "suggestion"]) {
              for (const agents of [0, 3]) {
                const monitor = (verb.length + agents) % 2 === 0;
                yield { cols, rows, phase, verb, right, label, cursor, agents, monitor };
              }
            }
          }
        }
      }
    }
  }
}

test("every_layout_variant_has_its_box_found_and_empty_with_nothing_read_as_a_dialog_or_plan_footer", () => {
  let count = 0;
  for (const options of variants()) {
    const what = JSON.stringify(options);
    const screen = draw(options);
    assert.equal(screen.tainted, false, what);
    // The ordinary probe refuses a running turn's marker; the queued one reads the box through it.
    const plain = probe(screen);
    if (options.phase === "working") {
      assert.deepEqual([plain.kind, plain.reason], ["blocked", "busy_indicator"], what);
    } else {
      assert.deepEqual([plain.kind, plain.empty], ["prompt", true], what);
    }
    const queued = probe(screen, { queued: true });
    assert.deepEqual([queued.kind, queued.empty], ["prompt", true], what);
    assert.equal(boxState(screen), "empty", what);
    assert.equal(showsDialog(screen), false, what);
    assert.equal(showsPlanMode(screen), false, what);
    count += 1;
  }
  assert.equal(count, 2 * 3 * 2 * 4 * 2 * 3 * 2);
});

test("every_layout_variant_is_ready_in_auto_and_bypass_modes_whatever_the_file_says_and_not_so_elsewhere", () => {
  for (const options of variants()) {
    const box = boxState(draw(options));
    for (const status of ["idle", "busy", "shell"]) {
      for (const mode of ["auto", "bypassPermissions"]) {
        const t = setup({ mode, status, report: box });
        assert.equal(t.router.followupState(KEY), "ready", `${mode} ${status} ${JSON.stringify(options)}`);
        assert.equal(t.router.followupWhy(KEY), undefined);
      }
    }
  }
  // Other modes keep the file's own rule: ready on idle, never on busy or shell.
  const options = { cols: 207, rows: 50, phase: "working", verb: "Baked", right: "update", label: "", cursor: "blank", agents: 0, monitor: true };
  const box = boxState(draw(options));
  for (const mode of ["default", "acceptEdits", "dontAsk", "plan"]) {
    assert.equal(setup({ mode, status: "idle", report: box }).router.followupState(KEY), "ready", `${mode} idle`);
    for (const status of ["busy", "shell"]) {
      const t = setup({ mode, status, report: box });
      assert.equal(t.router.followupState(KEY), "unavailable", `${mode} ${status}`);
      assert.equal(t.router.followupWhy(KEY), "busy", `${mode} ${status}`);
    }
  }
});

/** The owner's normal state: an idle main thread, background agents and monitors, the agents panel under the footer. */
function* panelVariants() {
  for (const [cols, rows] of SIZES) {
    for (const agents of [0, 1, 3, 8]) {
      const selections = agents === 0 ? [-1] : [-1, 0, agents - 1, "main"];
      for (const selected of selections) {
        for (const phase of ["waiting", "idle", "working"]) {
          for (const cursor of ["blank", "none", "suggestion"]) {
            yield { cols, rows, phase, agents, selected, cursor, monitors: 2, right: "updateGoalSeconds", label: agents % 2 ? "" : " Rokid app" };
          }
        }
      }
    }
  }
}

test("the_agents_panel_in_every_shape_is_never_the_prompt_a_draft_or_a_menu_and_the_box_is_ready", () => {
  let count = 0;
  for (const options of panelVariants()) {
    const what = JSON.stringify(options);
    const screen = draw(options);
    assert.equal(screen.tainted, false, what);
    const queued = probe(screen, { queued: true });
    assert.deepEqual([queued.kind, queued.empty], ["prompt", true], what);
    assert.equal(queued.text === "" || queued.text === "continue", true, `${what}: only the muted suggestion is on the line`);
    assert.equal(boxState(screen), "empty", what);
    assert.equal(showsDialog(screen), false, what);
    for (const status of ["idle", "busy", "shell"]) {
      assert.equal(setup({ mode: "auto", status, report: boxState(screen) }).router.followupState(KEY), "ready", `${status} ${what}`);
    }
    count += 1;
  }
  assert.equal(count, 2 * (1 + 3 * 4) * 3 * 3);
});

test("a_transcript_with_a_coloured_diff_and_dashes_never_hides_or_stands_in_for_the_box", () => {
  let count = 0;
  for (const [cols, rows] of SIZES) {
    for (const agents of [0, 1]) {
      for (const phase of ["none", "idle", "waiting"]) {
        for (const [right, diffHeaderAbove] of [["update", false], ["none", true], ["none", false], ["clipboard", false]]) {
          for (const cursor of ["blank", "none"]) {
            const options = {
              cols, rows, agents, phase, right, diffHeaderAbove, cursor,
              transcript: "diff", monitors: 2, selected: -1, titles: ["Writing NexusRealHubTest.kt"],
            };
            const what = JSON.stringify(options);
            const screen = draw(options);
            assert.equal(screen.tainted, false, what);
            const seen = probe(screen, { queued: true });
            assert.deepEqual([seen.kind, seen.empty, seen.text], ["prompt", true, ""], what);
            assert.equal(boxState(screen), "empty", what);
            for (const status of ["idle", "busy", "shell"]) {
              assert.equal(setup({ mode: "auto", status, report: boxState(screen) }).router.followupState(KEY), "ready", `${status} ${what}`);
            }
            count += 1;
          }
        }
      }
    }
  }
  assert.equal(count, 2 * 2 * 3 * 4 * 2);
  // The diff's own rows are text: none is muted but the dim ones, and a coloured background alone mutes nothing.
  const screen = draw({ cols: 207, rows: 50, transcript: "diff", phase: "idle", monitor: false });
  const rows = screen.lines();
  const solid = screen.solidLines();
  const removed = rows.findIndex((row) => /^ 56 −/.test(row));
  assert.equal(removed >= 0 && solid[removed].trim() !== "", true, "the removed line on its red background is text");
  const dim = rows.findIndex((row) => /Allowed by auto mode classifier/.test(row));
  assert.equal(solid[dim].trim(), "", "the dim row is muted");
});

test("agent_titles_and_token_counts_that_look_like_rules_or_prompts_change_nothing_but_a_dialog_still_refuses", () => {
  // Panel rows start with `●`, `○` or `❯ ○`, so a title (or the counts) shaped like a rule, a prompt or a list is text.
  for (const title of ["─".repeat(30), "──── label ────", "> not a prompt", "❯ nor this", "1. Yes please", "2) not a list","│ boxed │"]) {
    const screen = new ScreenModel(207, 50);
    screen.push(layout({ cols: 207, rows: 50, phase: "waiting", agents: 3, selected: 1, titles: [title], monitors: 2, right: "updateGoalSeconds" }));
    const seen = probe(screen, { queued: true });
    assert.deepEqual([seen.kind, seen.empty], ["prompt", true], title);
    assert.equal(boxState(screen), "empty", title);
  }
  // A real dialog drawn anywhere still refuses: in place of the box, or with its words on a panel row.
  const dialog = new ScreenModel(207, 50);
  dialog.push(claudeScreen({ cols: 207, rows: 50, agents: 3, selected: 0, dialog: true }));
  assert.equal(boxState(dialog), "dialog");
  const inPanel = new ScreenModel(207, 50);
  inPanel.push(layout({ cols: 207, rows: 50, phase: "waiting", agents: 3, titles: ["Do you want to proceed?"] }));
  assert.equal(boxState(inPanel), "dialog");
  const above = new ScreenModel(207, 50);
  above.push(layout({ cols: 207, rows: 50, phase: "waiting", agents: 3 }) + "\x1b[40;1H  Esc to cancel · Tab to amend");
  assert.equal(boxState(above), "dialog");
});

test("a_plan_footer_a_dialog_and_text_in_the_box_are_not_ready_in_any_layout", () => {
  for (const [cols, rows] of SIZES) {
    const plan = new ScreenModel(cols, rows);
    plan.push(layout({ cols, rows, footer: "plan", phase: "working" }));
    assert.equal(showsPlanMode(plan), true);
    assert.equal(boxState(plan), "plan");
    const dialog = new ScreenModel(cols, rows);
    dialog.push(claudeScreen({ cols, rows, agents: 2, dialog: true }));
    assert.equal(boxState(dialog), "dialog");
    const typed = new ScreenModel(cols, rows);
    typed.push(claudeScreen({ cols, rows, agents: 2, input: "half typed" }));
    assert.equal(boxState(typed), "text");
    for (const status of ["idle", "busy", "shell"]) {
      assert.equal(setup({ mode: "auto", status, report: boxState(dialog) }).router.followupWhy(KEY), "dialog");
      assert.equal(setup({ mode: "auto", status: "busy", report: boxState(plan) }).router.followupWhy(KEY), "mode_not_allowed");
    }
    assert.equal(setup({ mode: "auto", status: "busy", report: boxState(typed) }).router.followupWhy(KEY), "draft");
  }
});

test("the_real_captured_turn_reads_idle_typed_working_replied_and_done_as_the_screenshots_say", () => {
  const screen = new ScreenModel(real.COLS, real.ROWS);
  const seen = {};
  real.CHUNKS.forEach((chunk, index) => {
    screen.push(chunk);
    for (const [name, at] of Object.entries(real.AFTER)) {
      if (at === index) {
        seen[name] = { box: boxState(screen), plain: probe(screen), queued: probe(screen, { queued: true }), tainted: screen.tainted, rows: screen.lines() };
      }
    }
  });
  assert.deepEqual(Object.values(seen).map((s) => s.tainted), [false, false, false, false, false]);
  assert.equal(seen.idle.box, "empty");
  assert.equal(seen.idle.plain.empty, true, "the muted suggestion is empty");
  assert.equal(seen.typed.box, "text", "the prompt typed into the box");
  // Mid-turn: the ordinary probe refuses on `esc to interrupt`; the box is empty and a reply would queue.
  for (const name of ["working", "replied"]) {
    assert.deepEqual([seen[name].plain.kind, seen[name].plain.reason], ["blocked", "busy_indicator"], name);
    assert.deepEqual([seen[name].queued.kind, seen[name].queued.empty], ["prompt", true], name);
    assert.equal(seen[name].box, "empty", name);
    assert.equal(seen[name].rows.some((row) => /esc to interrupt/.test(row)), true, name);
  }
  assert.equal(seen.working.rows.some((row) => /Pouncing/.test(row)), true, "the spinner row");
  assert.equal(seen.done.box, "empty");
  assert.equal(seen.done.plain.empty, true);
  assert.equal(seen.done.rows.some((row) => /for 1s · done/.test(row)), true, "the turn summary line");
  assert.equal(seen.done.rows.some((row) => /esc to interrupt/.test(row)), false);
  for (const status of ["idle", "busy", "shell"]) {
    assert.equal(setup({ mode: "auto", status, report: seen.working.box }).router.followupState(KEY), "ready", status);
  }
});
