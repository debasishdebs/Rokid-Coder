import type { HookResponse } from "./approval-manager";
import { sessionKeyOf, type QuestionPayload, type SessionKey } from "./protocol-v2";
import type { HookPayload } from "./types";

/** Matches the `timeout` of the plugin's PreToolUse hook; a longer wait would be killed from outside. */
export const MAX_QUESTION_WAIT_MS = 3_600_000;
/** Open questions held for the glasses at once, per provider; one more is left to the provider's own UI. */
export const MAX_PENDING_QUESTIONS = 32;

export type QuestionAnswers = Record<string, string | string[]>;

/** A question the wearer can answer. Task 9 turns this into a `question` alert. */
export interface QuestionOpened {
  sessionKey: SessionKey;
  sessionId: string;
  question: QuestionPayload;
}

/**
 * `laptop`: answered or taken over at the terminal; `cancelled`: the session
 * ended or was detached, or the request went away; `timeout`: nobody answered.
 */
export type QuestionClosedReason = "answered" | "laptop" | "timeout" | "cancelled";

export interface QuestionClosed {
  sessionKey: SessionKey;
  requestRef: string;
  reason: QuestionClosedReason;
  /** The answer that closed it; absent for every other reason. */
  msgId?: string;
}

export type QuestionOpenedListener = (event: QuestionOpened) => void;
export type QuestionClosedListener = (event: QuestionClosed) => void;

export interface QuestionRelayOptions {
  waitLimitMs: number;
  setTimer?: typeof setTimeout;
  /**
   * Whether a phone is connected to answer. PreToolUse suppresses the TUI's own
   * dialog while it waits, so without a phone the question must go straight to
   * the laptop. Defaults to always.
   */
  canAsk?: () => boolean;
}

interface Hold {
  sessionId: string;
  settle(reason: QuestionClosedReason, response: HookResponse, msgId?: string): void;
  respondWith(answers: QuestionAnswers, msgId: string): void;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** AskUserQuestion's tool_input, projected onto what the phone shows. */
export function claudeQuestionItems(toolInput: unknown): QuestionPayload["items"] {
  const questions = asRecord(toolInput)?.questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  const items: QuestionPayload["items"] = [];
  for (const entry of questions) {
    const question = asRecord(entry);
    if (typeof question?.question !== "string" || question.question.length === 0) {
      continue;
    }
    const options: QuestionPayload["items"][number]["options"] = [];
    for (const option of Array.isArray(question.options) ? question.options : []) {
      const record = asRecord(option);
      if (typeof record?.label !== "string") {
        continue;
      }
      options.push(
        typeof record.description === "string" && record.description.length > 0
          ? { label: record.label, description: record.description }
          : { label: record.label },
      );
    }
    // Claude always lets the person type their own answer instead of an option.
    items.push({
      text: question.question,
      options,
      multiSelect: question.multiSelect === true,
      allowFreeText: true,
    });
  }
  return items;
}

/** Claude's `answers` values are one string; a multi-select joins its labels with commas. */
function flattenAnswers(answers: QuestionAnswers): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [question, answer] of Object.entries(answers)) {
    flat[question] = Array.isArray(answer) ? answer.join(", ") : answer;
  }
  return flat;
}

/**
 * Holds an attached Claude session's AskUserQuestion PreToolUse hook open until
 * the glasses answer. Answering returns an allow whose `updatedInput` carries
 * the answers, which Claude takes as the user's reply with no dialog on the
 * laptop; every other way out returns `{}`, which leaves the question to the TUI.
 */
export class QuestionRelay {
  private readonly holds = new Map<string, Hold>();
  private readonly opened = new Set<QuestionOpenedListener>();
  private readonly closed = new Set<QuestionClosedListener>();
  private waitLimitMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly canAsk: () => boolean;

  constructor(options: QuestionRelayOptions) {
    this.waitLimitMs = clampWaitLimit(options.waitLimitMs, MAX_QUESTION_WAIT_MS);
    this.setTimer = options.setTimer ?? setTimeout;
    this.canAsk = options.canAsk ?? (() => true);
  }

  /** Applies to the holds that start after this call, not to one already waiting. */
  setWaitLimitMs(ms: number): void {
    this.waitLimitMs = clampWaitLimit(ms, this.waitLimitMs);
  }

  get currentWaitLimitMs(): number {
    return this.waitLimitMs;
  }

