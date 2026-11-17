const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld } = require("./fixtures/plugin-cli/harness");
const os = require("node:os");
const { createDriver, syncPlugin, removePlugin, restorePlugin, helpCommands } = require("../dist/setup/plugins.js");

const options = (world) => ({ home: world.home, env: world.env });
const RECORDED = path.join(__dirname, "fixtures", "plugin-cli", "recorded");
/** One help screen of a recorded capture: from the line that starts it to the next capture's first line. */
function recordedHelp(file, first, next) {
  const text = fs.readFileSync(path.join(RECORDED, file), "utf8");
  const start = text.indexOf(first);
  assert.ok(start >= 0, `${file} has ${first}`);
  const end = next ? text.indexOf(next, start + first.length) : -1;
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

test("help_commands_parse_recorded_help_with_wrapped_descriptions", () => {
  const claude = recordedHelp("claude-plugin-help.txt", "Usage: claude plugin|plugins", "Usage: claude plugin install");
  assert.deepEqual([...helpCommands(claude)].sort(), [
    "autoremove", "configure", "details", "disable", "enable", "eval", "help", "i", "init", "install", "list",
    "marketplace", "new", "prune", "remove", "tag", "uninstall", "update", "validate",
  ]);
  const marketplace = recordedHelp("claude-plugin-help.txt", "Usage: claude plugin marketplace");
  assert.deepEqual([...helpCommands(marketplace)].sort(), ["add", "help", "list", "remove", "rm", "update"]);
  // The whole capture: the command list ends at the next unindented line, not inside a wrapped description.
  assert.deepEqual(helpCommands(fs.readFileSync(path.join(RECORDED, "claude-plugin-help.txt"), "utf8")), helpCommands(claude));

  const codexTop = recordedHelp("codex-help.txt", "Codex CLI", "Manage Codex plugins\n\nUsage");
  const top = helpCommands(codexTop);
  assert.ok(top.has("plugin") && top.has("apply") && top.has("fork") && top.has("help"), [...top].join(" "));
  assert.ok(!top.has("working") && !top.has("the"), "a wrapped description line is not a command");
  const codex = recordedHelp("codex-help.txt", "Manage Codex plugins\n\nUsage");
  assert.deepEqual([...helpCommands(codex)].sort(), ["add", "help", "list", "marketplace", "remove"]);
});

test("plugins_sync_installs_both_and_is_idempotent", async (t) => {
  const world = makeWorld(t);
  const bundle = world.bundle("1.0.0-test.1");
  const marketplace = path.join(bundle, "plugins");
  for (const tool of ["claude", "codex"]) {
    const driver = createDriver(tool, world.cli(tool), options(world));
    const first = await syncPlugin(driver, marketplace);
    assert.equal(first.result, "ok", JSON.stringify(first));
    assert.deepEqual(first.prior, {}, "nothing was registered before");
    assert.equal(first.record.pluginVersion, "1.0.0-test.1");
    const state = world.cliState(tool);
    assert.equal(state.marketplaces["rokid-coder"].path, marketplace, "the bundle's own plugins/ dir, not a copy");
    assert.equal(state.plugins["rokid@rokid-coder"].version, "1.0.0-test.1");
    assert.ok(world.mutatingCalls(tool).length > 0);

    world.clearCliCalls(tool);
    const second = await syncPlugin(createDriver(tool, world.cli(tool), options(world)), marketplace);
    assert.equal(second.result, "ok");
    assert.deepEqual(world.mutatingCalls(tool), [], `${tool}: a second sync only reads`);
  }
});

test("plugins_sync_repoints_foreign_marketplace_and_records_old_source", async (t) => {
  const world = makeWorld(t);
  const claude = world.cli("claude");
  const { repo } = await world.legacy08({ running: false, claude });
  const bundle = world.bundle("1.0.0-test.1");
  const outcome = await syncPlugin(createDriver("claude", claude, options(world)), path.join(bundle, "plugins"));
  assert.equal(outcome.result, "ok", JSON.stringify(outcome));
  assert.deepEqual(outcome.prior, { source: repo, pluginVersion: "0.8.0" }, "the 0.8.0 checkout's registration is recorded");
  const state = world.cliState("claude");
  assert.equal(state.marketplaces["rokid-coder"].path, path.join(bundle, "plugins"));
  assert.equal(state.plugins["rokid@rokid-coder"].version, "1.0.0-test.1");
  const verbs = world.mutatingCalls("claude").map((args) => args.slice(1, 3).join(" "));
  assert.deepEqual(verbs.slice(0, 2), ["marketplace remove", "marketplace add"], "re-pointed: removed, then added from the bundle");
});

test("plugins_sync_manual_step_when_cli_has_no_install_verb", async (t) => {
  const world = makeWorld(t);
  assert.ok(!helpCommands(fs.readFileSync(path.join(__dirname, "fixtures", "plugin-cli", "codex-0.169.0-noinstall", "plugin-help.txt"), "utf8")).has("add"));
  const bundle = world.bundle("1.0.0-test.1");
  const codex = world.cli("codex", { fixture: "codex-noinstall" });
  const outcome = await syncPlugin(createDriver("codex", codex, options(world)), path.join(bundle, "plugins"));
  assert.equal(outcome.result, "manual_step_required");
  assert.equal(outcome.record.detail, "In Codex, open /plugins and install Rokid-Coder");
  assert.equal(world.cliState("codex").marketplaces["rokid-coder"].path, path.join(bundle, "plugins"), "the marketplace is registered");
  assert.ok(!world.cliCalls("codex").some((args) => args[1] === "install" || args[1] === "add"), "no install verb is guessed");
});

test("plugins_remove_only_removes_our_marketplace", async (t) => {
  const world = makeWorld(t);
  const claude = world.cli("claude");
  const { repo } = await world.legacy08({ running: false, claude });
  const bundle = world.bundle("1.0.0-test.1");
  const roots = [bundle, path.dirname(bundle)];
  assert.equal(await removePlugin(createDriver("claude", claude, options(world)), roots), false);
  assert.equal(world.cliState("claude").marketplaces["rokid-coder"].path, repo, "a developer's checkout stays registered");
  assert.ok(world.cliState("claude").plugins["rokid@rokid-coder"]);

  const codex = world.cli("codex");
  assert.equal((await syncPlugin(createDriver("codex", codex, options(world)), path.join(bundle, "plugins"))).result, "ok");
  assert.equal(await removePlugin(createDriver("codex", codex, options(world)), roots), true);
  assert.deepEqual(world.cliState("codex"), { marketplaces: {}, plugins: {} });
  const order = world.mutatingCalls("codex").slice(-2).map((args) => args.slice(1, 3).join(" "));
  assert.deepEqual(order, ["remove rokid@rokid-coder", "marketplace remove"], "the plugin first, then its marketplace");
});

test("plugin_cli_fixtures_are_the_recorded_help", () => {
  const fixture = (dir, file) => fs.readFileSync(path.join(__dirname, "fixtures", "plugin-cli", dir, file), "utf8");
  const meta = (dir) => JSON.parse(fixture(dir, "meta.json"));
  assert.equal(fixture("claude-2.1.285", "plugin-help.txt"), recordedHelp("claude-plugin-help.txt", "Usage: claude plugin|plugins", "Usage: claude plugin install"));
  assert.equal(fixture("claude-2.1.285", "marketplace-help.txt"), recordedHelp("claude-plugin-help.txt", "Usage: claude plugin marketplace"));
  assert.equal(fixture("codex-0.169.0", "plugin-help.txt"), recordedHelp("codex-help.txt", "Manage Codex plugins\n\nUsage"));
  for (const [dir, file] of [["claude-2.1.285", "claude-plugin-help.txt"], ["codex-0.169.0", "codex-help.txt"]]) {
    assert.equal(meta(dir).versionOutput, fs.readFileSync(path.join(RECORDED, file), "utf8").split("\n")[0]);
    assert.equal(meta(dir).recorded, true, dir);
    assert.equal(meta(dir).listJsonRecorded, false, `${dir}: the marketplace list --json shape waits for the device gate`);
  }
  assert.equal(meta("codex-0.169.0").pluginListJsonRecorded, true);
  assert.equal(meta("claude-2.1.285").pluginListJsonRecorded, undefined);
  assert.equal(meta("codex-0.169.0").marketplaceHelpRecorded, false);
});

test("plugins_each_cli_runs_its_own_verbs", async (t) => {
  const world = makeWorld(t);
  const bundle = world.bundle("1.0.0-test.1");
  const roots = [bundle, path.dirname(bundle)];
  const verbs = {};
  for (const tool of ["claude", "codex"]) {
    const cli = world.cli(tool);
    assert.equal((await syncPlugin(createDriver(tool, cli, options(world)), path.join(bundle, "plugins"))).result, "ok", tool);
    assert.equal(await removePlugin(createDriver(tool, cli, options(world)), roots), true, tool);
    verbs[tool] = world.mutatingCalls(tool).filter((args) => args[1] !== "marketplace").map((args) => args.slice(1).join(" "));
  }
  assert.deepEqual(verbs.claude, ["install rokid@rokid-coder", "uninstall rokid@rokid-coder"]);
  assert.deepEqual(verbs.codex, ["add rokid@rokid-coder", "remove rokid@rokid-coder"]);
});

// What `plugin list --json` and `plugin marketplace list --json` may look like: each shape reads, garbage does not.

const SHAPES = path.join(__dirname, "fixtures", "plugin-cli", "list-shapes");
const CODEX_FIXTURE = path.join(__dirname, "fixtures", "plugin-cli", "codex-0.169.0");

/** A `codex` that answers the three read-only calls with the given raw outputs. */
function fixedCli(t, { plugins, marketplaces = '{"marketplaces":[]}' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-shape-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "plugins.out"), plugins);
  fs.writeFileSync(path.join(dir, "marketplaces.out"), marketplaces);
  const cli = path.join(dir, "codex");
  fs.writeFileSync(
    cli,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2).join(" ");
const out = (file) => process.stdout.write(fs.readFileSync(${JSON.stringify(dir)} + "/" + file, "utf8"));
if (args === "plugin --help") process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(CODEX_FIXTURE, "plugin-help.txt"))}, "utf8"));
else if (args === "plugin marketplace list --json") out("marketplaces.out");
else if (args === "plugin list --json") out("plugins.out");
else { process.stderr.write("unexpected " + args); process.exit(2); }
`,
    { mode: 0o755 },
  );
  return cli;
}

const shape = (name) => fs.readFileSync(path.join(SHAPES, `${name}.json`), "utf8");
const statusOf = (t, outputs) => createDriver("codex", fixedCli(t, outputs), { home: os.tmpdir(), env: process.env }).status();

test("plugin_list_shapes_each_read_as_installed_or_not", async (t) => {
  const installed = (status) => status.plugin?.version;
  assert.equal(installed(await statusOf(t, { plugins: shape("top-level-array") })), "1.0.0");
  assert.equal(installed(await statusOf(t, { plugins: shape("plugins-key") })), "1.0.0");
  assert.equal(installed(await statusOf(t, { plugins: shape("marketplaces-nested") })), "1.0.0");
  assert.equal(installed(await statusOf(t, { plugins: shape("keyed-by-id") })), "1.0.0");
  assert.equal(installed(await statusOf(t, { plugins: shape("available-entry-marked-installed") })), "1.0.0");
  // Offered by a marketplace, not installed.
  assert.equal(installed(await statusOf(t, { plugins: shape("installed-and-available") })), undefined);
  assert.equal(installed(await statusOf(t, { plugins: '{"installed":[]}' })), undefined);
  assert.equal(installed(await statusOf(t, { plugins: "[]" })), undefined);
});

test("the_real_codex_0_169_0_plugin_list_reads_our_plugin_and_its_marketplace", async (t) => {
  const real = fs.readFileSync(path.join(CODEX_FIXTURE, "plugin-list.json"), "utf8");
  const status = await statusOf(t, { plugins: real });
  assert.equal(status.plugin.version, "1.0.0");
  assert.equal(status.plugin.installPath, undefined, "source.path is the marketplace's copy, not the installed one");
  assert.equal(status.marketplace.source, "/Users/alex/Library/Application Support/RokidCoder/1.0.0/plugins");
  // Another marketplace's plugin of the same name is not ours.
  const other = JSON.parse(real);
  other.installed[1].marketplaceName = "someone-else";
  other.installed[1].pluginId = "rokid@someone-else";
  assert.equal((await statusOf(t, { plugins: JSON.stringify(other) })).plugin, undefined);
});

test("marketplace_list_shapes_give_the_source_of_ours", async (t) => {
  const source = "/Users/alex/market";
  const plugins = "[]";
  for (const marketplaces of [
    JSON.stringify([{ name: "rokid-coder", path: source }]),
    JSON.stringify({ marketplaces: [{ name: "rokid-coder", source: { source: "local", path: source } }] }),
    JSON.stringify({ marketplaces: [{ name: "rokid-coder", marketplaceSource: { sourceType: "local", source } }] }),
    JSON.stringify({ installed: [{ marketplaceName: "rokid-coder", source }] }),
    JSON.stringify({ marketplaces: { "rokid-coder": { source } } }),
  ]) {
    assert.equal((await statusOf(t, { plugins, marketplaces })).marketplace?.source, source, marketplaces);
  }
  assert.equal((await statusOf(t, { plugins, marketplaces: JSON.stringify({ marketplaces: [{ name: "other", path: source }] }) })).marketplace, undefined);
});

test("plugin_list_garbage_is_refused", async (t) => {
  for (const plugins of ["not json", "null", '"text"', "{}", '{"error":"boom"}', '{"installed":"x"}', "[1,2]", '{"plugins":{"error":"boom"}}']) {
    await assert.rejects(() => statusOf(t, { plugins }), /unexpected|JSON/, plugins);
  }
  await assert.rejects(() => statusOf(t, { plugins: "[]", marketplaces: '{"error":"boom"}' }), /unexpected/);
});

// The offered plugin's whole content decides whether the installed copy is current, not its version alone.

const SOURCES = { claude: "claude-code", codex: "codex" };
const HOOKS_OLD = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node hook-forward.js" }] }] } })}\n`;
const HOOKS_NEW = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }], SubagentStart: [{ hooks: [] }] } })}\n`;

/** A synced world: both tools' plugin sources hold hooks.json and commands/on.md, and both are installed at one version. */
async function installedWorld(t, tool, fixture = tool === "codex" ? "codex-withpath" : tool) {
  const world = makeWorld(t);
  const marketplace = path.join(world.bundle("1.0.0"), "plugins");
  const source = path.join(marketplace, SOURCES[tool]);
  fs.mkdirSync(path.join(source, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(source, "commands"), { recursive: true });
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_OLD);
  fs.writeFileSync(path.join(source, "commands", "on.md"), "turn on\n");
  const cli = world.cli(tool, { fixture });
  const sync = () => syncPlugin(createDriver(tool, cli, options(world)), marketplace);
  assert.equal((await sync()).result, "ok");
  const installed = () => path.join(world.cliState(tool).plugins["rokid@rokid-coder"].installPath);
  return { world, source, sync, installed };
}

for (const tool of ["claude", "codex"]) {
  test(`plugins_${tool}_same_version_changed_hooks_json_reinstalls`, async (t) => {
    const { world, source, sync, installed } = await installedWorld(t, tool);
    fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
    assert.ok(!fs.readFileSync(path.join(installed(), "hooks", "hooks.json"), "utf8").includes("SubagentStart"));
    world.clearCliCalls(tool);
    const outcome = await sync();
    assert.equal(outcome.result, "ok", JSON.stringify(outcome));
    const verbs = world.mutatingCalls(tool).map((args) => args.slice(1).join(" "));
    assert.deepEqual(verbs, [`${tool === "claude" ? "uninstall" : "remove"} rokid@rokid-coder`, `${tool === "claude" ? "install" : "add"} rokid@rokid-coder`]);
    assert.ok(fs.readFileSync(path.join(installed(), "hooks", "hooks.json"), "utf8").includes("SubagentStart"), "the installed copy has the new event");
    // Settled: the next run only reads.
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.deepEqual(world.mutatingCalls(tool), []);
  });

  test(`plugins_${tool}_same_version_identical_content_does_not_churn`, async (t) => {
    const { world, sync } = await installedWorld(t, tool);
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.equal((await sync()).result, "ok");
    assert.deepEqual(world.mutatingCalls(tool), [], "no uninstall, install or update");
  });

  test(`plugins_${tool}_extra_file_in_installed_copy_is_not_a_difference`, async (t) => {
    const { world, sync, installed } = await installedWorld(t, tool);
    fs.writeFileSync(path.join(installed(), ".cache-note"), "added by the CLI\n");
    fs.mkdirSync(path.join(installed(), "node_modules", "x"), { recursive: true });
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.deepEqual(world.mutatingCalls(tool), []);
    assert.ok(fs.existsSync(path.join(installed(), ".cache-note")), "left alone");
  });

  test(`plugins_${tool}_changed_command_file_reinstalls`, async (t) => {
    const { world, source, sync, installed } = await installedWorld(t, tool);
    fs.writeFileSync(path.join(source, "commands", "on.md"), "turn on, louder\n");
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.equal(world.mutatingCalls(tool).length, 2, "uninstall then install");
    assert.equal(fs.readFileSync(path.join(installed(), "commands", "on.md"), "utf8"), "turn on, louder\n");
  });

  test(`plugins_${tool}_new_and_removed_offered_files_reinstall`, async (t) => {
    const { world, source, sync, installed } = await installedWorld(t, tool);
    fs.writeFileSync(path.join(source, "commands", "off.md"), "turn off\n");
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.equal(world.mutatingCalls(tool).length, 2);
    assert.ok(fs.existsSync(path.join(installed(), "commands", "off.md")));
    // A file the installed copy lacks (deleted behind the CLI's back) also reinstalls.
    fs.rmSync(path.join(installed(), "commands", "off.md"));
    world.clearCliCalls(tool);
    assert.equal((await sync()).result, "ok");
    assert.equal(world.mutatingCalls(tool).length, 2);
    assert.ok(fs.existsSync(path.join(installed(), "commands", "off.md")));
  });
}

test("plugins_codex_without_install_path_trusts_the_version", async (t) => {
  // The recorded codex list says where the marketplace is, not where the installed copy is.
  const { world, source, sync } = await installedWorld(t, "codex", "codex");
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
  world.clearCliCalls("codex");
  assert.equal((await sync()).result, "ok");
  assert.deepEqual(world.mutatingCalls("codex"), [], "no installed path to compare, so the version is trusted");
});

test("plugin_content_digest_covers_every_file_and_skips_noise", (t) => {
  const { pluginFiles, contentDigest } = require("../dist/setup/plugins.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-digest-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "a"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a", "x.json"), "1");
  fs.writeFileSync(path.join(dir, "y.md"), "2");
  const base = contentDigest(pluginFiles(dir));
  assert.deepEqual(Object.keys(pluginFiles(dir)), ["a/x.json", "y.md"]);
  // Skipped: node_modules, .git, .DS_Store, symlinks.
  fs.mkdirSync(path.join(dir, "node_modules", "m"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "m", "i.js"), "3");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "HEAD"), "4");
  fs.writeFileSync(path.join(dir, ".DS_Store"), "5");
  fs.symlinkSync(path.join(dir, "y.md"), path.join(dir, "link.md"));
  assert.equal(contentDigest(pluginFiles(dir)), base);
  fs.writeFileSync(path.join(dir, "a", "x.json"), "changed");
  assert.notEqual(contentDigest(pluginFiles(dir)), base);
});

// A reported install path that is gone is a difference, and a reinstall must not switch a disabled plugin back on.

const PLUGIN = "rokid@rokid-coder";
const stateFile = (world, tool) => path.join(world.home, ".fake-plugin-cli", tool, "state.json");
/** Marks the installed plugin enabled or disabled in the fake CLI's own state (as the user's `plugin disable` would). */
function setEnabled(world, tool, enabled) {
  const state = world.cliState(tool);
  state.plugins[PLUGIN].enabled = enabled;
  fs.writeFileSync(stateFile(world, tool), JSON.stringify(state));
}
const isEnabled = (world, tool) => world.cliState(tool).plugins[PLUGIN].enabled !== false;
const disableCalls = (world, tool) => world.cliCalls(tool).filter((args) => args[1] === "disable");

for (const tool of ["claude", "codex"]) {
  test(`plugins_${tool}_reported_install_path_that_is_missing_reinstalls`, async (t) => {
    const { world, sync, installed } = await installedWorld(t, tool);
    fs.rmSync(installed(), { recursive: true, force: true });
    world.clearCliCalls(tool);
    const outcome = await sync();
    assert.equal(outcome.result, "ok", JSON.stringify(outcome));
    assert.equal(world.mutatingCalls(tool).length, 2, "uninstall then install");
    assert.ok(fs.existsSync(path.join(installed(), "hooks", "hooks.json")));
  });
}

test("plugins_claude_disabled_plugin_stays_disabled_after_a_same_version_refresh", async (t) => {
  const { world, source, sync } = await installedWorld(t, "claude");
  setEnabled(world, "claude", false);
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
  world.clearCliCalls("claude");
  const outcome = await sync();
  assert.equal(outcome.result, "ok", JSON.stringify(outcome));
  assert.equal(outcome.warning, undefined);
  assert.equal(outcome.prior.enabled, false, "the prior registration records that it was off");
  assert.equal(world.mutatingCalls("claude").filter((args) => args[1] !== "disable").length, 2, "refreshed");
  assert.deepEqual(disableCalls(world, "claude"), [["plugin", "disable", PLUGIN]], "turned off again by the CLI's own verb");
  assert.equal(isEnabled(world, "claude"), false);
});

test("plugins_claude_enabled_plugin_stays_enabled_and_is_never_disabled", async (t) => {
  const { world, source, sync } = await installedWorld(t, "claude");
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
  world.clearCliCalls("claude");
  const outcome = await sync();
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.warning, undefined);
  assert.equal(outcome.prior.enabled, undefined);
  assert.deepEqual(disableCalls(world, "claude"), []);
  assert.equal(isEnabled(world, "claude"), true);
});

test("plugins_claude_disabled_plugin_with_current_content_is_left_alone", async (t) => {
  const { world, sync } = await installedWorld(t, "claude");
  setEnabled(world, "claude", false);
  world.clearCliCalls("claude");
  const outcome = await sync();
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.warning, undefined);
  assert.deepEqual(world.mutatingCalls("claude"), []);
  assert.equal(isEnabled(world, "claude"), false);
});

test("plugins_a_cli_without_a_disable_verb_warns_that_the_plugin_is_enabled_again", async (t) => {
  const { world, source, sync } = await installedWorld(t, "codex");
  setEnabled(world, "codex", false);
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
  const outcome = await sync();
  assert.equal(outcome.result, "ok");
  assert.equal(outcome.warning, "The Rokid plugin was disabled before this update; it is enabled again - disable it in /plugins if you want it off");
  assert.deepEqual(disableCalls(world, "codex"), [], "no disable verb is guessed");
  assert.equal(outcome.prior.enabled, false);
});

test("plugins_a_failing_disable_verb_warns_rather_than_leaving_the_plugin_silently_enabled", async (t) => {
  const { world, source, sync } = await installedWorld(t, "claude");
  setEnabled(world, "claude", false);
  fs.writeFileSync(path.join(source, "hooks", "hooks.json"), HOOKS_NEW);
  // The login shell's `claude` stays; make `disable` fail by pointing the driver at a wrapper that refuses it.
  const cli = world.cli("claude");
  const real = fs.readFileSync(cli, "utf8");
  fs.writeFileSync(cli, `#!/bin/sh\n[ "$2" = disable ] && { echo "boom" >&2; exit 1; }\n${real.split("\n").slice(1).join("\n")}`, { mode: 0o755 });
  const outcome = await sync();
  assert.equal(outcome.result, "ok");
  assert.match(outcome.warning, /disabled before this update; it is enabled again - disable it in \/plugin/);
});

