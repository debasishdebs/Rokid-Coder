// gate/netprobe.mjs, the Windows gate's network probe (6b T8, W3/W4), on loopback.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { agentCert } = require("../../../test/helpers/tls.js");

const NETPROBE = path.join(__dirname, "..", "gate", "netprobe.mjs");

function run(args) {
  const child = spawn(process.execPath, [NETPROBE, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const result = { child, out: "" };
  child.stdout.on("data", (chunk) => (result.out += chunk));
  child.stderr.on("data", (chunk) => (result.out += chunk));
  result.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  result.until = async (pattern) => {
    const deadline = Date.now() + 10000;
    while (!pattern.test(result.out)) {
      if (Date.now() > deadline) throw new Error(`netprobe never printed ${pattern}: ${result.out}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return pattern.exec(result.out);
  };
  return result;
}

test("netprobe_tls_listen_and_dial_agree_on_the_fingerprint", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-netprobe-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = await agentCert();
  fs.writeFileSync(path.join(dir, "agentd.crt"), agent.cert);
  fs.writeFileSync(path.join(dir, "agentd.key"), agent.key);
  const listener = run(["listen-tls", "--port", "0", "--cert", path.join(dir, "agentd.crt"), "--key", path.join(dir, "agentd.key")]);
  t.after(() => listener.child.kill());
  const [, fp] = await listener.until(/^fp (\S+)$/m);
  assert.equal(fp, agent.fingerprint256);
  const [, port] = await listener.until(/listening tls 0\.0\.0\.0:(\d+)/);
  const dial = run(["dial-tls", "--host", "127.0.0.1", "--port", port]);
  assert.equal(await dial.exited, 0, dial.out);
  assert.match(dial.out, new RegExp(`^fp ${fp}$`, "m"));
  assert.ok(!/PRIVATE KEY/.test(listener.out + dial.out), "no key is ever printed");
  await listener.until(/^peer 127\.0\.0\.1:/m);
});

test("netprobe_udp_probe_arrives", async (t) => {
  const listener = run(["listen-udp", "--port", "0"]);
  t.after(() => listener.child.kill());
  const [, port] = await listener.until(/listening udp 0\.0\.0\.0:(\d+)/);
  const send = run(["send-udp", "--host", "127.0.0.1", "--port", port]);
  assert.equal(await send.exited, 0, send.out);
  await listener.until(/datagram from 127\.0\.0\.1:\d+ \d+ bytes \(probe\)/);
  const bad = run(["send-udp", "--port", port]);
  assert.equal(await bad.exited, 2);
  assert.match(bad.out, /--broadcast or --host/);
});
