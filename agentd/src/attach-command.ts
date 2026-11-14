import type { HookResponse } from "./approval-manager";
import type { AttachRegistry } from "./attach-registry";
import type { AgentProvider, HookPayload, Logger } from "./types";

export type AttachAction = "attach" | "detach" | "status" | "pair";

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

const CODEX_PHRASE = /^\s*rokid:(on|off|status|pair)\s*$/;

/**
 * Recognises the opt-in phrase in a Codex prompt: `rokid:on`, `rokid:off`,
 * `rokid:status`, `rokid:pair`, on the same terms as parseAttachCommand. The Codex TUI
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
  const word = match[1];
  return { action: word === "off" ? "detach" : word === "status" ? "status" : word === "pair" ? "pair" : "attach" };
}

export const ATTACH_TEXT =
  'Attached to Rokid-Coder (plugin mode). Works: progress, approvals, questions, context, voice follow-ups while waiting. Not available: compact, model change — use "rk claude" for those.';
export const CODEX_ATTACH_TEXT =
  "Attached to Rokid-Coder (plugin mode). All controls are available: follow-ups, approvals, questions, context, compact, model change.";
/** The `rk claude` banner, and what `/rokid:on` says in a session a launcher holds (R135). */
export const LAUNCHER_ATTACH_TEXT =
  "Rokid-Coder launcher: attached. From the glasses you can reply at any time, compact, and change model (changing model also sets your default for new sessions).";
const DETACH_TEXT = "Detached from Rokid-Coder. This session no longer sends anything to the phone.";
const STATUS_ATTACHED_TEXT = "Attached to Rokid-Coder (plugin mode).";
export const LAUNCHER_STATUS_TEXT = "Attached to Rokid-Coder (launcher mode, through rk claude).";
const STATUS_DETACHED_TEXT = "Not attached to Rokid-Coder.";
/**
 * U6: in a session, pairing only opens the allow-next window. The pairing line
 * and its secrets never go into a reply: a reply is model context and lands in
 * the transcript. R156: this hook only words the reply. The hook forwarder
 * opens the window over the same-user launcher socket, and replaces this text
 * with PAIR_UNAVAILABLE_TEXT when it could not.
 */
export const PAIR_TEXT =
  "Pairing window open: Open Agents on your phone → Add a computer within 2 minutes. The phone and this computer must be on the same Wi-Fi or on Tailscale.";
export const PAIR_UNAVAILABLE_TEXT = 'Run "agentd phones allow-next" in a terminal';
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
  "rokid:pair": "pair",
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
  /** A live `rk claude` binding holds this Claude session (R135). */
  isLauncherBound?(sessionId: string): boolean;
  /** agentd's phone pin store: whether a phone is paired (undefined when unreadable). */
  phones?: {
    paired(): boolean | undefined;
  };
}

/** How the pair command is typed in this agent. */
function pairCommand(provider: AgentProvider): string {
  return provider === "codex" ? "rokid:pair" : "/rokid:pair";
}

function statusReply(provider: AgentProvider, attached: boolean, launcher: boolean, paired: boolean | undefined): string {
  const head = attached ? (launcher ? LAUNCHER_STATUS_TEXT : STATUS_ATTACHED_TEXT) : STATUS_DETACHED_TEXT;
  const phone = paired === undefined ? "unknown (agentd cannot read its pin file)" : paired ? "paired" : "not paired";
  const attach = `type ${provider === "codex" ? "rokid:on" : "/rokid:on"} to attach`;
  const pair = `type ${pairCommand(provider)} to pair your phone`;
  const next = !attached
    ? paired === false ? `${attach}, and ${pair}.` : `${attach}.`
    : paired === false
      ? `${pair}.`
      : paired === undefined
        ? 'run "agentd phones list" in a terminal to check the paired phones.'
        : "on your glasses, open Agents to see this session.";
  const mode = !attached ? "— (not attached)" : launcher ? "LAUNCHER" : "PLUGIN";
  return `${head}\nMode: ${mode} · Phone: ${phone} · agentd: reachable\nNext step: ${next}`;
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
  // Pairing is about this computer, not this session, so it needs no session id.
  // Nothing is armed here: anyone on this machine can reach the hook port.
  if (action === "pair") {
    return block(PAIR_TEXT);
  }
  const sessionId = typeof payload.session_id === "string" && payload.session_id.length > 0
    ? payload.session_id
    : undefined;
  if (!sessionId) {
    return block(NO_SESSION_TEXT);
  }
  const { registry } = context;
  switch (action) {
    case "attach": {
      // R135: opting in again never takes a bound session out of launcher mode.
      const bound = provider === "claude" && context.isLauncherBound?.(sessionId) === true;
      try {
        registry.attach(provider, sessionId, bound ? "launcher" : "plugin");
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
      // M9: in a session `/rokid:off` had detached from its launcher, the opt-in
      // rebinds the launcher at once, so the reply is the launcher's.
      const launcher = bound || (provider === "claude" && context.isLauncherBound?.(sessionId) === true);
      const text = provider === "codex" ? CODEX_ATTACH_TEXT : launcher ? LAUNCHER_ATTACH_TEXT : ATTACH_TEXT;
      const unpaired = context.phones?.paired() === false;
      return block(unpaired ? `${text}\nNo phone paired yet — type ${pairCommand(provider)}` : text);
    }
    case "detach":
      registry.detach(provider, sessionId);
      return block(DETACH_TEXT);
    case "status": {
      const launcher = provider === "claude" && context.isLauncherBound?.(sessionId) === true;
      return block(statusReply(provider, registry.isAttached(provider, sessionId), launcher, context.phones?.paired()));
    }
  }
}
