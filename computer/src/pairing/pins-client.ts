import net from "node:net";
import path from "node:path";
import { LAUNCHER_SOCKET_NAME } from "../launcher/socket-name";
import type { PinsChangeOp } from "../launcher/launcher-hub";

export interface PinsChange {
  op: PinsChangeOp;
  fp?: string;
}

/** What agentd answered: `removed` and `empty` for a forget, `until` for allow-next. */
export interface PinsChangeResult {
  removed?: number;
  empty?: boolean;
  until?: number;
}

const ANSWER_TIMEOUT_MS = 5_000;

/**
 * Asks a running agentd to make a pin change over its 0600 launcher socket
 * (R208): while it runs, it is the only process that writes the pins.
 * Resolves undefined only when agentd is not running (no socket, or it
 * refuses the connection); the caller may then write the pins itself. Any
 * other failure rejects: agentd may be running, so this process must not write.
 */
export function requestPinsChange(configDir: string, change: PinsChange): Promise<PinsChangeResult | undefined> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(configDir, LAUNCHER_SOCKET_NAME));
    let connected = false;
    let settled = false;
    let buffer = "";
    const settle = (outcome: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        outcome();
      }
    };
    const timer = setTimeout(
      () => settle(() => reject(new Error("agentd did not answer the pin change in time; nothing was changed here. Try again."))),
      ANSWER_TIMEOUT_MS,
    );
    timer.unref();
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ type: "pins_change", ...change })}\n`);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED")) {
        settle(() => resolve(undefined));
        return;
      }
      settle(() => reject(new Error(`Could not reach agentd to change the phone pins: ${error.message}`)));
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) {
        return;
      }
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
      } catch {
        settle(() => reject(new Error("agentd sent an unreadable answer to the pin change")));
        return;
      }
      if (reply.type !== "pins_result") {
        settle(() => reject(new Error("agentd did not take the pin change; is it an older version? Restart it and try again.")));
      } else if (reply.ok === true) {
        const { type: _type, ok: _ok, ...result } = reply;
        settle(() => resolve(result as PinsChangeResult));
      } else {
        settle(() => reject(new Error(typeof reply.error === "string" ? reply.error : "agentd refused the pin change")));
      }
    });
    socket.on("close", () => {
      settle(() => reject(new Error("agentd closed the connection before it answered the pin change; is it an older version? Restart it and try again.")));
    });
  });
}
