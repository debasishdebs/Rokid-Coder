const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { spawnPty } = require("../dist/launcher/pty.js");

const BASE = { cwd: os.tmpdir(), env: { ...process.env, TERM: "xterm" }, cols: 100, rows: 40 };

function collect(child) {
  const state = { out: "", waiters: [] };
  child.onData((chunk) => {
    state.out += chunk;
    state.waiters = state.waiters.filter((w) => !w.check());
  });
  state.until = (pattern, ms = 5000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (state.out.includes(pattern)) {
          resolve(state.out);
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${JSON.stringify(pattern)}; saw ${JSON.stringify(state.out)}`)),
        ms,
      );
      state.waiters.push({
        check: () => {
          const done = check();
          if (done) clearTimeout(timer);
          return done;
        },
      });
    });
  return state;
}

function exited(child) {
  return new Promise((resolve) => child.onExit((code, signal) => resolve({ code, signal })));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitDead(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

test("pty_echoes_child_output", async () => {
  const child = spawnPty("/bin/sh", ["-c", "printf ready; read x; printf got:$x"], BASE);
  const done = exited(child);
  const seen = collect(child);
  assert.ok(child.pid > 0);
  await seen.until("ready");
  child.write("hi\r");
  await seen.until("got:hi");
  assert.deepEqual(await done, { code: 0, signal: null });
});

test("pty_reports_exit_code_and_signal", async () => {
  const withCode = spawnPty("/bin/sh", ["-c", "exit 7"], BASE);
  assert.deepEqual(await exited(withCode), { code: 7, signal: null });

  const killed = spawnPty("/bin/sh", ["-c", "kill -TERM $$; sleep 5"], BASE);
  assert.deepEqual(await exited(killed), { code: null, signal: "SIGTERM" });
});

test("pty_resize_reaches_child", async () => {
  const child = spawnPty("/bin/sh", ["-c", "read x; stty size; read y; stty size"], BASE);
  const done = exited(child);
  const seen = collect(child);
  child.write("\r");
  await seen.until("40 100");
  child.resize(120, 33);
  child.write("\r");
  await seen.until("33 120");
  await done;
});

test("pty_end_input_sends_tty_eof", async () => {
  const child = spawnPty("/bin/sh", ["-c", "cat >/dev/null; printf eof-seen"], BASE);
  const done = exited(child);
  const seen = collect(child);
  child.endInput();
  await seen.until("eof-seen");
  assert.deepEqual(await done, { code: 0, signal: null });
});

test("pty_kill_signals_process_group", async () => {
  const child = spawnPty("/bin/sh", ["-c", "sleep 60 & echo gc:$!; wait"], BASE);
  const done = exited(child);
  const seen = collect(child);
  const out = await seen.until("gc:");
  const grandchild = Number(/gc:(\d+)/.exec(out)[1]);
  assert.ok(alive(grandchild), "grandchild should be running before kill");
  child.kill();
  await done;
  assert.ok(await waitDead(grandchild), "grandchild should die with the group");
  assert.ok(await waitDead(child.pid), "child should be gone");
});

test("pty_kill_after_exit_is_harmless", async () => {
  const child = spawnPty("/bin/sh", ["-c", "exit 0"], BASE);
  await exited(child);
  assert.doesNotThrow(() => child.kill());
  assert.doesNotThrow(() => child.write("late"));
});
