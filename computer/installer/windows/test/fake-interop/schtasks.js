// Fake schtasks.exe over interop: /Create /XML, /Query /XML, /Run, /End, /Delete.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { record, toLinux, decodeXml, xmlUnescape } = require("./world.js");

const root = process.env.FAKE_WINDOWS_ROOT;
const argv = process.argv.slice(2);
record(root, ["schtasks.exe", ...argv]);
const stateFile = path.join(root, "windows.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const arg = (name) => {
  const at = argv.findIndex((value) => value.toLowerCase() === name.toLowerCase());
  return at < 0 ? undefined : argv[at + 1];
};
const fail = (text) => {
  process.stderr.write(`ERROR: ${text}\r\n`);
  process.exit(1);
};

const op = argv[0]?.toLowerCase();
const name = arg("/TN");
if (!name) fail("Invalid syntax.");
const key = name.replace(/^\\/, "").toLowerCase();

if (op === "/create") {
  const xml = arg("/XML");
  // What interop does with a Linux path: hands it to Windows untranslated, where it names nothing.
  if (!xml || xml.startsWith("/")) fail(`The system cannot find the path specified: ${xml}`);
  const file = toLinux(root, xml);
  if (!fs.existsSync(file)) fail(`The system cannot find the file specified: ${xml}`);
  if (state.tasks[key] && !argv.some((value) => value.toLowerCase() === "/f")) fail("Cannot create a file when that file already exists.");
  state.tasks[key] = fs.readFileSync(file).toString("base64");
  save();
  process.stdout.write(`SUCCESS: The scheduled task "${name}" has successfully been created.\r\n`);
} else if (op === "/query") {
  if (!state.tasks[key]) fail("The system cannot find the file specified.");
  process.stdout.write(Buffer.from(state.tasks[key], "base64"));
} else if (op === "/delete") {
  if (!state.tasks[key]) fail("The system cannot find the file specified.");
  delete state.tasks[key];
  save();
} else if (op === "/end") {
  if (!state.tasks[key]) fail("The system cannot find the file specified.");
} else if (op === "/run") {
  if (!state.tasks[key]) fail("The system cannot find the file specified.");
  const xml = decodeXml(Buffer.from(state.tasks[key], "base64"));
  const args = xmlUnescape(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? "");
  const binding = /-Binding "([^"]+)"/.exec(args)?.[1];
  if (binding) {
    // start-agentd.ps1: read the binding, run its agentd inside the distro.
    const contents = JSON.parse(fs.readFileSync(toLinux(root, binding), "utf8"));
    const child = spawn("/bin/sh", ["-c", '("$0" run) </dev/null >/dev/null 2>&1 &', contents.agentdPath], {
      stdio: "ignore",
      env: { HOME: contents.linuxHome, PATH: "/usr/bin:/bin", FAKE_PROC_ROOT: path.join(root, "proc") },
    });
    child.unref();
    child.on("exit", () => process.exit(0));
    return;
  }
  const legacy = state.legacyRunner;
  if (legacy && key === "nexusagentd") {
    state.listeners.push(...legacy);
    save();
  }
} else {
  fail("Invalid syntax.");
}
