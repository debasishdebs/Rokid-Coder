#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
// The plugins ship a copy of this file with no node_modules and no sibling
// modules next to it, so it may import only node:* built-ins. The defaults
// below are only the fallback for a forwarder run by hand: the plugins always set
// ROKID_CODER_HOOK_DEADLINE_MS past the wait limit Y (up to an hour). A test pins
// the "no relative require" rule.
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TIMER_MS = 2_147_000_000;
function positiveTimerMs(value) {
    if (value === undefined || value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_TIMER_MS ? parsed : undefined;
}
// An explicit deadline wins (plugins set it past the longest hook timeout);
// otherwise wait one approval timeout plus slack for the daemon to answer.
const EXIT_AFTER_MS = positiveTimerMs(process.env.ROKID_CODER_HOOK_DEADLINE_MS) ??
    (positiveTimerMs(process.env.NEXUS_AGENTD_APPROVAL_TIMEOUT_MS) ?? DEFAULT_APPROVAL_TIMEOUT_MS) + 5000;
const PROVIDER = process.env.ROKID_CODER_PROVIDER?.trim();
const HTTP_PORT = (() => {
    const parsed = Number(process.env.NEXUS_AGENTD_HTTP_PORT);
    return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : 8791;
})();
// With agentd down nothing intercepts the plugin's commands. These two still get
// a plain answer rather than reaching the model as a prompt.
const OFFLINE_REPLIES = {
    "rokid:pair": 'agentd isn\'t running — run "agentd run" in a terminal',
    "rokid:status": 'Not attached to Rokid-Coder: agentd isn\'t running.\nNext step: run "agentd run" in a terminal.',
};
function offlineReply(body) {
    try {
        const hook = JSON.parse(body.toString("utf8"));
        const command = PROVIDER === "codex"
            ? hook.hook_event_name === "UserPromptSubmit" && typeof hook.prompt === "string" ? hook.prompt.trim() : undefined
            : hook.hook_event_name === "UserPromptExpansion" ? hook.command_name : undefined;
        return typeof command === "string" && Object.hasOwn(OFFLINE_REPLIES, command)
            ? JSON.stringify({ decision: "block", reason: OFFLINE_REPLIES[command] })
            : undefined;
    }
    catch {
        return undefined;
    }
}
const chunks = [];
let finished = false;
function finish(output) {
    if (finished) {
        return;
    }
    finished = true;
    clearTimeout(deadline);
    if (output && output !== "{}") {
        process.stdout.write(output, () => process.exit(0));
        return;
    }
    process.exit(0);
}
const deadline = setTimeout(finish, EXIT_AFTER_MS);
process.stdin.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
});
process.stdin.on("error", () => finish());
process.stdin.on("end", () => {
    if (finished) {
        return;
    }
    const body = Buffer.concat(chunks);
    try {
        const outgoing = (0, node_http_1.request)({
            hostname: "127.0.0.1",
            port: HTTP_PORT,
            path: "/hook",
            method: "POST",
            headers: {
                "content-type": "application/json",
                "content-length": body.length,
                ...(PROVIDER ? { "x-rokid-provider": PROVIDER } : {}),
            },
        }, (response) => {
            let responseBody = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                if (responseBody.length <= 64 * 1024) {
                    responseBody += chunk;
                }
            });
            response.once("end", () => {
                try {
                    const parsed = JSON.parse(responseBody);
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                        finish();
                        return;
                    }
                    finish(JSON.stringify(parsed));
                }
                catch {
                    finish();
                }
            });
        });
        outgoing.once("error", (error) => finish(error.code === "ECONNREFUSED" ? offlineReply(body) : undefined));
        outgoing.end(body);
    }
    catch {
        finish();
    }
});
process.stdin.resume();
process.once("uncaughtException", () => finish());
process.once("unhandledRejection", () => finish());
process.once("exit", () => clearTimeout(deadline));
