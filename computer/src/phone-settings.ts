import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_WAIT_LIMIT_SEC } from "./config";
import type { AlertTimings, DefaultMode } from "./protocol-v2";
import { MAX_WAIT_LIMIT_MS } from "./stop-wait";
import { DEFAULT_PAIRING_TTL_DAYS } from "./tls";
import type { Logger } from "./types";

/** Global Constraints: age boost 30 s, dwell 8 s, ack 5 s, backoff 5/10/20 s, reminder 5 min. Expiry is the wait limit. */
export const DEFAULT_ALERT_TIMINGS: Readonly<AlertTimings> = Object.freeze({
  ageBoostMs: 30_000,
  dwellMs: 8_000,
  ackTimeoutMs: 5_000,
  retryBackoffMs: Object.freeze([5_000, 10_000, 20_000]) as unknown as number[],
  reminderMs: 300_000,
});

export interface DefaultModes {
  claude: DefaultMode;
  codex: DefaultMode;
}

export interface PhoneSettings {
  timings: AlertTimings;
  waitLimitMs: number;
  defaultModes: DefaultModes;
  /** Days a phone pairing may go unused before the phone must pair again. */
  pairingTtlDays: number;
}

const FILE_VERSION = 1;
const MAX_BACKOFF_STEPS = 8;

function isDefaultMode(value: unknown): value is DefaultMode {
  return value === "ask" || value === "acceptEdits";
}

/**
 * Floors, so that even a trusted phone (settings_sync is steering) cannot set
 * every threshold to nothing and flood the glasses, or end every hold at once.
 */
export const MIN_TIMING_MS = 1_000;
export const MIN_REMINDER_MS = 30_000;
export const MIN_WAIT_LIMIT_MS = 30_000;

function duration(value: unknown, floor = MIN_TIMING_MS): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= floor
    ? Math.min(Math.round(value), MAX_WAIT_LIMIT_MS)
    : undefined;
}

/**
 * All five thresholds or nothing: a half-applied set would leave the queue with
 * mixed rules. An `expireMs` (older phones and settings files carry one) is
 * dropped, since alert expiry is always the wait limit.
 */
export function parseTimings(value: unknown): AlertTimings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ageBoostMs = duration(record.ageBoostMs);
  const dwellMs = duration(record.dwellMs);
  const ackTimeoutMs = duration(record.ackTimeoutMs);
  const reminderMs = duration(record.reminderMs, MIN_REMINDER_MS);
  const backoff = record.retryBackoffMs;
  if (
    ageBoostMs === undefined || dwellMs === undefined || ackTimeoutMs === undefined ||
    reminderMs === undefined ||
    !Array.isArray(backoff) || backoff.length === 0 || backoff.length > MAX_BACKOFF_STEPS
  ) {
    return undefined;
  }
  const retryBackoffMs = backoff.map((step) => duration(step));
  if (retryBackoffMs.some((step) => step === undefined)) {
    return undefined;
  }
  return { ageBoostMs, dwellMs, ackTimeoutMs, retryBackoffMs: retryBackoffMs as number[], reminderMs };
}

/** The wait limit is capped at an hour, the longest the hooks' own timeouts allow. */
export function parseWaitLimitMs(value: unknown): number | undefined {
  return duration(value, MIN_WAIT_LIMIT_MS);
}

/** A whole number of days, 1 to 365. Anything else is not a setting. */
export function parsePairingTtlDays(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 365
    ? value
    : undefined;
}

export function parseDefaultModes(value: unknown): DefaultModes | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return isDefaultMode(record.claude) && isDefaultMode(record.codex)
    ? { claude: record.claude, codex: record.codex }
    : undefined;
}

/**
 * The phone's own settings, kept in `<stateDir>/settings.json`: the alert
 * thresholds and wait limit its settings screen owns (§12.2) and the default
 * approval modes. Whatever is missing or unreadable falls back to the defaults,
 * since a bad file may lose a setting but must never grant anything.
 */
export class PhoneSettingsStore {
  private current: PhoneSettings;

  constructor(private readonly file: string, waitLimitSec?: number, private readonly logger?: Logger) {
    this.current = this.load(waitLimitSec);
  }

  get(): PhoneSettings {
    return {
      timings: { ...this.current.timings, retryBackoffMs: [...this.current.timings.retryBackoffMs] },
      waitLimitMs: this.current.waitLimitMs,
      defaultModes: { ...this.current.defaultModes },
      pairingTtlDays: this.current.pairingTtlDays,
    };
  }

  /** Throws when the file cannot be written; the caller refuses the change then. */
  update(change: Partial<PhoneSettings>): void {
    const next: PhoneSettings = { ...this.get(), ...change };
    this.write(next);
    this.current = next;
  }

  private load(waitLimitSec?: number): PhoneSettings {
    const defaults: PhoneSettings = {
      timings: { ...DEFAULT_ALERT_TIMINGS, retryBackoffMs: [...DEFAULT_ALERT_TIMINGS.retryBackoffMs] },
      waitLimitMs: (waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC) * 1000,
      defaultModes: { claude: "ask", codex: "ask" },
      pairingTtlDays: DEFAULT_PAIRING_TTL_DAYS,
    };
    let parsed: Record<string, unknown> | undefined;
    try {
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      parsed = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.warn("phone_settings_unreadable", {});
      }
      return defaults;
    }
    if (parsed?.version !== FILE_VERSION) {
      this.logger?.warn("phone_settings_unreadable", { reason: "unexpected_shape" });
      return defaults;
    }
    return {
      timings: parseTimings(parsed.timings) ?? defaults.timings,
      waitLimitMs: parseWaitLimitMs(parsed.waitLimitMs) ?? defaults.waitLimitMs,
      defaultModes: parseDefaultModes(parsed.defaultModes) ?? defaults.defaultModes,
      // Absent from files written before the setting existed.
      pairingTtlDays: parsePairingTtlDays(parsed.pairingTtlDays) ?? defaults.pairingTtlDays,
    };
  }

  private write(settings: PhoneSettings): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ version: FILE_VERSION, ...settings }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
