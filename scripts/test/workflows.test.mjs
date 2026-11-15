// Static checks of .github/workflows: what each reusable workflow checks out,
// who may create releases, and actionlint. The proof that they run is the
// controller's real runs (T10 Step 4); these keep the shape from drifting.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = path.join(ROOT, ".github", "workflows");
const WORKFLOWS = fs.readdirSync(DIR).filter((name) => /\.ya?ml$/.test(name)).sort();
const read = (name) => fs.readFileSync(path.join(DIR, name), "utf8");

const PRODUCT_REF = "${{ inputs.ref || github.sha }}";
const CXRGLOBAL_REF = "${{ env.CXRGLOBAL_SHA }}";
/** Checkouts of this repository at a fixed older release: dependencies with their own pin, never the tested ref. */
const PINNED_OWN_REFS = new Set(["rokid-coder-v0.8.0"]);

const indent = (line) => line.length - line.trimStart().length;
const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/** Each list item's lines (`- ...` and everything indented under it). */
function items(text) {
  const lines = text.split("\n");
  const out = [];
  lines.forEach((line, at) => {
    const match = /^(\s*)- /.exec(line);
    if (!match) return;
    const start = match[1].length;
    const block = [line];
    for (let next = at + 1; next < lines.length; next++) {
      if (lines[next].trim() && indent(lines[next]) <= start) break;
      block.push(lines[next]);
    }
    out.push({ line: at + 1, block });
  });
  return out;
}

const field = (block, key) => {
  const line = block.find((entry) => new RegExp(`^\\s*(- )?${key}:`).test(entry));
  return line === undefined ? undefined : unquote(line.replace(new RegExp(`^\\s*(- )?${key}:`), ""));
};

function checkouts(name) {
  return items(read(name))
    .filter(({ block }) => /^\s*-?\s*uses:\s*actions\/checkout@/.test(block.find((line) => /uses:/.test(line)) ?? ""))
    .map(({ line, block }) => ({ where: `${name}:${line}`, repository: field(block, "repository"), ref: field(block, "ref"), text: block.join("\n") }));
}

/** Each job that calls a local workflow: its `with:` lines. */
function localCalls(name) {
  const lines = read(name).split("\n");
  const calls = [];
  lines.forEach((line, at) => {
    const match = /^(\s*)uses:\s*\.\/\.github\/workflows\/(\S+)/.exec(line);
    if (!match) return;
    const level = match[1].length;
    let start = at;
    while (start > 0 && !(lines[start - 1].trim() && indent(lines[start - 1]) < level)) start--;
    start--;
    const block = [];
    for (let next = start + 1; next < lines.length; next++) {
      if (lines[next].trim() && indent(lines[next]) < level) break;
      block.push(lines[next]);
    }
    calls.push({ where: `${name}:${at + 1}`, callee: match[2], with: block });
  });
  return calls;
}

const reusable = WORKFLOWS.filter((name) => /^\s{2}workflow_call:/m.test(read(name)));

