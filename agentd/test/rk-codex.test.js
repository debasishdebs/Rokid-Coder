// rk codex on Path B (R133): plain codex with inherited stdio and the attach hint.
const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { PinStore } = require("../dist/tls.js");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, until, waitDead, rkEnv, inPty, killLive, readJson, sttyState, pairPhone } = require("./helpers/rk.js");

afterEach(killLive);

const NEXT_STEP = "type rokid:on inside Codex to show this session on the glasses";
const SIG = os.constants.signals;
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** A stand-in agentd: answers GET /health on the port rk will probe. Close it in finally. */
async function fakeAgentd(env) {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(Number(env.NEXUS_AGENTD_HTTP_PORT), "127.0.0.1", resolve));
  return { close: () => new Promise((resolve) => server.close(resolve)) };
}

const PAIR_LATER = 'Pair later: run "agentd pair" or type /rokid:pair in Claude (rokid:pair in Codex).';

/** rk codex with stderr on a pipe, so the hint is seen the way a script or log would see it. */
function runPiped(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [RK, "codex"], { env, timeout: 15000 }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

test("path_b_prints_attach_hint", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir);
    const run = inPty(process.execPath, [RK, "codex"], env);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    const out = plain(run.out);
    assert.equal(out.split(NEXT_STEP).length - 1, 1, out);
    assert.ok(out.indexOf(NEXT_STEP) < out.indexOf("fake-codex ready"), "the hint comes before Codex starts");
    assert.equal(out.includes("Rokid-Coder launcher: attached"), false, "Path B never claims a binding");
  });
});

test("rk_codex_prints_next_step_hint", async () => {
  await withTempDir(async (dir) => {
    const { env, configDir } = await rkEnv(dir);
    pairPhone(configDir);
    const agentd = await fakeAgentd(env);
    try {
      const result = await runPiped(env);
      assert.equal(result.code, 0);
      // Plain text on a pipe: no colour codes, and on stderr so stdout stays Codex's.
      assert.equal(/\x1b/.test(result.stderr), false, JSON.stringify(result.stderr));
      assert.equal(result.stdout.includes("rokid:on"), false);
      const lines = result.stderr.trimEnd().split("\n");
      assert.ok(lines.length >= 3 && lines.length <= 6, result.stderr);
      assert.ok(result.stderr.includes(NEXT_STEP), result.stderr);
      assert.ok(/rokid:off[^\n]*rokid:status/.test(result.stderr), "one line on rokid:off and rokid:status");
      assert.equal(result.stderr.includes("agentd run"), false, "agentd is up: no start hint");
      assert.equal(result.stderr.includes("agentd pair"), false, "a phone is paired: no pair hint");
    } finally {
      await agentd.close();
    }
  });
});

test("rk_codex_hint_mentions_agentd_run_when_unreachable", async () => {
  await withTempDir(async (dir) => {
    const { env, configDir } = await rkEnv(dir); // the hook port has nothing listening
    pairPhone(configDir);
    const result = await runPiped(env);
    assert.equal(result.code, 0, "Codex still starts");
    assert.ok(/agentd isn't running[^\n]*agentd run/.test(result.stderr), result.stderr);
    assert.equal(result.stderr.includes("agentd pair"), false);
    assert.ok(result.stderr.trimEnd().split("\n").length <= 6, result.stderr);
  });
});

test("rk_codex_hint_mentions_pair_when_unpaired", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, {}, { unpaired: true }); // no pin file under the config dir
    const agentd = await fakeAgentd(env);
    try {
      const result = await runPiped(env);
      assert.equal(result.code, 0, "Codex still starts");
      assert.ok(result.stderr.includes(PAIR_LATER), result.stderr);
      assert.equal(result.stderr.includes("Pair now?"), false, "a pipe is never asked");
      assert.equal(result.stderr.includes("agentd run"), false);
      assert.ok(result.stderr.trimEnd().split("\n").length <= 6, result.stderr);
    } finally {
      await agentd.close();
    }
  });
});

test("rk_codex_hint_mentions_plugin_install", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir);
    const agentd = await fakeAgentd(env);
    try {
      const result = await runPiped(env);
      assert.ok(/rokid:on works only once the Rokid-Coder plugin[^\n]*installed in Codex/.test(result.stderr), result.stderr);
      assert.ok(result.stderr.trimEnd().split("\n").length <= 6, result.stderr);
    } finally {
      await agentd.close();
    }
  });
});

test("rk_codex_pair_prompt_opens_window_then_starts_codex", async () => {
  await withTempDir(async (dir) => {
    const { env, configDir } = await rkEnv(dir, {}, { unpaired: true });
    const agentd = await fakeAgentd(env);
    try {
      const run = inPty(process.execPath, [RK, "codex"], env);
      await run.until("No phone paired yet. Pair now? [Y/n]");
      run.write("y\r");
      await run.until("Open Agents on your phone → Add a computer (2:00 left)");
      const pins = new PinStore(path.join(configDir, "tls", "phone-pins.json"));
      assert.equal(pins.allowNextOpen(Date.now()), true);
      assert.equal(run.out.includes("fake-codex ready"), false, "Codex waits for the pairing");
      pairPhone(configDir);
      await run.until("Paired ✓", 3000);
      assert.deepEqual(await run.exited, { code: 0, signal: null });
      assert.ok(run.out.indexOf("Paired ✓") < run.out.indexOf("fake-codex ready"), run.out);
    } finally {
      await agentd.close();
    }
  });
});

