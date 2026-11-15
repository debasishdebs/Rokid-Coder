#!/usr/bin/env node
// upstream-sync.yml's decisions.
//
//   upstream-sync-decide.mjs outcome --code <exit> --log <file>
//     after scripts/upstream-sync.sh: prints the sync job's outputs (code,
//     changed, merge_sha, report) in $GITHUB_OUTPUT form.
//   upstream-sync-decide.mjs report
//     the report job: maps the needs' outcomes (in its environment) to exactly
//     one action, and takes it with gh:
//       exit 0, no change            nothing
//       merge, both suites pass      open a PR, or update the open one
//       merge, a suites job fails    an issue "Upstream sync breaks suites"; the branch stays
//       exit 2                       an issue "Upstream sync conflict" with the script's report
//       anything else                an issue "Upstream sync error"
//     Issues carry the label upstream-sync, and a repeat comments on the open one.
//     A job that tested any commit but merge_sha is an error, not a pass.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LABEL = "upstream-sync";
export const TITLES = { conflict: "Upstream sync conflict", suites: "Upstream sync breaks suites", error: "Upstream sync error" };

/** What upstream-sync.sh's exit and output mean for the sync job. */
export function syncOutcome({ code, log }) {
  const merge = /^MERGE_SHA=([0-9a-f]{40})\s*$/m.exec(log)?.[1] ?? "";
  return {
    code,
    changed: code === 0 && merge !== "",
    merge_sha: code === 0 ? merge : "",
    report: code === 0 && !merge ? "upstream-sync: already up to date." : log.trim(),
  };
}

/** `job=sha` entries, one per line or space-separated; an empty sha is a job that reported none. */
export function parseShas(text = "") {
  return text.split(/\s+/).filter(Boolean).map((entry) => {
    const at = entry.indexOf("=");
    return at < 0 ? { job: entry, sha: "" } : { job: entry.slice(0, at), sha: entry.slice(at + 1) };
  });
}

/**
 * The one action for these outcomes: { action: "none" | "pr" | "issue", title?, body }.
 * inputs = { sync: { result, code, changed, merge_sha, report }, suites: { result, shas }, upstream: { result, shas }, failedJobs, context }
 */
export function decide({ sync, suites = { result: "skipped", shas: [] }, upstream = { result: "skipped", shas: [] }, failedJobs = [], context = {} }) {
  const lines = (...parts) => `${parts.filter((part) => part !== undefined).join("\n")}\n`;
  const runLine = context.runUrl ? `Sync run: ${context.runUrl}` : undefined;
  const source = context.upstreamUrl ? `Upstream: ${context.upstreamUrl} ${context.upstreamRef ?? ""}`.trim() : undefined;
  const error = (why) => ({ action: "issue", title: TITLES.error, body: lines(runLine, source, "", why) });

  const code = sync.code === "" || sync.code === undefined || sync.code === null ? null : Number(sync.code);
  if (code === 2) {
    return { action: "issue", title: TITLES.conflict, body: lines(runLine, source, "", "The merge conflicts with recorded patches and was aborted. No PR was opened.", "", "```", sync.report ?? "", "```") };
  }
  if (code === null) return error(`The sync job ended ${sync.result ?? "without a result"} before upstream-sync.sh reported an exit code.`);
  if (code !== 0) return error(`upstream-sync.sh exited ${code}.\n\n\`\`\`\n${sync.report ?? ""}\n\`\`\``);
  if (sync.changed !== true && sync.changed !== "true") return { action: "none", body: "Nothing to do: upstream has no new commits." };
  if (!/^[0-9a-f]{40}$/.test(sync.merge_sha ?? "")) return error("The merge reported no MERGE_SHA.");

  const jobs = [...suites.shas.map((entry) => ({ ...entry, group: "suites" })), ...upstream.shas.map((entry) => ({ ...entry, group: "upstream" }))];
  const elsewhere = jobs.filter((entry) => entry.sha && entry.sha !== sync.merge_sha);
  if (elsewhere.length) {
    return error(`These jobs tested another commit than the merge ${sync.merge_sha}:\n${elsewhere.map((entry) => `- ${entry.job} tested ${entry.sha}`).join("\n")}`);
  }
  const branchLine = `Branch: ${context.branch ?? ""} (kept)`;
  if (suites.result === "success" && upstream.result === "success") {
    const silent = jobs.filter((entry) => !entry.sha);
    if (silent.length || jobs.length === 0) {
      return error(`A passing job reported no tested commit:\n${(silent.length ? silent : [{ job: "(no jobs)" }]).map((entry) => `- ${entry.job} reported no commit`).join("\n")}`);
    }
    return {
      action: "pr",
      title: `Merge upstream Nexus ${context.upstreamRef ?? "main"} (${context.branch ?? ""})`,
      body: lines(
        "Merges upstream Nexus into vendor/nexus (scripts/upstream-sync.sh, squashed subtree).",
        "",
        runLine,
        source,
        `Merge commit: ${sync.merge_sha}`,
        "",
        "Every product, script and upstream suite passed on that commit, inside the sync run:",
        ...jobs.map((entry) => `- ${entry.group} / ${entry.job}: ${entry.sha}`),
        "",
        "Pull-request runs this PR starts may wait for approval; the sync run above is the evidence.",
      ),
    };
  }
  if (suites.result === "failure" || upstream.result === "failure") {
    const failed = failedJobs.length ? failedJobs : [`suites: ${suites.result}`, `upstream: ${upstream.result}`];
    return {
      action: "issue",
      title: TITLES.suites,
      body: lines(runLine, source, `Merge commit: ${sync.merge_sha}`, branchLine, "", "No PR was opened. These jobs failed on the merge:", ...failed.map((name) => `- ${name}`)),
    };
  }
  return error(`The suites did not finish: suites ${suites.result}, upstream ${upstream.result}.`);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeBody(text) {
  const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || fs.realpathSync(process.env.TMPDIR || "/tmp"), "sync-report-"));
  const file = path.join(dir, "body.md");
  fs.writeFileSync(file, text);
  return file;
}

