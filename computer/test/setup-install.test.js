const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { makeWorld, treeBytes, NODE } = require("./fixtures/plugin-cli/harness");
const { PinStore, normalizeFingerprint } = require("../dist/tls.js");

const CONSENT = { legacy: { retireAutostart: true, removeInstallHooks: true } };

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function wrappers(world) {
  const bin = path.join(world.home, ".rokid-coder", "bin");
  return fs.existsSync(bin) ? fs.readdirSync(bin) : [];
}

function insideBundle(health, bundle) {
  return health && health.execPath.startsWith(`${bundle}${path.sep}`);
}

/** A Mac running 0.8.0: its state, its LaunchAgent up, fake claude installed from its checkout. */
async function on080(t, options = {}) {
  const world = makeWorld(t);
  if (options.scenario) world.scenario(options.scenario);
  const secrets = await world.seed08();
  if (options.prepare) options.prepare(world);
  const claude = world.cli("claude");
  const legacy = await world.legacy08({ claude });
  const settings = fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8");
  return { world, secrets, claude, legacy, settings, before: world.stateBytes(options.stateDir?.(world)) };
}

/** Everything a failed upgrade from 0.8.0 must have put back. */
function assertBackOn080(world, { legacy, before, settings }) {
  assert.ok(fs.existsSync(legacy.plist), "the old LaunchAgent is back");
  const daemons = world.fakeState().daemons.filter((d) => alive(d.pid));
  assert.deepEqual(daemons.map((d) => d.role), ["legacy"], "only the old agent runs");
  assert.deepEqual(world.stateBytes(), before, "the state is byte-identical");
  const claude = world.cliState("claude");
  assert.equal(claude.marketplaces["rokid-coder"].path, legacy.repo, "the marketplace points at the checkout again");
  assert.equal(claude.plugins["rokid@rokid-coder"].version, "0.8.0");
  assert.deepEqual(wrappers(world), [], "no wrappers are left");
  assert.equal(fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8"), settings);
  assert.equal(world.manifest(), undefined, "nothing was committed");
  assert.equal(world.journal().open, false);
}

test("upgrade_from_0_8_0_keeps_pairings_and_retires_old_agent", async (t) => {
  const { world, secrets, legacy, settings } = await on080(t);
  const bundle = world.bundle("1.0.0-test.1");
  const run = world.install(bundle, CONSENT);
  assert.equal(run.status, 0, run.output);

  const ops = world.calls().map((c) => c.op);
  assert.ok(ops.indexOf("retireLegacyAutostart") < ops.indexOf("installAutostart"));
  assert.ok(!fs.existsSync(legacy.plist), "the old LaunchAgent is retired");
  const health = await world.health();
  assert.equal(health.agentdVersion, "1.0.0-test.1");
  assert.ok(insideBundle(health, bundle), health.execPath);
  assert.deepEqual(world.fakeState().daemons.filter((d) => alive(d.pid)).map((d) => d.role), ["current"]);

  const pins = new PinStore(path.join(world.home, ".rokid-coder", "tls", "phone-pins.json"));
  assert.deepEqual(pins.list(), [normalizeFingerprint(secrets.pinFp)], "the phone is still paired");
  const config = JSON.parse(fs.readFileSync(path.join(world.home, ".nexus-agentd", "config.json"), "utf8"));
  assert.equal(config.token, secrets.token);
  assert.equal(config.machineId, secrets.machineId);

  const claude = world.cliState("claude");
  assert.equal(claude.marketplaces["rokid-coder"].path, path.join(bundle, "plugins"));
  assert.equal(claude.plugins["rokid@rokid-coder"].version, "1.0.0-test.1");
  const manifest = world.manifest();
  assert.equal(manifest.version, "1.0.0-test.1");
  assert.equal(fs.statSync(path.join(world.home, ".rokid-coder", "install.json")).mode & 0o777, 0o600);
  assert.deepEqual(manifest.previous.pluginSources.claude, { source: legacy.repo, pluginVersion: "0.8.0" });
  assert.equal(manifest.previous.retiredLegacy.label, "com.anezium.nexus-agentd");
  assert.ok(fs.existsSync(path.join(manifest.previous.snapshot, "inventory.json")));
  assert.equal(world.journal().open, false);

  const now = fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8");
  assert.ok(!now.includes("hook-forward.js"), "the install-hooks entries are gone");
  assert.ok(now.includes("my-own-guard"), "the user's own hook stays");
  const backups = fs.readdirSync(path.join(world.home, ".claude")).filter((n) => n.startsWith("settings.json.agentd-backup-"));
  assert.equal(fs.readFileSync(path.join(world.home, ".claude", backups[0]), "utf8"), settings);
  assert.match(fs.readFileSync(path.join(world.home, ".zprofile"), "utf8"), /# >>> rokid-coder >>>\nexport PATH="\$HOME\/\.rokid-coder\/bin:\$PATH"\n# <<< rokid-coder <<</);
  assert.deepEqual(wrappers(world).sort(), ["agentd", "rk", "rokid-node", "rokid-setup"]);
});

test("custom_state_dir_from_0_8_0_config_is_honoured", async (t) => {
  const custom = (world) => path.join(world.home, "custom coder state");
  const { world } = await on080(t, {
    prepare: (w) => {
      fs.renameSync(path.join(w.home, ".rokid-coder"), custom(w));
      const file = path.join(w.home, ".nexus-agentd", "config.json");
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      config.rokidCoder.stateDir = "~/custom coder state";
      fs.writeFileSync(file, JSON.stringify(config));
    },
  });
  const run = world.install(world.bundle("1.0.0-test.1"), CONSENT);
  assert.equal(run.status, 0, run.output);
  const inventory = JSON.parse(fs.readFileSync(path.join(world.manifest().previous.snapshot, "inventory.json"), "utf8"));
  assert.equal(inventory.roots.state, custom(world));
  assert.ok(inventory.paths.some((p) => p.root === "state" && p.rel === path.join("tls", "phone-pins.json")));
  assert.ok(!fs.existsSync(path.join(world.home, ".rokid-coder", "tls")), "nothing moved into the default dir");
  assert.equal(new PinStore(path.join(custom(world), "tls", "phone-pins.json")).list().length, 1);
});

test("failure_after_autostart_rolls_back_everything", async (t) => {
  const setup = await on080(t);
  const { world } = setup;
  const run = world.install(world.bundle("1.0.0-test.1"), CONSENT, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } });
  assert.equal(run.status, 1, run.output);
  assert.match(run.stdout, /injected failure at step 9/);
  assert.match(run.stdout, /Rolled back to your 0\.8\.0 setup\n/);
  assertBackOn080(world, setup);
  const health = await world.health();
  assert.equal(health.agentdVersion, "0.8.0");
});

