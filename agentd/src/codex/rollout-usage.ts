import { open } from "node:fs/promises";

export interface ContextUsage {
  used: number;
  window: number;
}

const INITIAL_WINDOW_BYTES = 64 * 1024;

function usageFromLine(line: string): ContextUsage | undefined {
  if (!line.includes('"token_count"')) {
    return undefined;
  }
  try {
    const record: unknown = JSON.parse(line);
    const payload = (record as { type?: unknown; payload?: Record<string, unknown> })?.payload;
    if ((record as { type?: unknown })?.type !== "event_msg" || payload?.type !== "token_count") {
      return undefined;
    }
    const info = payload.info as {
      last_token_usage?: { total_tokens?: unknown };
      model_context_window?: unknown;
    } | null;
    const used = info?.last_token_usage?.total_tokens;
    const window = info?.model_context_window;
    return typeof used === "number" && Number.isFinite(used) &&
      typeof window === "number" && Number.isFinite(window) && window > 0
      ? { used, window }
      : undefined;
  } catch {
    // A torn line at the file's moving end, or an unrelated record.
    return undefined;
  }
}

/**
 * The newest context fill in a Codex rollout. Codex has no client method for
 * it, but it journals a token_count event after every model response, so the
 * tail of the file answers without compacting or waiting for the next turn.
 */
export async function readLastTokenUsage(rolloutPath: string): Promise<ContextUsage | undefined> {
  let handle;
  try {
    handle = await open(rolloutPath, "r");
  } catch {
    return undefined;
  }
  try {
    const { size } = await handle.stat();
    // Rollouts grow to many MB; read a growing tail window instead of the whole file.
    for (let windowBytes = INITIAL_WINDOW_BYTES; ; windowBytes *= 4) {
      const start = Math.max(0, size - windowBytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start > 0) {
        lines.shift(); // begins mid-line
      }
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const usage = usageFromLine(lines[index]);
        if (usage) {
          return usage;
        }
      }
      if (start === 0) {
        return undefined;
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
