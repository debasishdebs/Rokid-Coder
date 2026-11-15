// scripts/release-gate.mjs: publish-release promotes an rc only when the device
// checklist, as committed, has every schema row PASS for that rc's lineage, and
// the 6a, 6b and 6c execution reviews are READY for a commit the rc only adds
// evidence to.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { gate, lint, parseChecklist } from "../release-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "checklist-required.json"), "utf8"));
const REAL = fs.readFileSync(path.join(ROOT, SCHEMA.checklist), "utf8");
const RC = "rokid-coder-v1.0.0-rc.3";
const REVIEWS = SCHEMA.reviewsDir;

const reviewFile = (name) => `${REVIEWS}${name}`;
const EXEC = {
  "6a": reviewFile("2026-11-16-plan-6a-exec-review.md"),
  "6b": reviewFile("2026-11-16-plan-6b-exec-review.md"),
  "6c": reviewFile("2026-11-17-plan-6c-exec-review.md"),
};
const review = (commit, verdict = "READY") => `# Execution review\n\nReviewed commit: ${commit}\n\nFindings: none.\n\nVERDICT: ${verdict}\n`;

/**
 * The repository the gate asks: rc.1 < rc.2 < rc.3 on one line, rc.9 on another,
 * and the review files. `changes` is what `git diff --name-only <c> <rc.3>` lists.
 */
function repo({ files = {}, changes = {} } = {}) {
  const commits = { "rokid-coder-v1.0.0-rc.1": "c1".padEnd(40, "1"), "rokid-coder-v1.0.0-rc.2": "c2".padEnd(40, "2"), [RC]: "c3".padEnd(40, "3"), "rokid-coder-v1.0.0-rc.9": "c9".padEnd(40, "9") };
  const line = [commits["rokid-coder-v1.0.0-rc.1"], commits["rokid-coder-v1.0.0-rc.2"], commits[RC]];
  const all = { ...files };
  for (const file of Object.values(EXEC)) if (!(file in all)) all[file] = review(commits[RC], "READY");
  return {
    commits,
    commitOf: (ref) => commits[ref] ?? (/^[0-9a-f]{40}$/.test(ref) ? ref : Object.values(commits).find((sha) => sha.startsWith(ref)) ?? null),
    isAncestor: (a, b) => a === b || (line.includes(a) && line.includes(b) && line.indexOf(a) <= line.indexOf(b)),
    changedFiles: (a, b) => (a === b ? [] : changes[a] ?? ["computer/src/cli.ts"]),
    readFile: (file) => all[file] ?? null,
  };
}

/** The real checklist, filled in as T13 leaves it: every required row PASS on rc.3. */
function filled({ reviews = Object.values(EXEC), testedBuild = RC, edit = (row) => row } = {}) {
  const lines = REAL.split("\n").map((line) => {
    if (line.startsWith("Tested build:")) return `Tested build: ${testedBuild}`;
    if (line.startsWith("Final reviews:")) return `Final reviews: ${reviews.join(", ")}`;
    if (line.startsWith("ROKID_RK_WINDOWS_VERIFIED:")) return "ROKID_RK_WINDOWS_VERIFIED: no";
    if (!line.startsWith("| ") || line.startsWith("| ID ")) return line;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const row = { id: cells[0], cells };
    if (cells[5] === "yes") {
      cells[6] = RC;
      cells[7] = "PASS";
    }
    const edited = edit(row);
    if (edited === null) return null;
    return `| ${edited.cells.join(" | ")} |`;
  });
  return lines.filter((line) => line !== null).join("\n");
}

const setCell = (id, index, value) => (row) => {
  if (row.id === id) row.cells[index] = value;
  return row;
};

function refuses(text, pattern, options = {}) {
  const problems = gate({ text, schema: SCHEMA, rcTag: RC, repo: options.repo ?? repo() });
  assert.ok(problems.length > 0, "the gate should refuse");
  assert.ok(problems.some((problem) => pattern.test(problem)), `expected ${pattern} in:\n${problems.join("\n")}`);
}

test("release_gate_refuses_unless_every_required_item_passes: the filled checklist passes", () => {
  assert.deepEqual(gate({ text: filled(), schema: SCHEMA, rcTag: RC, repo: repo() }), []);
});

test("release_gate_refuses_unless_every_required_item_passes: results", () => {
  refuses(filled({ edit: setCell("APPROVE-MAC-CC", 7, "") }), /APPROVE-MAC-CC .*Result is blank/);
  refuses(filled({ edit: setCell("REPLY-WIN-CX", 7, "FAIL") }), /REPLY-WIN-CX .*Result is FAIL/);
  refuses(filled({ edit: setCell("GLS-INSTALL", 7, "N/A") }), /GLS-INSTALL .*Result is N\/A/);
});

