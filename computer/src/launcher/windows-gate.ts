import { isWsl } from "../advertise";
import type { CliTool } from "./cli-install";

/**
 * Launcher mode on Windows (U33). Flipped to true only by a commit after the
 * recorded Windows gate's W9 passes; ROKID_RK_WINDOWS_VERIFIED=1 lifts it for
 * the gate session itself.
 */
export const WINDOWS_LAUNCHER_VERIFIED = false;

const HINTS: Record<CliTool, string> = {
  claude: "Launcher mode isn't verified on Windows yet — use plugin mode: type /rokid:on in Claude",
  codex: "Launcher mode isn't verified on Windows yet — use plugin mode: type rokid:on in Codex",
};

/** The plugin-mode hint when `rk <tool>` must not start the launcher here, else undefined. */
export function windowsGateHint(tool: CliTool, env: NodeJS.ProcessEnv = process.env, wsl = isWsl(env)): string | undefined {
  if (!wsl || WINDOWS_LAUNCHER_VERIFIED || env.ROKID_RK_WINDOWS_VERIFIED === "1") {
    return undefined;
  }
  return HINTS[tool];
}

/**
 * Called right after `rk`'s CLI resolution [6b-R2], so a missing CLI has been
 * offered and provisioned first. In unverified WSL it says what to do instead
 * and ends `rk` successfully.
 */
export function applyWindowsGate(tool: CliTool): void {
  const hint = windowsGateHint(tool);
  if (hint) {
    process.stderr.write(`${hint}\n`);
    process.exit(0);
  }
}
