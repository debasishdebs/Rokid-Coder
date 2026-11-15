import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { normalizeFingerprint } from "../tls";

/** How long a phone that was handed credentials has to prove it stored them. */
export const PROVISIONAL_PIN_MS = 10 * 60 * 1000;
const VERSION = 4;

export interface ProvisionalPin {
  fp: string;
  addedAt: number;
  lastUsedAt: number;
  state: "provisional";
  attempt: string;
  provisionalUntil: number;
}

function writePrivate(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  rmSync(temp, { force: true });
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

/**
 * The phones agentd sent credentials to but has not yet heard store them
 * (6a-R4′, step 1): kept on disk, beside the durable pins and never in them,
 * so nothing that admits a normal link can mistake one for a pin. A pin here
 * becomes durable only by `pair_committed`, by a recovery hello that carries
 * the token and the steering secret, or by a PhoneLink commit proof; after
 * `provisionalUntil` it is purged. Entries use the PinStore v4 shape.
 *
 * Like PinStore, every read looks at the file again (the CLI edits it too),
 * and an unreadable file throws rather than reading as empty.
 */
export class ProvisionalPins {
  private memory = new Map<string, ProvisionalPin>();

  constructor(
    private readonly file?: string,
    private readonly options: { writeFile?: (file: string, content: string) => void } = {},
  ) {}

  /** Live (not yet expired) provisional pin for `fp`, if any. */
  get(fp: string, now: number): ProvisionalPin | undefined {
    const normalized = normalizeFingerprint(fp);
    const entry = normalized === undefined ? undefined : this.read().get(normalized);
    return entry && entry.provisionalUntil > now ? entry : undefined;
  }

  entries(): ProvisionalPin[] {
    return [...this.read().values()];
  }

  add(fp: string, attempt: string, now: number, ttlMs: number = PROVISIONAL_PIN_MS): ProvisionalPin {
    const normalized = normalizeFingerprint(fp);
    if (!normalized) {
      throw new Error("not a SHA-256 certificate fingerprint");
    }
    const next = new Map(this.read());
    const entry: ProvisionalPin = {
      fp: normalized,
      addedAt: now,
      lastUsedAt: now,
      state: "provisional",
      attempt,
      provisionalUntil: now + ttlMs,
    };
    next.set(normalized, entry);
    this.write(next);
    return entry;
  }

  remove(fp: string): boolean {
    const normalized = normalizeFingerprint(fp);
    const current = this.read();
    if (normalized === undefined || !current.has(normalized)) {
      return false;
    }
    const next = new Map(current);
    next.delete(normalized);
    this.write(next);
    return true;
  }

  /** Every entry whose fingerprint starts with `prefix` (as `phones forget` takes it); returns them. */
  forget(prefix: string): string[] {
    const wanted = prefix.replace(/:/g, "").toUpperCase();
    const current = this.read();
    const hits = [...current.keys()].filter((fp) => fp.replace(/:/g, "").startsWith(wanted));
    if (hits.length > 0) {
      const next = new Map(current);
      for (const hit of hits) {
        next.delete(hit);
      }
      this.write(next);
    }
    return hits;
  }

  forgetAll(): void {
    if (this.read().size > 0) {
      this.write(new Map());
    }
  }

  /** Purges what ran past `provisionalUntil`; returns the fingerprints. */
  expire(now: number): string[] {
    const current = this.read();
    const gone = [...current.values()].filter((entry) => entry.provisionalUntil <= now).map((entry) => entry.fp);
    if (gone.length > 0) {
      const next = new Map(current);
      for (const fp of gone) {
        next.delete(fp);
      }
      this.write(next);
    }
    return gone;
  }

  private read(): Map<string, ProvisionalPin> {
    if (!this.file) {
      return this.memory;
    }
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Map();
      }
      throw new Error(`Cannot read provisional phone pins at ${this.file}: ${(error as Error).message}`);
    }
    const record = JSON.parse(text) as { version?: unknown; phones?: unknown };
    if (!record || record.version !== VERSION || !Array.isArray(record.phones)) {
      throw new Error(`Invalid provisional phone pins file at ${this.file}`);
    }
    const map = new Map<string, ProvisionalPin>();
    for (const item of record.phones as Array<Record<string, unknown>>) {
      const fp = typeof item?.fp === "string" ? normalizeFingerprint(item.fp) : undefined;
      if (
        !fp ||
        item.state !== "provisional" ||
        typeof item.attempt !== "string" ||
        typeof item.addedAt !== "number" ||
        typeof item.lastUsedAt !== "number" ||
        typeof item.provisionalUntil !== "number"
      ) {
        throw new Error(`Invalid provisional phone pins file at ${this.file}`);
      }
      map.set(fp, {
        fp,
        addedAt: item.addedAt,
        lastUsedAt: item.lastUsedAt,
        state: "provisional",
        attempt: item.attempt,
        provisionalUntil: item.provisionalUntil,
      });
    }
    return map;
  }

  private write(next: Map<string, ProvisionalPin>): void {
    if (!this.file) {
      this.memory = next;
      return;
    }
    (this.options.writeFile ?? writePrivate)(
      this.file,
      `${JSON.stringify({ version: VERSION, phones: [...next.values()] }, null, 2)}\n`,
    );
  }
}
