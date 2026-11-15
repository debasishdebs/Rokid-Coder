#!/usr/bin/env node
// Builds one self-contained computer bundle:
//   node build.mjs --target <darwin-arm64|darwin-x64|linux-x64> --out dist-bundle/ [--archive]
// writes dist-bundle/<target>/{node,app,plugins,bin,bundle.json}, and with
// --archive also dist-bundle/rokid-coder-bundle-<v>-<target>.tar.gz and its .sha256.
// Run it from a built repo (computer/dist present) on a host of the target:
// the production modules are installed by the pinned Node's own npm.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COMPUTER_DIR = path.resolve(HERE, "..", "..");
export const REPO_ROOT = path.resolve(COMPUTER_DIR, "..");
export const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64"];
export const WRAPPER_NAMES = ["rokid-node", "agentd", "rk", "rokid-setup"];
const NODE_DIST = "https://nodejs.org/dist";

export function hostTarget() {
  return `${process.platform}-${process.arch}`;
}

/** The pinned Node version and the official SHASUMS256 digests, keyed by file name. */
export function readPin(computerDir = COMPUTER_DIR) {
  const version = fs.readFileSync(path.join(computerDir, "runtime", "node-version.txt"), "utf8").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`runtime/node-version.txt must hold an exact version, not '${version}'`);
  }
  const checksums = new Map();
  for (const line of fs.readFileSync(path.join(computerDir, "runtime", "node-checksums.txt"), "utf8").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line.trim());
    if (match) checksums.set(match[2], match[1]);
  }
  return { version, checksums };
}

export const nodeArchiveName = (version, target) => `node-v${version}-${target}.tar.gz`;
export const headersArchiveName = (version) => `node-v${version}-headers.tar.gz`;

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * `name` from the mirror (an http(s) URL or a local dir, both laid out as
 * <mirror>/v<version>/<name>), cached in cacheDir and checked against the
 * pinned digest. A mismatch deletes the download and aborts the build.
 */
