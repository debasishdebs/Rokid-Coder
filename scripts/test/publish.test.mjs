// scripts/publish-release.mjs: release.yml's draft assembly, and the promotion
// of exactly the tested rc's files to the final release. gh is the fake in
// fixtures/bin, answering from a JSON world; nothing reaches GitHub.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { readReleaseAssets } from "../publish-release.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "publish-release.mjs");
const FAKE_BIN = path.join(HERE, "fixtures", "bin");
const JOB_PAGES = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "release-run-jobs.json"), "utf8"));

const REPO = "debasishdebs/Rokid-Coder";
const RC = "rokid-coder-v1.0.0-rc.3";
const FINAL = "rokid-coder-v1.0.0";
const COMMIT = "a".repeat(40);
const RUN = 4242;
const NEEDS = ["verify", "suites", "android", "android-install", "macos", "windows"];

const ASSETS = readReleaseAssets(path.join(ROOT, "scripts", "release-assets.txt"), "1.0.0");
const PAYLOAD = ASSETS.filter((asset) => asset.kind === "payload");
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
const sums = (files) => Object.keys(files).sort().map((name) => `${sha256(files[name])}  ${name}\n`).join("");

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-release-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "gh.log");
  const worldFile = path.join(dir, "world.json");
  const run = (world, ...args) => {
    fs.writeFileSync(worldFile, JSON.stringify(world));
    fs.writeFileSync(log, "");
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`, FAKE_GH_WORLD: worldFile, FAKE_GH_LOG: log, HOME: dir },
    });
    const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, calls };
  };
  return { dir, run };
}

const releaseCreates = (calls) => calls.filter((call) => call[0] === "release" && call[1] === "create");
const fileArgs = (call) => call.filter((arg) => path.isAbsolute(arg) && !arg.endsWith("notes.md")).map((arg) => path.basename(arg)).sort();

// ---------------------------------------------------------------- the draft

/** This run's artifacts as download-artifact extracts them: <dir>/<artifact>/<file>. */
function downloaded(dir, { drop = [] } = {}) {
  const artifacts = {
    "android-release": ["rokid-coder-1.0.0.apk", "rokid-coder-1.0.0.aab", "rokid-coder-glasses-1.0.0.apk"],
    // The macOS artifact also holds the bare pkg; only the dmg (which holds it) is a release asset.
    "macos-pkg-arm64": ["rokid-coder-1.0.0-macos-arm64.dmg", "rokid-coder-1.0.0-macos-arm64.pkg"],
    "macos-pkg-x64": ["rokid-coder-1.0.0-macos-x64.dmg", "rokid-coder-1.0.0-macos-x64.pkg"],
    "windows-exe": ["rokid-coder-1.0.0-windows-x64.exe"],
  };
  const from = path.join(dir, "artifacts");
  for (const [artifact, names] of Object.entries(artifacts)) {
    if (drop.includes(artifact)) continue;
    fs.mkdirSync(path.join(from, artifact), { recursive: true });
    for (const name of names) if (!drop.includes(name)) fs.writeFileSync(path.join(from, artifact, name), `bytes of ${name}\n`);
  }
  return from;
}

test("draft_assembly_starts_without_sha256sums_and_uploads_exact_set", (t) => {
  const s = sandbox(t);
  const out = path.join(s.dir, "assets");
  const notes = path.join(s.dir, "notes.md");
  const from = downloaded(s.dir);

  const pattern = s.run({}, "artifacts", "--version", "1.0.0");
  assert.equal(pattern.stdout, "pattern={android-release,macos-pkg-arm64,macos-pkg-x64,windows-exe}\n");

  const assembled = s.run({}, "assemble", "--tag", RC, "--run", String(RUN), "--commit", COMMIT, "--from", from, "--out", out, "--notes", notes);
  assert.equal(assembled.status, 0, assembled.stdout + assembled.stderr);
  const names = fs.readdirSync(out).sort();
  assert.deepEqual(names, ASSETS.map((asset) => asset.name).sort());
  const payload = Object.fromEntries(PAYLOAD.map((asset) => [asset.name, fs.readFileSync(path.join(out, asset.name), "utf8")]));
  assert.equal(fs.readFileSync(path.join(out, "SHA256SUMS"), "utf8"), sums(payload), "SHA256SUMS covers the payload, not itself");
  const body = fs.readFileSync(notes, "utf8");
  assert.ok(body.startsWith(fs.readFileSync(path.join(ROOT, "docs", "coding-agent", "releases", "1.0.0.md"), "utf8")));
  assert.match(body, new RegExp(`\\nBuilt by run: ${RUN}\\nCommit: ${COMMIT}\\n$`));
  assert.deepEqual(releaseCreates(assembled.calls), [], "assembly creates nothing");

  const created = s.run({}, "create-draft", "--tag", RC, "--repo", REPO, "--out", out, "--notes", notes);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  const [create, ...more] = releaseCreates(created.calls);
  assert.deepEqual(more, []);
  assert.equal(create[2], RC);
  for (const flag of ["--draft", "--prerelease", "--verify-tag"]) assert.ok(create.includes(flag), flag);
  assert.ok(!create.includes("--latest"));
  assert.deepEqual(fileArgs(create), ASSETS.map((asset) => asset.name).sort());

  // An upload set that is not exactly the payload and the generated files is refused.
  fs.writeFileSync(path.join(out, "stray.txt"), "x");
  const stray = s.run({}, "create-draft", "--tag", RC, "--repo", REPO, "--out", out, "--notes", notes);
  assert.equal(stray.status, 1);
  assert.match(stray.stderr, /stray\.txt/);
  assert.deepEqual(releaseCreates(stray.calls), []);

  // Assembly starts from nothing: a SHA256SUMS already there is refused.
  const again = s.run({}, "assemble", "--tag", RC, "--run", String(RUN), "--commit", COMMIT, "--from", from, "--out", out, "--notes", notes);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /must start empty/);
});

test("draft_fails_on_a_missing_payload_asset", (t) => {
  for (const [drop, named] of [["windows-exe", /windows-exe/], ["rokid-coder-1.0.0-macos-x64.dmg", /rokid-coder-1\.0\.0-macos-x64\.dmg/], ["rokid-coder-glasses-1.0.0.apk", /rokid-coder-glasses-1\.0\.0\.apk/]]) {
    const s = sandbox(t);
    const out = path.join(s.dir, "assets");
    const from = downloaded(s.dir, { drop: [drop] });
    const result = s.run({}, "assemble", "--tag", RC, "--run", String(RUN), "--commit", COMMIT, "--from", from, "--out", out, "--notes", path.join(s.dir, "notes.md"));
    assert.equal(result.status, 1, drop);
    assert.match(result.stderr, named);
    assert.equal(fs.existsSync(path.join(out, "SHA256SUMS")), false, "no SHA256SUMS over an incomplete payload");
    assert.equal(fs.existsSync(path.join(s.dir, "notes.md")), false, "no notes either");
  }
});

test("release-assets.txt names every 1.0 asset once", () => {
  assert.deepEqual(ASSETS.map((asset) => `${asset.name}|${asset.kind}|${asset.artifact ?? ""}`), [
    "rokid-coder-1.0.0.apk|payload|android-release",
    "rokid-coder-1.0.0.aab|payload|android-release",
    "rokid-coder-glasses-1.0.0.apk|payload|android-release",
    "rokid-coder-1.0.0-macos-arm64.dmg|payload|macos-pkg-arm64",
    "rokid-coder-1.0.0-macos-x64.dmg|payload|macos-pkg-x64",
    "rokid-coder-1.0.0-windows-x64.exe|payload|windows-exe",
    "SHA256SUMS|generated|",
  ]);
});

// ---------------------------------------------------------------- the promotion

const FOOTER = `\n---\nBuilt by run: ${RUN}\nCommit: ${COMMIT}\n`;

function promoteWorld() {
  const payload = Object.fromEntries(PAYLOAD.map((asset) => [asset.name, `bytes of ${asset.name}\n`]));
  const sumsText = sums(payload);
  return {
    api: {
      [`repos/${REPO}/git/ref/tags/${RC}`]: { ref: `refs/tags/${RC}`, object: { type: "tag", sha: "f".repeat(40) } },
      [`repos/${REPO}/git/tags/${"f".repeat(40)}`]: { tag: RC, object: { type: "commit", sha: COMMIT } },
      [`repos/${REPO}/actions/runs/${RUN}`]: {
        id: RUN, path: ".github/workflows/release.yml", event: "push", head_branch: RC, head_sha: COMMIT,
        status: "completed", conclusion: "success",
      },
    },
    pages: {
      [`repos/${REPO}/releases`]: [
        [{ id: 7, tag_name: RC, draft: true, prerelease: true, body: `# Rokid Coder 1.0.0\n${FOOTER}` }],
        [{ id: 3, tag_name: "rokid-coder-v0.8.0", draft: false, prerelease: false, body: "old" }],
      ],
      [`repos/${REPO}/actions/runs/${RUN}/jobs`]: structuredClone(JOB_PAGES),
    },
    artifacts: {
      [`${RUN}/release-provenance`]: {
        "release-provenance.json": JSON.stringify({ run_id: RUN, commit: COMMIT, results: Object.fromEntries(NEEDS.map((need) => [need, "success"])) }),
      },
      [`${RUN}/release-sha256sums`]: { SHA256SUMS: sumsText },
    },
    releases: { [RC]: { ...payload, SHA256SUMS: sumsText } },
  };
}

