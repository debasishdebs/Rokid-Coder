import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sessionKeyOf, type SessionKey } from "./protocol-v2";
import type { AgentProvider, Logger } from "./types";

export type SessionMode = "plugin" | "launcher";

export interface AttachedEntry {
  provider: AgentProvider;
  id: string;
  mode: SessionMode;
  attachedAt: number;
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

/**
 * The opt-in list: only a session recorded here sends anything to the phone,
 * gets output forwarded, or is eligible for approvals. Identity is the exact
 * (provider, id) pair; nothing is ever matched by prefix or cwd.
 */
export class AttachRegistry {
  private readonly entries = new Map<SessionKey, AttachedEntry>();
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
    try {
      this.persist();
    } catch (error) {
      // An opt-in that would silently vanish on restart is worse than a refusal.
      if (existing) {
        this.entries.set(key, existing);
      } else {
        this.entries.delete(key);
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
    try {
      this.persist();
    } catch (error) {
      // Detaching is the closed direction: apply it in memory regardless.
      this.logger?.error("attach_registry_persist_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (dropped > 0) {
      this.logger?.warn("attach_registry_corrupt", { reason: "invalid_entries", dropped });
    }
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, entries: this.list() }, null, 2)}\n`;
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
