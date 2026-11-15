#!/usr/bin/env node
// Drafts an rc's release, and promotes exactly the tested rc to the final one.
//
// release.yml's draft job:
//   publish-release.mjs artifacts --version <v>
//     prints the download-artifact pattern of the payload artifacts.
//   publish-release.mjs assemble --tag <rc> --run <id> --commit <sha> --from <dir> --out <dir> --notes <file>
//     copies every payload asset of scripts/release-assets.txt from the run's
//     downloaded artifacts (<from>/<artifact>/) into an empty <out>, writes
//     SHA256SUMS over them, checks the set, and writes the notes:
//     docs/coding-agent/releases/<v>.md and a provenance footer.
//   publish-release.mjs create-draft --tag <rc> --repo <o/r> --out <dir> --notes <file>
//     gh release create <rc> --draft --prerelease --verify-tag with exactly those files.
//
// publish-release.yml (after scripts/release-gate.mjs):
//   publish-release.mjs promote --rc <rc> --repo <o/r> --work <dir>
//     refuses unless the final tag and release are free, the draft came from a
//     fully successful release.yml push run of the rc's commit, and its files
//     match its SHA256SUMS and the run's; then creates the final release from
//     those files at the rc commit and deletes the draft.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { versionFromTag } from "./check-versions.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NEEDS = ["verify", "suites", "android", "android-install", "macos", "windows"];
const SUMS = "SHA256SUMS";

class Refused extends Error {}
const refuse = (message) => {
  throw new Refused(message);
};

/** scripts/release-assets.txt for `version`: [{ name, kind, producer, artifact }]. */
export function readReleaseAssets(file, version) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("#"))
    .map((line) => {
      const [name, kind, source] = line.split("|").map((cell) => cell.trim());
      if (!["payload", "generated"].includes(kind) || !source) throw new Error(`release-assets.txt: cannot read "${line}"`);
      const [producer, artifact] = kind === "payload" ? source.split(" / ").map((part) => part.trim()) : [source, undefined];
      if (kind === "payload" && !artifact) throw new Error(`release-assets.txt: ${name} names no Actions artifact`);
      return { name: name.replaceAll("{version}", version), kind, producer, artifact };
    });
}

function gh(args, { allowNotFound = false } = {}) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    if (allowNotFound && /HTTP 404/.test(String(error.stderr))) return null;
    throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${String(error.stderr).trim()}`);
  }
}
const ghJson = (args, options) => {
  const out = gh(args, options);
  return out === null ? null : JSON.parse(out);
};
const ghLines = (args) => gh(args).split("\n").filter(Boolean).map((line) => JSON.parse(line));

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sumsOf = (dir, names) => [...names].sort().map((name) => `${sha256(path.join(dir, name))}  ${name}\n`).join("");

function option(argv, name, required = true) {
  const at = argv.indexOf(name);
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (required && !value) refuse(`${name} is required`);
  return value;
}

function sameSet(actual, expected, what) {
  const missing = expected.filter((name) => !actual.includes(name));
  const extra = actual.filter((name) => !expected.includes(name));
  if (missing.length || extra.length) {
    refuse(`${what} is not exactly the release's assets: ${[...missing.map((n) => `missing ${n}`), ...extra.map((n) => `unexpected ${n}`)].join(", ")}`);
  }
}

// ---------------------------------------------------------------- draft

/** The download-artifact pattern for every payload artifact: release.yml fetches exactly these. */
function artifacts(argv) {
  const names = [...new Set(readReleaseAssets(path.join(ROOT, "scripts", "release-assets.txt"), option(argv, "--version"))
    .filter((asset) => asset.kind === "payload").map((asset) => asset.artifact))];
  process.stdout.write(`pattern=${names.length === 1 ? names[0] : `{${names.join(",")}}`}\n`);
}

