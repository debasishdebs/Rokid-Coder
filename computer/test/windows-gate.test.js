// The Windows launcher gate (6b T8, U33): until the recorded gate passes, `rk claude`
// and `rk codex` inside WSL point to plugin mode instead of starting the launcher.
// It applies only after the CLI resolution and install offer [6b-R2].
const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, FAKE_CLAUDE, FAKE_CODEX, rkEnv, inPty, killLive, readJson } = require("./helpers/rk.js");
const { WINDOWS_LAUNCHER_VERIFIED, windowsGateHint } = require("../dist/launcher/windows-gate.js");

afterEach(killLive);

const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const CLAUDE_HINT = "Launcher mode isn't verified on Windows yet — use plugin mode: type /rokid:on in Claude";
const CODEX_HINT = "Launcher mode isn't verified on Windows yet — use plugin mode: type rokid:on in Codex";

/** A temp HOME with no CLI, a fake curl whose "installer" drops the fake CLI, and a recording setup entry. */
async function sandbox(dir, tool, { installed = false } = {}) {
  const home = path.join(dir, "home");
  const bin = path.join(home, ".local", "bin");
  const fakebin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(fakebin, { recursive: true });
  const fakeCli = tool === "claude" ? FAKE_CLAUDE : FAKE_CODEX;
  const cli = `#!/bin/sh\nexec '${process.execPath}' '${fakeCli}' "$@"\n`;
  if (installed) fs.writeFileSync(path.join(bin, tool), cli, { mode: 0o755 });
  const installer = `mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/${tool}" <<'CLI'
${cli}CLI
chmod +x "$HOME/.local/bin/${tool}"
`;
  fs.writeFileSync(path.join(dir, "installer.sh"), installer);
  fs.writeFileSync(path.join(fakebin, "curl"), `#!/bin/sh\ncat "${dir}/installer.sh"\n`, { mode: 0o755 });
  const setup = path.join(dir, "fake-setup.js");
  fs.writeFileSync(setup, `require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "setup-argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
  const { env } = await rkEnv(dir);
  return {
    ...env,
    HOME: home,
    PATH: `${fakebin}:/usr/bin:/bin`,
    ROKID_RK_CLAUDE_BIN: tool,
    ROKID_RK_CODEX_BIN: "codex",
    ROKID_RK_KNOWN_BIN_DIRS: bin,
    ROKID_RK_SETUP_ENTRY: setup,
    FAKE_ARGV_FILE: path.join(dir, "cli-argv.json"),
  };
}

test("windows_gate_constant_is_unverified_until_the_gate_passes", () => {
  assert.equal(WINDOWS_LAUNCHER_VERIFIED, false);
  assert.equal(windowsGateHint("claude", {}, true), CLAUDE_HINT);
  assert.equal(windowsGateHint("codex", {}, true), CODEX_HINT);
  assert.equal(windowsGateHint("claude", { ROKID_RK_WINDOWS_VERIFIED: "1" }, true), undefined, "the gate session's override");
  assert.equal(windowsGateHint("claude", {}, false), undefined, "only inside WSL");
});

test("windows_gate_runs_after_cli_install_offer", async () => {
  for (const tool of ["claude", "codex"]) {
    await withTempDir(async (dir) => {
      const env = { ...(await sandbox(dir, tool)), WSL_DISTRO_NAME: "Ubuntu" };
      const run = inPty(process.execPath, [RK, tool], env);
      await run.until("[y/N]");
      run.write("y\r");
      assert.deepEqual(await run.exited, { code: 0, signal: null });
      const out = plain(run.out);
      assert.ok(out.includes(tool === "claude" ? CLAUDE_HINT : CODEX_HINT), out);
      assert.ok(out.indexOf("[y/N]") < out.indexOf("Launcher mode"), "the offer comes first");
      assert.deepEqual(readJson(path.join(dir, "setup-argv.json")), ["cli-installed", "--tool", tool, "--json"], "and the plugin is provisioned before the hint");
      assert.equal(fs.existsSync(path.join(dir, "cli-argv.json")), false, `the ${tool} launcher never started`);
    });
  }
});

test("rk_on_windows_without_verified_flag_prints_plugin_mode_hint", async () => {
  for (const tool of ["claude", "codex"]) {
    await withTempDir(async (dir) => {
      const env = { ...(await sandbox(dir, tool, { installed: true })), WSL_DISTRO_NAME: "Ubuntu" };
      const run = inPty(process.execPath, [RK, tool], env);
      assert.deepEqual(await run.exited, { code: 0, signal: null });
      const out = plain(run.out);
      assert.ok(out.includes(tool === "claude" ? CLAUDE_HINT : CODEX_HINT), out);
      assert.equal(out.includes("Rokid-Coder"), false, "no banner: nothing of the launcher ran");
      assert.equal(fs.existsSync(path.join(dir, "cli-argv.json")), false);
    });
  }
});

test("rk_on_macos_unaffected_by_windows_gate", async () => {
  await withTempDir(async (dir) => {
    const env = await sandbox(dir, "codex", { installed: true });
    delete env.WSL_DISTRO_NAME;
    const run = inPty(process.execPath, [RK, "codex"], env);
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    const out = plain(run.out);
    assert.ok(out.includes("fake-codex ready"), out);
    assert.equal(out.includes("Launcher mode isn't verified"), false);
  });
});
