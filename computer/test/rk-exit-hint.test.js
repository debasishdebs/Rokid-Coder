"use strict";
/**
 * What `rk claude` leaves on the screen after the child exits. Plain `claude` leaves the alternate
 * screen by itself on `/exit` and prints "Resume this session with:" on the main one, then exits at
 * once; rk must not put that hint out of sight (a second `?1049l` after it restores the cursor saved
 * at the first `?1049h`), and when the hint never reached the terminal rk says the id itself, once.
 * The fake plays Claude (FAKE_EXIT_HINT); no real claude is started.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, until, waitDead, rkEnv, inPty, readJson, terminalModes, tuiModes } = require("./helpers/rk.js");
const { KittyKeyboardTracker, ResumeHintWatcher, restoreTerminal } = require("../dist/launcher/terminal.js");
const { sessionHasTranscript } = require("../dist/launcher/claude-sessions.js");

const ID = "sess-exit-hint";
const count = (text, needle) => text.split(needle).length - 1;

/** rk claude on a pty with the fake behind it, driven to `/exit`; resolves with the run and the status. */
async function exitRun(dir, extra, { exit = "/exit", before } = {}) {
  const { env } = await rkEnv(dir, { FAKE_PIDFILE: path.join(dir, "pids.json"), FAKE_SESSION_ID: ID, FAKE_TUI_MODES: "1", ...extra });
  await before?.(dir);
  const run = inPty(process.execPath, [RK, "claude"], env);
  await run.until("fake-claude ready");
  const pids = await until(() => readJson(path.join(dir, "pids.json")), 5000, "the fake's pid file");
  // rk finds the session by polling its file; give it the fast polls to do so before the child goes.
  await new Promise((resolve) => setTimeout(resolve, 600));
  run.write(`${exit}\r`);
  await run.exited;
  await waitDead(pids.pid);
  return run;
}

test("the_childs_own_hint_after_leaving_the_alternate_screen_is_kept_and_rk_adds_no_second_leave", async () => {
  await withTempDir(async (dir) => {
    const run = await exitRun(dir, { FAKE_EXIT_HINT: "1" });
    assert.equal(run.out.includes("Resume this session with:"), true, "the hint is on the terminal");
    assert.equal(run.out.includes(`claude --resume ${ID}`), true);
    assert.equal(count(run.out, "Resume this session with:"), 1, "the child's hint is the only one: rk adds no extra line");
    // The child left the alternate screen once, before its hint; rk's restore does not leave it again.
    assert.equal(count(run.out, "\x1b[?1049l"), 1);
    assert.equal(run.out.lastIndexOf("\x1b[?1049l") < run.out.indexOf("Resume this session with:"), true);
    assert.deepEqual(tuiModes(run.out).altScreen, false);
    assert.deepEqual(terminalModes(run.out), { cursorHidden: false, bracketedPaste: false }, "cursor shown, paste off");
    assert.equal(run.exit.code, 0);
  });
});

test("a_hint_that_never_reached_the_terminal_is_said_once_by_rk_after_the_restore", async () => {
  await withTempDir(async (dir) => {
    const run = await exitRun(dir, { FAKE_EXIT_HINT: "leave" }, { exit: "/exit 3" });
    const line = `Resume this session with: rk claude --resume ${ID}\n`;
    assert.equal(count(run.out, `rk claude --resume ${ID}`), 1, "once");
    assert.equal(run.out.replace(/\r/g, "").endsWith(line), true, "last, after the terminal was restored");
    assert.equal(count(run.out, "\x1b[?1049l"), 1, "the child's leave only");
    assert.equal(run.exit.code, 3, "the exit code is the child's, whatever is printed");
  });
});

test("the_line_needs_a_known_id_a_terminal_and_a_conversation_to_resume", async () => {
  // A conversation exists: a transcript in any folder of projects.
  await withTempDir(async (dir) => {
    const run = await exitRun(dir, { FAKE_EXIT_HINT: "leave" }, {
      before: async (d) => {
        fs.mkdirSync(path.join(d, "projects", "-some-folder"), { recursive: true });
        fs.writeFileSync(path.join(d, "projects", "-some-folder", `${ID}.jsonl`), "");
      },
    });
    assert.equal(count(run.out, `rk claude --resume ${ID}`), 1);
  });
  // Projects can be read and hold no transcript for it: nothing was said, and plain claude prints no hint either.
  await withTempDir(async (dir) => {
    const run = await exitRun(dir, { FAKE_EXIT_HINT: "leave" }, {
      before: async (d) => fs.mkdirSync(path.join(d, "projects", "-some-folder"), { recursive: true }),
    });
    assert.equal(run.out.includes("rk claude --resume"), false);
  });
  // The id is unknown (this Claude writes no sessions file, and rk looks for one by the child's pid only): no line.
  await withTempDir(async (dir) => {
    const run = await exitRun(dir, { FAKE_EXIT_HINT: "leave", ROKID_CLAUDE_SESSIONS_DIR: "" });
    assert.equal(run.out.includes("rk claude --resume"), false);
  });
});

