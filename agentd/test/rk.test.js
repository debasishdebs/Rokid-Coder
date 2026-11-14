const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { LauncherHub } = require("../dist/launcher/launcher-hub.js");
const { AttachRegistry } = require("../dist/attach-registry.js");
const { silentLogger } = require("../dist/logger.js");
const { withTempDir } = require("./helpers/daemon.js");
const { FAKE_CLAUDE, RK, until, alive, waitDead, rkEnv, inPty, readJson, sttyState } = require("./helpers/rk.js");

const BANNER =
  "Rokid-Coder launcher: attached. From the glasses you can reply at any time, compact, and change model (changing model also sets your default for new sessions).";
const UNREACHABLE = "Rokid-Coder: agentd isn't running — this session is not attached.";
const SIG = os.constants.signals;

const readPids = (file) => until(() => readJson(file), 5000, "the fake's pid file");

/** rk claude on an outer pty with the fake behind it. */
async function startRk(dir, { extra = {}, args = [] } = {}) {
  const { env, ...rest } = await rkEnv(dir, { FAKE_PIDFILE: path.join(dir, "pids.json"), ...extra });
  const run = inPty(process.execPath, [RK, "claude", ...args], env);
  await run.until("fake-claude ready");
  return { run, env, ...rest, pids: await readPids(path.join(dir, "pids.json")) };
}

test("rk_claude_runs_fake_and_returns_exit_code", async () => {
  await withTempDir(async (dir) => {
    const argvFile = path.join(dir, "argv.json");
    const { run } = await startRk(dir, {
      extra: { FAKE_ARGV_FILE: argvFile },
      args: ["--model", "haiku", "a b", "--flag=x"],
    });
    assert.deepEqual(readJson(argvFile), ["--model", "haiku", "a b", "--flag=x"], "args reach claude unchanged");
    // Typing passes through to the child and its output comes back.
    run.write("hello");
    await run.until("hello");
    run.write("\r");
    await run.until("reply: hello");
    run.write("/exit 7\r");
    assert.deepEqual(await run.exited, { code: 7, signal: null });
    // A clean exit is a clean exit.
    const second = await startRk(dir, { extra: { FAKE_PIDFILE: path.join(dir, "p2.json") } });
    second.run.write("/exit 0\r");
    assert.deepEqual(await second.run.exited, { code: 0, signal: null });
  });
});

test("signal_exit_maps_to_128_plus_n", async () => {
  for (const name of ["SIGKILL", "SIGTERM"]) {
    await withTempDir(async (dir) => {
      const { run } = await startRk(dir);
      run.write(`/signal ${name}\r`);
      assert.deepEqual(await run.exited, { code: 128 + SIG[name], signal: null }, name);
    });
  }
});

test("rk_codex_refuses_dash_c", async () => {
  for (const args of [["-c", "model=x"], ["--dangerously-bypass-hook-trust"], ["-cmodel=x"], ["--config", "a=b"], ["resume", "-c", "x"]]) {
    await withTempDir(async (dir) => {
      const argvFile = path.join(dir, "argv.json");
      const { env } = await rkEnv(dir, { FAKE_ARGV_FILE: argvFile });
      const run = inPty(process.execPath, [RK, "codex", ...args], env);
      const { code } = await run.exited;
      assert.equal(code, 2, JSON.stringify(args));
      assert.ok(
        run.out.includes(
          "rk codex: -c and --dangerously-bypass-hook-trust move Codex off the shared daemon; run plain codex for those.",
        ),
        run.out,
      );
      assert.equal(fs.existsSync(argvFile), false, "codex was never started");
    });
  }
});

/** A real hub over `dir`, for the tests that need agentd's side of the socket. */
async function withHub(dir, body) {
  const { env, sessionsDir, configDir } = await rkEnv(dir);
  const file = path.join(configDir, "attached.json");
  const make = () => {
    const registry = new AttachRegistry({ file, logger: silentLogger });
    return { registry, hub: new LauncherHub({ configDir, claudeSessionsDir: sessionsDir, logger: silentLogger, registry }) };
  };
  let current = make();
  await current.hub.start();
  try {
    await body({
      env,
      sessionsDir,
      get hub() {
        return current.hub;
      },
      get registry() {
        return current.registry;
      },
      restart: async () => {
        await current.hub.stop();
        current = make();
        current.registry.reconcileLaunchers();
        await current.hub.start();
      },
    });
  } finally {
    await current.hub.stop();
  }
}

