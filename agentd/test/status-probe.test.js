const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { probeStatus } = require("../dist/launcher/status-probe.js");
const { withTempDir, freePort } = require("./helpers/daemon.js");
const { pairPhone } = require("./helpers/rk.js");

async function withProbeEnv(env, body) {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const listening = (server, ...where) => new Promise((resolve) => server.listen(...where, resolve));
const closed = (server) => new Promise((resolve) => server.close(resolve));

test("status_probe_reports_down_unpaired_and_paired", async () => {
  await withTempDir(async (dir) => {
    const configDir = path.join(dir, "rokid-coder");
    const port = await freePort();
    await withProbeEnv({ ROKID_RK_CONFIG_DIR: configDir, NEXUS_AGENTD_HTTP_PORT: String(port) }, async () => {
      assert.deepEqual(await probeStatus(), { agentd: "down", paired: false, launcherSocket: false });

      const health = http.createServer((req, res) => {
        res.writeHead(req.url === "/health" ? 200 : 404);
        res.end('{"ok":true}');
      });
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const socket = net.createServer((connection) => connection.destroy());
      await listening(health, port, "127.0.0.1");
      await listening(socket, path.join(configDir, "launcher.sock"));
      try {
        assert.deepEqual(await probeStatus(), { agentd: "up", paired: false, launcherSocket: true });
        pairPhone(configDir);
        assert.deepEqual(await probeStatus(), { agentd: "up", paired: true, launcherSocket: true });
      } finally {
        await closed(health);
        await closed(socket);
      }
      // A pin file that cannot be read is never taken for "no phone".
      fs.writeFileSync(path.join(configDir, "tls", "phone-pins.json"), "not json");
      assert.deepEqual(await probeStatus(), { agentd: "down", paired: true, launcherSocket: false });
    });
  });
});
