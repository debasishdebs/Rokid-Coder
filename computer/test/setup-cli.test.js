const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeWorld } = require("./fixtures/plugin-cli/harness");
const { parseAnswers } = require("../dist/setup/answers.js");
const { pairStep } = require("../dist/setup/pair-step.js");

test("answers_cannot_confirm_pairing_and_unknown_keys_rejected", () => {
  assert.deepEqual(
    parseAnswers(JSON.stringify({ cli: { claude: "install", codex: "skip" }, legacy: { retireAutostart: true, removeInstallHooks: false }, pairing: "skip", purge: false })),
    { cli: { claude: "install", codex: "skip" }, legacy: { retireAutostart: true, removeInstallHooks: false }, pairing: "skip", purge: false },
  );
  for (const pairing of ["confirm", "yes", true, "y", { confirm: true }]) {
    assert.throws(() => parseAnswers(JSON.stringify({ pairing })), /pairing accepts only "skip"/);
  }
  assert.throws(() => parseAnswers('{"pairConfirm":true}'), /unknown key pairConfirm/);
  assert.throws(() => parseAnswers('{"cli":{"gemini":"install"}}'), /unknown key cli\.gemini/);
  assert.throws(() => parseAnswers('{"legacy":{"retireAutostart":true,"sas":"123456"}}'), /unknown key legacy\.sas/);
  assert.throws(() => parseAnswers('{"cli":{"claude":"yes"}}'), /cli\.claude must be/);
  assert.throws(() => parseAnswers("[]"), /must be an object/);
});

test("pair_step_maps_exit_status_and_offers_fallbacks", async () => {
  const io = (lines) => {
    const out = [];
    return { out, write: (text) => out.push(text), readLine: async () => lines.shift() };
  };
  const runs = (statuses) => {
    const seen = [];
    return { seen, run: async () => (seen.push("pair"), statuses.shift()) };
  };

  let pair = runs([0]);
  let screen = io([]);
  assert.equal(await pairStep(pair.run, screen), "paired");
  assert.equal(pair.seen.length, 1);

  // Not paired: Tailscale prints its steps and asks again; retry and QR re-run `agentd pair`.
  pair = runs([1, 1, 0]);
  screen = io(["t", "r", "q"]);
  assert.equal(await pairStep(pair.run, screen), "paired");
  assert.equal(pair.seen.length, 3);
  const text = screen.out.join("");
  assert.match(text, /\[R\]etry, \[T\]ailscale, \[Q\]R code, or \[L\]ater\?/);
  assert.match(text, /https:\/\/tailscale\.com\/download/);

  for (const lines of [["l"], []]) {
    pair = runs([2]);
    screen = io(lines);
    assert.equal(await pairStep(pair.run, screen), "later");
    assert.match(screen.out.join(""), /run ~\/\.rokid-coder\/bin\/agentd pair\n$/);
  }
});

test("uninstall_keeps_state_unless_purge", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  world.cli("claude");
  const bundle = world.bundle("1.0.0-test.1");
  assert.equal(world.install(bundle).status, 0);
  const state = world.stateBytes();
  world.clearCalls();

  const run = world.run(["uninstall"]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /Your pairings and settings were kept in .*\.nexus-agentd and .*\.rokid-coder/);
  const ops = world.calls().filter((c) => c.op !== "cli").map((c) => c.op);
  assert.deepEqual(ops.slice(0, 2), ["stopCurrent", "removeAutostart"]);
  assert.deepEqual(world.cliState("claude"), { marketplaces: {}, plugins: {} }, "the plugin went first, while its bundle still existed");
  const rc = path.join(world.home, ".rokid-coder");
  for (const gone of ["bin", "env", "install.json"]) assert.ok(!fs.existsSync(path.join(rc, gone)), gone);
  assert.ok(!fs.readFileSync(path.join(world.home, ".zprofile"), "utf8").includes("rokid-coder"));
  assert.deepEqual(world.stateBytes(), state, "the state is kept");
  assert.ok(fs.existsSync(bundle), "on macOS the system dir is the package's to remove");

  assert.equal(world.install(bundle).status, 0);
  const purge = world.run(["uninstall", "--purge", "--yes"]);
  assert.equal(purge.status, 0, purge.output);
  assert.ok(!fs.existsSync(path.join(world.home, ".nexus-agentd")));
  assert.ok(!fs.existsSync(path.join(rc, "tls")));
  assert.ok(!fs.existsSync(path.join(rc, "backups")));
});

test("uninstall_stops_and_stays_retryable_when_plugin_removal_fails", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  const cli = world.cli("claude");
  const bundle = world.bundle("1.0.0-test.1");
  assert.equal(world.install(bundle).status, 0);
  const working = fs.readFileSync(cli, "utf8");
  // The CLI answers its help and list, but refuses to remove anything.
  fs.writeFileSync(
    cli,
    working.replace(/^exec /m, 'case " $* " in *" uninstall "*|*" remove "*) echo "permission denied" >&2; exit 1;; esac\nexec '),
  );
  const state = world.stateBytes();

  const run = world.run(["uninstall"]);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /The claude plugin could not be removed: .*permission denied/);
  assert.match(run.output, /Nothing else was removed.*run rokid-setup uninstall again/s);
  assert.doesNotMatch(run.output, /Rokid Coder was removed/);
  assert.ok(world.cliState("claude").plugins["rokid@rokid-coder"], "the plugin is still registered");
  const rc = path.join(world.home, ".rokid-coder");
  for (const kept of ["bin", "env", "install.json"]) assert.ok(fs.existsSync(path.join(rc, kept)), `${kept} is kept`);
  assert.ok(world.manifest(), "the manifest still names the CLIs and bundles to retry with");
  assert.ok(fs.readFileSync(path.join(world.home, ".zprofile"), "utf8").includes("rokid-coder"), "the PATH block is kept");
  assert.deepEqual(world.stateBytes(), state);

  // Once the CLI can remove it again, the same command finishes the job.
  fs.writeFileSync(cli, working);
  const retry = world.run(["uninstall"]);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(world.cliState("claude"), { marketplaces: {}, plugins: {} });
  for (const gone of ["bin", "env", "install.json"]) assert.ok(!fs.existsSync(path.join(rc, gone)), gone);
});

test("uninstall_purge_requires_confirmation", async (t) => {
  const world = makeWorld(t);
  await world.seed08();
  assert.equal(world.install(world.bundle("1.0.0-test.1")).status, 0);
  const refused = world.run(["uninstall", "--purge"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /confirm with --yes/);
  assert.ok(world.manifest(), "nothing was removed");
  assert.ok(fs.existsSync(path.join(world.home, ".nexus-agentd", "config.json")));
  assert.ok(!world.calls().some((c) => c.op === "removeAutostart"));
});

test("refuses_to_run_as_root", (t) => {
  const world = makeWorld(t);
  for (const args of [["install", "--platform", "darwin", "--bundle", world.bundle("1.0.0-test.1")], ["uninstall"], ["plugins", "sync"]]) {
    const run = world.run(args, { extraEnv: { ROKID_SETUP_FAKE_UID: "0" } });
    assert.equal(run.status, 1);
    assert.equal(run.stderr, "Run Rokid Coder setup as yourself, not as root\n");
    assert.equal(run.stdout, "");
  }
  assert.deepEqual(fs.readdirSync(world.home), [], "nothing was written");
  // The uid seam is a test hook only.
  const real = world.run(["no-such-command"], { extraEnv: { ROKID_SETUP_FAKE_UID: "0", ROKID_SETUP_TEST: "" } });
  assert.match(real.stderr, /^Usage: rokid-setup/);
});
