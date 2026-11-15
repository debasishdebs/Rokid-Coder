import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { uninstallHooks } from "../settings";
import type { LegacyAutostart, PlatformHooks, PortOwner } from "./platform/index";

/**
 * What 0.8.0 left behind [FR 15]:
 * (a) its autostart (`PlatformHooks.legacyAutostart`)
 * (b) `install-hooks` entries in ~/.claude/settings.json, which would forward
 *     every event twice next to the plugin
 * (c) a repo-sourced `rokid-coder` marketplace: plugin sync re-points it
 * (d) an agentd someone started by hand, holding the ports: never killed
 */
export interface LegacyFindings {
  autostart?: LegacyAutostart;
  installHooks: boolean;
  /** Owners of the agentd ports that are neither our service nor the legacy one. */
  others: PortOwner[];
}

export function claudeSettingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

function isForwarder(value: unknown): boolean {
  const command = value && typeof value === "object" ? (value as { command?: unknown }).command : undefined;
  return typeof command === "string" && command.includes("hook-forward.js");
}

/** True when settings.json holds a hook-forward.js command: what `agentd install-hooks` wrote (the plugin's live in its own hooks.json). */
export function hasInstallHooks(home: string): boolean {
  const file = claudeSettingsPath(home);
  if (!existsSync(file)) {
    return false;
  }
  try {
    const hooks = (JSON.parse(readFileSync(file, "utf8")) as { hooks?: unknown }).hooks;
    if (!hooks || typeof hooks !== "object") return false;
    return Object.values(hooks as Record<string, unknown>).some(
      (groups) =>
        Array.isArray(groups) &&
        groups.some(
          (group) =>
            isForwarder(group) ||
            (Array.isArray((group as { hooks?: unknown })?.hooks) && (group as { hooks: unknown[] }).hooks.some(isForwarder)),
        ),
    );
  } catch {
    return false;
  }
}

/** Through the existing `uninstallHooks`, which writes a backup first. */
export function removeInstallHooks(home: string): { backupPath?: string; settingsPath: string } {
  const result = uninstallHooks({ settingsPath: claudeSettingsPath(home) });
  return { backupPath: result.backupPath, settingsPath: result.settingsPath };
}

export async function discoverLegacy(home: string, platform: PlatformHooks, ports: number[]): Promise<LegacyFindings> {
  const autostart = await platform.legacyAutostart();
  const owners = await platform.portOwners(ports);
  return {
    ...(autostart ? { autostart } : {}),
    installHooks: hasInstallHooks(home),
    others: owners.filter((owner) => owner.owner === "other"),
  };
}
