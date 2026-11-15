const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const forwarderPath = path.resolve(__dirname, "..", "dist", "hook-forward.js");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runForwarder(port, payload, timeoutMs = "500", options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.script ?? forwarderPath], {
      cwd: options.cwd,
      env: {
        ...process.env,
        NEXUS_AGENTD_HTTP_PORT: String(port),
        NEXUS_AGENTD_APPROVAL_TIMEOUT_MS: timeoutMs,
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test("hook forwarder waits for and prints a decision, but stays silent for local fallback", async () => {
  let responseBody = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
  const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      setTimeout(() => {
        const body = JSON.stringify(responseBody);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
      }, 40);
    });
  });
  const port = await listen(server);
  try {
    const startedAt = Date.now();
    const decided = await runForwarder(port, bashPayload());
    assert.equal(decided.code, 0);
    assert.equal(decided.stderr, "");
    assert.ok(Date.now() - startedAt >= 30);
    assert.deepEqual(JSON.parse(decided.stdout), responseBody);

    responseBody = {};
    const local = await runForwarder(port, bashPayload());
    assert.deepEqual(local, { code: 0, stdout: "", stderr: "" });
  } finally {
    await close(server);
  }
});

test("hook forwarder falls through silently when the daemon is unavailable", async () => {
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  assert.deepEqual(
    await runForwarder(port, bashPayload()),
    { code: 0, stdout: "", stderr: "" },
  );
});