function assemble(argv) {
  const tag = option(argv, "--tag");
  const run = option(argv, "--run");
  const commit = option(argv, "--commit");
  const from = path.resolve(option(argv, "--from"));
  const out = path.resolve(option(argv, "--out"));
  const notes = path.resolve(option(argv, "--notes"));
  const version = versionFromTag(tag);
  const assets = readReleaseAssets(path.join(ROOT, "scripts", "release-assets.txt"), version);
  if (fs.existsSync(out) && fs.readdirSync(out).length) refuse(`${out} must start empty (no ${SUMS}, no earlier files)`);

  // <from>/<artifact>/ is each of this run's artifacts, as download-artifact extracts them.
  const payload = assets.filter((asset) => asset.kind === "payload");
  for (const artifact of new Set(payload.map((asset) => asset.artifact))) {
    if (!fs.existsSync(path.join(from, artifact))) refuse(`the run has no artifact ${artifact}`);
  }
  for (const asset of payload) {
    if (!fs.existsSync(path.join(from, asset.artifact, asset.name))) refuse(`${asset.name} is missing from the artifact ${asset.artifact}`);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const asset of payload) fs.copyFileSync(path.join(from, asset.artifact, asset.name), path.join(out, asset.name));
  fs.writeFileSync(path.join(out, SUMS), sumsOf(out, payload.map((asset) => asset.name)));
  sameSet(fs.readdirSync(out), assets.map((asset) => asset.name), out);

  const body = fs.readFileSync(path.join(ROOT, "docs", "coding-agent", "releases", `${version}.md`), "utf8");
  fs.writeFileSync(notes, `${body.replace(/\n*$/, "\n")}\n---\nBuilt by run: ${run}\nCommit: ${commit}\n`);
  process.stdout.write(`publish-release: assembled ${assets.length} assets for ${tag}\n`);
}

function createDraft(argv) {
  const tag = option(argv, "--tag");
  const repo = option(argv, "--repo");
  const out = path.resolve(option(argv, "--out"));
  const notes = path.resolve(option(argv, "--notes"));
  const assets = readReleaseAssets(path.join(ROOT, "scripts", "release-assets.txt"), versionFromTag(tag));
  const names = fs.readdirSync(out);
  sameSet(names, assets.map((asset) => asset.name), out);
  const payload = assets.filter((asset) => asset.kind === "payload").map((asset) => asset.name);
  if (fs.readFileSync(path.join(out, SUMS), "utf8") !== sumsOf(out, payload)) refuse(`${SUMS} does not match the files in ${out}`);
  gh(["release", "create", tag, "--draft", "--prerelease", "--verify-tag", "--title", tag, "--notes-file", notes,
    ...[...names].sort().map((name) => path.join(out, name)), "--repo", repo]);
  process.stdout.write(`publish-release: drafted ${tag} (a prerelease) with ${names.length} assets\n`);
}

// ---------------------------------------------------------------- promote

/** The commit a tag names, peeling an annotated tag; null when there is no such tag. */
function tagCommit(repo, tag) {
  let object = ghJson(["api", `repos/${repo}/git/ref/tags/${tag}`], { allowNotFound: true })?.object;
  for (let depth = 0; object && object.type === "tag" && depth < 5; depth++) {
    object = ghJson(["api", `repos/${repo}/git/tags/${object.sha}`]).object;
  }
  if (!object) return null;
  if (object.type !== "commit") refuse(`the tag ${tag} names a ${object.type}, not a commit`);
  return object.sha;
}

