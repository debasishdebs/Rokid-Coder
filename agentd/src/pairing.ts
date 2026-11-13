import os from "node:os";
import type { AgentConfig } from "./types";

function familyIsV4(family: string | number): boolean {
  return family === "IPv4" || family === 4;
}

export function bestHostGuess(interfaces = os.networkInterfaces()): string {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (familyIsV4(address.family) && !address.internal) {
        candidates.push({ name, address: address.address });
      }
    }
  }
  return (
    candidates.find((candidate) => candidate.name.toLowerCase().includes("tailscale"))?.address ||
    candidates[0]?.address ||
    "PASTE-YOUR-TAILNET-IP"
  );
}

/**
 * `fp` is agentd's certificate fingerprint; the phone pins it before it trusts
 * wss. `steer` is the secret that makes a wss hello a steering one. It travels
 * only in this payload (line, QR): agentd never sends it on a socket.
 */
export function pairingPayload(config: AgentConfig, fp: string, steer: string): string {
  return JSON.stringify({
    v: 1,
    kind: "nexus-agentd",
    name: config.machineName,
    host: bestHostGuess(),
    port: config.wsPort,
    token: config.token,
    fp,
    steer,
  });
}
