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
