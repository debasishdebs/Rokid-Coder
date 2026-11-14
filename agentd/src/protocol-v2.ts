/**
 * Rokid-Coder wire protocol v2: frame types shared by both phone transports
 * (PhoneLink's newline-delimited TCP and WsHub's WebSocket). Types and the
 * frame classification only; handlers live with the tasks that own them.
 */
import { isSteeringAllowed } from "./tls";
import type { AgentProvider, Session } from "./types";

export type SessionKey = `${AgentProvider}:${string}`;

export function sessionKeyOf(provider: AgentProvider, id: string): SessionKey {
  return `${provider}:${id}`;
}

export type TempMode = "ask" | "acceptEdits" | "approveAll";
export type DefaultMode = "ask" | "acceptEdits";

/**
 * The alert thresholds the phone owns. There is no expiry here: an alert lives
 * exactly as long as the wait limit Y (`waitLimitMs`), so it can never end
 * before the hold it stands for. An `expireMs` sent anyway is ignored.
 */
export interface AlertTimings {
  ageBoostMs: number;
  dwellMs: number;
  ackTimeoutMs: number;
  retryBackoffMs: number[];
  reminderMs: number;
}

export interface QuestionItem {
  text: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowFreeText: boolean;
}

export interface QuestionPayload {
  requestRef: string;
  source: "claude_tool" | "codex_async" | "codex_rpc";
  items: QuestionItem[];
}

export type AlertKind = "approval" | "question" | "error" | "done" | "notice";

export type FollowupState = "waiting" | "unavailable" | "cap_reached" | "ready";

// agent -> phone

export interface SessionUpsertV2Fields {
  mode: "plugin" | "launcher";
  capabilities: {
    compact: boolean;
    model: boolean;
    followup: FollowupState;
  };
  tempMode: TempMode;
  nativeMode?: string;
  heading: string;
  currentFile?: string;
  step?: string;
  context?: { used: number; window: number };
  pendingSettings?: { model?: string; effort?: string };
  sandbox?: string;
}

/** The v2 additions to a v1 `session_upsert`; `session` keeps its v1 shape. */
export interface SessionUpsertFrameV2 {
  type: "session_upsert";
  v: 2;
  seq: number;
  session: Record<string, unknown> & SessionUpsertV2Fields;
}

export type AlertSendReason = "new" | "retry" | "reminder" | "resume" | "update";

export interface AlertFrame {
  type: "alert";
  v: 2;
  id: string;
  sessionKey: SessionKey;
  kind: AlertKind;
  title: string;
  body: string;
  actions?: string[];
  question?: QuestionPayload;
  /**
   * Set (always `true`) on an approval whose command or path did not fit the
   * body whole (R128). The glasses then offer no Allow: only Deny, or the laptop.
   */
  truncated?: boolean;
  waiting: number;
  /**
   * Why this frame is being sent. `update` re-sends the occupant only to carry
   * a new `waiting`; it changes nothing about the alert's delivery.
   */
  reason: AlertSendReason;
}

/**
 * The answer to every steering frame. `applied` and `duplicate` both mean the
 * frame took effect once; `rejected` never consumes the msgId, so the phone may
 * resend the same frame once the cause (`error`) is gone.
 */
export interface AckFrame {
  type: "ack";
  v: 2;
  msgId: string;
  result: "applied" | "duplicate" | "rejected";
  error?: string;
}

export interface FollowupClosedFrame {
  type: "followup_closed";
  v: 2;
  sessionKey: SessionKey;
  reason: "timeout" | "laptop" | "cancelled" | "delivered";
}

export interface ModeResetFrame {
  type: "mode_reset";
  v: 2;
  sessionKey: SessionKey;
  from: TempMode;
  reason: "session_ended" | "helper_restarted" | "revoked";
}

export interface ModelsFrame {
  type: "models";
  v: 2;
  sessionKey: SessionKey;
  models: string[];
  efforts: string[];
  current: { model?: string; effort?: string };
}

export type AlertClosedReason = "acted" | "dismissed" | "expired" | "withdrawn";

/** An alert left the queue for a reason the glasses did not cause (a dismiss is theirs, so it is never sent). */
export interface AlertClosedFrame {
  type: "alert_closed";
  v: 2;
  id: string;
  reason: AlertClosedReason;
}

/** The v1 reply to a detail_open for a session that is not attached. */
export interface DetailRejectedFrame {
  type: "detail_rejected";
  sessionId: string;
  error: "not_attached";
}

