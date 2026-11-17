import { randomUUID } from "node:crypto";
import type {
  AlertClosedReason,
  AlertFrame,
  AlertKind,
  AlertSendReason,
  AlertTimings,
  QuestionPayload,
  SessionKey,
} from "./protocol-v2";

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
  /** An approval whose action was cut (R128); sent as the frame's `truncated`. */
  truncated?: boolean;
  createdAt: number;
  state: AlertState;
  attempts: number;
  promoted: boolean;
}

export type AlertCloseListener = (alert: Alert, reason: AlertClosedReason) => void;

/** The phone's thresholds plus the expiry, which the daemon always sets to the wait limit Y. */
export interface QueueTimings extends AlertTimings {
  expireMs: number;
}

export type NewAlert = Omit<Alert, "id" | "state" | "attempts" | "promoted">;

/**
 * The longest the glasses can keep one band up: the hub caps a notice's
 * lifetime at 90 s from its first show (45 s per ttl, restarted by an update).
 * A configured "Alert stays on screen" above this is read as this, so the queue
 * never holds the display for a card the glasses already dropped.
 */
export const MAX_BAND_DWELL_MS = 80_000;

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
  /** Why the next dispatch happens: how this alert last went back to the queue. */
  dispatchReason: "new" | "reminder" | "resume";
  /** The `waiting` its latest frame carried; a different count is an update. */
  sentWaiting: number;
  /**
   * Whether a dispatch or retry of it has reached a link. Until one has, the
   * phone has never heard of it, so whatever sends it next says `new`.
   */
  delivered: boolean;
}

/**
 * Alert lifecycle: queued -> sent -> shown (glasses ack) -> acted/dismissed,
 * or expired. Only a `shown` ack counts as delivered. The queue owns no timers;
 * the daemon drives it with tick() and everything time-based reads `now()`.
 *
 * One alert at a time occupies the glasses (current()). The card's lifetime on
 * the glasses is the wearer's "Alert stays on screen" (`dwellMs`), counted from
 * the `shown` ack; the phone takes the band down at that moment, and this queue
 * frees the display at the same moment without touching the alert's own state.
 * Past its dwell:
 * - a Done or notice needs no answer and is closed (silently: the phone already
 *   dropped it), so it never comes back;
 * - an approval, question or error still needs the wearer: it stays pending, and
 *   `reminderMs` after it was shown it is sent again as a reminder, until it is
 *   answered, dismissed or the wait limit ends it. Approvals and questions stay
 *   answerable from the phone and laptop the whole time.
 *
 * Before this rule `dwellMs` only decided when the next queued alert could take
 * the display and when the first reminder was allowed; nothing took the card off
 * the glasses except the hub's own ttl (45 s for an action band, 12 s for Done and
 * error), and a reminder was counted from the last frame sent, not from the show.
 */
export class AlertQueue {
  private readonly entries = new Map<string, Entry>();
  private slot: Entry | undefined;
  private seq = 0;

  /**
   * `sink` returns false when no phone link can take the frame. That is not an
   * attempt: the alert stays unsent-for-free, so a link that is down for a while
   * does not push the retry gap to its 20 s step, and linkUp() sends it the
   * moment a link returns. A throwing sink is treated like a refusing one.
   * `onClose` hears every way an alert leaves the queue; a dismiss is the
   * glasses' own doing, so the daemon reports every other reason to the phone.
   */
  constructor(
    private timings: QueueTimings,
    private readonly sink: (frame: AlertFrame) => boolean,
    private readonly now: () => number = Date.now,
    private readonly onClose?: AlertCloseListener,
  ) {}

  /** New thresholds apply to the alerts already queued as well as the ones to come. */
  setTimings(timings: QueueTimings): void {
    this.timings = timings;
    this.service();
  }

  get(id: string): Alert | undefined {
    const entry = this.entries.get(id);
    return entry ? { ...entry.alert } : undefined;
  }

  /**
   * Hides an alert from the glasses without settling it: it leaves the display
   * slot but stays queued as shown, so it is still answerable and still comes
   * back as a reminder.
   */
  park(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    const t = this.now();
    entry.alert.state = "shown";
    entry.shownAt = t;
    entry.firstShownAt ??= t;
    if (this.slot === entry) {
      this.slot = undefined;
    }
    this.service();
  }

  /** Removes an alert whose subject went away (answered at the laptop, session ended). */
  withdraw(id: string, reason: "expired" | "withdrawn" = "withdrawn"): void {
    const entry = this.entries.get(id);
    if (entry) {
      this.close(entry, "expired", reason);
      this.service();
    }
  }

