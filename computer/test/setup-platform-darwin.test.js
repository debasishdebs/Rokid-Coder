// darwin.ts, the macOS PlatformHooks, over a fake machine: an in-process
// launchctl and lsof that record their argv and keep launchd's job table and
// the listening sockets. bootout is modelled the way launchd behaves: the job
// still prints for a while after bootout returns, and its process keeps the
// ports a little longer. Nothing here runs the real launchctl or touches the
// real ~/Library/LaunchAgents.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DIST = path.join(__dirname, "..", "dist");
const { DarwinPlatform, LEGACY_LABEL, LABEL, readPlistArray, readPlistString } = require(path.join(DIST, "setup", "platform", "darwin.js"));
const { runRestore } = require(path.join(DIST, "setup", "orchestrator.js"));
const { stateLocations } = require(path.join(DIST, "setup", "state.js"));

const UID = 501;
const PORTS = [8791, 8792];

function fakeMac(t, { gui = true, lingerPrints = 2, lingerListen = 2, homeName = "Rokid Tëst home" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-darwin-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, homeName);
  fs.mkdirSync(home, { recursive: true });
  const bundleDir = path.join(root, "RokidCoder", "1.0.0");
  fs.mkdirSync(path.join(bundleDir, "node", "bin"), { recursive: true });
  fs.writeFileSync(path.join(bundleDir, "node", "bin", "node"), "");
  const legacyNode = path.join(root, "homebrew", "bin", "node");
  fs.mkdirSync(path.dirname(legacyNode), { recursive: true });
  fs.writeFileSync(legacyNode, "");

  const machine = {
    gui,
    jobs: new Map(),
    lingering: new Map(),
    listeners: [],
    calls: [],
    nextPid: 4000,
    exeFor: (label) => (label === LEGACY_LABEL ? legacyNode : path.join(bundleDir, "node", "bin", "node")),
  };
  const listen = (pid, label) => {
    for (const port of PORTS) machine.listeners.push({ pid, port, exe: machine.exeFor(label) });
  };
  const result = (code, stdout = "", stderr = "") => ({ code, stdout, stderr });
  const launchctl = (args) => {
    const [verb, target, plist] = args;
    const domain = `gui/${UID}`;
    if (verb === "print") {
      if (target === domain) return machine.gui ? result(0, `${domain} = {\n}\n`) : result(113, "", `Could not find domain for user gui: ${UID}\n`);
      const label = target.slice(domain.length + 1);
      const job = machine.jobs.get(label);
      if (job) return result(0, `${target} = {\n\tstate = running\n\tpid = ${job.pid}\n}\n`);
      if ((machine.lingering.get(label) ?? 0) > 0) {
        machine.lingering.set(label, machine.lingering.get(label) - 1);
        return result(0, `${target} = {\n\tstate = exiting\n}\n`);
      }
      return result(113, "", `Could not find service "${label}" in domain for user gui: ${UID}\n`);
    }
    if (verb === "bootout") {
      const label = target.slice(domain.length + 1);
      const job = machine.jobs.get(label);
      if (!job) return result(3, "", "Boot-out failed: 3: No such process\n");
      machine.jobs.delete(label);
      machine.lingering.set(label, lingerPrints);
      for (const listener of machine.listeners) if (listener.pid === job.pid) listener.remaining = lingerListen;
      return result(0);
    }
    if (verb === "bootstrap") {
      if (!machine.gui) return result(125, "", "Bootstrap failed: 125: Domain does not support specified action\n");
      const label = path.basename(plist, ".plist");
      if (!fs.existsSync(plist) || machine.jobs.has(label) || (machine.lingering.get(label) ?? 0) > 0) {
        return result(5, "", "Bootstrap failed: 5: Input/output error\n");
      }
      const pid = machine.nextPid++;
      machine.jobs.set(label, { pid, plist });
      listen(pid, label);
      return result(0);
    }
    if (verb === "kickstart") {
      const label = args[2].slice(domain.length + 1);
      const job = machine.jobs.get(label);
      if (!job) return result(113);
      machine.listeners = machine.listeners.filter((l) => l.pid !== job.pid);
      job.pid = machine.nextPid++;
      listen(job.pid, label);
      return result(0);
    }
    return result(64, "", "unknown verb\n");
  };
  const lsof = (args) => {
    if (args.includes("-sTCP:LISTEN")) {
      const wanted = args.find((a) => a.startsWith("-iTCP:")).slice("-iTCP:".length).split(",").map(Number);
      const live = machine.listeners.filter((l) => wanted.includes(l.port));
      for (const listener of live) {
        if (listener.remaining !== undefined) listener.remaining -= 1;
      }
      machine.listeners = machine.listeners.filter((l) => l.remaining === undefined || l.remaining >= 0);
      if (live.length === 0) return result(1);
      return result(0, live.map((l) => `p${l.pid}\nf${l.port - 8770}\nn127.0.0.1:${l.port}\n`).join(""));
    }
    const pid = Number(args[args.indexOf("-p") + 1]);
    const listener = machine.listeners.find((l) => l.pid === pid);
    return listener ? result(0, `p${pid}\nftxt\nn${listener.exe}\nftxt\nn/usr/lib/dyld\n`) : result(1);
  };
  const run = async (command, args) => {
    machine.calls.push([path.basename(command), ...args]);
    if (path.basename(command) === "launchctl") return launchctl(args);
    if (path.basename(command) === "lsof") return lsof(args);
    return result(127, "", `no fake for ${command}\n`);
  };
  const env = { HOME: home, PATH: "/usr/bin:/bin" };
  const platform = new DarwinPlatform({ home, env, uid: UID, run, pollMs: 1, timeoutMs: 2000 });
  const manifest = (version = "1.0.0", dir = bundleDir) => ({
    schema: 1,
    version,
    platform: "darwin",
    bundleDir: dir,
    installedAt: new Date(0).toISOString(),
    clis: {},
    plugins: {},
    autostart: { kind: "launchd", label: LABEL },
  });
  /** 0.8.0 as install-launchagent.sh left it: its plist, and its job loaded and holding the ports. */
  const legacy08 = () => {
    const repo = path.join(root, "Rokid-Coder checkout");
    fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
    fs.writeFileSync(path.join(repo, "dist", "cli.js"), "");
    fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "nexus-agentd", version: "0.8.0" }));
    const plist = path.join(home, "Library", "LaunchAgents", `${LEGACY_LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LEGACY_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${legacyNode}</string>
    <string>${repo}/dist/cli.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`,
    );
    const pid = machine.nextPid++;
    machine.jobs.set(LEGACY_LABEL, { pid, plist });
    listen(pid, LEGACY_LABEL);
    return { plist, bytes: fs.readFileSync(plist), repo };
  };
  /** Our own job, loaded from a plist installAutostart wrote earlier. */
  const loadedCurrent = () => {
    const plist = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, "<plist/>\n");
    const pid = machine.nextPid++;
    machine.jobs.set(LABEL, { pid, plist });
    listen(pid, LABEL);
    return { plist, pid };
  };
  const launchctlCalls = (verb) => machine.calls.filter((c) => c[0] === "launchctl" && (!verb || c[1] === verb));
  return { root, home, env, bundleDir, legacyNode, machine, platform, manifest, legacy08, loadedCurrent, launchctlCalls };
}

