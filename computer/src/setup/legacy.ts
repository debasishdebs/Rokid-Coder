import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { uninstallHooks } from "../settings";
import type { LegacyAutostart, PlatformHooks, PortOwner } from "./platform/index";

/**
 * What 0.8.0 left behind [FR 15]:
 * (a) its autostart (`PlatformHooks.legacyAutostart`)
 * (b) `install-hooks` entries in ~/.claude/settings.json, which would forward
 *     every event twice next to the plugin: removed only by the user's own
 *     migration step (`migrateInstallHooks`) [R217]
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

/** What a person runs to remove them later; the installed wrapper, so it works from any shell. */
export const MIGRATE_HOOKS_COMMAND = "~/.rokid-coder/bin/rokid-setup migrate-hooks";

export interface InstallHookEntry {
  event: string;
  command: string;
}

function forwarderCommand(value: unknown): string | undefined {
  const command = value && typeof value === "object" ? (value as { command?: unknown }).command : undefined;
  return typeof command === "string" && command.includes("hook-forward.js") ? command : undefined;
}

/** The hook-forward.js commands in `settings` text: what `agentd install-hooks` wrote (the plugin's live in its own hooks.json). */
function forwarderEntries(text: string): InstallHookEntry[] {
  const hooks = (JSON.parse(text) as { hooks?: unknown }).hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const entries: InstallHookEntry[] = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = (group as { hooks?: unknown })?.hooks;
      for (const hook of [group, ...(Array.isArray(inner) ? inner : [])]) {
        const command = forwarderCommand(hook);
        if (command) entries.push({ event, command });
      }
    }
  }
  return entries;
}

/** Every `agentd install-hooks` entry in ~/.claude/settings.json; none when the file is absent or unreadable. */
export function listInstallHooks(home: string): InstallHookEntry[] {
  const file = claudeSettingsPath(home);
  if (!existsSync(file)) {
    return [];
  }
  try {
    return forwarderEntries(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

export function hasInstallHooks(home: string): boolean {
  return listInstallHooks(home).length > 0;
}

export interface MigrateIo {
  interactive: boolean;
  write(text: string): void;
  note(text: string): void;
  readLine(): Promise<string | undefined>;
}

/**
 * The legacy hooks migration [R217], a step of its own outside the install
 * transaction: setup's only edit of a ~/.claude file. It shows the exact
 * entries, and only a typed yes in a terminal removes them, through
 * `uninstallHooks` (a backup copy, then temp file + rename). Not in a
 * terminal, or declined, it changes nothing and prints the command to run
 * later. Nothing is written when the file changed after it was shown.
 */
export async function migrateInstallHooks(
  home: string,
  io: MigrateIo,
  options: { decline?: boolean } = {},
): Promise<"none" | "kept" | "removed"> {
  const file = claudeSettingsPath(home);
  const shown = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const entries = shown === undefined ? [] : forwarderEntries(shown);
  if (entries.length === 0) {
    return "none";
  }
  io.write(
    "~/.claude/settings.json still has the hooks `agentd install-hooks` added. Next to the plugin they forward every event twice.\n" +
      `These entries would be removed:\n${entries.map((entry) => `  ${entry.event}: ${entry.command}\n`).join("")}`,
  );
  const later = `Nothing was changed. To remove them later, run: ${MIGRATE_HOOKS_COMMAND}\n`;
  if (!io.interactive || options.decline) {
    io.write(later);
    return "kept";
  }
  io.note("awaiting: migrate_hooks");
  io.write("Remove them from ~/.claude/settings.json? A backup is kept. [y/N] ");
  const answer = (await io.readLine())?.trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    if (answer === undefined) io.write("\n");
    io.write(later);
    return "kept";
  }
  if ((existsSync(file) ? readFileSync(file, "utf8") : undefined) !== shown) {
    io.write(`~/.claude/settings.json changed while you were deciding. ${later}`);
    return "kept";
  }
  const result = uninstallHooks({ settingsPath: file });
  io.write(`Removed them. The previous file is kept as ${result.backupPath}\n`);
  return "removed";
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