test("release_gate_refuses_unless_every_required_item_passes: the rows the schema fixes", () => {
  refuses(filled({ edit: (row) => (row.id === "ATTACH-WIN-CX" ? null : row) }), /ATTACH-WIN-CX is missing/);
  refuses(filled({ edit: (row) => (row.id === "WINS-W3" ? null : row) }), /WINS-W3 is missing/);
  refuses(filled().replace(/(\| DND-MAC-CC .*\n)/, "$1$1"), /DND-MAC-CC appears 2 times/);
  refuses(filled({ edit: setCell("EXPIRY-MAC-CX", 5, "no") }), /EXPIRY-MAC-CX .*Required is no/);
  refuses(filled({ edit: setCell("REVOKE-MAC-CC", 3, "Windows (WSL)") }), /REVOKE-MAC-CC .*Platform is Windows \(WSL\), expected macOS/);
  refuses(filled({ edit: setCell("REVOKE-WIN-CX", 4, "Claude Code") }), /REVOKE-WIN-CX .*CLI is Claude Code, expected Codex/);
  // A row the schema does not name can only be recorded, never required.
  refuses(filled({ edit: setCell("FWD-WAKE", 5, "yes") }), /FWD-WAKE is not in the schema and must be Required = no/);
});

test("release_gate_refuses_unless_every_required_item_passes: the rc lineage", () => {
  refuses(filled({ testedBuild: "rokid-coder-v1.0.0-rc.2" }), /Tested build is rokid-coder-v1\.0\.0-rc\.2, not rokid-coder-v1\.0\.0-rc\.3/);
  refuses(filled({ edit: setCell("ALERT-MAC-CC", 6, "rokid-coder-v1.0.0-rc.2") }), /ALERT-MAC-CC is a smoke row tested on rokid-coder-v1\.0\.0-rc\.2/);
  refuses(filled({ edit: setCell("INSTALL-WIN", 6, "rokid-coder-v1.0.0-rc.1") }), /INSTALL-WIN is a smoke row/);
  refuses(filled({ edit: setCell("SPEECH", 6, "rokid-coder-v1.0.0-rc.9") }), /SPEECH was tested on rokid-coder-v1\.0\.0-rc\.9, which is not an ancestor/);
  refuses(filled({ edit: setCell("SPEECH", 6, "") }), /SPEECH .*Tested on is blank/);
  // A non-smoke row carried from an earlier rc of the same line stands.
  assert.deepEqual(gate({ text: filled({ edit: setCell("SPEECH", 6, "rokid-coder-v1.0.0-rc.1") }), schema: SCHEMA, rcTag: RC, repo: repo() }), []);
});

test("release_gate_refuses_unless_every_required_item_passes: the 6b gate rows", () => {
  refuses(filled({ edit: (row) => (row.id === "MACG-M2" ? null : row) }), /MACG-M2 is missing/);
  refuses(filled({ edit: setCell("MACG-M1", 7, "") }), /MACG-M1 .*Result is blank/);
  refuses(filled({ edit: setCell("MACG-M3", 7, "FAIL") }), /MACG-M3 .*Result is FAIL/);
});

