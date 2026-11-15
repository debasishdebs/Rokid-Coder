// Fake wslpath: -u <windows path> and -w <linux path>, over the fake C: drive.
const { record, toLinux, toWin } = require("./world.js");

const root = process.env.FAKE_WINDOWS_ROOT;
const [flag, value] = process.argv.slice(2);
record(root, ["wslpath", flag, value]);
try {
  if (flag === "-u") process.stdout.write(`${toLinux(root, value)}\n`);
  else if (flag === "-w") process.stdout.write(`${toWin(root, value)}\n`);
  else throw new Error(`unsupported flag ${flag}`);
} catch (error) {
  process.stderr.write(`wslpath: ${error.message}\n`);
  process.exit(1);
}
