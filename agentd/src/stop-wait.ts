import type { HookResponse } from "./approval-manager";

export const DEFAULT_STOP_CONTINUATION_CAP = 8;
/** Matches the `timeout` of the plugin's Stop hook; a longer wait would be killed from outside. */
export const MAX_WAIT_LIMIT_MS = 3_600_000;

export type StopWaitReleaseReason = "timeout" | "laptop" | "cancelled" | "delivered";
export type StopWaitDelivery = "delivered" | "not_waiting" | "cap_reached";
export type StopWaitReleaseListener = (
  sessionId: string,
  reason: StopWaitReleaseReason,
  /** The follow-up that was delivered; absent for every other reason. */
  msgId?: string,
) => void;

export interface StopWaitOptions {
  waitLimitMs: number;
  /** Claude ignores a Stop block after this many in a row, until it calls a tool. */
  continuationCap: number;
  setTimer?: typeof setTimeout;
}

interface Hold {
  settle(reason: StopWaitReleaseReason, response: HookResponse, msgId?: string): void;
}

/**
 * Holds an attached Claude session's Stop hook open until the glasses send a
 * follow-up. Delivering returns `{decision:"block", reason}`, which makes
 * Claude carry on in the same session; every other way out returns `{}`, which
 * lets the Stop finish and the session go idle.
 */
export class StopWait {
  private readonly holds = new Map<string, Hold>();
  /** Follow-ups delivered since the session last called a tool. */
  private readonly used = new Map<string, number>();
  private readonly listeners = new Set<StopWaitReleaseListener>();
  private waitLimitMs: number;
  private readonly cap: number;
  private readonly setTimer: typeof setTimeout;

  constructor(options: StopWaitOptions) {
    this.waitLimitMs = clampWaitLimit(options.waitLimitMs, MAX_WAIT_LIMIT_MS);
    this.cap = options.continuationCap;
    this.setTimer = options.setTimer ?? setTimeout;
  }

  /** Applies to the holds that start after this call, not to one already waiting. */
  setWaitLimitMs(ms: number): void {
    this.waitLimitMs = clampWaitLimit(ms, this.waitLimitMs);
  }

  onRelease(listener: StopWaitReleaseListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  hold(sessionId: string, closed: AbortSignal): Promise<HookResponse> {
    // Claude would not honour another block, so waiting for one only stalls it.
    if (closed.aborted || this.continuationsUsed(sessionId) >= this.cap) {
      return Promise.resolve({});
    }
    // One hook process per session; a second Stop means the first is gone.
    this.holds.get(sessionId)?.settle("cancelled", {});
    return new Promise<HookResponse>((resolve) => {
      let done = false;
      const timer = this.setTimer(() => hold.settle("timeout", {}), this.waitLimitMs);
      timer.unref?.();
      const onAbort = () => hold.settle("cancelled", {});
      const hold: Hold = {
        settle: (reason, response, msgId) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          closed.removeEventListener("abort", onAbort);
          if (this.holds.get(sessionId) === hold) {
            this.holds.delete(sessionId);
          }
          if (reason === "delivered") {
            this.used.set(sessionId, this.continuationsUsed(sessionId) + 1);
          }
          resolve(response);
          this.emit(sessionId, reason, msgId);
        },
      };
      this.holds.set(sessionId, hold);
      closed.addEventListener("abort", onAbort, { once: true });
    });
  }

  deliver(sessionId: string, text: string, msgId: string): StopWaitDelivery {
    const hold = this.holds.get(sessionId);
    if (!hold) {
      return this.continuationsUsed(sessionId) >= this.cap ? "cap_reached" : "not_waiting";
    }
    hold.settle(
      "delivered",
      { decision: "block", reason: `Follow-up from Rokid glasses:\n${text}` },
      msgId,
    );
    return "delivered";
  }

  /** The wearer typed at the laptop: that prompt wins, so stop waiting for the glasses. */
  releaseByLaptop(sessionId: string): void {
    this.holds.get(sessionId)?.settle("laptop", {});
  }

  /** Claude called a tool, which is what resets its own count of consecutive blocks. */
  noteToolUse(sessionId: string): void {
    this.used.delete(sessionId);
  }

  /** The session was detached or ended: release its hold and forget its count. */
  endSession(sessionId: string): void {
    this.holds.get(sessionId)?.settle("cancelled", {});
    this.used.delete(sessionId);
  }

  /** Releases every hold, so no HTTP request is left open when the daemon stops. */
  dispose(): void {
    for (const hold of [...this.holds.values()]) {
      hold.settle("cancelled", {});
    }
    this.used.clear();
  }

  state(sessionId: string): { waiting: boolean; continuationsLeft: number } {
    return {
      waiting: this.holds.has(sessionId),
      continuationsLeft: Math.max(0, this.cap - this.continuationsUsed(sessionId)),
    };
  }

  private continuationsUsed(sessionId: string): number {
    return this.used.get(sessionId) ?? 0;
  }

  private emit(sessionId: string, reason: StopWaitReleaseReason, msgId?: string): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(sessionId, reason, msgId);
      } catch {
        // One subscriber's bug must not strand the hook or the others.
      }
    }
  }
}

function clampWaitLimit(ms: number, fallback: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return fallback;
  }
  return Math.min(ms, MAX_WAIT_LIMIT_MS);
}
