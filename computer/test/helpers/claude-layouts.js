"use strict";
/**
 * Synthetic screens in the layouts seen on the user's machine (three screenshots of Claude Code 2.1.285, 207x50,
 * and the real capture in claude-real-turn.js), with every piece that varies from one moment to the next made
 * an option, so a test can run over the product of them:
 *
 * - `phase: "idle"`: the turn is over. Above the box a muted `✻ <Verb> for <duration> · done <time>` line,
 *   with `· N monitor still running` while a background task lives; `phase: "working"`: the in-turn
 *   spinner `✱ <Verb>… (<duration> · ↓ <tokens> tokens)` and an indented muted tip line, and `esc to interrupt`
 *   in the footer; `phase: "none"`: neither line.
 * - `right`: the right-aligned line just above the top rule: an update notice, `Image in clipboard · ctrl+v
 *   to paste · ⊙ /goal active (10m)`, or only `/goal active`.
 * - `label`: text in the top rule, or none.
 * - `cursor`: `blank` (only the block cursor, an inverse blank cell), `none` (nothing, as the real capture's
 *   cursor is the terminal's own) or `suggestion` (a muted suggestion, the cursor on its first letter).
 * - `agents`: rows of an agents panel under the footer, or none; `monitor`: `1 monitor` in the footer.
 * - `footer`: `auto` (the glyph is `▶▶` here, `⏵⏵` in the real bytes), `plan`.
 * Nothing is drawn in the top-right corner of the window: a tab tooltip there is no terminal content.
 */
const RULE_SGR = "\x1b[38;5;244m";
const MUTED = "\x1b[2m";
const GRAY = "\x1b[38;5;246m";
const RESET = "\x1b[0m";

const at = (row, col, text) => `\x1b[${row + 1};${col}H${text}`;
const rule = (cols, label) => {
  if (!label) return `${RULE_SGR}${"─".repeat(cols)}${RESET}`;
  return `${RULE_SGR}${"─".repeat(cols - label.length - 3)}${RESET} ${label} ${RULE_SGR}─${RESET}`;
};

const RIGHT_LINES = {
  update: "Update available! Run: brew upgrade claude-code◎ /goal active (7m)",
  updateGoalSeconds: "Update available! Run: brew upgrade claude-code⊙ /goal active (59s)",
  clipboard: "Image in clipboard · ctrl+v to paste · ⊙ /goal active (10m)",
  goal: "◎ /goal active (15m)",
  none: "",
};

