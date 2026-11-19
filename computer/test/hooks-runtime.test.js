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
const { spawnSync } = require("node:child_process");
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
  assert.equal(hooks.length, 18, "the Claude plugin's 17 hooks (the MCP elicitation pair included) and the Codex plugin's 1");
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
  assert.equal(hooks.detail.length, 18);
  for (const result of hooks.detail) {
    assert.ok(result.ok, `${result.plugin} ${result.event}: ${result.stdout} ${result.stderr}`);
  }
});

test("controlled_run_passes_every_check", async () => {
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const result = await run.controlledRun(dir);
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  assert.deepEqual(result.checks.map((check) => check.name), ["wrappers", "version", "selfcheck", "daemon", "hooks"]);
});

test("controlled_run_wrapper_check_rejects_extra_or_altered_wrappers", async (t) => {
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const home = tempDir(t, "rokid-controlled-");
  run.installWrappers(dir, home);
  assert.deepEqual(run.wrappersCheck(dir, home), { name: "wrappers", ok: true, detail: [...WRAPPER_NAMES].sort() });
  const bin = path.join(home, ".rokid-coder", "bin");

  fs.writeFileSync(path.join(bin, "extra"), "#!/bin/sh\n", { mode: 0o755 });
  let check = run.wrappersCheck(dir, home);
  assert.equal(check.ok, false);
  assert.deepEqual(check.detail, ["extra is not a generated wrapper"]);
  fs.rmSync(path.join(bin, "extra"));

  fs.appendFileSync(path.join(bin, "rk"), "/usr/bin/curl https://example.invalid\n");
  fs.chmodSync(path.join(bin, "agentd"), 0o775);
  check = run.wrappersCheck(dir, home);
  assert.equal(check.ok, false);
  assert.deepEqual(check.detail, ["agentd has mode 775, not 755", "rk is not the wrapper setup generates"]);

  const result = await run.controlledRun(dir, { home });
  assert.equal(result.ok, true, "the run writes the wrappers again before it checks them");
});

test("exec_allowlist_refuses_an_extra_executable_beside_the_wrappers", async (t) => {
  if (process.platform !== "darwin" || !fs.existsSync("/usr/bin/sandbox-exec")) {
    t.skip("needs macOS sandbox-exec");
    return;
  }
  const run = await loadControlledRun();
  const { dir } = await bundleUnderTest();
  const home = tempDir(t, "rokid-controlled-");
  run.installWrappers(dir, home);
  const bin = path.join(home, ".rokid-coder", "bin");
  fs.copyFileSync("/usr/bin/true", path.join(bin, "extra"));
  fs.chmodSync(path.join(bin, "extra"), 0o755);
  const profile = path.join(__dirname, "..", "installer", "bundle", "exec-allowlist.sb");
  const allow = ["-f", profile, "-D", `BUNDLE=${fs.realpathSync(dir)}`, "-D", `WRAPPERS=${bin}`];
  const sandboxed = (file, args = []) => spawnSync("/usr/bin/sandbox-exec", [...allow, file, ...args], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });

  const wrapper = sandboxed(path.join(bin, "rokid-node"), ["-e", "process.stdout.write('ran')"]);
  assert.equal(wrapper.status, 0, wrapper.stderr);
  assert.equal(wrapper.stdout, "ran");
  const extra = sandboxed(path.join(bin, "extra"));
  assert.notEqual(extra.status, 0, "an executable the wrapper dir should not hold ran");
  assert.match(extra.stderr, /Operation not permitted/);
});
