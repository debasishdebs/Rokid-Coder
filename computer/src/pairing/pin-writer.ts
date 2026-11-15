import { createServer } from "node:http";
import path from "node:path";
import { PinStore } from "../tls";
import { type PinsChange, type PinsChangeResult, requestPinsChange } from "./pins-client";

/**
 * The pin writer lock (R209) is the kernel-held bind of agentd's hook port on
 * 127.0.0.1. agentd binds it before its first read of the pins and keeps it
 * for its whole run; a CLI that writes the pins while agentd is down binds it
 * for the length of that write. The OS frees it when its holder dies, so
 * there is never anything stale to recover.
 *
 * Resolves the release when this process now holds the port, or undefined
 * when another process does. While held here, any request on it is refused
 * with 503.
 */
export function holdHookPort(port: number): Promise<(() => Promise<void>) | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json", connection: "close" });
      response.end('{"error":"pins_being_written"}');
    });
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(undefined);
      } else {
        reject(error);
      }
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      resolve(
        () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      );
    });
  });
}

export function hookPortBusy(port: number): string {
  return (
    `agentd is running or starting (127.0.0.1:${port} is taken) and did not take the pin change, ` +
    "so nothing was changed. Try again once it is up."
  );
}

/** Runs `fn`, a pin write, holding the hook port; rejects, with nothing written, when another process holds it. */
export async function writePinsDirectly<T>(port: number, fn: () => T): Promise<T> {
  const release = await holdHookPort(port);
  if (!release) {
    throw new Error(hookPortBusy(port));
  }
  try {
    return fn();
  } finally {
    await release();
  }
}

/**
 * A CLI pin change (R208, R209): agentd makes it when it is running, as the
 * only writer. Only when it is not does this process write, holding the hook
 * port. A port that is taken means agentd is running or starting: the request
 * is tried once more, and then the change fails closed.
 */
export async function changePins(stateDir: string, tlsDir: string, httpPort: number, change: PinsChange): Promise<PinsChangeResult> {
  const viaAgentd = await requestPinsChange(stateDir, change);
  if (viaAgentd) {
    return viaAgentd;
  }
  const release = await holdHookPort(httpPort);
  if (!release) {
    const retried = await requestPinsChange(stateDir, change);
    if (retried) {
      return retried;
    }
    throw new Error(hookPortBusy(httpPort));
  }
  try {
    const pins = new PinStore(path.join(tlsDir, "phone-pins.json"));
    switch (change.op) {
      case "forget": {
        const removed = pins.forget(change.fp ?? "");
        return { removed: removed.length, empty: pins.isEmpty() };
      }
      case "forget_all":
        pins.forgetAll();
        return {};
      case "allow_next":
        return { until: pins.armAllowNext(Date.now()) };
    }
  } finally {
    await release();
  }
}
