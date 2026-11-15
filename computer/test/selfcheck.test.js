const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { COMPUTER, bundleUnderTest, fixtureBundle, tempDir } = require("./helpers/bundle.js");

function selfcheck(bundle, args, home) {
  const result = spawnSync(path.join(bundle, "bin", "agentd"), ["selfcheck", "--json", ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, json: JSON.parse(result.stdout || "null"), stderr: result.stderr };
}

test("selfcheck_spawns_real_pty_and_all_natives_inside_bundle", async (t) => {
  const { dir } = await bundleUnderTest();
  const home = tempDir(t);
  const { status, json, stderr } = selfcheck(dir, ["--require-bundle"], home);
  assert.equal(status, 0, `${stderr}\n${JSON.stringify(json, null, 2)}`);
  assert.equal(json.ok, true);
  assert.deepEqual(Object.keys(json).sort(), ["bundleRoot", "execPath", "natives", "node", "ok", "outside", "pty"]);
  assert.deepEqual(json.pty, { output: "rokid-pty-ok", exitCode: 0 });
  assert.equal(json.bundleRoot, dir);
  assert.equal(json.execPath, path.join(dir, "node", "bin", "node"));
  assert.deepEqual(json.outside, []);
  assert.ok(json.natives.some((file) => file.startsWith(`${dir}${path.sep}`) && path.basename(file) === "pty.node"), json.natives.join("\n"));
  if (process.platform === "darwin") {
    assert.ok(json.natives.some((file) => path.basename(file) === "spawn-helper"), "darwin lists spawn-helper");
  }
  assert.deepEqual(fs.readdirSync(home), [], "selfcheck touched no state dir");
});

test("selfcheck_fails_when_a_native_loads_from_outside", async (t) => {
  const repoPty = fs.realpathSync(path.join(COMPUTER, "node_modules", "node-pty"));
  const bundle = await fixtureBundle({ ptyFrom: repoPty });
  const home = tempDir(t);
  const { status, json } = selfcheck(bundle, ["--require-bundle"], home);
  assert.notEqual(status, 0);
  assert.equal(json.ok, false);
  assert.equal(json.pty.output, "rokid-pty-ok", "the pty itself works: only where it loaded from fails");
  assert.ok(json.outside.length > 0);
  assert.ok(json.outside.every((file) => file.startsWith(`${repoPty}${path.sep}`)), json.outside.join("\n"));
  assert.ok(json.outside.some((file) => path.basename(file) === "pty.node"));

  // Without --require-bundle the same run passes: outside is reported, not refused.
  const relaxed = selfcheck(bundle, [], home);
  assert.equal(relaxed.status, 0, JSON.stringify(relaxed.json));
  assert.deepEqual(relaxed.json.outside, json.outside);
});

test("selfcheck_outside_a_bundle_fails_only_with_require_bundle", (t) => {
  const home = tempDir(t);
  const run = (args) => spawnSync(process.execPath, [path.join(COMPUTER, "dist", "cli.js"), "selfcheck", "--json", ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 30_000,
  });
  const dev = run([]);
  assert.equal(dev.status, 0, dev.stderr);
  assert.equal(JSON.parse(dev.stdout).bundleRoot, null);
  const strict = run(["--require-bundle"]);
  assert.notEqual(strict.status, 0);
  assert.equal(JSON.parse(strict.stdout).ok, false);
  assert.deepEqual(fs.readdirSync(home), []);
});
