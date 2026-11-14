import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** What agentd reads from `~/.claude/sessions/<pid>.json`, which Claude itself writes. */
export interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  status: "idle" | "busy" | string;
  statusUpdatedAt?: number;
}

/** Claude's own files are a few hundred bytes; anything far larger is not one. */
const MAX_SESSION_FILE_BYTES = 64 * 1024;

/** `ROKID_CLAUDE_SESSIONS_DIR` (tests) or `<claudeDir>/sessions`. */
export function claudeSessionsDir(claudeDir = path.join(homedir(), ".claude")): string {
  return process.env.ROKID_CLAUDE_SESSIONS_DIR || path.join(claudeDir, "sessions");
}

function isPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function readBounded(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(MAX_SESSION_FILE_BYTES + 1);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    return length > MAX_SESSION_FILE_BYTES ? undefined : buffer.toString("utf8", 0, length);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * Reads the sessions file Claude keeps for `pid`. A file whose own pid is not
 * the one it is named for is not trusted as that process's session.
 */
export function readClaudeSession(dir: string, pid: number): ClaudeSessionFile | undefined {
  if (!isPid(pid)) {
    return undefined;
  }
  const text = readBounded(path.join(dir, `${pid}.json`));
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.pid !== pid ||
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    typeof record.status !== "string"
  ) {
    return undefined;
  }
  return {
    pid,
    sessionId: record.sessionId,
    status: record.status,
    ...(typeof record.statusUpdatedAt === "number" && Number.isFinite(record.statusUpdatedAt)
      ? { statusUpdatedAt: record.statusUpdatedAt }
      : {}),
  };
}

/**
 * `rootPid` and every process below it, breadth-first, so the nearest come
 * first. When `ps` cannot be read the tree is unknown and this is empty:
 * nothing can then be proven to be the launcher's.
 */
export function descendantPids(rootPid: number): number[] {
  if (!isPid(rootPid)) {
    return [];
  }
  let output: string;
  try {
    output = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const list = children.get(ppid);
    if (list) {
      list.push(pid);
    } else {
      children.set(ppid, [pid]);
    }
  }
  const seen = new Set<number>([rootPid]);
  const order = [rootPid];
  for (let index = 0; index < order.length; index += 1) {
    for (const child of children.get(order[index]) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        order.push(child);
      }
    }
  }
  return order;
}

/** The session file of the process nearest `rootPid` in its own tree, if any. */
export function findOwnedClaudeSession(dir: string, rootPid: number): ClaudeSessionFile | undefined {
  for (const pid of descendantPids(rootPid)) {
    const session = readClaudeSession(dir, pid);
    if (session) {
      return session;
    }
  }
  return undefined;
}

/**
 * The session ids that a live Claude process names in its sessions file. An
 * absent dir means no Claude is running; any other read error is undefined,
 * since then nothing is known.
 */
export function liveClaudeSessionIds(dir: string): Set<string> | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Set() : undefined;
  }
  const ids = new Set<string>();
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    const pid = match ? Number(match[1]) : 0;
    const session = pid > 0 && isPidAlive(pid) ? readClaudeSession(dir, pid) : undefined;
    if (session) {
      ids.add(session.sessionId);
    }
  }
  return ids;
}

/** True only for a process this user can signal; EPERM (another user's) is not ours. */
export function isPidAlive(pid: number): boolean {
  if (!isPid(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
