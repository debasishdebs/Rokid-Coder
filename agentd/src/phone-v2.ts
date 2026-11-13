import { AlertQueue, type Alert } from "./alerts";
import type { AppliedIds } from "./applied-ids";
import type {
  ApprovalManager,
  ApprovalObserver,
  ApprovalOutcome,
  ApprovalRequest,
} from "./approval-manager";
import type { ApprovalPolicy, ResetNotice } from "./approval-policy";
import type { AttachRegistry } from "./attach-registry";
import type { CodexMonitor } from "./codex/monitor";
import {
  parseSessionKey,
  sessionKeyOf,
  type AckFrame,
  type AlertClosedReason,
  type AlertFrame,
  type FollowupState,
  type PhoneChannel,
  type QuestionPayload,
  type SessionKey,
  type TempMode,
} from "./protocol-v2";
import {
  PhoneSettingsStore,
  parseDefaultModes,
  parseTimings,
  parseWaitLimitMs,
} from "./phone-settings";
import type { QuestionClosed, QuestionOpened, QuestionRelay } from "./question-relay";
import type { SessionStore } from "./session-store";
import type { StopWait, StopWaitReleaseReason } from "./stop-wait";
import type { AgentProvider, Logger, Session } from "./types";

const TICK_MS = 1000;
const MAX_MSG_ID_CHARS = 128;
const MAX_FOLLOWUP_BYTES = 16 * 1024;
const MAX_ANSWER_ENTRIES = 32;
const MAX_ANSWER_CHARS = 4000;
const FORBIDDEN_ANSWER_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const MAX_SETTING_CHARS = 100;
const HEADING_FALLBACK_CHARS = 48;
/**
 * Codex reasoning efforts a turn/start takes. Static until the live check
 * (Task 12) says whether model/list's own per-model list should replace it.
 */
export const CODEX_EFFORTS: readonly string[] = ["low", "medium", "high"];

/** The v1 frames: the transports keep handling these themselves, behind the same gate. */
const V1_FRAME_TYPES: ReadonlySet<string> = new Set([
  "hello", "hello_ack", "hello_reject", "refresh", "detail_open", "detail_close",
  "ping", "pong", "fs_list", "thread_start", "session_input", "approval_decision",
]);

/** Where outbound frames go: whichever phone link is up, preferring the one agentd dialled. */
export interface PhoneOutlet {
  readonly connected: boolean;
  /** False when no link took the frame. */
  send(frame: Record<string, unknown>): boolean;
}

export interface PhoneV2Deps {
  sessions: SessionStore;
  attachRegistry: AttachRegistry;
  approvalPolicy: ApprovalPolicy;
  approvals: ApprovalManager;
  stopWait: StopWait;
  questionRelay: QuestionRelay;
  codex: CodexMonitor;
  settings: PhoneSettingsStore;
  appliedIds: AppliedIds;
  outlet: PhoneOutlet;
  /** Drains the reset notices queued since the last call, restart notices first. */
  takeResetNotices: () => ResetNotice[];
  logger: Logger;
  now?: () => number;
  tickMs?: number;
}

type Outcome = { ok: true } | { ok: false; error: string };
const OK: Outcome = { ok: true };
const fail = (error: string): Outcome => ({ ok: false, error });