  /** A phone link just came up: whatever held the glasses may never have arrived, so send it again. */
  linkUp(): void {
    const occupant = this.slot;
    if (occupant && (occupant.alert.state === "sent" || occupant.alert.state === "shown")) {
      this.requeue(occupant, occupant.preempted, "resume");
    }
    this.service();
  }

  push(input: NewAlert): string {
    const id = randomUUID();
    const alert: Alert = { ...input, id, state: "queued", attempts: 0, promoted: false };
    this.entries.set(id, { alert, seq: this.seq++, lastSentAt: 0, preempted: false, dispatchReason: "new", sentWaiting: 0, delivered: false });
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
        this.close(entry, "expired", "withdrawn");
      }
    }
    this.service();
  }

  private finish(id: string, state: "acted" | "dismissed"): void {
    const entry = this.entries.get(id);
    if (!entry) {
      return;
    }
    this.close(entry, state, state);
    this.service();
  }

  private close(entry: Entry, state: AlertState, reason: AlertClosedReason): void {
    entry.alert.state = state;
    this.entries.delete(entry.alert.id);
    if (this.slot === entry) {
      this.slot = undefined;
    }
    try {
      this.onClose?.({ ...entry.alert }, reason);
    } catch {
      // A listener's bug must not leave the queue half-updated.
    }
  }

  private service(): void {
    const t = this.now();
    this.expireDue(t);
    this.remind(t);
    this.retryUnacked(t);
    this.dispatchNext(t);
    this.updateWaiting();
  }

  private expireDue(t: number): void {
    for (const entry of [...this.entries.values()]) {
      const origin = entry.firstShownAt ?? entry.alert.createdAt;
      if (t - origin >= this.timings.expireMs) {
        this.close(entry, "expired", "expired");
      }
    }
  }

  /** What the glasses can show of "Alert stays on screen". */
  private dwellMs(): number {
    return Math.min(this.timings.dwellMs, MAX_BAND_DWELL_MS);
  }

  /**
   * A shown alert whose card has left the glasses: a Done or notice is over, and
   * the rest come back as a reminder `reminderMs` after they were shown.
   */
  private remind(t: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.alert.state !== "shown" || entry.shownAt === undefined) {
        continue;
      }
      const onScreenFor = t - entry.shownAt;
      if (onScreenFor < this.dwellMs()) {
        continue;
      }
      if (entry.alert.kind === "done" || entry.alert.kind === "notice") {
        this.close(entry, "dismissed", "dismissed");
      } else if (onScreenFor >= this.timings.reminderMs) {
        this.requeue(entry, false, "reminder");
      }
    }
  }

  private retryUnacked(t: number): void {
    const entry = this.slot;
    if (entry && entry.alert.state === "sent" && t >= entry.lastSentAt + this.retryGap(entry.alert.attempts)) {
      this.transmit(entry, t, "retry");
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
      (occupant.alert.state === "shown" && t - (occupant.shownAt ?? t) < this.dwellMs());
    if (inDwell) {
      if (occupant.alert.kind !== "approval") {
        const approval = this.best((e) => e.alert.state === "queued" && e.alert.kind === "approval");
        if (approval) {
          this.requeue(occupant, true, "resume");
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

  private requeue(entry: Entry, preempted: boolean, reason: "reminder" | "resume"): void {
    entry.dispatchReason = reason;
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
    this.transmit(entry, t, entry.dispatchReason);
  }

  /**
   * A push, a close or a withdraw changed how many alerts wait behind the one
   * on the glasses: tell the phone, so `+N waiting` stays current even for an
   * alert that is already acknowledged. The delivery bookkeeping stays as it is.
   */
  private updateWaiting(): void {
    const occupant = this.slot;
    if (occupant && occupant.sentWaiting !== this.waitingCount()) {
      this.send(occupant, "update");
    }
  }

  private transmit(entry: Entry, t: number, reason: Exclude<AlertSendReason, "update">): void {
    entry.alert.attempts += 1;
    entry.lastSentAt = t;
    // Only a shown ack ends the retries, and only a frame that reached a link
    // counts toward the backoff. An `update` is no delivery: the phone ignores
    // one for an alert it never showed.
    if (this.send(entry, entry.delivered ? reason : "new")) {
      entry.delivered = true;
    } else {
      entry.alert.attempts = Math.max(0, entry.alert.attempts - 1);
    }
  }

  /** Hands the entry's frame to the sink; false when no link took it. */
  private send(entry: Entry, reason: AlertSendReason): boolean {
    const alert = entry.alert;
    const waiting = this.waitingCount();
    entry.sentWaiting = waiting;
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
      ...(alert.truncated ? { truncated: true } : {}),
      waiting,
      reason,
    };
    try {
      return this.sink(frame);
    } catch {
      // Handled like a refusal.
      return false;
    }
  }
}
