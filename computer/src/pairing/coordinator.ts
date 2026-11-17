import { advertisedEndpoint, startAdvertiseRefresh } from "../advertise";
import { ALLOW_NEXT_WINDOW_MS, PROVISIONAL_PIN_MS, PinStore, normalizeFingerprint, shortFingerprint } from "../tls";
import type { AgentConfig, Logger } from "../types";
import { SasAttempt, type AbortReason, type AttemptState } from "./attempt";
import { computeCommitProof, hexDigestMatches, isAttemptId, newAttemptId } from "./sas";

/** What every computer-side pairing client is told (`pair_status` on the launcher socket). */
export interface PairStatus {
  attempt: string;
  state: AttemptState;
  code?: string;
  reason?: AbortReason;
}

export interface SessionTransport {
  transport: "wshub" | "phonelink";
  agentdFp: string;
  phoneFp: string;
  send(frame: Record<string, unknown>): void;
  close(): void;
}

/** The session a transport feeds until it ends. */
export interface PairingSession {
  receive(frame: Record<string, unknown>): void;
  disconnected(): void;
}

export interface CoordinatorOptions {
  config: AgentConfig;
  /** Durable and provisional phone pins, in one store (R207). */
  pins: PinStore;
  logger: Logger;
  /** Read when the credentials go out, so a rotation since the window opened is what the phone gets. */
  steer: () => string | undefined;
  /** Where the phone should dial agentd's wss, for the outbound slot it stores. */
  wsHost: () => string;
  /** Test seam: the computer's Tailscale address; the Tailscale CLI's answer when absent. */
  tailnetHost?: () => string | undefined;
  now?: () => number;
  /** How long an attempt may take from its first TLS peer to both confirmations. */
  attemptTimeoutMs?: number;
  /** How long agentd keeps a pinned session open for `pair_committed` before it relies on recovery. */
  commitWaitMs?: number;
  windowMs?: number;
}

/**
 * agentd's one pairing window and its one attempt (R1′, 6a-R4′).
 *
 * The window is PinStore's allow-next flag, so every way of opening it (`agentd
 * pair`, `rk`'s prompt, `/rokid:pair`, `phones allow-next`) opens this one. The
 * first unpinned TLS peer to arrive while it is open spends it: one attempt per
 * window, and a second peer during that attempt aborts both. A phone pin is
 * stored only once both humans confirmed, and only as provisional until the
 * phone proves it kept the credentials.
 */
export class PairingCoordinator {
  private current?: SasAttempt;
  /** The attempt id of an open window no peer has reached yet. */
  private windowAttempt?: string;
  private lastStatus?: PairStatus;
  private readonly watchers = new Set<(status: PairStatus) => void>();
  private attemptTimer?: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly stopAdvertiseRefresh: () => void;

  constructor(private readonly options: CoordinatorOptions) {
    this.now = options.now ?? Date.now;
    // The daemon's refresh of the NAT-mode endpoint [6b-R3]; a no-op anywhere else.
    this.stopAdvertiseRefresh = startAdvertiseRefresh(options.config);
  }

  // ---------------------------------------------------------------- the window

  /** Opens the window unless an attempt is already under way; either way returns what clients should show. */
  openWindow(): PairStatus | undefined {
    if (this.current?.active) {
      return this.status();
    }
    this.options.pins.armAllowNext(this.now(), this.options.windowMs ?? ALLOW_NEXT_WINDOW_MS);
    this.current = undefined;
    this.windowAttempt = newAttemptId();
    this.options.logger.info("pairing_window_opened", { attempt: this.windowAttempt });
    this.publish();
    return this.status();
  }

  /** True while a new phone may start an attempt. */
  windowOpen(): boolean {
    try {
      return this.options.pins.allowNextOpen(this.now());
    } catch {
      return false;
    }
  }

