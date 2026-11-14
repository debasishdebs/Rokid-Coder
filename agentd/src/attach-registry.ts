import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPidAlive } from "./launcher/claude-sessions";
import { sessionKeyOf, type SessionKey } from "./protocol-v2";
import type { AgentProvider, Logger } from "./types";

export type SessionMode = "plugin" | "launcher";

export interface AttachedEntry {
  provider: AgentProvider;
  id: string;
  mode: SessionMode;
  attachedAt: number;
}

/**
 * `/rokid:off` for a Claude session (R51). No launcher may bind `key` while
 * the entry holds; `/rokid:on` for the session clears it. An entry made while
 * no launcher held the session has no launcher yet: the first launcher that
 * proves it owns the session adopts it (and is refused), and from then on the
 * entry lasts while that launcher's `childPid` lives.
 */
export interface ExplicitDetach {
  key: SessionKey;
  launcherId?: string;
  childPid?: number;
}

export interface AttachChange {
  kind: "attached" | "detached";
  entry: AttachedEntry;
}

export type AttachChangeListener = (change: AttachChange) => void;

/** Thrown by a gated read path when the session has not been opted in. */
export class NotAttachedError extends Error {
  constructor() {
    super("not_attached");
    this.name = "NotAttachedError";
  }
}

const FILE_VERSION = 1;

function isProvider(value: unknown): value is AgentProvider {
  return value === "claude" || value === "codex";
}

function isMode(value: unknown): value is SessionMode {
  return value === "plugin" || value === "launcher";
}

function parseEntry(value: unknown): AttachedEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !isProvider(record.provider) ||
    typeof record.id !== "string" ||
    record.id.length === 0 ||
    !isMode(record.mode) ||
    typeof record.attachedAt !== "number" ||
    !Number.isFinite(record.attachedAt)
  ) {
    return undefined;
  }
  return {
    provider: record.provider,
    id: record.id,
    mode: record.mode,
    attachedAt: record.attachedAt,
  };
}

function parseExplicitDetach(value: unknown): ExplicitDetach | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || !/^(claude|codex):./.test(record.key)) {
    return undefined;
  }
  if (record.launcherId === undefined && record.childPid === undefined) {
    return { key: record.key as SessionKey };
  }
  if (
    typeof record.launcherId !== "string" ||
    record.launcherId.length === 0 ||
    !Number.isInteger(record.childPid) ||
    (record.childPid as number) <= 0
  ) {
    return undefined;
  }
  return { key: record.key as SessionKey, launcherId: record.launcherId, childPid: record.childPid as number };
}

/**
 * The opt-in list: only a session recorded here sends anything to the phone,
 * gets output forwarded, or is eligible for approvals. Identity is the exact
 * (provider, id) pair; nothing is ever matched by prefix or cwd.
 */
export class AttachRegistry {
  private readonly entries = new Map<SessionKey, AttachedEntry>();
  private readonly explicitDetaches = new Map<SessionKey, ExplicitDetach>();
  private readonly listeners = new Set<AttachChangeListener>();
  private readonly file: string;
  private readonly now: () => number;
  private readonly logger?: Logger;

