// Offering to install a missing Claude Code or Codex (6b T9). Everything here is a fake:
// no real installer, claude or codex runs, and nothing reads the user's home.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { withTempDir } = require("./helpers/daemon.js");
const {
  INSTALL_TABLE,
  offerCliInstall,
  realCliInstallIo,
  resolveCli,
  knownBinDirs,
} = require("../dist/launcher/cli-install.js");

const CLAUDE_CMD = "curl -fsSL https://claude.ai/install.sh | bash";
const CODEX_NPM = "npm install -g @openai/codex";

/** An io with every effect recorded. `have` is the set of commands "on PATH". */
function fakeIo({ interactive = true, answers = [], have = ["curl", "bash", "sh", "npm", "brew"], runExit = 0, resolved, setupExit = 0, setupThrows = false } = {}) {
  const queue = [...answers];
  const io = {
    interactive,
    platform: "darwin",
    out: "",
    runs: [],
    setups: [],
    reads: 0,
    write: (text) => {
      io.out += text;
    },
    readLine: async () => {
      io.reads += 1;
      return queue.shift();
    },
    hasCommand: (name) => have.includes(name),
    run: async (command) => {
      io.runs.push(command);
      return runExit;
    },
    resolve: () => resolved,
    runSetup: async (args) => {
      io.setups.push(args);
      if (setupThrows) throw new Error("boom");
      return setupExit;
    },
  };
  return io;
}

