const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

function listen(server, port, host) {
  return new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

function runSmoke() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "smoke.js")], {
      cwd: path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => resolve({ code, output }));
  });
}

// A daemon already running on the well-known ports stands in as these decoys:
// the smoke must start, find and drive only its own child.
test("smoke_never_reaches_a_daemon_on_the_well_known_ports", async (t) => {
  const requests = [];
  const httpDecoy = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/health" ? '{"ok":true,"sessions":0}' : "{}");
  });
  const wsConnections = [];
  const wsDecoy = net.createServer((socket) => {
    wsConnections.push(socket.remoteAddress);
    socket.destroy();
  });
  if (!(await listen(httpDecoy, 8791, "127.0.0.1"))) {
    t.skip("port 8791 is in use on this machine");
    return;
  }
  if (!(await listen(wsDecoy, 8792, "0.0.0.0"))) {
    httpDecoy.close();
    t.skip("port 8792 is in use on this machine");
    return;
  }
  try {
    const { code, output } = await runSmoke();
    assert.deepEqual(requests, [], "the smoke talked to the decoy on 8791");
    assert.deepEqual(wsConnections, [], "the smoke dialled the decoy on 8792");
    assert.equal(code, 0, output);
    assert.match(output, /Smoke test passed/);
  } finally {
    await new Promise((resolve) => httpDecoy.close(resolve));
    await new Promise((resolve) => wsDecoy.close(resolve));
  }
});
