// ci/state-check.js's pin commands, as the legacy macOS jobs run them: the 0.8.0
// fixture's pins are refreshed while staging, so startup expiry cannot empty
// them, and the trusted set is asserted nonempty and unchanged on both sides.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STATE_CHECK = path.join(__dirname, "ci", "state-check.js");
const FIXTURE = path.join(__dirname, "..", "..", "..", "test", "fixtures", "state-0.8.0", "home");
const DIST = path.join(__dirname, "..", "..", "..", "dist");
const PINS = path.join(".rokid-coder", "tls", "phone-pins.json");

function run(...args) {
  const result = spawnSync(process.execPath, [STATE_CHECK, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function stagedHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-state-check-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(FIXTURE, root, { recursive: true });
  return root;
}

/** A directory shaped like a bundle's app/dist, for state-check's <bundle> argument. */
function bundleOfThisBuild(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-state-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.symlinkSync(DIST, path.join(root, "app", "dist"));
  return root;
}

test("legacy_pins_refreshed_at_staging_survive_startup_expiry", (t) => {
  const home = stagedHome(t);
  const expected = path.join(home, "pins.expected");
  const bundle = bundleOfThisBuild(t);
  const { PinStore, DEFAULT_PAIRING_TTL_DAYS, DAY_MS } = require(path.join(DIST, "tls.js"));
  const startupExpiry = () => new PinStore(path.join(home, PINS)).expire(Date.now(), DEFAULT_PAIRING_TTL_DAYS * DAY_MS);
  // As copied, the fixture's pin was last used in November 2025: agentd's startup expiry forgets it.
  assert.equal(startupExpiry().length, 1, "the stale fixture pin is expired at startup");
  fs.cpSync(FIXTURE, home, { recursive: true });

  const before = Date.now();
  const refresh = run("refresh-pins", home, expected);
  assert.equal(refresh.status, 0, refresh.output);
  const pins = JSON.parse(fs.readFileSync(path.join(home, PINS), "utf8"));
  assert.equal(pins.phones.length, 1);
  assert.ok(pins.phones[0].lastUsedAt >= before && pins.phones[0].lastUsedAt <= Date.now(), "lastUsedAt is now, never in the future");
  assert.doesNotMatch(refresh.output + fs.readFileSync(expected, "utf8"), new RegExp(pins.phones[0].fp.slice(0, 11)), "no fingerprint is printed or stored");

  // Before the upgrade (0.8.0's own file) and after it (through the bundle's PinStore): the same nonempty set.
  assert.equal(run("trusted", home, expected).status, 0);
  assert.deepEqual(startupExpiry(), [], "refreshed, it survives the startup expiry");
  const after = run("trusted", home, expected, bundle);
  assert.equal(after.status, 0, after.output);
  assert.match(after.output, /1 trusted phone/);
});

test("trusted_fails_on_an_empty_or_changed_set", (t) => {
  const home = stagedHome(t);
  const expected = path.join(home, "pins.expected");
  assert.equal(run("refresh-pins", home, expected).status, 0);
  const file = path.join(home, PINS);
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));

  fs.writeFileSync(file, JSON.stringify({ ...pins, phones: [] }));
  const empty = run("trusted", home, expected);
  assert.equal(empty.status, 1);
  assert.match(empty.output, /no trusted phone/);

  fs.writeFileSync(file, JSON.stringify({ ...pins, phones: [{ ...pins.phones[0], fp: pins.phones[0].fp.replace(/^5C/, "6D") }] }));
  const changed = run("trusted", home, expected);
  assert.equal(changed.status, 1);
  assert.match(changed.output, /differ/);

  // An expected set that is itself empty is refused at staging.
  fs.writeFileSync(file, JSON.stringify({ ...pins, phones: [] }));
  assert.equal(run("refresh-pins", home, expected).status, 1);
});