test("failure_at_each_step_undoes_only_what_ran", async (t) => {
  for (const step of [3, 4, 5, 6, 7, 8, 9]) {
    await t.test(`step ${step}`, async (t2) => {
      const setup = await on080(t2);
      const { world } = setup;
      const run = world.install(world.bundle("1.0.0-test.1"), CONSENT, { extraEnv: { ROKID_SETUP_FAIL_AT: String(step) } });
      assert.equal(run.status, 1, run.output);
      assertBackOn080(world, setup);
      const ops = world.calls().filter((c) => c.op !== "cli").map((c) => c.op);
      const started = ops.filter((op) => op === "installAutostart").length;
      assert.equal(started, step === 9 ? 1 : 0, "autostart only when step 9 ran");
      assert.equal(ops.filter((op) => op === "stopCurrent").length, step === 9 ? 1 : 0, "a replacement is stopped only if one started");
      assert.equal(ops.filter((op) => op === "startLegacyAutostart").length, 1, "the old agent starts exactly once");
      assert.equal(world.mutatingCalls("claude").length > 0, step >= 8, "plugins are touched (and put back) only once step 8 ran");
      assert.equal(fs.existsSync(path.join(world.home, ".rokid-coder", "bin")), step >= 5, "wrappers only once step 5 ran");
      assert.ok(!fs.existsSync(path.join(world.home, ".rokid-coder", "env")), "no env is left");
      assert.equal(fs.existsSync(path.join(world.home, ".zprofile")) && fs.readFileSync(path.join(world.home, ".zprofile"), "utf8").includes("rokid-coder"), false);
    });
  }
});