test("install_table_rows_are_pinned_to_docs", () => {
  assert.ok(INSTALL_TABLE.length >= 3);
  for (const row of INSTALL_TABLE) {
    assert.match(row.docsUrl, /^https:\/\//, row.command);
    assert.match(row.verified, /^\d{4}-\d{2}-\d{2}$/, row.command);
    assert.ok(Array.isArray(row.requires) && row.requires.length > 0, row.command);
    assert.ok(["claude", "codex"].includes(row.tool));
    assert.ok(["darwin", "linux"].includes(row.platform));
  }
  assert.ok(INSTALL_TABLE.some((r) => r.tool === "claude" && r.command === CLAUDE_CMD));
  assert.ok(INSTALL_TABLE.some((r) => r.tool === "codex" && r.command === CODEX_NPM));
});

test("neither_cli_install_offers_official_installer_and_never_runs_unconfirmed", async () => {
  for (const answer of ["n", "N", "", "no", "yes please", undefined]) {
    const io = fakeIo({ answers: [answer] });
    assert.equal(await offerCliInstall("claude", io), "skipped", JSON.stringify(answer));
    assert.deepEqual(io.runs, [], `nothing runs on ${JSON.stringify(answer)}`);
    assert.ok(io.out.includes(CLAUDE_CMD), "the official command is shown");
    assert.ok(io.out.includes("[y/N]"));
    assert.equal(io.setups.length, 0);
  }
  const yes = fakeIo({ answers: ["y"], resolved: "/home/u/.local/bin/claude" });
  assert.equal(await offerCliInstall("claude", yes), "installed");
  assert.deepEqual(yes.runs, [CLAUDE_CMD]);
  const upper = fakeIo({ answers: ["Y"], resolved: "/x/claude" });
  assert.equal(await offerCliInstall("claude", upper), "installed");
});

test("non_tty_never_prompts_prints_command", async () => {
  for (const tool of ["claude", "codex"]) {
    const io = fakeIo({ interactive: false });
    assert.equal(await offerCliInstall(tool, io), "skipped");
    assert.equal(io.reads, 0, "stdin is never read");
    assert.deepEqual(io.runs, []);
    assert.equal(io.out.includes("[y/N]"), false);
    const row = INSTALL_TABLE.find((r) => r.tool === tool);
    assert.ok(io.out.includes(row.command), io.out);
  }
});

test("install_failure_prints_command_to_run_manually", async () => {
  const io = fakeIo({ answers: ["y"], runExit: 7 });
  assert.equal(await offerCliInstall("claude", io), "failed");
  assert.ok(io.out.includes("exit 7"), io.out);
  assert.ok(io.out.includes(`run it yourself: ${CLAUDE_CMD}`), io.out);
  assert.equal(io.setups.length, 0, "no plugin setup after a failed install");
});

test("install_that_leaves_no_cli_is_failed_and_skips_setup", async () => {
  // `curl ... | bash` exits 0 when curl fails: the proof of an install is the CLI itself.
  const io = fakeIo({ answers: ["y"], runExit: 0, resolved: undefined });
  assert.equal(await offerCliInstall("claude", io), "failed");
  assert.equal(io.setups.length, 0);
  assert.ok(io.out.includes(CLAUDE_CMD));
});

test("codex_without_npm_or_brew_is_manual_with_docs_url", async () => {
  // No curl either: the standalone script is the first choice, so it must be missing too.
  const io = fakeIo({ answers: ["y"], have: [] });
  assert.equal(await offerCliInstall("codex", io), "manual");
  assert.deepEqual(io.runs, []);
  assert.equal(io.reads, 0, "no prompt for something rk cannot run");
  assert.ok(io.out.includes("https://developers.openai.com/codex/cli"), io.out);
  // The same on a non-interactive stdin.
  const piped = fakeIo({ interactive: false, have: [] });
  assert.equal(await offerCliInstall("codex", piped), "manual");
});

test("codex_uses_the_standalone_script_then_npm_then_brew", async () => {
  const script = fakeIo({ answers: ["y"], resolved: "/x/codex" });
  assert.equal(await offerCliInstall("codex", script), "installed");
  assert.deepEqual(script.runs, ["curl -fsSL https://chatgpt.com/codex/install.sh | sh"]);
  const npm = fakeIo({ answers: ["y"], have: ["npm", "brew"], resolved: "/x/codex" });
  assert.equal(await offerCliInstall("codex", npm), "installed");
  assert.deepEqual(npm.runs, [CODEX_NPM]);
  const brew = fakeIo({ answers: ["y"], have: ["brew"], resolved: "/x/codex" });
  assert.equal(await offerCliInstall("codex", brew), "installed");
  assert.deepEqual(brew.runs, ["brew install --cask codex"]);
});

test("claude_without_curl_is_manual_with_docs_url", async () => {
  const io = fakeIo({ have: ["bash"] });
  assert.equal(await offerCliInstall("claude", io), "manual");
  assert.ok(io.out.includes("https://code.claude.com/docs/en/setup"), io.out);
});

test("unsupported_platform_is_manual", async () => {
  const io = fakeIo();
  io.platform = "win32";
  assert.equal(await offerCliInstall("claude", io), "manual");
  assert.ok(io.out.includes("https://code.claude.com/docs/en/setup"));
});

test("never_uses_bundled_node_for_npm", async () => {
  // No row may name rokid-node or this process's node.
  for (const row of INSTALL_TABLE) {
    assert.equal(/rokid-node|execPath/.test(row.command), false, row.command);
    assert.equal(row.command.includes(process.execPath), false, row.command);
  }
  // The real io looks for npm only on the user's PATH, never beside the running node,
  // which is where the bundled runtime lives.
  const nodeDir = path.dirname(process.execPath);
  const io = realCliInstallIo({ env: { PATH: "/nonexistent-rk-dir", HOME: nodeDir }, platform: "darwin" });
  assert.equal(io.hasCommand("npm"), false);
  assert.equal(io.hasCommand("node"), false);
  io.interactive = false;
  io.write = () => {};
  assert.equal(await offerCliInstall("codex", io), "manual");
});

test("installed_cli_triggers_cli_installed_setup_contract", async () => {
  const io = fakeIo({ answers: ["y"], resolved: "/home/u/.local/bin/claude" });
  assert.equal(await offerCliInstall("claude", io), "installed");
  assert.deepEqual(io.setups, [["cli-installed", "--tool", "claude", "--json"]]);
  const codex = fakeIo({ answers: ["y"], resolved: "/x/codex" });
  assert.equal(await offerCliInstall("codex", codex), "installed");
  assert.deepEqual(codex.setups, [["cli-installed", "--tool", "codex", "--json"]]);
});

test("cli_installed_failure_does_not_fail_rk", async () => {
  const bad = fakeIo({ answers: ["y"], resolved: "/x/claude", setupExit: 3 });
  assert.equal(await offerCliInstall("claude", bad), "installed");
  assert.ok(bad.out.includes("Plugin setup failed — run: rokid-setup plugins sync"), bad.out);
  const thrown = fakeIo({ answers: ["y"], resolved: "/x/claude", setupThrows: true });
  assert.equal(await offerCliInstall("claude", thrown), "installed");
  assert.ok(thrown.out.includes("Plugin setup failed"), thrown.out);
});

test("resolver_order_is_path_then_known_install_dirs", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "home");
    const onPath = path.join(dir, "onpath");
    const local = path.join(home, ".local", "bin");
    for (const d of [onPath, local]) fs.mkdirSync(d, { recursive: true });
    const put = (d) => {
      const f = path.join(d, "tool");
      fs.writeFileSync(f, "#!/bin/sh\n", { mode: 0o755 });
      return f;
    };
    const env = { PATH: onPath, ROKID_RK_KNOWN_BIN_DIRS: local };
    assert.equal(resolveCli("tool", env, home), undefined);
    const inLocal = put(local);
    assert.equal(resolveCli("tool", env, home), inLocal, "found in a known dir when off PATH");
    const inPath = put(onPath);
    assert.equal(resolveCli("tool", env, home), inPath, "PATH wins");
    // A path with a slash is taken as it is.
    assert.equal(resolveCli(inLocal, { PATH: "" }, home), inLocal);
    // Defaults, with no override.
    assert.deepEqual(knownBinDirs("/h", {}), ["/h/.local/bin", "/h/.npm-global/bin", "/opt/homebrew/bin", "/usr/local/bin"]);
  });
});
