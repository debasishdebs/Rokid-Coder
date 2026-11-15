const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { COMPUTER, REPO, bundleUnderTest, copyBundle, loadBuild, tempDir } = require("./helpers/bundle.js");

const BUNDLE_DIR = path.join(COMPUTER, "installer", "bundle");
const loadVerify = () => import(pathToFileURL(path.join(BUNDLE_DIR, "verify-bundle.mjs")).href);

test("bundle_layout_matches_manifest", async (t) => {
  const verify = await loadVerify();
  const { dir } = await bundleUnderTest();
  assert.deepEqual(verify.verifyBundle({ dir, sources: REPO }), { ok: true, errors: [] });
  const layout = verify.LAYOUT;
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
  assert.deepEqual(Object.keys(bundle).sort(), ["builtFrom", "node", "nodePtyMode", "target", "version"]);
  assert.equal(bundle.version, require("../package.json").version);
  assert.ok(layout.targets[bundle.target]);
  assert.equal(fs.existsSync(path.join(dir, "app", "node_modules", "typescript")), false);
  if (bundle.target.startsWith("darwin-")) {
    const helper = path.join(dir, "app", "node_modules", "node-pty", "prebuilds", bundle.target, "spawn-helper");
    assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(path.join(dir, "app", "node_modules", "node-pty", "prebuilds")), [bundle.target]);
  }
  const claude = JSON.parse(fs.readFileSync(path.join(dir, "plugins", ".claude-plugin", "marketplace.json"), "utf8"));
  assert.equal(claude.name, "rokid-coder");
  assert.equal(claude.plugins.find((plugin) => plugin.name === "rokid").source, "./claude-code");
  const codex = JSON.parse(fs.readFileSync(path.join(dir, "plugins", ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(codex.name, "rokid-coder");
  assert.equal(codex.plugins.find((plugin) => plugin.name === "rokid").source.path, "./codex");

  // The checks bite: a broken copy fails each of them.
  const broken = copyBundle(dir, path.join(tempDir(t), "broken"));
  fs.chmodSync(path.join(broken, "bin", "agentd"), 0o644);
  fs.mkdirSync(path.join(broken, "app", "node_modules", "typescript"));
  fs.symlinkSync("../../../../outside", path.join(broken, "plugins", "codex", "escape"));
  const marketplace = path.join(broken, "plugins", ".claude-plugin", "marketplace.json");
  fs.writeFileSync(marketplace, fs.readFileSync(marketplace, "utf8").replace("./claude-code", "../claude-code"));
  const hooks = path.join(broken, "plugins", "codex", "hooks", "hooks.json");
  fs.writeFileSync(hooks, fs.readFileSync(hooks, "utf8").replace('\\"$HOME/.rokid-coder/bin/rokid-node\\"', "node"));
  const result = verify.verifyBundle({ dir: broken, staticOnly: true, sources: REPO });
  assert.equal(result.ok, false);
  for (const expected of [/bin\/agentd has mode 644/, /app\/node_modules\/typescript must not/, /dev dependency typescript/,
    /symlink plugins\/codex\/escape/, /claude-plugin\/marketplace\.json is not/, /codex\/hooks\/hooks\.json UserPromptSubmit/,
    /plugins\/codex\/hooks\/hooks\.json differs/]) {
    assert.ok(result.errors.some((error) => expected.test(error)), `${expected}: ${result.errors.join("\n")}`);
  }
});

test("node_download_digest_mismatch_aborts_build", async (t) => {
  const build = await loadBuild();
  const target = build.hostTarget();
  if (!build.TARGETS.includes(target)) {
    t.skip(`no bundle target for ${target}`);
    return;
  }
  const { version } = build.readPin();
  const scratch = tempDir(t);
  const mirror = path.join(scratch, "mirror");
  fs.mkdirSync(path.join(mirror, `v${version}`), { recursive: true });
  fs.writeFileSync(path.join(mirror, `v${version}`, build.nodeArchiveName(version, target)), "not the official node archive");
  const out = path.join(scratch, "out");
  const result = spawnSync(process.execPath, [path.join(BUNDLE_DIR, "build.mjs"), "--target", target, "--out", out, "--node-mirror", mirror], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /Digest mismatch for node-v[\d.]+-[a-z0-9-]+\.tar\.gz: expected [0-9a-f]{64}, got [0-9a-f]{64}/);
  assert.equal(fs.existsSync(path.join(out, target)), false, "nothing was built");
  assert.deepEqual(fs.existsSync(path.join(out, ".cache")) ? fs.readdirSync(path.join(out, ".cache")) : [], [], "the bad download was not kept");
});

const loadLockfile = () => import(pathToFileURL(path.join(BUNDLE_DIR, "lockfile.mjs")).href);

test("workspace_lockfile_pins_every_registry_package_by_digest", async () => {
  const { unhashedPackages } = await loadLockfile();
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  assert.deepEqual(unhashedPackages(lock), []);
  const check = spawnSync(process.execPath, [path.join(BUNDLE_DIR, "lockfile.mjs")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("bundle_build_rejects_unhashed_registry_dependency", async (t) => {
  const build = await loadBuild();
  const { unhashedPackages } = await loadLockfile();
  const repo = tempDir(t);
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  delete lock.packages["computer/node_modules/ws"].integrity;
  lock.packages["computer/node_modules/selfsigned"].resolved = "https://example.invalid/selfsigned.tgz";
  assert.deepEqual(unhashedPackages(lock), [
    "computer/node_modules/selfsigned@5.5.0 has no registry resolved URL",
    "computer/node_modules/ws@8.21.1 has no sha512 integrity",
  ]);
  fs.writeFileSync(path.join(repo, "package-lock.json"), JSON.stringify(lock));
  for (const file of ["package.json", ".npmrc"]) fs.copyFileSync(path.join(REPO, file), path.join(repo, file));
  const stage = path.join(repo, "stage");
  assert.throws(
    () => build.assembleApp(path.join(repo, "app"), { nodeBin: "/nonexistent/node", stageDir: stage, repoRoot: repo }),
    /unhashed registry dependencies; refusing to build:\n {2}computer\/node_modules\/selfsigned@5\.5\.0 has no registry resolved URL\n {2}computer\/node_modules\/ws@8\.21\.1 has no sha512 integrity/,
  );
  assert.equal(fs.existsSync(stage) || fs.existsSync(path.join(repo, "app")), false, "nothing was written");
  const check = spawnSync(process.execPath, [path.join(BUNDLE_DIR, "lockfile.mjs"), path.join(repo, "package-lock.json")], { encoding: "utf8" });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /ws@8\.21\.1 has no sha512 integrity/);
});

test("archive_round_trip_preserves_modes_and_dotfiles", async (t) => {
  const build = await loadBuild();
  const verify = await loadVerify();
  const { dir } = await bundleUnderTest();
  const scratch = tempDir(t);
  const bundle = JSON.parse(fs.readFileSync(path.join(dir, "bundle.json"), "utf8"));
  const { archive, sha256 } = build.writeArchive(dir, scratch, { version: bundle.version, target: bundle.target });
  assert.equal(path.basename(archive), `rokid-coder-bundle-${bundle.version}-${bundle.target}.tar.gz`);
  assert.equal(fs.readFileSync(`${archive}.sha256`, "utf8"), `${sha256}  ${path.basename(archive)}\n`);
  assert.equal(build.sha256File(archive), sha256);

  // The tar listing alone (what a Windows consumer checks) passes, with the same modes.
  const original = verify.dirSource(dir).entries;
  const listed = verify.tarSource(archive).entries;
  assert.deepEqual(verify.verifyBundle({ archive }), { ok: true, errors: [] });
  for (const rel of ["plugins/.claude-plugin/marketplace.json", "plugins/.agents/plugins/marketplace.json", "bin/agentd", "node/bin/node"]) {
    assert.ok(listed.has(rel), rel);
  }

  const extracted = path.join(scratch, "extracted");
  fs.mkdirSync(extracted);
  const untar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8" });
  assert.equal(untar.status, 0, untar.stderr);
  const roundTrip = verify.dirSource(extracted).entries;
  assert.deepEqual([...roundTrip.keys()].sort(), [...original.keys()].sort());
  for (const [rel, entry] of original) {
    assert.equal(roundTrip.get(rel).type, entry.type, rel);
    assert.equal(roundTrip.get(rel).link, entry.link, rel);
    if (entry.type !== "symlink") {
      assert.equal(roundTrip.get(rel).mode & 0o777, entry.mode & 0o777, rel);
      assert.equal(listed.get(rel).mode & 0o777, entry.mode & 0o777, `${rel} in the tar headers`);
    }
  }
  assert.deepEqual(verify.verifyBundle({ dir: extracted, sources: REPO }), { ok: true, errors: [] });
});

/** Every Mach-O file in the bundle, by its magic number. */
function machOFiles(root) {
  const magics = new Set(["feedfacf", "cffaedfe", "feedface", "cefaedfe", "cafebabe"]);
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    const read = fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (read === 4 && magics.has(head.toString("hex"))) found.push(file);
  }
  return found;
}

test("every_macho_minos_at_most_13_0", async (t) => {
  const { dir, real } = await bundleUnderTest();
  if (process.platform !== "darwin" || !real) {
    t.skip("needs a real darwin bundle (ROKID_BUNDLE_DIR)");
    return;
  }
  const files = machOFiles(dir);
  assert.ok(files.some((file) => file.endsWith("/node/bin/node")));
  assert.ok(files.some((file) => file.endsWith("/pty.node")));
  const version = (text) => text.split(".").map(Number);
  const atMost13 = (text) => { const [major, minor = 0] = version(text); return major < 13 || (major === 13 && minor === 0); };
  for (const file of files) {
    const otool = spawnSync("otool", ["-l", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(otool.status, 0, `${file}: ${otool.stderr}`);
    const mins = [];
    const lines = otool.stdout.split("\n");
    lines.forEach((line, index) => {
      if (/cmd LC_BUILD_VERSION/.test(line)) {
        const minos = lines.slice(index, index + 8).map((next) => /^\s*minos (\S+)/.exec(next)).find(Boolean);
        if (minos) mins.push(minos[1]);
      } else if (/cmd LC_VERSION_MIN_MACOSX/.test(line)) {
        const min = lines.slice(index, index + 5).map((next) => /^\s*version (\S+)/.exec(next)).find(Boolean);
        if (min) mins.push(min[1]);
      }
    });
    assert.ok(mins.length > 0, `${file}: no minimum OS load command`);
    for (const min of mins) assert.ok(atMost13(min), `${file}: minos ${min} > 13.0`);
    const codesign = spawnSync("codesign", ["--verify", file], { encoding: "utf8" });
    assert.equal(codesign.status, 0, `${file}: ${codesign.stderr}`);
  }
});

test("linux_bundle_glibc_floor_is_2_35", async (t) => {
  const { dir, real } = await bundleUnderTest();
  if (process.platform !== "linux" || !real) {
    t.skip("needs a real linux bundle (ROKID_BUNDLE_DIR)");
    return;
  }
  const files = [path.join(dir, "node", "bin", "node"), path.join(dir, "app", "node_modules", "node-pty", "build", "Release", "pty.node")];
  let highest = [0, 0];
  for (const file of files) {
    const objdump = spawnSync("objdump", ["-T", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    assert.equal(objdump.status, 0, `${file}: ${objdump.stderr}`);
    for (const match of objdump.stdout.matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
      const found = [Number(match[1]), Number(match[2])];
      if (found[0] > highest[0] || (found[0] === highest[0] && found[1] > highest[1])) highest = found;
    }
  }
  assert.ok(highest[0] < 2 || (highest[0] === 2 && highest[1] <= 35), `requires GLIBC_${highest.join(".")}`);
});
