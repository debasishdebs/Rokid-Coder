const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_DIR = path.join(__dirname, "..", "..", "plugin");

/** Every hook command in a plugin's hooks.json. */
function hookCommands(hooksFile) {
  const { hooks } = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  return Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap((group) => group.hooks.map((hook) => ({ event, ...hook }))));
}

const PLUGINS = [
  { name: "claude-code", root: "CLAUDE_PLUGIN_ROOT", provider: "claude" },
  { name: "codex", root: "PLUGIN_ROOT", provider: "codex" },
];

test("hooks_never_call_bare_node", () => {
  for (const plugin of PLUGINS) {
    const commands = hookCommands(path.join(PLUGIN_DIR, plugin.name, "hooks", "hooks.json"));
    assert.ok(commands.length > 0, plugin.name);
    for (const { event, command } of commands) {
      // Only env assignments may come before the wrapper, and the wrapper runs the forwarder.
      const match = /^((?:[A-Z_]+=[^ ]* )*)"\$HOME\/\.rokid-coder\/bin\/rokid-node" "\$\{([A-Z_]+)\}\/bin\/hook-forward\.js"$/.exec(command);
      assert.ok(match, `${plugin.name} ${event}: ${command}`);
      assert.equal(match[2], plugin.root, `${plugin.name} ${event}`);
      assert.match(match[1], new RegExp(`(^| )ROKID_CODER_PROVIDER=${plugin.provider} `), `${plugin.name} ${event}`);
      assert.doesNotMatch(command, /(^|[\s"'/])node(\s|$)/, `${plugin.name} ${event}: bare node`);
    }
  }
});

const net = require("node:net");
const { pathToFileURL } = require("node:url");
const { bundleUnderTest, copyBundle, tempDir } = require("./helpers/bundle.js");
const { installUserWrappers, WRAPPER_NAMES } = require("../dist/wrappers.js");

const CONTROLLED_RUN = path.join(__dirname, "..", "installer", "bundle", "controlled-run.mjs");
const loadControlledRun = () => import(pathToFileURL(CONTROLLED_RUN).href);

function refusedPort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("wrappers_and_hooks_work_from_a_path_with_spaces_and_non_ascii", async (t) => {
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const scratch = tempDir(t);
  const bundle = copyBundle(dir, path.join(scratch, "Rokid Tëst", "b ü"));
  // T7p brings the real setup entry; the wrapper only has to reach it.
  fs.mkdirSync(path.join(bundle, "app", "dist", "setup"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "app", "dist", "setup", "main.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const home = path.join(scratch, "Hömé dir");
  fs.mkdirSync(home);
  installUserWrappers(home, bundle);
  const bin = path.join(home, ".rokid-coder", "bin");
  const env = run.controlledEnv(home, 1);
  const node = fs.realpathSync(path.join(bundle, "node", "bin", "node"));

  const probe = await run.runFile(path.join(bin, "rokid-node"), ["-p", "process.execPath"], { env });
  assert.equal(probe.code, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), node);
  const version = await run.runFile(path.join(bin, "agentd"), ["--version", "--json"], { env });
  assert.equal(version.code, 0, version.stderr);
  assert.equal(JSON.parse(version.stdout).bundleRoot, bundle);
  const setup = await run.runFile(path.join(bin, "rokid-setup"), ["--json", "a b"], { env });
  assert.equal(setup.code, 0, setup.stderr);
  assert.deepEqual(JSON.parse(setup.stdout), ["--json", "a b"]);
  assert.deepEqual(fs.readdirSync(bin).sort(), [...WRAPPER_NAMES].sort());

  // Every bundled hook command, with agentd down (a refused port): the
  // forwarder must run, and give its offline status answer.
  const port = await refusedPort();
  const hooks = run.bundledHookCommands(bundle);
  assert.equal(hooks.length, 15);
  for (const hook of hooks) {
    const payload = hook.plugin.provider === "codex"
      ? { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "rokid:status" }
      : { hook_event_name: "UserPromptExpansion", session_id: "s", command_name: "rokid:status" };
    const result = await run.runHook(bundle, home, port, hook, payload);
    assert.equal(result.code, 0, `${hook.plugin.name} ${hook.event}: ${result.stderr}`);
    assert.match(result.stdout, /agentd isn't running/, `${hook.plugin.name} ${hook.event}`);
  }
});

test("bundled_hooks_reach_daemon_with_controlled_env", async (t) => {
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const home = tempDir(t, "rokid-controlled-");
  run.installWrappers(dir, home);
  const daemon = await run.startDaemon(dir, home);
  t.after(() => daemon.stop());
  assert.notEqual(daemon.httpPort, 8791);
  const identity = run.daemonCheck(dir, daemon.health);
  assert.equal(identity.ok, true, JSON.stringify(identity.detail));
  const hooks = await run.hooksCheck(dir, home, daemon.httpPort);
  assert.equal(hooks.detail.length, 15);
  for (const result of hooks.detail) {
    assert.ok(result.ok, `${result.plugin} ${result.event}: ${result.stdout} ${result.stderr}`);
  }
});

test("controlled_run_passes_all_four_checks", async () => {
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const result = await run.controlledRun(dir);
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  assert.deepEqual(result.checks.map((check) => check.name), ["version", "selfcheck", "daemon", "hooks"]);
});
