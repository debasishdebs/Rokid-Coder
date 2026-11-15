const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, NODE } = require("./fixtures/plugin-cli/harness");
const { resolveTool, writeDaemonEnv, daemonPath, envFilePath } = require("../dist/setup/resolve-cli.js");

const options = (world) => ({ home: world.home, env: world.env });

function envPath(world) {
  const text = fs.readFileSync(envFilePath(world.home), "utf8");
  const match = /^export PATH='(.*)'$/m.exec(text);
  assert.ok(match, text);
  return match[1];
}

test("resolver_finds_cli_outside_login_path_and_records_absolute_path", async (t) => {
  const world = makeWorld(t);
  // Not on the login shell's PATH, -l or -li: found in ~/.local/bin, the first known dir.
  const claude = world.cli("claude");
  const found = await resolveTool("claude", options(world));
  assert.equal(found.path, claude);
  assert.ok(path.isAbsolute(found.path));
  assert.equal(found.version, "2.1.285 (Claude Code)");
  assert.equal(found.interpreter, "/bin/sh");

  // On the login PATH, past the rc file's noise; then only on the interactive one (-lic).
  const elsewhere = path.join(world.root, "opt bin");
  const codex = world.cli("codex", { dir: elsewhere });
  world.env.FAKE_LOGIN_PATH = `${elsewhere}:/usr/bin:/bin`;
  assert.equal((await resolveTool("codex", options(world))).path, codex);
  world.env.FAKE_LOGIN_PATH = "/usr/bin:/bin";
  world.env.FAKE_INTERACTIVE_PATH = `${elsewhere}:/usr/bin:/bin`;
  assert.equal((await resolveTool("codex", options(world))).path, codex);
  delete world.env.FAKE_INTERACTIVE_PATH;
  assert.equal(await resolveTool("codex", options(world)), undefined);
});

test("npm_cli_with_separate_node_dir_gets_both_dirs_and_is_verified_under_generated_env", async (t) => {
  const world = makeWorld(t);
  const npmBin = path.join(world.home, ".npm-global", "bin");
  const nodeBin = path.join(world.home, ".nvm", "versions", "node", "v22", "bin");
  fs.mkdirSync(nodeBin, { recursive: true });
  fs.symlinkSync(NODE, path.join(nodeBin, "node"));
  const codex = world.cli("codex", { dir: npmBin, npm: true });
  world.env.FAKE_LOGIN_PATH = `${npmBin}:${nodeBin}:/usr/bin:/bin`;

  const found = await resolveTool("codex", options(world));
  assert.equal(found.path, codex);
  assert.equal(found.interpreter, path.join(nodeBin, "node"), "the user's own node, not rokid-node");
  assert.equal(daemonPath({ codex: found }), `${npmBin}:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);

  // The initial install's env write, verified under env -i.
  const written = await writeDaemonEnv(options(world));
  assert.deepEqual(written.warnings, []);
  assert.equal(envPath(world), `${npmBin}:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);
  assert.equal(fs.statSync(envFilePath(world.home)).mode & 0o777, 0o600);

  // refreshDaemonEnv rewrites it and restarts agentd, which then runs with that PATH.
  const bundle = world.bundle("1.0.0-test.1");
  const platform = world.platform();
  const manifest = { schema: 1, version: "1.0.0-test.1", platform: "darwin", bundleDir: bundle, installedAt: "", clis: {}, plugins: {}, autostart: { kind: "launchd", label: "x" } };
  assert.equal(await platform.installAutostart(manifest), "running");
  fs.rmSync(envFilePath(world.home));
  await platform.refreshDaemonEnv(manifest);
  assert.equal(envPath(world), `${npmBin}:${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);
  assert.equal((await world.health()).path, envPath(world));

  // A node only the user's terminal can find: the env is written, and the summary says agentd can't start codex.
  world.env.FAKE_LOGIN_PATH = `${npmBin}:/usr/bin:/bin`;
  const broken = await writeDaemonEnv(options(world));
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /^agentd won't be able to start codex at login: .*Fix: .*rokid-setup cli-installed --tool codex$/);
});
