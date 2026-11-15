const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld } = require("./fixtures/plugin-cli/harness");
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
  assert.ok(!helpCommands(fs.readFileSync(path.join(__dirname, "fixtures", "plugin-cli", "codex-0.130.0-noinstall", "plugin-help.txt"), "utf8")).has("install"));
  const bundle = world.bundle("1.0.0-test.1");
  const codex = world.cli("codex", { fixture: "codex-noinstall" });
  const outcome = await syncPlugin(createDriver("codex", codex, options(world)), path.join(bundle, "plugins"));
  assert.equal(outcome.result, "manual_step_required");
  assert.equal(outcome.record.detail, "In Codex, open /plugins and install Rokid-Coder");
  assert.equal(world.cliState("codex").marketplaces["rokid-coder"].path, path.join(bundle, "plugins"), "the marketplace is registered");
  assert.ok(!world.cliCalls("codex").some((args) => args[1] === "install"), "no install verb is guessed");
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
  assert.deepEqual(order, ["uninstall rokid@rokid-coder", "marketplace remove"], "the plugin first, then its marketplace");
});
