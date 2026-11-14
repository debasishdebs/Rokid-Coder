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
const { RK, until, waitDead, rkEnv, inPty, killLive, readJson, sttyState } = require("./helpers/rk.js");

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

/** Records one trusted phone in the pin file rk reads. */
function pairPhone(configDir) {
  new PinStore(path.join(configDir, "tls", "phone-pins.json")).add("AB".repeat(32));
}

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
    const { env } = await rkEnv(dir); // no pin file under the config dir
    const agentd = await fakeAgentd(env);
    try {
      const result = await runPiped(env);
      assert.equal(result.code, 0, "Codex still starts");
      assert.ok(/No phone is paired[^\n]*agentd pair/.test(result.stderr), result.stderr);
      assert.equal(result.stderr.includes("agentd run"), false);
      assert.ok(result.stderr.trimEnd().split("\n").length <= 6, result.stderr);
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