function promote(argv) {
  const rc = option(argv, "--rc");
  const repo = option(argv, "--repo");
  const work = path.resolve(option(argv, "--work"));
  const version = versionFromTag(rc);
  const final = `rokid-coder-v${version}`;

  // 1. The final tag and release must be free. --target is ignored for an existing tag, so this is
  //    what binds the final tag to the tested commit.
  const rcCommit = tagCommit(repo, rc);
  if (!rcCommit) refuse(`the tag ${rc} does not exist`);
  const finalCommit = tagCommit(repo, final);
  if (finalCommit && finalCommit !== rcCommit) {
    refuse(`The tag ${final} already exists at ${finalCommit}, not the rc commit ${rcCommit}: delete the tag ${final} first`);
  }
  const releases = ghLines(["api", "--paginate", `repos/${repo}/releases`, "--jq", ".[]"]);
  if (releases.some((release) => release.tag_name === final)) refuse(`A release ${final} already exists: delete the release ${final} first`);
  const drafts = releases.filter((release) => release.tag_name === rc && release.draft);
  if (drafts.length !== 1) refuse(`expected one draft release of ${rc}, found ${drafts.length}`);
  const [draft] = drafts;

  // 2. The draft's provenance: a fully successful release.yml push run of exactly the rc commit.
  const runId = /^Built by run: (\d+)\s*$/m.exec(draft.body ?? "")?.[1];
  const footerCommit = /^Commit: ([0-9a-f]{40})\s*$/m.exec(draft.body ?? "")?.[1];
  if (!runId || !footerCommit) refuse(`the draft of ${rc} has no provenance footer (Built by run: / Commit:)`);
  if (footerCommit !== rcCommit) refuse(`the draft's footer names commit ${footerCommit}, not the rc commit ${rcCommit}`);
  const run = ghJson(["api", `repos/${repo}/actions/runs/${runId}`]);
  if (run.path !== ".github/workflows/release.yml" && !String(run.path).startsWith(".github/workflows/release.yml@")) refuse(`run ${runId} is ${run.path}, not release.yml`);
  if (run.event !== "push") refuse(`run ${runId}'s event is ${run.event}, not push`);
  if (run.head_branch !== rc) refuse(`run ${runId} was triggered by ${run.head_branch}, not ${rc}`);
  if (run.head_sha !== rcCommit) refuse(`run ${runId}'s head_sha ${run.head_sha} is not the rc commit ${rcCommit}`);
  if (run.status !== "completed" || run.conclusion !== "success") refuse(`run ${runId}'s conclusion is ${run.conclusion ?? run.status}, not success`);
  const jobs = ghLines(["api", "--paginate", `repos/${repo}/actions/runs/${runId}/jobs`, "--jq", ".jobs[]"]);
  for (const name of ["release-summary", "draft"]) {
    const found = jobs.filter((job) => job.name === name);
    if (found.length !== 1) refuse(`run ${runId} has not exactly one ${name} job, found ${found.length}`);
    if (found[0].conclusion !== "success") refuse(`run ${runId}'s ${name} is ${found[0].conclusion}, not success`);
  }
  fs.rmSync(work, { recursive: true, force: true });
  const provenanceDir = path.join(work, "provenance");
  const sumsDir = path.join(work, "run-sums");
  const assetsDir = path.join(work, "assets");
  try {
    gh(["run", "download", runId, "--name", "release-provenance", "--dir", provenanceDir, "--repo", repo]);
  } catch (error) {
    refuse(`run ${runId} has no release-provenance artifact: ${error.message}`);
  }
  const provenance = JSON.parse(fs.readFileSync(path.join(provenanceDir, "release-provenance.json"), "utf8"));
  if (String(provenance.run_id) !== runId) refuse(`release-provenance.json names run ${provenance.run_id}, not ${runId}`);
  if (provenance.commit !== rcCommit) refuse(`release-provenance.json names commit ${provenance.commit}, not ${rcCommit}`);
  for (const need of NEEDS) {
    if (provenance.results?.[need] !== "success") refuse(`release-provenance.json: ${need} is ${provenance.results?.[need] ?? "missing"}, not success`);
  }

  // 3. The draft's files are the ones the run summed.
  try {
    gh(["run", "download", runId, "--name", "release-sha256sums", "--dir", sumsDir, "--repo", repo]);
  } catch (error) {
    refuse(`run ${runId} has no release-sha256sums artifact: ${error.message}`);
  }
  gh(["release", "download", rc, "--dir", assetsDir, "--repo", repo]);
  const names = fs.readdirSync(assetsDir);
  const assets = readReleaseAssets(path.join(ROOT, "scripts", "release-assets.txt"), version);
  sameSet(names, assets.map((asset) => asset.name), `the draft of ${rc}`);
  const sumsText = fs.readFileSync(path.join(assetsDir, SUMS), "utf8");
  if (sumsText !== fs.readFileSync(path.join(sumsDir, SUMS), "utf8")) refuse(`the draft's ${SUMS} differs from run ${runId}'s release-sha256sums`);
  const listed = new Map(sumsText.split("\n").filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) refuse(`${SUMS} has a line that is not "<sha256>  <name>"`);
    return [match[2], match[1]];
  }));
  sameSet([...listed.keys(), SUMS], names, SUMS);
  for (const [name, digest] of listed) if (sha256(path.join(assetsDir, name)) !== digest) refuse(`${name} does not match ${SUMS}`);

  // 4 and 5. The final release, of exactly those files, at the rc commit; then the draft goes.
  const notes = path.join(work, "notes.md");
  fs.writeFileSync(notes, draft.body);
  gh(["release", "create", final, "--target", rcCommit, "--latest", "--title", final, "--notes-file", notes,
    ...[...names].sort().map((name) => path.join(assetsDir, name)), "--repo", repo]);
  gh(["release", "delete", rc, "--yes", "--repo", repo]);
  process.stdout.write(`publish-release: published ${final} at ${rcCommit} from ${rc} (run ${runId}); the draft is deleted\n`);
}

const COMMANDS = { artifacts, assemble, "create-draft": createDraft, promote };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (!COMMANDS[command]) throw new Refused("usage: publish-release.mjs assemble|create-draft|promote ...");
    COMMANDS[command](argv);
  } catch (error) {
    process.stderr.write(`publish-release: refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
