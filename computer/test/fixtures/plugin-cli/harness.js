// A throwaway machine for rokid-setup's tests: a temp HOME, fake claude/codex
// (fake-plugin-cli.js over a recorded fixture), a test login shell, fixture
// bundles, the 0.8.0 state fixture and the recording fake platform. Nothing
// here can reach the real ~/.claude, ~/.codex, ~/.rokid-coder or
// ~/.nexus-agentd, or a real claude or codex: PATH is /usr/bin:/bin, the
// login shell is ours and the known install dirs are replaced.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COMPUTER = path.resolve(__dirname, "..", "..", "..");
const DIST = path.join(COMPUTER, "dist");
const SETUP_MAIN = path.join(DIST, "setup", "main.js");
const FAKE_CLI = path.join(__dirname, "fake-plugin-cli.js");
const STATE_FIXTURE = path.join(__dirname, "..", "state-0.8.0", "home");
const FIXTURES = {
  claude: path.join(__dirname, "claude-2.1.285"),
  codex: path.join(__dirname, "codex-0.169.0"),
  "codex-noinstall": path.join(__dirname, "codex-0.169.0-noinstall"),
  "codex-withpath": path.join(__dirname, "codex-0.169.0-withpath"),
};
const NODE = fs.realpathSync(process.execPath);
const MUTATING = new Set(["add", "remove", "rm", "install", "i", "update", "uninstall"]);

const LOGIN_SHELL = `#!/bin/sh
# A login shell for tests: runs -c's command with FAKE_LOGIN_PATH, or with
# FAKE_INTERACTIVE_PATH when -i is given too. It prints rc-file noise first.
interactive=
while [ $# -gt 0 ]; do
  case $1 in
    -*c) case $1 in *i*) interactive=1;; esac; shift; break;;
    -*) case $1 in *i*) interactive=1;; esac; shift;;
    *) break;;
  esac
done
if [ -n "$interactive" ] && [ -n "\${FAKE_INTERACTIVE_PATH+x}" ]; then PATH=$FAKE_INTERACTIVE_PATH; else PATH=\${FAKE_LOGIN_PATH:-/usr/bin:/bin}; fi
export PATH
echo "welcome back (rc noise)"
exec /bin/sh -c "$1"
`;

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

const q = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/** A bundle as setup sees one: bundle.json and the plugins/ tree with both marketplaces. */
function writeBundle(dir, version, { pluginVersion = version, forwarder = `// hook-forward ${version}\n` } = {}) {
  writeJson(path.join(dir, "bundle.json"), { version, target: "test", node: process.version.slice(1), nodePtyMode: "napi-prebuild", builtFrom: "fixture" });
  writePluginSources(path.join(dir, "plugins"), { claude: "./claude-code", codex: "./codex" }, pluginVersion, forwarder);
  return fs.realpathSync(dir);
}

function writePluginSources(root, sources, pluginVersion, forwarder) {
  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "rokid-coder",
    owner: { name: "Rokid-Coder" },
    plugins: [{ name: "rokid", source: sources.claude }],
  });
  writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
    name: "rokid-coder",
    plugins: [{ name: "rokid", source: { source: "local", path: sources.codex } }],
  });
  for (const [sub, manifest] of [[sources.claude, ".claude-plugin"], [sources.codex, ".codex-plugin"]]) {
    writeJson(path.join(root, sub, manifest, "plugin.json"), { name: "rokid", version: pluginVersion });
    fs.mkdirSync(path.join(root, sub, "bin"), { recursive: true });
    fs.writeFileSync(path.join(root, sub, "bin", "hook-forward.js"), forwarder);
  }
}

