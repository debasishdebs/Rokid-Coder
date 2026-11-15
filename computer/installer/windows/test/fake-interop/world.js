// A fake Windows host and WSL procfs for wsl.ts's tests (6b T8). Nothing here runs
// on Windows or touches a real Task Scheduler:
//
//   <root>/mnt/c/...                     the C: drive (C:\X\Y <-> <root>/mnt/c/X/Y)
//   <root>/mnt/c/Windows/System32/schtasks.exe and .../powershell.exe   recording fakes
//   <root>/bin/wslpath                   the path mapping, both ways
//   <root>/proc                          the procfs the fake daemons register in
//   <root>/windows.json                  the registered tasks and the host's listeners
//   <root>/interop.jsonl                 every interop call's argv, in order
//
// The fake schtasks.exe fails, like interop would, on any /XML argument that is
// a Linux path [6b-R18]. Its /Run starts what the task's action names: the
// binding's agentd, as start-agentd.ps1 would through wsl.exe --exec.
const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const NODE = fs.realpathSync(process.execPath);

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

const nodeScript = (script, root) => `#!/bin/sh\nFAKE_WINDOWS_ROOT='${root}' exec '${NODE}' '${path.join(HERE, script)}' "$@"\n`;

function createWindows(root, { localAppData = "C:\\Users\\Zoë Müller\\AppData\\Local" } = {}) {
  const system32 = path.join(root, "mnt", "c", "Windows", "System32");
  writeExecutable(path.join(system32, "schtasks.exe"), nodeScript("schtasks.js", root));
  writeExecutable(path.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), nodeScript("powershell.js", root));
  writeExecutable(path.join(root, "bin", "wslpath"), nodeScript("wslpath.js", root));
  fs.mkdirSync(path.join(root, "proc", "net"), { recursive: true });
  fs.writeFileSync(path.join(root, "proc", "net", "tcp"), "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n");
  fs.writeFileSync(path.join(root, "proc", "net", "tcp6"), "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n");
  const state = { tasks: {}, listeners: [], localAppData, stopped: [] };
  fs.writeFileSync(path.join(root, "windows.json"), JSON.stringify(state, null, 2));
  return {
    root,
    system32,
    procRoot: path.join(root, "proc"),
    binDir: path.join(root, "bin"),
    toLinux: (win) => toLinux(root, win),
    toWin: (linux) => toWin(root, linux),
    state: () => JSON.parse(fs.readFileSync(path.join(root, "windows.json"), "utf8")),
    update(change) {
      const value = JSON.parse(fs.readFileSync(path.join(root, "windows.json"), "utf8"));
      change(value);
      fs.writeFileSync(path.join(root, "windows.json"), JSON.stringify(value, null, 2));
    },
    calls() {
      const file = path.join(root, "interop.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    clearCalls() {
      fs.rmSync(path.join(root, "interop.jsonl"), { force: true });
    },
    task(name) {
      const value = this.state().tasks[name.replace(/^\\/, "").toLowerCase()];
      return value ? Buffer.from(value, "base64") : undefined;
    },
  };
}

function toLinux(root, win) {
  const match = /^([A-Za-z]):\\(.*)$/.exec(win);
  if (!match) throw new Error(`not a Windows path: ${win}`);
  return path.join(root, "mnt", match[1].toLowerCase(), ...match[2].split("\\").filter(Boolean));
}

function toWin(root, linux) {
  const mnt = path.join(root, "mnt");
  const abs = path.resolve(linux);
  if (abs.startsWith(`${mnt}${path.sep}`)) {
    const [drive, ...rest] = abs.slice(mnt.length + 1).split(path.sep);
    return `${drive.toUpperCase()}:\\${rest.join("\\")}`;
  }
  return `\\\\wsl.localhost\\Ubuntu${abs.replace(/\//g, "\\")}`;
}

function record(root, argv) {
  fs.appendFileSync(path.join(root, "interop.jsonl"), `${JSON.stringify(argv)}\n`);
}

/** A task XML as the Task Scheduler stores it: UTF-16LE with a BOM. */
function utf16(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function decodeXml(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString("utf16le") : bytes.toString("utf8");
}

const xmlUnescape = (value) => value.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * Registers a fake daemon process in the fake procfs: its exe link, its cmdline,
 * and a LISTEN socket per port. Called by the daemon itself.
 */
function registerProcess(procRoot, { pid, exe, argv, ports }) {
  const dir = path.join(procRoot, String(pid));
  fs.mkdirSync(path.join(dir, "fd"), { recursive: true });
  fs.rmSync(path.join(dir, "exe"), { force: true });
  fs.symlinkSync(exe, path.join(dir, "exe"));
  fs.writeFileSync(path.join(dir, "cmdline"), `${argv.join("\0")}\0`);
  ports.forEach((port, i) => {
    const inode = pid * 10 + i;
    fs.symlinkSync(`socket:[${inode}]`, path.join(dir, "fd", String(10 + i)));
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    fs.appendFileSync(path.join(procRoot, "net", "tcp"), `   0: 00000000:${hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0\n`);
  });
}

function unregisterProcess(procRoot, pid) {
  fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
  removeSockets(procRoot, [pid]);
}

function removeSockets(procRoot, pids) {
  const file = path.join(procRoot, "net", "tcp");
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((line, i) => i === 0 || !line.trim() || !pids.includes(Math.floor(Number(line.trim().split(/\s+/)[9]) / 10)));
  fs.writeFileSync(file, kept.join("\n"));
}

/** What the kernel does for a SIGKILLed process: its procfs entry and sockets go. */
function reap(procRoot) {
  const dead = fs.readdirSync(procRoot).filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  for (const pid of dead) fs.rmSync(path.join(procRoot, String(pid)), { recursive: true, force: true });
  removeSockets(procRoot, dead);
}

module.exports = { createWindows, toLinux, toWin, record, utf16, decodeXml, xmlUnescape, registerProcess, unregisterProcess, reap, writeExecutable, NODE };
