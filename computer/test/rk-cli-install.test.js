// rk claude / rk codex with no CLI installed (6b T9, 6b-R2). The vendor installer is the
// real command from the table, run against a fake `curl` that emits a fake installer
// script: nothing touches the network, a real CLI, or the user's home.
const test = require("node:test");
const { afterEach } = test;
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const { RK, FAKE_CLAUDE, FAKE_CODEX, until, rkEnv, inPty, killLive, readJson } = require("./helpers/rk.js");

afterEach(killLive);

const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/**
 * A sandbox: a temp HOME, a PATH of [fake curl dir]:/usr/bin:/bin (no claude, codex, npm or brew),
 * known install dirs confined to HOME/.local/bin, and a fake setup entry recording its argv.
 */
async function sandbox(dir, tool, { unpaired = false, curlFails = false } = {}) {
  const home = path.join(dir, "home");
  const bin = path.join(home, ".local", "bin");
  const fakebin = path.join(dir, "fakebin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(fakebin, { recursive: true });
  const fakeCli = tool === "claude" ? FAKE_CLAUDE : FAKE_CODEX;
  // What the fake curl prints is the "vendor installer": it drops a fake CLI into ~/.local/bin.
  const installer = `mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\\nexec "%s" "%s" "$@"\\n' '${process.execPath}' '${fakeCli}' > "$HOME/.local/bin/${tool}"
chmod +x "$HOME/.local/bin/${tool}"
`;
  fs.writeFileSync(path.join(dir, "installer.sh"), installer);
  const curl = `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/curl-argv.txt"
${curlFails ? "exit 22" : `cat "${dir}/installer.sh"`}
`;
  fs.writeFileSync(path.join(fakebin, "curl"), curl, { mode: 0o755 });
  const setup = path.join(dir, "fake-setup.js");
  fs.writeFileSync(setup, `require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "setup-argv.json"))}, JSON.stringify(process.argv.slice(2)));\n`);
  const { env } = await rkEnv(dir, {}, { unpaired });
  return {
    home,
    env: {
      ...env,
      HOME: home,
      PATH: `${fakebin}:/usr/bin:/bin`,
      ROKID_RK_CLAUDE_BIN: "claude",
      ROKID_RK_CODEX_BIN: "codex",
      ROKID_RK_KNOWN_BIN_DIRS: bin,
      ROKID_RK_SETUP_ENTRY: setup,
      FAKE_ARGV_FILE: path.join(dir, "cli-argv.json"),
    },
  };
}

test("rk_claude_continues_after_install_with_resolved_path", async () => {
  await withTempDir(async (dir) => {
    const { env, home } = await sandbox(dir, "claude");
    const run = inPty(process.execPath, [RK, "claude", "--flag", "x y"], env);
    await run.until("[y/N]");
    assert.ok(plain(run.out).includes("curl -fsSL https://claude.ai/install.sh | bash"));
    run.write("y\r");
    await run.until("fake-claude ready", 15000);
    assert.deepEqual(readJson(path.join(dir, "cli-argv.json")), ["--flag", "x y"], "the installed CLI got the args");
    assert.ok(fs.existsSync(path.join(home, ".local", "bin", "claude")));
    assert.equal(fs.readFileSync(path.join(dir, "curl-argv.txt"), "utf8").trim(), "-fsSL https://claude.ai/install.sh");
    // The setup contract, exact argv.
    assert.deepEqual(readJson(path.join(dir, "setup-argv.json")), ["cli-installed", "--tool", "claude", "--json"]);
    run.write("/exit 0\r");
    assert.deepEqual(await run.exited, { code: 0, signal: null });
  });
});

test("rk_codex_without_codex_declined_exits_127_and_runs_nothing", async () => {
  await withTempDir(async (dir) => {
    const { env } = await sandbox(dir, "codex");
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("[y/N]");
    run.write("\r");
    const { code } = await run.exited;
    assert.equal(code, 127);
    const out = plain(run.out);
    assert.ok(out.includes("could not start codex"), out);
    assert.equal(fs.existsSync(path.join(dir, "curl-argv.txt")), false, "nothing was fetched");
    assert.equal(fs.existsSync(path.join(dir, "setup-argv.json")), false);
  });
});

test("rk_codex_continues_after_install", async () => {
  await withTempDir(async (dir) => {
    const { env } = await sandbox(dir, "codex");
    const run = inPty(process.execPath, [RK, "codex"], env);
    await run.until("[y/N]");
    run.write("y\r");
    assert.deepEqual(await run.exited, { code: 0, signal: null });
    assert.ok(plain(run.out).includes("fake-codex ready"), run.out);
    assert.deepEqual(readJson(path.join(dir, "setup-argv.json")), ["cli-installed", "--tool", "codex", "--json"]);
  });
});

test("resolution_runs_before_banner_pairing_and_raw_mode", async () => {
  for (const tool of ["claude", "codex"]) {
    await withTempDir(async (dir) => {
      // Unpaired, so a banner or the pairing question would show if they came first.
      const { env } = await sandbox(dir, tool, { unpaired: true });
      const run = inPty(process.execPath, [RK, tool], env);
      await run.until("[y/N]");
      // Cooked terminal: the kernel echoes the key and holds it until Enter.
      run.write("n");
      await until(() => plain(run.out).endsWith("[y/N] n"), 3000, "the echo of a cooked terminal");
      assert.equal(run.exit, undefined, "line-buffered: not delivered before Enter");
      run.write("\r");
      assert.equal((await run.exited).code, 127);
      const out = plain(run.out);
      assert.equal(out.includes("Rokid-Coder"), false, `no banner: ${out}`);
      assert.equal(out.includes("Pair now?"), false, `no pairing question: ${out}`);
      assert.equal(out.includes("rokid:on"), false, `no codex hint: ${out}`);
    });
  }
});

test("rk_install_failure_exits_127_with_manual_command", async () => {
  await withTempDir(async (dir) => {
    // curl fails, bash gets nothing and exits 0: the missing CLI is what tells.
    const { env } = await sandbox(dir, "claude", { curlFails: true });
    const run = inPty(process.execPath, [RK, "claude"], env);
    await run.until("[y/N]");
    run.write("y\r");
    assert.equal((await run.exited).code, 127);
    const out = plain(run.out);
    assert.ok(out.includes("run it yourself: curl -fsSL https://claude.ai/install.sh | bash"), out);
    assert.equal(fs.existsSync(path.join(dir, "setup-argv.json")), false);
  });
});

test("rk_with_an_explicit_missing_bin_does_not_offer_an_install", async () => {
  await withTempDir(async (dir) => {
    const { env } = await sandbox(dir, "claude");
    const run = inPty(process.execPath, [RK, "claude"], { ...env, ROKID_RK_CLAUDE_BIN: path.join(dir, "no-such-claude") });
    assert.equal((await run.exited).code, 127);
    assert.equal(plain(run.out).includes("[y/N]"), false);
  });
});
