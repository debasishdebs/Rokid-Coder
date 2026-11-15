#!/usr/bin/env node
import { request } from "node:http";
import path from "node:path";
import qrcode from "qrcode-terminal";
import {
  defaultStateDir,
  ensureConfig,
  parsePhoneTarget,
  saveConfig,
} from "./config";
import { startDaemon } from "./daemon";
import { LineReader } from "./launcher/pair-prompt";
import { pairingPayload } from "./pairing";
import { type PinsChange, type PinsChangeResult, requestPinsChange } from "./pairing/pins-client";
import { confirmInTerminal } from "./pairing/terminal-client";
import { PhoneSettingsStore } from "./phone-settings";
import {
  ALLOW_NEXT_WINDOW_MS,
  DAY_MS,
  PinStore,
  ensureAgentCert,
  ensureSteerSecret,
  rotateSteerSecret,
} from "./tls";
import { installHooks, uninstallHooks } from "./settings";

/**
 * A pin change (R208): made by agentd when it is running, which is then the
 * only process that writes the pins. Only when it is not running does this
 * process write them itself, under the pins lock.
 */
async function changePins(stateDir: string, tlsDir: string, change: PinsChange): Promise<PinsChangeResult> {
  const viaAgentd = await requestPinsChange(stateDir, change);
  if (viaAgentd) {
    return viaAgentd;
  }
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
}

interface Health {
  ok: boolean;
  sessions: number;
  codex?: {
    enabled: boolean;
    available: boolean;
    reason?: string;
  };
}

function getHealth(port: number): Promise<Health | undefined> {
  return new Promise((resolve) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 1000,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Health;
            resolve(response.statusCode === 200 && parsed.ok === true ? parsed : undefined);
          } catch {
            resolve(undefined);
          }
        });
      },
    );
    outgoing.once("timeout", () => {
      outgoing.destroy();
      resolve(undefined);
    });
    outgoing.once("error", () => resolve(undefined));
    outgoing.end();
  });
}

