// uninstall.ps1's first step (6b): which distro holds the committed install, from
// its install.json read through the fake wsl.exe. No PowerShell here: the module's
// own calls are read from its source and applied the way Read-InstallManifest applies
// them. The Pester suite (Uninstall.Tests.ps1) runs the same cases through the module.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WINDOWS = path.join(__dirname, "..");
const MODULE = fs.readFileSync(path.join(WINDOWS, "lib", "RokidCoder.psm1"), "utf8");
const UNINSTALL = fs.readFileSync(path.join(WINDOWS, "uninstall.ps1"), "utf8");
const FAKE_WSL = path.join(__dirname, "fake-interop", "wsl.js");

function functionBody(name) {
  const start = MODULE.indexOf(`function ${name} {`);
  assert.ok(start >= 0, `RokidCoder.psm1 defines ${name}`);
  const next = MODULE.indexOf("\nfunction ", start + 1);
  return MODULE.slice(start, next < 0 ? undefined : next);
}

const BINDING = { distroName: "Ubuntu", linuxUser: "zoe", linuxHome: "/home/zoe smith" };
const STATE = `${BINDING.linuxHome}/.rokid-coder`;
const FILE = `${STATE}/install.json`;
const COMMITTED = JSON.stringify({ schema: 1, binding: { bindingPath: { win: "C:\\x\\binding-1.json" } } });

function fakeWindows(t, distros) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-uninstall-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "distros.json"), JSON.stringify(distros));
  return (args) => {
    const run = spawnSync(process.execPath, [FAKE_WSL, "-d", BINDING.distroName, "-u", BINDING.linuxUser, "--exec", ...args], { env: { ...process.env, FAKE_WINDOWS_ROOT: root }, encoding: "utf8" });
    return { exitCode: run.status, output: run.stdout.split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line !== "") };
  };
}

/** Read-InstallManifest's decision, step for step: null only for an unregistered distro or a file that is not there. */
function readInstallManifest(wsl, registered) {
  if (!registered) return null;
  const probe = wsl(["/usr/bin/test", "-e", FILE]);
  if (probe.exitCode === 1 && wsl(["/usr/bin/true"]).exitCode === 0) {
    // test -e also gives 1 behind an unsearchable directory: "not there" needs a searchable path.
    const homeOk = wsl(["/usr/bin/test", "-x", BINDING.linuxHome]).exitCode === 0;
    const dirAbsent = wsl(["/usr/bin/test", "-e", STATE]).exitCode === 1;
    const dirOk = dirAbsent || wsl(["/usr/bin/test", "-x", STATE]).exitCode === 0;
    if (homeOk && dirOk) return null;
    throw new Error("could not be read: a directory on the way to it cannot be searched");
  }
  if (probe.exitCode !== 0) throw new Error(`could not be read (wsl.exe exited ${probe.exitCode})`);
  const cat = wsl(["/usr/bin/cat", FILE]);
  if (cat.exitCode !== 0) throw new Error(`could not be read (wsl.exe exited ${cat.exitCode})`);
  try {
    return JSON.parse(cat.output.join("\n"));
  } catch (error) {
    throw new Error(`is not valid JSON: ${error.message}`);
  }
}

