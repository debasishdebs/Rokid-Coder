import { spawn } from "node:child_process";
import path from "node:path";

export const TAILSCALE_LINK = "https://tailscale.com/download";
const LATER = '~/.rokid-coder/bin/agentd pair';

export interface PairIo {
  write(text: string): void;
  /** The next line typed, or undefined at end of input. */
  readLine(): Promise<string | undefined>;
}

/**
 * `<bundle>/bin/agentd pair` with the terminal inherited: it shows the code,
 * takes `[y/N]` and waits for `pair-ready` (6a). Setup never confirms a
 * pairing itself. Resolves to its exit status; 0 means paired.
 */
export function runAgentdPair(bundleDir: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(path.join(bundleDir, "bin", "agentd"), ["pair"], { stdio: "inherit", env });
    child.once("error", () => resolve(127));
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

/**
 * The pairing step, which is also the post-install reachability check
 * (§13.1). Not paired offers [R]etry, [T]ailscale, [Q]R and [L]ater.
 */
export async function pairStep(runPair: () => Promise<number>, io: PairIo): Promise<"paired" | "later"> {
  let status = await runPair();
  for (;;) {
    if (status === 0) {
      io.write("Paired.\n");
      return "paired";
    }
    io.write("Not paired yet. [R]etry, [T]ailscale, [Q]R code, or [L]ater? ");
    const answer = (await io.readLine())?.trim().toLowerCase();
    if (answer === undefined || answer === "l" || answer === "later") {
      io.write(`${answer === undefined ? "\n" : ""}Pair whenever you are ready: run ${LATER}\n`);
      return "later";
    }
    if (answer === "t" || answer === "tailscale") {
      io.write(
        `Away from this Wi-Fi, or the phone can't reach this computer? Tailscale connects them:\n` +
          `  1. Install Tailscale on this computer: ${TAILSCALE_LINK}\n` +
          "  2. On the phone, open Settings > Connectors > Tailscale, and sign in with the same account.\n",
      );
      continue;
    }
    if (answer === "r" || answer === "retry" || answer === "q" || answer === "qr") {
      // `agentd pair` prints the v2 pairing line and its QR again: where to dial and which cert, nothing secret.
      status = await runPair();
    }
  }
}