test("every_called_workflow_checks_out_inputs_ref", () => {
  for (const name of ["tests.yml", "upstream-validation.yml", "emulator.yml", "windows-installer.yml", "macos-installer.yml", "bundles.yml"]) {
    assert.ok(reusable.includes(name), `${name} runs on workflow_call`);
  }
  const problems = [];
  for (const name of reusable) {
    if (!/^\s{2}workflow_call:\n(?:\s{4}.*\n)*?\s{4}inputs:\n(?:\s{6}.*\n)*?\s{6}ref:/m.test(read(name))) problems.push(`${name} has no workflow_call input ref`);
    for (const checkout of checkouts(name)) {
      const ours = checkout.repository === undefined || checkout.repository === "${{ github.repository }}";
      if (checkout.repository === "Anezium/CxrGlobal") {
        if (checkout.ref !== CXRGLOBAL_REF) problems.push(`${checkout.where} checks out CxrGlobal at ${checkout.ref}, not ${CXRGLOBAL_REF}`);
        if (/inputs\.ref/.test(checkout.text)) problems.push(`${checkout.where}: the CxrGlobal checkout references inputs.ref`);
      } else if (ours) {
        if (checkout.ref !== PRODUCT_REF && !PINNED_OWN_REFS.has(checkout.ref)) problems.push(`${checkout.where} checks out ${checkout.ref ?? "the event SHA"}, not ${PRODUCT_REF}`);
      } else if (/inputs\.ref/.test(checkout.text)) {
        problems.push(`${checkout.where}: a dependency checkout (${checkout.repository}) references inputs.ref`);
      }
    }
  }
  // Every call of a local workflow names the commit it is to test.
  for (const name of WORKFLOWS) {
    for (const call of localCalls(name)) {
      const ref = call.with.find((line) => /^\s+ref:/.test(line));
      if (!ref) problems.push(`${call.where} calls ${call.callee} without a ref`);
      else if (reusable.includes(name) && unquote(ref.replace(/^\s+ref:/, "")) !== PRODUCT_REF) problems.push(`${call.where} forwards ${ref.trim()}, not ${PRODUCT_REF}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("every_called_workflow_checks_out_inputs_ref: the scan catches a stray checkout", () => {
  const bad = items("    steps:\n      - name: Check out\n        uses: actions/checkout@v6\n        with:\n          repository: Anezium/CxrGlobal\n          ref: ${{ inputs.ref }}\n");
  assert.equal(bad.length, 1);
  assert.equal(field(bad[0].block, "repository"), "Anezium/CxrGlobal");
  assert.equal(field(bad[0].block, "ref"), "${{ inputs.ref }}");
});

test("no_other_workflow_creates_releases", () => {
  const creates = /gh release (create|edit|upload|delete)|action-gh-release|actions\/create-release|release-action|publish-release\.mjs|releases.*(POST|PATCH)/;
  const problems = [];
  for (const name of WORKFLOWS) {
    const text = read(name);
    const lines = text.split("\n").filter((line) => creates.test(line) && !line.trim().startsWith("#"));
    if (name === "release.yml") {
      for (const line of lines) if (!/publish-release\.mjs (artifacts|assemble|create-draft)\b/.test(line)) problems.push(`release.yml: ${line.trim()}`);
      if (!/publish-release\.mjs create-draft/.test(text)) problems.push("release.yml does not draft");
    } else if (name === "publish-release.yml") {
      for (const line of lines) if (!/publish-release\.mjs promote\b/.test(line)) problems.push(`publish-release.yml: ${line.trim()}`);
    } else {
      for (const line of lines) problems.push(`${name}: ${line.trim()}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("release.yml builds only from rc tags, and publish-release.yml is manual and approval-gated", () => {
  const release = read("release.yml");
  assert.match(release, /^on:\n {2}push:\n {4}tags:\n {6}- "rokid-coder-v\*"\n/m);
  assert.doesNotMatch(release, /workflow_dispatch|pull_request|branches:/);
  for (const job of ["verify", "suites", "android", "android-install", "macos", "windows", "release-summary", "draft"]) {
    assert.match(release, new RegExp(`^ {2}${job}:\\n`, "m"), job);
  }
  assert.match(release, /needs: \[verify, suites, android, android-install, macos, windows\]/);

  const publish = read("publish-release.yml");
  assert.match(publish, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(publish, /^\s{2}(push|pull_request|schedule|workflow_call):/m);
  assert.match(publish, /environment: release/);
  const gateAt = publish.indexOf("release-gate.mjs --rc");
  const promoteAt = publish.indexOf("publish-release.mjs promote");
  assert.ok(gateAt > 0 && promoteAt > gateAt, "the gate runs before the promotion");
});

test("emulator.yml's checkRelease build signs with an ephemeral CI key and overrides the pin for that build only", () => {
  const text = read("emulator.yml");
  const make = text.indexOf("Make an ephemeral CI signing key");
  const run = text.indexOf("./gradlew", make);
  assert.ok(make > 0 && run > make, "the key is made before the release checks run");
  const step = text.slice(make, run);
  assert.match(step, /keytool -genkeypair/);
  assert.match(step, /-storetype PKCS12/);
  assert.match(step, /keytool -exportcert[^\n]*\| sha256sum/);
  for (const name of ["NEXUS_RELEASE_KEYSTORE", "NEXUS_RELEASE_KEYSTORE_PASSWORD", "NEXUS_RELEASE_KEY_ALIAS", "CI_SIGNER_SHA256"]) {
    assert.match(step, new RegExp(`echo "${name}=`), name);
  }
  assert.match(step, /::add-mask::/);
  assert.doesNotMatch(step, /secrets\./, "the CI key is not a repository secret");
  const gradleLine = text.slice(run).split("\n")[0];
  assert.match(gradleLine, /"-Prokid\.releaseSignerSha256=\$CI_SIGNER_SHA256"/);
  assert.match(gradleLine, /:mobile:app:checkRelease/);
  // The shipping pin stays empty in the repository, and no other workflow overrides it.
  const properties = fs.readFileSync(path.join(ROOT, "gradle.properties"), "utf8");
  assert.match(properties, /^rokid\.releaseSignerSha256=$/m);
  const overrides = WORKFLOWS.filter((name) => /-Prokid\.releaseSignerSha256/.test(read(name)));
  assert.deepEqual(overrides, ["emulator.yml"]);
});

test("workflows_lint", (t) => {
  const found = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
  if (found.error) {
    if (process.env.CI) assert.fail("actionlint must be installed in CI (tests.yml's scripts job installs it)");
    t.skip("actionlint is not installed here; tests.yml's scripts job runs it");
    return;
  }
  // Shell and Python inside run: blocks are not linted here; the workflow schema and expressions are.
  const result = spawnSync("actionlint", ["-shellcheck=", "-pyflakes=", ...WORKFLOWS.map((name) => path.join(DIR, name))], { cwd: ROOT, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
