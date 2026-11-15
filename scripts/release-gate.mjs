#!/usr/bin/env node
// The release gate: the device checklist, as committed, against the fixed schema
// scripts/checklist-required.json.
//
//   node scripts/release-gate.mjs --lint          the format, and every schema row present
//   node scripts/release-gate.mjs --rc <rc tag>   may this rc be published?
//
// --rc refuses unless the checklist's Tested build is the rc; every schema row
// appears once, as the schema has it, Required = yes and PASS, tested on an rc
// of this rc's line (the smoke rows on this rc itself); and Final reviews lists
// exactly one READY execution review of each plan for an ancestor of the rc,
// one of which (or a re-check listed beside them) leaves only evidence changed
// between its reviewed commit and the rc. The checks are pure over `repo`.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const COLUMNS = ["ID", "Area", "Item", "Platform", "CLI", "Required", "Tested on", "Result", "Notes"];
const PLATFORMS = new Set(["macOS", "Windows (WSL)", "phone/glasses"]);
const CLIS = new Set(["Claude Code", "Codex", "—"]);
const RESULTS = new Set(["PASS", "FAIL", "N/A", ""]);
const RC_TAG = /^rokid-coder-v\d+\.\d+\.\d+-rc\.\d+$/;
const PLACEHOLDER = /^<[^<>]+>$/;
const HEADERS = { testedBuild: "Tested build:", finalReviews: "Final reviews:", windowsVerified: "ROKID_RK_WINDOWS_VERIFIED:" };

/** Splits a table row on its unescaped pipes. */
function cells(line) {
  const out = [];
  let cell = "";
  for (let i = 1; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (line[i] === "|") {
      out.push(cell.trim());
      cell = "";
    } else cell += line[i];
  }
  return out;
}

export function parseChecklist(text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const header = {};
  for (const [key, prefix] of Object.entries(HEADERS)) {
    const found = lines.filter((line) => line.startsWith(prefix));
    if (found.length !== 1) problems.push(`the header line "${prefix}" appears ${found.length} times`);
    header[key] = found.length ? found[0].slice(prefix.length).trim() : undefined;
  }
  const rows = [];
  let inTable = false;
  lines.forEach((line, at) => {
    if (!line.startsWith("|")) {
      inTable = false;
      return;
    }
    const row = cells(line);
    if (row[0] === "ID") {
      if (row.join("|") !== COLUMNS.join("|")) problems.push(`line ${at + 1}: a table's columns are not ${COLUMNS.join(", ")}`);
      inTable = true;
      return;
    }
    if (/^:?-+:?$/.test(row[0] ?? "")) return;
    if (!inTable) {
      problems.push(`line ${at + 1}: a table row outside a checklist table`);
      return;
    }
    if (row.length !== COLUMNS.length) {
      problems.push(`line ${at + 1}: ${row[0]} has ${row.length} cells, not ${COLUMNS.length}`);
      return;
    }
    const [id, area, item, platform, cli, required, testedOn, result, notes] = row;
    rows.push({ id, area, item, platform, cli, required, testedOn, result, notes, line: at + 1 });
  });
  return { header, rows, problems };
}

