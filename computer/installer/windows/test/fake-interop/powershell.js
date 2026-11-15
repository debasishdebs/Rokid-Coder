// Fake powershell.exe over interop. wsl.ts and advertise.ts run only fixed
// scripts, each starting with a `# rokid:<name>` line; data comes on stdin as JSON.
const fs = require("node:fs");
const path = require("node:path");
const { record, toLinux, utf16, decodeXml } = require("./world.js");

const root = process.env.FAKE_WINDOWS_ROOT;
const argv = process.argv.slice(2);
record(root, ["powershell.exe", ...argv]);
const stateFile = path.join(root, "windows.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

if (argv[0] !== "-NoProfile" || argv[1] !== "-NonInteractive" || argv[2] !== "-Command" || argv.length !== 4) {
  process.stderr.write("fake powershell: argv must be -NoProfile -NonInteractive -Command <script>\n");
  process.exit(2);
}
const script = argv[3];
const name = /^<# rokid:([a-z-]+) #>/.exec(script)?.[1];
const input = () => JSON.parse(fs.readFileSync(0, "utf8") || "{}");

switch (name) {
  case "export-task": {
    const { taskPath, taskName, file } = input();
    const stored = state.tasks[`${taskPath}${taskName}`.replace(/^\\/, "").toLowerCase()];
    if (!stored) {
      process.stdout.write("absent");
      break;
    }
    // Export-ScheduledTask hands back the XML as a string; .NET writes it UTF-16LE with a BOM.
    fs.writeFileSync(toLinux(root, file), utf16(decodeXml(Buffer.from(stored, "base64"))));
    process.stdout.write("exported");
    break;
  }
  case "local-app-data":
    process.stdout.write(Buffer.from(`${state.localAppData}\r\n`, "utf8"));
    break;
  case "listeners": {
    const { ports } = input();
    const found = state.listeners.filter((listener) => ports.includes(listener.port));
    // Windows PowerShell 5.1 prints one object, not a one-item array.
    if (found.length === 1) process.stdout.write(JSON.stringify(found[0]));
    else if (found.length > 1) process.stdout.write(JSON.stringify(found));
    break;
  }
  case "stop-exact": {
    const wanted = input();
    const proc = state.listeners.find((listener) => listener.pid === wanted.pid);
    if (!proc) {
      process.stdout.write("gone");
    } else if (proc.executablePath !== wanted.executablePath || proc.commandLine !== wanted.commandLine || proc.creationDate !== wanted.creationDate) {
      process.stdout.write("mismatch");
    } else if (state.unstoppable) {
      process.stdout.write("stopped");
    } else {
      state.listeners = state.listeners.filter((listener) => listener.pid !== wanted.pid);
      state.stopped.push(wanted.pid);
      save();
      process.stdout.write("stopped");
    }
    break;
  }
  case "host-ipv4":
    process.stdout.write(fs.existsSync(path.join(root, "ips.txt")) ? fs.readFileSync(path.join(root, "ips.txt")) : "");
    break;
  default:
    process.stderr.write(`fake powershell: unknown script ${name}\n`);
    process.exit(2);
}
