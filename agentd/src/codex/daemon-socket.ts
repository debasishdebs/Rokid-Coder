import os from "node:os";
import path from "node:path";

/** Where the user's managed Codex app-server listens for control clients. */
export function defaultDaemonSocketPath(home = os.homedir()): string {
  return path.join(home, ".codex", "app-server-control", "app-server-control.sock");
}

/** The `ws` package dials a unix socket as `ws+unix://<socket>:<request path>`. */
export function daemonEndpoint(socketPath: string): string {
  return `ws+unix://${socketPath}:/`;
}

/** The configured socket path with a leading `~/` expanded; absent means Codex's default. */
export function resolveDaemonSocketPath(configured?: string, home = os.homedir()): string {
  if (!configured) {
    return defaultDaemonSocketPath(home);
  }
  return configured === "~" || configured.startsWith("~/")
    ? path.join(home, configured.slice(1))
    : configured;
}