  /** What `pair-ready` announces while the window waits for a phone; nothing once a peer has arrived. */
  pairReady(): Record<string, unknown> | undefined {
    const attempt = this.waitingAttempt();
    if (!attempt) {
      return undefined;
    }
    const endpoint = advertisedEndpoint(this.options.config, this.options.wsHost, this.options.tailnetHost);
    return {
      nexus: "agentd-pair-ready",
      v: 1,
      machineName: this.options.config.machineName,
      host: endpoint.hosts[0],
      wsPort: endpoint.port,
      attempt,
    };
  }

  status(): PairStatus | undefined {
    if (this.current) {
      return {
        attempt: this.current.attempt,
        state: this.current.state,
        ...(this.current.code ? { code: this.current.code } : {}),
        ...(this.current.abortReason ? { reason: this.current.abortReason } : {}),
      };
    }
    const waiting = this.waitingAttempt();
    return waiting ? { attempt: waiting, state: "WINDOW_OPEN" } : undefined;
  }

  watch(listener: (status: PairStatus) => void): () => void {
    this.watchers.add(listener);
    const now = this.status();
    if (now) {
      listener(now);
    }
    return () => {
      this.watchers.delete(listener);
    };
  }

  /**
   * A computer-side confirmation, from any launcher-socket client. Same-user
   * processes can send it, a model-launched one included, so it is only half:
   * the phone's own confirmation is the one nothing on this computer can give.
   */
  confirm(attempt: unknown, ok: unknown): boolean {
    const current = this.current;
    // A "no" before any code is a cancel: the client that opened the window is going away.
    if (ok === false && isAttemptId(attempt) && (attempt === this.windowAttempt || (current?.active && current.attempt === attempt && current.state !== "AWAITING_CONFIRM"))) {
      this.cancel();
      return true;
    }
    if (!isAttemptId(attempt) || typeof ok !== "boolean" || !current || current.attempt !== attempt) {
      this.options.logger.warn("pair_confirm_ignored", { reason: "stale_attempt" });
      return false;
    }
    const taken = current.confirmLocal(ok);
    if (!taken) {
      this.options.logger.warn("pair_confirm_ignored", { reason: `state_${current.state.toLowerCase()}` });
    }
    return taken;
  }

  /** The user cancelled on the computer: the window shuts and an attempt in progress ends. */
  cancel(): void {
    const waiting = this.windowAttempt;
    this.windowAttempt = undefined;
    try {
      this.options.pins.closeAllowNext();
    } catch {
      // The window still runs out by itself.
    }
    if (this.current?.active) {
      this.current.abort("cancel");
    } else if (waiting) {
      this.emit({ attempt: waiting, state: "ABORTED", reason: "cancel" });
    }
  }

  // ---------------------------------------------------------------- sessions

  /**
   * Whether an unpinned TLS peer reaching agentd now is a pairing peer: the
   * window is open, or an attempt is running (which a second peer aborts).
   */
  accepts(): boolean {
    return this.current?.active === true || this.windowOpen();
  }

