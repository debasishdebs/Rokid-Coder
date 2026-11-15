const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { HookHttpServer } = require("../dist/http-server.js");
const { bundleRootFor } = require("../dist/version.js");

const CLI = path.join(__dirname, "..", "dist", "cli.js");
const PACKAGE_VERSION = require("../package.json").version;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-version-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

/** Every path under `dir`, so a test can tell that nothing was created. */
function tree(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    out.push(path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)));
  }
  return out.sort();
}

function agentd(home, args) {
  const env = { ...process.env, HOME: home };
  delete env.NEXUS_AGENTD_STATE_DIR;
  delete env.ROKID_RK_CONFIG_DIR;
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 20_000 });
}

test("version_command_prints_versions_and_touches_no_state", (t) => {
  const home = tempDir(t);
  const expected = `agentd ${PACKAGE_VERSION} node ${process.version} ${process.platform}-${process.arch}\n`;
  for (const args of [["--version"], ["-v"], ["version"]]) {
    const result = agentd(home, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected, args.join(" "));
  }
  assert.deepEqual(tree(home), [], "a version query created files");

  // A corrupt config is never read: the version still prints, and nothing changes.
  fs.mkdirSync(path.join(home, ".nexus-agentd"));
  fs.writeFileSync(path.join(home, ".nexus-agentd", "config.json"), "{not json");
  const before = tree(home);
  const result = agentd(home, ["--version", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(json).sort(), ["agentd", "arch", "bundleRoot", "execPath", "node", "platform"]);
  assert.equal(json.agentd, PACKAGE_VERSION);
  assert.equal(json.node, process.version);
  assert.equal(json.platform, process.platform);
  assert.equal(json.arch, process.arch);
  assert.equal(json.execPath, fs.realpathSync(process.execPath));
  assert.equal(json.bundleRoot, null);
  assert.deepEqual(tree(home), before);
  assert.equal(fs.readFileSync(path.join(home, ".nexus-agentd", "config.json"), "utf8"), "{not json");
});

test("bundle_root_is_the_dir_holding_node_bin_node_and_bundle_json", (t) => {
  const dir = tempDir(t);
  const bundle = path.join(dir, "b ü");
  fs.mkdirSync(path.join(bundle, "node", "bin"), { recursive: true });
  const node = path.join(bundle, "node", "bin", "node");
  fs.writeFileSync(node, "");
  assert.equal(bundleRootFor(node), null, "no bundle.json: not a bundle");
  fs.writeFileSync(path.join(bundle, "bundle.json"), "{}");
  assert.equal(bundleRootFor(node), bundle);
  // A symlinked node reports the bundle it really lives in.
  const link = path.join(dir, "node-link");
  fs.symlinkSync(node, link);
  assert.equal(bundleRootFor(link), bundle);
});

test("health_reports_version_and_exec_path", async (t) => {
  const server = new HookHttpServer({
    port: 0,
    sessionCount: () => 0,
    onHook: () => ({}),
    logger: { info() {}, warn() {}, error() {} },
  });
  await server.start();
  t.after(() => server.stop());
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port: server.port(), path: "/health" }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve(JSON.parse(text)));
    }).once("error", reject);
  });
  assert.equal(body.ok, true);
  assert.equal(body.agentdVersion, PACKAGE_VERSION);
  assert.equal(body.execPath, fs.realpathSync(process.execPath));
  assert.equal(body.bundleRoot, null);
});