function promote(t, mutate = () => {}) {
  const s = sandbox(t);
  const world = promoteWorld();
  mutate(world);
  return s.run(world, "promote", "--rc", RC, "--repo", REPO, "--work", path.join(s.dir, "work"));
}

function refused(t, mutate, pattern) {
  const result = promote(t, mutate);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, pattern);
  assert.deepEqual(releaseCreates(result.calls), [], "nothing is created");
  assert.ok(!result.calls.some((call) => call[0] === "release" && call[1] === "delete"), "nothing is deleted");
  return result;
}

const jobsOf = (world) => world.pages[`repos/${REPO}/actions/runs/${RUN}/jobs`];
const findJob = (world, name) => jobsOf(world).flatMap((page) => page.jobs).find((job) => job.name === name);

test("publish_promotes_exact_tested_artifacts: success uploads exactly the rc's files to the final tag", (t) => {
  const result = promote(t);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const creates = releaseCreates(result.calls);
  assert.equal(creates.length, 1);
  const [create] = creates;
  assert.equal(create[2], FINAL);
  assert.equal(create[create.indexOf("--target") + 1], COMMIT);
  assert.ok(create.includes("--latest"));
  for (const flag of ["--draft", "--prerelease"]) assert.ok(!create.includes(flag), `not ${flag}`);
  assert.deepEqual(fileArgs(create), ASSETS.map((asset) => asset.name).sort());
  const notes = create[create.indexOf("--notes-file") + 1];
  assert.ok(notes, "the same notes");

  const createAt = result.calls.indexOf(create);
  const deleteAt = result.calls.findIndex((call) => call[0] === "release" && call[1] === "delete");
  assert.ok(deleteAt > createAt, "the rc draft is deleted after the final release exists");
  assert.deepEqual(result.calls[deleteAt].slice(0, 3), ["release", "delete", RC]);
  assert.ok(result.calls[deleteAt].includes("--yes"));
  assert.ok(!result.calls[deleteAt].includes("--cleanup-tag"), "the rc tag stays");
});