let certCache;
async function agentCertFiles() {
  if (!certCache) {
    const { ensureAgentCert } = require(path.join(DIST, "tls.js"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rokid-setup-cert-"));
    const cert = await ensureAgentCert(dir);
    certCache = {
      key: fs.readFileSync(path.join(dir, "agentd.key")),
      crt: fs.readFileSync(path.join(dir, "agentd.crt")),
      fingerprint: cert.fingerprint256,
    };
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return certCache;
}

/** Every file under `dir` (relative path -> bytes), for byte-identical comparisons. */
function treeBytes(dir, { skip = () => false } = {}) {
  const out = {};
  const visit = (sub) => {
    const abs = path.join(dir, sub);
    if (!fs.existsSync(abs)) return;
    for (const name of fs.readdirSync(abs).sort()) {
      const rel = path.join(sub, name);
      if (skip(rel)) continue;
      const stat = fs.lstatSync(path.join(dir, rel));
      if (stat.isDirectory()) visit(rel);
      else if (stat.isFile()) out[rel] = fs.readFileSync(path.join(dir, rel)).toString("base64");
    }
  };
  visit("");
  return out;
}

function makeWorld(t, { loginPath } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-setup-")));
  const home = path.join(root, "home dir");
  const fake = path.join(root, "fake");
  const tools = path.join(root, "tools");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fake, { recursive: true });
  const shell = writeExecutable(path.join(tools, "login-shell"), LOGIN_SHELL);
  const env = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    SHELL: shell,
    LANG: "C.UTF-8",
    FAKE_LOGIN_PATH: (loginPath ?? ["/usr/bin", "/bin"]).join(":"),
    ROKID_RK_KNOWN_BIN_DIRS: [path.join(home, ".local", "bin"), path.join(home, ".npm-global", "bin")].join(":"),
    ROKID_SETUP_TEST: "1",
    ROKID_SETUP_PLATFORM: "fake",
    ROKID_SETUP_FAKE_DIR: fake,
    ROKID_SETUP_TIMEOUT_MS: "4000",
  };
  const world = {
    root,
    home,
    fake,
    tools,
    env,
    /** A fake CLI at `dir/<tool>`: a sh wrapper, or (npm) a `#!/usr/bin/env node` script. */
    cli(tool, { dir = path.join(home, ".local", "bin"), fixture = tool, npm = false } = {}) {
      const file = path.join(dir, tool);
      if (npm) {
        return writeExecutable(file, `#!/usr/bin/env node\nrequire(${JSON.stringify(FAKE_CLI)}).main([${JSON.stringify(FIXTURES[fixture])}, ...process.argv.slice(2)]);\n`);
      }
      return writeExecutable(file, `#!/bin/sh\nexec ${q(NODE)} ${q(FAKE_CLI)} ${q(FIXTURES[fixture])} "$@"\n`);
    },
    /** Runs a fake CLI as the 0.8.0 user once did, then forgets the calls. */
    runCli(cliPath, args) {
      const result = spawnSync(cliPath, args, { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`${cliPath} ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    },
    cliCalls(tool) {
      const file = path.join(home, ".fake-plugin-cli", tool, "calls.log");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    mutatingCalls(tool) {
      return world.cliCalls(tool).filter((args) => args[0] === "plugin" && (MUTATING.has(args[1]) || (args[1] === "marketplace" && MUTATING.has(args[2]))));
    },
    clearCliCalls(tool) {
      fs.rmSync(path.join(home, ".fake-plugin-cli", tool, "calls.log"), { force: true });
    },
    cliState(tool) {
      const file = path.join(home, ".fake-plugin-cli", tool, "state.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { marketplaces: {}, plugins: {} };
    },
    bundle(version, options) {
      return writeBundle(path.join(root, "bundles", version), version, options);
    },
    scenario(value) {
      writeJson(path.join(fake, "scenario.json"), value);
    },
    calls() {
      const file = path.join(fake, "calls.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    clearCalls() {
      fs.rmSync(path.join(fake, "calls.jsonl"), { force: true });
    },
    fakeState() {
      const file = path.join(fake, "state.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { daemons: [] };
    },
    platform() {
      const { FakePlatform } = require(path.join(DIST, "setup", "platform", "fake.js"));
      return new FakePlatform("darwin", { home, env });
    },
    answers(value) {
      const file = path.join(root, `answers-${Math.random().toString(36).slice(2)}.json`);
      writeJson(file, value);
      return file;
    },
    run(args, { input = "", extraEnv = {} } = {}) {
      const result = spawnSync(NODE, [SETUP_MAIN, ...args], { env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 60_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
    },
    install(bundleDir, answers = {}, options = {}) {
      return world.run(["install", "--platform", "darwin", "--bundle", bundleDir, "--answers", world.answers({ pairing: "skip", ...answers })], options);
    },
    /** The 0.8.0 user's state, with a real agent cert. Returns the secrets a test must never see printed. */
    async seed08() {
      fs.cpSync(STATE_FIXTURE, home, { recursive: true });
      const cert = await agentCertFiles();
      const tls = path.join(home, ".rokid-coder", "tls");
      fs.writeFileSync(path.join(tls, "agentd.key"), cert.key, { mode: 0o600 });
      fs.writeFileSync(path.join(tls, "agentd.crt"), cert.crt, { mode: 0o600 });
      const config = JSON.parse(fs.readFileSync(path.join(home, ".nexus-agentd", "config.json"), "utf8"));
      const pins = JSON.parse(fs.readFileSync(path.join(tls, "phone-pins.json"), "utf8"));
      return {
        token: config.token,
        machineId: config.machineId,
        steer: fs.readFileSync(path.join(tls, "steer.secret"), "utf8").trim(),
        pinFp: pins.phones[0].fp,
        certFp: cert.fingerprint,
      };
    },
    /**
     * 0.8.0 as it runs today: a repo checkout whose marketplace fake claude has
     * installed from, and its LaunchAgent with its daemon up.
     */
    async legacy08({ running = true, claude } = {}) {
      const repo = path.join(root, "Rokid-Coder checkout");
      writePluginSources(repo, { claude: "./plugin/claude-code", codex: "./plugin/codex" }, "0.8.0", "// hook-forward 0.8.0\n");
      writeExecutable(path.join(repo, "dist", "cli.js"), "#!/usr/bin/env node\n");
      writeJson(path.join(repo, "package.json"), { name: "nexus-agentd", version: "0.8.0" });
      const plist = path.join(home, "Library", "LaunchAgents", "com.anezium.nexus-agentd.plist");
      fs.mkdirSync(path.dirname(plist), { recursive: true });
      fs.writeFileSync(plist, "<plist><!-- 0.8.0 --></plist>\n");
      const legacy = { plist, executable: "/opt/homebrew/bin/node", version: "0.8.0" };
      world.scenario({ ...world.readScenario(), legacy });
      if (claude) {
        world.runCli(claude, ["plugin", "marketplace", "add", repo]);
        world.runCli(claude, ["plugin", "install", "rokid@rokid-coder"]);
        world.clearCliCalls("claude");
      }
      if (running) {
        await world.platform().startLegacyAutostart({ kind: "launchd", label: "com.anezium.nexus-agentd", originalPath: plist, retiredPath: plist, wasLoaded: true, executable: legacy.executable, version: "0.8.0" });
      }
      world.clearCalls();
      return { repo: fs.realpathSync(repo), plist };
    },
    readScenario() {
      const file = path.join(fake, "scenario.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    },
    manifest() {
      const file = path.join(home, ".rokid-coder", "install.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    },
    journal() {
      const file = path.join(home, ".rokid-coder", "setup-journal.json");
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
    },
    async health() {
      return world.platform().health();
    },
    /** The STATE files of both locations (logs, sockets, program and setup files left out). */
    stateBytes(stateDir = path.join(home, ".rokid-coder")) {
      const programSkip = (rel) => /^(bin|env|install\.json|setup-journal\.json|backups|logs)(\/|$)/.test(rel) || rel.endsWith(".sock");
      return {
        nexus: treeBytes(path.join(home, ".nexus-agentd"), { skip: (rel) => rel.endsWith(".log") }),
        state: treeBytes(stateDir, { skip: stateDir === path.join(home, ".rokid-coder") ? programSkip : (rel) => /^logs(\/|$)/.test(rel) || rel.endsWith(".sock") }),
      };
    },
  };
  t.after(async () => {
    const { stopFakeDaemons } = require(path.join(DIST, "setup", "platform", "fake.js"));
    await stopFakeDaemons(fake);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return world;
}

module.exports = { makeWorld, treeBytes, writeBundle, FIXTURES, NODE, DIST, SETUP_MAIN };