test("darwin_retire_waits_for_bootout_and_frees_ports", async (t) => {
  const mac = fakeMac(t, { lingerPrints: 3, lingerListen: 3 });
  const { plist, bytes, repo } = mac.legacy08();

  const found = await mac.platform.legacyAutostart();
  assert.equal(found.label, LEGACY_LABEL);
  assert.equal(found.definitionPath, plist);
  assert.equal(found.executable, mac.legacyNode);
  assert.equal(found.version, "0.8.0");
  assert.equal(found.loaded, true);
  assert.ok(repo);

  mac.machine.calls.length = 0;
  const record = await mac.platform.retireLegacyAutostart(found);

  const calls = mac.machine.calls.map((c) => c.join(" "));
  const bootout = calls.indexOf(`launchctl bootout gui/${UID}/${LEGACY_LABEL}`);
  assert.ok(bootout >= 0, "bootout was called");
  const prints = calls.map((c, i) => [c, i]).filter(([c, i]) => i > bootout && c === `launchctl print gui/${UID}/${LEGACY_LABEL}`);
  assert.ok(prints.length >= 4, "it kept printing until launchd let go of the label");
  assert.equal(mac.machine.lingering.get(LEGACY_LABEL), 0, "the last print failed");
  const listens = calls.map((c, i) => [c, i]).filter(([c]) => c.startsWith("lsof -nP -iTCP:8791,8792 -sTCP:LISTEN"));
  assert.ok(listens.length >= 4, "it kept checking the ports until nothing listened");
  assert.ok(listens[0][1] > prints.at(-1)[1], "ports are checked after the job is gone");
  assert.equal(mac.machine.listeners.length, 0, "nothing listens when retire returns");

  assert.equal(fs.existsSync(plist), false);
  assert.equal(record.originalPath, plist);
  assert.ok(record.retiredPath.startsWith(path.join(mac.home, ".rokid-coder", "backups") + path.sep));
  assert.deepEqual(fs.readFileSync(record.retiredPath), bytes);
  assert.equal(record.wasLoaded, true);
  assert.equal(record.executable, mac.legacyNode);
  assert.equal(record.version, "0.8.0");
  assert.deepEqual(await mac.platform.portOwners(PORTS), []);
});

