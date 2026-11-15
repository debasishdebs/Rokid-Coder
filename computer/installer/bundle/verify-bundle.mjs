#!/usr/bin/env node
// Checks a bundle against bundle-layout.json:
//   node verify-bundle.mjs <bundle-dir> [--static] [--sources <repo-root>]
//   node verify-bundle.mjs --archive <rokid-coder-bundle-*.tar.gz>     (static, from the tar headers)
// Static checks read files and modes only: the layout, the mode bits, both
// marketplaces, the hook commands and every symlink. Without --static (a
// directory on a native host) it also runs the bundle's `agentd --version`.
// Prints {ok, errors} as JSON; the exit status is 0 only when ok.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LAYOUT = JSON.parse(fs.readFileSync(path.join(HERE, "bundle-layout.json"), "utf8"));

/** A bundle on disk, seen as entries {type, mode, link} keyed by their posix path. */
export function dirSource(root) {
  const entries = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      const stat = fs.lstatSync(full);
      const type = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "dir" : "file";
      entries.set(rel, { type, mode: stat.mode & 0o7777, link: type === "symlink" ? fs.readlinkSync(full) : undefined });
      if (type === "dir") walk(full);
    }
  };
  walk(root);
  return { entries, read: (rel) => fs.readFileSync(path.join(root, ...rel.split("/"))) };
}

function tarString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end < 0 ? length : end).toString("utf8");
}

function tarNumber(block, start, length) {
  if (block[start] & 0x80) {
    let value = 0;
    for (let i = start + 1; i < start + length; i += 1) value = value * 256 + block[i];
    return value;
  }
  return parseInt(tarString(block, start, length).trim() || "0", 8);
}

function paxRecords(data) {
  const records = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!length) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** A bundle archive, read from its (gzipped pax/ustar) tar headers without extracting it. */
export function tarSource(archive) {
  const data = zlib.gunzipSync(fs.readFileSync(archive));
  const entries = new Map();
  const contents = new Map();
  let offset = 0;
  let pax = {};
  let longName;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarNumber(header, 124, 12);
    const flag = String.fromCharCode(header[156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (flag === "x") { pax = paxRecords(body); continue; }
    if (flag === "g") continue;
    if (flag === "L") { longName = tarString(body, 0, body.length); continue; }
    const prefix = tarString(header, 345, 155);
    let name = pax.path ?? longName ?? (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    const link = pax.linkpath ?? tarString(header, 157, 100);
    pax = {};
    longName = undefined;
    name = name.replace(/^\.\//, "").replace(/\/$/, "");
    if (name === "" || name === ".") continue;
    const type = flag === "5" ? "dir" : flag === "2" ? "symlink" : "file";
    entries.set(name, { type, mode: tarNumber(header, 100, 8) & 0o7777, link: type === "symlink" ? link : undefined });
    if (type === "file") contents.set(name, body);
  }
  return {
    entries,
    read: (rel) => {
      const body = contents.get(rel);
      if (!body) throw new Error(`${rel} is not in the archive`);
      return Buffer.from(body);
    },
  };
}

const HOOK = /^((?:[A-Z_]+=[^ ]* )*)"\$HOME\/\.rokid-coder\/bin\/rokid-node" "\$\{([A-Z_]+)\}\/bin\/hook-forward\.js"$/;

/** Every static check; returns the list of problems (empty when the bundle is sound). */
export function verifySource(source, { sources } = {}) {
  const errors = [];
  const { entries } = source;
  const json = (rel) => {
    try {
      return JSON.parse(source.read(rel).toString("utf8"));
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
      return undefined;
    }
  };
  const bundle = entries.has("bundle.json") ? json("bundle.json") : undefined;
  const target = bundle?.target;
  const perTarget = LAYOUT.targets[target];
  if (!perTarget) {
    errors.push(`bundle.json: unknown target ${JSON.stringify(target)}`);
  }
  const required = [...LAYOUT.required, ...(perTarget?.required ?? [])];
  for (const rel of required) {
    if (!entries.has(rel)) errors.push(`missing ${rel}`);
  }
  for (const rel of [...LAYOUT.mode0755, ...(perTarget?.mode0755 ?? [])]) {
    const entry = entries.get(rel);
    if (entry && (entry.mode & 0o777) !== 0o755) errors.push(`${rel} has mode ${(entry.mode & 0o777).toString(8)}, not 755`);
  }
  for (const rel of LAYOUT.forbidden) {
    if (entries.has(rel)) errors.push(`${rel} must not be in the bundle`);
  }
  const app = entries.has("app/package.json") ? json("app/package.json") : undefined;
  for (const name of Object.keys(app?.devDependencies ?? {})) {
    if (entries.has(`app/node_modules/${name}`)) errors.push(`dev dependency ${name} is in the bundle`);
  }
  if (bundle && app) {
    if (bundle.version !== app.version) errors.push(`bundle.json version ${bundle.version} != app ${app.version}`);
    if (perTarget && bundle.nodePtyMode !== perTarget.nodePtyMode) errors.push(`bundle.json nodePtyMode ${bundle.nodePtyMode} != ${perTarget.nodePtyMode}`);
    if (entries.has("app/runtime/node-version.txt") && source.read("app/runtime/node-version.txt").toString("utf8").trim() !== bundle.node) {
      errors.push("app/runtime/node-version.txt differs from bundle.json node");
    }
  }

  // Both marketplaces, with sources that resolve to a plugin inside plugins/.
  const insidePlugins = (rel, manifest) => {
    const resolved = path.posix.normalize(path.posix.join("plugins", rel));
    if (!resolved.startsWith("plugins/") || resolved.includes("..")) {
      errors.push(`marketplace source ${rel} leaves plugins/`);
    } else if (!entries.has(`${resolved}/${manifest}`)) {
      errors.push(`marketplace source ${rel} has no ${manifest}`);
    }
  };
  const claude = entries.has("plugins/.claude-plugin/marketplace.json") ? json("plugins/.claude-plugin/marketplace.json") : undefined;
  const claudePlugin = claude?.plugins?.find((plugin) => plugin.name === "rokid");
  if (claude && (claude.name !== "rokid-coder" || claudePlugin?.source !== "./claude-code")) {
    errors.push("plugins/.claude-plugin/marketplace.json is not rokid-coder/rokid -> ./claude-code");
  }
  if (claudePlugin) insidePlugins(claudePlugin.source, ".claude-plugin/plugin.json");
  const codex = entries.has("plugins/.agents/plugins/marketplace.json") ? json("plugins/.agents/plugins/marketplace.json") : undefined;
  const codexPlugin = codex?.plugins?.find((plugin) => plugin.name === "rokid");
  if (codex && (codex.name !== "rokid-coder" || codexPlugin?.source?.path !== "./codex")) {
    errors.push("plugins/.agents/plugins/marketplace.json is not rokid-coder/rokid -> ./codex");
  }
  if (codexPlugin?.source?.path) insidePlugins(codexPlugin.source.path, ".codex-plugin/plugin.json");

  // The hooks run the forwarder through the rokid-node wrapper, never a bare node.
  for (const [plugin, root] of [["claude-code", "CLAUDE_PLUGIN_ROOT"], ["codex", "PLUGIN_ROOT"]]) {
    const rel = `plugins/${plugin}/hooks/hooks.json`;
    const hooks = entries.has(rel) ? json(rel)?.hooks ?? {} : {};
    for (const [event, groups] of Object.entries(hooks)) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        const match = HOOK.exec(hook.command);
        if (!match || match[2] !== root) errors.push(`${rel} ${event}: ${hook.command}`);
      }
    }
    const forwarder = `plugins/${plugin}/bin/hook-forward.js`;
    if (entries.has(forwarder) && entries.has("app/dist/hook-forward.js") && !source.read(forwarder).equals(source.read("app/dist/hook-forward.js"))) {
      errors.push(`${forwarder} is not the built forwarder`);
    }
  }

  for (const [rel, entry] of entries) {
    if (entry.type !== "symlink") continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), entry.link));
    if (path.posix.isAbsolute(entry.link) || resolved.startsWith("..")) errors.push(`symlink ${rel} -> ${entry.link} leaves the bundle`);
  }

  if (sources) {
    for (const rel of ["claude-code/.claude-plugin/plugin.json", "claude-code/hooks/hooks.json", "codex/.codex-plugin/plugin.json", "codex/hooks/hooks.json"]) {
      const original = fs.readFileSync(path.join(sources, "plugin", ...rel.split("/")));
      if (!entries.has(`plugins/${rel}`) || !source.read(`plugins/${rel}`).equals(original)) {
        errors.push(`plugins/${rel} differs from plugin/${rel}`);
      }
    }
  }
  return errors;
}

