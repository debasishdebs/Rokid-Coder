import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The commit-then-reveal code (R1′), byte for byte as the phone computes it
 * (`SasPairing` in Kotlin; both are held to `contracts/sas-vectors.json`):
 *
 *   C     = SHA-256("rokid-sas-v1" ‖ Nc ‖ agentdFp ‖ phoneFp)
 *   SAS   = first 20 bits of SHA-256("rokid-sas-v1" ‖ Nc ‖ Np ‖ agentdFp ‖ phoneFp), mod 10^6
 *   proof = HMAC-SHA256(key = steer, "rokid-commit-v1" ‖ attempt ‖ agentdFp ‖ phoneFp)
 *
 * Nonces are 32 raw bytes, written on the wire as 64 lowercase hex digits. The
 * labels, fingerprints (canonical upper-case colon hex), attempt ids and the
 * steer secret enter the hashes as their UTF-8 bytes.
 */
export const SAS_LABEL = "rokid-sas-v1";
export const COMMIT_PROOF_LABEL = "rokid-commit-v1";
export const NONCE_BYTES = 32;

const HEX_NONCE = /^[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{16}$/;

export function newNonce(): Buffer {
  return randomBytes(NONCE_BYTES);
}

/** 64 random bits as 16 hex digits: what an attempt is called on every wire and in pair-ready. */
export function newAttemptId(): string {
  return randomBytes(8).toString("hex");
}

export function isAttemptId(value: unknown): value is string {
  return typeof value === "string" && ATTEMPT_ID.test(value);
}

/** The nonce a frame carried, or undefined when it is not exactly 32 bytes of lowercase hex. */
export function parseNonce(value: unknown): Buffer | undefined {
  return typeof value === "string" && HEX_NONCE.test(value) ? Buffer.from(value, "hex") : undefined;
}

export function computeCommit(nc: Buffer, agentdFp: string, phoneFp: string): string {
  return createHash("sha256")
    .update(SAS_LABEL, "utf8")
    .update(nc)
    .update(agentdFp, "utf8")
    .update(phoneFp, "utf8")
    .digest("hex");
}

export function computeSas(nc: Buffer, np: Buffer, agentdFp: string, phoneFp: string): string {
  const digest = createHash("sha256")
    .update(SAS_LABEL, "utf8")
    .update(nc)
    .update(np)
    .update(agentdFp, "utf8")
    .update(phoneFp, "utf8")
    .digest();
  const first20 = (digest[0] << 12) | (digest[1] << 4) | (digest[2] >> 4);
  return String(first20 % 1_000_000).padStart(6, "0");
}

export function computeCommitProof(steer: string, attempt: string, agentdFp: string, phoneFp: string): string {
  return createHmac("sha256", Buffer.from(steer, "utf8"))
    .update(COMMIT_PROOF_LABEL, "utf8")
    .update(attempt, "utf8")
    .update(agentdFp, "utf8")
    .update(phoneFp, "utf8")
    .digest("hex");
}

/** Constant time; anything that is not 64 hex digits is simply wrong. */
export function hexDigestMatches(received: unknown, expected: string): boolean {
  if (typeof received !== "string" || !/^[0-9a-f]{64}$/.test(received)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(received, "hex"), Buffer.from(expected, "hex"));
}
