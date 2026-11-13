const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { AppliedIds } = require("../dist/applied-ids.js");
const { withTempDir } = require("./helpers/daemon.js");

const DAY = 24 * 60 * 60 * 1000;

function capturingLogger() {
  const events = [];
  const record = (level) => (event, meta) => events.push({ level, event, meta });
  return { events, logger: { info: record("info"), warn: record("warn"), error: record("error") } };
}

test("applied_ids_survive_restart", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "nested", "applied-ids.json");
    const first = new AppliedIds(file, DAY, () => 1_000);
    assert.equal(first.seen("m1"), false);
    first.record("m1");
    assert.equal(first.seen("m1"), true);

    const second = new AppliedIds(file, DAY, () => 2_000);
    assert.equal(second.seen("m1"), true);
    assert.equal(second.seen("m2"), false);
  });
});

test("applied_ids_prune_after_retention", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "applied-ids.json");
    let t = 1_000;
    const ids = new AppliedIds(file, DAY, () => t);
    ids.record("old");
    t += DAY - 1;
    assert.equal(ids.seen("old"), true);
    t += 1;
    assert.equal(ids.seen("old"), false);

    ids.record("new");
    const onDisk = JSON.parse(await fsp.readFile(file, "utf8"));
    assert.deepEqual(Object.keys(onDisk.ids), ["new"]);

    // An entry that aged out while agentd was down is gone after the restart too.
    t += DAY;
    const restarted = new AppliedIds(file, DAY, () => t);
    assert.equal(restarted.seen("new"), false);
  });
});

test("applied_ids_file_is_private_and_written_atomically", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "applied-ids.json");
    new AppliedIds(file, DAY, () => 1).record("m1");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["applied-ids.json"]);
  });
});

test("applied_ids_corrupt_or_missing_file_starts_empty", async () => {
  await withTempDir(async (dir) => {
    const missing = new AppliedIds(path.join(dir, "absent.json"), DAY, () => 1);
    assert.equal(missing.seen("m1"), false);

    for (const body of ["{not json", "[]", JSON.stringify({ version: 9, ids: {} }), JSON.stringify({ version: 1, ids: [] })]) {
      const file = path.join(dir, "bad.json");
      await fsp.writeFile(file, body);
      const { events, logger } = capturingLogger();
      const ids = new AppliedIds(file, DAY, () => 1, logger);
      assert.equal(ids.seen("m1"), false);
      assert.equal(events.some((e) => e.event === "applied_ids_corrupt"), true);
      ids.record("m1");
      assert.equal(new AppliedIds(file, DAY, () => 2).seen("m1"), true);
    }
  });
});

test("applied_ids_drops_malformed_entries_but_keeps_valid_ones", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "applied-ids.json");
    await fsp.writeFile(file, JSON.stringify({ version: 1, ids: { good: 5, bad: "x", worse: null } }));
    const { events, logger } = capturingLogger();
    const ids = new AppliedIds(file, DAY, () => 10, logger);
    assert.equal(ids.seen("good"), true);
    assert.equal(ids.seen("bad"), false);
    assert.equal(events.find((e) => e.event === "applied_ids_corrupt").meta.dropped, 2);
  });
});

test("applied_ids_failed_write_keeps_the_in_memory_record", async () => {
  await withTempDir(async (dir) => {
    const blocker = path.join(dir, "blocker");
    await fsp.writeFile(blocker, "a file where a directory is needed");
    const { events, logger } = capturingLogger();
    const ids = new AppliedIds(path.join(blocker, "applied-ids.json"), DAY, () => 1, logger);
    assert.doesNotThrow(() => ids.record("m1"));
    assert.equal(ids.seen("m1"), true);
    assert.equal(events.some((e) => e.level === "error" && e.event === "applied_ids_persist_failed"), true);
  });
});