  onOpened(listener: QuestionOpenedListener): () => void {
    this.opened.add(listener);
    return () => {
      this.opened.delete(listener);
    };
  }

  onClosed(listener: QuestionClosedListener): () => void {
    this.closed.add(listener);
    return () => {
      this.closed.delete(listener);
    };
  }

  /** Whether this hook is one the relay holds; anything else is not its business. */
  static handles(payload: HookPayload): boolean {
    return payload.hook_event_name === "PreToolUse" && payload.tool_name === "AskUserQuestion";
  }

  hold(payload: HookPayload, closed: AbortSignal): Promise<HookResponse> {
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
    const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : "";
    const items = QuestionRelay.handles(payload) ? claudeQuestionItems(payload.tool_input) : [];
    // Nothing to show the wearer, or nothing to answer by: let the TUI ask.
    if (closed.aborted || !this.canAsk() || !sessionId || !toolUseId || items.length === 0) {
      return Promise.resolve({});
    }
    const toolInput = asRecord(payload.tool_input) ?? {};
    const sessionKey = sessionKeyOf("claude", sessionId);
    // A tool_use_id is unique; a repeat means the earlier hook process is gone.
    this.holds.get(toolUseId)?.settle("cancelled", {});
    if (this.holds.size >= MAX_PENDING_QUESTIONS) {
      return Promise.resolve({});
    }
    return new Promise<HookResponse>((resolve) => {
      let done = false;
      const timer = this.setTimer(() => hold.settle("timeout", {}), this.waitLimitMs);
      timer.unref?.();
      const onAbort = () => hold.settle("cancelled", {});
      const hold: Hold = {
        sessionId,
        settle: (reason, response, msgId) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          closed.removeEventListener("abort", onAbort);
          if (this.holds.get(toolUseId) === hold) {
            this.holds.delete(toolUseId);
          }
          resolve(response);
          this.emitClosed({ sessionKey, requestRef: toolUseId, reason, msgId });
        },
        respondWith: (answers, msgId) =>
          hold.settle(
            "answered",
            {
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "allow",
                updatedInput: { ...toolInput, answers: flattenAnswers(answers) },
              },
            },
            msgId,
          ),
      };
      this.holds.set(toolUseId, hold);
      closed.addEventListener("abort", onAbort, { once: true });
      this.emitOpened({
        sessionKey,
        sessionId,
        question: { requestRef: toolUseId, source: "claude_tool", items },
      });
    });
  }

  /** False when nothing is waiting on that tool_use_id (already answered, released or never held). */
  answer(toolUseId: string, answers: QuestionAnswers, msgId: string): boolean {
    const hold = this.holds.get(toolUseId);
    if (!hold) {
      return false;
    }
    hold.respondWith(answers, msgId);
    return true;
  }

  /** The wearer took the keyboard: let the TUI ask its own question. */
  releaseByLaptop(sessionId: string): void {
    for (const hold of [...this.holds.values()]) {
      if (hold.sessionId === sessionId) {
        hold.settle("laptop", {});
      }
    }
  }

  /** The session was detached or ended: release its holds. */
  endSession(sessionId: string): void {
    for (const hold of [...this.holds.values()]) {
      if (hold.sessionId === sessionId) {
        hold.settle("cancelled", {});
      }
    }
  }

  /** No phone that could answer is left: every held question goes back to the TUI. */
  releaseAll(): void {
    for (const hold of [...this.holds.values()]) {
      hold.settle("cancelled", {});
    }
  }

  /** Releases every hold, so no HTTP request is left open when the daemon stops. */
  dispose(): void {
    this.releaseAll();
  }

  isWaiting(toolUseId: string): boolean {
    return this.holds.has(toolUseId);
  }

  hasPendingForSession(sessionId: string): boolean {
    return [...this.holds.values()].some((hold) => hold.sessionId === sessionId);
  }

  private emitOpened(event: QuestionOpened): void {
    for (const listener of [...this.opened]) {
      try {
        listener(event);
      } catch {
        // One subscriber's bug must not strand the hook or the others.
      }
    }
  }

  private emitClosed(event: QuestionClosed): void {
    for (const listener of [...this.closed]) {
      try {
        listener(event);
      } catch {
        // As above.
      }
    }
  }
}

function clampWaitLimit(ms: number, fallback: number): number {
  if (!Number.isFinite(ms) || ms <= 0) {
    return fallback;
  }
  return Math.min(ms, MAX_QUESTION_WAIT_MS);
}
