#!/usr/bin/env node
// The product suites' verdict from their JUnit XML, for tests.yml's android job:
//
//   node scripts/check-test-results.mjs <test-results dir>...
//
// Every test must pass, except the two known GlassesFileStoreTest failures, by
// class and name. A directory with no results (a module that did not compile,
// or did not run) fails: no results is not a pass.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE = "com.anezium.rokidbus.glasses.GlassesFileStoreTest";
export const ALLOWED_FAILURES = [
  `${STORE}#a file swapped for a folder at the final boundary is not removed`,
  `${STORE}#a folder swapped for a file at the final boundary is not removed`,
];

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, entity) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ENTITIES[entity] ?? whole;
  });
const attribute = (tag, name) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]) : "";
};

/** Each testcase of a JUnit XML file: its identity and whether it failed or errored. */
function testcases(xml) {
  const out = [];
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of xml.matchAll(pattern)) {
    const id = `${attribute(match[1], "classname")}#${attribute(match[1], "name")}`;
    const body = match[3] ?? "";
    out.push({ id, failed: /<(failure|error)\b/.test(body), skipped: /<skipped\b/.test(body) });
  }
  return out;
}

export function checkResults(dirs) {
  const problems = [];
  let total = 0;
  let failed = 0;
  for (const dir of dirs) {
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".xml")) : [];
    if (files.length === 0) {
      problems.push(`${dir} has no JUnit results`);
      continue;
    }
    for (const file of files) {
      for (const testcase of testcases(fs.readFileSync(path.join(dir, file), "utf8"))) {
        total++;
        if (!testcase.failed) continue;
        failed++;
        if (!ALLOWED_FAILURES.includes(testcase.id)) problems.push(`${testcase.id} failed`);
      }
    }
  }
  return { total, failed, problems };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write("usage: check-test-results.mjs <test-results dir>...\n");
    process.exitCode = 2;
  } else {
    const { total, failed, problems } = checkResults(dirs);
    process.stdout.write(`check-test-results: ${total} tests, ${failed} failed (${ALLOWED_FAILURES.length} known failures allowed)\n`);
    for (const problem of problems) process.stderr.write(`check-test-results: ${problem}\n`);
    process.exitCode = problems.length ? 1 : 0;
  }
}
