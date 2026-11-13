#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_http_1 = require("node:http");
// The plugins ship a copy of this file with no node_modules and no sibling
// modules next to it, so it may import only node:* built-ins. The defaults
// below mirror approval-manager; a test pins the "no relative require" rule.
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
        outgoing.once("error", () => finish());
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