test("state_check_failure_stops_before_any_change", async (t) => {
  const setup = await on080(t, {
    prepare: (w) => fs.writeFileSync(path.join(w.home, ".rokid-coder", "tls", "phone-pins.json"), '{"version":3,"phones":"not a list"}\n'),
  });
  const { world } = setup;
  const run = world.install(world.bundle("1.0.0-test.1"), CONSENT);
  assert.equal(run.status, 1, run.output);
  assert.match(run.stdout, /the new version cannot read the phone pins; your setup was left as it was/);
  assertBackOn080(world, setup);
  assert.ok(!world.calls().some((c) => c.op === "installAutostart"));
  assert.deepEqual(world.mutatingCalls("claude"), []);
  assert.ok(!fs.existsSync(path.join(world.home, ".rokid-coder", "bin")));
});

test("upgrade_from_previous_installer_release_replaces_running_daemon", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1");
  assert.equal(world.install(b1).status, 0);
  const first = world.fakeState().daemons[0];
  assert.equal((await world.health()).agentdVersion, "1.0.0-test.1");

  const b2 = world.bundle("1.0.0-test.2");
  world.clearCalls();
  const run = world.install(b2);
  assert.equal(run.status, 0, run.output);
  const health = await world.health();
  assert.equal(health.agentdVersion, "1.0.0-test.2");
  assert.ok(insideBundle(health, b2), health.execPath);
  assert.ok(!alive(first.pid), "the test.1 process has exited");
  const ops = world.calls().filter((c) => c.op !== "cli");
  assert.deepEqual(ops.filter((c) => c.op === "stopCurrent").map((c) => c.bundleDir), [b1]);
  assert.ok(ops.findIndex((c) => c.op === "stopCurrent") < ops.findIndex((c) => c.op === "installAutostart"));
  const manifest = world.manifest();
  assert.equal(manifest.previous.version, "1.0.0-test.1");
  assert.equal(manifest.previous.bundleDir, b1);
  assert.equal(manifest.previous.manifest.version, "1.0.0-test.1");
  assert.equal(manifest.previous.manifest.previous, undefined, "one level of history");
});

test("identity_check_fails_when_old_daemon_still_answers", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  assert.equal(world.install(world.bundle("1.0.0-test.1")).status, 0);
  world.scenario({ stopLeavesRunning: true });
  const run = world.install(world.bundle("1.0.0-test.2"));
  assert.equal(run.status, 1, run.output);
  assert.match(run.stdout, /the new agentd did not take over: \/health answered agentd 1\.0\.0-test\.1/);
  assert.match(run.stdout, /Rolled back to 1\.0\.0-test\.1\n/);
  assert.doesNotMatch(run.stdout, /is installed/);
  assert.equal(world.manifest().version, "1.0.0-test.1");
});

test("rollback_stops_replacement_before_restarting_previous", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1");
  assert.equal(world.install(b1).status, 0);
  const b2 = world.bundle("1.0.0-test.2");
  world.clearCalls();
  assert.equal(world.install(b2, {}, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } }).status, 1);
  const ops = world.calls().filter((c) => c.op === "stopCurrent" || c.op === "installAutostart").map((c) => `${c.op} ${path.basename(c.bundleDir)}`);
  assert.deepEqual(ops, [
    "stopCurrent 1.0.0-test.1",
    "installAutostart 1.0.0-test.2",
    "stopCurrent 1.0.0-test.2",
    "installAutostart 1.0.0-test.1",
  ]);
  assert.equal((await world.health()).agentdVersion, "1.0.0-test.1");
});

test("recovery_restarts_previous_once_after_all_restores", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1");
  assert.equal(world.install(b1).status, 0);
  world.clearCalls();
  assert.equal(world.install(world.bundle("1.0.0-test.2"), {}, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } }).status, 1);
  const calls = world.calls();
  const stop = calls.findIndex((c) => c.op === "stopCurrent" && c.bundleDir.endsWith("test.2"));
  const after = calls.slice(stop + 1);
  const starts = after.filter((c) => c.op === "installAutostart" || c.op === "startLegacyAutostart" || c.op === "daemon_started");
  assert.deepEqual(starts.map((c) => `${c.op} ${c.version}`), ["installAutostart 1.0.0-test.1", "daemon_started 1.0.0-test.1"], "exactly one start, of the previous bundle");
  const start = after.find((c) => c.op === "installAutostart");
  assert.equal(start.alive, 0, "no replacement process is alive when the previous one starts");
  assert.match(start.wrapper, /1\.0\.0-test\.1\/bin\/agentd/, "the wrappers were restored first");
  const lastCli = after.map((c, i) => (c.op === "cli" && ["add", "remove", "install", "update", "uninstall"].some((v) => c.args.includes(v)) ? i : -1)).filter((i) => i >= 0).pop();
  assert.ok(lastCli !== undefined && lastCli < after.indexOf(start), "the plugins were restored first");
  assert.match(fs.readFileSync(path.join(world.home, ".rokid-coder", "env"), "utf8"), /^export PATH=/m);
});

