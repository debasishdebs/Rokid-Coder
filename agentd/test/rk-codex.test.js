// rk codex on Path B (R133): plain codex with inherited stdio and the attach hint.
const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, until, waitDead, rkEnv, inPty, killLive, readJson, sttyState } = require("./helpers/rk.js");

afterEach(killLive);

const HINT = "Type rokid:on in Codex to attach this session.";
const SIG = os.constants.signals;

test("path_b_prints_attach_hint", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir);
    const run = inPty(process.execPath, [RK, "codex"], env);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.equal(run.out.split(HINT).length - 1, 1, run.out);
    assert.ok(run.out.indexOf(HINT) < run.out.indexOf("fake-codex ready"), "the hint comes before Codex starts");
    assert.equal(run.out.includes("Rokid-Coder launcher: attached"), false, "Path B never claims a binding");
  });
});

test("resume_args_passed_through", async () => {
  await withTempDir(async (dir) => {
    const argvFile = path.join(dir, "argv.json");
    const { env } = await rkEnv(dir, { FAKE_ARGV_FILE: argvFile, FAKE_CODEX_EXIT: "9" });
    const run = inPty(process.execPath, [RK, "codex", "resume", "0198-abc", "--model", "gpt", "a b"], env);
    assert.deepEqual(await run.exited, { code: 9, signal: null }, "the child's own exit code is returned");
    assert.deepEqual(readJson(argvFile), ["resume", "0198-abc", "--model", "gpt", "a b"]);
  });
});

test("rk_codex_missing_binary_exits_127", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, { ROKID_RK_CODEX_BIN: path.join(dir, "no-such-codex") });
    const run = inPty(process.execPath, [RK, "codex"], env);
    assert.deepEqual(await run.exited, { code: 127, signal: null });
    assert.ok(run.out.includes("rk: could not start codex: "), run.out);
  });
});

test("ctrl_c_in_terminal_reaches_codex_not_rk", async () => {
  await withTempDir(async (dir) => {
    const events = path.join(dir, "events");
    const { env } = await rkEnv(dir, { FAKE_CODEX_HOLD: "1", FAKE_CODEX_SIGINT_EXIT: "42", FAKE_EVENT_FILE: events });
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("fake-codex ready");
    run.write("\x03"); // the pty's line discipline sends SIGINT to the whole foreground group
    // Were rk to die of the SIGINT too, this would be a signal exit, not Codex's own 42.
    assert.deepEqual(await run.exited, { code: 42, signal: null });
    assert.equal(fs.readFileSync(events, "utf8"), "SIGINT\n");
  });
});

/** rk codex under a shell, so `stty -g` can be compared on the same pty. */
async function sigtermScenario(dir, { extra, signal }) {
  const events = path.join(dir, "events");
  const { env } = await rkEnv(dir, {
    FAKE_CODEX_HOLD: "1",
    FAKE_CODEX_RAW: "1",
    FAKE_EVENT_FILE: events,
    FAKE_PIDFILE: path.join(dir, "pids.json"),
    ...extra,
  });
  const script = [
    `stty -g > "${dir}/before"`,
    `"${process.execPath}" "${RK}" codex`,
    `echo $? > "${dir}/rc"`,
    `stty -g > "${dir}/after"`,
  ].join("\n");
  const run = inPty("/bin/sh", ["-c", script], env);
  await run.until("fake-codex ready");
  const pids = await until(() => readJson(path.join(dir, "pids.json")), 3000, "pid file");
  process.kill(pids.ppid, signal);
  await run.exited;
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").trim();
  return { rc: Number(read("rc")), before: read("before"), after: read("after"), pids, events: fs.readFileSync(events, "utf8") };
}

test("sigterm_forwarded_and_terminal_restored", async () => {
  const cases = [
    { name: "SIGTERM, codex exits", signal: "SIGTERM", extra: {}, rc: 128 + SIG.SIGTERM, event: "SIGTERM\n" },
    { name: "SIGHUP, codex exits", signal: "SIGHUP", extra: {}, rc: 128 + SIG.SIGHUP, event: "SIGHUP\n" },
    {
      name: "SIGTERM ignored, then KILL",
      signal: "SIGTERM",
      extra: { FAKE_CODEX_TERM: "ignore", ROKID_RK_KILL_AFTER_MS: "300" },
      rc: 128 + SIG.SIGTERM,
      event: "SIGTERM\n",
    },
  ];
  for (const c of cases) {
    await withTempDir(async (dir) => {
      const result = await sigtermScenario(dir, c);
      assert.equal(result.rc, c.rc, `${c.name}: exit status`);
      assert.equal(result.events, c.event, `${c.name}: the signal was forwarded`);
      assert.equal(sttyState(result.after), sttyState(result.before), `${c.name}: stty -g restored (Codex left the tty raw)`);
      await waitDead(result.pids.pid);
    });
  }
});