test("plugins_restore_puts_a_disabled_plugin_back_disabled", async (t) => {
  const { world, source, installed } = await installedWorld(t, "claude");
  const marketplace = path.dirname(source);
  const driver = createDriver("claude", world.cli("claude"), options(world));
  const roots = [path.dirname(path.dirname(marketplace))];
  const prior = { source: marketplace, pluginVersion: "1.0.0", enabled: false };
  assert.equal(isEnabled(world, "claude"), true);
  await restorePlugin(driver, prior, roots);
  assert.equal(isEnabled(world, "claude"), false);
  // Already as it was: nothing more to do, and an enabled prior is never disabled.
  world.clearCliCalls("claude");
  await restorePlugin(driver, prior, roots);
  assert.deepEqual(world.mutatingCalls("claude"), []);
  setEnabled(world, "claude", true);
  await restorePlugin(driver, { source: marketplace, pluginVersion: "1.0.0" }, roots);
  assert.deepEqual(disableCalls(world, "claude"), [], "an enabled prior is never disabled");
  assert.ok(fs.existsSync(installed()));
});

test("plugins_restore_says_so_when_it_cannot_disable_again", async (t) => {
  const { world, source } = await installedWorld(t, "codex");
  const marketplace = path.dirname(source);
  const driver = createDriver("codex", world.cli("codex", { fixture: "codex-withpath" }), options(world));
  await assert.rejects(() => restorePlugin(driver, { source: marketplace, pluginVersion: "1.0.0", enabled: false }, [path.dirname(path.dirname(marketplace))]), /could not keep it disabled/);
});