/** What an alert is about, so an answer can be checked against the alert's own subject. */
type Binding =
  | { kind: "approval"; requestId: string }
  | { kind: "question"; requestRef: string }
  | { kind: "done" | "error" | "notice" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmptyString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

/**
 * The phone protocol v2 in one place: what the phone may ask (after the
 * transports' shared authorization gate has passed it), what agentd tells the
 * phone about alerts, modes and waits, and the enrichment of every published
 * session. The transports only parse lines and call in here.
 */
export class PhoneV2 {
  readonly alerts: AlertQueue;
  private readonly bindings = new Map<string, Binding>();
  private readonly approvalAlerts = new Map<string, string>();
  private readonly questionAlerts = new Map<string, string>();
  private readonly doneAlerts = new Map<SessionKey, string>();
  private readonly lastError = new Map<string, string>();
  private readonly now: () => number;
  private tickTimer?: NodeJS.Timeout;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: PhoneV2Deps) {
    this.now = deps.now ?? Date.now;
    const settings = deps.settings.get();
    this.alerts = new AlertQueue(
      settings.timings,
      (frame) => deps.outlet.send({ ...frame }),
      this.now,
      (alert, reason) => this.onAlertClosed(alert, reason),
    );
    // Persisted settings win over what the daemon was constructed with; the
    // default approval modes reach sessions that were attached before this start.
    deps.stopWait.setWaitLimitMs(settings.waitLimitMs);
    deps.questionRelay.setWaitLimitMs(settings.waitLimitMs);
    deps.approvalPolicy.setDefaults(settings.defaultModes);
    for (const entry of deps.attachRegistry.list()) {
      deps.approvalPolicy.applyDefault(sessionKeyOf(entry.provider, entry.id));
    }
    this.wireSources();
  }

  start(): void {
    this.tickTimer ??= setInterval(() => this.alerts.tick(), this.deps.tickMs ?? TICK_MS);
    this.tickTimer.unref();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    for (const off of this.unsubscribe.splice(0)) {
      off();
    }
  }

  /** The frame observer ApprovalManager reports to; pass it as the manager's `observer`. */
  readonly approvalObserver: ApprovalObserver = {
    onPending: (request) => this.onApprovalPending(request),
    onSettled: (request, outcome, reason) => this.onApprovalSettled(request, outcome, reason),
  };

  // Outbound: sessions

  /** A published session as the phone sees it: the store's fields plus the v2 ones. */
  decorate(session: Session): Record<string, unknown> {
    const { provider, id } = session;
    const key = sessionKeyOf(provider, id);
    const mode = this.deps.attachRegistry.mode(provider, id) ?? "plugin";
    const launcher = mode === "launcher";
    return {
      ...session,
      mode,
      capabilities: provider === "codex"
        ? { compact: true, model: true, followup: this.codexFollowup() }
        : { compact: launcher, model: launcher, followup: this.claudeFollowup(id, launcher) },
      tempMode: this.deps.approvalPolicy.get(key),
      heading: session.heading ?? (session.title.slice(0, HEADING_FALLBACK_CHARS) || id.slice(0, 8)),
    };
  }

  private codexFollowup(): FollowupState {
    return this.deps.codex.availability().available ? "ready" : "unavailable";
  }

  private claudeFollowup(sessionId: string, launcher: boolean): FollowupState {
    if (launcher) {
      return "ready";
    }
    const state = this.deps.stopWait.state(sessionId);
    if (state.waiting) {
      return "waiting";
    }
    return state.continuationsLeft === 0 ? "cap_reached" : "unavailable";
  }

  private republish(key: SessionKey | string): void {
    const parsed = parseSessionKey(key);
    if (parsed) {
      this.deps.sessions.refresh(parsed.id);
    }
  }

  // Outbound: alerts, resets and waits

  /** A phone link came up: send what was waiting for one, and any resets nobody has been told about. */
  onChannelConnected(): void {
    this.alerts.linkUp();
    this.flushResets();
  }

  /** The session ended or was detached: its alerts have no subject any more, and its mode is gone. */
  onSessionEnded(provider: AgentProvider, id: string): void {
    const key = sessionKeyOf(provider, id);
    this.alerts.expireSession(key, "session_ended");
    this.lastError.delete(key);
    this.flushResets();
  }

  /** Drains queued resets into `mode_reset` frames and `notice` alerts. */
  flushResets(): void {
    for (const notice of this.deps.takeResetNotices()) {
      this.announceReset(notice);
    }
  }

  private announceReset(notice: ResetNotice): void {
    const key = notice.sessionKey as SessionKey;
    this.deps.outlet.send({
      type: "mode_reset",
      v: 2,
      sessionKey: key,
      from: notice.from,
      reason: notice.reason,
    });
    const why = {
      session_ended: "the session ended",
      helper_restarted: "agentd restarted",
      revoked: "you revoked it",
    }[notice.reason];
    this.pushAlert(key, "notice", {
      title: "Approval mode reset",
      body: `${notice.from} ended for ${this.nameOf(key)}: ${why}.`,
    });
    this.republish(key);
  }

  /** A Claude transcript reported an error for an attached session. */
  onClaudeError(sessionId: string, message: string): void {
    const key = sessionKeyOf("claude", sessionId);
    if (!this.deps.attachRegistry.isAttached("claude", sessionId) || this.lastError.get(key) === message) {
      return;
    }
    this.lastError.set(key, message);
    this.pushAlert(key, "error", { title: "Error", body: message });
  }

  private wireSources(): void {
    const { stopWait, questionRelay, codex } = this.deps;
    this.unsubscribe.push(
      stopWait.onOpened((sessionId) => this.onStopHeld(sessionId)),
      stopWait.onRelease((sessionId, reason) => this.onStopReleased(sessionId, reason)),
      questionRelay.onOpened((event) => this.onQuestionOpened(event)),
      questionRelay.onClosed((event) => this.onQuestionClosed(event)),
      codex.onQuestionOpened((event) => this.onQuestionOpened(event)),
      codex.onQuestionClosed((event) => this.onQuestionClosed(event)),
      codex.onTurnCompleted((event) => {
        if (event.status === "completed") {
          this.onDone(event.sessionKey);
        } else if (event.status === "failed") {
          this.pushAlert(event.sessionKey, "error", { title: "Error", body: event.error ?? "Codex turn failed." });
        }
      }),
    );
  }

  private onStopHeld(sessionId: string): void {
    const key = sessionKeyOf("claude", sessionId);
    this.onDone(key);
    this.republish(key);
  }

  private onStopReleased(sessionId: string, reason: StopWaitReleaseReason): void {
    const key = sessionKeyOf("claude", sessionId);
    const alertId = this.doneAlerts.get(key);
    if (alertId) {
      if (reason === "delivered") {
        this.alerts.onActed(alertId);
      } else {
        this.alerts.withdraw(alertId);
      }
    }
    if (!this.deps.attachRegistry.isAttached("claude", sessionId)) {
      return;
    }
    this.deps.outlet.send({ type: "followup_closed", v: 2, sessionKey: key, reason });
    this.republish(key);
  }

  private onDone(key: SessionKey): void {
    const parsed = parseSessionKey(key);
    const session = parsed ? this.deps.sessions.get(parsed.id) : undefined;
    // One "done" per session: a newer one replaces an older that nobody read.
    const previous = this.doneAlerts.get(key);
    if (previous) {
      this.alerts.withdraw(previous);
    }
    const id = this.pushAlert(key, "done", {
      title: "Done",
      body: session?.lastAssistantText || session?.heading || session?.title || this.nameOf(key),
    });
    this.doneAlerts.set(key, id);
  }

  private onQuestionOpened(event: QuestionOpened): void {
    const ref = `${event.sessionKey}|${event.question.requestRef}`;
    const id = this.pushAlert(event.sessionKey, "question", {
      title: "Question",
      body: event.question.items[0]?.text ?? "Needs an answer",
      question: event.question,
    }, { kind: "question", requestRef: event.question.requestRef });
    this.questionAlerts.set(ref, id);
  }

  private onQuestionClosed(event: QuestionClosed): void {
    const ref = `${event.sessionKey}|${event.requestRef}`;
    const id = this.questionAlerts.get(ref);
    if (!id) {
      return;
    }
    if (event.reason === "answered") {
      this.alerts.onActed(id);
    } else {
      this.alerts.withdraw(id, event.reason === "timeout" ? "expired" : "withdrawn");
    }
  }

  private onApprovalPending(request: ApprovalRequest): void {
    const id = this.pushAlert(request.sessionKey, "approval", {
      title: request.tool,
      body: request.summary,
      actions: ["allow", "deny"],
    }, { kind: "approval", requestId: request.requestId });
    this.approvalAlerts.set(request.requestId, id);
  }

  private onApprovalSettled(request: ApprovalRequest, outcome: ApprovalOutcome, reason?: string): void {
    const id = this.approvalAlerts.get(request.requestId);
    if (id) {
      if (outcome === "allow" || outcome === "deny") {
        this.alerts.onActed(id);
      } else {
        this.alerts.withdraw(id, outcome === "timeout" ? "expired" : "withdrawn");
      }
    }
    if (reason === "phone_disconnected") {
      this.pushAlert(request.sessionKey, "notice", {
        title: "Approval expired",
        body: `${request.tool} was not answered before the phone disconnected. Answer it at the laptop.`,
      });
    }
  }

  private pushAlert(
    sessionKey: SessionKey,
    kind: AlertFrame["kind"],
    fields: { title: string; body: string; actions?: string[]; question?: QuestionPayload },
    binding: Binding = { kind: kind as "done" | "error" | "notice" },
  ): string {
    const id = this.alerts.push({ sessionKey, kind, createdAt: this.now(), ...fields });
    this.bindings.set(id, binding);
    return id;
  }

  private onAlertClosed(alert: Alert, reason: AlertClosedReason): void {
    const binding = this.bindings.get(alert.id);
    this.bindings.delete(alert.id);
    if (binding?.kind === "approval") {
      this.approvalAlerts.delete(binding.requestId);
    } else if (binding?.kind === "question") {
      this.questionAlerts.delete(`${alert.sessionKey}|${binding.requestRef}`);
    } else if (binding?.kind === "done" && this.doneAlerts.get(alert.sessionKey) === alert.id) {
      this.doneAlerts.delete(alert.sessionKey);
    }
    // A dismiss is the glasses' own doing; every other end is news to the phone.
    if (reason !== "dismissed") {
      this.deps.outlet.send({ type: "alert_closed", v: 2, id: alert.id, reason });
    }
  }

  private nameOf(key: SessionKey): string {
    const parsed = parseSessionKey(key);
    const session = parsed ? this.deps.sessions.get(parsed.id) : undefined;
    return session?.heading || session?.title || key;
  }

  // Inbound

  /**
   * Handles a frame that has passed the authorization gate. True means it was a
   * v2 frame (or an unknown one) and is dealt with; false leaves a v1 frame to
   * the transport's own switch.
   */
  handle(frame: Record<string, unknown>, channel: PhoneChannel): boolean {
    const type = typeof frame.type === "string" ? frame.type : "";
    if (V1_FRAME_TYPES.has(type)) {
      return false;
    }
    switch (type) {
      case "alert_shown":
        if (typeof frame.id === "string") {
          this.alerts.onShown(frame.id);
        }
        break;
      case "alert_dismissed":
        if (typeof frame.id === "string") {
          this.dismiss(frame.id);
        }
        break;
      case "settings_sync":
        this.settingsSync(frame, channel);
        break;
      case "models_request":
        void this.modelsRequest(frame, channel);
        break;
      default:
        // Everything else is steering, an unknown type included.
        void this.steer(frame, channel);
        break;
    }
    return true;
  }

  /**
   * Dismissing hides an alert from the glasses; it never settles one. A dismiss
   * is a monitor frame and may come over plaintext, so an approval or question
   * alert is only parked: it stays answerable through a later trusted
   * alert_action or question_answer. The others have nothing left to answer.
   */
  private dismiss(id: string): void {
    const kind = this.bindings.get(id)?.kind;
    if (kind === "approval" || kind === "question") {
      this.alerts.park(id);
    } else {
      this.alerts.onDismissed(id);
    }
  }

  private ack(channel: PhoneChannel, msgId: string, result: AckFrame["result"], error?: string): void {
    channel.send({ type: "ack", v: 2, msgId, result, ...(error ? { error } : {}) });
  }

  /**
   * A msgId is consumed only when the frame is actually about to be applied:
   * a frame refused by the gate or by any check (bad shape, not attached, wrong
   * session, ...) leaves its id free, so the phone can resend it once the cause
   * is gone. Each handler calls `record` after its last check and before its
   * first effect, synchronously, so a replay can never run twice; only the
   * applying itself is allowed to wait.
   */
  private async steer(frame: Record<string, unknown>, channel: PhoneChannel): Promise<void> {
    const msgId = nonEmptyString(frame.msgId, MAX_MSG_ID_CHARS);
    if (!msgId) {
      this.ack(channel, "", "rejected", "bad_msg_id");
      return;
    }
    if (this.deps.appliedIds.seen(msgId)) {
      this.ack(channel, msgId, "duplicate");
      return;
    }
    const record = (): void => this.deps.appliedIds.record(msgId);
    let outcome: Outcome;
    try {
      outcome = await this.apply(frame, msgId, record);
    } catch (error) {
      this.deps.logger.warn("phone_v2_apply_failed", {
        type: String(frame.type).slice(0, 40),
        reason: error instanceof Error ? error.name : "unknown",
      });
      outcome = fail("failed");
    }
    this.deps.logger.info("phone_v2_steering", {
      type: String(frame.type).slice(0, 40),
      result: outcome.ok ? "applied" : outcome.error,
    });
    this.ack(channel, msgId, outcome.ok ? "applied" : "rejected", outcome.ok ? undefined : outcome.error);
  }

  private apply(frame: Record<string, unknown>, msgId: string, record: () => void): Outcome | Promise<Outcome> {
    switch (frame.type) {
      case "alert_action":
        return this.alertAction(frame, record);
      case "followup":
        return this.followup(frame, msgId, record);
      case "question_answer":
        return this.questionAnswer(frame, msgId, record);
      case "mode_set":
        return this.modeSet(frame, record);
      case "mode_revoke_all":
        return this.modeRevokeAll(record);
      case "codex_settings":
        return this.codexSettings(frame, record);
      case "codex_compact":
        return this.codexCompact(frame, record);
      case "defaults_set":
        return this.defaultsSet(frame, record);
      default:
        return fail("unknown_frame");
    }
  }

  /** The attached session a steering frame names, or why there is none. */
  private target(value: unknown): { provider: AgentProvider; id: string; key: SessionKey } | Outcome {
    const parsed = parseSessionKey(value);
    if (!parsed) {
      return fail("bad_session_key");
    }
    if (!this.deps.attachRegistry.isAttached(parsed.provider, parsed.id)) {
      return fail("not_attached");
    }
    return { ...parsed, key: sessionKeyOf(parsed.provider, parsed.id) };
  }

  private alertAction(frame: Record<string, unknown>, record: () => void): Outcome {
    const alertId = nonEmptyString(frame.id, MAX_MSG_ID_CHARS);
    const alert = alertId ? this.alerts.get(alertId) : undefined;
    const binding = alertId ? this.bindings.get(alertId) : undefined;
    if (!alertId || !alert || !binding) {
      return fail("unknown_alert");
    }
    if (binding.kind !== "approval") {
      return fail("no_actions");
    }
    if (frame.action !== "allow" && frame.action !== "deny") {
      return fail("unknown_action");
    }
    // The request can only be decided through its own alert, whatever the phone says it is about.
    record();
    return this.deps.approvals.handleDecision(binding.requestId, frame.action)
      ? OK
      : fail("no_longer_pending");
  }

  private async followup(frame: Record<string, unknown>, msgId: string, record: () => void): Promise<Outcome> {
    const target = this.target(frame.sessionKey);
    if ("ok" in target) {
      return target;
    }
    const text = typeof frame.text === "string" ? frame.text : "";
    if (text.trim().length === 0 || Buffer.byteLength(text, "utf8") > MAX_FOLLOWUP_BYTES) {
      return fail("bad_text");
    }
    record();
    if (target.provider === "claude") {
      switch (this.deps.stopWait.deliver(target.id, text, msgId)) {
        case "delivered":
          return OK;
        case "cap_reached":
          return fail("cap_reached");
        default:
          return fail("not_waiting");
      }
    }
    await this.deps.codex.followUp(target.id, text, msgId);
    return OK;
  }

  private async questionAnswer(frame: Record<string, unknown>, msgId: string, record: () => void): Promise<Outcome> {
    const alertId = nonEmptyString(frame.alertId, MAX_MSG_ID_CHARS);
    const requestRef = nonEmptyString(frame.requestRef, 512);
    const alert = alertId ? this.alerts.get(alertId) : undefined;
    const binding = alertId ? this.bindings.get(alertId) : undefined;
    if (!alertId || !requestRef || !alert || binding?.kind !== "question" || !alert.question) {
      return fail("unknown_alert");
    }
    // An answer belongs to the alert's own session and request, not to what the frame claims.
    if (frame.sessionKey !== alert.sessionKey) {
      return fail("wrong_session");
    }
    if (requestRef !== binding.requestRef) {
      return fail("wrong_request");
    }
    const target = this.target(frame.sessionKey);
    if ("ok" in target) {
      return target;
    }
    const answers = this.parseAnswers(frame.answers);
    if (!answers) {
      return fail("bad_answers");
    }
    record();
    if (alert.question.source === "claude_tool") {
      return this.deps.questionRelay.answer(requestRef, answers, msgId) ? OK : fail("not_waiting");
    }
    const result = await this.deps.codex.answerQuestion(requestRef, answers, msgId);
    return result === "unknown" ? fail("unknown_question") : OK;
  }

  private parseAnswers(value: unknown): Record<string, string | string[]> | undefined {
    const record = asRecord(value);
    if (!record || Object.keys(record).length === 0 || Object.keys(record).length > MAX_ANSWER_ENTRIES) {
      return undefined;
    }
    // No prototype, and no key that could reach one: the answers go on to be
    // spread and indexed by question text the phone chose.
    const answers: Record<string, string | string[]> = Object.create(null);
    for (const [question, answer] of Object.entries(record)) {
      if (question.length > MAX_ANSWER_CHARS || FORBIDDEN_ANSWER_KEYS.has(question)) {
        return undefined;
      }
      const parts = Array.isArray(answer) ? answer : [answer];
      if (
        parts.length > MAX_ANSWER_ENTRIES ||
        parts.some((part) => typeof part !== "string" || part.length > MAX_ANSWER_CHARS)
      ) {
        return undefined;
      }
      answers[question] = Array.isArray(answer) ? [...answer as string[]] : answer as string;
    }
    return answers;
  }

  private modeSet(frame: Record<string, unknown>, record: () => void): Outcome {
    const target = this.target(frame.sessionKey);
    if ("ok" in target) {
      return target;
    }
    const mode = frame.mode;
    if (mode !== "ask" && mode !== "acceptEdits" && mode !== "approveAll") {
      return fail("bad_mode");
    }
    // The policy refuses this too; asking here keeps a refusal from spending the id.
    if (mode === "approveAll" && frame.confirmed !== true) {
      return fail("confirm_required");
    }
    // policy.set does not know about attachment, which is why target() asked.
    record();
    let result;
    try {
      result = this.deps.approvalPolicy.set(target.key, mode as TempMode, frame.confirmed === true);
    } catch {
      return fail("state_unwritable");
    }
    if (!result.ok) {
      return fail(result.error);
    }
    this.republish(target.key);
    return OK;
  }

  private modeRevokeAll(record: () => void): Outcome {
    record();
    // revokeAll's notices are not queued anywhere: announcing them is on us.
    for (const notice of this.deps.approvalPolicy.revokeAll()) {
      this.announceReset(notice);
    }
    return OK;
  }

  private codexSettings(frame: Record<string, unknown>, record: () => void): Outcome {
    const target = this.target(frame.sessionKey);
    if ("ok" in target) {
      return target;
    }
    if (target.provider !== "codex") {
      return fail("unsupported");
    }
    const model = frame.model === undefined ? undefined : nonEmptyString(frame.model, MAX_SETTING_CHARS);
    const effort = frame.effort === undefined ? undefined : nonEmptyString(frame.effort, MAX_SETTING_CHARS);
    if ((frame.model !== undefined && !model) || (frame.effort !== undefined && !effort) || (!model && !effort)) {
      return fail("bad_settings");
    }
    record();
    this.deps.codex.setPendingSettings(target.id, { model, effort });
    return OK;
  }

  private async codexCompact(frame: Record<string, unknown>, record: () => void): Promise<Outcome> {
    const target = this.target(frame.sessionKey);
    if ("ok" in target) {
      return target;
    }
    if (target.provider !== "codex") {
      return fail("unsupported");
    }
    record();
    await this.deps.codex.compact(target.id);
    return OK;
  }

  private defaultsSet(frame: Record<string, unknown>, record: () => void): Outcome {
    const defaultModes = parseDefaultModes(frame.defaultModes);
    if (!defaultModes) {
      return fail("invalid_default");
    }
    record();
    try {
      this.deps.settings.update({ defaultModes });
    } catch {
      return fail("state_unwritable");
    }
    // Only sessions attached from now on start in it; the ones already running keep their mode.
    this.deps.approvalPolicy.setDefaults(defaultModes);
    return OK;
  }

  /**
   * The phone owns the alert thresholds and the wait limit. Not steering, so a
   * plaintext link may send it; for that reason it must never carry the default
   * approval modes, which are.
   */
  private settingsSync(frame: Record<string, unknown>, channel: PhoneChannel): void {
    const msgId = nonEmptyString(frame.msgId, MAX_MSG_ID_CHARS) ?? "";
    if (!msgId) {
      this.ack(channel, "", "rejected", "bad_msg_id");
      return;
    }
    const timings = asRecord(frame.timings);
    if ("defaultModes" in frame || (timings && "defaultModes" in timings)) {
      this.ack(channel, msgId, "rejected", "default_modes_not_allowed");
      return;
    }
    const parsedTimings = parseTimings(frame.timings);
    const waitLimitMs = parseWaitLimitMs(frame.waitLimitMs);
    if (!parsedTimings || waitLimitMs === undefined) {
      this.ack(channel, msgId, "rejected", "bad_settings");
      return;
    }
    try {
      this.deps.settings.update({ timings: parsedTimings, waitLimitMs });
    } catch {
      this.ack(channel, msgId, "rejected", "state_unwritable");
      return;
    }
    this.alerts.setTimings(parsedTimings);
    this.deps.stopWait.setWaitLimitMs(waitLimitMs);
    this.deps.questionRelay.setWaitLimitMs(waitLimitMs);
    this.ack(channel, msgId, "applied");
  }

  private async modelsRequest(frame: Record<string, unknown>, channel: PhoneChannel): Promise<void> {
    const parsed = parseSessionKey(frame.sessionKey);
    // An unattached session gets nothing, not even a refusal.
    if (!parsed || !this.deps.attachRegistry.isAttached(parsed.provider, parsed.id)) {
      return;
    }
    const sessionKey = sessionKeyOf(parsed.provider, parsed.id);
    if (parsed.provider === "claude") {
      // Plugin mode cannot change the model, so there is nothing to choose from.
      channel.send({ type: "models", v: 2, sessionKey, models: [], efforts: [], current: {} });
      return;
    }
    let models: string[] = [];
    try {
      models = await this.deps.codex.listModels();
    } catch {
      // A phone that gets an empty list shows no choices, which is the truth.
    }
    const { applied } = this.deps.codex.settings(parsed.id);
    channel.send({
      type: "models",
      v: 2,
      sessionKey,
      models,
      efforts: [...CODEX_EFFORTS],
      current: applied,
    });
  }
}
