// A bundle's app/dist/cli.js for wsl.ts's tests: `run` serves /health as the bundle's
// version on the config's httpPort, holds its wsPort, and registers itself in the
// fake procfs the way Linux would show a real bundle's agentd.
//   FAKE_PROC_ROOT   the fake procfs
//   FAKE_PORTS       "http,ws" instead of ~/.nexus-agentd/config.json
//   FAKE_TERM        "ignore" (SIGTERM is ignored) or a delay in ms before exiting on SIGTERM
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { registerProcess, unregisterProcess } = require("./world.js");

const appDist = path.dirname(process.argv[1]);
const bundle = path.resolve(appDist, "..", "..");
const procRoot = process.env.FAKE_PROC_ROOT;
const [httpPort, wsPort] = process.env.FAKE_PORTS
  ? process.env.FAKE_PORTS.split(",").map(Number)
  : (() => {
      const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".nexus-agentd", "config.json"), "utf8"));
      return [config.httpPort, config.wsPort];
    })();
const { version } = JSON.parse(fs.readFileSync(path.join(bundle, "bundle.json"), "utf8"));
const execPath = path.join(bundle, "node", "bin", "node");

const health = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, sessions: 0, agentdVersion: version, execPath, bundleRoot: bundle }));
});
const ws = net.createServer((socket) => socket.end());
let listening = 0;
const ready = () => {
  if (++listening < 2) return;
  registerProcess(procRoot, {
    pid: process.pid,
    exe: execPath,
    // As the wrapper execs it: "$d/../node/bin/node" "$d/../app/dist/cli.js" <args>
    argv: [path.join(bundle, "bin", "..", "node", "bin", "node"), path.join(bundle, "bin", "..", "app", "dist", "cli.js"), ...process.argv.slice(2)],
    ports: [httpPort, wsPort],
  });
  if (process.env.FAKE_READY_FILE) fs.writeFileSync(process.env.FAKE_READY_FILE, String(process.pid));
};
health.listen(httpPort, "127.0.0.1", ready);
ws.listen(wsPort, "127.0.0.1", ready);

const exit = () => {
  unregisterProcess(procRoot, process.pid);
  process.exit(0);
};
process.on("SIGTERM", () => {
  if (process.env.FAKE_TERM === "ignore") return;
  const delay = Number(process.env.FAKE_TERM || 0);
  setTimeout(exit, delay);
});
