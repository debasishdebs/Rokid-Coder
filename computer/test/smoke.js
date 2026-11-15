const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { ensureConfig, saveConfig } = require("../dist/config.js");
const { PinStore } = require("../dist/tls.js");
const { freePort } = require("./helpers/daemon.js");
const { phoneCert } = require("./helpers/tls.js");

const projectRoot = path.resolve(__dirname, "..");

function health(httpPort) {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${httpPort}/health`, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(response.statusCode === 200 ? JSON.parse(body) : undefined);
        } catch {
          resolve(undefined);
        }
      });
    });
    request.setTimeout(250, () => {
      request.destroy();
      resolve(undefined);
    });
    request.on("error", () => resolve(undefined));
  });
}

/**
 * Healthy, and answered by this child: it prints its listening line only once
 * it holds `httpPort`, so a health reply before that may be another daemon's.
 */
async function waitForDaemon(child, output, httpPort) {
  const deadline = Date.now() + 8000;
  const listening = `nexus-agentd listening on 127.0.0.1:${httpPort} `;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`daemon exited early with code ${child.exitCode}`);
    }
    if (output().includes(listening)) {
      const response = await health(httpPort);
      if (response?.ok) return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("daemon did not become healthy");
}

function postWithCurl(httpPort, payload, expected = "{}") {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const result = spawnSync(
    curl,
    [
      "--silent",
      "--show-error",
      "--fail",
      "--header",
      "content-type: application/json",
      "--data-binary",
      JSON.stringify(payload),
      `http://127.0.0.1:${httpPort}/hook`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || "curl failed");
  // `expected` null: the caller reads the reply itself.
  if (expected !== null) assert.equal(result.stdout, expected);
  return result.stdout;
}

function waitForFrame(frames, predicate, timeoutMs = 5000) {
  const existing = frames.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for smoke WS frame")), timeoutMs);
    frames.waiters.push((frame) => {
      if (predicate(frame)) {
        clearTimeout(timer);
        resolve(frame);
        return true;
      }
      return false;
    });
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

async function main() {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "nexus-agentd-smoke-"));
  const stateDir = path.join(tempDir, "state");
  const claudeDir = path.join(tempDir, "claude");
  const coderDir = path.join(tempDir, "rokid-coder");
  const transcriptPath = path.join(tempDir, "smoke-session.jsonl");
  await fsp.mkdir(path.join(claudeDir, "projects"), { recursive: true });
  await fsp.writeFile(
    transcriptPath,
    '{"type":"system","timestamp":"2026-07-24T10:00:00.000Z","cwd":"E:/smoke/project"}\n',
  );

  // Never the default ports: a real daemon may hold them, and hooks posted
  // there would land in its state.
  const httpPort = await freePort();
  const wsPort = await freePort();
  saveConfig({
    ...ensureConfig(stateDir),
    httpPort,
    wsPort,
    phoneHosts: [],
    tailnetDiscovery: false,
    rokidCoder: { stateDir: coderDir },
  }, stateDir);

  // A phone paired earlier: pinned before agentd starts, since while it runs it is the only pin writer (R208).
  const tlsDir = path.join(coderDir, "tls");
  const phone = await phoneCert("smoke-phone");
  new PinStore(path.join(tlsDir, "phone-pins.json")).add(phone.fingerprint256);

  const child = spawn(process.execPath, [path.join(projectRoot, "dist", "cli.js"), "run"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: tempDir,
      NEXUS_AGENTD_STATE_DIR: stateDir,
      NEXUS_AGENTD_CLAUDE_DIR: claudeDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on("data", (chunk) => { childOutput += chunk.toString(); });
  let socket;

  try {
    await waitForDaemon(child, () => childOutput, httpPort);
    const config = JSON.parse(
      fs.readFileSync(path.join(stateDir, "config.json"), "utf8"),
    );
    const base = {
      session_id: "smoke-session",
      transcript_path: transcriptPath,
      cwd: "E:/smoke/project",
    };
    // Hooks of a session nobody opted in leave no trace, so it is attached the
    // way the plugin's /rokid:on does: UserPromptExpansion, answered with a block.
    const attached = JSON.parse(
      postWithCurl(httpPort, { ...base, hook_event_name: "UserPromptExpansion", command_name: "rokid:on" }, null),
    );
    assert.equal(attached.decision, "block");
    assert.match(attached.reason, /^Attached to Rokid-Coder/);
    postWithCurl(httpPort, { ...base, hook_event_name: "SessionStart", source: "startup" });

    // The phone port is wss only, and admits a pinned client cert with the steering secret.
    const steer = fs.readFileSync(path.join(tlsDir, "steer.secret"), "utf8").trim();
    socket = new WebSocket(`wss://127.0.0.1:${wsPort}`, { rejectUnauthorized: false, key: phone.key, cert: phone.cert });
    const frames = [];
    frames.waiters = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      frames.waiters = frames.waiters.filter((waiter) => !waiter(frame));
      if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", t: frame.t }));
      }
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({
      type: "hello",
      v: 1,
      token: config.token,
      steer,
      client: { name: "plugin-agents", version: "smoke" },
    }));
    const helloAck = await waitForFrame(frames, (frame) => frame.type === "hello_ack");
    const snapshot = await waitForFrame(frames, (frame) => frame.type === "snapshot");

    postWithCurl(httpPort, {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "Smoke-test the monitor",
    });
    const upsert = await waitForFrame(frames, (frame) => frame.type === "session_upsert");

    assert.equal(helloAck.v, 1);
    assert.equal(helloAck.steering, true);
    assert.equal(snapshot.sessions.some((session) => session.id === "smoke-session"), true);
    assert.equal(upsert.session.status, "working");
    assert.equal(upsert.seq, snapshot.seq + 1);
    // There is deliberately no linked phone in this smoke test. A blocking
    // permission hook must therefore return immediately with no decision so
    // Claude Code can show its own local prompt.
    postWithCurl(httpPort, {
      ...base,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: "smoke-tool-use",
      tool_input: { command: "npm test", description: "Run tests" },
    });
    for (const frame of [helloAck, snapshot, upsert]) {
      process.stdout.write(`${JSON.stringify(frame)}\n`);
    }
    process.stdout.write("Smoke test passed\n");
  } catch (error) {
    if (childOutput) process.stderr.write(childOutput);
    throw error;
  } finally {
    socket?.terminate();
    await stopChild(child);
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