test("darwin_restore_legacy_restores_plist_without_starting", async (t) => {
  const mac = fakeMac(t);
  const { plist, bytes } = mac.legacy08();
  const record = await mac.platform.retireLegacyAutostart(await mac.platform.legacyAutostart());
  mac.machine.calls.length = 0;

  await mac.platform.restoreLegacyAutostart(record);

  assert.deepEqual(fs.readFileSync(plist), bytes);
  assert.equal(fs.existsSync(record.retiredPath), false);
  assert.deepEqual(mac.launchctlCalls("bootstrap"), [], "restore never starts it");
  assert.deepEqual(mac.launchctlCalls("kickstart"), []);
  assert.equal(mac.machine.jobs.has(LEGACY_LABEL), false);
});

test("legacy_rollback_bootstraps_exactly_once", async (t) => {
  const mac = fakeMac(t);
  const { plist } = mac.legacy08();
  const record = await mac.platform.retireLegacyAutostart(await mac.platform.legacyAutostart());
  mac.machine.calls.length = 0;

  const ctx = {
    home: mac.home,
    env: mac.env,
    platform: mac.platform,
    io: { interactive: false, write() {}, note() {}, readLine: async () => undefined },
    health: async () => (mac.machine.jobs.has(LEGACY_LABEL) ? { ok: true } : undefined),
    runPair: async () => 1,
    now: () => new Date(),
    timeoutMs: 2000,
  };
  const problems = await runRestore(ctx, {
    ports: PORTS,
    locations: stateLocations(mac.home, mac.env),
    ourRoots: [],
    legacy: record,
    start: { legacy: record },
    label: "your 0.8.0 setup",
  });

  assert.deepEqual(problems, []);
  const bootstraps = mac.launchctlCalls("bootstrap");
  assert.deepEqual(bootstraps, [["launchctl", "bootstrap", `gui/${UID}`, plist]], "one bootstrap, of the legacy plist");
  assert.ok(mac.machine.jobs.has(LEGACY_LABEL));
  const owners = await mac.platform.portOwners(PORTS);
  assert.deepEqual(new Set(owners.map((o) => o.owner)), new Set(["legacy"]));
  assert.deepEqual(owners.map((o) => o.port).sort(), PORTS);
});

