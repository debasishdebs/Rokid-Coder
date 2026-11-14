#!/usr/bin/env node
"use strict";
// A stand-in for the real `claude` TUI, for rk launcher tests. It never talks to
// a model and never touches ~/.claude. What it models, because Tasks 2 to 4 rely
// on it:
//   - an editable prompt line, echoing typed keys ("line"); \r submits it,
//     \x15 (Ctrl-U) clears it, Backspace edits it, Up recalls the last submitted
//     line, Ctrl-C clears it, \x1b closes a dialog, a bracketed paste inserts text
//   - its own sessions file, <ROKID_CLAUDE_SESSIONS_DIR>/<pid>.json, with
//     status (busy|idle) and statusUpdatedAt, rewritten on every status change
//   - /compact: busy, PreCompact then PostCompact through the real hook-forward,
//     then idle
//   - /model X: prints "Switch model?" and waits; \r prints "Set model to X" and
//     goes idle; Esc cancels. FAKE_NO_DIALOG=1 prints nothing for /model.
//   - FAKE_BUSY_MS: how long a submitted line keeps the session busy, silently
//   - at start it hides the cursor (\x1b[?25l) and enables bracketed paste (\x1b[?2004h);
//     FAKE_TUI_MODES=1 also enters the alternate screen, mouse and focus reporting and a kitty push
//   - SIGUSR2: writes {line, dialogOpen, model, status, sessionId} to FAKE_STATE_FILE
//   - FAKE_INPUT_ACK_FILE: rewritten with the count of input chars processed so
//     far, so a test can wait for its keys before it signals for a dump
// Other test hooks: /exit [n], /signal NAME, /clear (new session id), and the env
// FAKE_SESSION_ID, FAKE_SESSION_DELAY_MS, FAKE_ARGV_FILE, FAKE_PIDFILE,
// FAKE_GRANDCHILD (1 | stubborn), FAKE_IGNORE_SIGNALS, FAKE_EXIT_ON_EOT, FAKE_HOOK_FORWARD.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const env = process.env;
const state = {
  line: "",
  dialogOpen: false,
  model: env.FAKE_MODEL || "opus",
  status: "idle",
  sessionId: env.FAKE_SESSION_ID || crypto.randomUUID(),
};
let pendingModel;
let lastSubmitted = "";
let lastStatusAt = 0;
let inPaste = false;
let sessionFileWritten = false;
let consumed = 0;

const out = (text) => process.stdout.write(text);

function sessionFile() {
  const dir = env.ROKID_CLAUDE_SESSIONS_DIR;
  return dir ? path.join(dir, `${process.pid}.json`) : undefined;
}

function writeSession() {
  const file = sessionFile();
  if (!file) return;
  // Strictly increasing, so "newer than" checks never tie.
  lastStatusAt = Math.max(lastStatusAt + 1, Date.now());
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    pid: process.pid,
    sessionId: state.sessionId,
    cwd: process.cwd(),
    status: state.status,
    statusUpdatedAt: lastStatusAt,
  }));
  fs.renameSync(tmp, file);
  sessionFileWritten = true;
}

function setStatus(status) {
  state.status = status;
  if (sessionFileWritten) writeSession();
}

function cleanup() {
  const file = sessionFile();
  if (file) {
    try { fs.unlinkSync(file); } catch { /* already gone */ }
  }
}

function quit(code) {
  cleanup();
  process.exit(code);
}
process.on("exit", cleanup);

/** Runs the repository's real hook-forward, as Claude's hook runner would. */
function hook(eventName, extra) {
  return new Promise((resolve) => {
    const forward = env.FAKE_HOOK_FORWARD || path.join(__dirname, "..", "..", "dist", "hook-forward.js");
    const child = spawn(process.execPath, [forward], {
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...env, ROKID_CODER_PROVIDER: "claude", ROKID_CODER_HOOK_DEADLINE_MS: "5000" },
    });
    child.on("error", resolve);
    child.on("exit", resolve);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: state.sessionId, cwd: process.cwd(), hook_event_name: eventName, ...extra }));
  });
}

