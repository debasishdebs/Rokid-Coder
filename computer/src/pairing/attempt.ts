import { computeCommit, computeSas, isAttemptId, newNonce, parseNonce } from "./sas";

export type AttemptState =
  | "IDLE"
  | "WINDOW_OPEN"
  | "PEER_TLS"
  | "COMMIT_SENT"
  | "NONCE_RECEIVED"
  | "REVEALED"
  | "AWAITING_CONFIRM"
  | "PINNED"
  | "ABORTED";

export type AbortReason =
  | "mismatch"
  | "cancel"
  | "timeout"
  | "disconnect"
  | "second_peer"
  | "second_commit"
  | "bad_reveal"
  | "out_of_order"
  | "storage";

const ABORT_REASONS: ReadonlySet<string> = new Set<AbortReason>([
  "mismatch",
  "cancel",
  "timeout",
  "disconnect",
  "second_peer",
  "second_commit",
  "bad_reveal",
  "out_of_order",
  "storage",
]);

/** The frames of a pairing session, the only ones either side accepts before the pins are committed. */
export const SAS_FRAME_TYPES: ReadonlySet<string> = new Set([
  "sas_commit",
  "sas_nonce",
  "sas_reveal",
  "sas_confirm",
  "pair_credentials",
  "pair_committed",
  "pair_abort",
]);

export interface AttemptHooks {
  send(frame: Record<string, unknown>): void;
  /** Both sides confirmed: store the phone pin as provisional, then return the credentials frame (or throw). */
  onPinned(): Record<string, unknown>;
  /** The phone said it stored the credentials. */
  onCommitted(): void;
  /** The phone could not store them, or the session ended before it did: whatever was provisional goes. */
  onPhoneAborted(reason: AbortReason): void;
  onChange(): void;
  /** The session is over; the transport closes the link. */
  close(): void;
}

/**
 * One SAS attempt from agentd's side, on one TLS session whose two
 * fingerprints were fixed by the handshake. agentd commits first (R1′), so its
 * code exists only once the phone has sent its own nonce, blind.
 *
 * Transport-free: the hub or the dialled link feeds it frames and closes the
 * socket when it says so. Nothing here ever writes a nonce, the code or the
 * credentials anywhere but `send`.
 */
export class SasAttempt {
  private stateValue: AttemptState = "PEER_TLS";
  private reason?: AbortReason;
  private nc?: Buffer;
  private codeValue?: string;
  private localConfirmed = false;
  private remoteConfirmed = false;
  private credentials?: Record<string, unknown>;
  private committed = false;

  constructor(
    readonly attempt: string,
    readonly agentdFp: string,
    readonly phoneFp: string,
    private readonly hooks: AttemptHooks,
  ) {}

  get state(): AttemptState {
    return this.stateValue;
  }

  get abortReason(): AbortReason | undefined {
    return this.reason;
  }

  /** Shown only while the two humans compare it, and after. */
  get code(): string | undefined {
    return this.stateValue === "AWAITING_CONFIRM" || this.stateValue === "PINNED" ? this.codeValue : undefined;
  }

  get durable(): boolean {
    return this.committed;
  }

  /** Before PINNED: anything still being decided. */
  get active(): boolean {
    return !["PINNED", "ABORTED"].includes(this.stateValue);
  }

  start(): void {
    this.nc = newNonce();
    this.send({ type: "sas_commit", v: 2, attempt: this.attempt, c: computeCommit(this.nc, this.agentdFp, this.phoneFp) });
    this.move("COMMIT_SENT");
  }

  receive(frame: Record<string, unknown>): void {
    const type = typeof frame.type === "string" ? frame.type : "";
    if (!SAS_FRAME_TYPES.has(type)) {
      // Before the pins, a session carries nothing else; after them, nothing else either.
      if (this.active) {
        this.abort("out_of_order");
      }
      return;
    }
    // Another attempt's frame (an old one, or another window's): not this session's business.
    if (frame.attempt !== this.attempt) {
      return;
    }
    if (this.stateValue === "ABORTED") {
      return;
    }
    switch (type) {
      case "sas_nonce":
        return this.onNonce(frame);
      case "sas_confirm":
        return this.onRemoteConfirm(frame);
      case "pair_committed":
        return this.onCommitted();
      case "pair_abort":
        return this.onPeerAbort(frame);
      default:
        // sas_commit, sas_reveal and pair_credentials only ever go from agentd to the phone.
        if (this.active) {
          this.abort("out_of_order");
        }
    }
  }

