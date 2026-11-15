import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The marked PATH block that puts `~/.rokid-coder/bin` first, for login shells. */
export const BLOCK_BEGIN = "# >>> rokid-coder >>>";
export const BLOCK_END = "# <<< rokid-coder <<<";

export function renderBlock(): string {
  return `${BLOCK_BEGIN}\nexport PATH="$HOME/.rokid-coder/bin:$PATH"\n${BLOCK_END}\n`;
}

/** macOS: `~/.zprofile`, plus `~/.bash_profile` when the login shell is bash. WSL: `~/.profile`. */
export function profileFiles(platform: "darwin" | "wsl", home: string, shell: string | undefined): string[] {
  if (platform === "wsl") {
    return [path.join(home, ".profile")];
  }
  const files = [path.join(home, ".zprofile")];
  if (shell && path.basename(shell) === "bash") {
    files.push(path.join(home, ".bash_profile"));
  }
  return files;
}

function blockRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(BLOCK_BEGIN);
  if (start < 0) return undefined;
  const endMarker = text.indexOf(BLOCK_END, start);
  if (endMarker < 0) return undefined;
  let end = endMarker + BLOCK_END.length;
  if (text[end] === "\n") end += 1;
  return { start, end };
}

/** The block as it is in `file` now, or null when the file has none. */
export function readBlock(file: string): string | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  const range = blockRange(text);
  return range ? text.slice(range.start, range.end) : null;
}

/** Replaces, appends or (with null) removes the block; everything else in the file stays as it was. */
export function writeBlock(file: string, block: string | null): void {
  const existed = existsSync(file);
  const text = existed ? readFileSync(file, "utf8") : "";
  const range = blockRange(text);
  let next: string;
  if (range) {
    next = text.slice(0, range.start) + (block ?? "") + text.slice(range.end);
  } else if (block === null) {
    return;
  } else {
    next = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${block}`;
  }
  if (!existed && next === "") return;
  const temp = `${file}.rokid-${process.pid}.tmp`;
  writeFileSync(temp, next, { mode: existed ? statSync(file).mode & 0o777 : 0o644 });
  renameSync(temp, file);
}
