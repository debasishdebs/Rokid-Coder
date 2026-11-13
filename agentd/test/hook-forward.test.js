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
  const pluginBin = path.resolve(__dirname, "..", "..", "plugins", "claude-code", "bin", "hook-forward.js");
  assert.equal(
    fs.readFileSync(pluginBin, "utf8"),
    fs.readFileSync(forwarderPath, "utf8"),
    "plugins/claude-code/bin/hook-forward.js is stale; run npm run build",
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