test("publish_promotes_exact_tested_artifacts: refuses what was not tested", (t) => {
  refused(t, (w) => { w.releases[RC]["rokid-coder-1.0.0.apk"] = "other bytes\n"; }, /rokid-coder-1\.0\.0\.apk does not match SHA256SUMS/);
  refused(t, (w) => { w.artifacts[`${RUN}/release-sha256sums`].SHA256SUMS += `${"0".repeat(64)}  extra\n`; }, /SHA256SUMS differs from run 4242's release-sha256sums/);
  refused(t, (w) => { w.pages[`repos/${REPO}/releases`][0][0].body = "# Rokid Coder 1.0.0\n"; }, /provenance footer/);
  refused(t, (w) => { w.api[`repos/${REPO}/actions/runs/${RUN}`].conclusion = "failure"; }, /conclusion is failure/);
  refused(t, (w) => { w.api[`repos/${REPO}/actions/runs/${RUN}`].head_sha = "b".repeat(40); }, /head_sha/);
  refused(t, (w) => { w.api[`repos/${REPO}/actions/runs/${RUN}`].path = ".github/workflows/tests.yml"; }, /not release\.yml/);
  refused(t, (w) => { w.api[`repos/${REPO}/actions/runs/${RUN}`].event = "workflow_dispatch"; }, /event is workflow_dispatch/);
  refused(t, (w) => {
    for (const page of jobsOf(w)) page.jobs = page.jobs.filter((job) => job.name !== "release-summary");
  }, /exactly one release-summary job, found 0/);
  refused(t, (w) => { findJob(w, "release-summary").conclusion = "failure"; }, /release-summary is failure/);
  refused(t, (w) => { findJob(w, "draft").conclusion = "cancelled"; }, /draft is cancelled/);
  refused(t, (w) => {
    const file = w.artifacts[`${RUN}/release-provenance`];
    const provenance = JSON.parse(file["release-provenance.json"]);
    provenance.results["android-install"] = "skipped";
    file["release-provenance.json"] = JSON.stringify(provenance);
  }, /release-provenance\.json: android-install is skipped/);
  refused(t, (w) => {
    const file = w.artifacts[`${RUN}/release-provenance`];
    file["release-provenance.json"] = JSON.stringify({ ...JSON.parse(file["release-provenance.json"]), commit: "c".repeat(40) });
  }, /release-provenance\.json names commit c+/);
  refused(t, (w) => { delete w.artifacts[`${RUN}/release-provenance`]; }, /release-provenance/);
  refused(t, (w) => { w.pages[`repos/${REPO}/releases`][0][0].body = `# x\n\n---\nBuilt by run: ${RUN}\nCommit: ${"d".repeat(40)}\n`; }, /footer names commit d+/);
});

test("publish_promotes_exact_tested_artifacts: an existing final tag or release is refused before anything else", (t) => {
  const tag = refused(t, (w) => {
    w.api[`repos/${REPO}/git/ref/tags/${FINAL}`] = { ref: `refs/tags/${FINAL}`, object: { type: "commit", sha: "e".repeat(40) } };
  }, /The tag rokid-coder-v1\.0\.0 already exists at e+, not the rc commit a+: delete the tag rokid-coder-v1\.0\.0/);
  assert.ok(!tag.calls.some((call) => call[0] === "run" || (call[0] === "release" && call[1] === "download")), "no download first");

  refused(t, (w) => {
    w.pages[`repos/${REPO}/releases`][1].push({ id: 9, tag_name: FINAL, draft: true, prerelease: false, body: "" });
  }, /A release rokid-coder-v1\.0\.0 already exists: delete the release rokid-coder-v1\.0\.0/);

  // The final tag at exactly the rc commit is not in the way.
  const same = promote(t, (w) => {
    w.api[`repos/${REPO}/git/ref/tags/${FINAL}`] = { ref: `refs/tags/${FINAL}`, object: { type: "commit", sha: COMMIT } };
  });
  assert.equal(same.status, 0, same.stdout + same.stderr);
});

test("publish refuses a tag that is not an rc", (t) => {
  const s = sandbox(t);
  const result = s.run(promoteWorld(), "promote", "--rc", FINAL, "--repo", REPO, "--work", path.join(s.dir, "work"));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Final releases are created by publish-release from a tested rc/);
  assert.deepEqual(result.calls, []);
});