test("rk_codex_hint_is_bold_only_on_a_terminal", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir);
    const run = inPty(process.execPath, [RK, "codex"], env);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.ok(run.out.includes("\x1b[1mrokid:on\x1b[22m"), JSON.stringify(run.out));
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

test("rk_codex_hint_waits_for_key_or_3s_on_tty", async () => {
  // A key starts Codex at once, and is not passed to it.
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, { ROKID_RK_CODEX_HINT_WAIT_MS: "3000" });
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("press any key to start it now");
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(run.out.includes("fake-codex ready"), false, "the hint stays up");
    const pressed = Date.now();
    run.write("x");
    await run.until("fake-codex ready");
    assert.ok(Date.now() - pressed < 1500, "started on the key");
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.ok(plain(run.out).includes("Rokid-Coder: type rokid:on inside Codex to show a session on the glasses."), run.out);
  });
  // No key: Codex starts after 3 s.
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, { ROKID_RK_CODEX_HINT_WAIT_MS: "3000" });
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("press any key to start it now");
    const shown = Date.now();
    await until(() => run.out.includes("fake-codex ready"), 6000, "Codex after the wait");
    assert.ok(Date.now() - shown >= 2500, "the full wait");
    await run.exited;
  });
  // Not a terminal: no wait.
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, { ROKID_RK_CODEX_HINT_WAIT_MS: "3000" });
    const started = Date.now();
    const result = await runPiped(env);
    assert.equal(result.code, 0);
    assert.ok(Date.now() - started < 2500, "a pipe never waits");
    assert.equal(result.stderr.includes("press any key"), false);
  });
});

// N7: Ctrl-C at the hint is the user saying no, not "any key".
test("ctrl_c_at_the_codex_hint_aborts_with_130", async () => {
  await withTempDir(async (dir) => {
    const argvFile = path.join(dir, "argv.json");
    const { env } = await rkEnv(dir, { ROKID_RK_CODEX_HINT_WAIT_MS: "3000", FAKE_ARGV_FILE: argvFile });
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("press any key to start it now");
    run.write("\x03");
    assert.deepEqual(await run.exited, { code: 128 + SIG.SIGINT, signal: null });
    assert.equal(run.out.includes("fake-codex ready"), false, run.out);
    assert.equal(fs.existsSync(argvFile), false, "Codex was never started");
  });
});

// The hint holds the terminal raw: a kill sent to rk then must still give it back cooked.
test("term_or_hup_at_the_codex_hint_restores_the_terminal_and_never_starts_codex", async () => {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    await withTempDir(async (dir) => {
      const argvFile = path.join(dir, "argv.json");
      const pidFile = path.join(dir, "rk.pid");
      const preload = path.join(dir, "pid.js");
      fs.writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`);
      const { env } = await rkEnv(dir, { ROKID_RK_CODEX_HINT_WAIT_MS: "5000", FAKE_ARGV_FILE: argvFile });
      const script = [
        `stty -g > "${dir}/before"`,
        `"${process.execPath}" --require "${preload}" "${RK}" codex`,
        `echo $? > "${dir}/rc"`,
        `stty -g > "${dir}/after"`,
      ].join("\n");
      const run = inPty("/bin/sh", ["-c", script], env);
      await run.until("press any key to start it now");
      process.kill(Number(fs.readFileSync(pidFile, "utf8")), signal);
      await run.exited;
      const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").trim();
      assert.equal(Number(read("rc")), 128 + SIG[signal], `${signal}: exit status`);
      assert.equal(sttyState(read("after")), sttyState(read("before")), `${signal}: stty -g restored after the hint`);
      assert.equal(run.out.includes("fake-codex ready"), false, run.out);
      assert.equal(fs.existsSync(argvFile), false, `${signal}: Codex was never started`);
    });
  }
});

test("rk_codex_fatal_error_ends_codex_and_restores_terminal", async () => {
  await withTempDir(async (dir) => {
    const events = path.join(dir, "events");
    const preload = path.join(dir, "throw.js");
    fs.writeFileSync(preload, `setTimeout(() => { throw new Error("boom"); }, 2000);`);
    const { env } = await rkEnv(dir, { FAKE_CODEX_HOLD: "1", FAKE_EVENT_FILE: events, FAKE_PIDFILE: path.join(dir, "pids.json") });
    const run = inPty(process.execPath, ["--require", preload, RK, "codex"], env);
    await run.until("fake-codex ready");
    const pids = await until(() => readJson(path.join(dir, "pids.json")), 3000, "pid file");
    assert.deepEqual(await run.exited, { code: 128 + SIG.SIGTERM, signal: null });
    assert.ok(run.out.includes("rk: unexpected error: boom"), run.out);
    assert.equal(fs.readFileSync(events, "utf8"), "SIGTERM\n", "Codex was told to end");
    assert.ok(run.out.includes("\x1b[?1049l"), "the terminal is given back");
    await waitDead(pids.pid);
  });
});