function report(env) {
  const repo = env.GITHUB_REPOSITORY;
  const context = { runUrl: env.RUN_URL, upstreamUrl: env.UPSTREAM_URL, upstreamRef: env.UPSTREAM_REF, branch: env.SYNC_BRANCH };
  const suites = { result: env.SUITES_RESULT || "skipped", shas: parseShas(env.SUITES_SHAS) };
  const upstream = { result: env.UPSTREAM_RESULT || "skipped", shas: parseShas(env.UPSTREAM_SHAS) };
  let failedJobs = [];
  if (suites.result === "failure" || upstream.result === "failure") {
    failedJobs = gh(["api", "--paginate", `repos/${repo}/actions/runs/${env.RUN_ID}/jobs`, "--jq", ".jobs[]"])
      .split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((job) => job.conclusion === "failure" && /^(suites|upstream) \/ /.test(job.name))
      .map((job) => job.name);
  }
  const sync = { result: env.SYNC_RESULT, code: env.SYNC_CODE, changed: env.SYNC_CHANGED, merge_sha: env.SYNC_MERGE_SHA, report: env.SYNC_REPORT };
  const decision = decide({ sync, suites, upstream, failedJobs, context });

  if (decision.action === "none") {
    process.stdout.write(`upstream-sync: ${decision.body}\n`);
    return;
  }
  const body = writeBody(decision.body);
  if (decision.action === "pr") {
    const open = JSON.parse(gh(["pr", "list", "--state", "open", "--head", env.SYNC_BRANCH, "--json", "number", "--limit", "1", "--repo", repo]) || "[]");
    if (open.length) {
      gh(["pr", "edit", String(open[0].number), "--body-file", body, "--repo", repo]);
      process.stdout.write(`upstream-sync: updated PR #${open[0].number}\n`);
    } else {
      const url = gh(["pr", "create", "--base", env.BASE_BRANCH, "--head", env.SYNC_BRANCH, "--title", decision.title, "--body-file", body, "--repo", repo]);
      process.stdout.write(`upstream-sync: opened ${url.trim()}\n`);
    }
    return;
  }
  gh(["label", "create", LABEL, "--color", "c5def5", "--description", "Opened by the weekly upstream sync", "--force", "--repo", repo]);
  const issues = JSON.parse(gh(["issue", "list", "--state", "open", "--label", LABEL, "--json", "number,title", "--limit", "100", "--repo", repo]) || "[]");
  const same = issues.find((issue) => issue.title === decision.title);
  if (same) {
    gh(["issue", "comment", String(same.number), "--body-file", body, "--repo", repo]);
    process.stdout.write(`upstream-sync: ${decision.title} again; commented on #${same.number}\n`);
  } else {
    const url = gh(["issue", "create", "--title", decision.title, "--label", LABEL, "--body-file", body, "--repo", repo]);
    process.stdout.write(`upstream-sync: opened ${url.trim()}\n`);
  }
}

function outcome(argv) {
  const option = (name) => argv[argv.indexOf(name) + 1];
  const code = Number(option("--code"));
  const result = syncOutcome({ code, log: fs.readFileSync(option("--log"), "utf8") });
  const delimiter = `EOF_${crypto.randomBytes(8).toString("hex")}`;
  process.stdout.write(`code=${result.code}\nchanged=${result.changed}\nmerge_sha=${result.merge_sha}\nreport<<${delimiter}\n${result.report}\n${delimiter}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...argv] = process.argv.slice(2);
  try {
    if (command === "outcome") outcome(argv);
    else if (command === "report") report(process.env);
    else throw new Error("usage: upstream-sync-decide.mjs outcome --code <exit> --log <file> | report");
  } catch (error) {
    process.stderr.write(`upstream-sync-decide: ${error.message}\n${error.stderr ?? ""}`);
    process.exitCode = 1;
  }
}