async function startRkOn(env, dir, extra) {
  const full = { ...env, FAKE_PIDFILE: path.join(dir, "pids.json"), ...extra };
  const run = inPty(process.execPath, [RK, "claude"], full);
  await run.until("fake-claude ready");
  return { run, pids: await readPids(path.join(dir, "pids.json")) };
}

test("binds_owned_session_from_sessions_file", async () => {
  await withTempDir(async (dir) => {
    await withHub(dir, async (ctx) => {
      const { run, pids } = await startRkOn(ctx.env, dir, { FAKE_SESSION_ID: "sess-one", FAKE_NEXT_SESSION_ID: "sess-two" });
      const first = await until(() => ctx.hub.binding("claude:sess-one"), 5000, "the bind");
      assert.equal(first.childPid, pids.pid, "the launcher's child is the pty child");
      assert.equal(first.claudePid, pids.pid);
      assert.equal(ctx.registry.mode("claude", "sess-one"), "launcher");

      // /clear gives the same process a new session id; the 2 s poll rebinds.
      run.write("/clear\r");
      const second = await until(() => ctx.hub.binding("claude:sess-two"), 6000, "the rebind after /clear");
      assert.equal(second.launcherId, first.launcherId);
      assert.equal(ctx.hub.binding("claude:sess-one"), undefined, "the old id is released");

      run.write("/exit 0\r");
      await run.exited;
      await until(() => !ctx.hub.binding("claude:sess-two"), 3000, "release on exit");
      assert.equal(ctx.registry.mode("claude", "sess-two"), "plugin", "a closed launcher demotes to plugin");
    });
  });
});

test("banner_text_exact", async () => {
  await withTempDir(async (dir) => {
    await withHub(dir, async (ctx) => {
      const { run } = await startRkOn(ctx.env, dir, { FAKE_SESSION_ID: "sess-banner", FAKE_NEXT_SESSION_ID: "sess-banner-2" });
      await until(() => ctx.hub.binding("claude:sess-banner"), 5000, "the bind");
      await run.until(BANNER);
      assert.equal(run.out.includes(UNREACHABLE), false, "no unreachable notice when agentd answers");
      run.write("/clear\r");
      await until(() => ctx.hub.binding("claude:sess-banner-2"), 6000, "the rebind");
      assert.equal(run.out.split(BANNER).length - 1, 1, "the banner is printed once");
      run.write("/exit 0\r");
      await run.exited;
    });
  });
});

test("rebinds_after_agentd_restart", async () => {
  await withTempDir(async (dir) => {
    await withHub(dir, async (ctx) => {
      const { run } = await startRkOn(ctx.env, dir, { FAKE_SESSION_ID: "sess-restart" });
      await until(() => ctx.hub.binding("claude:sess-restart"), 5000, "the bind");
      await ctx.restart();
      assert.equal(ctx.hub.binding("claude:sess-restart"), undefined);
      await until(() => ctx.hub.binding("claude:sess-restart"), 8000, "reconnect and rebind");
      assert.equal(run.out.split(BANNER).length - 1, 1, "no second banner after a reconnect");
      run.write("/exit 0\r");
      await run.exited;
    });
  });
});

test("unreachable_agentd_prints_line_and_still_runs", async () => {
  await withTempDir(async (dir) => {
    const { run } = await startRk(dir);
    assert.ok(run.out.includes(UNREACHABLE), run.out);
    assert.equal(run.out.includes("Rokid-Coder launcher: attached"), false);
    run.write("hi\r");
    await run.until("reply: hi");
    run.write("/exit 3\r");
    assert.deepEqual(await run.exited, { code: 3, signal: null });
  });
});

/** Runs `body` with rk under a shell, so `stty -g` can be compared on the same pty. */
async function sttyScenario(dir, { rkArgs = ["claude"], preload, extra = {}, drive }) {
  const { env } = await rkEnv(dir, { FAKE_PIDFILE: path.join(dir, "pids.json"), ...extra });
  const flags = preload ? `--require "${preload}"` : "";
  const script = [
    `stty -g > "${dir}/before"`,
    // The terminal as rk leaves it while running: sampled mid-run to prove rk really changed it.
    `(sleep 0.7; stty -g < /dev/tty > "${dir}/mid") &`,
    `"${process.execPath}" ${flags} "${RK}" ${rkArgs.join(" ")}`,
    `echo $? > "${dir}/rc"`,
    `stty -g > "${dir}/after"`,
  ].join("\n");
  const run = inPty("/bin/sh", ["-c", script], env);
  await until(() => fs.existsSync(path.join(dir, "mid")), 8000, "the mid-run terminal sample");
  const pids = readJson(path.join(dir, "pids.json"));
  await drive(run, pids);
  await run.exited;
  const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").trim();
  return { before: read("before"), mid: read("mid"), after: read("after"), rc: Number(read("rc")), run, pids };
}

