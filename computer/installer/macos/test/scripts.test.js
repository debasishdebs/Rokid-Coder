// The package's shell scripts over fake system commands: who setup runs as
// (resolve-user.sh), how it is started (launch-setup.sh), postinstall's
// handoff and pending marker, and "Rokid Coder Setup.command" itself.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MACOS, makeMac } = require("./helpers");

const skip = process.platform !== "darwin" && "the installer scripts run on macOS";
const RESOLVE = path.join(MACOS, "lib", "resolve-user.sh");
const LAUNCH = path.join(MACOS, "lib", "launch-setup.sh");
const SETUP_COMMAND = path.join(MACOS, "Rokid Coder Setup.command");

test("resolve_console_user_eligible", { skip }, (t) => {
  const mac = makeMac(t);
  const home = mac.user("tester", { uid: 502, home: path.join(mac.root, "Users", "Rokid Tëst"), shell: "/bin/bash" });
  mac.console("tester", 502);

  const result = mac.run(RESOLVE);

  assert.equal(result.status, 0, result.output);
  assert.equal(result.stdout, `tester\t502\t${home}\t/bin/bash\n`);
  assert.deepEqual(mac.calls("dscl"), [["dscl", ".", "-read", "/Users/tester", "NFSHomeDirectory", "UserShell"]]);
  assert.deepEqual(mac.calls("stat"), [["stat", "-f%Su", "/dev/console"]]);
});

test("resolve_console_user_rejects_root_loginwindow_mbsetupuser", { skip }, (t) => {
  const mac = makeMac(t);
  for (const [name, uid] of [["root", 0], ["loginwindow", 0], ["_mbsetupuser", 248]]) {
    mac.user(name, { uid, home: path.join(mac.root, "homes", name) });
    mac.console(name, uid);
    const result = mac.run(RESOLVE);
    assert.equal(result.status, 2, name);
    assert.equal(result.stdout, "no_eligible_user\n", name);
  }
  // No one at the console at all, and a console owner that disagrees with scutil.
  fs.writeFileSync(path.join(mac.data, "scutil.out"), "  No such key\n");
  assert.equal(mac.run(RESOLVE).stdout, "no_eligible_user\n");
  mac.user("tester", { uid: 501, home: path.join(mac.root, "homes", "tester") });
  mac.console("tester", 501, { statUser: "someoneelse" });
  assert.equal(mac.run(RESOLVE).stdout, "no_eligible_user\n");
});

test("resolve_console_user_rejects_uid_below_501_and_missing_home", { skip }, (t) => {
  const mac = makeMac(t);
  mac.user("service", { uid: 499, home: path.join(mac.root, "homes", "service") });
  mac.console("service", 499);
  assert.equal(mac.run(RESOLVE).stdout, "no_eligible_user\n");

  mac.user("nohome", { uid: 503, home: path.join(mac.root, "homes", "nohome"), createHome: false });
  mac.console("nohome", 503);
  assert.equal(mac.run(RESOLVE).stdout, "no_eligible_user\n");

  mac.console("ghost", 504);
  fs.writeFileSync(path.join(mac.data, "console-user"), "ghost\n");
  const ghost = mac.run(RESOLVE);
  assert.equal(ghost.status, 2);
  assert.equal(ghost.stdout, "no_eligible_user\n", "a user the directory service does not know");
});

test("cli_install_defers_setup", { skip }, (t) => {
  const mac = makeMac(t);
  mac.user("tester", { uid: 501, home: path.join(mac.root, "homes", "tester") });
  mac.console("tester", 501);

  const result = mac.run(RESOLVE, [], { extraEnv: { COMMAND_LINE_INSTALL: "1" } });

  assert.equal(result.status, 2);
  assert.equal(result.stdout, "deferred_cli_install\n");
  assert.deepEqual(mac.calls(), [], "a `sudo installer` run never asks whose machine it is");
});

