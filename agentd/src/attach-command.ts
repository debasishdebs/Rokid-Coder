import type { HookResponse } from "./approval-manager";
import type { AttachRegistry } from "./attach-registry";
import type { AgentProvider, HookPayload, Logger } from "./types";

export type AttachAction = "attach" | "detach" | "status";

const COMMAND = /^\s*\/rokid(?:\s+(off|status))?\s*$/;

/**
 * Recognises the opt-in command: `/rokid`, `/rokid off`, `/rokid status`. It is
 * case-sensitive and matches the whole prompt, so "/rokidx" and prose that
 * merely mentions the command are left alone.
 */
export function parseAttachCommand(prompt: unknown): { action: AttachAction } | undefined {
  if (typeof prompt !== "string") {
    return undefined;
  }
  const match = COMMAND.exec(prompt);
  if (!match) {
    return undefined;
  }
  return { action: match[1] === "off" ? "detach" : match[1] === "status" ? "status" : "attach" };
}

const CODEX_PHRASE = /^\s*rokid:(on|off|status)\s*$/;

/**
 * Recognises the opt-in phrase in a Codex prompt: `rokid:on`, `rokid:off`,
 * `rokid:status`, on the same terms as parseAttachCommand. The Codex TUI
 * rejects an unknown slash command ("Unrecognized command '/rokid:on'")
 * before any hook runs, so the phrase is plain text rather than a command.
 */
export function parseCodexAttachPhrase(prompt: unknown): { action: AttachAction } | undefined {
  if (typeof prompt !== "string") {
    return undefined;
  }
  const match = CODEX_PHRASE.exec(prompt);
  if (!match) {
    return undefined;
  }
  return { action: match[1] === "off" ? "detach" : match[1] === "status" ? "status" : "attach" };
}

export const ATTACH_TEXT =
  'Attached to Rokid-Coder (plugin mode). Works: progress, approvals, questions, context, voice follow-ups while waiting. Not available: compact, model change — use "rk claude" for those.';
export const CODEX_ATTACH_TEXT =
  "Attached to Rokid-Coder (plugin mode). All controls are available: follow-ups, approvals, questions, context, compact, model change.";
const DETACH_TEXT = "Detached from Rokid-Coder. This session no longer sends anything to the phone.";
const STATUS_ATTACHED_TEXT = "Attached to Rokid-Coder (plugin mode).";
const STATUS_DETACHED_TEXT = "Not attached to Rokid-Coder. Type /rokid:on to attach.";
const CODEX_STATUS_DETACHED_TEXT = "Not attached to Rokid-Coder. Type rokid:on to attach.";
const NO_SESSION_TEXT = "Rokid-Coder could not tell which session this is, so nothing was changed.";
const ATTACH_FAILED_TEXT = "Rokid-Coder could not save the attach list, so this session was not attached.";

/**
 * Claude Code never hands a slash command to UserPromptSubmit. The plugin's
 * commands arrive as UserPromptExpansion, namespaced by the plugin name
 * (observed command_name values: "rokid:on", "rokid:off", "rokid:status").
 */
const PLUGIN_COMMANDS: Record<string, AttachAction> = {
  "rokid:on": "attach",
  "rokid:off": "detach",
  "rokid:status": "status",
};

/**
 * Which agent sent the hook. The forwarder's `x-rokid-provider` header is
 * copied into `__provider` by the HTTP server; a payload that says nothing
 * is Claude's, which is all the daemon heard from before the Codex plugin.
 */
export function hookProvider(payload: HookPayload): AgentProvider {
  return payload.__provider === "codex" ? "codex" : "claude";
}

function requestedAction(payload: HookPayload, provider: AgentProvider): AttachAction | undefined {
  if (provider === "codex") {
    return payload.hook_event_name === "UserPromptSubmit"
      ? parseCodexAttachPhrase(payload.prompt)?.action
      : undefined;
  }
  if (payload.hook_event_name === "UserPromptExpansion") {
    const name = payload.command_name;
    return typeof name === "string" && Object.hasOwn(PLUGIN_COMMANDS, name)
      ? PLUGIN_COMMANDS[name]
      : undefined;
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    return parseAttachCommand(payload.prompt)?.action;
  }
  return undefined;
}

function block(reason: string): HookResponse {
  return { decision: "block", reason };
}

export interface AttachCommandContext {
  registry: AttachRegistry;
  logger: Logger;
  /** Called after a session is attached so it shows up before its next hook. */
  onAttached(payload: HookPayload, sessionId: string): void;
}

/**
 * Handles the opt-in command when `payload` is one. Returns the hook response
 * that blocks the prompt (the reply is its reason), or undefined when the
 * payload is not the command and the caller should carry on. It runs before
 * the attach gate, because the command is how a session gets through it.
 */
export function handleAttachCommand(
  payload: HookPayload,
  context: AttachCommandContext,
): HookResponse | undefined {
  const provider = hookProvider(payload);
  const action = requestedAction(payload, provider);
  if (!action) {
    return undefined;
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : undefined;
  if (!sessionId) {
    return block(NO_SESSION_TEXT);
  }
  const { registry } = context;
  switch (action) {
    case "attach":
      try {
        registry.attach(provider, sessionId, "plugin");
      } catch (error) {
        context.logger.error("attach_command_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        return block(ATTACH_FAILED_TEXT);
      }
      // A Codex thread reaches the phone through the Codex monitor, which the
      // registry's change event subscribes; there is no hook-side record to make.
      if (provider === "claude") {
        context.onAttached(payload, sessionId);
      }
      return block(provider === "codex" ? CODEX_ATTACH_TEXT : ATTACH_TEXT);
    case "detach":
      registry.detach(provider, sessionId);
      return block(DETACH_TEXT);
    case "status":
      return block(
        registry.isAttached(provider, sessionId)
          ? STATUS_ATTACHED_TEXT
          : provider === "codex"
            ? CODEX_STATUS_DETACHED_TEXT
            : STATUS_DETACHED_TEXT,
      );
  }
}
