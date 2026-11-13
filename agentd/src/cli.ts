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
import { pairingPayload } from "./pairing";
import {
  ALLOW_NEXT_WINDOW_MS,
  PinStore,
  ensureAgentCert,
  ensureSteerSecret,
  rotateSteerSecret,
} from "./tls";
import { installHooks, uninstallHooks } from "./settings";

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
    `nexus-agentd listening on 127.0.0.1:${daemon.config.httpPort} and 0.0.0.0:${daemon.config.wsPort}\n`,
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
      const rotate = process.argv.slice(3).includes("--rotate-steer");
      const steer = rotate ? rotateSteerSecret(tlsDir) : ensureSteerSecret(tlsDir);
      if (rotate) {
        process.stderr.write(
          "Steering secret rotated. A running agentd now disconnects every phone that was steering with the old secret and refuses its steering frames; they must pair again with this new pairing payload.\n",
        );
      }
      const payload = pairingPayload(config, cert.fingerprint256, steer);
      process.stdout.write(`${payload}\n`);
      qrcode.generate(payload, { small: true }, (code) => process.stdout.write(`${code}\n`));
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
      const pins = new PinStore(path.join(config.rokidCoder.stateDir, "tls", "phone-pins.json"));
      const action = process.argv[3];
      if (action === "list") {
        const phones = pins.list();
        process.stdout.write(phones.length > 0 ? `${phones.join("\n")}\n` : "No trusted phones.\n");
        if (pins.allowNextOpen(Date.now())) {
          process.stdout.write("The next new phone will be trusted (allow-next is open).\n");
        }
      } else if (action === "forget") {
        const which = process.argv[4];
        if (which === "--all") {
          pins.forgetAll();
          process.stdout.write(
            "Forgot all phones. A running agentd disconnects the phone it has linked; the next phone to connect is trusted on first use.\n",
          );
        } else if (which) {
          const removed = pins.forget(which);
          process.stdout.write(
            removed.length > 0
              ? `Forgot ${removed.join(", ")}. A running agentd disconnects it.\n`
              : "No such phone.\n",
          );
        } else {
          throw new Error("Usage: agentd phones forget <fingerprint|--all>");
        }
      } else if (action === "allow-next") {
        pins.armAllowNext(Date.now());
        process.stdout.write(
          `The next new phone to connect in the next ${ALLOW_NEXT_WINDOW_MS / 60_000} minutes will be trusted.\n`,
        );
      } else {
        throw new Error("Usage: agentd phones list | forget <fingerprint|--all> | allow-next");
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
        `Unknown command '${command}'. Use run, install-hooks, uninstall-hooks, pair, phones, link-phone, unlink-phone, or status.`,
      );
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