async function run(): Promise<void> {
  const daemon = await startDaemon();
  process.stdout.write(
    `nexus-agentd listening on 127.0.0.1:${daemon.config.httpPort} and wss on 0.0.0.0:${daemon.config.wsPort}\n`,
  );
  const shutdown = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function phoneTargetArgument(command: string): string {
  const target = process.argv[3];
  if (!target || !parsePhoneTarget(target)) {
    throw new Error(`Usage: agentd ${command} <host[:port]>`);
  }
  return target;
}

function printPhoneHosts(phoneHosts: string[]): void {
  process.stdout.write(`${JSON.stringify(phoneHosts)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2] || "run";
  const agentRoot = path.resolve(__dirname, "..");
  switch (command) {
    case "run":
      await run();
      break;
    case "install-hooks": {
      const result = installHooks(agentRoot);
      process.stdout.write(
        result.changed
          ? `Installed Claude Code hooks in ${result.settingsPath}${
              result.backupPath ? ` (backup: ${result.backupPath})` : ""
            }\n`
          : `Claude Code hooks are already installed in ${result.settingsPath}\n`,
      );
      break;
    }
    case "uninstall-hooks": {
      const result = uninstallHooks();
      process.stdout.write(
        result.changed
          ? `Removed nexus-agentd hooks from ${result.settingsPath}${
              result.backupPath ? ` (backup: ${result.backupPath})` : ""
            }\n`
          : `No nexus-agentd hooks found in ${result.settingsPath}\n`,
      );
      break;
    }
    case "pair": {
      const config = ensureConfig(defaultStateDir());
      const tlsDir = path.join(config.rokidCoder.stateDir, "tls");
      const cert = await ensureAgentCert(tlsDir);
      if (process.argv.slice(3).includes("--rotate-steer")) {
        rotateSteerSecret(tlsDir);
        // PhoneLink checks the pin, not the secret: a rotation that kept the pins would revoke nothing there.
        await changePins(config.rokidCoder.stateDir, tlsDir, { op: "forget_all" });
        process.stderr.write(
          "Steering secret rotated and every phone forgotten. A running agentd disconnects them on both links now; each must pair again with a code.\n",
        );
      } else {
        ensureSteerSecret(tlsDir);
      }
      // Where to dial and which cert to expect, nothing secret: the phone still runs the code check.
      const payload = pairingPayload(config, cert.fingerprint256);
      process.stdout.write(`${payload}\n`);
      qrcode.generate(payload, { small: true }, (code) => process.stdout.write(`${code}\n`));
      process.stdout.write(`Pairing window open for ${ALLOW_NEXT_WINDOW_MS / 60_000} minutes.\n`);
      const input = new LineReader(process.stdin);
      let outcome;
      try {
        outcome = await confirmInTerminal({
          configDir: config.rokidCoder.stateDir,
          write: (text) => process.stdout.write(text),
          nextLine: () => input.next(),
          windowMs: ALLOW_NEXT_WINDOW_MS,
        });
      } finally {
        input.close();
      }
      if (outcome === "unavailable") {
        throw new Error('agentd isn\'t running — run "agentd run" in a terminal, then "agentd pair" again.');
      }
      if (outcome !== "paired") {
        process.exitCode = 1;
      }
      break;
    }
    case "link-phone": {
      const target = phoneTargetArgument(command);
      const stateDir = defaultStateDir();
      const config = ensureConfig(stateDir);
      if (!config.phoneHosts.includes(target)) {
        config.phoneHosts.push(target);
      }
      saveConfig(config, stateDir);
      printPhoneHosts(config.phoneHosts);
      break;
    }
    case "unlink-phone": {
      const target = phoneTargetArgument(command);
      const stateDir = defaultStateDir();
      const config = ensureConfig(stateDir);
      config.phoneHosts = config.phoneHosts.filter((entry) => entry !== target);
      saveConfig(config, stateDir);
      printPhoneHosts(config.phoneHosts);
      break;
    }
    case "phones": {
      const config = ensureConfig(defaultStateDir());
      const tlsDir = path.join(config.rokidCoder.stateDir, "tls");
      const pins = new PinStore(path.join(tlsDir, "phone-pins.json"));
      const action = process.argv[3];
      if (action === "list") {
        const entries = pins.entries();
        const ttlMs = new PhoneSettingsStore(
          path.join(config.rokidCoder.stateDir, "settings.json"),
          config.rokidCoder.waitLimitSec,
        ).get().pairingTtlDays * DAY_MS;
        const now = Date.now();
        const days = (count: number): string => `${count} day${count === 1 ? "" : "s"}`;
        process.stdout.write(
          entries.length > 0
            ? `${entries
                .map((entry) => {
                  const unused = now - entry.lastUsedAt;
                  return `${entry.fp}  last used ${days(Math.floor(unused / DAY_MS))} ago · signs out in ${days(Math.max(0, Math.ceil((ttlMs - unused) / DAY_MS)))}`;
                })
                .join("\n")}\n`
            : "No trusted phones.\n",
        );
        if (pins.allowNextOpen(Date.now())) {
          process.stdout.write("A pairing window is open: a new phone can pair once both screens confirm its code.\n");
        }
      } else if (action === "forget") {
        const which = process.argv[4];
        const none = 'No phones are trusted now. Run "phones allow-next" to add one.\n';
        if (which === "--all") {
          // Forgetting everything revokes both transports: a phone that dials in
          // over wss is trusted by the steering secret, not by a pin.
          await changePins(config.rokidCoder.stateDir, tlsDir, { op: "forget_all" });
          rotateSteerSecret(tlsDir);
          process.stdout.write(
            `Forgot all phones. A running agentd drops its dialled link.\nThe steering secret was rotated too, so a running agentd also cuts off every phone steering over the paired WebSocket link; to steer again, a phone must pair again with "pair".\n${none}`,
          );
        } else if (which) {
          // One phone is one pairing: a half-finished one (provisional) goes with it.
          const result = await changePins(config.rokidCoder.stateDir, tlsDir, { op: "forget", fp: which });
          process.stdout.write(
            (result.removed ?? 0) > 0
              ? `Forgotten. That phone's links close now; it must pair again to reconnect.\n${result.empty ? none : ""}`
              : "No such phone.\n",
          );
        } else {
          throw new Error("Usage: agentd phones forget <fingerprint|--all>");
        }
      } else if (action === "allow-next") {
        await changePins(config.rokidCoder.stateDir, tlsDir, { op: "allow_next" });
        process.stdout.write(
          `Open for ${ALLOW_NEXT_WINDOW_MS / 60_000} minutes, for one phone. It pairs only once you compare its 6-digit code: run "agentd pair" to see it, and confirm on the phone.\n`,
        );
      } else {
        throw new Error(
          `Usage: agentd phones list | forget <fingerprint|--all> | allow-next\nTo factory-reset instead, stop agentd and delete ${tlsDir}: agentd gets a new certificate and trusts no phone until you run "pair" again.`,
        );
      }
      break;
    }
    case "status": {
      const config = ensureConfig(defaultStateDir());
      const health = await getHealth(config.httpPort);
      process.stdout.write(
        health
          ? `running: yes, sessions: ${health.sessions}, codex: ${
              health.codex?.available
                ? "available"
                : health.codex?.enabled
                  ? `unavailable (${health.codex.reason ?? "unknown reason"})`
                  : "disabled"
            }\n`
          : "running: no, sessions: 0\n",
      );
      break;
    }
    default:
      throw new Error(
        `Unknown command '${command}'. Use run, install-hooks, uninstall-hooks, pair (opens a 2-minute window for one new phone and shows its code to confirm), phones, link-phone, unlink-phone, or status.`,
      );
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