test("plugin_rollback_between_releases_restores_registration_and_content", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  world.cli("codex");
  const b1 = world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1", forwarder: "// forwarder one\n" });
  const b2 = world.bundle("1.0.0-test.2", { pluginVersion: "1.0.2", forwarder: "// forwarder two\n" });
  assert.equal(world.install(b1).status, 0);
  const upgraded = world.install(b2, {}, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } });
  assert.equal(upgraded.status, 1, upgraded.output);
  for (const tool of ["claude", "codex"]) {
    const state = world.cliState(tool);
    assert.equal(state.marketplaces["rokid-coder"].path, path.join(b1, "plugins"), tool);
    const plugin = state.plugins["rokid@rokid-coder"];
    assert.equal(plugin.version, "1.0.1", tool);
    assert.equal(fs.readFileSync(path.join(plugin.installPath, "bin", "hook-forward.js"), "utf8"), "// forwarder one\n", tool);
  }
});

test("rollback_restores_previous_install", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  assert.equal(world.install(b1).status, 0);
  const none = world.run(["rollback"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /no previous install to roll back to/);

  const b2 = world.bundle("1.0.0-test.2", { pluginVersion: "1.0.2" });
  assert.equal(world.install(b2).status, 0);
  const run = world.run(["rollback"]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /Rolled back to 1\.0\.0-test\.1\n/);
  const health = await world.health();
  assert.equal(health.agentdVersion, "1.0.0-test.1");
  assert.ok(insideBundle(health, b1));
  assert.match(fs.readFileSync(path.join(world.home, ".rokid-coder", "bin", "agentd"), "utf8"), /1\.0\.0-test\.1\/bin\/agentd/);
  assert.equal(world.cliState("claude").marketplaces["rokid-coder"].path, path.join(b1, "plugins"));
  assert.equal(world.cliState("claude").plugins["rokid@rokid-coder"].version, "1.0.1");
  assert.equal(world.manifest().version, "1.0.0-test.1");

  fs.rmSync(b1, { recursive: true });
  assert.equal(world.install(b2).status, 0);
  const gone = world.run(["rollback"]);
  assert.equal(gone.status, 1);
  assert.match(gone.stderr, /previous version's files are gone/);
});

test("snapshot_taken_only_after_quiesce", async (t) => {
  const writes = (w) => path.join(w.home, ".rokid-coder", "agent-writes.txt");
  const world = makeWorld(t);
  world.scenario({ daemonWrites: writes(world) });
  await world.seed08();
  await world.legacy08({ claude: world.cli("claude") });
  // The old agent is writing state right now.
  const first = fs.readFileSync(writes(world), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual(fs.readFileSync(writes(world), "utf8"), first);

  assert.equal(world.install(world.bundle("1.0.0-test.1"), CONSENT).status, 0);
  const snapshot = world.manifest().previous.snapshot;
  const afterStop = fs.readFileSync(writes(world), "utf8");
  assert.equal(fs.readFileSync(path.join(snapshot, "files", "state", "agent-writes.txt"), "utf8"), afterStop);
});

test("rerun_after_crash_completes_open_journal_undo", async (t) => {
  const { world, before, legacy } = await on080(t);
  const bundle = world.bundle("1.0.0-test.1");
  const crashed = world.install(bundle, CONSENT, { extraEnv: { ROKID_SETUP_CRASH_AT: "8" } });
  assert.equal(crashed.status, 70);
  assert.equal(world.journal().open, true);
  assert.ok(!fs.existsSync(legacy.plist));

  world.clearCalls();
  const rerun = world.install(bundle, CONSENT);
  assert.equal(rerun.status, 0, rerun.output);
  assert.match(rerun.stdout, /An earlier setup did not finish\. Undoing it first\.\n[\s\S]*Rolled back to your 0\.8\.0 setup\n[\s\S]*Rokid Coder 1\.0\.0-test\.1 is installed\./);
  const ops = world.calls().filter((c) => c.op !== "cli").map((c) => c.op);
  assert.deepEqual(ops.slice(0, 3), ["restoreLegacyAutostart", "startLegacyAutostart", "daemon_started"], "the undo ran first");
  assert.ok(ops.indexOf("retireLegacyAutostart") > 2);
  assert.deepEqual(world.stateBytes(), before);
  assert.equal(world.journal().open, false);
});

test("fresh_install_cli_installed_outside_path_reaches_daemon_env", async (t) => {
  const world = makeWorld(t);
  const vendor = world.cli("claude", { dir: path.join(world.root, "vendor") });
  const curlDir = path.join(world.tools, "curl-bin");
  fs.mkdirSync(curlDir, { recursive: true });
  // The vendor's `curl ... | bash` installer, faked: it drops claude into ~/.local/bin.
  fs.writeFileSync(path.join(curlDir, "curl"), `#!/bin/sh\necho 'mkdir -p "$HOME/.local/bin" && cp "${vendor}" "$HOME/.local/bin/claude"'\n`, { mode: 0o755 });
  world.env.PATH = `${curlDir}:/usr/bin:/bin`;
  const run = world.install(world.bundle("1.0.0-test.1"), { cli: { claude: "install", codex: "skip" } });
  assert.equal(run.status, 0, run.output);
  const local = path.join(world.home, ".local", "bin");
  assert.equal(world.manifest().clis.claude.path, path.join(local, "claude"));
  assert.ok(fs.readFileSync(path.join(world.home, ".rokid-coder", "env"), "utf8").includes(local));
  assert.ok((await world.health()).path.split(":").includes(local), "the daemon runs with that dir on PATH");
  assert.equal(world.manifest().plugins.claude.status, "ok");
});

test("failed_recovery_stays_open_and_setup_stops_until_restore_succeeds", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  assert.equal(world.install(b1).status, 0);
  const b2 = world.bundle("1.0.0-test.2", { pluginVersion: "1.0.2" });
  // The previous bundle's plugins are gone, so the claude registration cannot be put back.
  fs.rmSync(path.join(b1, "plugins"), { recursive: true });

  const failed = world.install(b2, {}, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } });
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.stdout, /restoring the claude plugin: /);
  assert.doesNotMatch(failed.stdout, /Rolled back to/);
  assert.equal(world.journal().open, true, "the undo can be retried");

  world.clearCalls();
  const blocked = world.install(b2);
  assert.equal(blocked.status, 1, blocked.output);
  assert.match(blocked.stdout, /An earlier setup did not finish\. Undoing it first\.\n[\s\S]*restoring the claude plugin: /);
  assert.match(blocked.stderr, /The earlier setup could not be undone, so this one did not start/);
  assert.ok(!world.calls().some((c) => c.op === "installAutostart" && c.version === "1.0.0-test.2"), "nothing of this run started");
  assert.equal(world.journal().open, true);
  assert.equal(world.manifest().version, "1.0.0-test.1");

  world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  const retried = world.install(b2);
  assert.equal(retried.status, 0, retried.output);
  assert.match(retried.stdout, /Rolled back to 1\.0\.0-test\.1\n[\s\S]*Rokid Coder 1\.0\.0-test\.2 is installed\./);
  assert.equal(world.journal().open, false);
  assert.equal(world.manifest().version, "1.0.0-test.2");
});

