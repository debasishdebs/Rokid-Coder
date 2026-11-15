import { rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  ApprovalManager,
  type ApprovalTransport,
  type HookResponse,
} from "./approval-manager";
import { handleAttachCommand, hookProvider } from "./attach-command";
import { AppliedIds } from "./applied-ids";
import { ApprovalPolicy, type ResetNotice } from "./approval-policy";
import { AttachRegistry, NotAttachedError } from "./attach-registry";
import { spawnClaudeThread } from "./claude-spawn";
import { CodexMonitor } from "./codex/monitor";
import { DEFAULT_WAIT_LIMIT_SEC, configPath, defaultStateDir, ensureConfig } from "./config";
import { claudeSessionGone, discoverRecentSessions } from "./discovery";
import { HookHttpServer } from "./http-server";
import { claudeSessionsDir, liveClaudeSessionIds, readClaudeSession } from "./launcher/claude-sessions";
import { LauncherHub } from "./launcher/launcher-hub";
import { bestHostGuess } from "./pairing";
import { PairingCoordinator } from "./pairing/coordinator";
import { COMPACT_LIMIT_MS, LauncherRouter, READY_WAIT_MS, SessionStates } from "./launcher/session-state";
import { FileLogger } from "./logger";
import { SessionStore } from "./session-store";
import { DEFAULT_STOP_CONTINUATION_CAP, StopWait } from "./stop-wait";
import { TerminalTargets, createTerminalInputHandler } from "./terminal-input";
import { PhoneLink } from "./phone-link";
import { PhoneV2, type PhoneOutlet } from "./phone-v2";
import { PhoneSettingsStore } from "./phone-settings";
import { QuestionRelay } from "./question-relay";
import { TranscriptTailManager, readTranscriptHeading } from "./transcript";
import { DETAIL_MESSAGE_LIMIT, readRecentMessages } from "./transcript-messages";
import { sessionKeyOf } from "./protocol-v2";
import { DAY_MS, ensureAgentCert, ensureSteerSecret, PinStore, readSteerSecret, steerSecretFile } from "./tls";
import type { AgentProvider, HookPayload } from "./types";
import { WsHub } from "./ws-server";

export interface RunningDaemon {
  config: ReturnType<typeof ensureConfig>;
  sessions: SessionStore;
  attachRegistry: AttachRegistry;
  /** Temporary approval modes; the phone's mode_set and defaults_set frames drive it (Task 9). */
  approvalPolicy: ApprovalPolicy;
  /** Drains the reset notices queued since the last call, restart notices first. */
  takeResetNotices(): ResetNotice[];
  /**
   * Glasses follow-ups for attached Claude sessions. The phone's followup frame
   * calls deliver and its settings call setWaitLimitMs (Task 9); onRelease is
   * where followup_closed comes from.
   */
  stopWait: StopWait;
  /**
   * AskUserQuestion holds for attached Claude sessions. The phone's
   * question_answer frame calls answer for source claude_tool; onOpened and
   * onClosed are where the question alerts come from (Task 9).
   */
  questionRelay: QuestionRelay;
  /**
   * Codex follow-ups, compact, context fill, models and questions. Its
   * answerQuestion serves question_answer for codex_async and codex_rpc.
   */
  codex: CodexMonitor;
  /** Phone protocol v2: inbound frames, alerts and session enrichment for both transports. */
  phoneV2: PhoneV2;
  /** Held tool approvals; each lives for the wait limit Y and ends with its alert. */
  approvals: ApprovalManager;
  /** The `rk` launchers' socket and the session bindings it proves. */
  launchers: LauncherHub;
  /** Readiness of launcher-bound sessions, and the glasses' commands and late follow-ups into them. */
  launcherRouter: LauncherRouter;
  isTailing(sessionId: string): boolean;
  /** The once-a-minute housekeeping: stalled sessions, and approve-all for Claude sessions that are gone. */
  sweepSessions(): Promise<void>;
  /** The hourly pairing expiry: forgets phones unused for the TTL, returning their fingerprints. */
  sweepPairings(now?: number): string[];
  stop(): Promise<void>;
}

export interface DaemonOptions {
  /** Test seam: keeps the UDP announce broadcast off the well-known port. */
  discoveryPort?: number;
}

const APPLIED_ID_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_QUEUED_RESET_NOTICES = 64;
const PAIRING_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How long `/rokid:on` waits for a launcher it asked to bind again before it answers. */
const REBIND_REPLY_WAIT_MS = 1000;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long agentd waits for its hook port, which a CLI writing the pins (or another agentd) may hold. */
const HOOK_PORT_WAIT_MS = 5_000;