test("unreadable_or_corrupt_manifest_is_an_error_not_an_absent_install", (t) => {
  const body = functionBody("Read-InstallManifest");
  // The module makes exactly these calls, in this order, and only these are null.
  assert.match(body, /Get-LxssDistros\) \| Where-Object \{ \$_\.Name -eq \$Binding\.distroName \}\)\) \{ return \$null \}/, "an unregistered distro holds no install");
  const calls = [...body.matchAll(/& \$exec '([^']+)' @\(([^)]*)\)/g)].map((m) => [m[1], ...[...m[2].matchAll(/'([^']*)'|(\$file)/g)].map((a) => a[1] ?? "$file")]);
  assert.deepEqual(calls, [["/usr/bin/test", "-e", "$file"], ["/usr/bin/true"], ["/usr/bin/test", "-x"], ["/usr/bin/test", "-e"], ["/usr/bin/test", "-x"], ["/usr/bin/cat", "$file"]]);
  assert.match(body, /'\/usr\/bin\/test' @\('-x', \$Binding\.linuxHome\)/, "the home must be searchable");
  assert.match(body, /'\/usr\/bin\/test' @\('-e', \$stateDir\)/);
  assert.match(body, /'\/usr\/bin\/test' @\('-x', \$stateDir\)/);
  assert.match(body, /\$file = "\$\(\$Binding\.linuxHome\)\/\.rokid-coder\/install\.json"/);
  assert.doesNotMatch(body, /catch \{ \$null \}/, "a manifest that does not parse is never taken for no manifest");
  assert.equal((body.match(/return \$null/g) ?? []).length, 2, "null only for the unregistered distro and the absent file");
  assert.doesNotMatch(functionBody("Resolve-CommittedBinding"), /catch/, "Resolve-CommittedBinding lets it through");

  const answers = {
    absent: { [`/usr/bin/test -e ${FILE}`]: { code: 1 }, [`/usr/bin/cat ${FILE}`]: { stdout: "", code: 1 }, "/usr/bin/true": { code: 0 }, [`/usr/bin/test -x ${BINDING.linuxHome}`]: { code: 0 }, [`/usr/bin/test -e ${STATE}`]: { code: 0 }, [`/usr/bin/test -x ${STATE}`]: { code: 0 } },
    neverInstalled: { [`/usr/bin/test -e ${FILE}`]: { code: 1 }, "/usr/bin/true": { code: 0 }, [`/usr/bin/test -x ${BINDING.linuxHome}`]: { code: 0 }, [`/usr/bin/test -e ${STATE}`]: { code: 1 } },
    homeUnsearchable: { [`/usr/bin/test -e ${FILE}`]: { code: 1 }, "/usr/bin/true": { code: 0 }, [`/usr/bin/test -x ${BINDING.linuxHome}`]: { code: 1 }, [`/usr/bin/test -e ${STATE}`]: { code: 1 } },
    stateUnsearchable: { [`/usr/bin/test -e ${FILE}`]: { code: 1 }, "/usr/bin/true": { code: 0 }, [`/usr/bin/test -x ${BINDING.linuxHome}`]: { code: 0 }, [`/usr/bin/test -e ${STATE}`]: { code: 0 }, [`/usr/bin/test -x ${STATE}`]: { code: 1 } },
    unreadable: { [`/usr/bin/test -e ${FILE}`]: { code: 0 }, [`/usr/bin/cat ${FILE}`]: { stdout: "", code: 1 }, "/usr/bin/true": { code: 0 } },
    corrupt: { [`/usr/bin/test -e ${FILE}`]: { code: 0 }, [`/usr/bin/cat ${FILE}`]: { stdout: '{"schema":1,"binding":', code: 0 }, "/usr/bin/true": { code: 0 } },
    committed: { [`/usr/bin/test -e ${FILE}`]: { code: 0 }, [`/usr/bin/cat ${FILE}`]: { stdout: `${COMMITTED}\n`, code: 0 }, "/usr/bin/true": { code: 0 } },
  };
  const verdict = (distros, registered = true) => {
    try {
      const manifest = readInstallManifest(fakeWindows(t, distros), registered);
      return manifest ? "committed" : "none";
    } catch (error) {
      return error.message.replace(/:.*$/, "").replace(/ \(.*\)$/, "");
    }
  };
  // cat exits 1 both for a missing and for an unreadable file: its exit code alone cannot tell them apart.
  assert.equal(fakeWindows(t, { Ubuntu: answers.absent })(["/usr/bin/cat", FILE]).exitCode, fakeWindows(t, { Ubuntu: answers.unreadable })(["/usr/bin/cat", FILE]).exitCode);
  assert.equal(verdict({ Ubuntu: answers.committed }), "committed");
  assert.equal(verdict({ Ubuntu: answers.absent }), "none");
  assert.equal(verdict({ Ubuntu: answers.neverInstalled }), "none");
  // An unsearchable directory on the way makes test -e say 1 too: never taken for "no install".
  assert.equal(verdict({ Ubuntu: answers.homeUnsearchable }), "could not be read");
  assert.equal(verdict({ Ubuntu: answers.stateUnsearchable }), "could not be read");
  assert.equal(verdict({ Ubuntu: answers.unreadable }), "could not be read");
  assert.equal(verdict({ Ubuntu: answers.corrupt }), "is not valid JSON");
  // Registered, but wsl.exe cannot start it: every call fails, /usr/bin/true too, so it is no proof of absence.
  assert.equal(verdict({}), "could not be read");
  assert.equal(verdict({}, false), "none");
});

test("uninstall_stops_on_a_manifest_it_cannot_read", () => {
  const step = UNINSTALL.slice(UNINSTALL.indexOf("# 1:"), UNINSTALL.indexOf("# 2"));
  assert.match(step, /try \{ \$committed = Resolve-CommittedBinding -Paths \$paths \}\s*catch \{ Stop-Uninstall /, "an unreadable install.json stops it before anything is removed");
  assert.ok(UNINSTALL.indexOf("Stop-Uninstall") < UNINSTALL.indexOf("# 2"));
});
