import { X509Certificate } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { generate } from "selfsigned";
import { defaultRokidCoderStateDir } from "./config";

const CERT_COMMON_NAME = "rokid-coder-agentd";
const CERT_VALID_DAYS = 3650;
const PINS_VERSION = 1;

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

function writePrivate(file: string, content: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, file);
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
  const pems = await generate([{ name: "commonName", value: CERT_COMMON_NAME }], {
    algorithm: "sha256",
    keySize: 2048,
    notBeforeDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    notAfterDate: new Date(Date.now() + CERT_VALID_DAYS * 24 * 60 * 60 * 1000),
  });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { keyFile, certFile } = certFiles(dir);
  // Key first: a cert without its key is useless, a key without its cert is regenerated.
  writePrivate(keyFile, pems.private);
  writePrivate(certFile, pems.cert);
  chmodSync(dir, 0o700);
  return { key: pems.private, cert: pems.cert, fingerprint256: fingerprintOfCert(pems.cert) };
}

/**
 * The phones' certificate fingerprints that agentd has pinned, by phone id
 * (the dialled host). Pinning is trust on first use: whoever pins first wins,
 * and a later different fingerprint is the caller's to refuse.
 */
export class PinStore {
  private readonly pins = new Map<string, string>();

  /** Without a file the pins live only as long as the process. */
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      this.load(file);
    }
  }

  pinFor(phoneId: string): string | undefined {
    return this.pins.get(phoneId);
  }

  pin(phoneId: string, fp: string): void {
    const normalized = normalizeFingerprint(fp);
    if (!normalized) {
      throw new Error("not a SHA-256 certificate fingerprint");
    }
    this.pins.set(phoneId, normalized);
    this.persist();
  }

  // A pin file that cannot be read is an error, not an empty store: starting
  // over would turn the next stranger into the first-use phone.
  private load(file: string): void {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot read phone pins at ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const record = value as { version?: unknown; pins?: unknown } | null;
    if (
      !record ||
      typeof record !== "object" ||
      record.version !== PINS_VERSION ||
      !record.pins ||
      typeof record.pins !== "object" ||
      Array.isArray(record.pins)
    ) {
      throw new Error(`Invalid phone pins file at ${file}`);
    }
    for (const [phoneId, fp] of Object.entries(record.pins)) {
      const normalized = typeof fp === "string" ? normalizeFingerprint(fp) : undefined;
      if (!normalized) {
        throw new Error(`Invalid phone pins file at ${file}`);
      }
      this.pins.set(phoneId, normalized);
    }
  }

  private persist(): void {
    if (!this.file) {
      return;
    }
    mkdirSync(path.dirname(this.file), { recursive: true });
    writePrivate(
      this.file,
      `${JSON.stringify({ version: PINS_VERSION, pins: Object.fromEntries(this.pins) }, null, 2)}\n`,
    );
  }
}

/**
 * True when the link has proved who it is. Plaintext is monitor-only: it may
 * read the board but never steer a session.
 */
export function isSteeringAllowed(link: { tls: boolean }): boolean {
  return link.tls === true;
}
