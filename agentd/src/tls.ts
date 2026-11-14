import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeSync,
} from "node:fs";
import path from "node:path";
import { generate } from "selfsigned";
import { defaultRokidCoderStateDir } from "./config";
import type { Logger } from "./types";

const CERT_COMMON_NAME = "rokid-coder-agentd";
const CERT_VALID_DAYS = 3650;
const PINS_VERSION = 3;
/** A phone whose pairing goes unused for this long must pair again; the phone's settings may change it. */
export const DEFAULT_PAIRING_TTL_DAYS = 14;
export const DAY_MS = 24 * 60 * 60 * 1000;
/** `touch` writes a phone's last use at most this often. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/** How long `phones allow-next` leaves the door open for one more phone. */
export const ALLOW_NEXT_WINDOW_MS = 2 * 60 * 1000;
const CERT_LOCK_STALE_MS = 30_000;
const CERT_LOCK_WAIT_MS = 10_000;

export interface AgentCert {
  key: string;
  cert: string;
  /** SHA-256 of the DER certificate, colon-separated upper-case hex (what a phone pins). */
  fingerprint256: string;
}

export function defaultTlsDir(): string {
  return path.join(defaultRokidCoderStateDir(), "tls");
}

export function fingerprintOfCert(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

/** Enough of a fingerprint to tell two apart in a log, never enough to be the pin itself. */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, "").slice(0, 12).toLowerCase();
}

/** The first 16 hex digits, as `phones list` writes them: what a person compares with the phone's own screen. */
export function pinnedFingerprint(fingerprint: string): string {
  return fingerprint.replace(/:/g, "").slice(0, 16).toUpperCase();
}

/** Normalises a fingerprint to the form `fingerprint256` uses, or undefined if it is not one. */
export function normalizeFingerprint(value: string): string | undefined {
  const hex = value.replace(/:/g, "").toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(":") : undefined;
}

function certFiles(dir: string): { keyFile: string; certFile: string } {
  return { keyFile: path.join(dir, "agentd.key"), certFile: path.join(dir, "agentd.crt") };
}

