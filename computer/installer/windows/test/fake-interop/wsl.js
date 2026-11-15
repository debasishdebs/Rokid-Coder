// Fake wsl.exe for RokidCoder.psm1's Invoke-WslExec: `-d <distro> [-u <user>] --exec
// <absolute path> <argv...>` only, as the module promises. Each distro answers from
// <root>/distros.json ({ "<distro>": { "<path> <argv...>": { stdout, code } } }),
// which a test fills from recorded outputs (recorded/*.json).
const fs = require("node:fs");
const path = require("node:path");
const { record } = require("./world.js");

const root = process.env.FAKE_WINDOWS_ROOT;
const argv = process.argv.slice(2);
record(root, ["wsl.exe", ...argv]);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

let at = 0;
if (argv[at] !== "-d" || !argv[at + 1]) fail("fake wsl.exe: argv must start with -d <distro>", 2);
const distro = argv[at + 1];
at += 2;
if (argv[at] === "-u") {
  if (!argv[at + 1]) fail("fake wsl.exe: -u needs a user", 2);
  at += 2;
}
if (argv[at] !== "--exec") fail("fake wsl.exe: only --exec, never a shell command line", 2);
const exe = argv[at + 1];
if (!exe || !exe.startsWith("/") || exe.includes("~")) fail(`fake wsl.exe: --exec needs an absolute Linux path, not '${exe}'`, 2);

const file = path.join(root, "distros.json");
const distros = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
// What wsl.exe prints (UTF-16LE without WSL_UTF8; the module sets WSL_UTF8=1) for a distro it does not know.
if (!distros[distro]) fail(`There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND`, 1);
const answer = distros[distro][[exe, ...argv.slice(at + 2)].join(" ")];
if (!answer) fail(`${exe}: no recorded output for this call`, 127);
process.stdout.write(answer.stdout ?? "");
process.exit(answer.code ?? 0);
