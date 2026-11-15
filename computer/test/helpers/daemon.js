const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { ensureConfig, saveConfig } = require("../../dist/config.js");
const { startDaemon } = require("../../dist/daemon.js");
const { PinStore } = require("../../dist/tls.js");
const { createFakePhone } = require("../fake-phone.js");
const { agentCert, phoneCert, seedAgentCert } = require("./tls.js");

async function withTempDir(body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rokid-coder-test-"));
  try {
    await body(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

const handedOut = new Set();

function probeFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * A port nothing listens on. The kernel may hand a just-closed port to the
 * next caller, so a port this process gave out before is not given again
 * (up to 5 draws): two daemons starting together would collide on it.
 */
async function freePort() {
  let port;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    port = await probeFreePort();
    if (!handedOut.has(port)) break;
  }
  handedOut.add(port);
  return port;
}

// Daemons read their state dirs from the process environment as they start, so
// concurrent withDaemon calls take turns through the start, and the last one
// out restores the environment.
let envHolders = 0;
let envSaved;
let startTurn = Promise.resolve();

function holdEnv() {
  if (envHolders === 0) {
    envSaved = { state: process.env.NEXUS_AGENTD_STATE_DIR, claude: process.env.NEXUS_AGENTD_CLAUDE_DIR };
  }
  envHolders += 1;
}

function releaseEnv() {
  envHolders -= 1;
  if (envHolders > 0) return;
  for (const [key, value] of [["NEXUS_AGENTD_STATE_DIR", envSaved.state], ["NEXUS_AGENTD_CLAUDE_DIR", envSaved.claude]]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Starts the daemon on fresh ports, retrying up to 5 times when a port turns
 * out to be taken after all (another process drew it between probe and bind).
 */
async function startOnFreePorts({ base, stateDir, coderDir, claudeDir, phoneHosts }) {
  const previous = startTurn;
  let done;
  startTurn = new Promise((resolve) => { done = resolve; });
  await previous;
  try {
    for (let attempt = 1; ; attempt += 1) {
      const httpPort = await freePort();
      const wsPort = await freePort();
      const discoveryPort = await freePort();
      saveConfig({
        ...base,
        httpPort,
        wsPort,
        phoneHosts,
        tailnetDiscovery: false,
        rokidCoder: { stateDir: coderDir },
      }, stateDir);
      process.env.NEXUS_AGENTD_STATE_DIR = stateDir;
      process.env.NEXUS_AGENTD_CLAUDE_DIR = claudeDir;
      try {
        return { daemon: await startDaemon({ discoveryPort }), httpPort, wsPort };
      } catch (error) {
        if (error?.code !== "EADDRINUSE" || attempt >= 5) throw error;
      }
    }
  } finally {
    done();
  }
}

function postHook(port, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/hook",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve(JSON.parse(text)));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function transcriptLine(sessionId) {
  return `${JSON.stringify({
    type: "user",
    sessionId,
    cwd: "/work/demo",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "hello" },
  })}\n`;
}

/**
 * Boots the real daemon against temp state with a fake phone on `transport`.
 * `discovered` Claude sessions are written under a temp ~/.claude/projects.
 * The phone link is real TLS, pinned both ways: agentd pins the fake phone's
 * cert on its first hello inside a pairing window opened here, as `pair` would
 * (phonelink), or the fake phone's cert is pinned before it dials (wshub, see
 * `pinFakePhone`), and the fake pins agentd's cert. `tls: false` is a
 * plaintext phone, which agentd refuses, so no snapshot is waited for.
 * The daemon's agentd cert is the one shared test cert, copied into its tls dir. `coderFiles` pre-seeds files in
 * the Rokid-Coder state dir (name -> JSON value), such as settings.json.
 */
async function withDaemon({ transport, tls = true, attached = [], discovered = [], coderFiles = {}, paired = false }, body) {
  await withTempDir(async (dir) => {
    const stateDir = path.join(dir, "nexus-agentd");
    const coderDir = path.join(dir, "rokid-coder");
    const claudeDir = path.join(dir, "claude");
    const project = path.join(claudeDir, "projects", "-work-demo");
    await fsp.mkdir(project, { recursive: true });
    for (const id of discovered) {
      await fsp.writeFile(path.join(project, `${id}.jsonl`), transcriptLine(id));
    }
    await fsp.mkdir(coderDir, { recursive: true });
    await fsp.writeFile(
      path.join(coderDir, "attached.json"),
      JSON.stringify({
        version: 1,
        entries: attached.map((entry) => ({ ...entry, mode: "plugin", attachedAt: 1 })),
      }),
    );

    for (const [name, content] of Object.entries(coderFiles)) {
      await fsp.mkdir(path.dirname(path.join(coderDir, name)), { recursive: true });
      await fsp.writeFile(path.join(coderDir, name), JSON.stringify(content));
    }

    await seedAgentCert(path.join(coderDir, "tls"));
    if (paired) {
      // A phone paired earlier. The dialled link checks pins, so this suits wshub only.
      new PinStore(path.join(coderDir, "tls", "phone-pins.json")).add("CD".repeat(32));
    }
    const agent = await agentCert();
    const phone = createFakePhone({ transport, tls, pin: agent.fingerprint256, cert: tls ? await phoneCert("phone") : undefined });
    if (tls) {
      pinFakePhone({ coderDir, phone }, { arm: transport === "phonelink" });
    }
    const base = ensureConfig(stateDir);
    let phonePort;
    if (transport === "phonelink") {
      phonePort = (await phone.start({ token: base.token })).port;
    }

    holdEnv();
    let daemon;
    try {
      const started = await startOnFreePorts({
        base,
        stateDir,
        coderDir,
        claudeDir,
        phoneHosts: transport === "phonelink" ? [`127.0.0.1:${phonePort}`] : [],
      });
      daemon = started.daemon;
      const { httpPort, wsPort } = started;
      // The steering secret the daemon made; a wss phone sends it to steer.
      const steer = (await fsp.readFile(path.join(coderDir, "tls", "steer.secret"), "utf8")).trim();
      if (tls) phone.steer = steer;
      if (transport === "wshub") {
        await phone.start({ port: wsPort, host: "127.0.0.1", token: base.token });
      }
      if (tls) {
        await phone.waitFor("snapshot");
      }
      await body({ daemon, phone, pins: new PinStore(path.join(coderDir, "tls", "phone-pins.json")), httpPort, wsPort, token: base.token, coderDir, claudeDir, steer, agentFingerprint: agent.fingerprint256 });
    } finally {
      phone.close();
      await daemon?.stop();
      releaseEnv();
    }
  });
}

/**
 * Makes the fake phone's cert one agentd trusts: pinned outright, as a phone
 * paired earlier, or (`arm`) with the pairing window open, so its next hello
 * pins it. `ctx` is withDaemon's context, or anything with `coderDir` and `phone`.
 */
function pinFakePhone({ coderDir, phone }, { arm = false } = {}) {
  const pins = new PinStore(path.join(coderDir, "tls", "phone-pins.json"));
  if (arm) {
    pins.armAllowNext(Date.now());
  } else {
    pins.add(phone.fingerprint);
  }
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { withTempDir, withDaemon, pinFakePhone, postHook, freePort, settle };