  /**
   * A TLS peer whose cert is not pinned arrived inside the window. Its
   * fingerprints are the handshake's. Undefined when it is refused: the
   * transport then closes it (a second peer also aborts the running attempt).
   */
  beginSession(transport: SessionTransport): PairingSession | undefined {
    const agentdFp = normalizeFingerprint(transport.agentdFp);
    const phoneFp = normalizeFingerprint(transport.phoneFp);
    if (!agentdFp || !phoneFp) {
      return undefined;
    }
    if (this.current?.active) {
      // The same phone on the other transport (agentd dials the phone while the phone dials agentd):
      // the TLS handshake proved the same client key, so it is no second device. The duplicate goes,
      // quietly: no pair_abort, because the phone's attempt model is one object for both transports
      // and a frame on the duplicate would abort the attempt the phone is showing.
      // The first transport wins whichever it is. The phone's SAS screen and its confirmation read
      // that shared model, not a transport, so the code is shown either way; and moving the attempt
      // to the other transport would mean aborting a commitment that is already bound to this one.
      if (this.current.phoneFp === phoneFp) {
        this.options.logger.info("pairing_duplicate_transport", { transport: transport.transport, fingerprint: shortFingerprint(phoneFp) });
        transport.close();
        return undefined;
      }
      this.options.logger.warn("pairing_second_peer", {
        transport: transport.transport,
        fingerprint: shortFingerprint(phoneFp),
      });
      const attempt = this.current.attempt;
      transport.send({ type: "pair_abort", v: 2, attempt, reason: "second_peer" });
      transport.close();
      this.current.abort("second_peer");
      return undefined;
    }
    if (!this.windowOpen()) {
      return undefined;
    }
    const attemptId = this.windowAttempt ?? newAttemptId();
    this.windowAttempt = undefined;
    // One attempt per window: it is spent the moment a peer reaches it.
    try {
      this.options.pins.closeAllowNext();
    } catch {
      return undefined;
    }
    let closed = false;
    const close = (): void => {
      if (!closed) {
        closed = true;
        transport.close();
      }
    };
    const attempt: SasAttempt = new SasAttempt(attemptId, agentdFp, phoneFp, {
      send: (frame) => {
        if (!closed) {
          transport.send(frame);
        }
      },
      onPinned: () => this.pinProvisional(attempt),
      onCommitted: () => this.promote(phoneFp, attemptId, "pair_committed"),
      onPhoneAborted: (reason) => {
        this.dropProvisional(phoneFp, attemptId);
        this.options.logger.warn("pairing_provisional_dropped", { reason, fingerprint: shortFingerprint(phoneFp) });
      },
      onChange: () => this.onAttemptChange(attempt, close),
      close,
    });
    this.current = attempt;
    this.options.logger.info("pairing_peer", {
      transport: transport.transport,
      attempt: attemptId,
      fingerprint: shortFingerprint(phoneFp),
    });
    this.armTimer(attempt, this.options.attemptTimeoutMs ?? ALLOW_NEXT_WINDOW_MS);
    attempt.start();
    return {
      receive: (frame) => {
        if (this.current === attempt || attempt.state === "PINNED") {
          attempt.receive(frame);
        }
      },
      disconnected: () => {
        closed = true;
        attempt.disconnected();
      },
    };
  }

  // ---------------------------------------------------------------- recovery

