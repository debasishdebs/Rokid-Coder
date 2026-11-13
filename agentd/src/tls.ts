import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
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

const CERT_COMMON_NAME = "rokid-coder-agentd";
const CERT_VALID_DAYS = 3650;
const PINS_VERSION = 2;
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

/** Identifies a file's current content cheaply: replaced files (rename) get a new inode. */
function fileSignature(file: string): string | undefined {
  try {
    const stat = statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
}

const steerCache = new Map<string, { signature: string; value: string | undefined }>();

/**
 * The secret a wss phone must present, with the token, to steer. Undefined
 * until one is made. Read on every steering check, so the file is re-read only
 * when its signature changes.
 */
export function readSteerSecret(dir: string = defaultTlsDir()): string | undefined {
  const file = steerFile(dir);
  const signature = fileSignature(file);
  if (signature === undefined) {
    steerCache.delete(file);
    return undefined;
  }
  const cached = steerCache.get(file);
  if (cached && cached.signature === signature) {
    return cached.value;
  }
  let value: string | undefined;
  try {
    const text = readFileSync(file, "utf8").trim();
    value = text.length >= 32 ? text : undefined;
  } catch {
    value = undefined;
  }
  steerCache.set(file, { signature, value });
  return value;
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

/**
 * The set of phone certificates agentd trusts, by `fingerprint256`. A phone is
 * its cert, wherever it is dialled from, so an IP change needs nothing.
 *
 * Trust on first use applies only at first-ever setup, while no phone has ever
 * been pinned, or inside the window `phones allow-next` opens for one more
 * phone. Anything else is refused, including after every phone was forgotten:
 * an empty set is not a fresh install, or the phone just forgotten (or whoever
 * answered in its place) would be trusted again on its own.
 *
 * The CLI edits the same file the daemon uses, so every read looks at the file
 * again; a file that cannot be read throws rather than reading as empty.
 */
export class PinStore {
  private phones = new Set<string>();
  private allowNextUntil = 0;
  private pinnedBefore = false;
  private signature: string | undefined;

  /** Without a file the set lives only as long as the process. */
  constructor(private readonly file?: string) {
    this.reload();
  }

  /** The backing file, for watchers; undefined for a store that lives only in memory. */
  get filePath(): string | undefined {
    return this.file;
  }

  list(): string[] {
    this.reload();
    return [...this.phones];
  }

  has(fp: string): boolean {
    this.reload();
    const normalized = normalizeFingerprint(fp);
    return normalized !== undefined && this.phones.has(normalized);
  }

  isEmpty(): boolean {
    this.reload();
    return this.phones.size === 0;
  }

  /** True once any phone has ever been pinned, even if all were forgotten since. */
  everPinned(): boolean {
    this.reload();
    return this.pinnedBefore;
  }

  add(fp: string): void {
    const normalized = normalizeFingerprint(fp);
    if (!normalized) {
      throw new Error("not a SHA-256 certificate fingerprint");
    }
    this.reload();
    this.phones.add(normalized);
    this.pinnedBefore = true;
    // A phone admitted through the empty set used up an open window too.
    this.allowNextUntil = 0;
    this.persist();
  }

  /** Removes the phone whose fingerprint is `fp` or starts with it; returns what was removed. */
  forget(fp: string): string[] {
    this.reload();
    const wanted = fp.replace(/:/g, "").toUpperCase();
    if (wanted.length < 8 || !/^[0-9A-F]+$/.test(wanted)) {
      throw new Error("give at least 8 hex digits of the fingerprint");
    }
    const hits = [...this.phones].filter((phone) => phone.replace(/:/g, "").startsWith(wanted));
    if (hits.length > 1) {
      throw new Error("that matches more than one phone; give more of the fingerprint");
    }
    for (const hit of hits) {
      this.phones.delete(hit);
    }
    if (hits.length > 0) {
      this.persist();
    }
    return hits;
  }

  /** Back to an empty set: the next phone to authenticate is trusted on first use again. */
  forgetAll(): void {
    this.reload();
    this.phones.clear();
    this.allowNextUntil = 0;
    this.persist();
  }

  /** Lets one more unknown phone be trusted on first use until `now` + the window. */
  armAllowNext(now: number, windowMs: number = ALLOW_NEXT_WINDOW_MS): number {
    this.reload();
    this.allowNextUntil = now + windowMs;
    this.persist();
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
      this.allowNextUntil = 0;
      this.persist();
    }
  }

  // A pin file that cannot be read is an error, not an empty store: starting
  // over would turn the next stranger into the first-use phone.
  private reload(): void {
    const file = this.file;
    if (!file) {
      return;
    }
    // The set is consulted on every steering frame, so an unchanged file is not re-read.
    const signature = fileSignature(file);
    if (signature === undefined || signature === this.signature) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
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
      everPinned?: unknown;
    } | null;
    if (!record || typeof record !== "object") {
      throw new Error(`Invalid phone pins file at ${file}`);
    }
    // Version 1 keyed fingerprints by the host they were first seen on. The
    // fingerprints were authentic first uses, so they carry over as the set.
    let raw: unknown[];
    if (record.version === 1 && record.pins && typeof record.pins === "object" && !Array.isArray(record.pins)) {
      raw = Object.values(record.pins);
    } else if (record.version === PINS_VERSION && Array.isArray(record.phones)) {
      raw = record.phones;
    } else {
      throw new Error(`Invalid phone pins file at ${file}`);
    }
    const phones = new Set<string>();
    for (const entry of raw) {
      const normalized = typeof entry === "string" ? normalizeFingerprint(entry) : undefined;
      if (!normalized) {
        throw new Error(`Invalid phone pins file at ${file}`);
      }
      phones.add(normalized);
    }
    this.signature = signature;
    this.phones = phones;
    // Phones on file mean a phone was pinned, whatever an older file said.
    this.pinnedBefore = phones.size > 0 || (record.version === PINS_VERSION && record.everPinned === true);
    this.allowNextUntil =
      typeof record.allowNextUntil === "number" && Number.isFinite(record.allowNextUntil)
        ? record.allowNextUntil
        : 0;
  }

  private persist(): void {
    if (!this.file) {
      return;
    }
    privateDir(path.dirname(this.file));
    writePrivate(
      this.file,
      `${JSON.stringify(
        {
          version: PINS_VERSION,
          everPinned: this.pinnedBefore,
          phones: [...this.phones],
          allowNextUntil: this.allowNextUntil,
        },
        null,
        2,
      )}\n`,
    );
    this.signature = fileSignature(this.file);
  }
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
