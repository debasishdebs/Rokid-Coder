// The contract of the fake claude CLI that the launcher tests (Tasks 2 to 4) rely on.
const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const { FAKE_CLAUDE, until, rkEnv, inPty, killLive, readJson } = require("./helpers/rk.js");

afterEach(killLive);

async function startFake(dir, extra = {}) {
  const { env, sessionsDir } = await rkEnv(dir, {
    FAKE_SESSION_ID: "fake-session",
    FAKE_STATE_FILE: path.join(dir, "state.json"),
    FAKE_PIDFILE: path.join(dir, "pids.json"),
    FAKE_INPUT_ACK_FILE: path.join(dir, "consumed"),
    ...extra,
  });
  const run = inPty(FAKE_CLAUDE, [], env);
  await run.until("fake-claude ready");
  const { pid } = await until(() => readJson(path.join(dir, "pids.json")), 5000, "pid file");
  const sessionFile = path.join(sessionsDir, `${pid}.json`);
  const session = () => readJson(sessionFile);
  // Input and SIGUSR2 race each other: the dump waits until the fake has
  // processed every key written so far.
  let written = 0;
  const write = (data) => {
    written += data.length;
    run.write(data);
  };
  const consumed = () => {
    try {
      return Number(fs.readFileSync(path.join(dir, "consumed"), "utf8"));
    } catch {
      return 0;
    }
  };
  const dump = async () => {
    await until(() => consumed() >= written, 3000, `the fake to process ${written} input chars`);
    fs.rmSync(path.join(dir, "state.json"), { force: true });
    process.kill(pid, "SIGUSR2");
    return until(() => readJson(path.join(dir, "state.json")), 3000, "the SIGUSR2 state dump");
  };
  return { run, pid, session, dump, write, sessionFile };
}

test("fake_edits_a_prompt_line_and_dumps_state_on_sigusr2", async () => {
  await withTempDir(async (dir) => {
    const fake = await startFake(dir);
    fake.write("abx\x7fc");
    assert.equal((await fake.dump()).line, "abc", "typed keys fill the line; Backspace removes one");
    fake.write("\x15");
    assert.equal((await fake.dump()).line, "", "Ctrl-U clears it");
    fake.write("\x1b[200~multi\rline\x1b[201~");
    assert.equal((await fake.dump()).line, "multi\nline", "a bracketed paste inserts text and does not submit");
    fake.write("\x03");
    assert.equal((await fake.dump()).line, "", "Ctrl-C clears it");
    fake.write("first\r");
    await fake.run.until("reply: first");
    fake.write("\x1b[A");
    assert.equal((await fake.dump()).line, "first", "Up recalls the last submitted line");
    const state = await fake.dump();
    assert.deepEqual({ dialogOpen: state.dialogOpen, model: state.model }, { dialogOpen: false, model: "opus" });
    fake.write("\x15/exit 0\r");
    await fake.run.exited;
    assert.equal(fs.existsSync(fake.sessionFile), false, "the sessions file goes with the process");
  });
});

test("fake_writes_sessions_file_with_status_and_increasing_statusUpdatedAt", async () => {
  await withTempDir(async (dir) => {
    const fake = await startFake(dir, { FAKE_BUSY_MS: "400" });
    const idle = fake.session();
    assert.equal(idle.sessionId, "fake-session");
    assert.equal(idle.status, "idle");
    assert.equal(idle.pid, fake.pid);
    fake.write("work\r");
    await until(() => fake.session().status === "busy", 2000, "busy");
    const busy = fake.session();
    assert.ok(busy.statusUpdatedAt > idle.statusUpdatedAt);
    const outputBefore = fake.run.out.length;
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fake.run.out.length, outputBefore, "no output while busy");
    await until(() => fake.session().status === "idle", 3000, "idle again");
    assert.ok(fake.session().statusUpdatedAt > busy.statusUpdatedAt);
    await fake.run.until("reply: work");
    fake.write("/exit 0\r");
    await fake.run.exited;
  });
});

test("fake_model_dialog_confirm_and_escape", async () => {
  await withTempDir(async (dir) => {
    const fake = await startFake(dir);
    fake.write("/model sonnet\r");
    await fake.run.until("Switch model?");
    assert.deepEqual(
      { open: (await fake.dump()).dialogOpen, status: fake.session().status },
      { open: true, status: "busy" },
      "the dialog is open and the file reads busy",
    );
    fake.write("\x1b");
    let state = await fake.dump();
    assert.deepEqual({ open: state.dialogOpen, model: state.model, line: state.line }, { open: false, model: "opus", line: "" });
    assert.equal(fake.session().status, "idle");

    fake.write("/model haiku\r");
    await until(() => fake.run.out.split("Switch model?").length === 3, 3000, "the second dialog");
    fake.write("\r");
    await fake.run.until("Set model to haiku");
    state = await fake.dump();
    assert.deepEqual({ open: state.dialogOpen, model: state.model }, { open: false, model: "haiku" });
    assert.equal(fake.session().status, "idle");
    fake.write("/exit 0\r");
    await fake.run.exited;
  });
});

test("fake_no_dialog_prints_nothing_for_model", async () => {
  await withTempDir(async (dir) => {
    const fake = await startFake(dir, { FAKE_NO_DIALOG: "1" });
    const before = fake.run.out.length;
    fake.write("/model sonnet\r");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fake.run.out.slice(before).includes("Switch model?"), false);
    const state = await fake.dump();
    assert.deepEqual({ open: state.dialogOpen, model: state.model, line: state.line }, { open: false, model: "opus", line: "" });
    fake.write("/exit 0\r");
    await fake.run.exited;
  });
});

test("fake_compact_sends_pre_and_post_compact_through_hook_forward", async () => {
  const hooks = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      hooks.push({ url: request.url, provider: request.headers["x-rokid-provider"], body: JSON.parse(body) });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await withTempDir(async (dir) => {
      const fake = await startFake(dir, { NEXUS_AGENTD_HTTP_PORT: String(server.address().port) });
      fake.write("/compact\r");
      await until(() => fake.session().status === "busy", 2000, "busy during compact");
      await until(() => fake.session().status === "idle" && hooks.length === 2, 5000, "idle after both hooks");
      assert.deepEqual(
        hooks.map((h) => [h.url, h.provider, h.body.hook_event_name, h.body.session_id]),
        [
          ["/hook", "claude", "PreCompact", "fake-session"],
          ["/hook", "claude", "PostCompact", "fake-session"],
        ],
      );
      await fake.run.until("Compacted");
      fake.write("/exit 0\r");
      await fake.run.exited;
    });
  } finally {
    server.close();
  }
});
