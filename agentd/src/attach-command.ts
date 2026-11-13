import type { HookResponse } from "./approval-manager";
import type { AttachRegistry } from "./attach-registry";
import type { HookPayload, Logger } from "./types";

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

export const ATTACH_TEXT =
  'Attached to Rokid-Coder (plugin mode). Works: progress, approvals, questions, context, voice follow-ups while waiting. Not available: compact, model change — use "rk claude" for those.';
const DETACH_TEXT = "Detached from Rokid-Coder. This session no longer sends anything to the phone.";
const STATUS_ATTACHED_TEXT = "Attached to Rokid-Coder (plugin mode).";
const STATUS_DETACHED_TEXT = "Not attached to Rokid-Coder. Type /rokid to attach.";
const USAGE_TEXT = "Usage: /rokid-coder:rokid [off|status]";
const NO_SESSION_TEXT = "Rokid-Coder could not tell which session this is, so nothing was changed.";
const ATTACH_FAILED_TEXT = "Rokid-Coder could not save the attach list, so this session was not attached.";

/**
 * Claude Code never hands a slash command to UserPromptSubmit. The plugin's
 * command arrives as UserPromptExpansion, namespaced by the plugin and with its
 * arguments split out. The prompt string the parser sees is rebuilt from that.
 */
const PLUGIN_COMMAND_NAME = "rokid-coder:rokid";

function commandPrompt(payload: HookPayload): { prompt: string; ours: boolean } {
  if (payload.hook_event_name === "UserPromptExpansion") {
    if (payload.command_name !== PLUGIN_COMMAND_NAME) {
      return { prompt: "", ours: false };
    }
    const args = typeof payload.command_args === "string" ? payload.command_args.trim() : "";
    return { prompt: args ? `/rokid ${args}` : "/rokid", ours: true };
  }
  if (payload.hook_event_name === "UserPromptSubmit") {
    return { prompt: typeof payload.prompt === "string" ? payload.prompt : "", ours: false };
  }
  return { prompt: "", ours: false };
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
  const { prompt, ours } = commandPrompt(payload);
  const command = parseAttachCommand(prompt);
  if (!command) {
    return ours ? block(USAGE_TEXT) : undefined;
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : undefined;
  if (!sessionId) {
    return block(NO_SESSION_TEXT);
  }
  const { registry } = context;
  switch (command.action) {
    case "attach":
      try {
        registry.attach("claude", sessionId, "plugin");
      } catch (error) {
        context.logger.error("attach_command_failed", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        return block(ATTACH_FAILED_TEXT);
      }
      context.onAttached(payload, sessionId);
      return block(ATTACH_TEXT);
    case "detach":
      registry.detach("claude", sessionId);
      return block(DETACH_TEXT);
    case "status":
      return block(registry.isAttached("claude", sessionId) ? STATUS_ATTACHED_TEXT : STATUS_DETACHED_TEXT);
  }
}