/** The whole board, first thing on every link and in answer to `refresh`. */
export interface SnapshotFrameV2 {
  type: "snapshot";
  v: 2;
  seq: number;
  sessions: Array<Record<string, unknown> & SessionUpsertV2Fields>;
}

/**
 * The v1 approval frames still go to trusted phones next to each approval
 * alert. They carry the same request: a phone that renders the alert should
 * deduplicate them by `requestId` rather than show the request twice. The frame
 * is exactly this: agentd's internal `provider`, `sessionKey` and `approvalKind`
 * are stripped before it is sent (`toWireFrame`), so the session's harness comes
 * from the alert, not from this frame.
 */
export interface ApprovalRequestFrameV1 {
  type: "approval_request";
  v: 1;
  requestId: string;
  sessionId: string;
  tool: string;
  summary: string;
  detail: string;
  createdAt: number;
}

export interface ApprovalResolvedFrameV1 {
  type: "approval_resolved";
  v: 1;
  requestId: string;
  outcome: "allow" | "deny" | "timeout" | "local";
}

export type AgentToPhoneFrameV2 =
  | SnapshotFrameV2
  | SessionUpsertFrameV2
  | ApprovalRequestFrameV1
  | ApprovalResolvedFrameV1
  | AlertFrame
  | AlertClosedFrame
  | DetailRejectedFrame
  | AckFrame
  | FollowupClosedFrame
  | ModeResetFrame
  | ModelsFrame
  | LinkTrustFrame;

// phone -> agent

export interface AlertShownFrame {
  type: "alert_shown";
  v: 2;
  id: string;
}

export interface AlertActionFrame {
  type: "alert_action";
  v: 2;
  id: string;
  action: string;
  msgId: string;
}

export interface AlertDismissedFrame {
  type: "alert_dismissed";
  v: 2;
  id: string;
}

export interface FollowupFrame {
  type: "followup";
  v: 2;
  sessionKey: SessionKey;
  text: string;
  msgId: string;
}

export interface QuestionAnswerFrame {
  type: "question_answer";
  v: 2;
  sessionKey: SessionKey;
  alertId: string;
  requestRef: string;
  answers: Record<string, string | string[]>;
  msgId: string;
}

export interface ModeSetFrame {
  type: "mode_set";
  v: 2;
  sessionKey: SessionKey;
  mode: TempMode;
  confirmed: boolean;
  msgId: string;
}

export interface ModeRevokeAllFrame {
  type: "mode_revoke_all";
  v: 2;
  msgId: string;
}

export interface CodexSettingsFrame {
  type: "codex_settings";
  v: 2;
  sessionKey: SessionKey;
  model?: string;
  effort?: string;
  msgId: string;
}

export interface CodexCompactFrame {
  type: "codex_compact";
  v: 2;
  sessionKey: SessionKey;
  msgId: string;
}

/**
 * Compact or model change for a session an `rk claude` launcher holds. A
 * session no live launcher holds is answered `ack rejected error=not_launcher`;
 * a bound one gets the launcher's real result (R130).
 */
export interface LauncherCommandFrame {
  type: "launcher_command";
  v: 2;
  sessionKey: SessionKey;
  command: "compact" | "model";
  model?: string;
  msgId: string;
}

export interface DefaultsSetFrame {
  type: "defaults_set";
  v: 2;
  defaultModes: { claude: DefaultMode; codex: DefaultMode };
  msgId: string;
}

export interface SettingsSyncFrame {
  type: "settings_sync";
  v: 2;
  timings: AlertTimings;
  waitLimitMs: number;
  msgId: string;
}

export interface ModelsRequestFrame {
  type: "models_request";
  v: 2;
  sessionKey: SessionKey;
}

export type PhoneToAgentFrameV2 =
  | AlertShownFrame
  | AlertActionFrame
  | AlertDismissedFrame
  | FollowupFrame
  | QuestionAnswerFrame
  | ModeSetFrame
  | ModeRevokeAllFrame
  | CodexSettingsFrame
  | CodexCompactFrame
  | LauncherCommandFrame
  | DefaultsSetFrame
  | SettingsSyncFrame
  | ModelsRequestFrame;

/**
 * Live trust changed on this link (R126): sent when a rotated steer or a
 * forgotten phone revokes steering, just before agentd drops the link. A
 * phone that hears `steering: false` stops steering and asks for a re-pair.
 */
export interface LinkTrustFrame {
  type: "link_trust";
  v: 2;
  steering: boolean;
}

