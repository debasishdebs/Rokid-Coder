const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_CODEX_PORT, configPath, ensureConfig } = require("../dist/config.js");
const { SessionStore } = require("../dist/session-store.js");
const { PhoneLink } = require("../dist/phone-link.js");
const { WsHub } = require("../dist/ws-server.js");
const { silentLogger } = require("../dist/logger.js");
const { classifyFrame, sessionKeyOf } = require("../dist/protocol-v2.js");
const { createFakePhone } = require("./fake-phone.js");
const { agentCert } = require("./helpers/tls.js");

const LEGACY = {
  token: "legacy-token",
  wsPort: 8792,
  httpPort: 8791,
  machineId: "legacy-machine",
  machineName: "legacy-pc",
  phoneHosts: ["100.64.0.9"],
  tailnetDiscovery: false,
  allowTerminalInput: true,
  codex: { enabled: true, port: 9000 },
};

async function withStateDir(body) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "rokid-coder-config-"));
  try {
    await body(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test("old_config_parses_with_new_defaults", async () => {
  await withStateDir(async (dir) => {
    const original = `${JSON.stringify(LEGACY)}\n`;
    await fsp.writeFile(configPath(dir), original);
    const config = ensureConfig(dir);

    assert.equal(config.token, LEGACY.token);
    assert.deepEqual(config.phoneHosts, LEGACY.phoneHosts);
    assert.equal(config.allowTerminalInput, true);
    assert.deepEqual(config.codex, {
      enabled: true,
      port: 9000,
      useSharedDaemon: true,
    });
    assert.equal(config.codex.socketPath, undefined);
    assert.deepEqual(config.rokidCoder, {
      stateDir: path.join(os.homedir(), ".rokid-coder"),
    });
    // A complete pre-existing file is not rewritten just to add the new fields.
    assert.equal(await fsp.readFile(configPath(dir), "utf8"), original);
  });
});

test("minimal legacy config and fresh config get the new defaults", async () => {
  await withStateDir(async (dir) => {
    const fresh = ensureConfig(dir);
    assert.deepEqual(fresh.codex, {
      enabled: false,
      port: DEFAULT_CODEX_PORT,
      useSharedDaemon: true,
    });
    assert.equal(fresh.rokidCoder.stateDir, path.join(os.homedir(), ".rokid-coder"));
    // Defaults survive a save/load round trip.
    assert.deepEqual(ensureConfig(dir), fresh);
  });
});

test("new codex and rokidCoder fields are honoured and validated", async () => {
  await withStateDir(async (dir) => {
    await fsp.writeFile(configPath(dir), JSON.stringify({
      ...LEGACY,
      codex: {
        enabled: true,
        port: 9000,
        useSharedDaemon: false,
        socketPath: "/tmp/codex.sock",
      },
      rokidCoder: { stateDir: "/var/rokid" },
    }));
    const config = ensureConfig(dir);
    assert.equal(config.codex.useSharedDaemon, false);
    assert.equal(config.codex.socketPath, "/tmp/codex.sock");
    assert.equal(config.rokidCoder.stateDir, "/var/rokid");

    for (const bad of [
      { codex: { enabled: true, port: 9000, useSharedDaemon: "yes" } },
      { codex: { enabled: true, port: 9000, socketPath: "" } },
      { codex: { enabled: true, port: 9000, socketPath: 7 } },
      { rokidCoder: "nope" },
      { rokidCoder: { stateDir: "" } },
      { rokidCoder: { stateDir: 3 } },
    ]) {
      await fsp.writeFile(configPath(dir), JSON.stringify({ ...LEGACY, ...bad }));
      assert.throws(() => ensureConfig(dir), /Invalid nexus-agentd config/, JSON.stringify(bad));
    }
  });
});

test("classify_frame_is_exhaustive_and_unknown_is_steering", () => {
  const steering = [
    "approval_decision", "session_input", "thread_start", "alert_action", "followup",
    "question_answer", "mode_set", "mode_revoke_all", "codex_settings", "codex_compact",
    "launcher_command", "defaults_set", "settings_sync",
  ];
  const monitor = [
    "hello", "hello_ack", "hello_reject", "refresh", "detail_open", "detail_close",
    "ping", "pong", "fs_list", "alert_shown", "alert_dismissed", "models_request",
  ];
  for (const type of steering) assert.equal(classifyFrame(type), "steering", type);
  for (const type of monitor) assert.equal(classifyFrame(type), "monitor", type);
  for (const type of [
    "", "unknown_frame", "SNAPSHOT", "Hello", "toString", "constructor", "__proto__", "hasOwnProperty",
  ]) {
    assert.equal(classifyFrame(type), "steering", `unknown ${JSON.stringify(type)}`);
  }
});

test("sessionKeyOf joins provider and id", () => {
  assert.equal(sessionKeyOf("claude", "abc"), "claude:abc");
  assert.equal(sessionKeyOf("codex", "thread-1"), "codex:thread-1");
});

test("fake_phone_receives_snapshot_on_both_transports", async () => {
  const config = {
    token: "fake-phone-token",
    wsPort: 0,
    httpPort: 8791,
    machineId: "machine-fake-phone",
    machineName: "fake-phone-pc",
    phoneHosts: [],
    tailnetDiscovery: false,
  };

  await t_phonelink();
  await t_wshub();

  async function t_phonelink() {
    const phone = createFakePhone({ transport: "phonelink", tls: false });
    const { port } = await phone.start({ token: config.token });
    const store = new SessionStore(config, silentLogger);
    const link = new PhoneLink({
      config: { ...config, phoneHosts: [`127.0.0.1:${port}`] },
      store,
      logger: silentLogger,
      detailProvider: async () => [],
      discoveryPort: 48793,
    });
    try {
      link.start();
      const hello = await phone.waitFor("hello");
      assert.equal(hello.token, config.token);
      const snapshot = await phone.waitFor("snapshot");
      assert.deepEqual(snapshot.sessions, []);
      assert.equal(phone.tls, false);
      // Frames flow phone -> agentd as well: ping is answered with pong.
      phone.send({ type: "ping", t: 1 });
      assert.equal((await phone.waitFor("pong", (frame) => frame.t === 1)).t, 1);
    } finally {
      link.stop();
      store.dispose();
      phone.close();
    }
  }

  async function t_wshub() {
    const store = new SessionStore(config, silentLogger);
    const agent = await agentCert();
    const hub = new WsHub(config, store, silentLogger, { host: "127.0.0.1", tls: agent });
    await hub.start();
    const phone = createFakePhone({ transport: "wshub", tls: true, pin: agent.fingerprint256 });
    try {
      await phone.start({ port: hub.port(), token: config.token });
      assert.equal((await phone.waitFor("hello_ack")).server.name, "nexus-agentd");
      const snapshot = await phone.waitFor("snapshot");
      assert.deepEqual(snapshot.sessions, []);
      assert.equal(phone.tls, true);
      phone.send({ type: "refresh" });
      await phone.waitFor("snapshot", () => phone.frames.filter((f) => f.type === "snapshot").length === 2);
    } finally {
      phone.close();
      await hub.stop();
      store.dispose();
    }
  }
});

test("fake phone waitFor times out with a descriptive error", async () => {
  const phone = createFakePhone({ transport: "phonelink", tls: false });
  await phone.start({});
  try {
    await assert.rejects(phone.waitFor("never", undefined, 30), /timed out waiting for "never"/);
  } finally {
    phone.close();
  }
});

test("rokidCoder.waitLimitSec is optional, absent by default and validated against the hour cap", async () => {
  await withStateDir(async (dir) => {
    assert.equal(ensureConfig(dir).rokidCoder.waitLimitSec, undefined);
    await fsp.writeFile(configPath(dir), JSON.stringify({
      ...LEGACY,
      rokidCoder: { stateDir: "/var/rokid", waitLimitSec: 600 },
    }));
    assert.equal(ensureConfig(dir).rokidCoder.waitLimitSec, 600);

    for (const bad of [0, -5, 3601, 1.5, "600"]) {
      await fsp.writeFile(configPath(dir), JSON.stringify({
        ...LEGACY,
        rokidCoder: { stateDir: "/var/rokid", waitLimitSec: bad },
      }));
      assert.throws(() => ensureConfig(dir), /Invalid nexus-agentd config/, String(bad));
    }
  });
});
