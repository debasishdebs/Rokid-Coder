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

/**
 * The set of phone certificates agentd trusts, by `fingerprint256`. A phone is
 * its cert, wherever it is dialled from, so an IP change needs nothing.
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
  private phones = new Set<string>();
  private allowNextUntil = 0;
  private pinnedBefore = false;
  private signature: string | undefined;
  private readonly writeFile: (file: string, content: string) => void;

  /** Without a file the set lives only as long as the process. `writeFile` is for tests. */
  constructor(
    private readonly file?: string,
    options: { writeFile?: (file: string, content: string) => void } = {},
  ) {
    this.writeFile = options.writeFile ?? writePrivate;
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

  /** True once setup has begun (a pin file exists), even if every phone was forgotten since. */
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
    // A phone admitted through the empty set used up an open window too.
    this.commit(new Set([...this.phones, normalized]), 0, true);
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
    if (hits.length > 0) {
      const remaining = new Set(this.phones);
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
    this.commit(new Set(), 0, this.pinnedBefore);
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
    // Any pin file, of any version and even with no phones, was written after
    // setup began; older builds left `forget --all` files without the flag.
    this.pinnedBefore = true;
    this.allowNextUntil =
      typeof record.allowNextUntil === "number" && Number.isFinite(record.allowNextUntil)
        ? record.allowNextUntil
        : 0;
  }

  /** Writes the new state and keeps it only once the write succeeded: a pin the disk lacks is no pin. */
  private commit(phones: Set<string>, allowNextUntil: number, pinnedBefore: boolean): void {
    if (this.file) {
      privateDir(path.dirname(this.file));
      this.writeFile(
        this.file,
        `${JSON.stringify(
          {
            version: PINS_VERSION,
            // Still written, so an older binary reading this file stays closed too.
            everPinned: true,
            phones: [...phones],
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
    this.allowNextUntil = allowNextUntil;
    this.pinnedBefore = pinnedBefore || this.file !== undefined;
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
