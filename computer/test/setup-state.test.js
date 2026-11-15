const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld, treeBytes } = require("./fixtures/plugin-cli/harness");
const {
  stateLocations,
  classify,
  newSnapshotDir,
  writeSnapshot,
  checkSnapshot,
  restoreSnapshot,
  readInventory,
} = require("../dist/setup/state.js");

const NOW = new Date("2026-11-15T10:00:00Z");

/** The program and transaction files, next to the state in the default layout. */
function writeProgramFiles(home) {
  const dir = path.join(home, ".rokid-coder");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "agentd"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, "env"), "export PATH='/usr/bin'\n");
  fs.writeFileSync(path.join(dir, "install.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "setup-journal.json"), "{}\n");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "logs", "agentd.out"), "log\n");
  fs.writeFileSync(path.join(dir, "launcher.sock"), "");
}

test("snapshot_excludes_program_and_transaction_paths_and_is_0700", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  writeProgramFiles(world.home);
  const locations = stateLocations(world.home, world.env);
  assert.equal(classify(locations, path.join(world.home, ".rokid-coder", "bin", "agentd")), "PROGRAM");
  assert.equal(classify(locations, path.join(world.home, ".rokid-coder", "backups", "x")), "TRANSACTION");
  assert.equal(classify(locations, path.join(world.home, ".rokid-coder", "tls", "steer.secret")), "STATE");
  assert.equal(classify(locations, path.join(world.home, ".nexus-agentd", "agentd.log")), "OTHER");

  const dir = newSnapshotDir(locations, "0.8.0", NOW);
  assert.equal(path.basename(dir), "20261115T100000Z-0.8.0");
  writeSnapshot(locations, dir, "0.8.0", NOW);
  const rels = readInventory(dir).paths.filter((p) => p.type === "file").map((p) => `${p.root}/${p.rel}`).sort();
  assert.deepEqual(rels, [
    "nexus/config.json",
    "state/settings.json",
    "state/tls/agentd.crt",
    "state/tls/agentd.key",
    "state/tls/phone-pins.json",
    "state/tls/steer.secret",
  ]);
  assert.equal(fs.statSync(path.join(world.home, ".rokid-coder", "backups")).mode & 0o777, 0o700);
  const walk = (p) => {
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      assert.equal(stat.mode & 0o777, 0o700, p);
      for (const name of fs.readdirSync(p)) walk(path.join(p, name));
    } else {
      assert.equal(stat.mode & 0o777, 0o600, p);
    }
  };
  walk(dir);
});

test("state_check_is_non_destructive", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  const locations = stateLocations(world.home, world.env);
  const dir = newSnapshotDir(locations, "0.8.0", NOW);
  writeSnapshot(locations, dir, "0.8.0", NOW);
  const before = { live: world.stateBytes(), snapshot: treeBytes(dir) };
  const result = await checkSnapshot(dir);
  assert.deepEqual(result, { ok: true, pins: 1, machineId: "fixtureMachineIdT7p0q8" });
  assert.deepEqual({ live: world.stateBytes(), snapshot: treeBytes(dir) }, before, "the v3 pins migrate in a copy only");
});

test("restore_with_default_overlapping_layout_keeps_program_and_transaction_paths", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  const locations = stateLocations(world.home, world.env);
  assert.equal(locations.stateDir, path.join(world.home, ".rokid-coder"));
  const dir = newSnapshotDir(locations, "0.8.0", NOW);
  writeSnapshot(locations, dir, "0.8.0", NOW);
  const snapshotState = world.stateBytes();

  // What the new version did afterwards: program and setup files, a changed pin file, new state.
  writeProgramFiles(world.home);
  const rc = path.join(world.home, ".rokid-coder");
  fs.writeFileSync(path.join(rc, "tls", "phone-pins.json"), '{"version":4,"phones":[]}\n');
  fs.writeFileSync(path.join(rc, "attached.json"), "[]\n");
  fs.mkdirSync(path.join(rc, "sessions"));
  fs.writeFileSync(path.join(rc, "sessions", "a.json"), "{}\n");
  const untouched = (rel) => treeBytes(path.join(rc, rel));
  const program = { bin: untouched("bin"), backups: untouched("backups"), logs: untouched("logs") };
  const files = ["env", "install.json", "setup-journal.json", "launcher.sock"].map((f) => fs.readFileSync(path.join(rc, f), "utf8"));

  const { discarded } = restoreSnapshot(locations, dir, NOW);
  assert.deepEqual(world.stateBytes(), snapshotState, "the state is the snapshot's again");
  assert.deepEqual({ bin: untouched("bin"), backups: treeBytes(path.join(rc, "backups"), { skip: (rel) => rel.includes("discarded") }), logs: untouched("logs") }, program);
  assert.deepEqual(["env", "install.json", "setup-journal.json", "launcher.sock"].map((f) => fs.readFileSync(path.join(rc, f), "utf8")), files);
  assert.match(path.basename(discarded), /-discarded$/);
  assert.deepEqual(Object.keys(treeBytes(discarded)).sort(), ["state/attached.json", "state/sessions/a.json"]);
  assert.ok(!fs.readdirSync(path.join(rc, "tls")).some((name) => name.includes("rokid-")), "no swap leftovers");
});
