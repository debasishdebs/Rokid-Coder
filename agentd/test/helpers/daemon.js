const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { ensureConfig, saveConfig } = require("../../dist/config.js");
const { startDaemon } = require("../../dist/daemon.js");
const { PinStore } = require("../../dist/tls.js");
const { createFakePhone } = require("../fake-phone.js");
const { agentCert, seedAgentCert } = require("./tls.js");

async function withTempDir(body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rokid-coder-test-"));
  try {
    await body(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
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
 * `tls: true` makes the phone link real TLS: agentd pins the fake phone's cert
 * on its first hello inside a pairing window opened here, as `pair` would
 * (phonelink), or the fake pins agentd's cert (wshub). That
 * is what lets steering frames through; without it the link is monitor-only.
 * The daemon's agentd cert is the one shared test cert, copied into its tls dir. `coderFiles` pre-seeds files in
 * the Rokid-Coder state dir (name -> JSON value), such as settings.json.
 */
async function withDaemon({ transport, tls = false, attached = [], discovered = [], coderFiles = {}, paired = false }, body) {
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
      await fsp.writeFile(path.join(coderDir, name), JSON.stringify(content));
    }

    await seedAgentCert(path.join(coderDir, "tls"));
    if (paired) {
      // A phone paired earlier. The dialled link checks pins, so this suits wshub only.
      new PinStore(path.join(coderDir, "tls", "phone-pins.json")).add("CD".repeat(32));
    }
    if (transport === "phonelink" && tls) {
      new PinStore(path.join(coderDir, "tls", "phone-pins.json")).armAllowNext(Date.now());
    }
    const agent = await agentCert();
    const phone = createFakePhone({ transport, tls, pin: agent.fingerprint256 });
    const httpPort = await freePort();
    const wsPort = await freePort();
    const base = ensureConfig(stateDir);
    let phonePort;
    if (transport === "phonelink") {
      phonePort = (await phone.start({ token: base.token })).port;
    }
    saveConfig({
      ...base,
      httpPort,
      wsPort,
      phoneHosts: transport === "phonelink" ? [`${tls ? "tls://" : ""}127.0.0.1:${phonePort}`] : [],
      tailnetDiscovery: false,
      rokidCoder: { stateDir: coderDir },
    }, stateDir);

    const saved = { state: process.env.NEXUS_AGENTD_STATE_DIR, claude: process.env.NEXUS_AGENTD_CLAUDE_DIR };
    process.env.NEXUS_AGENTD_STATE_DIR = stateDir;
    process.env.NEXUS_AGENTD_CLAUDE_DIR = claudeDir;
    let daemon;
    try {
      daemon = await startDaemon({ discoveryPort: await freePort() });
      // The steering secret the daemon made; a wss phone sends it to steer.
      const steer = (await fsp.readFile(path.join(coderDir, "tls", "steer.secret"), "utf8")).trim();
      if (tls) phone.steer = steer;
      if (transport === "wshub") {
        await phone.start({ port: wsPort, host: "127.0.0.1", token: base.token });
      }
      await phone.waitFor("snapshot");
      await body({ daemon, phone, httpPort, wsPort, token: base.token, coderDir, claudeDir, steer, agentFingerprint: agent.fingerprint256 });
    } finally {
      phone.close();
      await daemon?.stop();
      for (const [key, value] of [["NEXUS_AGENTD_STATE_DIR", saved.state], ["NEXUS_AGENTD_CLAUDE_DIR", saved.claude]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
}

const settle = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { withTempDir, withDaemon, postHook, freePort, settle };
