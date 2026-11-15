// A throwaway Mac for the installer's shell scripts: fake scutil, dscl, stat,
// id, launchctl, sudo, getconf, open, pkgutil and lsof that record their argv
// and answer from files the test writes, plus a temp install root standing in
// for /Library/Application Support/RokidCoder. The scripts honour these
// overrides only with ROKID_INSTALLER_TEST=1, so nothing here can reach the
// real /Library, a real LaunchAgent or a real user.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MACOS = path.resolve(__dirname, "..");
const SEP = "\x1f";

const RECORD = `{ printf '%s' "\${0##*/}"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >> "$FAKE_LOG"`;

const FAKES = {
  scutil: `cat "$FAKE_DATA/scutil.out" 2>/dev/null; exit 0`,
  stat: `cat "$FAKE_DATA/console-user" 2>/dev/null || exit 1`,
  dscl: `case "$2" in
  -read) u=\${3#/Users/}; f="$FAKE_DATA/dscl-read-$u"; if [ -f "$f" ]; then cat "$f"; else echo "DS Error: -14136 (eDSRecordNotFound)" >&2; exit 56; fi;;
  -list) cat "$FAKE_DATA/dscl-list-$4" 2>/dev/null;;
esac`,
  id: `case "$1" in -u) cat "$FAKE_DATA/id-u";; -un) cat "$FAKE_DATA/id-un";; esac`,
  launchctl: `exit 0`,
  sudo: `for a in "$@"; do case $a in */getconf) cat "$FAKE_DATA/user-tmpdir"; exit 0;; esac; done
if [ -f "$FAKE_DATA/sudo-exec" ]; then exec "$@"; fi
exit 0`,
  getconf: `cat "$FAKE_DATA/user-tmpdir"`,
  open: `exit 0`,
  pkgutil: `exit 0`,
};

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

/** A version dir as the package lays it out: enough of a bundle for the scripts. */
function writeVersionDir(root, version, { setupLog } = {}) {
  const dir = path.join(root, version);
  writeJson(path.join(dir, "bundle.json"), { version, target: "darwin-arm64" });
  const record = setupLog
    ? `{ printf 'HOME=%s\\nSHELL=%s\\nUSER=%s\\nLOGNAME=%s\\n' "$HOME" "$SHELL" "$USER" "$LOGNAME"; for a in "$@"; do printf 'arg=%s\\n' "$a"; done; } > ${JSON.stringify(setupLog)}`
    : ":";
  writeExecutable(path.join(dir, "bin", "rokid-setup"), `#!/bin/sh\n${record}\nexit \${FAKE_SETUP_STATUS:-0}\n`);
  return dir;
}

function makeMac(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rokid-macos-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "fake-bin");
  const data = path.join(root, "fake-data");
  const log = path.join(root, "calls.log");
  const installRoot = path.join(root, "Library", "Application Support", "RokidCoder");
  const installLog = path.join(root, "install.log");
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(installRoot, { recursive: true });
  for (const [name, body] of Object.entries(FAKES)) {
    writeExecutable(path.join(bin, name), `#!/bin/sh\n${RECORD}\n${body}\n`);
  }
  const env = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C",
    ROKID_INSTALLER_TEST: "1",
    ROKID_INSTALL_ROOT: installRoot,
    ROKID_INSTALL_LOG: installLog,
    FAKE_LOG: log,
    FAKE_DATA: data,
    SCUTIL: path.join(bin, "scutil"),
    DSCL: path.join(bin, "dscl"),
    STAT: path.join(bin, "stat"),
    ID: path.join(bin, "id"),
    LAUNCHCTL: path.join(bin, "launchctl"),
    SUDO: path.join(bin, "sudo"),
    GETCONF: path.join(bin, "getconf"),
    OPEN: path.join(bin, "open"),
    PKGUTIL: path.join(bin, "pkgutil"),
  };
  const users = new Map();
  const mac = {
    root,
    bin,
    data,
    installRoot,
    installLog,
    env,
    /** A directory-service user. A home with a space is printed on its own line, as dscl does. */
    user(name, { uid, home, shell = "/bin/zsh", createHome = true }) {
      if (createHome) fs.mkdirSync(home, { recursive: true });
      users.set(name, { uid, home, shell });
      const value = (key, v) => (/\s/.test(v) ? `${key}:\n ${v}\n` : `${key}: ${v}\n`);
      fs.writeFileSync(path.join(data, `dscl-read-${name}`), `${value("NFSHomeDirectory", home)}${value("UniqueID", String(uid))}${value("UserShell", shell)}`);
      const list = (pick) => [...users].map(([n, u]) => `${n.padEnd(24)} ${pick(u)}\n`).join("");
      fs.writeFileSync(path.join(data, "dscl-list-NFSHomeDirectory"), `_spotlight               /var/empty\nroot                     /var/root\n${list((u) => u.home)}`);
      fs.writeFileSync(path.join(data, "dscl-list-UniqueID"), `_spotlight               89\nroot                     0\n${list((u) => u.uid)}`);
      return home;
    },
    /** What `scutil` shows for State:/Users/ConsoleUser, and who owns /dev/console. */
    console(name, uid, { statUser = name } = {}) {
      fs.writeFileSync(
        path.join(data, "scutil.out"),
        `<dictionary> {\n  GID : 20\n  Name : ${name}\n  SessionInfo : <array> {\n    0 : <dictionary> {\n      kCGSSessionUserIDKey : ${uid}\n      kCGSSessionUserNameKey : ${name}\n    }\n  }\n  UID : ${uid}\n}\n`,
      );
      fs.writeFileSync(path.join(data, "console-user"), `${statUser}\n`);
    },
    whoami(name, uid) {
      fs.writeFileSync(path.join(data, "id-u"), `${uid}\n`);
      fs.writeFileSync(path.join(data, "id-un"), `${name}\n`);
    },
    userTmpdir(dir) {
      fs.writeFileSync(path.join(data, "user-tmpdir"), `${dir}\n`);
    },
    version(version, options) {
      return writeVersionDir(installRoot, version, options);
    },
    /** The package's scripts dir as build-pkg.sh stages it: postinstall, lib/ and the version file. */
    scripts(version) {
      const dir = path.join(root, "scripts");
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
      fs.copyFileSync(path.join(MACOS, "scripts", "postinstall"), path.join(dir, "postinstall"));
      fs.chmodSync(path.join(dir, "postinstall"), 0o755);
      for (const name of fs.readdirSync(path.join(MACOS, "lib"))) fs.copyFileSync(path.join(MACOS, "lib", name), path.join(dir, "lib", name));
      fs.writeFileSync(path.join(dir, "version"), `${version}\n`);
      return dir;
    },
    installJson(home, value) {
      writeJson(path.join(home, ".rokid-coder", "install.json"), { schema: 1, platform: "darwin", ...value });
    },
    journal(home, value) {
      writeJson(path.join(home, ".rokid-coder", "setup-journal.json"), { schema: 1, op: "install", ...value });
    },
    handoff(uid, value) {
      writeJson(path.join(installRoot, "handoff", `${uid}.json`), { uid, ...value });
    },
    run(file, args = [], { extraEnv = {}, input = "" } = {}) {
      const result = spawnSync("/bin/sh", [file, ...args], { env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 30_000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
    },
    calls(name) {
      if (!fs.existsSync(log)) return [];
      return fs
        .readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(SEP))
        .filter((argv) => !name || argv[0] === name);
    },
    clearCalls() {
      fs.rmSync(log, { force: true });
    },
  };
  return mac;
}

module.exports = { MACOS, makeMac, writeExecutable, writeJson };