export function linkTrustFrame(steering: boolean): LinkTrustFrame & Record<string, unknown> {
  return { type: "link_trust", v: 2, steering };
}

export type FrameClass = "monitor" | "steering";

/**
 * Steering frames change what a session does and are accepted only over a
 * trusted (TLS) link; monitor frames only read or acknowledge state, so a
 * plaintext link may carry them. The tables are exhaustive for v1 and v2, and
 * anything not listed is steering so a new frame is closed until classified.
 */
export const FRAME_CLASS: Readonly<Record<string, FrameClass>> = Object.freeze({
  approval_decision: "steering",
  session_input: "steering",
  thread_start: "steering",
  alert_action: "steering",
  followup: "steering",
  question_answer: "steering",
  mode_set: "steering",
  mode_revoke_all: "steering",
  codex_settings: "steering",
  codex_compact: "steering",
  launcher_command: "steering",
  defaults_set: "steering",
  // Only a phone that can be held for (a trusted one) has any use for the
  // thresholds and the wait limit, and both decide how long holds last.
  settings_sync: "steering",
  hello: "monitor",
  hello_ack: "monitor",
  hello_reject: "monitor",
  refresh: "monitor",
  detail_open: "monitor",
  detail_close: "monitor",
  ping: "monitor",
  pong: "monitor",
  fs_list: "monitor",
  alert_shown: "monitor",
  alert_dismissed: "monitor",
  models_request: "monitor",
});

export function classifyFrame(type: string): FrameClass {
  return Object.prototype.hasOwnProperty.call(FRAME_CLASS, type)
    ? FRAME_CLASS[type]
    : "steering";
}

/** `provider:id`, taken apart; undefined for anything that is not an exact session key. */
export function parseSessionKey(value: unknown): { provider: AgentProvider; id: string } | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const id = value.slice(separator + 1);
  return separator > 0 && id.length > 0 && (provider === "claude" || provider === "codex")
    ? { provider, id }
    : undefined;
}

/**
 * One phone connection as the frame handlers see it, whichever transport it
 * came in on. `trusted` is true only for a link that has proved who it is: a
 * TLS connection whose peer was checked against a pin. It is read per
 * connection, so one phone's trust never covers another's.
 */
export interface PhoneChannel {
  readonly transport: "phonelink" | "wshub";
  readonly trusted: boolean;
  send(frame: Record<string, unknown>): void;
}

export type AuthorizeResult = { ok: true } | { ok: false; error: "monitor_only" };

/** The one authorization decision, made before any handler sees a frame. */
export function authorize(frame: { type?: unknown }, link: Pick<PhoneChannel, "trusted">): AuthorizeResult {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (classifyFrame(type) === "steering" && !isSteeringAllowed({ tls: link.trusted === true })) {
    return { ok: false, error: "monitor_only" };
  }
  return { ok: true };
}

function correlationId(frame: Record<string, unknown>): string {
  for (const key of ["msgId", "id", "requestId"]) {
    const value = frame[key];
    if (typeof value === "string" && value.length > 0) {
      return value.slice(0, 128);
    }
  }
  return "";
}

/**
 * The gate both transports run first on every frame after hello. True means
 * the frame may go to a handler; false means it was refused here and answered,
 * so nothing downstream ran. A v1 frame that expects its own reply also gets it,
 * or the existing phone plugin would wait on an answer that never comes.
 */
export function gateFrame(frame: Record<string, unknown>, link: PhoneChannel): boolean {
  const verdict = authorize(frame, link);
  if (verdict.ok) {
    return true;
  }
  const ack: AckFrame = {
    type: "ack",
    v: 2,
    msgId: correlationId(frame),
    result: "rejected",
    error: verdict.error,
  };
  link.send({ ...ack });
  const id = typeof frame.id === "string" ? frame.id : undefined;
  if (id && frame.type === "session_input") {
    link.send({ type: "session_input_result", id, ok: false, error: verdict.error });
  } else if (id && frame.type === "thread_start") {
    link.send({ type: "thread_started", id, ok: false, provider: null, error: verdict.error });
  }
  return false;
}

/**
 * What a transport needs from the v2 layer. Absent, a transport speaks exactly
 * the v1 frames it always did.
 */
export interface PhoneV2Hooks {
  /** True when the frame was a v2 (or unknown) one and is dealt with; false leaves v1 frames to the transport. */
  handle(frame: Record<string, unknown>, channel: PhoneChannel): boolean;
  /** The session as published to the phone, with the v2 fields. */
  decorate(session: Session): Record<string, unknown>;
}