test("failed_rollback_keeps_the_current_manifest_for_a_retry", async (t) => {
  const world = makeWorld(t);
  world.cli("claude");
  const b1 = world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  assert.equal(world.install(b1).status, 0);
  const b2 = world.bundle("1.0.0-test.2", { pluginVersion: "1.0.2" });
  assert.equal(world.install(b2).status, 0);
  fs.rmSync(path.join(b1, "plugins"), { recursive: true });

  const failed = world.run(["rollback"]);
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.stdout, /restoring the claude plugin: /);
  assert.match(failed.stdout, /The rollback to 1\.0\.0-test\.1 did not finish/);
  assert.equal(world.manifest().version, "1.0.0-test.2", "the manifest is not replaced after a failed restore");
  assert.equal(world.manifest().previous.version, "1.0.0-test.1");

  world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  const retried = world.run(["rollback"]);
  assert.equal(retried.status, 0, retried.output);
  assert.match(retried.stdout, /Rolled back to 1\.0\.0-test\.1\n/);
  assert.equal(world.manifest().version, "1.0.0-test.1");
  assert.equal(world.cliState("claude").plugins["rokid@rokid-coder"].version, "1.0.1");
});

test("npm_cli_plugin_commands_run_with_its_resolved_node_including_recovery", async (t) => {
  // An npm claude (a `#!/usr/bin/env node` script) whose node only the login shell finds: setup's own PATH has none.
  const nodeDir = path.dirname(NODE);
  const world = makeWorld(t, { loginPath: [nodeDir, "/usr/bin", "/bin"] });
  world.cli("claude", { npm: true });
  const b1 = world.bundle("1.0.0-test.1", { pluginVersion: "1.0.1" });
  const first = world.install(b1);
  assert.equal(first.status, 0, first.output);
  assert.equal(world.manifest().plugins.claude.status, "ok", first.output);
  assert.equal(world.manifest().clis.claude.interpreter, path.join(nodeDir, "node"));
  assert.equal(world.cliState("claude").plugins["rokid@rokid-coder"].version, "1.0.1");

  // A failed upgrade's recovery puts the registration back through the same CLI.
  const b2 = world.bundle("1.0.0-test.2", { pluginVersion: "1.0.2" });
  const failed = world.install(b2, {}, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } });
  assert.equal(failed.status, 1, failed.output);
  assert.doesNotMatch(failed.output, /restoring the claude plugin/);
  assert.equal(world.cliState("claude").marketplaces["rokid-coder"].path, path.join(b1, "plugins"));

  // So do rollback, plugins sync and status, and uninstall.
  assert.equal(world.install(b2).status, 0);
  assert.equal(world.cliState("claude").plugins["rokid@rokid-coder"].version, "1.0.2");
  const back = world.run(["rollback"]);
  assert.equal(back.status, 0, back.output);
  assert.equal(world.cliState("claude").plugins["rokid@rokid-coder"].version, "1.0.1");
  const sync = world.run(["plugins", "sync", "--json"]);
  assert.equal(sync.status, 0, sync.output);
  assert.equal(JSON.parse(sync.stdout).claude.result, "ok");
  const status = world.run(["plugins", "status", "--json"]);
  assert.equal(JSON.parse(status.stdout).claude.plugin.version, "1.0.1", status.output);
  const removed = world.run(["uninstall"]);
  assert.equal(removed.status, 0, removed.output);
  assert.doesNotMatch(removed.output, /could not be removed/);
  assert.deepEqual(world.cliState("claude"), { marketplaces: {}, plugins: {} });
});