// The plugins carry a copy of this file with nothing installed beside it, so any
// relative require would crash it the first time Claude Code runs a hook.
test("forwarder_has_no_relative_requires", () => {
  const source = fs.readFileSync(forwarderPath, "utf8");
  assert.equal(/require\(["']\./.test(source), false, "dist/hook-forward.js requires a relative module");
  const required = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  assert.ok(required.length > 0);
  for (const name of required) {
    assert.match(name, /^node:/, `${name} is not a node: built-in`);
  }
});

test("plugin_bin_runs_standalone_and_sends_provider_header", async () => {
  const pluginBin = path.resolve(__dirname, "..", "..", "plugin", "claude-code", "bin", "hook-forward.js");
  assert.equal(
    fs.readFileSync(pluginBin, "utf8"),
    fs.readFileSync(forwarderPath, "utf8"),
    "plugin/claude-code/bin/hook-forward.js is stale; run npm run build",
  );
  const seen = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
      seen.push({ url: request.url, provider: request.headers["x-rokid-provider"], body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ decision: "block", reason: "from daemon" }));
    });
  });
  const port = await listen(server);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-forwarder-"));
  try {
    // Run a copy from an empty directory: no node_modules, no sibling modules.
    const copy = path.join(dir, "hook-forward.js");
    fs.copyFileSync(pluginBin, copy);
    const result = await runForwarder(port, bashPayload(), "500", {
      script: copy,
      cwd: dir,
      env: { ROKID_CODER_PROVIDER: "claude" },
    });
    assert.deepEqual({ code: result.code, stderr: result.stderr }, { code: 0, stderr: "" });
    assert.deepEqual(JSON.parse(result.stdout), { decision: "block", reason: "from daemon" });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/hook");
    assert.equal(seen[0].provider, "claude");
    assert.equal(JSON.parse(seen[0].body).session_id, "forwarder-session");

    // Without the variable no provider header is sent.
    await runForwarder(port, bashPayload(), "500", { script: copy, cwd: dir, env: { ROKID_CODER_PROVIDER: "" } });
    assert.equal(seen[1].provider, undefined);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("explicit deadline overrides the approval timeout", async () => {
  // The daemon never answers; the forwarder must give up at its own deadline.
  const server = http.createServer((request) => { request.resume(); });
  const port = await listen(server);
  try {
    const startedAt = Date.now();
    const result = await runForwarder(port, bashPayload(), "60000", {
      env: { ROKID_CODER_HOOK_DEADLINE_MS: "300" },
    });
    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.ok(Date.now() - startedAt < 5000, "gave up at the explicit deadline, not 60 s + 5 s");
  } finally {
    server.closeAllConnections();
    await close(server);
  }
});

function bashPayload() {
  return {
    hook_event_name: "PreToolUse",
    session_id: "forwarder-session",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
  };
}

// R156/M6: the pairing window is asked for only over a socket provably this user's.
test("arm_pairing_only_over_a_launcher_socket_in_a_private_dir_of_ours", async () => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ decision: "block", reason: "Pairing window open" }));
    });
  });
  const port = await listen(server);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rk-arm-"));
  const asked = [];
  const sockServer = require("node:net").createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      asked.push(chunk);
      socket.end('{"type":"pairing_armed","ok":true}\n');
    });
    socket.on("error", () => {});
  });
  try {
    const dir = path.join(root, "rc");
    fs.mkdirSync(dir, { mode: 0o700 });
    await new Promise((resolve) => sockServer.listen(path.join(dir, "launcher.sock"), resolve));
    const pair = { hook_event_name: "UserPromptExpansion", command_name: "rokid:pair", session_id: "s" };
    const env = { env: { ROKID_CODER_PROVIDER: "claude", ROKID_RK_CONFIG_DIR: dir } };
    fs.chmodSync(dir, 0o700);
    const ours = await runForwarder(port, pair, "500", env);
    assert.deepEqual(JSON.parse(ours.stdout), { decision: "block", reason: "Pairing window open" });
    assert.equal(asked.length, 1, "a private dir of ours is asked");
    // A dir open to others is not provably ours: its socket is never connected to.
    fs.chmodSync(dir, 0o755);
    const loose = await runForwarder(port, pair, "500", env);
    assert.deepEqual(JSON.parse(loose.stdout), { decision: "block", reason: 'Run "agentd phones allow-next" in a terminal' });
    assert.equal(asked.length, 1, "the loose dir's socket was never asked");
  } finally {
    await new Promise((resolve) => sockServer.close(resolve));
    await close(server);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rokid_pair_and_status_with_agentd_down_say_start_it", async () => {
  // A port nothing listens on: agentd is down.
  const server = http.createServer();
  const port = await listen(server);
  await close(server);
  const expansion = (name) => ({ hook_event_name: "UserPromptExpansion", command_name: `rokid:${name}`, session_id: "s" });
  const codex = (prompt) => ({ hook_event_name: "UserPromptSubmit", prompt, session_id: "t" });
  // rokid:pair first tries agentd's launcher socket: point it at an empty dir, never the real one.
  const noSocket = fs.mkdtempSync(path.join(os.tmpdir(), "rk-nosock-"));
  const claudeEnv = { env: { ROKID_CODER_PROVIDER: "claude", ROKID_RK_CONFIG_DIR: noSocket } };
  const codexEnv = { env: { ROKID_CODER_PROVIDER: "codex", ROKID_RK_CONFIG_DIR: noSocket } };
  const pair = await runForwarder(port, expansion("pair"), "500", claudeEnv);
  assert.deepEqual(JSON.parse(pair.stdout), { decision: "block", reason: 'agentd isn\'t running — run "agentd run" in a terminal' });
  const codexPair = await runForwarder(port, codex(" rokid:pair\n"), "500", codexEnv);
  assert.deepEqual(JSON.parse(codexPair.stdout), JSON.parse(pair.stdout));
  const status = JSON.parse((await runForwarder(port, expansion("status"), "500", claudeEnv)).stdout);
  assert.match(status.reason, /agentd isn't running[\s\S]*agentd run/);
  // Anything else stays silent, as before.
  assert.equal((await runForwarder(port, expansion("on"), "500", claudeEnv)).stdout, "");
  assert.equal((await runForwarder(port, codex("please rokid:pair"), "500", codexEnv)).stdout, "");
  assert.equal((await runForwarder(port, expansion("pair"), "500", codexEnv)).stdout, "", "a Codex hook is read as Codex");
  fs.rmSync(noSocket, { recursive: true, force: true });
});