/** The checklist's format, and every schema row in it as the schema has it. Placeholders and blanks pass. */
export function lint(text, schema) {
  const { header, rows, problems } = parseChecklist(text);
  const at = (row) => `${row.id} (line ${row.line})`;
  if (header.testedBuild !== undefined && !PLACEHOLDER.test(header.testedBuild) && !RC_TAG.test(header.testedBuild)) {
    problems.push(`Tested build is ${header.testedBuild}, neither an rc tag nor a placeholder`);
  }
  if (header.windowsVerified !== undefined && !["yes", "no", "<yes|no>"].includes(header.windowsVerified)) {
    problems.push(`ROKID_RK_WINDOWS_VERIFIED is ${header.windowsVerified}, not yes or no`);
  }
  const counts = new Map();
  for (const row of rows) {
    counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    if (!/^[A-Z0-9][A-Z0-9-]*$/.test(row.id)) problems.push(`line ${row.line}: ID ${row.id} is not an ID`);
    if (!PLATFORMS.has(row.platform)) problems.push(`${at(row)}: Platform is ${row.platform}`);
    if (!CLIS.has(row.cli)) problems.push(`${at(row)}: CLI is ${row.cli}`);
    if (!["yes", "no"].includes(row.required)) problems.push(`${at(row)}: Required is ${row.required}, not yes or no`);
    if (row.testedOn && !RC_TAG.test(row.testedOn)) problems.push(`${at(row)}: Tested on is ${row.testedOn}, not an rc tag`);
    if (!RESULTS.has(row.result)) problems.push(`${at(row)}: Result is ${row.result}, not PASS, FAIL, N/A or blank`);
  }
  for (const [id, count] of counts) if (count > 1) problems.push(`${id} appears ${count} times`);
  const schemaIds = new Set(schema.rows.map((row) => row.id));
  for (const expected of schema.rows) {
    const found = rows.filter((row) => row.id === expected.id);
    if (found.length === 0) {
      problems.push(`${expected.id} is missing`);
      continue;
    }
    for (const row of found) {
      if (row.platform !== expected.platform) problems.push(`${at(row)}: Platform is ${row.platform}, expected ${expected.platform}`);
      if (row.cli !== expected.cli) problems.push(`${at(row)}: CLI is ${row.cli}, expected ${expected.cli}`);
      if (row.required !== "yes") problems.push(`${at(row)}: Required is ${row.required}; the schema requires it`);
    }
  }
  for (const row of rows) {
    if (!schemaIds.has(row.id) && row.required !== "no") problems.push(`${row.id} is not in the schema and must be Required = no`);
  }
  return problems;
}

const isEvidence = (file, schema) => file === schema.checklist || file.startsWith(schema.reviewsDir);

/** The listed reviews: each READY for an ancestor of the rc, one execution review per plan, and coverage. */
function checkReviews(listed, schema, rcCommit, repo) {
  const problems = [];
  const ready = [];
  const execByPlan = new Map(schema.plans.map((plan) => [plan, []]));
  for (const entry of listed) {
    const file = entry.includes("/") ? entry : `${schema.reviewsDir}${entry}`;
    const name = path.posix.basename(file);
    if (!file.startsWith(schema.reviewsDir) || file.slice(schema.reviewsDir.length).includes("/")) {
      problems.push(`Final reviews: ${entry} is not under ${schema.reviewsDir}`);
      continue;
    }
    const plan = /plan-(6[a-z])\b/.exec(name)?.[1];
    const exec = /exec/.test(name);
    const recheck = /re-?check/.test(name);
    if (exec && plan && execByPlan.has(plan)) execByPlan.get(plan).push(name);
    else if (!recheck) {
      problems.push(`Final reviews: ${name} is not an execution review (plan-6a/6b/6c and exec) or a re-check`);
      continue;
    }
    const text = repo.readFile(file);
    if (text === null || text === undefined) {
      problems.push(`Final reviews: ${name} does not exist`);
      continue;
    }
    const reviewed = /^Reviewed commit:\s*([0-9a-f]{7,40})\s*$/m.exec(text)?.[1];
    if (!reviewed) {
      problems.push(`Final reviews: ${name} has no Reviewed commit: <sha> line`);
      continue;
    }
    const commit = repo.commitOf(reviewed);
    if (!commit || !repo.isAncestor(commit, rcCommit)) {
      problems.push(`Final reviews: ${name} reviewed ${reviewed}, which is not an ancestor of the rc commit ${rcCommit}`);
      continue;
    }
    const last = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    if (last !== "VERDICT: READY") {
      problems.push(`Final reviews: ${name} does not end with VERDICT: READY`);
      continue;
    }
    ready.push({ name, commit });
  }
  for (const [plan, files] of execByPlan) {
    if (files.length === 0) problems.push(`Final reviews: no execution review of plan ${plan}`);
    if (files.length > 1) problems.push(`Final reviews: ${files.length} execution reviews of plan ${plan} (${files.join(", ")})`);
  }
  const covering = ready.find(({ commit }) => repo.changedFiles(commit, rcCommit).every((file) => isEvidence(file, schema)));
  if (ready.length && !covering) {
    problems.push("Final reviews: no READY review covers the rc: every listed review is followed by a code change (re-check the change and list it)");
  }
  return problems;
}