test("manual_agentd_on_ports_is_never_killed", async (t) => {
  const world = makeWorld(t);
  const manual = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
  t.after(() => manual.kill());
  world.scenario({ others: [{ port: 8791, pid: manual.pid, exe: "/usr/local/bin/node" }] });
  const run = world.install(world.bundle("1.0.0-test.1"));
  assert.equal(run.status, 1, run.output);
  assert.match(run.stdout, new RegExp(`Stop the agentd running in another terminal \\(pid ${manual.pid}\\), then press Enter`));
  assert.ok(alive(manual.pid), "it is still running");
  assert.equal(world.manifest(), undefined);
  assert.equal(world.journal(), undefined, "nothing was started");
});

test("install_completes_with_neither_cli", async (t) => {
  const world = makeWorld(t);
  const run = world.install(world.bundle("1.0.0-test.1"), { cli: { claude: "skip", codex: "skip" } });
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /Neither Claude Code nor Codex is installed/);
  assert.match(run.stdout, /Pair your phone whenever you are ready: run ~\/\.rokid-coder\/bin\/agentd pair/);
  assert.match(run.stdout, /https:\/\/tailscale\.com\/download/);
  assert.deepEqual(world.manifest().clis, {});
  assert.deepEqual(world.manifest().plugins, {});
  assert.equal(world.manifest().previous, undefined);
  assert.equal((await world.health()).agentdVersion, "1.0.0-test.1");
});

