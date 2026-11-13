import { randomUUID } from "node:crypto";
import type { AlertFrame, AlertKind, AlertTimings, QuestionPayload, SessionKey } from "./protocol-v2";

export type { AlertKind } from "./protocol-v2";

export type AlertState = "queued" | "sent" | "shown" | "acted" | "dismissed" | "expired";

export interface Alert {
  id: string;
  sessionKey: SessionKey;
  kind: AlertKind;
  title: string;
  body: string;
  actions?: string[];
  question?: QuestionPayload;
  createdAt: number;
  state: AlertState;
  attempts: number;
  promoted: boolean;
}

export type NewAlert = Omit<Alert, "id" | "state" | "attempts" | "promoted">;

const KIND_RANK: Record<AlertKind, number> = {
  approval: 0,
  question: 1,
  error: 2,
  notice: 3,
  done: 4,
};

interface Entry {
  alert: Alert;
  seq: number;
  lastSentAt: number;
  shownAt?: number;
  /** First time the glasses acknowledged it; the wait limit counts from here. */
  firstShownAt?: number;
  /** Displaced by an approval: sorts ahead of its priority class. */
  preempted: boolean;
}

/**
 * Alert lifecycle: queued -> sent -> shown (glasses ack) -> acted/dismissed,
 * or expired. Only a `shown` ack counts as delivered. The queue owns no timers;
 * the daemon drives it with tick() and everything time-based reads `now()`.
 *
 * One alert at a time occupies the glasses (current()). A shown alert that is
 * past its dwell and not acted stays "parked" and is requeued as a reminder
 * every reminderMs until the wait limit.
 */
export class AlertQueue {
  private readonly entries = new Map<string, Entry>();
  private slot: Entry | undefined;
  private seq = 0;

