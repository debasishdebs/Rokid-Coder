// The bundle the bundle tests run against. With ROKID_BUNDLE_DIR set (CI, on
// the extracted archive) it is that real bundle. Otherwise it is a fixture
// assembled by build.mjs's own steps from this repo's build, with a copy of
// the running node in node/bin and that node's version as the pin: enough to
// run the wrappers, selfcheck, the daemon and the hooks from inside a bundle.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const COMPUTER = path.resolve(__dirname, "..", "..");
const REPO = path.resolve(COMPUTER, "..");
const BUILD = path.join(COMPUTER, "installer", "bundle", "build.mjs");

const made = [];
process.once("exit", () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function loadBuild() {
  return import(pathToFileURL(BUILD).href);
}

/** computer's production packages, from the workspace lockfile (dev-only ones are flagged there). */
function productionPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  const prefix = "computer/node_modules/";
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith(prefix) && !key.slice(prefix.length).includes("node_modules/") && !entry.dev)
    .map(([key]) => key.slice(prefix.length));
}

/**
 * A fixture bundle in a fresh temp dir. `ptyFrom` replaces the bundle's
 * node-pty with a symlink to another copy (a native from outside the bundle).
 */
async function fixtureBundle({ ptyFrom } = {}) {
  const build = await loadBuild();
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-bundle-")));
  made.push(parent);
  const root = path.join(parent, "bundle");
  const target = build.hostTarget();
  fs.mkdirSync(path.join(root, "node", "bin"), { recursive: true });
  const node = path.join(root, "node", "bin", "node");
  const hostNode = fs.realpathSync(process.execPath);
  fs.copyFileSync(hostNode, node, fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(node, 0o755);
  // A shared-library node (Homebrew's) finds libnode at @rpath = ../lib: copy it too.
  const hostLib = path.join(path.dirname(hostNode), "..", "lib");
  for (const entry of fs.existsSync(hostLib) ? fs.readdirSync(hostLib) : []) {
    if (/^libnode\./.test(entry)) {
      fs.mkdirSync(path.join(root, "node", "lib"), { recursive: true });
      fs.copyFileSync(path.join(hostLib, entry), path.join(root, "node", "lib", entry), fs.constants.COPYFILE_FICLONE);
    }
  }

  const app = path.join(root, "app");
  fs.mkdirSync(path.join(app, "runtime"), { recursive: true });
  fs.cpSync(path.join(COMPUTER, "dist"), path.join(app, "dist"), { recursive: true });
  fs.copyFileSync(path.join(COMPUTER, "package.json"), path.join(app, "package.json"));
  const pin = process.version.slice(1);
  fs.writeFileSync(path.join(app, "runtime", "node-version.txt"), `${pin}\n`);
  for (const name of productionPackages()) {
    fs.cpSync(path.join(COMPUTER, "node_modules", name), path.join(app, "node_modules", name), { recursive: true, verbatimSymlinks: true });
  }
  let nodePtyMode = "source-built";
  if (target.startsWith("darwin-")) {
    nodePtyMode = build.prepareNodePty(app, target);
  }
  if (ptyFrom) {
    fs.rmSync(path.join(app, "node_modules", "node-pty"), { recursive: true, force: true });
    fs.symlinkSync(ptyFrom, path.join(app, "node_modules", "node-pty"));
  }
  build.writePlugins(path.join(root, "plugins"));
  build.writeBinWrappers(path.join(root, "bin"));
  const version = JSON.parse(fs.readFileSync(path.join(COMPUTER, "package.json"), "utf8")).version;
  build.writeBundleJson(root, { version, target, node: pin, nodePtyMode, builtFrom: "fixture" });
  return root;
}

let shared;
/** The bundle under test: ROKID_BUNDLE_DIR's, or one fixture shared by this test file. */
async function bundleUnderTest() {
  if (process.env.ROKID_BUNDLE_DIR) {
    return { dir: fs.realpathSync(process.env.ROKID_BUNDLE_DIR), real: true };
  }
  shared ??= fixtureBundle();
  return { dir: await shared, real: false };
}

/** A writable copy of a bundle at `dest` (modes and symlinks kept). */
function copyBundle(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(source, dest, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE });
  return dest;
}

/** A temp dir removed when the test ends. */
function tempDir(t, prefix = "rokid-bundle-test-") {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

module.exports = { COMPUTER, REPO, loadBuild, fixtureBundle, bundleUnderTest, copyBundle, tempDir };
