#!/usr/bin/env node
// Fails when a document carries something that must never be published: a full
// certificate fingerprint, a token or steering-secret value, or a pairing line with a
// real-looking host. Findings name the file, line and rule, never the matched text.
//
//   node scripts/check-docs-secrets.mjs [file ...]
//
// With no arguments it scans the install guides, the privacy note, the About strings,
// the device checklist, the release notes and everything under docs/coding-agent.
// gradle.properties is deliberately not scanned: rokid.releaseSignerSha256 is a public
// certificate digest, not a pairing fingerprint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".md", ".json", ".txt", ".xml", ".yml", ".yaml"]);

const HEX = "[0-9a-fA-F]";
const HEX64 = new RegExp(`(?<!${HEX})${HEX}{64}(?!${HEX})`);
const COLON_FINGERPRINT = new RegExp(`(?<!${HEX}:)(?<!${HEX})(?:${HEX}{2}:){31}${HEX}{2}(?!:?${HEX})`);
// "token": "value" and "steer": "value" (JSON or JSON-like), any non-placeholder value.
const SECRET_VALUE = /"(?:token|steer)"\s*:\s*"([^"]*)"/gi;
// A pairing line is a small JSON object with "v": 1 or 2 and a "host".
const PAIRING_LINE = /\{[^{}]*"v"\s*:\s*[12]\b[^{}]*\}/g;
const HOST_FIELD = /"host"\s*:\s*"([^"]*)"/;

function isPlaceholder(value) {
  const v = value.trim();
  return v === "" || /^[<\[{$%].*/.test(v) || /^(?:\.{2,}|…|x{3,}|redacted|todo|none)$/i.test(v) || /^[A-Z][A-Z0-9-]*-[A-Z0-9-]+$/.test(v);
}

function isDocumentationHost(host) {
  return (
    /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(host) ||
    /(?:^|\.)example(?:\.com|\.org|\.net)?$/i.test(host) ||
    /\.(?:test|invalid|example|localhost)$/i.test(host)
  );
}

function isRealLookingHost(host) {
  if (isPlaceholder(host) || isDocumentationHost(host)) return false;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(host) || /^[0-9a-f:]*:[0-9a-f:]+$/i.test(host);
}

/** Findings for one text: `{file, line, rule}`. The matched text is never part of a finding. */
export function scanText(text, file = "<text>") {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const at = (rule) => findings.push({ file, line: index + 1, rule });
    if (HEX64.test(line)) at("hex64");
    if (COLON_FINGERPRINT.test(line)) at("colon-fingerprint");
    for (const match of line.matchAll(SECRET_VALUE)) {
      if (!isPlaceholder(match[1])) at("secret-value");
    }
  });
  // Pairing lines are matched across the whole text, so one split over lines is still caught.
  for (const match of text.matchAll(PAIRING_LINE)) {
    const host = HOST_FIELD.exec(match[0])?.[1];
    if (host !== undefined && isRealLookingHost(host)) {
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file, line, rule: "pairing-line" });
    }
  }
  return findings;
}

/** Scans files; `root` (optional) makes the reported paths relative. Unreadable files are findings. */
export function scanFiles(files, root = process.cwd()) {
  const findings = [];
  for (const file of files) {
    const shown = path.relative(root, file).split(path.sep).join("/") || file;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      findings.push({ file: shown, line: 0, rule: "unreadable" });
      continue;
    }
    findings.push(...scanText(text, shown));
  }
  return findings;
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** The files this check covers by default, as absolute paths. */
export function defaultTargets(root) {
  const named = [
    "PRIVACY.md",
    "README.md",
    "computer/README.md",
    "plugin/README.md",
    "mobile/README.md",
    "glasses/README.md",
    "mobile/app/src/main/res/values/strings_about.xml",
  ].map((p) => path.join(root, p));
  const docs = path.join(root, "docs", "coding-agent");
  const all = [...named, ...(fs.existsSync(docs) ? walk(docs) : [])];
  return [...new Set(all)].sort();
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = argv.length > 0 ? argv.map((p) => path.resolve(p)) : defaultTargets(root);
  const findings = scanFiles(files, root);
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}`);
  if (findings.length > 0) {
    console.error(`check-docs-secrets: ${findings.length} finding(s). Remove the value or replace it with a placeholder.`);
    return 1;
  }
  console.log(`check-docs-secrets: ${files.length} files clean`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
