// Which version dirs are still in use, across every user the directory
// service knows: postinstall's pruning and uninstall.sh --system both ask
// lib/references.sh, so the two can never disagree [6b-R6, 6b-R19].
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MACOS, makeMac } = require("./helpers");

const skip = process.platform !== "darwin" && "the installer scripts run on macOS";
const UNINSTALL = path.join(MACOS, "uninstall.sh");
const v = (n) => `1.0.0-test.${n}`;

/**
 * A: on test.1 with previous test.0. B: on test.2, its handoff committed. C:
 * an open journal for test.1 and test.4, nothing committed. D (home outside
 * /Users): only a pending handoff, for test.5. A closed journal names test.-1.
 */
function crowdedMac(t) {
  const mac = makeMac(t);
  const dirs = Object.fromEntries(["-1", "0", "1", "2", "4", "5", "6"].map((n) => [n, mac.version(v(n))]));
  const a = mac.user("alice", { uid: 501, home: path.join(mac.root, "Users", "alice") });
  const b = mac.user("bob", { uid: 502, home: path.join(mac.root, "Users", "Bob Tëst") });
  const c = mac.user("carol", { uid: 503, home: path.join(mac.root, "Users", "carol") });
  mac.user("dave", { uid: 504, home: path.join(mac.root, "Volumes", "Data", "homes", "u2") });
  mac.installJson(a, { version: v(1), bundleDir: dirs["1"], previous: { version: v(0), bundleDir: dirs["0"] } });
  mac.journal(a, { open: false, newManifest: { bundleDir: dirs["-1"] } });
  mac.installJson(b, { version: v(2), bundleDir: dirs["2"] });
  mac.handoff(502, { version: v(2), bundleDir: dirs["2"] });
  mac.journal(c, { open: true, newManifest: { bundleDir: dirs["4"] }, previousManifest: { bundleDir: dirs["1"] } });
  mac.handoff(504, { version: v(5), bundleDir: dirs["5"] });
  return { mac, dirs };
}

test("prune_keeps_every_referenced_version_across_users", { skip }, (t) => {
  const { mac, dirs } = crowdedMac(t);
  mac.console("loginwindow", 0);

  const result = mac.run(path.join(mac.scripts(v(6)), "postinstall"));

  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(dirs["-1"]), false, "the one version nothing references is gone");
  for (const n of ["0", "1", "2", "4", "5", "6"]) assert.ok(fs.existsSync(dirs[n]), `${v(n)} is kept`);
  assert.ok(fs.existsSync(path.join(mac.installRoot, "handoff")));
  assert.deepEqual(mac.calls("dscl").find((c) => c[2] === "-list"), ["dscl", ".", "-list", "/Users", "NFSHomeDirectory"]);
});

test("prune_never_touches_what_is_not_a_version_dir", { skip }, (t) => {
  const mac = makeMac(t);
  mac.version("1.0.0");
  fs.mkdirSync(path.join(mac.installRoot, "something-else"));
  fs.writeFileSync(path.join(mac.installRoot, "notes.txt"), "keep me\n");
  mac.console("loginwindow", 0);

  mac.run(path.join(mac.scripts("1.0.0"), "postinstall"));

  assert.ok(fs.existsSync(path.join(mac.installRoot, "something-else")));
  assert.ok(fs.existsSync(path.join(mac.installRoot, "notes.txt")));
});

test("uninstall_system_refuses_while_other_users_installed", { skip }, (t) => {
  const { mac } = crowdedMac(t);
  mac.whoami("root", 0);

  const refused = mac.run(UNINSTALL, ["--system"], { extraEnv: { SUDO_USER: "alice" } });

  assert.notEqual(refused.status, 0);
  for (const user of ["bob", "carol", "dave"]) assert.match(refused.output, new RegExp(`\\b${user}\\b`), user);
  assert.match(refused.output, /dave.*pending setup/);
  assert.match(refused.output, /alice/, "alice's own install still counts while she has one");
  assert.ok(fs.existsSync(mac.installRoot), "nothing was removed");
  assert.deepEqual(mac.calls("pkgutil"), []);

  // Only a pending handoff of dave's, outside /Users, still refuses.
  for (const name of ["alice", "bob"]) fs.rmSync(path.join(mac.root, "Users", name === "bob" ? "Bob Tëst" : name, ".rokid-coder"), { recursive: true });
  fs.rmSync(path.join(mac.root, "Users", "carol", ".rokid-coder"), { recursive: true });
  fs.rmSync(path.join(mac.installRoot, "handoff", "502.json"));
  const pending = mac.run(UNINSTALL, ["--system"], { extraEnv: { SUDO_USER: "alice" } });
  assert.notEqual(pending.status, 0);
  assert.match(pending.output, /dave/);
  assert.doesNotMatch(pending.output, /\b(alice|bob|carol)\b/);

  const forced = mac.run(UNINSTALL, ["--system", "--force"], { extraEnv: { SUDO_USER: "alice" } });
  assert.equal(forced.status, 0, forced.output);
  assert.equal(fs.existsSync(mac.installRoot), false);
  assert.deepEqual(mac.calls("pkgutil"), [["pkgutil", "--forget", "io.github.debasishdebs.rokidcoder.computer"]]);
});

test("uninstall_system_ignores_the_invokers_own_pending_handoff", { skip }, (t) => {
  const mac = makeMac(t);
  const dir = mac.version("1.0.0");
  mac.user("alice", { uid: 501, home: path.join(mac.root, "Users", "alice") });
  mac.handoff(501, { version: "1.0.0", bundleDir: dir });
  mac.whoami("root", 0);

  const result = mac.run(UNINSTALL, ["--system"], { extraEnv: { SUDO_USER: "alice" } });

  assert.equal(result.status, 0, result.output);
  assert.equal(fs.existsSync(mac.installRoot), false);
});

test("uninstall_as_user_runs_rokid_setup_then_reexecs_under_sudo_for_system", { skip }, (t) => {
  const mac = makeMac(t);
  const record = path.join(mac.root, "setup-argv.txt");
  const dir = mac.version("1.0.0", { setupLog: record });
  fs.copyFileSync(UNINSTALL, path.join(dir, "uninstall.sh"));
  fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(MACOS, "lib", "references.sh"), path.join(dir, "lib", "references.sh"));
  mac.whoami("alice", 501);

  const user = mac.run(path.join(dir, "uninstall.sh"), ["--purge", "--yes"]);
  assert.equal(user.status, 0, user.output);
  assert.deepEqual(
    fs.readFileSync(record, "utf8").split("\n").filter((l) => l.startsWith("arg=")),
    ["arg=uninstall", "arg=--purge", "arg=--yes"],
  );
  assert.deepEqual(mac.calls("sudo"), []);

  const system = mac.run(path.join(dir, "uninstall.sh"), ["--system"]);
  assert.equal(system.status, 0, system.output);
  const [sudo] = mac.calls("sudo");
  assert.deepEqual(sudo, ["sudo", "/bin/sh", path.join(dir, "uninstall.sh"), "--system"]);
});
