"use strict";
/**
 * A real capture: Claude Code 2.1.285 on a 207x50 pty (auto mode on, from the user's settings), started with
 * `--model claude-haiku-4-5` (the organisation refuses that model and it used another one, which the
 * banner says), ONE prompt typed, `Reply with the single word ok.`, the whole turn recorded, then trimmed here at the
 * reply's end (before the `/exit` that followed). The output is the chunks as the terminal received them: the
 * UI redraws only what changed, with absolute cursor moves, so a screen is whatever the chunks up to some
 * point have drawn. Text that is not Claude's own UI (the organisation's banner, the model line, the folder)
 * is replaced by `x` of the same length; the session's own words, the UI's strings, the escape sequences and
 * their order are as captured.
 *
 * What it shows (row numbers of a 50-row screen):
 * - idle, after chunk 5: the top rule on row 46 (plain, no label), the prompt row 47 (`❯ ` and the muted
 *   suggestion `Try "fix typecheck errors"`), the bottom rule 48, the footer 49 (`⏵⏵ auto mode on (shift+tab to
 *   cycle) · ← 1 agent`);
 * - typing, after chunk 6: the same row holds the typed text;
 * - mid-turn, after chunk 8: the spinner row 44 (`✽ Pouncing… (running UserPromptSubmit hook · 0s)`), the
 *   box EMPTY (`❯ ` alone, no suggestion), the footer `⏵⏵ auto mode on (shift+tab to cycle) · esc to
 *   interrupt · ← 1 agent`; the sessions file said `busy` meanwhile;
 * - done, after chunk 22: `✻ Sautéed for 1s · done 8:43 PM` above, the footer without `esc to interrupt`.
 */
const RULE = (n) => "─".repeat(n);

