const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld } = require("./fixtures/plugin-cli/harness");
const os = require("node:os");
const { createDriver, syncPlugin, removePlugin, helpCommands } = require("../dist/setup/plugins.js");

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
