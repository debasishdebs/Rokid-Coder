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
 * The pairing line and QR, v2: where to dial agentd's wss and which cert to
 * expect there, and nothing secret. A phone that reads it still runs the SAS
 * code check on that link; the token and the steering secret reach it only
 * afterwards, in `pair_credentials` on the same confirmed TLS session.
 */
export function pairingPayload(config: AgentConfig, fp: string): string {
  return JSON.stringify({
    v: 2,
    kind: "rokid-coder",
    host: bestHostGuess(),
    port: config.wsPort,
    fp,
  });
}