test("the_line_is_not_printed_when_stdout_is_not_a_terminal", async () => {
  await withTempDir(async (dir) => {
    const { spawn } = require("node:child_process");
    const { env, sessionsDir } = await rkEnv(dir, { FAKE_SESSION_ID: ID, FAKE_EXIT_HINT: "leave", FAKE_PIDFILE: path.join(dir, "pids.json") });
    // stdout is a pipe here: rk runs the child on its own pty and its stdin is a pipe too.
    const rk = spawn(process.execPath, [RK, "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    rk.stdout.on("data", (d) => (out += d));
    rk.stderr.on("data", (d) => (err += d));
    await until(() => out.includes("fake-claude ready"), 8000, "the fake");
    await new Promise((resolve) => setTimeout(resolve, 600));
    rk.stdin.write("/exit\r");
    await new Promise((resolve) => rk.on("exit", resolve));
    assert.equal(`${out}${err}`.includes("rk claude --resume"), false);
    assert.equal(fs.existsSync(sessionsDir), true);
  });
});

test("the_restore_leaves_the_alternate_screen_only_when_the_child_left_it_on", () => {
  const tracker = new KittyKeyboardTracker();
  tracker.push("\x1b[?1049h\x1b[2Jtui");
  assert.equal(tracker.restore().leaveAlt, true, "killed mid-TUI: left as ever");
  tracker.push("\x1b[?1049l\r\nResume this session with:\r\n");
  assert.equal(tracker.restore().leaveAlt, false, "it already left: no second leave");
  // The other alternate-screen modes count the same, a split sequence too.
  for (const mode of ["47", "1047"]) {
    const t = new KittyKeyboardTracker();
    t.push(`\x1b[?${mode}h`);
    assert.equal(t.restore().leaveAlt, true, mode);
    t.push(`\x1b[?${mode}l`);
    assert.equal(t.restore().leaveAlt, false, mode);
  }
  const split = new KittyKeyboardTracker();
  split.push("\x1b[?10");
  split.push("49h");
  assert.equal(split.restore().leaveAlt, true);
  // No tracker at all (before the child existed): the screen is left as it always was.
  const written = [];
  const real = fs.writeSync;
  const stdoutTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  fs.writeSync = (fd, data) => written.push(String(data));
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    restoreTerminal("none");
    restoreTerminal("none", { onAlt: "", onMain: "", leaveAlt: false });
    restoreTerminal("none", { onAlt: "", onMain: "", leaveAlt: true });
  } finally {
    fs.writeSync = real;
    if (stdoutTty) Object.defineProperty(process.stdout, "isTTY", stdoutTty);
    else delete process.stdout.isTTY;
  }
  assert.deepEqual(written.map((w) => w.includes("\x1b[?1049l")), [true, false, true]);
});

test("the_resume_hint_is_recognised_through_escape_sequences_and_chunk_splits", () => {
  const plain = new ResumeHintWatcher();
  plain.push("\x1b[?1049l\r\nResume this session with:\r\nclaude --resume x\r\n");
  assert.equal(plain.seen, true);
  const split = new ResumeHintWatcher();
  split.push("Resume this ses");
  assert.equal(split.seen, false);
  split.push("sion with:");
  assert.equal(split.seen, true);
  const placed = new ResumeHintWatcher();
  placed.push("\x1b[1mResume\x1b[8Gthis\x1b[13Gsession\x1b[21Gwith:\x1b[0m");
  assert.equal(placed.seen, true);
  const none = new ResumeHintWatcher();
  none.push("Resumed the work on this session\r\n");
  assert.equal(none.seen, false);
});

test("a_session_has_a_transcript_when_any_project_folder_holds_its_file", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "rk-transcript-"));
  assert.equal(sessionHasTranscript(dir, "abc"), undefined, "no projects folder: not known");
  fs.mkdirSync(path.join(dir, "projects", "-a-b"), { recursive: true });
  assert.equal(sessionHasTranscript(dir, "abc"), false);
  fs.writeFileSync(path.join(dir, "projects", "-a-b", "abc.jsonl"), "");
  assert.equal(sessionHasTranscript(dir, "abc"), true);
  for (const bad of ["../abc", "a/b", ".hidden", ""]) {
    assert.equal(sessionHasTranscript(dir, bad), undefined, bad);
  }
});

