const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnPty } = require("../../dist/launcher/pty.js");
const { freePort } = require("./daemon.js");

const FAKE_CLAUDE = path.join(__dirname, "..", "fixtures", "fake-claude.js");
const FAKE_CODEX = path.join(__dirname, "..", "fixtures", "fake-codex.js");
const RK = path.join(__dirname, "..", "..", "dist", "rk.js");

async function until(check, ms = 5000, what = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const waitDead = (pid, ms = 4000) => until(() => !alive(pid), ms, `pid ${pid} to die`);

/**
 * An environment that cannot reach the user's real agentd, sessions or config:
 * every path is inside `dir`, and the hook port is one nothing listens on.
 */
async function rkEnv(dir, extra = {}) {
  const sessionsDir = path.join(dir, "sessions");
  const stateDir = path.join(dir, "state");
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });
  return {
    sessionsDir,
    configDir: path.join(dir, "rc"),
    env: {
      ...process.env,
      TERM: "xterm",
      ROKID_RK_CLAUDE_BIN: FAKE_CLAUDE,
      ROKID_RK_CODEX_BIN: FAKE_CODEX,
      ROKID_RK_CONFIG_DIR: path.join(dir, "rc"),
      ROKID_CLAUDE_SESSIONS_DIR: sessionsDir,
      NEXUS_AGENTD_STATE_DIR: stateDir,
      NEXUS_AGENTD_HTTP_PORT: String(await freePort()),
      ...extra,
    },
  };
}

/** Runs a command on a fresh pty and collects its output. */
function inPty(file, args, env, size = { cols: 100, rows: 40 }) {
  const child = spawnPty(file, args, { cwd: process.cwd(), env, ...size });
  const run = { child, out: "", exit: undefined };
  child.onData((chunk) => {
    run.out += chunk;
  });
  run.exited = new Promise((resolve) =>
    child.onExit((code, signal) => {
      run.exit = { code, signal };
      resolve(run.exit);
    }),
  );
  run.until = (pattern, ms = 5000) =>
    until(() => run.out.includes(pattern), ms, `${JSON.stringify(pattern)}; saw ${JSON.stringify(run.out)}`);
  run.write = (data) => child.write(data);
  return run;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * `stty -g` with the kernel-owned PENDIN bit cleared. On macOS any raw to cooked
 * switch sets PENDIN ("retype pending input"), and it stays set until some process
 * next reads the terminal, which the user's shell does at once. Nothing reads it
 * between rk's exit and the test's own `stty -g`, so it would be a false difference.
 */
function sttyState(text) {
  return String(text)
    .trim()
    .replace(/lflag=([0-9a-f]+)/, (_all, hex) => `lflag=${(parseInt(hex, 16) & ~0x20000000).toString(16)}`);
}

module.exports = { sttyState, FAKE_CLAUDE, FAKE_CODEX, RK, until, alive, waitDead, rkEnv, inPty, readJson };