/** Why `rcTag` may not be published from this checklist; empty when it may. */
export function gate({ text, schema, rcTag, repo }) {
  const problems = lint(text, schema);
  const { header, rows } = parseChecklist(text);
  if (!RC_TAG.test(rcTag)) return [...problems, `${rcTag} is not an rc tag`];
  const rcCommit = repo.commitOf(rcTag);
  if (!rcCommit) return [...problems, `the tag ${rcTag} does not exist`];
  if (header.testedBuild !== rcTag) problems.push(`Tested build is ${header.testedBuild}, not ${rcTag}`);

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const expected of schema.rows) {
    const row = byId.get(expected.id);
    if (!row) continue;
    if (row.result !== "PASS") problems.push(`${row.id} (line ${row.line}): Result is ${row.result || "blank"}, not PASS`);
    if (!row.testedOn) {
      problems.push(`${row.id} (line ${row.line}): Tested on is blank`);
      continue;
    }
    if (expected.smoke && row.testedOn !== rcTag) {
      problems.push(`${row.id} is a smoke row tested on ${row.testedOn}; it must be tested on ${rcTag}`);
      continue;
    }
    const tested = RC_TAG.test(row.testedOn) ? repo.commitOf(row.testedOn) : null;
    if (!tested || !repo.isAncestor(tested, rcCommit)) {
      problems.push(`${row.id} was tested on ${row.testedOn}, which is not an ancestor of ${rcTag}`);
    }
  }

  const verified = schema.windowsVerified;
  const value = header.windowsVerified;
  if (value !== "yes" && value !== "no") problems.push(`${verified.header} is ${value}, not yes or no`);
  if (value === "yes") {
    for (const id of verified.rows) if (byId.get(id)?.result !== "PASS") problems.push(`${verified.header} is yes, but ${id} is not PASS`);
  }

  const listed = PLACEHOLDER.test(header.finalReviews ?? "") ? [] : (header.finalReviews ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  problems.push(...checkReviews(listed, schema, rcCommit, repo));
  return problems;
}

/** The gate's view of a real checkout. */
export function gitRepo(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return {
    commitOf: (ref) => {
      try {
        return git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      } catch {
        return null;
      }
    },
    isAncestor: (a, b) => {
      try {
        git("merge-base", "--is-ancestor", a, b);
        return true;
      } catch {
        return false;
      }
    },
    changedFiles: (a, b) => git("diff", "--name-only", a, b).split("\n").filter(Boolean),
    readFile: (file) => {
      const full = path.join(root, file);
      return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
    },
  };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const schema = JSON.parse(fs.readFileSync(path.join(root, "scripts", "checklist-required.json"), "utf8"));
  const text = fs.readFileSync(path.join(root, schema.checklist), "utf8");
  const rc = argv[argv.indexOf("--rc") + 1];
  let problems;
  if (argv.includes("--lint")) problems = lint(text, schema);
  else if (argv.includes("--rc") && rc) problems = gate({ text, schema, rcTag: rc, repo: gitRepo(root) });
  else {
    process.stderr.write("usage: release-gate.mjs --lint | --rc <rc tag>\n");
    return 2;
  }
  if (problems.length) {
    process.stderr.write(`release-gate: refused (${problems.length}):\n${problems.map((problem) => `  ${problem}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write(argv.includes("--lint") ? `release-gate: ${schema.checklist} is well formed; all ${schema.rows.length} schema rows are present\n` : `release-gate: ${rc} may be published\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