export async function fetchVerified(name, { pin, mirror = NODE_DIST, cacheDir }) {
  const expected = pin.checksums.get(name);
  if (!expected) {
    throw new Error(`No pinned digest for ${name} in runtime/node-checksums.txt`);
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file) && sha256File(file) === expected) {
    return file;
  }
  const temp = `${file}.part`;
  const source = `${mirror.replace(/\/$/, "")}/v${pin.version}/${name}`;
  if (/^https?:\/\//.test(mirror)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Downloading ${source} failed: HTTP ${response.status}`);
    fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  } else {
    fs.copyFileSync(source, temp);
  }
  const actual = sha256File(temp);
  if (actual !== expected) {
    fs.rmSync(temp, { force: true });
    throw new Error(`Digest mismatch for ${name}: expected ${expected}, got ${actual}. Refusing to build.`);
  }
  fs.renameSync(temp, file);
  return file;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.error?.message ?? `exit ${result.status}`})`);
  }
}

export function extractTarball(archive, dest) {
  fs.mkdirSync(dest, { recursive: true });
  run("tar", ["-xzf", archive, "-C", dest, "--strip-components", "1"]);
}

/** app/: the built dist, package.json, the Node pin, and the production node_modules from the lockfile. */
export function assembleApp(appDir, { nodeBin, stageDir, computerDir = COMPUTER_DIR, repoRoot = REPO_ROOT }) {
  if (!fs.existsSync(path.join(computerDir, "dist", "cli.js"))) {
    throw new Error(`${computerDir}/dist is not built: run (cd computer && npm run build) first`);
  }
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(path.join(computerDir, "dist"), path.join(appDir, "dist"), { recursive: true });
  fs.copyFileSync(path.join(computerDir, "package.json"), path.join(appDir, "package.json"));
  fs.mkdirSync(path.join(appDir, "runtime"));
  fs.copyFileSync(path.join(computerDir, "runtime", "node-version.txt"), path.join(appDir, "runtime", "node-version.txt"));

  // The workspace lockfile, replayed in a stage that mirrors the workspaces:
  // only computer's production dependencies, and no package's install scripts.
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
    fs.copyFileSync(path.join(repoRoot, file), path.join(stageDir, file));
  }
  const workspaces = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).workspaces ?? [];
  for (const workspace of workspaces) {
    fs.mkdirSync(path.join(stageDir, workspace), { recursive: true });
    const manifest = path.join(repoRoot, workspace, "package.json");
    if (fs.existsSync(manifest)) fs.copyFileSync(manifest, path.join(stageDir, workspace, "package.json"));
  }
  const npmCli = path.join(path.dirname(path.dirname(nodeBin)), "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const workspace = path.relative(repoRoot, computerDir);
  run(nodeBin, [npmCli, "ci", "--omit=dev", "--ignore-scripts", "--workspace", workspace, "--no-audit", "--no-fund"], {
    cwd: stageDir,
    env: { ...process.env, PATH: `${path.dirname(nodeBin)}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  const modules = path.join(appDir, "node_modules");
  fs.renameSync(path.join(stageDir, workspace, "node_modules"), modules);
  fs.rmSync(stageDir, { recursive: true, force: true });
  // npm leaves the scope dir of an omitted dev package (@types) behind, empty.
  for (const entry of fs.readdirSync(modules)) {
    const dir = path.join(modules, entry);
    if (entry.startsWith("@") && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
}

/**
 * The one native step. darwin: keep only the target's N-API prebuild, with
 * spawn-helper made executable (node-pty 1.1.0 ships it 0644). linux-x64:
 * build node-pty from source against the checksum-verified headers.
 */
export function prepareNodePty(appDir, target, { nodeBin, headersDir } = {}) {
  const pty = path.join(appDir, "node_modules", "node-pty");
  if (target.startsWith("darwin-")) {
    const prebuilds = path.join(pty, "prebuilds");
    for (const entry of fs.readdirSync(prebuilds)) {
      if (entry !== target) fs.rmSync(path.join(prebuilds, entry), { recursive: true, force: true });
    }
    const native = path.join(prebuilds, target, "pty.node");
    const helper = path.join(prebuilds, target, "spawn-helper");
    if (!fs.existsSync(native) || !fs.existsSync(helper)) {
      throw new Error(`node-pty has no ${target} prebuild`);
    }
    fs.chmodSync(helper, 0o755);
    return "napi-prebuild";
  }
  const gyp = path.join(path.dirname(path.dirname(nodeBin)), "lib", "node_modules", "npm", "node_modules", "node-gyp", "bin", "node-gyp.js");
  run(nodeBin, [gyp, "rebuild", `--nodedir=${headersDir}`], {
    cwd: pty,
    env: { ...process.env, PATH: `${path.dirname(nodeBin)}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  fs.rmSync(path.join(pty, "prebuilds"), { recursive: true, force: true });
  // Keep the built objects only: build/Release/*.node.
  const build = path.join(pty, "build");
  const release = path.join(build, "Release");
  for (const entry of fs.readdirSync(build)) {
    if (entry !== "Release") fs.rmSync(path.join(build, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(release)) {
    if (!entry.endsWith(".node")) fs.rmSync(path.join(release, entry), { recursive: true, force: true });
  }
  if (!fs.existsSync(path.join(release, "pty.node"))) throw new Error("node-gyp built no pty.node");
  return "source-built";
}

/** plugins/: both marketplaces, re-pointed inside plugins/, and both plugins with the built forwarder. */
export function writePlugins(pluginsDir, { repoRoot = REPO_ROOT, computerDir = COMPUTER_DIR } = {}) {
  const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
  const writeJson = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  };
  const claude = readJson(repoRoot, ".claude-plugin", "marketplace.json");
  const claudePlugin = claude.plugins.find((plugin) => plugin.name === "rokid");
  if (claude.name !== "rokid-coder" || !claudePlugin) throw new Error("the Claude marketplace has no rokid-coder/rokid");
  claudePlugin.source = "./claude-code";
  writeJson(path.join(pluginsDir, ".claude-plugin", "marketplace.json"), claude);

  const codex = readJson(repoRoot, ".agents", "plugins", "marketplace.json");
  const codexPlugin = codex.plugins.find((plugin) => plugin.name === "rokid");
  if (codex.name !== "rokid-coder" || !codexPlugin) throw new Error("the Codex marketplace has no rokid-coder/rokid");
  codexPlugin.source = { ...codexPlugin.source, path: "./codex" };
  writeJson(path.join(pluginsDir, ".agents", "plugins", "marketplace.json"), codex);

  const forwarder = path.join(computerDir, "dist", "hook-forward.js");
  for (const plugin of ["claude-code", "codex"]) {
    const dest = path.join(pluginsDir, plugin);
    fs.cpSync(path.join(repoRoot, "plugin", plugin), dest, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
    fs.mkdirSync(path.join(dest, "bin"), { recursive: true });
    fs.copyFileSync(forwarder, path.join(dest, "bin", "hook-forward.js"));
  }
}

/** bin/: the self-locating sh wrappers. */
export function writeBinWrappers(binDir, wrappersDir = path.join(COMPUTER_DIR, "installer", "wrappers")) {
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of WRAPPER_NAMES) {
    fs.copyFileSync(path.join(wrappersDir, `${name}.sh`), path.join(binDir, name));
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
}

export function writeBundleJson(root, { version, target, node, nodePtyMode, builtFrom }) {
  fs.writeFileSync(path.join(root, "bundle.json"), `${JSON.stringify({ version, target, node, nodePtyMode, builtFrom }, null, 2)}\n`);
}

export function gitSha(repoRoot = REPO_ROOT) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export const archiveName = (version, target) => `rokid-coder-bundle-${version}-${target}.tar.gz`;

/** The pax tar of `<target>/`'s contents (modes, symlinks and dotfiles kept) and its `.sha256`. */
export function writeArchive(targetDir, outDir, { version, target }) {
  const name = archiveName(version, target);
  const archive = path.join(outDir, name);
  const macOnly = process.platform === "darwin" ? ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags"] : [];
  run("tar", ["--format", "pax", ...macOnly, "-czf", archive, "-C", targetDir, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const sha256 = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${sha256}  ${name}\n`);
  return { archive, sha256 };
}

function parseArgs(argv) {
  const options = { archive: false, mirror: process.env.ROKID_NODE_MIRROR || NODE_DIST };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--archive") options.archive = true;
    else if (arg === "--target") options.target = argv[++i];
    else if (arg === "--out") options.out = argv[++i];
    else if (arg === "--node-mirror") options.mirror = argv[++i];
    else if (arg === "--cache") options.cache = argv[++i];
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!TARGETS.includes(options.target)) throw new Error(`--target must be one of ${TARGETS.join(", ")}`);
  if (!options.out) throw new Error("--out <dir> is required");
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const { target } = options;
  if (target !== hostTarget()) {
    throw new Error(`Build ${target} on a ${target} host: its pinned Node installs the modules (this host is ${hostTarget()})`);
  }
  const out = path.resolve(options.out);
  const cacheDir = path.resolve(options.cache ?? path.join(out, ".cache"));
  const pin = readPin();
  // First, before anything is written: the pinned archives and their digests.
  const nodeArchive = await fetchVerified(nodeArchiveName(pin.version, target), { pin, mirror: options.mirror, cacheDir });
  const headersArchive = target.startsWith("linux-")
    ? await fetchVerified(headersArchiveName(pin.version), { pin, mirror: options.mirror, cacheDir })
    : undefined;

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, ".gitignore"), "*\n");
  const partial = path.join(out, `.${target}.partial`);
  fs.rmSync(partial, { recursive: true, force: true });
  extractTarball(nodeArchive, path.join(partial, "node"));
  const nodeBin = path.join(partial, "node", "bin", "node");
  const appDir = path.join(partial, "app");
  assembleApp(appDir, { nodeBin, stageDir: path.join(out, `.${target}.stage`) });
  let headersDir;
  if (headersArchive) {
    headersDir = path.join(cacheDir, `headers-v${pin.version}`);
    fs.rmSync(headersDir, { recursive: true, force: true });
    extractTarball(headersArchive, headersDir);
  }
  const nodePtyMode = prepareNodePty(appDir, target, { nodeBin, headersDir });
  writePlugins(path.join(partial, "plugins"));
  writeBinWrappers(path.join(partial, "bin"));
  const version = JSON.parse(fs.readFileSync(path.join(COMPUTER_DIR, "package.json"), "utf8")).version;
  writeBundleJson(partial, { version, target, node: pin.version, nodePtyMode, builtFrom: gitSha() });

  const targetDir = path.join(out, target);
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(partial, targetDir);
  process.stdout.write(`Built ${targetDir} (node ${pin.version}, node-pty ${nodePtyMode})\n`);
  if (options.archive) {
    const { archive, sha256 } = writeArchive(targetDir, out, { version, target });
    process.stdout.write(`Wrote ${archive}\n${sha256}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build.mjs: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
