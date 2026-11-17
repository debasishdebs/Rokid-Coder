import os from "node:os";
import { advertisedEndpoint, refreshAdvertiseSync } from "./advertise";
import { isTailnetIpv4 } from "./tailnet-discovery";
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
  // The LAN address leads: the tailnet one (any 100.64/10 address, whatever the
  // interface is called: macOS says utunN) is advertised after it, never instead.
  const lan = candidates.find(
    (candidate) => !isTailnetIpv4(candidate.address) && !candidate.name.toLowerCase().includes("tailscale"),
  );
  return (
    lan?.address ||
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
  refreshAdvertiseSync(config);
  const endpoint = advertisedEndpoint(config);
  // `host` is for phones that predate `hosts`; they ignore the extra field.
  return JSON.stringify({
    v: 2,
    kind: "rokid-coder",
    host: endpoint.hosts[0],
    hosts: endpoint.hosts,
    port: endpoint.port,
    fp,
  });
}