  /** A live provisional pin for `fp`: it never admits a normal link on its own. */
  provisionalFor(fp: string): { attempt: string } | undefined {
    try {
      const entry = this.options.pins.provisional(fp, this.now());
      return entry ? { attempt: entry.attempt } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The PhoneLink recovery check (6a-R4″): the phone's proof that it holds the
   * steering secret it was handed for this attempt, bound to both certs.
   */
  proofValid(phoneFp: string, agentdFp: string, attempt: unknown, proof: unknown): boolean {
    const entry = this.provisionalFor(phoneFp);
    const steer = this.options.steer();
    const phone = normalizeFingerprint(phoneFp);
    const agentd = normalizeFingerprint(agentdFp);
    if (!entry || !steer || !phone || !agentd || attempt !== entry.attempt) {
      return false;
    }
    return hexDigestMatches(proof, computeCommitProof(steer, entry.attempt, agentd, phone));
  }

  /**
   * The phone proved it stored the credentials of `attempt`: that attempt's
   * provisional pin becomes durable, in one write. Refused when the entry was
   * forgotten, rotated away, dropped or expired since, or belongs to another
   * attempt: a revoked pairing never comes back by a late commit.
   */
  promote(fp: string, attempt: string, how: "pair_committed" | "recovery_hello" | "recovery_proof"): boolean {
    let promoted: boolean;
    try {
      promoted = this.options.pins.promote(fp, attempt, this.now());
    } catch (error) {
      this.options.logger.error("pairing_promote_failed", { reason: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (!promoted) {
      this.options.logger.warn("pairing_promote_refused", { how, attempt, fingerprint: shortFingerprint(fp) });
      return false;
    }
    this.options.logger.info("phone_pinned", { how, fingerprint: shortFingerprint(fp) });
    return true;
  }

  /** The hourly sweep: provisional pins past their deadline go. */
  expire(): string[] {
    return this.options.pins.expireProvisional(this.now());
  }

  dispose(): void {
    this.stopAdvertiseRefresh();
    this.clearTimer();
    if (this.current?.active) {
      this.current.abort("disconnect", { tell: false });
    }
    this.watchers.clear();
  }

  // ---------------------------------------------------------------- internals

  private waitingAttempt(): string | undefined {
    if (this.current?.active || !this.windowOpen()) {
      return undefined;
    }
    // A window opened by another process (`phones allow-next`) gets its id here.
    this.windowAttempt ??= newAttemptId();
    return this.windowAttempt;
  }

  private pinProvisional(attempt: SasAttempt): Record<string, unknown> {
    const steer = this.options.steer();
    if (!steer) {
      throw new Error("no steering secret");
    }
    this.options.pins.addProvisional(attempt.phoneFp, attempt.attempt, this.now(), PROVISIONAL_PIN_MS);
    const endpoint = advertisedEndpoint(this.options.config, this.options.wsHost, this.options.tailnetHost);
    this.options.logger.info("pairing_pinned_provisional", { attempt: attempt.attempt, fingerprint: shortFingerprint(attempt.phoneFp) });
    return {
      type: "pair_credentials",
      v: 2,
      attempt: attempt.attempt,
      token: this.options.config.token,
      steer,
      machineId: this.options.config.machineId,
      machineName: this.options.config.machineName,
      // `wsHost` is for phones that predate `wsHosts`; they ignore the list.
      wsHost: endpoint.hosts[0],
      wsHosts: endpoint.hosts,
      wsPort: endpoint.port,
    };
  }

  private dropProvisional(fp: string, attempt: string): void {
    try {
      this.options.pins.dropProvisional(fp, attempt);
    } catch (error) {
      this.options.logger.error("pairing_provisional_unavailable", { reason: error instanceof Error ? error.message : String(error) });
    }
  }

  private onAttemptChange(attempt: SasAttempt, close: () => void): void {
    if (attempt.state === "ABORTED") {
      this.clearTimer();
      this.options.logger.warn("pairing_aborted", { attempt: attempt.attempt, reason: attempt.abortReason ?? "unknown" });
    } else if (attempt.state === "PINNED" && attempt.durable) {
      this.clearTimer();
    } else if (attempt.state === "PINNED") {
      // Lost or late, pair_committed is no longer needed after this: the phone recovers by its first hello.
      this.armTimer(attempt, this.options.commitWaitMs ?? 30_000, close);
    }
    if (this.current === attempt) {
      this.publish();
    }
  }

  private armTimer(attempt: SasAttempt, ms: number, onPinned?: () => void): void {
    this.clearTimer();
    this.attemptTimer = setTimeout(() => {
      if (attempt.active) {
        attempt.abort("timeout");
      } else if (attempt.state === "PINNED") {
        onPinned?.();
      }
    }, ms);
    this.attemptTimer.unref();
  }

  private clearTimer(): void {
    if (this.attemptTimer) {
      clearTimeout(this.attemptTimer);
      this.attemptTimer = undefined;
    }
  }

  private publish(): void {
    const status = this.status();
    if (status) {
      this.emit(status);
    }
  }

  private emit(status: PairStatus): void {
    const key = JSON.stringify(status);
    if (this.lastStatus && JSON.stringify(this.lastStatus) === key) {
      return;
    }
    this.lastStatus = status;
    for (const watcher of [...this.watchers]) {
      try {
        watcher(status);
      } catch {
        // A client that went away is removed by its own close.
      }
    }
  }
}
