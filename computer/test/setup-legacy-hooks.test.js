// R217: removing the hooks 0.8.0's `agentd install-hooks` wrote into
// ~/.claude/settings.json is an explicit user step, never part of the install
// transaction. Every test runs in a temp HOME.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeWorld } = require("./fixtures/plugin-cli/harness");
const { listInstallHooks, migrateInstallHooks, MIGRATE_HOOKS_COMMAND } = require("../dist/setup/legacy.js");

const FIXTURE = path.join(__dirname, "fixtures", "state-0.8.0", "home", ".claude", "settings.json");
const FORWARDER = 'node "/Users/example/src/Rokid-Coder/agentd/dist/hook-forward.js"';

function home(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-legacy-hooks-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, ".claude"));
  fs.copyFileSync(FIXTURE, path.join(dir, ".claude", "settings.json"));
  return dir;
}

/** A terminal (or not) that answers `lines` in turn, and records what was shown and how often it was asked. */
function io({ interactive, lines = [] }) {
  const out = [];
  let asked = 0;
  return {
    interactive,
    out: () => out.join(""),
    asked: () => asked,
    write: (text) => out.push(text),
    note: () => {},
    readLine: async () => {
      asked += 1;
      return lines.shift();
    },
  };
}

const settingsOf = (dir) => fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8");
const backupsOf = (dir) => fs.readdirSync(path.join(dir, ".claude")).filter((name) => name.startsWith("settings.json.agentd-backup-"));
const EXPECTED = [
  `  SessionStart: ${FORWARDER}\n`,
  `  UserPromptSubmit: ${FORWARDER}\n`,
  `  PreToolUse: ${FORWARDER}\n`,
  `  Stop: ${FORWARDER}\n`,
].join("");

test("legacy_hooks_migration_shows_entries_and_removes_them_on_yes", async (t) => {
  const dir = home(t);
  const before = settingsOf(dir);
  assert.deepEqual(listInstallHooks(dir).map((entry) => entry.event), ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"]);
  const screen = io({ interactive: true, lines: ["y"] });
  assert.equal(await migrateInstallHooks(dir, screen), "removed");
  assert.ok(screen.out().includes(`These entries would be removed:\n${EXPECTED}`), screen.out());
  assert.match(screen.out(), /Remove them from ~\/\.claude\/settings\.json\? A backup is kept\. \[y\/N\] /);
  assert.equal(screen.asked(), 1);

  const after = JSON.parse(settingsOf(dir));
  assert.ok(!settingsOf(dir).includes("hook-forward.js"), "the install-hooks entries are gone");
  assert.equal(after.model, "opus");
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-own-guard" }] }], "the user's own hook stays");
  const backups = backupsOf(dir);
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, ".claude", backups[0]), "utf8"), before, "the backup is the file as it was");
  assert.ok(screen.out().includes(`The previous file is kept as ${path.join(dir, ".claude", backups[0])}`), screen.out());
  assert.deepEqual(fs.readdirSync(path.join(dir, ".claude")).filter((name) => name.endsWith(".tmp")), [], "written by temp file + rename");
  assert.deepEqual(listInstallHooks(dir), []);
});

test("legacy_hooks_migration_keeps_settings_on_no_or_enter", async (t) => {
  for (const answer of ["n", "", undefined]) {
    const dir = home(t);
    const before = settingsOf(dir);
    const screen = io({ interactive: true, lines: [answer] });
    assert.equal(await migrateInstallHooks(dir, screen), "kept", JSON.stringify(answer));
    assert.equal(screen.asked(), 1);
    assert.equal(settingsOf(dir), before, "settings.json is untouched");
    assert.deepEqual(backupsOf(dir), []);
    assert.ok(screen.out().includes(`Nothing was changed. To remove them later, run: ${MIGRATE_HOOKS_COMMAND}\n`), screen.out());
  }
});

test("legacy_hooks_migration_skips_when_not_interactive_and_prints_the_command", async (t) => {
  const dir = home(t);
  const before = settingsOf(dir);
  const screen = io({ interactive: false, lines: ["y"] });
  assert.equal(await migrateInstallHooks(dir, screen), "kept");
  assert.equal(screen.asked(), 0, "nothing is asked, and nothing read stands in for a yes");
  assert.equal(settingsOf(dir), before);
  assert.deepEqual(backupsOf(dir), []);
  assert.ok(screen.out().includes(EXPECTED), screen.out());
  assert.ok(screen.out().includes(`Nothing was changed. To remove them later, run: ${MIGRATE_HOOKS_COMMAND}\n`), screen.out());
  assert.equal(MIGRATE_HOOKS_COMMAND, "~/.rokid-coder/bin/rokid-setup migrate-hooks");
});

test("legacy_hooks_migration_writes_nothing_when_the_file_changed_after_it_was_shown", async (t) => {
  const dir = home(t);
  const file = path.join(dir, ".claude", "settings.json");
  const screen = io({ interactive: true });
  screen.readLine = async () => {
    fs.writeFileSync(file, settingsOf(dir).replace('"opus"', '"sonnet"'));
    return "y";
  };
  assert.equal(await migrateInstallHooks(dir, screen), "kept");
  assert.match(settingsOf(dir), /"sonnet"/);
  assert.ok(settingsOf(dir).includes("hook-forward.js"));
  assert.deepEqual(backupsOf(dir), []);
  assert.match(screen.out(), /changed while you were deciding/);
});

test("install_never_edits_claude_settings_and_points_to_the_migration_step", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  const before = fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8");
  // An answers file cannot consent for the person either.
  const run = world.install(world.bundle("1.0.0-test.1"), { legacy: { removeInstallHooks: true } });
  assert.equal(run.status, 0, run.output);
  assert.equal(fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(path.join(world.home, ".claude")).filter((name) => name.includes("backup")), []);
  assert.ok(run.stdout.includes(EXPECTED), run.stdout);
  assert.ok(run.stdout.includes(`To remove them later, run: ${MIGRATE_HOOKS_COMMAND}\n`), run.stdout);
  assert.equal(world.journal().steps[5].settings, undefined, "the install transaction has no settings step");

  const later = world.run(["migrate-hooks"]);
  assert.equal(later.status, 0, later.output);
  assert.ok(later.stdout.includes(EXPECTED), later.stdout);
  assert.equal(fs.readFileSync(path.join(world.home, ".claude", "settings.json"), "utf8"), before, "not a terminal: skipped again");
});
