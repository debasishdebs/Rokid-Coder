"use strict";
/**
 * Synthetic screens in the structure of the real Claude Code 2.1.285 (checked against a screenshot of
 * a session with background agents, 207x50, and against the captured startup bytes): the alternate
 * screen with a whole-screen erase, a transcript that holds `❯` rows of its own, an update notice placed
 * with cursor moves, a rule above the prompt line (with or without a label), the prompt line `❯` + a
 * no-break space + a muted suggestion whose first character carries the cursor (inverse video), a rule
 * below, a footer, a blank row and the AGENTS PANEL (`● main`, then one `○` row per agent, the first
 * of which may carry the selection glyph `❯`). Everything is drawn with absolute cursor positions.
 */
const RULE_SGR = "\x1b[38;5;244m";
const MUTED = "\x1b[2m";
const RESET = "\x1b[0m";

const at = (row, text) => `\x1b[${row + 1};1H${text}`;
const rule = (cols, label) => {
  if (!label) return `${RULE_SGR}${"─".repeat(cols)}${RESET}`;
  return `${RULE_SGR}${"─".repeat(cols - label.length - 3)}${RESET} ${label} ${RULE_SGR}─${RESET}`;
};

/**
 * Options: cols, rows, agents (0..n), selected (index of the panel row that carries `❯`, or -1),
 * label (text in the top rule), notice (the update line above the box), input (typed text, else the muted
 * suggestion `continue` with the cursor on its first character), footer (text of the footer line),
 * dialog (replaces the box with a permission dialog), plan (footer says plan mode).
 */
function claudeScreen({
  cols = 207,
  rows = 50,
  agents = 1,
  selected = -1,
  label = " Rokid app for Claude code integration",
  notice = true,
  input,
  suggestion = "continue",
  footer,
  dialog = false,
  plan = false,
  entry = true,
} = {}) {
  const panelRows = agents > 0 ? 2 + agents : 0; // blank, main, agents...
  const panel = [];
  if (agents > 0) {
    panel.push("");
    panel.push("\x1b[1m● main\x1b[22m");
    for (let i = 0; i < agents; i += 1) {
      const glyph = i === selected ? "❯ ○" : "  ○";
      const description = `general-purpose  Task number ${i + 1} on the draft screen check`;
      const right = `3m ${40 + i}s · ↓ ${400 + i}.9k tokens`;
      const gap = Math.max(1, cols - 4 - description.length - right.length - 2);
      panel.push(`${i === selected ? "" : ""}${glyph} ${description}${" ".repeat(gap)}${right}`);
    }
  }
  const footerText = footer ?? (plan
    ? "⏸ plan mode on (shift+tab to cycle) · ← 1 agent · PR #9 · ↓ to manage"
    : "▶▶ auto mode on (shift+tab to cycle) · ← 1 agent · PR #9 · ↓ to manage");
  const bottomRow = rows - 1 - panel.length;
  const footerRow = bottomRow;
  const bottomRule = footerRow - 1;
  const promptRow = bottomRule - 1;
  const topRule = promptRow - 1;
  const noticeRow = topRule - 1;
  // `entry` is the startup: the alternate screen is entered once. A repaint later is just the erase and the rows.
  const out = [entry ? "\x1b7\x1b[r\x1b8\x1b[?25l\x1b[?2004h\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h" : "\x1b[2J\x1b[H"];
  // The transcript: long text, a user echo with a `❯`, a muted note, a `›` row, a finished-agent line.
  const transcript = [
    "- v3.1 delivery fixes: the five P1s. They cover a single critical section for the gates and the publish.",
    "",
    "✻ Waiting for 2 background agents to finish",
    "",
    "❯ continue",
    "",
    "  Ran 1 shell command",
    "",
    "● Both relaunched agents are working.",
    "",
    "› Message from @a29e6510e22610e70 (ctrl+o to expand)",
    "",
    "● The PMTiles fix is committed as ba611c64. The targeted zone and tile tests pass.",
    "",
    "● Agent \"Fix PMTiles OOM P1 (relaunch)\" finished · 3m 18s",
  ];
  const available = noticeRow - (notice ? 0 : 1);
  transcript.slice(-Math.max(0, notice ? noticeRow : noticeRow + 1)).forEach((line, i, all) => {
    out.push(at(Math.max(0, (notice ? noticeRow : noticeRow + 1) - all.length + i), line));
  });
  void available;
  if (notice) {
    out.push(at(noticeRow, `\x1b[${cols - 46}G\x1b[33mUpdate available! Run: \x1b[1mbrew upgrade claude-code\x1b[0m`));
  }
  if (dialog) {
    out.push(at(topRule - 3, "Bash command"));
    out.push(at(topRule - 2, "  rm -rf build"));
    out.push(at(topRule - 1, "Do you want to proceed?"));
    out.push(at(topRule, rule(cols)));
    out.push(at(promptRow, "❯ 1. Yes"));
    out.push(at(bottomRule, rule(cols)));
    out.push(at(footerRow, "Esc to cancel · Tab to amend"));
  } else {
    out.push(at(topRule, rule(cols, label)));
    const line =
      input === undefined
        ? `❯ \x1b[7m${suggestion[0]}\x1b[27m${MUTED}${suggestion.slice(1)}${RESET}`
        : `❯ ${input}`;
    out.push(at(promptRow, line));
    out.push(at(bottomRule, rule(cols)));
    out.push(at(footerRow, `\x1b[33m${footerText.slice(0, 2)}\x1b[0m${footerText.slice(2)}`));
  }
  panel.forEach((text, i) => out.push(at(footerRow + 1 + i, text)));
  return out.join("");
}

module.exports = { claudeScreen, panelRows: (agents) => (agents > 0 ? 2 + agents : 0) };