function layout({
  cols = 207,
  rows = 50,
  phase = "idle",
  verb = "Baked",
  duration = "1m 39s",
  monitor = true,
  right = "update",
  label = "",
  cursor = "blank",
  agents = 0,
  selected = -1,
  titles = ["Fix the PMTiles OOM", "Audit the zone and tile tests", "Draft the release notes"],
  monitors = 1,
  transcript = "plain",
  diffHeaderAbove = false,
  footer = "auto",
  entry = true,
  glyphs = "screenshot",
  redraw,
  trailing = "",
} = {}) {
  // The glyphs as the screenshots show them, or as the bytes of the real capture carry them (`⏵⏵` for the footer's `▶▶`,
  // `⏺` for the message bullet, `✳` in the spinner), which are the ones whose width a terminal does not settle alone.
  const glyph =
    glyphs === "bytes"
      ? { footer: "⏵⏵", plan: "⏸", bullet: "⏺", spinner: "✳", status: "✻" }
      : glyphs === "ambiguous"
        ? { footer: "▶▶", plan: "⏸", bullet: "⏺", spinner: "✳", status: "✱" }
        : { footer: "▶▶", plan: "⏸", bullet: "●", spinner: "✱", status: "✻" };
  // The agents panel: a blank row, `● main`, then a `○` row per agent with its duration and tokens right-aligned; the
  // selection `❯` is on one row, on `● main`, or nowhere. The footer's own counts are not the panel's.
  const panelRow = (glyph, text, right2) => {
    const left = `${glyph} ${text}`;
    const gap = Math.max(1, cols - [...left].length - [...right2].length - 1);
    return `${left}${right2 ? " ".repeat(gap) + right2 : ""}`;
  };
  const panel =
    agents > 0
      ? [
          "",
          panelRow(selected === "main" ? "❯ \x1b[1m●" : "  \x1b[1m●", "main\x1b[22m", ""),
          ...Array.from({ length: agents }, (_, i) =>
            panelRow(i === selected ? "❯ ○" : "  ○", `general-purpose  ${titles[i % titles.length]}`, `${i + 1}m 47s · ↓ ${90 + i}.6k tokens`),
          ),
        ]
      : [];
  const footerRow = rows - 1 - panel.length;
  const bottomRule = footerRow - 1;
  const promptRow = bottomRule - 1;
  const topRule = promptRow - 1;
  const rightRow = topRule - 1;
  // `entry: "diff"`: no erase at all, the rows are written over what is there, as Claude's own redraws do when
  // only part of the screen changed (a panel that grows or shrinks moves the box over rows that held other things).
  // The rows are blanked from their first cell with the erase-to-end-of-line (`K`), not a whole-screen or
  // whole-line erase, and written again.
  const out = [
    entry === "diff"
      ? Array.from({ length: rows }, (_, row) => `\x1b[${row + 1};1H\x1b[K`).join("")
      : entry
        ? "\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l"
        : "\x1b[2J\x1b[H",
  ];
  if (transcript === "diff") {
    // A rendered diff block as the UI draws it: full-width coloured BACKGROUNDS (red for removed, green for added),
    // line numbers, a dim `└` row, YAML with comments, `---` and `──` inside the text, bullet rows and a `Ran`
    // row with a dim summary at the far right. None of it is a rule, a prompt or muted text.
    const fill = (bg, text) => `\x1b[48;5;${bg}m${text}\x1b[K${RESET}`;
    const dim = (text) => `${MUTED}${text}${RESET}`;
    const diffRows = [
      "● Update(ci/deploy.yml)",
      dim("  └ Allowed by auto mode classifier"),
      fill(52, "─".repeat(cols - 1)), // a coloured separator far above the box: a rule by shape, never the box's
      "  --- a/ci/deploy.yml",
      "  +++ b/ci/deploy.yml",
      fill(52, " 56 −   - name: build # ──────────────────── section ────────────────────"),
      fill(22, " 56 +   - name: build --- the new one"),
      fill(22, " 60 +   - name: └ ─ not a rule"),
      "  # a comment line in the yaml, with ──── inside",
      `● Ran 1 shell command${" ".repeat(Math.max(1, cols - 21 - 24 - 1))}${dim("· ran the tests, all green")}`,
    ];
    diffRows.forEach((text, i) => out.push(at(1 + i, 1, text)));
  } else {
    out.push(at(1, 1, `${glyph.bullet} The last assistant text, which says what was done.`));
    out.push(at(3, 1, `${glyph.bullet} Another message, drawn earlier.`));
  }
  if (phase === "waiting") {
    out.push(at(topRule - 3, 1, `${GRAY}${glyph.status} Waiting for ${Math.max(agents, 1)} background agents to finish${RESET}`));
  } else if (phase === "idle") {
    out.push(at(topRule - 3, 1, `${GRAY}${glyph.status} ${verb} for ${duration} · done 8:32 PM${monitor ? " · 1 monitor still running" : ""}${RESET}`));
  } else if (phase === "working") {
    out.push(at(topRule - 4, 1, `\x1b[38;5;174m${glyph.spinner} ${verb}…${RESET} ${GRAY}(21s · ↓ 2.0k tokens)${RESET}`));
    out.push(at(topRule - 3, 1, `${MUTED}  Tip: Use /memory to view and manage Claude memory${RESET}`));
  }
  const text = RIGHT_LINES[right] ?? "";
  if (text) out.push(at(rightRow, Math.max(1, cols - [...text].length + 1), text));
  // A diff header (`---`) on the row right above the top rule, in place of the right-aligned line.
  if (diffHeaderAbove && !text) out.push(at(rightRow, 1, "--- a/ci/deploy.yml"));
  out.push(at(topRule, 1, rule(cols, label)));
  const line =
    cursor === "blank" ? `❯ \x1b[7m \x1b[27m` : cursor === "suggestion" ? `❯ \x1b[7mc\x1b[27m${MUTED}ontinue${RESET}` : "❯ ";
  out.push(at(promptRow, 1, line));
  out.push(at(bottomRule, 1, rule(cols)));
  const glyph2 = footer === "plan" ? glyph.plan : glyph.footer;
  const mode = footer === "plan" ? "plan mode on" : "auto mode on";
  const parts = [`${mode} (shift+tab to cycle)`];
  if (monitor) parts.push(monitors === 1 ? "1 monitor" : `${monitors} monitors`);
  if (phase === "working") parts.push("esc to interrupt");
  parts.push("← 1 agent", "↓ to manage");
  out.push(at(footerRow, 3, `\x1b[33m${glyph2}\x1b[0m ${GRAY}${parts.join(" · ")}${RESET}`));
  panel.forEach((text2, i) => out.push(at(footerRow + 1 + i, 1, text2)));
  if (trailing) {
    // A glyph far to the right of the footer, the panel rows and the status line: past where a later row (the
    // box's prompt row) is written, so only an erase or an overwrite of those cells clears it.
    const far = Math.min(100, cols - 10);
    for (const row of [footerRow, ...panel.map((_, i) => footerRow + 1 + i), topRule - 3, topRule - 4]) {
      if (row >= 0 && row < rows) out.push(at(row, far, trailing));
    }
  }
  if (!redraw) return out.join("");
  // A redraw of only what changed, row by row, with no whole-row erase before the writes: what is left of the old
  // rows is cleared only as `redraw` says. `k`: the tail of each row is erased with `K` after its writes, and a row
  // with no writes is blanked with `K` from its first cell. `x`: the same with `X` for as many cells as the row
  // has. `overwrite`: no erase at all, a row is written over with spaces and then its content.
  const writes = new Map();
  for (const piece of out.slice(1)) {
    const at2 = /^\x1b\[(\d+);\d+H/.exec(piece);
    const row = Number(at2[1]);
    writes.set(row, [...(writes.get(row) ?? []), piece]);
  }
  const rowwise = [];
  for (let row = 1; row <= rows; row += 1) {
    const mine = writes.get(row) ?? [];
    const start = `\x1b[${row};1H`;
    if (redraw === "overwrite") {
      rowwise.push(`${start}${" ".repeat(cols)}${mine.join("")}`);
    } else {
      const erase = redraw === "x" ? `\x1b[${cols}X` : "\x1b[K";
      rowwise.push(mine.length === 0 ? `${start}${erase}` : `${mine.join("")}${erase}`);
    }
  }
  return rowwise.join("");
}

/** The 1-based row of the prompt line of `layout(options)`, for a test that draws on it. */
function promptLine({ rows = 50, agents = 0 } = {}) {
  const panelRows = agents > 0 ? 2 + agents : 0;
  return rows - 1 - panelRows - 2 + 1; // footer row, bottom rule, then the prompt row; 1-based
}

module.exports = { layout, promptLine, RIGHT_LINES };