test("the_hint_is_found_across_a_cut_escape_sequence_and_only_after_the_last_leave_of_the_alternate_screen", () => {
  // A chunk that ends inside the sequence between two words: the rest of it is not text.
  const cut = new ResumeHintWatcher();
  cut.push("Resume\x1b[");
  cut.push("8Gthis session with:");
  assert.equal(cut.seen, true);
  const osc = new ResumeHintWatcher();
  osc.push("\x1b]0;a title that goes on");
  osc.push(" and ends\x07Resume this session with:");
  assert.equal(osc.seen, true);
  // The phrase in a transcript the child showed on the alternate screen is not its hint.
  const transcript = new ResumeHintWatcher();
  transcript.push("\x1b[?1049h\x1b[2JResume this session with: (a line of the conversation)\r\n");
  assert.equal(transcript.seen, true, "while it is on screen it could still be the hint of a child that never leaves");
  transcript.push("\x1b[?1049l\x1b[?25h");
  assert.equal(transcript.seen, false, "the child left the screen and said nothing after it");
  transcript.push("\r\nResume this session with:\r\nclaude --resume x\r\n");
  assert.equal(transcript.seen, true, "and what it printed after leaving is");
  // Leave and phrase in one chunk, and the other alternate-screen modes.
  for (const leave of ["\x1b[?1049l", "\x1b[?47l", "\x1b[?1047l", "\x1b[?1004;1049l"]) {
    const w = new ResumeHintWatcher();
    w.push(`Resume this session with: earlier${leave}`);
    assert.equal(w.seen, false, JSON.stringify(leave));
    w.push(`${leave}\r\nResume this session with:`);
    assert.equal(w.seen, true, JSON.stringify(leave));
  }
  // A child that never used the alternate screen: only the last few KiB count.
  const plain = new ResumeHintWatcher();
  plain.push("Resume this session with: a line it printed long ago\r\n");
  assert.equal(plain.seen, true);
  for (let i = 0; i < 6; i += 1) plain.push("x".repeat(1024));
  assert.equal(plain.seen, false, "the end of the output is where the hint is");
});

test("the_line_names_the_session_the_file_shows_last_and_prints_nothing_for_one_with_no_conversation", async () => {
  // A /clear right before /exit (well inside the two seconds of the slow poll): the id the poll had is the old one.
  for (const [transcript, expected] of [["sess-after-clear", "sess-after-clear"], [ID, undefined], [undefined, undefined]]) {
    await withTempDir(async (dir) => {
      const { env } = await rkEnv(dir, {
        FAKE_PIDFILE: path.join(dir, "pids.json"),
        FAKE_SESSION_ID: ID,
        FAKE_NEXT_SESSION_ID: "sess-after-clear",
        FAKE_TUI_MODES: "1",
        FAKE_EXIT_HINT: "leave",
      });
      fs.mkdirSync(path.join(dir, "projects", "-f"), { recursive: true });
      if (transcript) fs.writeFileSync(path.join(dir, "projects", "-f", `${transcript}.jsonl`), "");
      const run = inPty(process.execPath, [RK, "claude"], env);
      await run.until("fake-claude ready");
      const pids = await until(() => readJson(path.join(dir, "pids.json")), 5000, "the fake's pid file");
      await new Promise((resolve) => setTimeout(resolve, 600));
      run.write("/clear\r");
      await new Promise((resolve) => setTimeout(resolve, 150));
      run.write("/exit\r");
      await run.exited;
      await waitDead(pids.pid);
      const lines = [...run.out.matchAll(/rk claude --resume (\S+)/g)].map((m) => m[1]);
      assert.deepEqual(lines, expected ? [expected] : [], `transcript ${transcript}`);
    });
  }
});

test("a_late_agentd_still_restarts_the_fast_session_polls_and_one_read_serves_each_poll", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "rk.ts"), "utf8");
  const poll = source.slice(source.indexOf("const pollSession"), source.indexOf("pollTimer = setTimeout(pollSession, everFound"));
  assert.equal((poll.match(/findOwnedClaudeSession\(/g) ?? []).length, 1, "one read of the sessions file for each poll");
  // The id is kept without touching `everFound`, so a link that never came up gives up as it always did.
  const idLine = poll.indexOf("lastSessionId = session.sessionId");
  const everFound = poll.indexOf("everFound = true");
  const linkUp = poll.indexOf("if (link.up)");
  assert.equal(idLine > 0 && idLine < linkUp && everFound > linkUp, true, "everFound is only set once the link is up");
});
