// A stand-in for `claude` / `codex`, enough of their plugin commands for
// rokid-setup's drivers: the help and list output come from a recorded
// fixture dir, and the verbs a fixture's help lacks are refused, as the real
// CLI would. Its own state (marketplaces, installed copies, an argv log) lives
// in $HOME/.fake-plugin-cli/<tool>/, never in ~/.claude or ~/.codex, so a test
// can tell what setup itself wrote there.
//
//   node fake-plugin-cli.js <fixture dir> <args...>
const fs = require("node:fs");
const path = require("node:path");

function main(argv) {
  const [fixtureDir, ...args] = argv;
  const meta = JSON.parse(fs.readFileSync(path.join(fixtureDir, "meta.json"), "utf8"));
  const tool = meta.tool;
  const fixtureFile = (name) => {
    const own = path.join(fixtureDir, name);
    return fs.existsSync(own) || !meta.inherits ? own : path.join(fixtureDir, "..", meta.inherits, name);
  };
  const home = process.env.HOME;
  const stateDir = path.join(home, ".fake-plugin-cli", tool);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(path.join(stateDir, "calls.log"), `${JSON.stringify(args)}\n`);
  // Under the fake platform, also into its call log, so a test sees one order across both.
  if (process.env.ROKID_SETUP_FAKE_DIR) {
    fs.appendFileSync(path.join(process.env.ROKID_SETUP_FAKE_DIR, "calls.jsonl"), `${JSON.stringify({ op: "cli", tool, args })}\n`);
  }
  const stateFile = path.join(stateDir, "state.json");
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile, "utf8"))
    : { marketplaces: {}, plugins: {} };
  const save = () => fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  const out = (text) => process.stdout.write(text);
  const fail = (text, code = 1) => {
    process.stderr.write(`${text}\n`);
    process.exit(code);
  };
  const help = (name) => fs.readFileSync(fixtureFile(name), "utf8");
  const verbs = (name) => {
    const text = help(name);
    const commands = text.slice(text.indexOf("Commands:"));
    return new Set(
      [...commands.matchAll(/^ {2}([a-z][\w|-]*)/gm)].flatMap((m) => m[1].split("|")),
    );
  };
  const marketplaceManifest = (dir) =>
    tool === "claude"
      ? path.join(dir, ".claude-plugin", "marketplace.json")
      : path.join(dir, ".agents", "plugins", "marketplace.json");
  const pluginSourceDir = (marketplaceDir, pluginName) => {
    const manifest = JSON.parse(fs.readFileSync(marketplaceManifest(marketplaceDir), "utf8"));
    const entry = manifest.plugins.find((p) => p.name === pluginName);
    if (!entry) return undefined;
    const rel = typeof entry.source === "string" ? entry.source : entry.source.path;
    return path.resolve(marketplaceDir, rel);
  };
  const pluginVersion = (dir) => {
    const file = tool === "claude" ? path.join(dir, ".claude-plugin", "plugin.json") : path.join(dir, ".codex-plugin", "plugin.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version;
  };
  const copyIn = (id) => {
    const [name, marketplace] = id.split("@");
    const registered = state.marketplaces[marketplace];
    if (!registered) fail(`Marketplace '${marketplace}' not found`);
    const source = pluginSourceDir(registered.path, name);
    if (!source || !fs.existsSync(source)) fail(`Plugin '${name}' not found in marketplace '${marketplace}'`);
    const version = pluginVersion(source);
    const installPath = path.join(stateDir, "cache", marketplace, name, version);
    fs.rmSync(installPath, { recursive: true, force: true });
    fs.cpSync(source, installPath, { recursive: true });
    state.plugins[id] = { name, marketplace, version, installPath };
  };

  if (args[0] === "--version") {
    out(`${meta.versionOutput}\n`);
    return;
  }
  if (args[0] !== "plugin") fail(`fake ${tool}: only --version and plugin are implemented`, 2);
  const [, verb, ...rest] = args;
  const pluginVerbs = verbs("plugin-help.txt");
  if (verb === undefined || verb === "--help" || verb === "-h") {
    out(help("plugin-help.txt"));
    return;
  }
  if (!pluginVerbs.has(verb)) fail(`error: unknown command '${verb}'`, 2);

  if (verb === "marketplace") {
    const [sub, ...subRest] = rest;
    if (sub === undefined || sub === "--help" || sub === "-h") {
      out(help("marketplace-help.txt"));
      return;
    }
    if (!verbs("marketplace-help.txt").has(sub)) fail(`error: unknown command '${sub}'`, 2);
    if (sub === "add") {
      const dir = path.resolve(subRest[0]);
      if (!fs.existsSync(marketplaceManifest(dir))) fail(`No marketplace manifest found in ${dir}`);
      const { name } = JSON.parse(fs.readFileSync(marketplaceManifest(dir), "utf8"));
      if (state.marketplaces[name]) fail(`Marketplace '${name}' is already installed`);
      state.marketplaces[name] = { path: fs.realpathSync(dir) };
      save();
      out(`Successfully added marketplace: ${name}\n`);
    } else if (sub === "remove" || sub === "rm") {
      const name = subRest[0];
      if (!state.marketplaces[name]) fail(`Marketplace '${name}' not found`);
      delete state.marketplaces[name];
      // Removing a marketplace also drops what was installed from it.
      for (const [id, plugin] of Object.entries(state.plugins)) {
        if (plugin.marketplace === name) {
          fs.rmSync(plugin.installPath, { recursive: true, force: true });
          delete state.plugins[id];
        }
      }
      save();
      out(`Successfully removed marketplace: ${name}\n`);
    } else if (sub === "list") {
      const list = Object.entries(state.marketplaces).map(([name, m]) =>
        meta.listFormat === "array" ? { name, source: "directory", path: m.path } : { name, source: { source: "local", path: m.path } },
      );
      out(`${JSON.stringify(meta.listFormat === "array" ? list : { marketplaces: list }, null, 2)}\n`);
    } else {
      fail(`fake ${tool}: marketplace ${sub} is not implemented`, 2);
    }
    return;
  }
  const id = rest.find((arg) => !arg.startsWith("-"));
  if (verb === "install" || verb === "i") {
    if (state.plugins[id]) {
      out(`Plugin '${id}' is already installed\n`);
      return;
    }
    copyIn(id);
    save();
    out(`Successfully installed plugin: ${id}\n`);
  } else if (verb === "update") {
    const current = state.plugins[id];
    if (!current) fail(`Plugin '${id}' is not installed`);
    const source = pluginSourceDir(state.marketplaces[current.marketplace].path, current.name);
    // Like the real update, it compares versions: the same version is "up to date".
    if (pluginVersion(source) === current.version) {
      out(`Plugin '${id}' is already at the latest version\n`);
      return;
    }
    fs.rmSync(current.installPath, { recursive: true, force: true });
    copyIn(id);
    save();
    out(`Updated ${id}\n`);
  } else if (verb === "uninstall" || verb === "remove") {
    const current = state.plugins[id];
    if (!current) fail(`Plugin '${id}' is not installed`);
    fs.rmSync(current.installPath, { recursive: true, force: true });
    delete state.plugins[id];
    save();
    out(`Successfully uninstalled plugin: ${id}\n`);
  } else if (verb === "list") {
    const list = Object.entries(state.plugins).map(([pluginId, p]) =>
      meta.listFormat === "array"
        ? { id: pluginId, version: p.version, scope: "user", enabled: true, installPath: p.installPath }
        : { name: p.name, marketplace: p.marketplace, version: p.version, path: p.installPath },
    );
    out(`${JSON.stringify(meta.listFormat === "array" ? list : { plugins: list }, null, 2)}\n`);
  } else {
    fail(`fake ${tool}: plugin ${verb} is not implemented`, 2);
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2));
}