// A failed reinstall must not leave the user with a silent gap, and an extra read that fails is only a warning.

/**
 * Wraps a fake CLI: `fail(args, n)` (n counts the calls with the same verb) decides whether a call fails
 * with a transient-looking error before it reaches the fake.
 */
function flakyCli(world, tool, failures) {
  const real = world.cli(tool, { fixture: tool === "codex" ? "codex-withpath" : tool });
  const inner = `${real}.real`;
  fs.renameSync(real, inner);
  const counts = path.join(world.root, `${tool}-counts`);
  fs.mkdirSync(counts, { recursive: true });
  fs.writeFileSync(
    real,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const key = args.slice(0, 2).join("_").replace(/[^a-z_]/g, "") || "x";
const file = ${JSON.stringify(counts)} + "/" + key;
const n = (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0) + 1;
fs.writeFileSync(file, String(n));
const failures = ${JSON.stringify(failures)};
if ((failures[key] || []).includes(n)) { process.stderr.write("transient failure\\n"); process.exit(1); }
const r = require("node:child_process").spawnSync(${JSON.stringify(inner)}, args, { stdio: "inherit" });
process.exit(r.status === null ? 1 : r.status);
`,
    { mode: 0o755 },
  );
  return real;
}

const quickRetry = (t) => {
  const before = process.env.ROKID_SETUP_PLUGIN_RETRY_MS;
  process.env.ROKID_SETUP_PLUGIN_RETRY_MS = "0";
  t.after(() => (before === undefined ? delete process.env.ROKID_SETUP_PLUGIN_RETRY_MS : (process.env.ROKID_SETUP_PLUGIN_RETRY_MS = before)));
};

/** A world with the plugin installed, then its content changed so the next sync must reinstall. */
async function staleWorld(t, tool, failures) {
  const base = await installedWorld(t, tool);
  fs.writeFileSync(path.join(base.source, "hooks", "hooks.json"), HOOKS_NEW);
  const cli = flakyCli(base.world, tool, failures);
  const marketplace = path.dirname(base.source);
  return { ...base, marketplace, driver: () => createDriver(tool, cli, options(base.world)) };
}

for (const tool of ["claude", "codex"]) {
  const installKey = tool === "claude" ? "plugin_install" : "plugin_add";
  test(`plugins_${tool}_a_reinstall_that_fails_once_is_retried_and_succeeds`, async (t) => {
    quickRetry(t);
    const { world, driver, marketplace, installed } = await staleWorld(t, tool, { [installKey]: [1] });
    const outcome = await syncPlugin(driver(), marketplace);
    assert.equal(outcome.result, "ok", JSON.stringify(outcome));
    assert.equal(outcome.warning, undefined);
    assert.ok(fs.readFileSync(path.join(installed(), "hooks", "hooks.json"), "utf8").includes("SubagentStart"));
    assert.ok(world.cliState(tool).plugins["rokid@rokid-coder"]);
  });

  test(`plugins_${tool}_a_reinstall_that_fails_twice_says_the_plugin_is_not_installed`, async (t) => {
    quickRetry(t);
    // The retry and the put-back attempt all fail too.
    const { world, driver, marketplace } = await staleWorld(t, tool, { [installKey]: [1, 2, 3, 4, 5, 6] });
    const outcome = await syncPlugin(driver(), marketplace);
    assert.equal(outcome.result, "failed");
    assert.equal(outcome.warning, `The Rokid plugin is currently NOT installed in ${tool}. Run: rokid-setup plugins sync --tool ${tool}`);
    assert.equal(world.cliState(tool).plugins["rokid@rokid-coder"], undefined, "and that is true");
  });

  test(`plugins_${tool}_a_reinstall_that_fails_twice_but_restores_the_previous_registration_says_so`, async (t) => {
    quickRetry(t);
    // The first two installs (attempt and retry) fail, the put-back works.
    const { world, driver, marketplace } = await staleWorld(t, tool, { [installKey]: [1, 2] });
    const outcome = await syncPlugin(driver(), marketplace);
    assert.equal(outcome.result, "failed");
    assert.match(outcome.warning, /could not be updated in .*; the previous registration was put back\. Run: rokid-setup plugins sync/);
    assert.ok(world.cliState(tool).plugins["rokid@rokid-coder"], "the plugin is installed again");
  });
}

test("plugins_a_failing_enabled_state_read_after_a_good_refresh_is_a_warning_not_a_failure", async (t) => {
  const { world, source, marketplace, driver } = await staleWorld(t, "claude", { plugin_list: [3] });
  setEnabled(world, "claude", false);
  // plugin list calls: 1 the first status, 2 the verification after the reinstall, 3 the enabled-state check.
  const outcome = await syncPlugin(driver(), marketplace);
  assert.equal(outcome.result, "ok", JSON.stringify(outcome));
  assert.match(outcome.warning, /could not check whether the Rokid plugin was disabled/);
  assert.ok(fs.readFileSync(path.join(world.cliState("claude").plugins["rokid@rokid-coder"].installPath, "hooks", "hooks.json"), "utf8").includes("SubagentStart"));
  assert.ok(source);
});
