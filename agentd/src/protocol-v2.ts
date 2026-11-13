/**
 * Rokid-Coder wire protocol v2: frame types shared by both phone transports
 * (PhoneLink's newline-delimited TCP and WsHub's WebSocket). Types and the
 * frame classification only; handlers live with the tasks that own them.
 */
import type { AgentProvider } from "./types";

export type SessionKey = `${AgentProvider}:${string}`;

export function sessionKeyOf(provider: AgentProvider, id: string): SessionKey {
  return `${provider}:${id}`;
}

export type TempMode = "ask" | "acceptEdits" | "approveAll";
export type DefaultMode = "ask" | "acceptEdits";

export interface AlertTimings {
  ageBoostMs: number;
  dwellMs: number;
  ackTimeoutMs: number;
  retryBackoffMs: number[];
  reminderMs: number;
  expireMs: number;
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
  waiting: number;
}

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

export type AgentToPhoneFrameV2 =
  | SessionUpsertFrameV2
  | AlertFrame
  | AckFrame
  | FollowupClosedFrame
  | ModeResetFrame
  | ModelsFrame;

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
  | DefaultsSetFrame
  | SettingsSyncFrame
  | ModelsRequestFrame;

export type FrameClass = "monitor" | "steering";

/**
 * Steering frames change what a session does and are accepted only over a
 * trusted (TLS) link; monitor frames only read or acknowledge state, so a
 * plaintext link may carry them. The tables are exhaustive for v1 and v2, and
 * anything not listed is steering so a new frame is closed until classified.
 */
const FRAME_CLASS: Readonly<Record<string, FrameClass>> = Object.freeze({
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
  defaults_set: "steering",
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
  settings_sync: "monitor",
  models_request: "monitor",
});

export function classifyFrame(type: string): FrameClass {
  return Object.prototype.hasOwnProperty.call(FRAME_CLASS, type)
    ? FRAME_CLASS[type]
    : "steering";
}