test("setup_never_edits_cli_config_files_directly", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  fs.mkdirSync(path.join(world.home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(world.home, ".codex", "config.toml"), 'model = "gpt-5"\n');
  fs.mkdirSync(path.join(world.home, ".claude", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(world.home, ".claude", "plugins", "known_marketplaces.json"), "{}\n");
  world.cli("claude");
  world.cli("codex");
  const watched = [".claude", ".codex"].map((d) => path.join(world.home, d));
  const before = watched.map((d) => treeBytes(d));
  const events = [];
  const watchers = watched.map((dir) => fs.watch(dir, { recursive: true }, (_event, name) => events.push(`${path.basename(dir)}/${name}`)));
  t.after(() => watchers.forEach((w) => w.close()));

  assert.equal(world.install(world.bundle("1.0.0-test.1"), { legacy: { removeInstallHooks: true } }).status, 0);
  assert.equal(world.run(["plugins", "sync", "--json"]).status, 0);
  assert.equal(world.run(["plugins", "remove"]).status, 0);
  assert.equal(world.run(["uninstall"]).status, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));

  for (const name of events) {
    assert.match(name, /^\.claude\/settings\.json/, `only uninstallHooks writes there: ${name}`);
  }
  const [claudeAfter, codexAfter] = watched.map((d) => treeBytes(d));
  assert.deepEqual(codexAfter, before[1], "~/.codex is untouched");
  const changed = Object.keys({ ...before[0], ...claudeAfter }).filter((rel) => before[0][rel] !== claudeAfter[rel]);
  assert.equal(changed.filter((rel) => rel !== "settings.json" && !rel.startsWith("settings.json.agentd-backup-")).length, 0, changed.join(", "));
});

test("cli_installed_syncs_that_tool_and_refreshes_daemon_env", async (t) => {
  const world = makeWorld(t);
  assert.equal(world.install(world.bundle("1.0.0-test.1"), { cli: { claude: "skip", codex: "skip" } }).status, 0);
  const codex = world.cli("codex");
  world.clearCalls();
  const run = world.run(["cli-installed", "--tool", "codex", "--json"]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(JSON.parse(run.stdout), { codex: { result: "ok" } });
  assert.equal(world.cliState("codex").plugins["rokid@rokid-coder"].version, "1.0.0-test.1");
  assert.deepEqual(world.cliCalls("claude"), [], "only that tool");
  const ops = world.calls().filter((c) => c.op !== "cli").map((c) => c.op);
  assert.ok(ops.includes("refreshDaemonEnv"));
  assert.ok(fs.readFileSync(path.join(world.home, ".rokid-coder", "env"), "utf8").includes(path.dirname(codex)));
  assert.ok((await world.health()).path.split(":").includes(path.dirname(codex)), "agentd restarted with the new PATH");
  assert.deepEqual(world.manifest().clis.codex.path, codex);
  assert.equal(world.manifest().plugins.codex.status, "ok");
});

test("setup_output_never_contains_secrets", async (t) => {
  const { world, secrets } = await on080(t);
  const bundle = world.bundle("1.0.0-test.1");
  const runs = [
    world.install(bundle, CONSENT, { extraEnv: { ROKID_SETUP_FAIL_AT: "9" } }),
    world.install(bundle, CONSENT),
    world.run(["plugins", "status", "--json"]),
    world.run(["plugins", "sync"]),
    world.install(world.bundle("1.0.0-test.2"), CONSENT),
    world.run(["rollback"]),
  ];
  const rc = path.join(world.home, ".rokid-coder");
  const captured = [
    ...runs.map((r) => r.output),
    fs.readFileSync(path.join(rc, "setup-journal.json"), "utf8"),
    fs.readFileSync(path.join(rc, "install.json"), "utf8"),
    fs.readFileSync(path.join(rc, "logs", "setup.log"), "utf8"),
  ].join("\n");
  const forms = (fp) => [fp, fp.replace(/:/g, ""), fp.replace(/:/g, "").toLowerCase()];
  for (const secret of [secrets.token, secrets.steer, ...forms(secrets.pinFp), ...forms(secrets.certFp)]) {
    assert.ok(!captured.includes(secret), "a secret reached setup output");
  }
});
