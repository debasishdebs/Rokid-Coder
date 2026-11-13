import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./types";

const FILE_VERSION = 1;

/**
 * Message-id dedup for phone steering frames: a msgId that was applied once is
 * acknowledged as a duplicate afterwards, including across an agentd restart.
 * Entries older than the retention window are dropped.
 */
export class AppliedIds {
  private readonly ids = new Map<string, number>();
  private readonly file: string;
  private readonly retentionMs: number;
  private readonly now: () => number;
  private readonly logger?: Logger;

  constructor(file: string, retentionMs: number, now: () => number = Date.now, logger?: Logger) {
    this.file = file;
    this.retentionMs = retentionMs;
    this.now = now;
    this.logger = logger;
    this.load();
  }

  seen(msgId: string): boolean {
    const recordedAt = this.ids.get(msgId);
    return recordedAt !== undefined && !this.expired(recordedAt, this.now());
  }

  record(msgId: string): void {
    const t = this.now();
    const existing = this.ids.get(msgId);
    if (existing !== undefined && !this.expired(existing, t)) {
      return;
    }
    this.ids.set(msgId, t);
    this.prune(t);
    try {
      this.persist();
    } catch (error) {
      // The in-memory record still dedups within this process; only a restart can forget it.
      this.logger?.error("applied_ids_persist_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private expired(recordedAt: number, t: number): boolean {
    return t - recordedAt >= this.retentionMs;
  }

  private prune(t: number): void {
    for (const [id, recordedAt] of this.ids) {
      if (this.expired(recordedAt, t)) {
        this.ids.delete(id);
      }
    }
  }

  private load(): void {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("applied_ids_unreadable", {
          reason: (error as NodeJS.ErrnoException).code ?? "unknown",
        });
      }
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.logger?.warn("applied_ids_corrupt", { reason: "invalid_json" });
      return;
    }
    const record = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
    const ids = record?.ids;
    if (
      !record ||
      record.version !== FILE_VERSION ||
      !ids ||
      typeof ids !== "object" ||
      Array.isArray(ids)
    ) {
      this.logger?.warn("applied_ids_corrupt", { reason: "unexpected_shape" });
      return;
    }
    let dropped = 0;
    for (const [id, recordedAt] of Object.entries(ids)) {
      if (typeof recordedAt === "number" && Number.isFinite(recordedAt)) {
        this.ids.set(id, recordedAt);
      } else {
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.logger?.warn("applied_ids_corrupt", { reason: "invalid_entries", dropped });
    }
    this.prune(this.now());
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, ids: Object.fromEntries(this.ids) }, null, 2)}\n`;
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