/** Temp-and-rename, owner-only, flushed to disk before it replaces anything. */
function writePrivate(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  // A stale temp file would keep its old mode: `mode` applies only on create.
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

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** The cert already on disk, or undefined when none has been generated yet. */
export function loadAgentCert(dir: string = defaultTlsDir()): AgentCert | undefined {
  const { keyFile, certFile } = certFiles(dir);
  if (!existsSync(keyFile) || !existsSync(certFile)) {
    return undefined;
  }
  const cert = readFileSync(certFile, "utf8");
  return { key: readFileSync(keyFile, "utf8"), cert, fingerprint256: fingerprintOfCert(cert) };
}

/**
 * agentd's own TLS identity: generated once with `selfsigned` (CN
 * rokid-coder-agentd, ten years) and kept, so the fingerprint a phone pinned
 * from the pairing payload stays valid across restarts. Async because
 * selfsigned 5 is async-only.
 */
export async function ensureAgentCert(dir: string = defaultTlsDir()): Promise<AgentCert> {
  const existing = loadAgentCert(dir);
  if (existing) {
    return existing;
  }
  privateDir(dir);
  // `pair` and a first-run daemon can start together; one generates, the other
  // waits for its files, so a key is never paired with the other's cert.
  const lock = path.join(dir, "agentd.lock");
  const deadline = Date.now() + CERT_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const winner = loadAgentCert(dir);
      if (winner) {
        return winner;
      }
      try {
        if (Date.now() - statSync(lock).mtimeMs > CERT_LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
        }
      } catch {
        // The holder just finished; look again.
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for another agentd to create ${dir}/agentd.crt`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    const raced = loadAgentCert(dir);
    if (raced) {
      return raced;
    }
    const pems = await generate([{ name: "commonName", value: CERT_COMMON_NAME }], {
      algorithm: "sha256",
      keySize: 2048,
      notBeforeDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      notAfterDate: new Date(Date.now() + CERT_VALID_DAYS * 24 * 60 * 60 * 1000),
    });
    const { keyFile, certFile } = certFiles(dir);
    // Key first, cert last: loadAgentCert needs both, so nobody sees half a pair.
    writePrivate(keyFile, pems.private);
    writePrivate(certFile, pems.cert);
    return { key: pems.private, cert: pems.cert, fingerprint256: fingerprintOfCert(pems.cert) };
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

// ---- the steering secret ----

function steerFile(dir: string): string {
  return path.join(dir, "steer.secret");
}

/**
 * The file's bytes and a signature of exactly those bytes, from one open file:
 * stat before read, so the bytes are at least as new as the stat, and the hash
 * catches a same-size rewrite that keeps the inode and the mtime tick.
 * Undefined when there is no file.
 */
function readSnapshot(file: string): { bytes: Buffer; signature: string } | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    const bytes = readFileSync(fd);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { bytes, signature: `${stat.ino}:${bytes.length}:${stat.mtimeMs}:${hash}` };
  } finally {
    closeSync(fd);
  }
}

/**
 * The secret a wss phone must present, with the token, to steer. Undefined
 * until one is made. Read from the file on every steering check: it is 44
 * bytes, and a cache is how a rotation gets missed.
 */
export function readSteerSecret(dir: string = defaultTlsDir()): string | undefined {
  try {
    const text = readFileSync(steerFile(dir), "utf8").trim();
    return text.length >= 32 ? text : undefined;
  } catch {
    return undefined;
  }
}

export function steerSecretFile(dir: string = defaultTlsDir()): string {
  return steerFile(dir);
}

/**
 * Made once, 32 random bytes, and only ever shown in the pairing payload. agentd
 * never sends it on any socket: the token is the credential a plaintext link can
 * see, so it cannot also be the one that grants steering.
 */
export function ensureSteerSecret(dir: string = defaultTlsDir()): string {
  return readSteerSecret(dir) ?? rotateSteerSecret(dir);
}

export function rotateSteerSecret(dir: string = defaultTlsDir()): string {
  privateDir(dir);
  const secret = randomBytes(32).toString("base64url");
  writePrivate(steerFile(dir), `${secret}\n`);
  return secret;
}

/** The digest a connection keeps of the secret it presented, so the secret itself is not held. */
export function secretDigest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time compare that is safe for unequal lengths. */
export function secretMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(secretDigest(received), secretDigest(expected));
}

/** True when `digest` is the digest of `expected`: the live check for a connection admitted earlier. */
export function digestMatchesSecret(digest: Buffer, expected: string | undefined): boolean {
  return expected !== undefined && expected.length > 0 && timingSafeEqual(digest, secretDigest(expected));
}

/**
 * Calls `onChange` when any of `files` may have changed: `fs.watch` on each
 * parent directory for promptness, and a poll for platforms or edits it
 * misses. Returns a function that stops both.
 */
export function watchFiles(files: string[], intervalMs: number, onChange: () => void): () => void {
  const watchers = [...new Set(files.map((file) => path.dirname(file)))].flatMap((dir) => {
    try {
      const watcher = watch(dir, (_event, name) => {
        if (name === null || files.some((file) => path.basename(file) === name.toString())) {
          onChange();
        }
      });
      watcher.on("error", () => undefined);
      return [watcher];
    } catch {
      return [];
    }
  });
  const timer = setInterval(onChange, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
    for (const watcher of watchers) {
      watcher.close();
    }
  };
}

export interface PinEntry {
  /** Normalised fingerprint. */
  fp: string;
  addedAt: number;
  lastUsedAt: number;
}

/**
 * The set of phone certificates agentd trusts, by `fingerprint256`. A phone is
 * its cert, wherever it is dialled from, so an IP change needs nothing.
 *
 * Each pin remembers when the phone was added and last used, and a pairing
 * unused for the TTL is forgotten (`expire`, and `isTrusted` on the spot, so a
 * phone cannot renew itself between sweeps).
 *
 * Trust on first use applies only at first-ever setup, while there is no pin
 * file at all, or inside the window `phones allow-next` opens for one more
 * phone. Anything else is refused, including after every phone was forgotten:
 * an empty set is not a fresh install, or the phone just forgotten (or whoever
 * answered in its place) would be trusted again on its own. Deleting the tls
 * dir is the factory reset.
 *
 * The CLI edits the same file the daemon uses, so every read looks at the file
 * again; a file that cannot be read throws rather than reading as empty. A
 * change is kept only once it is on disk.
 */
export class PinStore {
  private phones = new Map<string, PinEntry>();
  private allowNextUntil = 0;
  private pinnedBefore = false;
  /** True while what was read differs from the file (an older format, or a time in the future), until the next write. */
  private needsWrite = false;
  private signature: string | undefined;
  private readonly writeFile: (file: string, content: string) => void;
  private readonly clock: () => number;
  private readonly logger?: Logger;

  /** Without a file the set lives only as long as the process. `writeFile` and `now` are for tests. */
  constructor(
    private readonly file?: string,
    options: { writeFile?: (file: string, content: string) => void; now?: () => number; logger?: Logger } = {},
  ) {
    this.writeFile = options.writeFile ?? writePrivate;
    this.clock = options.now ?? Date.now;
    this.logger = options.logger;
    this.reload();
  }

  /** The backing file, for watchers; undefined for a store that lives only in memory. */
  get filePath(): string | undefined {
    return this.file;
  }

  list(): string[] {
    this.reload();
    return [...this.phones.keys()];
  }

  /** Each pinned phone with when it was added and last used (never later than now). */
  entries(): PinEntry[] {
    this.reload();
    const now = this.clock();
    return [...this.phones.values()].map((entry) => ({
      fp: entry.fp,
      addedAt: entry.addedAt,
      lastUsedAt: Math.min(entry.lastUsedAt, now),
    }));
  }

  /** Pinned, whether or not stale. For the CLI; admission and trust checks use `isTrusted`. */
  has(fp: string): boolean {
    this.reload();
    const normalized = normalizeFingerprint(fp);
    return normalized !== undefined && this.phones.has(normalized);
  }

  /**
   * Pinned and used within `ttlMs`. A stale entry is forgotten on the spot,
   * so a phone whose pairing has run out cannot reconnect and renew itself
   * before the next sweep. Throws when the file cannot be read or written.
   */
  isTrusted(fp: string, now: number, ttlMs: number): boolean {
    this.reload();
    this.clampToNow(now);
    const normalized = normalizeFingerprint(fp);
    const entry = normalized === undefined ? undefined : this.phones.get(normalized);
    if (!entry) {
      return false;
    }
    if (!isStale(entry, now, ttlMs)) {
      return true;
    }
    this.expire(now, ttlMs);
    return false;
  }

  /**
   * Records that the phone was used, at most once an hour per phone. Called
   * only after the phone was admitted; an unpinned fingerprint is ignored.
   */
  touch(fp: string, now: number): void {
    this.reload();
    this.clampToNow(now);
    const normalized = normalizeFingerprint(fp);
    const entry = normalized === undefined ? undefined : this.phones.get(normalized);
    if (!entry) {
      return;
    }
    if (!this.needsWrite && now >= entry.lastUsedAt && now - entry.lastUsedAt < TOUCH_INTERVAL_MS) {
      return;
    }
    const next = new Map(this.phones);
    next.set(entry.fp, { ...entry, lastUsedAt: now });
    this.commit(next, this.allowNextUntil, this.pinnedBefore);
  }

  /**
   * Forgets every phone unused for `ttlMs`; returns their fingerprints. Also
   * writes back what was migrated from an older file format or corrected on read.
   */
  expire(now: number, ttlMs: number): string[] {
    this.reload();
    this.clampToNow(now);
    const gone = [...this.phones.values()].filter((entry) => isStale(entry, now, ttlMs));
    if (gone.length === 0 && !this.needsWrite) {
      return [];
    }
    const remaining = new Map(this.phones);
    for (const entry of gone) {
      remaining.delete(entry.fp);
    }
    this.commit(remaining, this.allowNextUntil, this.pinnedBefore);
    for (const entry of gone) {
      this.logger?.info("phone_pairing_expired", {
        fingerprint: shortFingerprint(entry.fp),
        unused_days: Math.floor((now - Math.min(entry.lastUsedAt, now)) / DAY_MS),
      });
    }
    return gone.map((entry) => entry.fp);
  }

  /**
   * A last use in the future means the clock went back since it was recorded.
   * It counts as now from here on, and the correction is written once, so an
   * unused pairing never gains the rolled-back time as extra life.
   */
  private clampToNow(now: number): void {
    let changed = false;
    for (const entry of this.phones.values()) {
      if (entry.lastUsedAt > now) {
        entry.lastUsedAt = now;
        changed = true;
      }
    }
    // Also what `reload` corrected or migrated: written once, then no longer pending.
    if (changed || this.needsWrite) {
      this.commit(new Map(this.phones), this.allowNextUntil, this.pinnedBefore);
    }
  }

  isEmpty(): boolean {
    this.reload();
    return this.phones.size === 0;
  }

  /** True once setup has begun (a pin file exists), even if every phone was forgotten since. */
  everPinned(): boolean {
    this.reload();
    return this.pinnedBefore;
  }

  add(fp: string, now: number = this.clock()): void {
    const normalized = normalizeFingerprint(fp);
    if (!normalized) {
      throw new Error("not a SHA-256 certificate fingerprint");
    }
    this.reload();
    // A phone admitted through the empty set used up an open window too.
    const next = new Map(this.phones);
    next.set(normalized, { fp: normalized, addedAt: this.phones.get(normalized)?.addedAt ?? now, lastUsedAt: now });
    this.commit(next, 0, true);
  }

  /** Removes the phone whose fingerprint is `fp` or starts with it; returns what was removed. */
  forget(fp: string): string[] {
    this.reload();
    const wanted = fp.replace(/:/g, "").toUpperCase();
    if (wanted.length < 8 || !/^[0-9A-F]+$/.test(wanted)) {
      throw new Error("give at least 8 hex digits of the fingerprint");
    }
    const hits = [...this.phones.keys()].filter((phone) => phone.replace(/:/g, "").startsWith(wanted));
    if (hits.length > 1) {
      throw new Error("that matches more than one phone; give more of the fingerprint");
    }
    if (hits.length > 0) {
      const remaining = new Map(this.phones);
      for (const hit of hits) {
        remaining.delete(hit);
      }
      this.commit(remaining, this.allowNextUntil, this.pinnedBefore);
    }
    return hits;
  }

  /** Empties the set. Not a fresh install: a new phone then needs `phones allow-next`. */
  forgetAll(): void {
    this.reload();
    this.commit(new Map(), 0, this.pinnedBefore);
  }

  /** Lets one more unknown phone be trusted on first use until `now` + the window. */
  armAllowNext(now: number, windowMs: number = ALLOW_NEXT_WINDOW_MS): number {
    this.reload();
    this.commit(this.phones, now + windowMs, this.pinnedBefore);
    return this.allowNextUntil;
  }

  allowNextOpen(now: number): boolean {
    this.reload();
    return this.allowNextUntil > now;
  }

  /** Called when a phone was admitted through the window: it admits exactly one. */
  closeAllowNext(): void {
    this.reload();
    if (this.allowNextUntil !== 0) {
      this.commit(this.phones, 0, this.pinnedBefore);
    }
  }

  // A pin file that cannot be read is an error, not an empty store: starting
  // over would turn the next stranger into the first-use phone.
  private reload(): void {
    const file = this.file;
    if (!file) {
      return;
    }
    // The set is consulted on every steering frame: the file is read each time,
    // but an unchanged one is not parsed again.
    let value: unknown;
    let signature: string;
    try {
      const snapshot = readSnapshot(file);
      if (snapshot === undefined || snapshot.signature === this.signature) {
        return;
      }
      signature = snapshot.signature;
      value = JSON.parse(snapshot.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read phone pins at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const record = value as {
      version?: unknown;
      phones?: unknown;
      pins?: unknown;
      allowNextUntil?: unknown;
    } | null;
    if (!record || typeof record !== "object") {
      throw new Error(`Invalid phone pins file at ${file}`);
    }
    // Versions 1 and 2 kept bare fingerprints (1 keyed them by the host they
    // were first seen on). They were authentic first uses, so they carry over,
    // with the time of this migration as when they were added and last used.
    const readAt = this.clock();
    let raw: unknown[];
    let migrated = true;
    if (record.version === 1 && record.pins && typeof record.pins === "object" && !Array.isArray(record.pins)) {
      raw = Object.values(record.pins);
    } else if (record.version === 2 && Array.isArray(record.phones)) {
      raw = record.phones;
    } else if (record.version === PINS_VERSION && Array.isArray(record.phones)) {
      raw = record.phones;
      migrated = false;
    } else {
      throw new Error(`Invalid phone pins file at ${file}`);
    }
    const phones = new Map<string, PinEntry>();
    let needsWrite = migrated;
    for (const item of raw) {
      const entry = migrated ? migratedEntry(item, readAt) : parseEntry(item);
      if (!entry) {
        throw new Error(`Invalid phone pins file at ${file}`);
      }
      // Never used in the future: with the clock set back a pin would otherwise outlive its TTL by that much.
      if (entry.lastUsedAt > readAt) {
        entry.lastUsedAt = readAt;
        needsWrite = true;
      }
      phones.set(entry.fp, entry);
    }
    this.signature = signature;
    this.phones = phones;
    this.needsWrite = needsWrite;
    // Any pin file, of any version and even with no phones, was written after
    // setup began; older builds left `forget --all` files without the flag.
    this.pinnedBefore = true;
    this.allowNextUntil =
      typeof record.allowNextUntil === "number" && Number.isFinite(record.allowNextUntil)
        ? record.allowNextUntil
        : 0;
  }

  /** Writes the new state and keeps it only once the write succeeded: a pin the disk lacks is no pin. */
  private commit(phones: Map<string, PinEntry>, allowNextUntil: number, pinnedBefore: boolean): void {
    if (this.file) {
      privateDir(path.dirname(this.file));
      this.writeFile(
        this.file,
        `${JSON.stringify(
          {
            version: PINS_VERSION,
            // Still written, so an older binary reading this file stays closed too.
            everPinned: true,
            phones: [...phones.values()],
            allowNextUntil,
          },
          null,
          2,
        )}\n`,
      );
      // Read again next time, not stat now: another process may already have
      // replaced the file, and its content is what counts.
      this.signature = undefined;
    }
    this.phones = phones;
    this.needsWrite = false;
    this.allowNextUntil = allowNextUntil;
    this.pinnedBefore = pinnedBefore || this.file !== undefined;
  }
}

/** A recorded use in the future (the clock went back) counts as now. */
function isStale(entry: PinEntry, now: number, ttlMs: number): boolean {
  return now - Math.min(entry.lastUsedAt, now) >= ttlMs;
}

function migratedEntry(item: unknown, at: number): PinEntry | undefined {
  const fp = typeof item === "string" ? normalizeFingerprint(item) : undefined;
  return fp ? { fp, addedAt: at, lastUsedAt: at } : undefined;
}

function parseEntry(item: unknown): PinEntry | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const { fp, addedAt, lastUsedAt } = item as Record<string, unknown>;
  const normalized = typeof fp === "string" ? normalizeFingerprint(fp) : undefined;
  return normalized && typeof addedAt === "number" && Number.isFinite(addedAt) &&
    typeof lastUsedAt === "number" && Number.isFinite(lastUsedAt)
    ? { fp: normalized, addedAt, lastUsedAt }
    : undefined;
}

/**
 * True when the link has proved who it is. Plaintext is monitor-only: it may
 * read the board but never steer a session. The value callers pass as `tls` is
 * not "the socket is encrypted" but "encrypted and verified": a pinned cert on
 * PhoneLink, the steering secret over wss on WsHub.
 */
export function isSteeringAllowed(link: { tls: boolean }): boolean {
  return link.tls === true;
}