/** The runtime check on a native host: the bundle's own agentd reports the pinned node and itself. */
export function verifyRuntime(root) {
  const errors = [];
  const bundle = JSON.parse(fs.readFileSync(path.join(root, "bundle.json"), "utf8"));
  const result = spawnSync(path.join(root, "bin", "agentd"), ["--version", "--json"], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) {
    return [`bin/agentd --version failed: ${result.stderr || result.error?.message}`];
  }
  const info = JSON.parse(result.stdout);
  const real = fs.realpathSync(root);
  if (info.node !== `v${bundle.node}`) errors.push(`node ${info.node} is not the pinned v${bundle.node}`);
  if (info.bundleRoot !== real) errors.push(`bundleRoot ${info.bundleRoot} is not ${real}`);
  if (info.execPath !== fs.realpathSync(path.join(root, "node", "bin", "node"))) errors.push(`execPath ${info.execPath} is outside the bundle`);
  if (info.agentd !== bundle.version) errors.push(`agentd ${info.agentd} != bundle ${bundle.version}`);
  return errors;
}

export function verifyBundle({ dir, archive, staticOnly = false, sources }) {
  const source = archive ? tarSource(archive) : dirSource(dir);
  const errors = verifySource(source, { sources });
  if (dir && !staticOnly && errors.length === 0) errors.push(...verifyRuntime(dir));
  return { ok: errors.length === 0, errors };
}

function main(argv) {
  const options = { staticOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--static") options.staticOnly = true;
    else if (arg === "--archive") options.archive = argv[++i];
    else if (arg === "--sources") options.sources = argv[++i];
    else if (!arg.startsWith("--") && !options.dir) options.dir = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.dir === !options.archive) throw new Error("Usage: verify-bundle.mjs <bundle-dir> [--static] [--sources <repo>] | --archive <file.tar.gz>");
  const result = verifyBundle(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`verify-bundle.mjs: ${error.message}\n`);
    process.exitCode = 1;
  }
}
