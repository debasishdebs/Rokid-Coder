// What the macOS installer CI jobs compare across an upgrade or a rollback,
// without ever printing a secret:
//
//   node state-check.js secrets <home> <out> [<bundle dir>]
//     the sha256 of the token, machineId and durable pin fps. With a bundle,
//     the pins are read through that bundle's own PinStore (what the new code
//     sees); without, straight from 0.8.0's v3 file.
//   node state-check.js state <home> <out>
//     a sha256 per STATE file of both locations (setup's own files, logs and
//     sockets left out), for a byte-identical comparison.
//   node state-check.js compare <a> <b>
//     exits 1 naming the paths that differ, never their content.
//   node state-check.js refresh-pins <home> <expected out>
//     while staging the 0.8.0 fixture: sets each pin's lastUsedAt to now, so
//     the startup expiry cannot forget them before the baseline, and records
//     the trusted set (count and sha256); exits 1 when it is empty.
//   node state-check.js trusted <home> <expected> [<bundle dir>]
//     exits 1 unless the trusted set (read like `secrets` reads it) is
//     nonempty and equals the recorded one.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

function locations(home) {
  const nexusDir = path.join(home, ".nexus-agentd");
  let stateDir = path.join(home, ".rokid-coder");
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(nexusDir, "config.json"), "utf8"))?.rokidCoder?.stateDir;
    if (typeof custom === "string" && custom) stateDir = path.resolve(custom.replace(/^~(?=$|\/)/, home));
  } catch {
    // no config
  }
  return { nexusDir, stateDir };
}

function pinsFile(home) {
  return path.join(locations(home).stateDir, "tls", "phone-pins.json");
}

/** The trusted fingerprints, normalized and sorted: through the bundle's own PinStore, or straight from 0.8.0's v3 file. */
function trustedFps(home, bundle) {
  const file = pinsFile(home);
  const fps = bundle
    ? new (require(path.join(bundle, "app", "dist", "tls.js")).PinStore)(file).list()
    : JSON.parse(fs.readFileSync(file, "utf8")).phones.map((phone) => phone.fp);
  return fps.map((fp) => fp.replace(/:/g, "").toUpperCase()).sort();
}

function secrets(home, out, bundle) {
  const config = JSON.parse(fs.readFileSync(path.join(locations(home).nexusDir, "config.json"), "utf8"));
  fs.writeFileSync(out, `${sha256([config.token, config.machineId, ...trustedFps(home, bundle)].join("\n"))}\n`);
}

const pinSet = (fps) => ({ count: fps.length, sha256: sha256(fps.join("\n")) });

function refreshPins(home, out) {
  const file = pinsFile(home);
  const pins = JSON.parse(fs.readFileSync(file, "utf8"));
  const now = Date.now();
  for (const phone of pins.phones ?? []) phone.lastUsedAt = now;
  fs.writeFileSync(file, `${JSON.stringify(pins, null, 2)}\n`);
  const expected = pinSet(trustedFps(home));
  if (expected.count === 0) {
    process.stderr.write("the staged state has no trusted phone, so nothing would prove the pins survive\n");
    process.exit(1);
  }
  fs.writeFileSync(out, `${JSON.stringify(expected)}\n`);
  process.stdout.write(`${expected.count} trusted phone(s) staged\n`);
}

function trusted(home, expectedFile, bundle) {
  const expected = JSON.parse(fs.readFileSync(expectedFile, "utf8"));
  const actual = pinSet(trustedFps(home, bundle));
  if (actual.count === 0) {
    process.stderr.write("no trusted phone is left\n");
    process.exit(1);
  }
  if (expected.count === 0 || actual.count !== expected.count || actual.sha256 !== expected.sha256) {
    process.stderr.write(`the trusted phones differ from the staged ones (${actual.count} now, ${expected.count} staged)\n`);
    process.exit(1);
  }
  process.stdout.write(`${actual.count} trusted phone(s), as staged\n`);
}

function state(home, out) {
  const { nexusDir, stateDir } = locations(home);
  const programDir = path.join(home, ".rokid-coder");
  const skip = (root, rel) =>
    rel.endsWith(".log") ||
    rel.endsWith(".sock") ||
    (root === stateDir && /^logs(\/|$)/.test(rel)) ||
    (root === programDir && /^(bin|env|install\.json|setup-journal\.json|backups|logs)(\/|$)/.test(rel));
  const files = {};
  for (const [name, root] of [["nexus", nexusDir], ["state", stateDir]]) {
    const visit = (rel) => {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) return;
      for (const entry of fs.readdirSync(abs).sort()) {
        const child = path.join(rel, entry);
        if (skip(root, child)) continue;
        const stat = fs.lstatSync(path.join(root, child));
        if (stat.isDirectory()) visit(child);
        else if (stat.isFile()) files[`${name}/${child}`] = sha256(fs.readFileSync(path.join(root, child)));
      }
    };
    visit("");
  }
  fs.writeFileSync(out, `${JSON.stringify(files, null, 2)}\n`);
}

function compare(a, b) {
  const left = JSON.parse(fs.readFileSync(a, "utf8"));
  const right = JSON.parse(fs.readFileSync(b, "utf8"));
  const differing = [...new Set([...Object.keys(left), ...Object.keys(right)])].filter((key) => left[key] !== right[key]).sort();
  if (differing.length > 0) {
    process.stderr.write(`state differs: ${differing.join(", ")}\n`);
    process.exit(1);
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === "secrets") secrets(...args);
else if (command === "state") state(...args);
else if (command === "compare") compare(...args);
else if (command === "refresh-pins") refreshPins(...args);
else if (command === "trusted") trusted(...args);
else {
  process.stderr.write("usage: state-check.js secrets|state|compare|refresh-pins|trusted ...\n");
  process.exit(64);
}