test("launch_setup_uses_asuser_sudo_and_explicit_env", { skip }, (t) => {
  const mac = makeMac(t);
  const bundle = mac.version("1.0.0");
  const home = mac.user("tester", { uid: 502, home: path.join(mac.root, "Users", "Rokid Tëst") });
  mac.userTmpdir("/var/folders/ab/cd/T/");

  const result = mac.run(LAUNCH, ["502", "tester", home, "/bin/zsh"], { extraEnv: { ROKID_VERSION: "1.0.0", ROKID_BUNDLE_DIR: bundle } });

  assert.equal(result.status, 0, result.output);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mac.installRoot, "handoff", "502.json"), "utf8")), { uid: 502, version: "1.0.0", bundleDir: bundle });
  assert.deepEqual(mac.calls("sudo"), [["sudo", "-u", "tester", "/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]]);
  assert.deepEqual(mac.calls("launchctl"), [
    [
      "launchctl",
      "asuser",
      "502",
      mac.env.SUDO,
      "-u",
      "tester",
      "-H",
      "/usr/bin/env",
      "-i",
      `HOME=${home}`,
      "USER=tester",
      "LOGNAME=tester",
      "SHELL=/bin/zsh",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
      "TMPDIR=/var/folders/ab/cd/T/",
      "/usr/bin/open",
      "-a",
      "Terminal",
      `${bundle}/Rokid Coder Setup.command`,
    ],
  ]);
});

test("launch_setup_runs_a_given_command_in_place_of_terminal", { skip }, (t) => {
  const mac = makeMac(t);
  const bundle = mac.version("1.0.0");
  const home = mac.user("tester", { uid: 502, home: path.join(mac.root, "Users", "tester") });
  mac.userTmpdir("/var/folders/x/T/");

  mac.run(LAUNCH, ["502", "tester", home, "/bin/zsh", "--", `${bundle}/bin/rokid-setup`, "install", "--answers", "a.json"], {
    extraEnv: { ROKID_VERSION: "1.0.0", ROKID_BUNDLE_DIR: bundle },
  });

  assert.deepEqual(mac.calls("launchctl")[0].slice(-4), [`${bundle}/bin/rokid-setup`, "install", "--answers", "a.json"]);
});

test("postinstall_exits_0_and_writes_pending_marker_without_eligible_user", { skip }, (t) => {
  const mac = makeMac(t);
  const bundle = mac.version("1.0.0");
  mac.user("loginwindow", { uid: 0, home: path.join(mac.root, "homes", "lw") });
  mac.console("loginwindow", 0);
  const scripts = mac.scripts("1.0.0");

  const result = mac.run(path.join(scripts, "postinstall"), ["/pkg", "/Library/Application Support/RokidCoder", "/", "/"]);

  assert.equal(result.status, 0, result.output);
  const command = `"${bundle}/bin/rokid-setup" install --platform darwin --bundle "${bundle}"`;
  const message = `Rokid Coder is installed. To finish, open "Rokid Coder Setup" from the disk image, or run: ${command}`;
  assert.ok(result.stdout.includes(message), result.stdout);
  assert.ok(fs.readFileSync(mac.installLog, "utf8").includes(message));
  const marker = fs.readFileSync(path.join(mac.installRoot, "pending-setup"), "utf8");
  assert.match(marker, /^version 1\.0\.0$/m);
  assert.match(marker, /^reason no_eligible_user$/m);
  assert.ok(marker.includes(command));
  assert.deepEqual(mac.calls("launchctl"), [], "nothing was started");
  const installed = fs.readFileSync(path.join(mac.installRoot, "installed-version"), "utf8");
  assert.match(installed, /<key>version<\/key>\s*<string>1\.0\.0<\/string>/);

  // A `sudo installer` run defers the same way, and says why.
  mac.user("tester", { uid: 501, home: path.join(mac.root, "homes", "tester") });
  mac.console("tester", 501);
  const cli = mac.run(path.join(scripts, "postinstall"), [], { extraEnv: { COMMAND_LINE_INSTALL: "1" } });
  assert.equal(cli.status, 0);
  assert.match(fs.readFileSync(path.join(mac.installRoot, "pending-setup"), "utf8"), /^reason deferred_cli_install$/m);
  assert.deepEqual(mac.calls("launchctl"), []);
});

test("postinstall_hands_setup_to_the_console_user", { skip }, (t) => {
  const mac = makeMac(t);
  const bundle = mac.version("1.0.0");
  const home = mac.user("tester", { uid: 501, home: path.join(mac.root, "Users", "tester") });
  mac.console("tester", 501);
  mac.userTmpdir("/var/folders/t/T/");

  const result = mac.run(path.join(mac.scripts("1.0.0"), "postinstall"));

  assert.equal(result.status, 0, result.output);
  const [launch] = mac.calls("launchctl");
  assert.deepEqual(launch.slice(0, 3), ["launchctl", "asuser", "501"]);
  assert.ok(launch.includes(`HOME=${home}`));
  assert.equal(launch.at(-1), `${bundle}/Rokid Coder Setup.command`);
  assert.equal(fs.existsSync(path.join(mac.installRoot, "pending-setup")), false);
});

test("postinstall_fails_only_when_the_payload_is_missing", { skip }, (t) => {
  const mac = makeMac(t);
  const result = mac.run(path.join(mac.scripts("1.0.0"), "postinstall"));
  assert.notEqual(result.status, 0);
});

test("setup_command_refuses_root_and_rederives_home", { skip }, (t) => {
  const mac = makeMac(t);
  const record = path.join(mac.root, "setup-argv.txt");
  const bundle = mac.version("1.0.0", { setupLog: record });
  fs.copyFileSync(SETUP_COMMAND, path.join(bundle, "Rokid Coder Setup.command"));
  const command = path.join(bundle, "Rokid Coder Setup.command");
  const home = mac.user("tester", { uid: 501, home: path.join(mac.root, "Users", "Rokid Tëst"), shell: "/bin/bash" });

  mac.whoami("root", 0);
  const root = mac.run(command, [], { extraEnv: { HOME: "/var/root" } });
  assert.notEqual(root.status, 0);
  assert.match(root.output, /Run Rokid Coder setup as yourself, not as root/);
  assert.equal(fs.existsSync(record), false);

  mac.whoami("tester", 501);
  mac.handoff(501, { version: "1.0.0", bundleDir: bundle });
  const ok = mac.run(command, [], { extraEnv: { HOME: "/tmp/not-the-home", SHELL: "/bin/false", USER: "intruder" } });
  assert.equal(ok.status, 0, ok.output);
  const seen = fs.readFileSync(record, "utf8");
  assert.match(seen, new RegExp(`^HOME=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(seen, /^SHELL=\/bin\/bash$/m);
  assert.match(seen, /^USER=tester$/m);
  assert.match(seen, /^LOGNAME=tester$/m);
  assert.equal(
    seen.split("\n").filter((l) => l.startsWith("arg=")).join("|"),
    ["install", "--platform", "darwin", "--bundle", bundle].map((a) => `arg=${a}`).join("|"),
  );
  assert.doesNotMatch(ok.output, /another user/);
  assert.equal(ok.stderr, "", "a first run, with no setup.log yet, prints nothing of its own");
});

test("setup_command_says_so_when_the_handoff_was_for_another_user", { skip }, (t) => {
  const mac = makeMac(t);
  const record = path.join(mac.root, "setup-argv.txt");
  const bundle = mac.version("1.0.0", { setupLog: record });
  fs.copyFileSync(SETUP_COMMAND, path.join(bundle, "Rokid Coder Setup.command"));
  mac.user("tester", { uid: 501, home: path.join(mac.root, "Users", "tester") });
  mac.whoami("tester", 501);
  mac.handoff(502, { version: "1.0.0", bundleDir: bundle });

  const result = mac.run(path.join(bundle, "Rokid Coder Setup.command"));

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /uid 502/);
  assert.ok(fs.existsSync(record), "it still sets up the current user");
});

test("setup_command_from_the_disk_image_uses_the_installed_version", { skip }, (t) => {
  const mac = makeMac(t);
  const record = path.join(mac.root, "setup-argv.txt");
  const bundle = mac.version("1.0.0", { setupLog: record });
  fs.writeFileSync(path.join(mac.installRoot, "installed-version"), "<plist version=\"1.0\">\n<dict>\n\t<key>version</key>\n\t<string>1.0.0</string>\n</dict>\n</plist>\n");
  const dmg = path.join(mac.root, "Volumes", "Rokid Coder");
  fs.mkdirSync(dmg, { recursive: true });
  fs.copyFileSync(SETUP_COMMAND, path.join(dmg, "Rokid Coder Setup.command"));
  mac.user("tester", { uid: 501, home: path.join(mac.root, "Users", "tester") });
  mac.whoami("tester", 501);

  const result = mac.run(path.join(dmg, "Rokid Coder Setup.command"));

  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(record, "utf8"), new RegExp(`^arg=${bundle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
});

test("setup_command_prints_the_local_network_hint_when_pairing_did_not_finish", { skip }, (t) => {
  const mac = makeMac(t);
  const bundle = mac.version("1.0.0");
  const home = mac.user("tester", { uid: 501, home: path.join(mac.root, "Users", "tester") });
  fs.writeFileSync(
    path.join(bundle, "bin", "rokid-setup"),
    `#!/bin/sh\nmkdir -p "$HOME/.rokid-coder/logs"\necho "Not paired yet. [R]etry, [T]ailscale, [Q]R code, or [L]ater? " >> "$HOME/.rokid-coder/logs/setup.log"\n`,
  );
  fs.copyFileSync(SETUP_COMMAND, path.join(bundle, "Rokid Coder Setup.command"));
  mac.whoami("tester", 501);
  fs.mkdirSync(path.join(home, ".rokid-coder", "logs"), { recursive: true });
  fs.writeFileSync(path.join(home, ".rokid-coder", "logs", "setup.log"), "an earlier run\n");

  const result = mac.run(path.join(bundle, "Rokid Coder Setup.command"));

  assert.match(result.output, /Privacy & Security > Local Network/);

  fs.writeFileSync(path.join(bundle, "bin", "rokid-setup"), "#!/bin/sh\nexit 0\n");
  assert.doesNotMatch(mac.run(path.join(bundle, "Rokid Coder Setup.command")).output, /Local Network/, "only for this run's pairing");
});
