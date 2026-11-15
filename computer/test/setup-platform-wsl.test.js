// wsl.ts (6b T8): the scheduled task, the stop, the legacy NexusAgentd retire,
// all through interop. Windows is fake (installer/windows/test/fake-interop):
// a fake C: drive, schtasks.exe, powershell.exe, wslpath and procfs. Its
// schtasks.exe refuses a Linux path where Windows needs a Windows one [6b-R18].
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { makeWorld, writeBundle, NODE, SETUP_MAIN } = require("./fixtures/plugin-cli/harness.js");
const W = require("../installer/windows/test/fake-interop/world.js");
const { createPlatform, TASK } = require("../dist/setup/platform/wsl.js");
const { ensureConfig, saveConfig } = require("../dist/config.js");
const { freePort } = require("./helpers/daemon.js");

const WINDOWS = path.join(__dirname, "..", "installer", "windows");
const FAKE_AGENTD = path.join(WINDOWS, "test", "fake-interop", "fake-agentd.js");
const USER = "Zoë Müller";
const LOCAL = `C:\\Users\\${USER}\\AppData\\Local`;
const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";

const xmlEscape = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function fakeWindows(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-wsl-")));
  t.after(() => {
    for (const name of fs.existsSync(path.join(root, "proc")) ? fs.readdirSync(path.join(root, "proc")) : []) {
      if (/^\d+$/.test(name)) {
        try {
          process.kill(Number(name), "SIGKILL");
        } catch {
          // gone
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return W.createWindows(root, { localAppData: LOCAL });
}

/** A bundle where setup puts it in WSL, whose agentd is the fake one. */
function wslBundle(home, version) {
  const dir = path.join(home, ".local", "share", "rokid-coder", version);
  writeBundle(dir, version);
  W.writeExecutable(path.join(dir, "bin", "agentd"), fs.readFileSync(path.join(__dirname, "..", "installer", "wrappers", "agentd.sh"), "utf8"));
  W.writeExecutable(path.join(dir, "node", "bin", "node"), `#!/bin/sh\nexec '${NODE}' "$@"\n`);
  fs.mkdirSync(path.join(dir, "app", "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "app", "dist", "cli.js"), `require(${JSON.stringify(FAKE_AGENTD)});\n`);
  return fs.realpathSync(dir);
}

/**
 * What user-setup.ps1 stages for one generation (New-StagedGeneration in
 * RokidCoder.psm1): binding-<gen>.json, <gen>\start-agentd.ps1 and <gen>\task.xml,
 * the task rendered from the same task.xml.template, UTF-16LE with a BOM.
 */
function stage(win, { gen, home, bundleDir, mode = "mirrored", hosts = mode === "nat" ? ["192.168.1.40"] : undefined }) {
  const binding = `${LOCAL}\\RokidCoder\\binding-${gen}.json`;
  const launcher = `${LOCAL}\\Programs\\RokidCoder\\${gen}\\start-agentd.ps1`;
  const taskXml = `${LOCAL}\\Programs\\RokidCoder\\${gen}\\task.xml`;
  const contents = {
    windowsSid: SID,
    windowsUser: `LAPTOP\\${USER}`,
    distroName: "Ubuntu",
    distroGuid: "{0b5bd4a5-7a7c-4d66-9c43-6e0c2f6f0f11}",
    linuxUser: "zoe",
    linuxUid: 1000,
    linuxHome: home,
    bundleDir,
    agentdPath: `${home}/.rokid-coder/bin/agentd`,
    wslExe: "C:\\Windows\\System32\\wsl.exe",
    networkMode: mode,
    advertisePort: mode === "nat" ? 8794 : 8792,
    ...(hosts ? { advertiseHosts: hosts } : {}),
  };
  fs.mkdirSync(path.dirname(win.toLinux(binding)), { recursive: true });
  fs.writeFileSync(win.toLinux(binding), `${JSON.stringify(contents, null, 2)}\n`);
  fs.mkdirSync(path.dirname(win.toLinux(launcher)), { recursive: true });
  fs.copyFileSync(path.join(WINDOWS, "start-agentd.ps1"), win.toLinux(launcher));
  const args = `--headless "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${launcher}" -Binding "${binding}"`;
  const xml = fs
    .readFileSync(path.join(WINDOWS, "task.xml.template"), "utf8")
    .replace(/\{\{SID\}\}/g, xmlEscape(SID))
    .replace(/\{\{DISTRO\}\}/g, "Ubuntu")
    .replace(/\{\{GENERATION\}\}/g, gen)
    .replace(/\{\{COMMAND\}\}/g, xmlEscape("C:\\Windows\\System32\\conhost.exe"))
    .replace(/\{\{ARGUMENTS\}\}/g, xmlEscape(args));
  fs.writeFileSync(win.toLinux(taskXml), W.utf16(xml));
  return {
    binding,
    taskXml,
    launcher,
    contents,
    record: { contents, bindingPath: { win: binding, linux: win.toLinux(binding) }, taskXmlPath: { win: taskXml, linux: win.toLinux(taskXml) } },
    files: () => [binding, launcher, taskXml].map((file) => fs.readFileSync(win.toLinux(file)).toString("base64")),
  };
}

function platformFor(win, home, overrides = {}) {
  return createPlatform(
    { home, env: { HOME: home, PATH: `${win.binDir}:/usr/bin:/bin` } },
    { system32: win.system32, procRoot: win.procRoot, stopTimeoutMs: 3000, interactive: false, env: { HOME: home, PATH: `${win.binDir}:/usr/bin:/bin` }, ...overrides },
  );
}

function manifestFor(bundleDir, version, staged) {
  return { schema: 1, version, platform: "wsl", bundleDir, installedAt: "2026-11-15T00:00:00Z", clis: {}, plugins: {}, autostart: { kind: "wsl-task", label: TASK }, ...(staged ? { binding: staged.record } : {}) };
}

/** A fake agentd from `bundleDir`, started straight (no task), registered in the fake procfs. */
async function startAgentd(win, bundleDir, { command = "run", term, ports } = {}) {
  const ready = path.join(win.root, `ready-${Math.random().toString(36).slice(2)}`);
  const child = spawn(NODE, [path.join(bundleDir, "app", "dist", "cli.js"), command], {
    stdio: "ignore",
    env: { HOME: os.tmpdir(), FAKE_PROC_ROOT: win.procRoot, FAKE_PORTS: (ports ?? [await freePort(), await freePort()]).join(","), FAKE_READY_FILE: ready, ...(term ? { FAKE_TERM: term } : {}) },
  });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(ready)) {
    if (Date.now() > deadline) throw new Error("the fake agentd did not start");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return child;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const exited = (child) => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve)));

test("wsl_install_autostart_runs_task_via_interop", async (t) => {
  const win = fakeWindows(t);
  const home = path.join(win.root, "home dir");
  const b1 = wslBundle(home, "1.0.0");
  const g1 = stage(win, { gen: "1.0.0-20261115100000", home, bundleDir: b1 });
  const platform = platformFor(win, home);
  assert.equal(await platform.installAutostart(manifestFor(b1, "1.0.0", g1)), "running");
  const schtasks = win.calls().filter((call) => call[0] === "schtasks.exe").map((call) => call.slice(1));
  assert.deepEqual(schtasks, [
    ["/Create", "/TN", "\\RokidCoder\\agentd", "/XML", g1.taskXml, "/F"],
    ["/Run", "/TN", "\\RokidCoder\\agentd"],
  ]);
  assert.deepEqual(win.task(TASK), fs.readFileSync(win.toLinux(g1.taskXml)), "registered from the staged definition, unchanged");

  // An upgrade exports the registered definition first, UTF-16LE with a BOM, then replaces it.
  const b2 = wslBundle(home, "1.1.0");
  const g2 = stage(win, { gen: "1.1.0-20261116100000", home, bundleDir: b2 });
  win.clearCalls();
  await platform.installAutostart(manifestFor(b2, "1.1.0", g2));
  const previous = win.toLinux(`${LOCAL}\\RokidCoder\\journal\\task-previous.xml`);
  assert.deepEqual([...fs.readFileSync(previous).subarray(0, 2)], [0xff, 0xfe]);
  assert.deepEqual(fs.readFileSync(previous), fs.readFileSync(win.toLinux(g1.taskXml)));
  assert.deepEqual(win.task(TASK), fs.readFileSync(win.toLinux(g2.taskXml)));
  const order = win.calls().map((call) => (call[0] === "powershell.exe" ? /rokid:([a-z-]+)/.exec(call[4])[1] : call[1]));
  assert.ok(order.indexOf("export-task") < order.indexOf("/Create"), `exported before /Create: ${order}`);

  // Recovery to the first install re-creates it from the export, which names its own files.
  win.clearCalls();
  await platform.installAutostart(manifestFor(b1, "1.0.0", g1));
  const create = win.calls().find((call) => call[1] === "/Create");
  assert.equal(create[5], `${LOCAL}\\RokidCoder\\journal\\task-previous.xml`);
  assert.deepEqual(win.task(TASK), fs.readFileSync(win.toLinux(g1.taskXml)));
});

test("wsl_stop_matches_exe_and_cmdline_only", async (t) => {
  const win = fakeWindows(t);
  const home = path.join(win.root, "home dir");
  const b1 = wslBundle(home, "1.0.0");
  const b0 = wslBundle(home, "0.9.0");
  const ours = await startAgentd(win, b1);
  const pair = await startAgentd(win, b1, { command: "pair" });
  const other = await startAgentd(win, b0);
  t.after(() => [ours, pair, other].forEach((child) => child.kill("SIGKILL")));
  await platformFor(win, home).stopCurrent(manifestFor(b1, "1.0.0"));
  await exited(ours);
  assert.equal(isAlive(ours.pid), false, "the bundle's own `cli.js run` is stopped");
  assert.equal(isAlive(pair.pid), true, "the same node running another command is left alone");
  assert.equal(isAlive(other.pid), true, "another bundle's agentd is left alone");
  assert.deepEqual(win.calls().find((call) => call[0] === "schtasks.exe"), ["schtasks.exe", "/End", "/TN", "\\RokidCoder\\agentd"]);
});

test("wsl_stop_current_waits_for_exit_and_free_ports", async (t) => {
  const win = fakeWindows(t);
  const home = path.join(win.root, "home dir");
  const b1 = wslBundle(home, "1.0.0");
  const ports = [await freePort(), await freePort()];
  const slow = await startAgentd(win, b1, { term: "500", ports });
  t.after(() => slow.kill("SIGKILL"));
  const platform = platformFor(win, home, { stopTimeoutMs: 3000 });
  const started = Date.now();
  await platform.stopCurrent(manifestFor(b1, "1.0.0"));
  assert.ok(Date.now() - started >= 450, "it waited for the process to finish exiting");
  assert.equal(isAlive(slow.pid), false);
  assert.deepEqual(await platform.portOwners(ports), [], "and its ports are free");

  // One that ignores SIGTERM is killed when the wait runs out: that pid only.
  const stuck = await startAgentd(win, b1, { term: "ignore", ports });
  const bystander = await startAgentd(win, b1, { command: "pair" });
  t.after(() => [stuck, bystander].forEach((child) => child.kill("SIGKILL")));
  await platformFor(win, home, { stopTimeoutMs: 600 }).stopCurrent(manifestFor(b1, "1.0.0"));
  await exited(stuck);
  assert.equal(stuck.signalCode, "SIGKILL");
  assert.equal(isAlive(bystander.pid), true);
  W.reap(win.procRoot);
  assert.deepEqual(await platform.portOwners(ports), []);
});

const LEGACY_XML = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"C:\\Users\\${USER}\\Rokid-Coder\\agentd\\scripts\\run-hidden.vbs"</Arguments></Exec></Actions>
</Task>
`;
const LEGACY_PROC = {
  pid: 4242,
  name: "node.exe",
  executablePath: "C:\\Program Files\\nodejs\\node.exe",
  commandLine: `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\${USER}\\Rokid-Coder\\agentd\\dist\\cli.js" run`,
  creationDate: "2026-11-01T08:00:00.0000000Z",
};

function seedLegacy(win) {
  win.update((state) => {
    state.tasks.nexusagentd = W.utf16(LEGACY_XML).toString("base64");
    state.listeners = [8791, 8792].map((port) => ({ ...LEGACY_PROC, port }));
    state.legacyRunner = [8791, 8792].map((port) => ({ ...LEGACY_PROC, pid: 5151, port }));
  });
  const pkg = win.toLinux(`C:\\Users\\${USER}\\Rokid-Coder\\agentd\\package.json`);
  fs.mkdirSync(path.dirname(pkg), { recursive: true });
  fs.writeFileSync(pkg, JSON.stringify({ name: "nexus-agentd", version: "0.8.0" }));
}

test("wsl_legacy_task_exported_then_restored", async (t) => {
  const win = fakeWindows(t);
  const home = path.join(win.root, "home dir");
  seedLegacy(win);
  const platform = platformFor(win, home);
  const found = await platform.legacyAutostart();
  assert.deepEqual(found, {
    kind: "wsl-task",
    label: "NexusAgentd",
    definitionPath: "\\NexusAgentd",
    executable: LEGACY_PROC.executablePath,
    version: "0.8.0",
    loaded: true,
  });
  assert.deepEqual((await platform.portOwners([8791, 8792])).map((owner) => owner.owner), ["legacy", "legacy"]);

  const retired = await platform.retireLegacyAutostart(found);
  assert.equal(win.task("NexusAgentd"), undefined, "the task is deleted");
  assert.deepEqual(win.state().stopped, [4242], "and its detached node, by its exact identity");
  assert.deepEqual(await platform.portOwners([8791, 8792]), [], "the ports are free");
  assert.equal(retired.retiredPath, win.toLinux(`${LOCAL}\\RokidCoder\\journal\\NexusAgentd.xml`));
  const exported = fs.readFileSync(retired.retiredPath);
  assert.deepEqual([...exported.subarray(0, 2)], [0xff, 0xfe], "exported UTF-16LE with a BOM");
  assert.equal(W.decodeXml(exported), LEGACY_XML, "non-ASCII paths intact");

  win.clearCalls();
  await platform.restoreLegacyAutostart(retired);
  assert.equal(W.decodeXml(win.task("NexusAgentd")), LEGACY_XML);
  const schtasks = win.calls().filter((call) => call[0] === "schtasks.exe");
  assert.deepEqual(schtasks, [["schtasks.exe", "/Create", "/TN", "NexusAgentd", "/XML", `${LOCAL}\\RokidCoder\\journal\\NexusAgentd.xml`, "/F"]], "re-created, not started");
  await platform.startLegacyAutostart(retired);
  assert.deepEqual(win.calls().at(-1), ["schtasks.exe", "/Run", "/TN", "NexusAgentd"]);
  assert.deepEqual((await platform.portOwners([8791])).map((owner) => owner.owner), ["legacy"]);
});

test("wsl_legacy_reused_pid_is_never_stopped", async (t) => {
  const win = fakeWindows(t);
  const home = path.join(win.root, "home dir");
  seedLegacy(win);
  const platform = platformFor(win, home, { stopTimeoutMs: 300 });
  const found = await platform.legacyAutostart();
  // The pid now names another process started later: same image, another identity.
  win.update((state) => {
    state.listeners = state.listeners.map((proc) => ({ ...proc, creationDate: "2026-11-15T09:00:00.0000000Z" }));
  });
  await assert.rejects(platform.retireLegacyAutostart(found), /Stop the old agentd \(pid 4242\)/);
  assert.deepEqual(win.state().stopped, [], "nothing was killed");
  assert.equal(W.decodeXml(win.task("NexusAgentd")), LEGACY_XML, "and the task is back as it was");
});

test("interop_fake_rejects_linux_paths_for_windows_executables", (t) => {
  const win = fakeWindows(t);
  const linux = win.toLinux(`${LOCAL}\\task.xml`);
  fs.mkdirSync(path.dirname(linux), { recursive: true });
  fs.writeFileSync(linux, W.utf16("<Task/>"));
  const refused = spawnSync(path.join(win.system32, "schtasks.exe"), ["/Create", "/TN", "\\RokidCoder\\agentd", "/XML", linux, "/F"], { encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /cannot find the path/);
  const accepted = spawnSync(path.join(win.system32, "schtasks.exe"), ["/Create", "/TN", "\\RokidCoder\\agentd", "/XML", win.toWin(linux), "/F"], { encoding: "utf8" });
  assert.equal(accepted.status, 0, accepted.stderr);
});

/** rokid-setup itself, as user-setup.ps1 runs it: the real wsl platform over the fake Windows. */
async function wslWorld(t) {
  const win = fakeWindows(t);
  const world = makeWorld(t);
  const nexusDir = path.join(world.home, ".nexus-agentd");
  saveConfig({ ...ensureConfig(nexusDir), httpPort: await freePort(), wsPort: await freePort(), rokidCoder: { stateDir: path.join(world.home, ".rokid-coder") } }, nexusDir);
  const env = { ...world.env, PATH: `${win.binDir}:/usr/bin:/bin`, ROKID_SETUP_WSL_SYSTEM32: win.system32, ROKID_SETUP_PROC_ROOT: win.procRoot, ROKID_SETUP_TIMEOUT_MS: "8000", ROKID_SETUP_STOP_TIMEOUT_MS: "3000" };
  delete env.ROKID_SETUP_PLATFORM;
  const answers = world.answers({ pairing: "skip", cli: { claude: "skip", codex: "skip" } });
  const install = (bundleDir, staged, extraEnv = {}) => {
    const result = spawnSync(NODE, [SETUP_MAIN, "install", "--platform", "wsl", "--bundle", bundleDir, "--binding", staged.binding, "--task-xml", staged.taskXml, "--answers", answers], {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      timeout: 90_000,
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  };
  const health = async () => {
    const { httpPort } = JSON.parse(fs.readFileSync(path.join(nexusDir, "config.json"), "utf8"));
    const response = await fetch(`http://127.0.0.1:${httpPort}/health`).catch(() => undefined);
    return response ? response.json() : undefined;
  };
  return { win, world, install, health };
}

test("wsl_failed_upgrade_restarts_previous_bundle_from_its_own_task_and_binding", async (t) => {
  const { win, world, install, health } = await wslWorld(t);
  const b1 = wslBundle(world.home, "1.0.0-wsl.1");
  const g1 = stage(win, { gen: "1.0.0-wsl.1-20261115100000", home: world.home, bundleDir: b1 });
  const first = install(b1, g1);
  assert.equal(first.status, 0, first.output);
  assert.equal((await health()).agentdVersion, "1.0.0-wsl.1");
  assert.deepEqual(world.manifest().binding, g1.record, "the binding is copied into install.json");
  const before = g1.files();

  const b2 = wslBundle(world.home, "1.0.0-wsl.2");
  const g2 = stage(win, { gen: "1.0.0-wsl.2-20261116100000", home: world.home, bundleDir: b2 });
  win.clearCalls();
  const failed = install(b2, g2, { ROKID_SETUP_FAIL_AT: "9" });
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /injected failure at step 9/);
  assert.match(failed.output, /Rolled back to 1\.0\.0-wsl\.1\n/);

  const previous = fs.readFileSync(win.toLinux(`${LOCAL}\\RokidCoder\\journal\\task-previous.xml`));
  assert.deepEqual(win.task(TASK), previous, "the re-created task is the exported one");
  assert.deepEqual(previous, fs.readFileSync(win.toLinux(g1.taskXml)), "which is the first generation's own definition");
  assert.ok(W.decodeXml(previous).includes(xmlEscape(g1.binding)) && W.decodeXml(previous).includes(xmlEscape(g1.launcher)), "naming its own launcher and binding");
  assert.deepEqual(g1.files(), before, "the first generation's binding, launcher and task are byte-identical");
  const up = await health();
  assert.equal(up.agentdVersion, "1.0.0-wsl.1", "the previous build is running again");
  assert.ok(up.execPath.startsWith(`${b1}/`));
  assert.equal(world.manifest().binding.bindingPath.win, g1.binding);

  // Every definition went to schtasks as a Windows path, at install, upgrade and recovery.
  const creates = win.calls().filter((call) => call[0] === "schtasks.exe" && call[1] === "/Create");
  assert.equal(creates.length, 2);
  for (const call of creates) assert.match(call[5], /^[A-Z]:\\/);
});

test("wsl_advertise_changes_inside_the_transaction_and_rollback_restores_its_bytes", async (t) => {
  const { win, world, install } = await wslWorld(t);
  const file = path.join(world.home, ".rokid-coder", "advertise.json");
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null);
  const b1 = wslBundle(world.home, "1.0.0-wsl.1");

  // A NAT binding without hosts is refused before anything is stopped or journaled.
  const hostless = install(b1, stage(win, { gen: "1.0.0-wsl.1-20261114100000", home: world.home, bundleDir: b1, mode: "nat", hosts: [] }));
  assert.equal(hostless.status, 1, hostless.output);
  assert.match(hostless.output, /advertiseHosts/);
  assert.equal(world.journal(), undefined, "nothing was journaled");

  // A fresh NAT install that fails: the record it wrote goes, as it was absent before.
  const fresh = install(b1, stage(win, { gen: "1.0.0-wsl.1-20261114110000", home: world.home, bundleDir: b1, mode: "nat" }), { ROKID_SETUP_FAIL_AT: "9" });
  assert.equal(fresh.status, 1, fresh.output);
  assert.equal(world.journal().steps[5].advertise.previous, null, "the journal recorded that there was none");
  assert.equal(bytes(), null, "no advertise.json is left behind");

  const g1 = stage(win, { gen: "1.0.0-wsl.1-20261115100000", home: world.home, bundleDir: b1 });
  const first = install(b1, g1);
  assert.equal(first.status, 0, first.output);
  assert.equal(bytes(), null, "mirrored mode advertises nothing");
  // An endpoint written since (start-agentd.ps1 at a logon), in bytes setup itself never produces.
  fs.writeFileSync(file, '{"mode":"nat","hosts":["10.0.0.7"],"port":8794,"updatedAt":"2026-11-15T08:00:00.000Z"}', { mode: 0o600 });
  const before = bytes();

  // A mirrored -> NAT Repair that fails after the new agentd started.
  const hosts = ["192.168.1.40", "100.101.102.103"];
  const failed = install(b1, stage(win, { gen: "1.0.0-wsl.1-20261116100000", home: world.home, bundleDir: b1, mode: "nat", hosts }), { ROKID_SETUP_FAIL_AT: "9" });
  assert.equal(failed.status, 1, failed.output);
  assert.match(failed.output, /Rolled back to 1\.0\.0-wsl\.1\n/);
  assert.equal(bytes(), before, "the previous endpoint is back, byte for byte");
  const journal = world.journal();
  assert.equal(journal.steps[5].advertise.previous, before, "the journal held the exact previous bytes");
  assert.ok(journal.steps[4], "and the change came after the snapshot");

  // The same Repair, committed: the binding's endpoint, written after the snapshot took the old one.
  const repaired = install(b1, stage(win, { gen: "1.0.0-wsl.1-20261116110000", home: world.home, bundleDir: b1, mode: "nat", hosts }));
  assert.equal(repaired.status, 0, repaired.output);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual([record.mode, record.hosts, record.port], ["nat", hosts, 8794]);
  const snapshot = world.manifest().previous.snapshot;
  assert.equal(fs.readFileSync(path.join(snapshot, "files", "state", "advertise.json")).toString("base64"), before, "the snapshot keeps the endpoint from before the change");
});
