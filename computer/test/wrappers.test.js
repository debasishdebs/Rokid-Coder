const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { WRAPPER_NAMES, installUserWrappers, renderUserWrapper } = require("../dist/wrappers.js");

const WRAPPERS_DIR = path.join(__dirname, "..", "installer", "wrappers");

function tempDir(t, prefix = "rokid-wrappers-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync(dir);
}

test("user_wrapper_execs_the_single_quoted_bundle_path", () => {
  assert.deepEqual([...WRAPPER_NAMES], ["rokid-node", "agentd", "rk", "rokid-setup"]);
  assert.equal(
    renderUserWrapper("rk", "/Library/Application Support/RokidCoder/1.0.0"),
    "#!/bin/sh\nexec '/Library/Application Support/RokidCoder/1.0.0/bin/rk' \"$@\"\n",
  );
  // A quote in the path is closed, escaped and reopened, so the shell never sees it as syntax.
  assert.equal(
    renderUserWrapper("rokid-node", "/opt/it's $here"),
    "#!/bin/sh\nexec '/opt/it'\\''s $here/bin/rokid-node' \"$@\"\n",
  );
  // agentd alone picks up the daemon's PATH first, when setup wrote one.
  assert.equal(
    renderUserWrapper("agentd", "/b"),
    "#!/bin/sh\nif [ -f \"$HOME/.rokid-coder/env\" ]; then . \"$HOME/.rokid-coder/env\"; fi\nexec '/b/bin/agentd' \"$@\"\n",
  );
  assert.throws(() => renderUserWrapper("node", "/b"), /unknown wrapper/i);
  assert.throws(() => renderUserWrapper("rk", "relative/b"), /absolute/i);
});

test("install_user_wrappers_writes_each_atomically_with_mode_0755", (t) => {
  const home = tempDir(t);
  const bin = path.join(home, ".rokid-coder", "bin");
  installUserWrappers(home, "/first bundle");
  assert.equal(fs.statSync(path.join(home, ".rokid-coder")).mode & 0o777, 0o700, "the state dir stays private");
  installUserWrappers(home, "/second bundle");
  assert.deepEqual(fs.readdirSync(bin).sort(), [...WRAPPER_NAMES].sort(), "no temp file is left behind");
  for (const name of WRAPPER_NAMES) {
    const file = path.join(bin, name);
    assert.equal(fs.statSync(file).mode & 0o777, 0o755, name);
    assert.equal(fs.readFileSync(file, "utf8"), renderUserWrapper(name, "/second bundle"), name);
  }
});

test("bundle_wrappers_use_only_builtins", () => {
  // The only lines a bundle wrapper may hold: it finds its own directory with
  // case/cd/pwd and execs the bundled node. No dirname, no readlink, no env.
  const allowed = [
    /^#!\/bin\/sh$/,
    /^#( .*)?$/,
    /^case \$0 in \*\/\*\) d=\$\{0%\/\*\};; \*\) d=\.;; esac$/,
    /^d=\$\(CDPATH= cd -- "\$d" && pwd -P\)$/,
    /^exec "\$d\/\.\.\/node\/bin\/node"( "\$d\/\.\.\/app\/dist\/[a-z/]+\.js")? "\$@"$/,
  ];
  const entries = { "rokid-node": undefined, agentd: "cli.js", rk: "rk.js", "rokid-setup": "setup/main.js" };
  for (const name of WRAPPER_NAMES) {
    const file = path.join(WRAPPERS_DIR, `${name}.sh`);
    const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
    for (const line of lines) {
      assert.ok(allowed.some((pattern) => pattern.test(line)), `${name}: ${line}`);
    }
    const exec = lines.filter((line) => line.startsWith("exec "));
    assert.equal(exec.length, 1, name);
    assert.equal(lines.at(-1), exec[0], `${name}: exec is the last line`);
    const entry = entries[name];
    assert.equal(
      exec[0],
      `exec "$d/../node/bin/node"${entry ? ` "$d/../app/dist/${entry}"` : ""} "$@"`,
      name,
    );
    assert.ok(lines.some((line) => line.startsWith("case $0")) && lines.some((line) => line.startsWith("d=$(")), name);
  }
});

test("install_dev_writes_wrappers_over_the_repo_build_and_the_node_it_resolved", (t) => {
  const home = tempDir(t, "rokid-dev wrappers ü-");
  const node = fs.realpathSync(process.execPath);
  const result = spawnSync("/bin/sh", [path.join(WRAPPERS_DIR, "install-dev.sh")], {
    env: { HOME: home, PATH: `${path.dirname(node)}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const bin = path.join(home, ".rokid-coder", "bin");
  assert.deepEqual(fs.readdirSync(bin).sort(), [...WRAPPER_NAMES].sort());
  // The wrappers run without a PATH: they hold the absolute node and repo paths.
  const env = { HOME: home, PATH: "/nonexistent" };
  const probe = spawnSync(path.join(bin, "rokid-node"), ["-p", "process.execPath"], { env, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(fs.realpathSync(probe.stdout.trim()), node);
  const version = spawnSync(path.join(bin, "agentd"), ["--version", "--json"], { env, encoding: "utf8" });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).execPath, node);
  for (const name of WRAPPER_NAMES) {
    assert.equal(fs.statSync(path.join(bin, name)).mode & 0o777, 0o755, name);
  }
  const rk = fs.readFileSync(path.join(bin, "rk"), "utf8");
  assert.ok(rk.includes(path.join(__dirname, "..", "dist", "rk.js").replace(/'/g, "'\\''")), rk);
});