async function bindHookPort(server: HookHttpServer, port: number): Promise<void> {
  const deadline = Date.now() + HOOK_PORT_WAIT_MS;
  for (;;) {
    try {
      await server.bind();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(
            `127.0.0.1:${port} is still taken after ${HOOK_PORT_WAIT_MS / 1000} s: another agentd is running, or a CLI is ` +
              "changing the phone pins. Stop the other agentd, or try again in a moment.",
          ),
          { code: "EADDRINUSE" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

export async function startDaemon(daemonOptions: DaemonOptions = {}): Promise<RunningDaemon> {
  const stateDir = defaultStateDir();
  const config = ensureConfig(stateDir);
  const logger = new FileLogger(stateDir);
  const attachRegistry = new AttachRegistry({
    file: path.join(config.rokidCoder.stateDir, "attached.json"),
    logger,
  });
  const approvalPolicy = new ApprovalPolicy({
    file: path.join(config.rokidCoder.stateDir, "approve-all.json"),
    logger,
  });
  // Reset notices wait here, in memory, until PhoneV2 drains them with
  // takeResetNotices into mode_reset frames and notice alerts.
  const queuedResetNotices: ResetNotice[] = [];
  const takeResetNotices = (): ResetNotice[] => [
    ...approvalPolicy.takeRestartNotices(),
    ...queuedResetNotices.splice(0),
  ];
  const resetApprovalMode = (provider: AgentProvider, id: string): void => {
    const notice = approvalPolicy.endSession(sessionKeyOf(provider, id));
    if (notice) {
      // They wait here while no phone is connected, so a phone that never comes
      // back must not let them pile up for good.
      if (queuedResetNotices.length >= MAX_QUEUED_RESET_NOTICES) {
        queuedResetNotices.shift();
      }
      queuedResetNotices.push(notice);
      logger.info("approval_mode_reset", { reason: notice.reason, from: notice.from });
    }
  };
  const endApprovalSession = (provider: AgentProvider, id: string): void => {
    resetApprovalMode(provider, id);
    phoneV2?.onSessionEnded(provider, id);
  };
  // Either transport counts, as for approvals: a phone that dialled in is as
  // good as one the daemon dialled. Read at hook time, after both exist. Every
  // accepted link is a trusted one (pinned TLS both ways); one that is losing
  // its trust, its phone forgotten, no longer holds anything.
  const trustedPhoneConnected = (): boolean =>
    phoneLink?.trustedConnected === true || wsHub?.hasTrustedClient === true;
  const stopWait = new StopWait({
    waitLimitMs: (config.rokidCoder.waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC) * 1000,
    continuationCap: DEFAULT_STOP_CONTINUATION_CAP,
    canAsk: trustedPhoneConnected,
  });
  // No phone frame carries a release yet; until followup_closed exists the log
  // is the only trace of how a wait ended.
  stopWait.onRelease((_sessionId, reason) => logger.info("stop_wait_released", { reason }));
  const questionRelay = new QuestionRelay({
    waitLimitMs: (config.rokidCoder.waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC) * 1000,
    canAsk: trustedPhoneConnected,
  });
  questionRelay.onClosed(({ reason }) => logger.info("question_released", { reason }));
  const sessions = new SessionStore(config, logger, Date.now, {
    isAttached: (provider, id) => attachRegistry.isAttached(provider, id),
  });
  const claudeDir = process.env.NEXUS_AGENTD_CLAUDE_DIR || path.join(homedir(), ".claude");
  const launcherSessionsDir = claudeSessionsDir(claudeDir);
  // No launcher has reconnected yet, so no session can be in launcher mode.
  // Before anything subscribes to the registry, which this does not notify.
  const liveIds = liveClaudeSessionIds(launcherSessionsDir);
  attachRegistry.reconcileLaunchers({
    isSessionLive: liveIds ? (key) => key.startsWith("claude:") && liveIds.has(key.slice("claude:".length)) : undefined,
  });
  const launchers = new LauncherHub({
    configDir: config.rokidCoder.stateDir,
    claudeSessionsDir: launcherSessionsDir,
    logger,
    registry: attachRegistry,
    // The plugin's pair command arrives here, from the hook forwarder (R156).
    // It only opens the window: the code is confirmed in a terminal and on the phone.
    armPairing: () => {
      pairing.openWindow();
    },
    // R208: while agentd runs, the CLI's pin changes are made here, by the one writer.
    pins: {
      change: (op, fp) => {
        logger.info("phone_pins_changed", { op, via: "cli" });
        if (op === "forget") {
          const removed = pins.forget(fp ?? "");
          return { removed: removed.length, empty: pins.isEmpty() };
        }
        if (op === "forget_all") {
          pins.forgetAll();
          return {};
        }
        return { until: pins.armAllowNext(Date.now()) };
      },
    },
    pairing: {
      open: () => {
        pairing.openWindow();
      },
      watch: (listener) => pairing.watch((status) => listener({ ...status })),
      confirm: (attempt, ok) => {
        pairing.confirm(attempt, ok);
      },
    },
    // Claude's SessionStart came before the bind and was dropped as unattached;
    // an idle session at its prompt is shown to the phone now, not at the first prompt.
    // M7: only a session the store has no record of; a rebind after a reconnect
    // or /rokid:on must not reset one (a pending prompt the phone shows, say).
    onBound: ({ sessionId, status, cwd }) => {
      if (status === "idle" && !sessions.get(sessionId)) {
        sessions.handleHook({
          session_id: sessionId,
          ...(cwd ? { cwd } : {}),
          hook_event_name: "SessionStart",
        });
      }
    },
  });
  // agentd's own read of the file Claude keeps for the bound process (R55).
  const launcherStates = new SessionStates(
    (claudePid) => {
      const file = readClaudeSession(launcherSessionsDir, claudePid);
      return file && { status: file.status, statusUpdatedAt: file.statusUpdatedAt ?? 0, sessionId: file.sessionId };
    },
    Date.now,
    {
      binding: (key) => launchers.binding(key),
      held: (key) => key.startsWith("claude:") && stopWait.state(key.slice("claude:".length)).waiting,
      asking: (key) => {
        const id = key.slice(key.indexOf(":") + 1);
        return approvals?.hasPendingForSession(id) === true || questionRelay.hasPendingForSession(id);
      },
      clearUncertain: (key) => launchers.setUncertain(key, false),
    },
  );
  // The environment overrides exist only so tests need not wait the windows out.
  const launcherRouter = new LauncherRouter({
    port: launchers,
    states: launcherStates,
    timings: {
      readyWaitMs: envMs("ROKID_LAUNCHER_READY_WAIT_MS", READY_WAIT_MS),
      compactLimitMs: envMs("ROKID_LAUNCHER_COMPACT_LIMIT_MS", COMPACT_LIMIT_MS),
    },
    onStateChange: (key) => phoneV2?.onLauncherChange(key),
  });
  // Synchronous, inside the release: the session is busy before the Stop hook's
  // response is written (Review Focus 2).
  stopWait.onRelease((sessionId, reason) => {
    if (reason === "delivered") {
      launcherRouter.onStopDelivered(sessionKeyOf("claude", sessionId));
    } else {
      launcherRouter.onHoldReleased(sessionKeyOf("claude", sessionId));
    }
  });
  // R163: whatever now waits on the wearer or the laptop makes a reply queued
  // before it stale, so one not yet typed is cancelled.
  stopWait.onOpened((sessionId) => launcherRouter.onBlocked(sessionKeyOf("claude", sessionId)));
  questionRelay.onOpened(({ sessionKey }) => launcherRouter.onBlocked(sessionKey));
  const discovered = await discoverRecentSessions(path.join(claudeDir, "projects"), logger);
  for (const session of discovered) {
    sessions.addDiscovered(session);
  }

  let wsHub: WsHub | undefined;
  let phoneLink: PhoneLink | undefined;
  let approvals: ApprovalManager | undefined;
  let codexMonitor: CodexMonitor | undefined;
  let phoneV2: PhoneV2 | undefined;
  const tailManager = new TranscriptTailManager(
    (sessionId, update) => {
      sessions.applyTranscriptUpdate(sessionId, update);
      if (update.error) {
        phoneV2?.onClaudeError(sessionId, update.error);
      }
    },
    logger,
    (sessionId, message) => {
      wsHub?.broadcastDetailMessage(sessionId, message);
      phoneLink?.sendDetailMessage(sessionId, message);
    },
  );

  // Session ids reach the gates without a provider. A session the store knows
  // names its own; one it does not is a Claude id, since only Claude sessions
  // can be attached before they have produced a record.
  const isSessionAttached = (sessionId: string): boolean =>
    attachRegistry.isAttached(sessions.get(sessionId)?.provider ?? "claude", sessionId);

  const detailProvider = async (sessionId: string, limit: number) => {
    if (!isSessionAttached(sessionId)) {
      throw new NotAttachedError();
    }
    if (sessions.get(sessionId)?.provider === "codex") {
      try {
        return await codexMonitor?.readMessages(sessionId, limit) ?? [];
      } catch {
        return [];
      }
    }
    const transcriptPath = sessions.transcriptPath(sessionId);
    return transcriptPath ? readRecentMessages(transcriptPath, limit) : [];
  };
  // The tail only sees what is appended from now on, so a session attached mid-
  // conversation, or one the phone lost for a while, starts without the last
  // thing the assistant said. Rebuild that from the transcript's recent messages.
  // Tailing is already running when this reads, so nothing falls between the two;
  // a value the tail has already set is newer and is left alone.
  const seedRecentMessages = async (sessionId: string, transcriptPath: string): Promise<void> => {
    const recent = await readRecentMessages(transcriptPath, DETAIL_MESSAGE_LIMIT);
    let last: (typeof recent)[number] | undefined;
    for (const message of recent) {
      if (message.role === "assistant") {
        last = message;
      }
    }
    if (last && !sessions.get(sessionId)?.lastAssistantText) {
      sessions.applyTranscriptUpdate(sessionId, { activityAt: last.at, lastAssistantText: last.text });
    }
  };
  const rebuildAttachedClaudeSessions = (): void => {
    for (const entry of attachRegistry.list()) {
      const transcriptPath = entry.provider === "claude" ? sessions.transcriptPath(entry.id) : undefined;
      if (transcriptPath) {
        void seedRecentMessages(entry.id, transcriptPath);
      }
    }
  };
  // Reading a conversation also starts tailing it, so the view stays live
  // even for a session that had been quiet since the daemon started.
  // The live tail starts at the end of the file, so a session attached mid-
  // conversation would never see its own title; read it from the transcript once.
  const startTailing = (sessionId: string, transcriptPath: string): void => {
    const fresh = !tailManager.isTailing(sessionId);
    tailManager.start(sessionId, transcriptPath);
    if (fresh) {
      void readTranscriptHeading(transcriptPath)
        .then((heading) => {
          if (heading.aiTitle || heading.firstPrompt) {
            sessions.seedHeading(sessionId, heading);
          }
        })
        .catch(() => undefined);
      void seedRecentMessages(sessionId, transcriptPath);
    }
  };
  const onDetailOpen = (sessionId: string) => {
    if (!isSessionAttached(sessionId) || sessions.get(sessionId)?.provider === "codex") {
      return;
    }
    const transcriptPath = sessions.transcriptPath(sessionId);
    if (transcriptPath && !tailManager.isTailing(sessionId)) {
      startTailing(sessionId, transcriptPath);
    }
  };
  const processHook = (payload: HookPayload, closed: AbortSignal): HookResponse | Promise<HookResponse> => {
    const attachReply = handleAttachCommand(payload, {
      registry: attachRegistry,
      logger,
      // The block ends the turn, so no further hook would show the session
      // to the phone until the user's next prompt.
      onAttached: (hook, id) => {
        sessions.handleHook({
          session_id: id,
          cwd: hook.cwd,
          transcript_path: hook.transcript_path,
          hook_event_name: "SessionStart",
        });
        if (typeof hook.transcript_path === "string") {
          void seedRecentMessages(id, hook.transcript_path);
        }
      },
      isLauncherBound: (id) => launchers.binding(sessionKeyOf("claude", id)) !== undefined,
      launcherRebound: (id) => launchers.rebound(sessionKeyOf("claude", id), REBIND_REPLY_WAIT_MS),
      phones: {
        paired: () => {
          try {
            return !pins.isEmpty();
          } catch {
            return undefined;
          }
        },
      },
    });
    if (attachReply) {
      return attachReply;
    }
    // Codex hooks exist only to carry the attach phrase. Everything else about
    // a Codex thread, approvals included, comes over the app-server connection.
    if (hookProvider(payload) === "codex") {
      return {};
    }
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;
    // The opt-in gate for hooks: an unattached session leaves no trace, is never
    // tailed and is never held for an approval. What reaches here is Claude's.
    // The attach command is handled above this check, since it is how a
    // session gets through it.
    if (sessionId !== undefined && !attachRegistry.isAttached("claude", sessionId)) {
      return {};
    }
    sessions.handleHook(payload);
    const eventName = typeof payload.hook_event_name === "string" ? payload.hook_event_name : undefined;
    if (sessionId && eventName) {
      launcherRouter.onHook(sessionKeyOf("claude", sessionId), eventName, payload);
    }
    const transcriptPath =
      typeof payload.transcript_path === "string"
        ? payload.transcript_path
        : sessionId
          ? sessions.transcriptPath(sessionId)
          : undefined;
    if (sessionId && eventName === "SessionEnd") {
      launcherRouter.endSession(sessionKeyOf("claude", sessionId));
      tailManager.stop(sessionId);
      approvals?.resolveSession(sessionId);
      stopWait.endSession(sessionId);
      questionRelay.endSession(sessionId);
      endApprovalSession("claude", sessionId);
      attachRegistry.endLauncherSession("claude", sessionId);
    } else if (sessionId && transcriptPath && sessions.get(sessionId)?.stale === false) {
      startTailing(sessionId, transcriptPath);
    }
    // The tool a prompt asked about ran, failed or was denied: whoever answered
    // it, the phone no longer can. Claude keeps the PermissionRequest hook open
    // after its own dialog is answered, so this is the only word of it.
    if (
      sessionId &&
      (eventName === "PostToolUse" || eventName === "PostToolUseFailure" || eventName === "PermissionDenied")
    ) {
      approvals?.settleByTool(sessionId, payload.tool_name, payload.tool_input);
      if (!approvals?.hasPendingForSession(sessionId)) {
        sessions.clearPermissionRequest(sessionId);
      }
      return {};
    }
    // PreToolUse still arrives, and is still what keeps the session's activity
    // current, but it is no longer what the wearer is asked about: it fires for
    // every tool call, so holding on it asked them to approve reads and greps
    // as well as the one command that actually needed them.
    if (eventName === "PermissionRequest") {
      // The PreToolUse relay answers (or deliberately leaves to the TUI) every
      // AskUserQuestion; an allow/deny from the phone would answer nothing.
      // ExitPlanMode is different: it is a real sign-off, never auto-allowed.
      if (payload.tool_name === "AskUserQuestion") {
        return {};
      }
      // R163: a permission prompt is now waiting, on the phone or at the laptop.
      if (sessionId) {
        launcherRouter.onBlocked(sessionKeyOf("claude", sessionId));
      }
      return approvals?.request(payload, closed) ?? {};
    }
    // Only a Claude session that is attached gets here, so these are the only
    // sessions that wait for the glasses. The attach commands were answered
    // above, which is why they never count as the wearer typing at the laptop.
    if (sessionId) {
      // A request still pending when the turn ends, or when the wearer types
      // a new prompt, was answered at the laptop in a way no other hook
      // reports (a dialog "No"). A later PreToolUse is no such sign: another
      // call of the same turn may still be waiting on its own prompt.
      if (eventName === "Stop") {
        approvals?.resolveSession(sessionId, "turn_ended");
        phoneV2?.onClaudeStop(sessionId);
        return stopWait.hold(sessionId, closed);
      }
      if (eventName === "PreToolUse") {
        stopWait.noteToolUse(sessionId);
        if (QuestionRelay.handles(payload)) {
          return questionRelay.hold(payload, closed);
        }
      } else if (eventName === "UserPromptSubmit" || eventName === "UserPromptExpansion") {
        if (eventName === "UserPromptSubmit") {
          approvals?.resolveSession(sessionId, "laptop_prompt");
          phoneV2?.onLaptopPrompt(sessionId);
        }
        stopWait.releaseByLaptop(sessionId);
        questionRelay.releaseByLaptop(sessionId);
      }
    }
    return {};
  };

  // Typing into a live session is the one thing --resume cannot do: it forks a
  // copy while the session's process exists, and two writers on one transcript
  // is how that record stops being true. A multiplexer can, because it is the
  // terminal. Off unless the owner turned it on.
  const terminalTargets = new TerminalTargets();
  const typeIntoTerminal = createTerminalInputHandler({
    enabled: () => config.allowTerminalInput,
    store: sessions,
    targets: terminalTargets,
  });
  const typeIntoSession: typeof typeIntoTerminal = async (sessionId, text) =>
    isSessionAttached(sessionId)
      ? typeIntoTerminal(sessionId, text)
      : { ok: false, error: "not_attached" };

  const tlsDir = path.join(config.rokidCoder.stateDir, "tls");
  const agentCert = await ensureAgentCert(tlsDir);
  ensureSteerSecret(tlsDir);
  // The only pin writer while it runs (R208). Its lock is the hook port (R209): bound before the first read
  // of the pins and held until stop, answering 503 until the daemon is up. The CLI asks over the launcher
  // socket instead, and writes directly only while it holds the port itself, so only when agentd is down.
  const httpServer = new HookHttpServer({
    port: config.httpPort,
    sessionCount: () => sessions.size,
    onHook: (payload, closed) => processHook(payload, closed),
    logger,
    extraHealth: () => ({ codex: codex.availability() }),
  });
  await bindHookPort(httpServer, config.httpPort);
  // The file lock an earlier build used; inert now.
  rmSync(path.join(tlsDir, "phone-pins.lock"), { recursive: true, force: true });
  const pins = new PinStore(path.join(tlsDir, "phone-pins.json"), { logger });
  // One window, one attempt, for both transports and every entry point.
  const pairing = new PairingCoordinator({
    config,
    pins,
    logger,
    steer: () => readSteerSecret(tlsDir),
    wsHost: () => bestHostGuess(),
  });
  const phoneSettings = new PhoneSettingsStore(
    path.join(config.rokidCoder.stateDir, "settings.json"),
    config.rokidCoder.waitLimitSec,
    logger,
  );
  // Read live: the phone's settings screen changes it, and the next check uses the new value.
  const pairingTtlMs = (): number => phoneSettings.get().pairingTtlDays * DAY_MS;
  // Both transports share one v2 layer, built once the pieces it needs exist.
  const v2Hooks = {
    handle: (frame: Record<string, unknown>, channel: Parameters<PhoneV2["handle"]>[1]) =>
      phoneV2?.handle(frame, channel) ?? false,
    decorate: (session: Parameters<PhoneV2["decorate"]>[0]) => phoneV2?.decorate(session) ?? { ...session },
  };

  // A phone came up on either transport: Claude sessions are rebuilt from their
  // transcripts, since the tail only sees new lines. A link that is now where
  // frames go (the outlet prefers the dialled link) also gets what was waiting
  // for one: open approvals, the alert on the glasses, resets nobody has been
  // told about. `trusted` is always true for an accepted link; a second phone
  // beside a trusted one must not make the first show it all again.
  const onPhoneConnected = (transport: "phonelink" | "wshub", trusted: boolean): void => {
    const nowPreferred = transport === "phonelink"
      ? trusted
      : trusted && !phoneLink?.trustedConnected && wsHub?.trustedClientCount === 1;
    if (nowPreferred) {
      approvals?.onLinkConnected();
      phoneV2?.onChannelConnected();
    }
    rebuildAttachedClaudeSessions();
  };
  // No trusted phone is left, so nothing held for one can be answered:
  // approvals, questions and Stop waits all go back to the laptop now.
  const releaseHoldsIfNoTrustedPhone = (): void => {
    if (!trustedPhoneConnected()) {
      approvals?.onLinkDisconnected();
      stopWait.releaseAll();
      questionRelay.releaseAll();
    }
  };
  // A phone went away on either transport. Unless the other transport still has
  // a trusted phone, what was held for one is released: expiring something that
  // can still be answered would only cost the wearer the answer. Frames go to
  // the dialled link when it is up, so only its loss strands anything; then the
  // other phone is sent what the link held.
  const onPhoneDisconnected = (lostTrustedDialledLink: boolean): void => {
    if (!trustedPhoneConnected()) {
      releaseHoldsIfNoTrustedPhone();
    } else if (lostTrustedDialledLink) {
      approvals?.onLinkConnected();
      phoneV2?.onChannelConnected();
    }
  };
  // A phone was forgotten or its steering secret rotated: the same release, now,
  // without waiting for its socket to close.
  const onPhoneTrustRevoked = releaseHoldsIfNoTrustedPhone;

  const hub = new WsHub(config, sessions, logger, {
    detailProvider,
    onDetailOpen,
    onApprovalDecision: (requestId, decision) => void approvals?.handleDecision(requestId, decision),
    onTerminalInput: typeIntoSession,
    tls: { key: agentCert.key, cert: agentCert.cert },
    // The same set the dialled link pins into, watched: `phones forget` cuts a wss phone off live.
    pins,
    pairing,
    pairingTtlMs,
    // Checked live, and the file watched: `pair --rotate-steer` cuts off connected phones without a restart.
    steer: () => readSteerSecret(tlsDir),
    steerFile: steerSecretFile(tlsDir),
    v2: v2Hooks,
    onClientConnected: (trusted) => onPhoneConnected("wshub", trusted),
    onClientDisconnected: () => onPhoneDisconnected(false),
    onTrustRevoked: onPhoneTrustRevoked,
  });
  wsHub = hub;
  const link = new PhoneLink({
    config,
    configFilePath: configPath(stateDir),
    store: sessions,
    logger,
    detailProvider,
    onDetailOpen,
    discoveryPort: daemonOptions.discoveryPort,
    onThreadStart: (provider, projectPath, prompt) => {
      if (provider === "claude") {
        return spawnClaudeThread(projectPath, prompt);
      }
      return codexMonitor?.startThread(projectPath, prompt) ?? Promise.resolve({
        ok: false,
        error: "Codex is not available on this computer",
      });
    },
    onApprovalDecision: (requestId, decision) => void approvals?.handleDecision(requestId, decision),
    onTerminalInput: typeIntoSession,
    pins,
    pairing,
    pairingTtlMs,
    clientCert: { key: agentCert.key, cert: agentCert.cert },
    v2: v2Hooks,
    onConnected: (trusted) => onPhoneConnected("phonelink", trusted),
    onDisconnected: (wasTrusted) => onPhoneDisconnected(wasTrusted),
    onTrustRevoked: onPhoneTrustRevoked,
  });
  phoneLink = link;
  // Either direction can carry an approval. The daemon dials the phone on the
  // zero-setup path, but a phone given a pairing line dials the daemon instead
  // and its link server is then deliberately stopped — so a transport that only
  // knew the dialled link left "paste the pairing line" with a session board and
  // no way to answer anything on it. Prefer the dialled link when both are up,
  // since that is the one the phone's own reconnect logic keeps warm.
  const approvalTransport: ApprovalTransport = {
    get connected(): boolean {
      return trustedPhoneConnected();
    },
    sendApprovalRequest: (request) =>
      link.trustedConnected
        ? link.sendApprovalRequest(request)
        : hub.sendApprovalRequest(request),
    sendApprovalResolved: (requestId, outcome) =>
      link.trustedConnected
        ? link.sendApprovalResolved(requestId, outcome)
        : hub.sendApprovalResolved(requestId, outcome),
  };
  approvals = new ApprovalManager({
    transport: approvalTransport,
    logger,
    // The phone's synced wait limit replaces this as soon as PhoneV2 starts.
    timeoutMs: (config.rokidCoder.waitLimitSec ?? DEFAULT_WAIT_LIMIT_SEC) * 1000,
    policy: approvalPolicy,
    observer: {
      onPending: (request) => phoneV2?.approvalObserver.onPending(request),
      onSettled: (request, outcome, reason) => phoneV2?.approvalObserver.onSettled(request, outcome, reason),
    },
  });
  const codex = new CodexMonitor({
    config,
    store: sessions,
    approvals,
    logger,
    isAttached: (threadId) => attachRegistry.isAttached("codex", threadId),
    onThreadEnded: (threadId) => endApprovalSession("codex", threadId),
  });
  codexMonitor = codex;
  const outlet: PhoneOutlet = {
    get connected(): boolean {
      return trustedPhoneConnected();
    },
    send: (frame) => (link.trustedConnected ? link.sendFrame(frame) : hub.broadcastFrame(frame)),
  };
  const phone = new PhoneV2({
    sessions,
    attachRegistry,
    approvalPolicy,
    approvals,
    stopWait,
    questionRelay,
    codex,
    settings: phoneSettings,
    appliedIds: new AppliedIds(
      path.join(config.rokidCoder.stateDir, "applied-ids.json"),
      APPLIED_ID_RETENTION_MS,
      Date.now,
      logger,
    ),
    outlet,
    launcher: launcherRouter,
    takeResetNotices,
    logger,
  });
  phoneV2 = phone;
  const subscribeCodex = (threadId: string): void => {
    codex.subscribe(threadId).catch((error: unknown) => {
      logger.warn("codex_subscribe_failed", { reason: error instanceof Error ? error.name : "unknown" });
    });
  };
  // Attaching a Codex thread subscribes to it; detaching undoes everything
  // attaching allowed. Pieces that do not exist yet (stop-waits, question
  // relays, alerts) subscribe to onChange themselves when they land.
  const stopListeningForDetach = attachRegistry.onChange(({ kind, entry }) => {
    if (kind === "attached") {
      approvalPolicy.applyDefault(sessionKeyOf(entry.provider, entry.id));
      if (entry.provider === "codex") {
        subscribeCodex(entry.id);
      }
      return;
    }
    tailManager.stop(entry.id);
    approvals?.resolveSession(entry.id);
    if (entry.provider === "claude") {
      // Before the hub's own listener unbinds it, so a command in flight is cancelled, not "exited".
      launcherRouter.endSession(sessionKeyOf("claude", entry.id));
      stopWait.endSession(entry.id);
      questionRelay.endSession(entry.id);
    }
    endApprovalSession(entry.provider, entry.id);
    sessions.removeSession(entry.id);
    if (entry.provider === "codex") {
      codex.unsubscribe(entry.id);
    }
  });
  // Threads attached in an earlier run are subscribed once the monitor connects.
  for (const entry of attachRegistry.list()) {
    if (entry.provider === "codex") {
      subscribeCodex(entry.id);
    }
  }
  // A Claude session killed outright (kill -9, a closed terminal) sends no
  // SessionEnd, and `claude --resume` would inherit its approve-all; once its
  // transcript or its process is gone, the mode ends as if it had.
  const sweepSessions = async (): Promise<void> => {
    sessions.sweepStalled();
    for (const entry of attachRegistry.list()) {
      const key = sessionKeyOf("claude", entry.id);
      if (entry.provider !== "claude" || approvalPolicy.get(key) !== "approveAll") {
        continue;
      }
      if (
        await claudeSessionGone(claudeDir, entry.id, sessions.transcriptPath(entry.id)) &&
        approvalPolicy.get(key) === "approveAll"
      ) {
        logger.info("approval_mode_session_gone", {});
        resetApprovalMode("claude", entry.id);
        phoneV2?.flushResets();
      }
    }
  };
  const heartbeatTimer = setInterval(() => {
    sweepSessions().catch(() => undefined);
  }, 60_000);
  heartbeatTimer.unref();
  // Pairings unused for the TTL are forgotten. The pins file is the signal: both
  // hubs watch it and cut off the forgotten phone's live link (link_trust false).
  const sweepPairings = (now: number = Date.now()): string[] => {
    try {
      // A provisional pin whose phone never proved its commit in time leaves nothing behind.
      pairing.expire();
      return pins.expire(now, pairingTtlMs());
    } catch (error) {
      logger.warn("phone_pairing_sweep_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  };
  sweepPairings();
  const pairingTimer = setInterval(() => sweepPairings(), PAIRING_SWEEP_INTERVAL_MS);
  pairingTimer.unref();

  try {
    await httpServer.start();
    await hub.start();
    link.start();
    codex.start();
    phone.start();
    await launchers.start();
    launcherRouter.start();
  } catch (error) {
    clearInterval(heartbeatTimer);
    clearInterval(pairingTimer);
    launcherRouter.stop();
    phone.stop();
    stopListeningForDetach();
    await launchers.stop();
    stopWait.dispose();
    questionRelay.dispose();
    link.stop();
    await codex.stop();
    await httpServer.stop().catch(() => undefined);
    await hub.stop().catch(() => undefined);
    tailManager.stopAll();
    sessions.dispose();
    throw error;
  }

  logger.info("daemon_started", {
    httpHost: "127.0.0.1",
    httpPort: config.httpPort,
    wsHost: "0.0.0.0",
    wsPort: config.wsPort,
    discoveredSessions: discovered.length,
  });

  let stopped = false;
  return {
    config,
    sessions,
    attachRegistry,
    approvalPolicy,
    stopWait,
    questionRelay,
    codex,
    phoneV2: phone,
    approvals,
    launchers,
    launcherRouter,
    takeResetNotices,
    isTailing: (sessionId) => tailManager.isTailing(sessionId),
    sweepSessions,
    sweepPairings,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(heartbeatTimer);
      clearInterval(pairingTimer);
      stopListeningForDetach();
      launcherRouter.stop();
      await launchers.stop();
      phone.stop();
      await codex.stop();
      approvals?.dispose();
      // Before the HTTP server: close() waits for open requests, and a held
      // Stop hook is one.
      stopWait.dispose();
      questionRelay.dispose();
      pairing.dispose();
      link.stop();
      tailManager.stopAll();
      await Promise.all([httpServer.stop(), hub.stop()]);
      sessions.dispose();
      logger.info("daemon_stopped");
    },
  };
}
