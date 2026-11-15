const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const {
  defaultDaemonSocketPath,
  daemonEndpoint,
  resolveDaemonSocketPath,
} = require("../dist/codex/daemon-socket.js");

test("endpoint_is_ws_unix", () => {
  assert.equal(
    daemonEndpoint("/tmp/x/app-server-control.sock"),
    "ws+unix:///tmp/x/app-server-control.sock:/",
  );
});

test("default socket path lives under the Codex home of the given user", () => {
  assert.equal(
    defaultDaemonSocketPath("/Users/someone"),
    "/Users/someone/.codex/app-server-control/app-server-control.sock",
  );
  assert.equal(
    defaultDaemonSocketPath(),
    `${os.homedir()}/.codex/app-server-control/app-server-control.sock`,
  );
});

test("configured socket path expands a leading ~/ and is otherwise untouched", () => {
  assert.equal(resolveDaemonSocketPath("~/custom/c.sock", "/Users/someone"), "/Users/someone/custom/c.sock");
  assert.equal(resolveDaemonSocketPath("/abs/c.sock", "/Users/someone"), "/abs/c.sock");
  assert.equal(
    resolveDaemonSocketPath(undefined, "/Users/someone"),
    "/Users/someone/.codex/app-server-control/app-server-control.sock",
  );
});