test("release_gate_refuses_unless_every_required_item_passes: the final reviews", () => {
  refuses(filled({ reviews: [EXEC["6a"], EXEC["6b"]] }), /no execution review of plan 6c/);
  const planReview = reviewFile("2026-11-15-plan-6c-review-1.md");
  refuses(filled({ reviews: [EXEC["6a"], EXEC["6b"], planReview] }), /2026-11-15-plan-6c-review-1\.md is not an execution review/, {
    repo: repo({ files: { [planReview]: review("c3".padEnd(40, "3")) } }),
  });
  const sideline = repo();
  refuses(filled(), /plan-6b-exec-review\.md reviewed c9+, which is not an ancestor/, {
    repo: repo({ files: { [EXEC["6b"]]: review(sideline.commits["rokid-coder-v1.0.0-rc.9"]) } }),
  });
  refuses(filled(), /plan-6a-exec-review\.md does not end with VERDICT: READY/, {
    repo: repo({ files: { [EXEC["6a"]]: review("c3".padEnd(40, "3"), "NOT READY") } }),
  });
  refuses(filled(), /plan-6c-exec-review\.md has no Reviewed commit/, {
    repo: repo({ files: { [EXEC["6c"]]: "# Review\n\nVERDICT: READY\n" } }),
  });
  const twice = reviewFile("2026-11-18-plan-6a-exec-review-2.md");
  refuses(filled({ reviews: [...Object.values(EXEC), twice] }), /2 execution reviews of plan 6a/, {
    repo: repo({ files: { [twice]: review("c3".padEnd(40, "3")) } }),
  });
  refuses(filled({ reviews: [EXEC["6a"], EXEC["6b"], "docs/elsewhere/plan-6c-exec-review.md"] }), /is not under docs\/coding-agent\/codex\/reviews\//);
});

test("release_gate_refuses_unless_every_required_item_passes: a code change after the last review", () => {
  const c2 = "c2".padEnd(40, "2");
  const at = (commit) => Object.fromEntries(Object.values(EXEC).map((file) => [file, review(commit)]));
  refuses(filled(), /no READY review covers the rc: every listed review is followed by a code change/, {
    repo: repo({ files: at(c2), changes: { [c2]: ["mobile/app/src/main/java/X.kt", SCHEMA.checklist] } }),
  });
  // Evidence only (the checklist and reviews) after the review: covered.
  const evidence = repo({ files: at(c2), changes: { [c2]: [SCHEMA.checklist, reviewFile("2026-11-18-note.md")] } });
  assert.deepEqual(gate({ text: filled(), schema: SCHEMA, rcTag: RC, repo: evidence }), []);
  // A fix-wave re-check of the code change, listed alongside, covers it.
  const recheck = reviewFile("2026-11-19-plan-6c-fix-wave-recheck.md");
  const rechecked = repo({ files: { ...at(c2), [recheck]: review("c3".padEnd(40, "3")) }, changes: { [c2]: ["mobile/app/src/main/java/X.kt"] } });
  assert.deepEqual(gate({ text: filled({ reviews: [...Object.values(EXEC), recheck] }), schema: SCHEMA, rcTag: RC, repo: rechecked }), []);
});

test("release_gate_refuses_unless_every_required_item_passes: the Windows launcher header", () => {
  const yes = filled().replace("ROKID_RK_WINDOWS_VERIFIED: no", "ROKID_RK_WINDOWS_VERIFIED: yes");
  refuses(yes, /ROKID_RK_WINDOWS_VERIFIED is yes, but WINS-W9 is not PASS/);
  refuses(filled().replace("ROKID_RK_WINDOWS_VERIFIED: no", "ROKID_RK_WINDOWS_VERIFIED: <yes|no>"), /ROKID_RK_WINDOWS_VERIFIED/);
});

test("release_gate_lints_the_real_checklist", () => {
  assert.deepEqual(lint(REAL, SCHEMA), []);
  const parsed = parseChecklist(REAL);
  assert.equal(parsed.header.testedBuild, "<rc tag>");
  const schemaIds = new Set(SCHEMA.rows.map((row) => row.id));
  assert.equal(schemaIds.size, SCHEMA.rows.length, "schema IDs are unique");
  for (const row of parsed.rows) assert.equal(schemaIds.has(row.id), row.required === "yes", `${row.id} required iff in the schema`);

  // The lint still holds the format: a missing column, a bad Result, a lost schema row.
  assert.match(lint(REAL.replace("| ABOUT | ", "| ABOUT2 | "), SCHEMA).join("\n"), /ABOUT is missing/);
  assert.match(lint(REAL.replace(/(\| GLS-NEWER \|(?:[^|\n]*\|){6})\s*\|/, "$1 maybe |"), SCHEMA).join("\n"), /GLS-NEWER .*Result/);
  assert.match(lint(REAL.replace("Tested build: <rc tag>", "Tested: <rc tag>"), SCHEMA).join("\n"), /Tested build/);

  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts", "release-gate.mjs"), "--lint"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("the schema is T11's required-row list, with 6b's gate rows", () => {
  const ids = SCHEMA.rows.map((row) => row.id);
  for (const item of ["ATTACH", "APPROVE", "REPLY", "ALERT", "DND", "RECONNECT", "EXPIRY", "REVOKE"]) {
    for (const p of ["MAC", "WIN"]) for (const c of ["CC", "CX"]) assert.ok(ids.includes(`${item}-${p}-${c}`), `${item}-${p}-${c}`);
  }
  assert.ok(ids.includes("LAUNCH-MAC-CC") && ids.includes("LAUNCH-MAC-CX"));
  assert.ok(!ids.includes("LAUNCH-WIN-CC") && !ids.includes("WINS-W9"), "U33 rows are not required");
  for (const id of ["MACG-M1", "MACG-M2", "MACG-M3", ...Array.from({ length: 8 }, (_, i) => `WINS-W${i + 1}`)]) assert.ok(ids.includes(id), id);
  assert.deepEqual(SCHEMA.rows.filter((row) => row.smoke).map((row) => row.id).sort(),
    ["ALERT-MAC-CC", "ALERT-MAC-CX", "ALERT-WIN-CC", "ALERT-WIN-CX", "INSTALL-MAC", "INSTALL-WIN", "PAIR-MAC", "PAIR-WIN"]);
  assert.ok(ids.includes("PLG-CODEX-ARGS") && ids.includes("PLG-LIST-JSON"), "R218 rows");
  assert.equal(ids.length, 75);
});
