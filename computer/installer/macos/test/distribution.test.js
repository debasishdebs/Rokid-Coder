// Distribution.xml's installation-check and volume-check, as build-pkg.sh
// renders them, evaluated in node with a stubbed Installer `system` and `my`.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const { MACOS } = require("./helpers");

function render({ arch = "arm64", version = "1.0.0", minOs } = {}) {
  const args = [path.join(MACOS, "build-pkg.sh"), "--render-distribution", "--arch", arch, "--version", version, ...(minOs ? ["--min-os", minOs] : [])];
  const result = spawnSync("/bin/sh", args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

/** Runs the rendered checks against a Mac described by `mac`; returns {ok, result} for each check. */
function evaluate(xml, { os = "15.1", arm64 = true, installed, availableKilobytes = 10_000_000 } = {}) {
  const script = /<script><!\[CDATA\[([\s\S]*?)\]\]><\/script>/.exec(xml)[1];
  const my = { result: {}, target: { availableKilobytes } };
  const system = {
    version: { ProductVersion: os },
    sysctl: (name) => (name === "hw.optional.arm64" ? (arm64 ? 1 : undefined) : undefined),
    files: {
      plistAtPath: (file) => (file === "/Library/Application Support/RokidCoder/installed-version" && installed ? { version: installed } : null),
    },
    log: () => {},
  };
  const context = vm.createContext({ system, my });
  vm.runInContext(script, context);
  const installation = /<installation-check script="([^"]+)"/.exec(xml)[1];
  const volume = /<volume-check script="([^"]+)"/.exec(xml)[1];
  const check = (call) => {
    my.result = {};
    const ok = vm.runInContext(call, context);
    return { ok, result: { ...my.result } };
  };
  return { installation: check(installation), volume: check(volume) };
}

test("distribution_declares_the_only_hard_prerequisites", () => {
  const xml = render();
  assert.match(xml, /<allowed-os-versions>\s*<os-version min="13.0"\s*\/>\s*<\/allowed-os-versions>/);
  assert.match(xml, /<domains enable_localSystem="true" enable_currentUserHome="false" enable_anywhere="false"\s*\/>/);
  assert.match(xml, /<pkg-ref id="io.github.debasishdebs.rokidcoder.computer" version="1.0.0"/);
  assert.doesNotMatch(xml, /ROKID_(VERSION|ARCH|MIN_OS)/, "every placeholder is filled");
});

test("installation_check_blocks_old_macos_with_fix", () => {
  const xml = render();
  const old = evaluate(xml, { os: "12.7.6" }).installation;
  assert.equal(old.ok, false);
  assert.equal(old.result.type, "Fatal");
  assert.equal(old.result.message, "Rokid Coder needs macOS 13 or later — update in System Settings > General > Software Update");
  for (const os of ["13.0", "13.6.1", "14.7", "15.1", "26.0"]) {
    assert.equal(evaluate(xml, { os }).installation.ok, true, os);
  }
  const gate = evaluate(render({ minOs: "99.0" }), { os: "15.1" }).installation;
  assert.equal(gate.ok, false);
  assert.match(gate.result.message, /^Rokid Coder needs macOS 99 or later/);
});

test("installation_check_blocks_wrong_arch", () => {
  const intel = evaluate(render({ arch: "x64" }), { arm64: true }).installation;
  assert.equal(intel.ok, false);
  assert.equal(intel.result.message, "This is the Intel package — download the Apple silicon one");
  assert.equal(evaluate(render({ arch: "x64" }), { arm64: false }).installation.ok, true);
  const silicon = evaluate(render({ arch: "arm64" }), { arm64: false }).installation;
  assert.equal(silicon.ok, false);
  assert.equal(silicon.result.message, "This is the Apple silicon package — download the Intel one");
  assert.equal(evaluate(render({ arch: "arm64" }), { arm64: true }).installation.ok, true);
});

test("installation_check_blocks_downgrade", () => {
  const cases = [
    ["1.0.1", "1.0.0", false],
    ["1.1.0", "1.0.9", false],
    ["1.0.0", "1.0.0-test.2", false],
    ["1.0.0-test.2", "1.0.0-test.1", false],
    ["1.0.0-test.10", "1.0.0-test.9", false],
    ["1.0.0", "1.0.0", true],
    ["1.0.0-test.1", "1.0.0-test.2", true],
    ["1.0.0-test.2", "1.0.0", true],
    ["0.9.9", "1.0.0", true],
    [undefined, "1.0.0", true],
  ];
  for (const [installed, version, ok] of cases) {
    const check = evaluate(render({ version }), { installed }).installation;
    assert.equal(check.ok, ok, `${installed} installed, package ${version}`);
    if (!ok) assert.match(check.result.message, /^A newer Rokid Coder is installed/);
  }
});

test("volume_check_needs_300_mb", () => {
  const xml = render();
  assert.equal(evaluate(xml, { availableKilobytes: 300 * 1024 }).volume.ok, true);
  const full = evaluate(xml, { availableKilobytes: 300 * 1024 - 1 }).volume;
  assert.equal(full.ok, false);
  assert.match(full.result.message, /300 MB/);
});
