import { readFileSync } from "node:fs";

/**
 * A non-interactive run's answers. `pairing` takes only "skip": no key can
 * confirm a pairing, because the phone's confirm is the security step and a
 * file must never stand in for the person comparing codes (6a).
 */
export interface Answers {
  cli?: { claude?: "install" | "skip"; codex?: "install" | "skip" };
  legacy?: { retireAutostart?: boolean; removeInstallHooks?: boolean };
  pairing?: "skip";
  purge?: boolean;
}

function fail(message: string): never {
  throw new Error(`Invalid answers: ${message}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(record: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(`unknown key ${where}${key}`);
    }
  }
}

export function parseAnswers(text: string): Answers {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const root = object(value, "the file");
  onlyKeys(root, ["cli", "legacy", "pairing", "purge"], "");
  const answers: Answers = {};
  if (root.cli !== undefined) {
    const cli = object(root.cli, "cli");
    onlyKeys(cli, ["claude", "codex"], "cli.");
    answers.cli = {};
    for (const tool of ["claude", "codex"] as const) {
      if (cli[tool] !== undefined) {
        if (cli[tool] !== "install" && cli[tool] !== "skip") {
          fail(`cli.${tool} must be "install" or "skip"`);
        }
        answers.cli[tool] = cli[tool] as "install" | "skip";
      }
    }
  }
  if (root.legacy !== undefined) {
    const legacy = object(root.legacy, "legacy");
    onlyKeys(legacy, ["retireAutostart", "removeInstallHooks"], "legacy.");
    answers.legacy = {};
    for (const key of ["retireAutostart", "removeInstallHooks"] as const) {
      if (legacy[key] !== undefined) {
        if (typeof legacy[key] !== "boolean") {
          fail(`legacy.${key} must be true or false`);
        }
        answers.legacy[key] = legacy[key] as boolean;
      }
    }
  }
  if (root.pairing !== undefined) {
    if (root.pairing !== "skip") {
      fail('pairing accepts only "skip": a pairing is confirmed on the phone, never by a file');
    }
    answers.pairing = "skip";
  }
  if (root.purge !== undefined) {
    if (typeof root.purge !== "boolean") {
      fail("purge must be true or false");
    }
    answers.purge = root.purge;
  }
  return answers;
}

export function readAnswers(file: string): Answers {
  return parseAnswers(readFileSync(file, "utf8"));
}