test("terminal_state_identical_after_exit_sigterm_sighup_and_throw", async () => {
  const scenarios = {
    exit: { drive: (run) => run.write("/exit 5\r"), rc: 5 },
    sigterm: { drive: (_run, pids) => process.kill(pids.ppid, "SIGTERM"), rc: 143 },
    sighup: { drive: (_run, pids) => process.kill(pids.ppid, "SIGHUP"), rc: 129 },
    throw: { throws: true, drive: () => {}, rc: 143 },
  };
  for (const [name, scenario] of Object.entries(scenarios)) {
    await withTempDir(async (dir) => {
      let preload;
      if (scenario.throws) {
        preload = path.join(dir, "throw.js");
        fs.writeFileSync(preload, `setTimeout(() => { throw new Error("boom"); }, 1500);`);
      }
      const result = await sttyScenario(dir, { preload, drive: scenario.drive });
      assert.notEqual(result.mid, result.before, `${name}: rk changes the terminal while it runs`);
      assert.equal(sttyState(result.after), sttyState(result.before), `${name}: stty -g is identical afterwards`);
      assert.equal(result.rc, scenario.rc, `${name}: exit status`);
      assert.ok(await waitDead(result.pids.pid).then(() => true), `${name}: the child is gone`);
      if (scenario.throws) {
        assert.ok(result.run.out.includes("rk: unexpected error: boom"), result.run.out);
      }
    });
  }
});

test("no_child_or_grandchild_left_after_sigterm", async () => {
  const variants = [
    { name: "all die on TERM", grandchild: "1", extra: {} },
    { name: "child ignores TERM until KILL", grandchild: "1", extra: { FAKE_IGNORE_SIGNALS: "1", ROKID_RK_KILL_AFTER_MS: "300" } },
    // The child exits on TERM at once; its grandchild ignores TERM and must still not be left.
    { name: "grandchild ignores TERM", grandchild: "stubborn", extra: {} },
  ];
  for (const { name, grandchild, extra } of variants) {
    await withTempDir(async (dir) => {
      const { run, pids } = await startRk(dir, { extra: { FAKE_GRANDCHILD: grandchild, ...extra } });
      assert.ok(alive(pids.pid) && alive(pids.grandchild), "both run before the signal");
      process.kill(pids.ppid, "SIGTERM");
      assert.deepEqual(await run.exited, { code: 143, signal: null });
      assert.ok(await waitDead(pids.pid).then(() => true), `${name}: child gone`);
      assert.ok(await waitDead(pids.grandchild).then(() => true), `${name}: grandchild gone`);
    });
  }
});

test("spawn_failure_exit_127_and_terminal_restored", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir, { ROKID_RK_CLAUDE_BIN: path.join(dir, "no-such-claude") });
    const script = [
      `stty -g > "${dir}/before"`,
      `"${process.execPath}" "${RK}" claude --model haiku`,
      `echo $? > "${dir}/rc"`,
      `stty -g > "${dir}/after"`,
    ].join("\n");
    const run = inPty("/bin/sh", ["-c", script], env);
    await run.exited;
    const read = (name) => fs.readFileSync(path.join(dir, name), "utf8").trim();
    assert.equal(read("rc"), "127");
    assert.equal(sttyState(read("after")), sttyState(read("before")));
    assert.ok(run.out.includes("rk: could not start claude: "), run.out);
  });
});

/** rk on plain pipes, so closing stdin is a real EOF. */
function rkOnPipes(env) {
  const child = spawn(process.execPath, [RK, "claude"], { env, stdio: ["pipe", "pipe", "pipe"] });
  const run = { child, out: "" };
  child.stdout.on("data", (chunk) => (run.out += chunk));
  child.stderr.on("data", (chunk) => (run.out += chunk));
  run.exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  run.until = (pattern) => until(() => run.out.includes(pattern), 5000, pattern);
  return run;
}

