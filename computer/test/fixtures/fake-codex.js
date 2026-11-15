#!/usr/bin/env node
"use strict";
// A stand-in for `codex`, for rk codex tests. It never contacts a model and never
// touches ~/.codex. Test hooks (env): FAKE_ARGV_FILE, FAKE_PIDFILE, FAKE_EVENT_FILE
// (appended one event per line), FAKE_CODEX_EXIT (exit code on a normal finish),
// FAKE_CODEX_SIGINT_EXIT (exit with it on SIGINT; unset: ignore SIGINT),
// FAKE_CODEX_TERM (exit|ignore, default exit), FAKE_CODEX_RAW=1 (leave the tty in
// raw mode, as a Codex killed mid-TUI would), FAKE_CODEX_HOLD=1 (keep running
// until a signal), FAKE_CODEX_HOLD_MS.
const fs = require("node:fs");

const env = process.env;
const event = (name) => {
  if (env.FAKE_EVENT_FILE) fs.appendFileSync(env.FAKE_EVENT_FILE, `${name}\n`);
};

if (env.FAKE_ARGV_FILE) fs.writeFileSync(env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (env.FAKE_PIDFILE) fs.writeFileSync(env.FAKE_PIDFILE, JSON.stringify({ pid: process.pid, ppid: process.ppid }));
if (env.FAKE_CODEX_RAW === "1" && process.stdin.isTTY) process.stdin.setRawMode(true);

process.on("SIGINT", () => {
  event("SIGINT");
  if (env.FAKE_CODEX_SIGINT_EXIT !== undefined) process.exit(Number(env.FAKE_CODEX_SIGINT_EXIT));
});
process.on("SIGTERM", () => {
  event("SIGTERM");
  if (env.FAKE_CODEX_TERM !== "ignore") process.exit(0);
});
process.on("SIGHUP", () => {
  event("SIGHUP");
  if (env.FAKE_CODEX_TERM !== "ignore") process.exit(0);
});

process.stdout.write("fake-codex ready\n");
if (env.FAKE_CODEX_HOLD === "1") {
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => process.exit(Number(env.FAKE_CODEX_EXIT) || 0), Number(env.FAKE_CODEX_HOLD_MS) || 0);
}
