// The preflight's distro_glibc item (6b T8) against the raw `getconf GNU_LIBC_VERSION`
// output the supported distros print ("glibc 2.35", two components), through the fake
// wsl.exe. No PowerShell here: the module's own pattern and argv are read from its
// source and applied the way Get-DistroFacts and Invoke-Preflight apply them. The
// Pester suite runs the same cases through the module itself on Windows.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WINDOWS = path.join(__dirname, "..");
const MODULE = fs.readFileSync(path.join(WINDOWS, "lib", "RokidCoder.psm1"), "utf8");
const REQUIREMENTS = JSON.parse(fs.readFileSync(path.join(WINDOWS, "wsl-requirements.json"), "utf8"));
const RECORDED = JSON.parse(fs.readFileSync(path.join(__dirname, "fake-interop", "recorded", "getconf-gnu-libc-version.json"), "utf8"));
const FAKE_WSL = path.join(__dirname, "fake-interop", "wsl.js");

/** The body of one module function, for the assertions on what it calls. */
function functionBody(name) {
  const start = MODULE.indexOf(`function ${name} {`);
  assert.ok(start >= 0, `RokidCoder.psm1 defines ${name}`);
  const next = MODULE.indexOf("\nfunction ", start + 1);
  return MODULE.slice(start, next < 0 ? undefined : next);
}

/** ConvertTo-GlibcVersion: `$script:GlibcPattern`, matched as PowerShell's -match does (case-insensitive), patch 0 when absent. */
function convertToGlibcVersion(text) {
  const declared = /^\$script:GlibcPattern = '([^']+)'$/m.exec(MODULE);
  assert.ok(declared, "RokidCoder.psm1 declares $script:GlibcPattern");
  const match = new RegExp(declared[1], "i").exec(String(text ?? ""));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

function fakeWindows(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-glibc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const distros = {};
  for (const [name, stdout] of Object.entries(RECORDED)) {
    if (name !== "_") distros[name] = { "/usr/bin/getconf GNU_LIBC_VERSION": { stdout, code: 0 } };
  }
  fs.writeFileSync(path.join(root, "distros.json"), JSON.stringify(distros));
  return {
    wsl: (args) => {
      const run = spawnSync(process.execPath, [FAKE_WSL, ...args], { env: { ...process.env, FAKE_WINDOWS_ROOT: root }, encoding: "utf8" });
      // Invoke-Native: stdout as lines, the exit code beside it.
      return { exitCode: run.status, output: run.stdout.split(/\r?\n/).filter((line, i, all) => i < all.length - 1 || line !== "") };
    },
  };
}

test("distro_glibc_accepts_two_component_getconf_output", (t) => {
  const win = fakeWindows(t);
  const facts = functionBody("Get-DistroFacts");
  const call = /Invoke-WslExec -Distro \$Distro -Path '([^']+)' -Arguments @\('GNU_LIBC_VERSION'\)/.exec(facts);
  assert.ok(call, "Get-DistroFacts runs getconf GNU_LIBC_VERSION through --exec");
  assert.match(facts, /Glibc\s+=.*ConvertTo-GlibcVersion/, "and parses it as a glibc version, not a WSL one");
  assert.match(functionBody("Invoke-Preflight"), /ConvertTo-GlibcVersion \$Requirements\.glibcMin/, "the floor is parsed the same way");

  const floor = convertToGlibcVersion(REQUIREMENTS.glibcMin);
  assert.deepEqual(floor, [2, 35, 0], "the requirement itself is a two-component version");
  const verdicts = {};
  for (const distro of Object.keys(RECORDED).filter((name) => name !== "_")) {
    const run = win.wsl(["-d", distro, "--exec", call[1], "GNU_LIBC_VERSION"]);
    assert.equal(run.exitCode, 0, distro);
    assert.match(run.output[0], /^glibc \d+\.\d+$/, "the raw output really has two components");
    const glibc = convertToGlibcVersion(run.output[0]);
    assert.ok(glibc, `${distro}: '${run.output[0]}' parses`);
    verdicts[distro] = atLeast(glibc, floor);
  }
  assert.deepEqual(verdicts, { "Ubuntu-20.04": false, "Ubuntu-22.04": true, "Ubuntu-24.04": true, "Debian-12": true });
  // Three components still parse, and nothing else does.
  assert.deepEqual(convertToGlibcVersion("glibc 2.35.1"), [2, 35, 1]);
  for (const junk of ["", "glibc", "musl libc 1.2.4", "WSL version: 2.3.26.0"]) assert.equal(convertToGlibcVersion(junk), undefined, junk);
});

test("fake_wsl_takes_only_exec_with_an_absolute_path", (t) => {
  const win = fakeWindows(t);
  assert.equal(win.wsl(["-d", "Ubuntu-22.04", "--", "getconf", "GNU_LIBC_VERSION"]).exitCode, 2);
  assert.equal(win.wsl(["-d", "Ubuntu-22.04", "--exec", "getconf", "GNU_LIBC_VERSION"]).exitCode, 2);
  assert.notEqual(win.wsl(["-d", "NoSuchDistro", "--exec", "/usr/bin/getconf", "GNU_LIBC_VERSION"]).exitCode, 0);
  assert.equal(win.wsl(["-d", "Ubuntu-24.04", "-u", "zoe", "--exec", "/usr/bin/getconf", "GNU_LIBC_VERSION"]).output[0], "glibc 2.39");
});