  /** The computer-side human's answer (a UX step: alone it never pins). */
  confirmLocal(ok: boolean): boolean {
    if (this.stateValue !== "AWAITING_CONFIRM") {
      return false;
    }
    if (!ok) {
      this.send({ type: "sas_confirm", v: 2, attempt: this.attempt, ok: false });
      this.abort("mismatch");
      return true;
    }
    if (!this.localConfirmed) {
      this.localConfirmed = true;
      this.send({ type: "sas_confirm", v: 2, attempt: this.attempt, ok: true });
      this.hooks.onChange();
    }
    this.maybePin();
    return true;
  }

  /** The link went away. Before the pins that ends the attempt; after them, the phone may still recover by hello. */
  disconnected(): void {
    if (this.active) {
      this.abort("disconnect", { tell: false });
    }
  }

  abort(reason: AbortReason, { tell = true }: { tell?: boolean } = {}): void {
    if (this.stateValue === "ABORTED") {
      return;
    }
    const wasPinned = this.stateValue === "PINNED";
    if (tell) {
      this.send({ type: "pair_abort", v: 2, attempt: this.attempt, reason });
    }
    this.reason = reason;
    this.nc = undefined;
    this.credentials = undefined;
    this.move("ABORTED");
    if (wasPinned && !this.committed) {
      this.hooks.onPhoneAborted(reason);
    }
    this.hooks.close();
  }

  private onNonce(frame: Record<string, unknown>): void {
    if (this.stateValue !== "COMMIT_SENT") {
      // A second nonce in the window is a second attempt at the code: never a retry.
      return this.abort(this.stateValue === "AWAITING_CONFIRM" || this.stateValue === "PINNED" ? "second_commit" : "out_of_order");
    }
    const np = parseNonce(frame.np);
    if (!np || !this.nc) {
      return this.abort("out_of_order");
    }
    this.move("NONCE_RECEIVED");
    this.send({ type: "sas_reveal", v: 2, attempt: this.attempt, nc: this.nc.toString("hex") });
    this.move("REVEALED");
    this.codeValue = computeSas(this.nc, np, this.agentdFp, this.phoneFp);
    this.nc = undefined;
    this.move("AWAITING_CONFIRM");
  }

  private onRemoteConfirm(frame: Record<string, unknown>): void {
    if (this.stateValue === "PINNED") {
      return;
    }
    if (this.stateValue !== "AWAITING_CONFIRM" || typeof frame.ok !== "boolean") {
      return this.abort("out_of_order");
    }
    if (!frame.ok) {
      return this.abort("mismatch", { tell: false });
    }
    if (!this.remoteConfirmed) {
      this.remoteConfirmed = true;
      this.hooks.onChange();
    }
    this.maybePin();
  }

  private maybePin(): void {
    if (!this.localConfirmed || !this.remoteConfirmed || this.stateValue !== "AWAITING_CONFIRM") {
      return;
    }
    let credentials: Record<string, unknown>;
    try {
      credentials = this.hooks.onPinned();
    } catch {
      this.abort("storage");
      return;
    }
    this.credentials = credentials;
    this.move("PINNED");
    this.send(credentials);
  }

  private onCommitted(): void {
    if (this.stateValue !== "PINNED") {
      return this.abort("out_of_order");
    }
    if (this.committed) {
      return;
    }
    this.committed = true;
    this.credentials = undefined;
    this.hooks.onCommitted();
    this.hooks.onChange();
    this.hooks.close();
  }

  private onPeerAbort(frame: Record<string, unknown>): void {
    const reason = typeof frame.reason === "string" && ABORT_REASONS.has(frame.reason)
      ? (frame.reason as AbortReason)
      : "cancel";
    if (this.stateValue === "PINNED" && this.committed) {
      return;
    }
    this.abort(reason, { tell: false });
  }

  private send(frame: Record<string, unknown>): void {
    this.hooks.send(frame);
  }

  private move(state: AttemptState): void {
    this.stateValue = state;
    this.hooks.onChange();
  }
}

export { isAttemptId };