test("darwin_install_autostart_pending_without_gui_domain", async (t) => {
  const mac = fakeMac(t, { gui: false });

  assert.equal(await mac.platform.installAutostart(mac.manifest()), "pending_next_login");

  const plist = path.join(mac.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  assert.ok(fs.existsSync(plist), "the plist is in place for the next login");
  assert.deepEqual(mac.launchctlCalls("bootstrap"), []);
  assert.deepEqual(mac.launchctlCalls("bootout"), []);
});

test("darwin_install_autostart_replaces_loaded_label", async (t) => {
  const mac = fakeMac(t, { lingerPrints: 2, lingerListen: 2 });
  const old = mac.loadedCurrent();
  mac.machine.calls.length = 0;

  assert.equal(await mac.platform.installAutostart(mac.manifest()), "running");

  const calls = mac.launchctlCalls().map((c) => c.slice(1).join(" "));
  const bootout = calls.indexOf(`bootout gui/${UID}/${LABEL}`);
  const bootstrap = calls.indexOf(`bootstrap gui/${UID} ${old.plist}`);
  assert.ok(bootout >= 0 && bootstrap > bootout, "bootout, then bootstrap");
  const waits = calls.slice(bootout + 1, bootstrap).filter((c) => c === `print gui/${UID}/${LABEL}`);
  assert.ok(waits.length >= 3, "it waited for launchd to release the label in between");
  assert.equal(mac.launchctlCalls("bootstrap").length, 1);
  const job = mac.machine.jobs.get(LABEL);
  assert.ok(job && job.pid !== old.pid, "a new process runs the label");
});

test("launchagent_plist_quotes_paths_with_spaces_and_non_ascii", async (t) => {
  const mac = fakeMac(t, { gui: false, homeName: `Rokid Tëst & <Co>'s "home"` });

  await mac.platform.installAutostart(mac.manifest());

  const plist = path.join(mac.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const xml = fs.readFileSync(plist, "utf8");
  const agentd = path.join(mac.home, ".rokid-coder", "bin", "agentd");
  assert.deepEqual(readPlistArray(xml, "ProgramArguments"), [agentd, "run"]);
  assert.equal(readPlistString(xml, "Label"), LABEL);
  assert.equal(readPlistString(xml, "StandardOutPath"), path.join(mac.home, ".rokid-coder", "logs", "agentd.out.log"));
  assert.equal(readPlistString(xml, "StandardErrorPath"), path.join(mac.home, ".rokid-coder", "logs", "agentd.err.log"));
  assert.ok(!xml.includes("KeepAlive"), "no KeepAlive, as 0.8.0");
  assert.ok(fs.statSync(path.join(mac.home, ".rokid-coder", "logs")).isDirectory());
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/plutil")) {
    assert.equal(spawnSync("/usr/bin/plutil", ["-lint", plist]).status, 0);
    const first = spawnSync("/usr/bin/plutil", ["-extract", "ProgramArguments.0", "raw", "-o", "-", plist], { encoding: "utf8" });
    assert.equal(first.stdout.replace(/\n$/, ""), agentd);
  }
});

test("darwin_stop_current_waits_for_ports_and_keeps_the_plist", async (t) => {
  const mac = fakeMac(t, { lingerPrints: 2, lingerListen: 3 });
  const old = mac.loadedCurrent();

  await mac.platform.stopCurrent(mac.manifest());

  assert.equal(mac.machine.jobs.has(LABEL), false);
  assert.equal(mac.machine.listeners.length, 0, "nothing listens when it returns");
  assert.ok(fs.existsSync(old.plist), "the plist stays, so an undo can bootstrap it again");
});

test("darwin_port_owners_tell_current_legacy_and_other_apart", async (t) => {
  const mac = fakeMac(t);
  mac.legacy08();
  mac.machine.listeners.push({ pid: 9001, port: 8791, exe: "/usr/local/bin/somethingelse" });

  const owners = await mac.platform.portOwners(PORTS);

  assert.deepEqual(
    owners.map((o) => `${o.port}:${o.owner}`).sort(),
    ["8791:legacy", "8791:other", "8792:legacy"],
  );
  mac.machine.listeners = mac.machine.listeners.filter((l) => l.pid !== 9001);
  await mac.platform.retireLegacyAutostart(await mac.platform.legacyAutostart());
  await mac.platform.installAutostart(mac.manifest());
  assert.deepEqual(new Set((await mac.platform.portOwners(PORTS)).map((o) => o.owner)), new Set(["current"]));
});