  constructor(options: { file: string; now?: () => number; logger?: Logger }) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
    this.load();
  }

  attach(provider: AgentProvider, id: string, mode: SessionMode): void {
    if (!isProvider(provider) || typeof id !== "string" || id.length === 0 || !isMode(mode)) {
      throw new Error("attach requires a provider, a non-empty session id and a mode");
    }
    const key = sessionKeyOf(provider, id);
    const existing = this.entries.get(key);
    if (existing?.mode === mode) {
      return;
    }
    const entry: AttachedEntry = {
      provider,
      id,
      mode,
      attachedAt: existing?.attachedAt ?? this.now(),
    };
    this.entries.set(key, entry);
    // Opting back in is what ends an explicit detach.
    const detached = this.explicitDetaches.get(key);
    this.explicitDetaches.delete(key);
    try {
      this.persist();
    } catch (error) {
      // An opt-in that would silently vanish on restart is worse than a refusal.
      if (existing) {
        this.entries.set(key, existing);
      } else {
        this.entries.delete(key);
      }
      if (detached) {
        this.explicitDetaches.set(key, detached);
      }
      throw error;
    }
    this.emit({ kind: "attached", entry: { ...entry } });
  }

  detach(provider: AgentProvider, id: string): void {
    const key = sessionKeyOf(provider, id);
    const entry = this.entries.get(key);
    if (!entry) {
      return;
    }
    this.entries.delete(key);
    // Saved with the detach itself, so a launcher that reconnects later (even
    // after a restart) cannot bind the session back in. The launcher hub adds
    // the launcher's identity when one holds the session. Codex sessions are
    // never launcher-bound (R133).
    if (provider === "claude" && !this.explicitDetaches.has(key)) {
      this.explicitDetaches.set(key, { key });
    }
    // Detaching is the closed direction: apply it in memory regardless.
    this.persistOrLog();
    this.emit({ kind: "detached", entry: { ...entry } });
  }

  isAttached(provider: AgentProvider, id: string): boolean {
    return this.entries.has(sessionKeyOf(provider, id));
  }

  mode(provider: AgentProvider, id: string): SessionMode | undefined {
    return this.entries.get(sessionKeyOf(provider, id))?.mode;
  }

  list(): AttachedEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  /** Records an explicit detach. Like detach, it holds in memory even if it cannot be saved. */
  recordExplicitDetach(entry: ExplicitDetach): void {
    this.explicitDetaches.set(entry.key, { ...entry });
    this.persistOrLog();
  }

  explicitDetach(key: SessionKey): ExplicitDetach | undefined {
    const entry = this.explicitDetaches.get(key);
    return entry ? { ...entry } : undefined;
  }

  dropExplicitDetach(key: SessionKey): void {
    if (this.explicitDetaches.delete(key)) {
      this.persistOrLog();
    }
  }

  /**
   * Startup: launcher mode exists only with a live binding, and no launcher is
   * connected yet, so every launcher session is plugin until its launcher
   * rebinds. Explicit detaches whose launcher child is gone are dropped, and so
   * are unadopted ones whose session no live Claude is running (`isSessionLive`;
   * without it they are kept). No change events: nothing is listening yet, and
   * nothing was attached or detached.
   */
  reconcileLaunchers(
    options: { isAlive?: (pid: number) => boolean; isSessionLive?: (key: SessionKey) => boolean } = {},
  ): void {
    const isAlive = options.isAlive ?? isPidAlive;
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.mode === "launcher") {
        this.entries.set(key, { ...entry, mode: "plugin" });
        changed = true;
      }
    }
    for (const [key, entry] of this.explicitDetaches) {
      const gone = entry.childPid === undefined
        ? options.isSessionLive !== undefined && !options.isSessionLive(key)
        : !isAlive(entry.childPid);
      if (gone) {
        this.explicitDetaches.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.persistOrLog();
    }
  }

  onChange(listener: AttachChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: AttachChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.logger?.error("attach_registry_listener_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("attach_registry_unreadable", {
          reason: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger?.warn("attach_registry_corrupt", { reason: "invalid_json" });
      return;
    }
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    if (!record || record.version !== FILE_VERSION || !Array.isArray(record.entries)) {
      this.logger?.warn("attach_registry_corrupt", { reason: "unexpected_shape" });
      return;
    }
    let dropped = 0;
    for (const raw of record.entries) {
      const entry = parseEntry(raw);
      if (entry) {
        this.entries.set(sessionKeyOf(entry.provider, entry.id), entry);
      } else {
        dropped += 1;
      }
    }
    const detaches = Array.isArray(record.explicitDetaches) ? record.explicitDetaches : [];
    for (const raw of detaches) {
      const entry = parseExplicitDetach(raw);
      if (entry) {
        this.explicitDetaches.set(entry.key, entry);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.logger?.warn("attach_registry_corrupt", { reason: "invalid_entries", dropped });
    }
  }

  private persistOrLog(): void {
    try {
      this.persist();
    } catch (error) {
      this.logger?.error("attach_registry_persist_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = `${JSON.stringify(
      {
        version: FILE_VERSION,
        entries: this.list(),
        explicitDetaches: [...this.explicitDetaches.values()],
      },
      null,
      2,
    )}\n`;
    try {
      writeFileSync(temp, body, { mode: 0o600 });
      renameSync(temp, this.file);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // The temp file may never have been created.
      }
      throw error;
    }
  }
}