function busyMs(fallback) {
  const parsed = Number(env.FAKE_BUSY_MS);
  return env.FAKE_BUSY_MS !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function compact() {
  setStatus("busy");
  void hook("PreCompact", { trigger: "manual" })
    .then(() => new Promise((resolve) => setTimeout(resolve, busyMs(300))))
    .then(() => hook("PostCompact", { trigger: "manual" }))
    .then(() => {
      out("Compacted\r\n");
      setStatus("idle");
    });
}

function runLine(text) {
  const [word, ...rest] = text.trim().split(/\s+/);
  switch (word) {
    case "/exit":
      quit(rest[0] === undefined ? 0 : Number(rest[0]));
      return;
    case "/signal":
      cleanup();
      process.kill(process.pid, rest[0] || "SIGTERM");
      return;
    case "/clear":
      state.sessionId = env.FAKE_NEXT_SESSION_ID || crypto.randomUUID();
      writeSession();
      return;
    case "/compact":
      compact();
      return;
    case "/model":
      if (env.FAKE_NO_DIALOG === "1") return;
      pendingModel = rest[0] || "";
      state.dialogOpen = true;
      setStatus("busy");
      out("Switch model?\r\n");
      return;
    default:
      setStatus("busy");
      setTimeout(() => {
        out(`reply: ${text}\r\n`);
        setStatus("idle");
      }, busyMs(0));
  }
}

function submit() {
  if (state.dialogOpen) {
    const model = pendingModel;
    state.dialogOpen = false;
    pendingModel = undefined;
    state.model = model;
    out(`Set model to ${model}\r\n`);
    setStatus("idle");
    return;
  }
  const text = state.line;
  state.line = "";
  lastSubmitted = text;
  out("\r\n");
  runLine(text);
}

function escape() {
  if (state.dialogOpen) {
    state.dialogOpen = false;
    pendingModel = undefined;
    setStatus("idle");
  }
}

function csi(params, final) {
  if (final === "~" && params === "200") inPaste = true;
  else if (final === "~" && params === "201") inPaste = false;
  else if (final === "A" && !state.dialogOpen) {
    state.line = lastSubmitted;
    out(`\r\x1b[K> ${state.line}`);
  }
}

let pending = "";
function onInput(data) {
  pending += data;
  let i = 0;
  while (i < pending.length) {
    const ch = pending[i];
    if (ch === "\x1b") {
      if (pending[i + 1] === "[") {
        const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(pending.slice(i));
        if (!m) break; // an unfinished sequence waits for the next chunk
        csi(m[1], m[2]);
        i += m[0].length;
        continue;
      }
      escape();
      i += 1;
      continue;
    }
    i += 1;
    if (inPaste) {
      state.line += ch === "\r" ? "\n" : ch;
      continue;
    }
    if (ch === "\r") submit();
    else if (ch === "\x15") {
      state.line = "";
      out("\r\x1b[K> ");
    } else if (ch === "\x03") {
      state.line = "";
      state.dialogOpen = false;
      pendingModel = undefined;
      out("^C\r\n");
    } else if (ch === "\x04") {
      if (env.FAKE_EXIT_ON_EOT === "1") quit(0);
    } else if (ch === "\x1a") out("^Z");
    else if (ch === "\x7f" || ch === "\b") {
      state.line = state.line.slice(0, -1);
      out("\b \b");
    } else if (ch >= " " && !state.dialogOpen) {
      state.line += ch;
      out(ch);
    }
  }
  pending = pending.slice(i);
  consumed += i;
  if (env.FAKE_INPUT_ACK_FILE) fs.writeFileSync(env.FAKE_INPUT_ACK_FILE, String(consumed));
}

process.on("SIGUSR2", () => {
  if (!env.FAKE_STATE_FILE) return;
  const { line, dialogOpen, model, status, sessionId } = state;
  fs.writeFileSync(env.FAKE_STATE_FILE, JSON.stringify({ line, dialogOpen, model, status, sessionId }));
});
if (env.FAKE_IGNORE_SIGNALS === "1") {
  process.on("SIGTERM", () => {});
  process.on("SIGHUP", () => {});
}

if (env.FAKE_ARGV_FILE) fs.writeFileSync(env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
let grandchild;
if (env.FAKE_GRANDCHILD === "1") {
  // Same process group as this process, like a tool subprocess Claude would start.
  grandchild = spawn("sleep", ["300"], { stdio: "ignore" });
} else if (env.FAKE_GRANDCHILD === "stubborn") {
  // One that shrugs off TERM and HUP, so only a KILL of the group ends it.
  grandchild = spawn("sh", ["-c", 'trap "" TERM HUP; while :; do sleep 1; done'], { stdio: "ignore" });
}
if (env.FAKE_PIDFILE) {
  fs.writeFileSync(env.FAKE_PIDFILE, JSON.stringify({ pid: process.pid, ppid: process.ppid, grandchild: grandchild && grandchild.pid }));
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", onInput);
process.stdin.on("end", () => quit(0));
process.stdin.on("error", () => {});
process.stdout.on("error", () => {});

setTimeout(() => {
  writeSession();
  // What a TUI does on start: hide the cursor and turn bracketed paste on. rk must
  // undo both on every exit path, whatever state the child dies in.
  out("\x1b[?25l\x1b[?2004h");
  // FAKE_TUI_MODES=1: the rest a full-screen TUI turns on, as real Claude does (R162).
  if (env.FAKE_TUI_MODES === "1") out("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[>1u");
  out("fake-claude ready\r\n");
}, Number(env.FAKE_SESSION_DELAY_MS) || 0);
