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

/** The secret a wss phone must present, with the token, to steer. Undefined until one is made. */
export function readSteerSecret(dir: string = defaultTlsDir()): string | undefined {
  try {
    const value = readFileSync(steerFile(dir), "utf8").trim();
    return value.length >= 32 ? value : undefined;
  } catch {
    return undefined;
  }
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

/** Constant-time compare that is safe for unequal lengths. */
export function secretMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || expected.length === 0) {
    return false;
  }
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

/**
 * The set of phone certificates agentd trusts, by `fingerprint256`. A phone is
 * its cert, wherever it is dialled from, so an IP change needs nothing.
 *
 * Trust on first use applies only while the set is empty, or inside the window
 * `phones allow-next` opens for one more phone. Anything else is refused.
 *
 * The CLI edits the same file the daemon uses, so every read looks at the file
 * again; a file that cannot be read throws rather than reading as empty.
 */
export class PinStore {
  private phones = new Set<string>();
  private allowNextUntil = 0;

  /** Without a file the set lives only as long as the process. */
  constructor(private readonly file?: string) {
    this.reload();
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

  add(fp: string): void {
    const normalized = normalizeFingerprint(fp);
    if (!normalized) {
      throw new Error("not a SHA-256 certificate fingerprint");
    }
    this.reload();
    this.phones.add(normalized);
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
    if (!file || !existsSync(file)) {
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
    const record = value as { version?: unknown; phones?: unknown; pins?: unknown; allowNextUntil?: unknown } | null;
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
    this.phones = phones;
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
      `${JSON.stringify({ version: PINS_VERSION, phones: [...this.phones], allowNextUntil: this.allowNextUntil }, null, 2)}\n`,
    );
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