const CHUNKS = [
  "\u001b7\u001b[r\u001b8\u001b[?25h",
  "\u001b[?2004h\u001b[?2031h\u001b[?1004h",
  "\u001b]0;✳ Claude Code\u0007",
  "\u001b[?1049h\u001b[2J\u001b[H\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h\u001b[?25l\u001b[?25l\u001b[H\r\u001b[1B\u001b[38;5;174m ▐\u001b[48;5;16m▛███▛█\u001b[12G\u001b[39m\u001b[49m\u001b[1mClaude Code\u001b[24G\u001b[22m\u001b[38;5;246mv2.1.285\r\u001b[1B\u001b[38;5;174m▝▜\u001b[48;5;16m█████\u001b[49m█▀\u001b[12G\u001b[38;5;246mSonnet 5.5 · xxxxxxxxxxxxxxxxx\r\u001b[1B\u001b[38;5;174m ▝▝   ▝▝ \u001b[12G\u001b[38;5;246mxxxxxxxxxxxxxxx\r\u001b[2B\u001b[38;5;220m⚠\u001b[3Gxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r\u001b[2B\u001b[38;5;174m▎\u001b[3G\u001b[38;5;246mxxxxxxx\u001b[11Gxxxx\u001b[16Gxxxxxxxxxxxxxxxxxxxxx:\r\u001b[1B\u001b[38;5;174m▎\u001b[3G\u001b[39m--------------------------------------------\r\u001b[1B\u001b[38;5;174m▎\u001b[3G\u001b[39mxxxxxx\u001b[10Gxxxx\u001b[15Gxxxx\u001b[20Gxxxxxxxxxxx\r\u001b[1B\u001b[38;5;174m▎\u001b[3G\u001b[39mxxxx\u001b[8Gxxxxxxxxx\r\u001b[1B\u001b[38;5;174m▎\u001b[3G\u001b[39m--------------------------------------------\r\u001b[1B\u001b[38;5;174m▎\u001b[3G\u001b[39mxxxxx:\u001b[10Gxxxxxx\u001b[17Gxxx\u001b[21Gxxxxxxxxxxx\u001b[33Gx\u001b[35Gxxxxxx\u001b[42Gxxxxx\u001b[48Gxx\u001b[51Gxxxxxxxxxx\r\u001b[187C\u001b[33B\u001b[38;5;246m◐ medium · /effort\r\u001b[1B\u001b[38;5;244m" +
    RULE(18),
  RULE(189) + "\r\u001b[1B\u001b[39m❯ \u001b[2mTry \"fix typecheck errors\"\r\u001b[1B\u001b[22m\u001b[38;5;244m" + RULE(130),
  RULE(77) + "\r\u001b[2C\u001b[1B\u001b[38;5;220m⏵⏵ auto mode on\u001b[38;5;246m (shift+tab to cycle) · ← for agents\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h\u001b[?25l\u001b[H\r\u001b[43C\u001b[49B\u001b[38;5;246m1 agent\u001b[39m\u001b[K\u001b[50;1H\u001b[48;3H\u001b[?25h\u001b[>0q\u001b[?u\u001b[c",
  // 6: the prompt typed into the box
  "\u001b[?25l\u001b[H\r\u001b[2C\u001b[47BReply with the single word\u001b[30Gok.\r\u001b[38C\u001b[2B\u001b[K\u001b[50;1H\u001b[48;33H\u001b[?25h",
  "\u001b]0;◐ Claude Code\u0007",
  // 8: Enter pressed: the spinner row, the box empty, `esc to interrupt` in the footer
  "\u001b[?25l\u001b[H\r\u001b[14B\u001b[48;5;237m\u001b[38;5;239m❯ \u001b[38;5;246mReply with the single word ok.\u001b[39m" + " ".repeat(175) + "\r\u001b[30B\u001b[49m\u001b[38;5;174m✽\u001b[3GPou\u001b[38;5;216mnci\u001b[38;5;174mng… \u001b[38;5;246m(running UserPromptSubmit hook · 0s)\r\u001b[3B❯ \u001b[39m\u001b[K\r\u001b[38C\u001b[2B\u001b[38;5;246m · esc to interrupt · ← 1 agent\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[12C\u001b[44B\u001b[K\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✻\u001b[5G\u001b[38;5;216mu\u001b[8G\u001b[38;5;174mi\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✶\u001b[4G\u001b[38;5;216mo\u001b[7G\u001b[38;5;174mc\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✳\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✢\u001b[3G\u001b[38;5;216mP\u001b[6G\u001b[38;5;174mn\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m·\u001b[5Gu\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[3C\u001b[44B\u001b[38;5;174mo\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b]0;◑ Claude Code\u0007",
  "\u001b]0;◑ Single word reply\u0007",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✢\u001b[3GP\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  // 19: the reply is drawn, still working
  "\u001b[?25l\u001b[H\r\u001b[2C\u001b[14B\u001b[48;5;237m\u001b[38;5;231mReply with the single word ok.\r\u001b[2B\u001b[49m⏺\u001b[3G\u001b[39mok\r\u001b[2C\u001b[28B\u001b[38;5;174mGusting… \u001b[39m\u001b[K\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b[?25l\u001b[H\r\u001b[44B\u001b[38;5;174m✳\u001b[3G\u001b[38;5;216mGusting…\u001b[12G\u001b[38;5;246m(running Stop hook · 1s · ↓\u001b[40G2 tokens)\u001b[39m\u001b[50;1H\u001b[48;3H\u001b[?25h",
  "\u001b]0;✳ Single word reply\u0007",
  // 22: done
  "\u001b[?25l\u001b[H\r\u001b[18B\u001b[38;5;246m✻\u001b[3GSautéed for 1s · done 8:43 PM\r\u001b[26B\u001b[39m\u001b[K\r\u001b[3B❯ \r\u001b[41C\u001b[2B\u001b[38;5;246m← 1\u001b[46Gagent\u001b[39m\u001b[K\u001b[50;1H\u001b[48;3H\u001b[?25h",
];

/** Chunk indexes after which the screen is: idle, the prompt typed, mid-turn (box empty), the reply drawn, done. */
const AFTER = { idle: 5, typed: 6, working: 8, replied: 19, done: 22 };

module.exports = { COLS: 207, ROWS: 50, CHUNKS, AFTER };