test("stdin_eof_ends_child_and_reaps", async () => {
  const cases = [
    { name: "child exits on EOF", extra: { FAKE_EXIT_ON_EOT: "1" }, expect: { code: 0, signal: null } },
    {
      name: "child ignores EOF, then dies of SIGHUP",
      extra: { ROKID_RK_EOF_WAIT_MS: "300" },
      expect: { code: 128 + SIG.SIGHUP, signal: null },
    },
    {
      name: "child ignores EOF and HUP, then is killed",
      extra: { FAKE_IGNORE_SIGNALS: "1", ROKID_RK_EOF_WAIT_MS: "200", ROKID_RK_KILL_AFTER_MS: "300" },
      expect: { code: 128 + SIG.SIGKILL, signal: null },
    },
  ];
  for (const c of cases) {
    await withTempDir(async (dir) => {
      const { env } = await rkEnv(dir, { FAKE_GRANDCHILD: "1", FAKE_PIDFILE: path.join(dir, "pids.json"), ...c.extra });
      const run = rkOnPipes(env);
      await run.until("fake-claude ready");
      const pids = await readPids(path.join(dir, "pids.json"));
      run.child.stdin.end();
      assert.deepEqual(await run.exited, c.expect, c.name);
      assert.ok(await waitDead(pids.pid).then(() => true), `${c.name}: child reaped`);
      assert.ok(await waitDead(pids.grandchild).then(() => true), `${c.name}: grandchild gone`);
    });
  }
});

test("ctrl_z_and_ctrl_c_bytes_pass_through_to_the_child", async () => {
  await withTempDir(async (dir) => {
    const { run } = await startRk(dir);
    run.write("\x1a");
    await run.until("^Z");
    run.write("abc\x03");
    await run.until("^C");
    run.write("ok\r");
    await run.until("reply: ok");
    assert.equal(run.exit, undefined, "rk is still running after both bytes");
    run.write("/exit 0\r");
    await run.exited;
  });
});

test("postinstall_sets_exec_bit_on_agentds_own_spawn_helper", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("the macOS spawn-helper only");
    return;
  }
  await withTempDir(async (dir) => {
    const scripts = path.join(dir, "scripts");
    fs.mkdirSync(scripts);
    fs.copyFileSync(path.join(__dirname, "..", "scripts", "postinstall.js"), path.join(scripts, "postinstall.js"));
    const helper = path.join(dir, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "#!/bin/sh\n", { mode: 0o644 });
    const other = path.join(dir, "..", `rk-postinstall-other-${process.pid}`);
    fs.writeFileSync(other, "x", { mode: 0o644 });
    try {
      await new Promise((resolve, reject) =>
        spawn(process.execPath, [path.join(scripts, "postinstall.js")], { stdio: "ignore" }).once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`postinstall exited ${code}`)),
        ),
      );
      assert.equal(fs.statSync(helper).mode & 0o111, 0o111, "exec bit set");
      assert.equal(fs.statSync(other).mode & 0o111, 0, "nothing outside node_modules is touched");
    } finally {
      fs.rmSync(other, { force: true });
    }
  });
});

test("restore_terminal_resets_stty_and_escapes_and_is_idempotent", async () => {
  await withTempDir(async (dir) => {
    const { env } = await rkEnv(dir);
    const script = path.join(dir, "restore.js");
    const terminal = path.join(__dirname, "..", "dist", "launcher", "terminal.js");
    fs.writeFileSync(
      script,
      `const { execFileSync } = require("node:child_process");
       const { saveTerminal, restoreTerminal } = require(${JSON.stringify(terminal)});
       const read = () => execFileSync("stty", ["-g"], { stdio: ["inherit", "pipe", "inherit"], encoding: "utf8" }).trim();
       const before = read();
       const saved = saveTerminal();
       execFileSync("stty", ["raw", "-echo"], { stdio: "inherit" });
       const raw = read();
       restoreTerminal(saved);
       const once = read();
       restoreTerminal(saved);
       restoreTerminal(undefined);
       require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "result.json"))},
         JSON.stringify({ saved, before, raw, once, twice: read() }));`,
    );
    const run = inPty(process.execPath, [script], env);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    const result = readJson(path.join(dir, "result.json"));
    assert.equal(result.saved, result.before, "saveTerminal returns stty -g");
    assert.notEqual(result.raw, result.before);
    assert.equal(sttyState(result.once), sttyState(result.before));
    assert.equal(sttyState(result.twice), sttyState(result.before));
    assert.ok(run.out.includes("\x1b[?25h\x1b[?2004l"), "cursor shown and bracketed paste off");
  });
  // Not a TTY: nothing to save, and restoring undefined writes no stty.
  const { saveTerminal, restoreTerminal } = require("../dist/launcher/terminal.js");
  if (!process.stdin.isTTY) {
    assert.equal(saveTerminal(), undefined);
    assert.doesNotThrow(() => restoreTerminal(undefined));
  }
});