  constructor(
    private readonly timings: AlertTimings,
    private readonly sink: (frame: AlertFrame) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  push(input: NewAlert): string {
    const id = randomUUID();
    const alert: Alert = { ...input, id, state: "queued", attempts: 0, promoted: false };
    this.entries.set(id, { alert, seq: this.seq++, lastSentAt: 0, preempted: false });
    this.service();
    return id;
  }

  onShown(id: string): void {
    const entry = this.entries.get(id);
    // Only an alert that is out on the wire can be acknowledged; a late ack for
    // one that was requeued or already shown is stale.
    if (!entry || entry.alert.state !== "sent") {
      return;
    }
    const t = this.now();
    entry.alert.state = "shown";
    entry.shownAt = t;
    entry.firstShownAt ??= t;
  }

  onActed(id: string): void {
    this.finish(id, "acted");
  }

  onDismissed(id: string): void {
    this.finish(id, "dismissed");
  }

  tick(): void {
    this.service();
  }

  waitingCount(): number {
    return this.slot ? this.entries.size - 1 : this.entries.size;
  }

  current(): Alert | undefined {
    return this.slot ? { ...this.slot.alert } : undefined;
  }

  /** Drops every alert of the session. The caller reports `reason` to the user if it wants to. */
  expireSession(sessionKey: string, _reason: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.alert.sessionKey === sessionKey) {
        this.close(entry, "expired");
      }
    }
    this.service();
  }

  private finish(id: string, state: "acted" | "dismissed"): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.close(entry, state);
    this.service();
  }

  private close(entry: Entry, state: AlertState): void {
    entry.alert.state = state;
    this.entries.delete(entry.alert.id);
    if (this.slot === entry) {
      this.slot = undefined;
    }
  }

  private service(): void {
    const t = this.now();
    this.expireDue(t);
    this.remind(t);
    this.retryUnacked(t);
    this.dispatchNext(t);
  }

  private expireDue(t: number): void {
    for (const entry of [...this.entries.values()]) {
      const origin = entry.firstShownAt ?? entry.alert.createdAt;
      if (t - origin >= this.timings.expireMs) {
        this.close(entry, "expired");
      }
    }
  }

  /** A shown alert nobody acted on comes back as a reminder. */
  private remind(t: number): void {
    for (const entry of this.entries.values()) {
      if (entry.alert.state !== "shown" || entry.shownAt === undefined) {
        continue;
      }
      const dwellOver = t - entry.shownAt >= this.timings.dwellMs;
      if (dwellOver && t - entry.lastSentAt >= this.timings.reminderMs) {
        this.requeue(entry, false);
      }
    }
  }

  private retryUnacked(t: number): void {
    const entry = this.slot;
    if (entry && entry.alert.state === "sent" && t >= entry.lastSentAt + this.retryGap(entry.alert.attempts)) {
      this.transmit(entry, t);
    }
  }

  /**
   * Gap after attempt n: the ack timeout at the least, stretched by the backoff
   * table (5/10/20 s by default, last value kept).
   */
  private retryGap(attempts: number): number {
    const backoff = this.timings.retryBackoffMs;
    const step = backoff.length === 0 ? 0 : backoff[Math.min(Math.max(attempts, 1) - 1, backoff.length - 1)];
    return Math.max(this.timings.ackTimeoutMs, step);
  }

  private dispatchNext(t: number): void {
    this.applyAgeBoost(t);
    const occupant = this.slot;
    if (!occupant) {
      const next = this.best((e) => e.alert.state === "queued");
      if (next) {
        this.dispatch(next, t);
      }
      return;
    }
    // Only a real approval displaces the current alert, whether it is still
    // waiting for its ack or inside its dwell.
    const inDwell = occupant.alert.state === "sent" ||
      (occupant.alert.state === "shown" && t - (occupant.shownAt ?? t) < this.timings.dwellMs);
    if (inDwell) {
      if (occupant.alert.kind !== "approval") {
        const approval = this.best((e) => e.alert.state === "queued" && e.alert.kind === "approval");
        if (approval) {
          this.requeue(occupant, true);
          this.dispatch(approval, t);
        }
      }
      return;
    }
    const next = this.best((e) => e.alert.state === "queued");
    if (next) {
      // Dwell is over: the shown alert is parked, still awaiting action.
      this.slot = undefined;
      this.dispatch(next, t);
    }
  }

  private applyAgeBoost(t: number): void {
    for (const entry of this.entries.values()) {
      if (!entry.alert.promoted && t - entry.alert.createdAt >= this.timings.ageBoostMs) {
        entry.alert.promoted = true;
      }
    }
  }

  private best(filter: (entry: Entry) => boolean): Entry | undefined {
    let winner: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (filter(entry) && (!winner || this.compare(entry, winner) < 0)) {
        winner = entry;
      }
    }
    return winner;
  }

  private compare(a: Entry, b: Entry): number {
    const rank = this.rank(a) - this.rank(b);
    if (rank !== 0) {
      return rank;
    }
    if (a.preempted !== b.preempted) {
      return a.preempted ? -1 : 1;
    }
    return a.alert.createdAt - b.alert.createdAt || a.seq - b.seq;
  }

  private rank(entry: Entry): number {
    return entry.alert.promoted ? KIND_RANK.approval : KIND_RANK[entry.alert.kind];
  }

  private requeue(entry: Entry, preempted: boolean): void {
    entry.alert.state = "queued";
    entry.alert.attempts = 0;
    entry.shownAt = undefined;
    entry.preempted = preempted;
    if (this.slot === entry) {
      this.slot = undefined;
    }
  }

  private dispatch(entry: Entry, t: number): void {
    this.slot = entry;
    entry.alert.state = "sent";
    entry.alert.attempts = 0;
    entry.preempted = false;
    this.transmit(entry, t);
  }

  private transmit(entry: Entry, t: number): void {
    entry.alert.attempts += 1;
    entry.lastSentAt = t;
    const alert = entry.alert;
    const frame: AlertFrame = {
      type: "alert",
      v: 2,
      id: alert.id,
      sessionKey: alert.sessionKey,
      kind: alert.kind,
      title: alert.title,
      body: alert.body,
      ...(alert.actions ? { actions: [...alert.actions] } : {}),
      ...(alert.question ? { question: alert.question } : {}),
      waiting: this.waitingCount(),
    };
    try {
      // A refused frame counts as an attempt: only a shown ack ends the retries.
      this.sink(frame);
    } catch {
      // A throwing sink is handled like a refusing one; the retry schedule covers it.
    }
  }
}
