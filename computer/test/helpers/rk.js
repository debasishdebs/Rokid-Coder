const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawnPty } = require("../../dist/launcher/pty.js");
const { freePort } = require("./daemon.js");
const { PinStore } = require("../../dist/tls.js");

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

/** Records one trusted phone in the pin file rk reads. */
function pairPhone(configDir) {
  new PinStore(path.join(configDir, "tls", "phone-pins.json")).add("AB".repeat(32));
}

/**
 * An environment that cannot reach the user's real agentd, sessions or config:
 * every path is inside `dir`, and the hook port is one nothing listens on. A
 * phone is paired unless `unpaired`, so a terminal run is not held at the
 * pairing prompt.
 */
async function rkEnv(dir, extra = {}, { unpaired = false } = {}) {
  const sessionsDir = path.join(dir, "sessions");
  const stateDir = path.join(dir, "state");
  // Not "rc": the terminal tests write the exit status to `${dir}/rc`.
  const configDir = path.join(dir, "rokid-coder");
  await fsp.mkdir(sessionsDir, { recursive: true });
  await fsp.mkdir(stateDir, { recursive: true });
  if (!unpaired) {
    pairPhone(configDir);
  }
  return {
    sessionsDir,
    configDir,
    env: {
      ...process.env,
      TERM: "xterm",
      ROKID_RK_CLAUDE_BIN: FAKE_CLAUDE,
      ROKID_RK_CODEX_BIN: FAKE_CODEX,
      ROKID_RK_CONFIG_DIR: configDir,
      ROKID_CLAUDE_SESSIONS_DIR: sessionsDir,
      NEXUS_AGENTD_STATE_DIR: stateDir,
      NEXUS_AGENTD_HTTP_PORT: String(await freePort()),
      // R158's wait is tested on its own; every other rk codex run starts at once.
      ROKID_RK_CODEX_HINT_WAIT_MS: "0",
      ...extra,
    },
  };
}

// Everything a test started that has not exited yet. killLive() runs after each
// test, so a failed assertion cannot leave an rk, a fake or a grandchild behind.
const live = new Set();

/** Registers a process for killLive(). `kill` ends it; `env` may name a FAKE_PIDFILE. */
function track(kill, env) {
  const entry = { kill, env };
  live.add(entry);
  return () => live.delete(entry);
}

function killLive() {
  for (const { kill, env } of live) {
    try {
      kill();
    } catch {
      // already gone
    }
    // The fake runs in its own session, so killing rk's group does not reach it.
    const pids = env && env.FAKE_PIDFILE ? readJson(env.FAKE_PIDFILE) : undefined;
    for (const target of pids ? [-pids.pid, pids.pid, pids.grandchild] : []) {
      try {
        if (target) process.kill(target, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  live.clear();
}

/** Runs a command on a fresh pty and collects its output. */
function inPty(file, args, env, size = { cols: 100, rows: 40 }) {
  const child = spawnPty(file, args, { cwd: process.cwd(), env, ...size });
  const untrack = track(() => child.kill("SIGKILL"), env);
  const run = { child, out: "", exit: undefined };
  child.onData((chunk) => {
    run.out += chunk;
  });
  run.exited = new Promise((resolve) =>
    child.onExit((code, signal) => {
      untrack();
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

/**
 * Replays the cursor and bracketed-paste sequences in `text` in order, as a
 * terminal would, and returns the state they leave behind.
 */
function terminalModes(text) {
  const modes = { cursorHidden: false, bracketedPaste: false };
  for (const match of String(text).matchAll(/\x1b\[\?(25|2004)([hl])/g)) {
    const on = match[2] === "h";
    if (match[1] === "25") modes.cursorHidden = !on;
    else modes.bracketedPaste = on;
  }
  return modes;
}

/**
 * R162: what the modes a TUI may own are left as by the end of `text`: the
 * alternate screen, any mouse or focus reporting, and the kitty keyboard stack.
 */
function tuiModes(text) {
  const modes = { altScreen: false, mouse: [], focus: false, kittyDepth: 0 };
  for (const match of String(text).matchAll(/\x1b\[(?:\?(\d+)([hl])|([<>])(\d*)u)/g)) {
    if (match[3] === ">") {
      modes.kittyDepth += 1;
    } else if (match[3] === "<") {
      modes.kittyDepth = Math.max(0, modes.kittyDepth - (Number(match[4]) || 1));
    } else {
      const mode = Number(match[1]);
      const on = match[2] === "h";
      if (mode === 1049) modes.altScreen = on;
      else if (mode === 1004) modes.focus = on;
      else if ([1000, 1002, 1003, 1006, 1015].includes(mode)) {
        modes.mouse = on ? [...new Set([...modes.mouse, mode])].sort() : modes.mouse.filter((m) => m !== mode);
      }
    }
  }
  return modes;
}

module.exports = { pairPhone, track, killLive, sttyState, terminalModes, tuiModes, FAKE_CLAUDE, FAKE_CODEX, RK, until, alive, waitDead, rkEnv, inPty, readJson };
