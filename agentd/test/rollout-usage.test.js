const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readLastTokenUsage } = require("../dist/codex/rollout-usage.js");

function tokenCount(total, window) {
  return JSON.stringify({
    timestamp: "2026-11-14T10:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total * 3 },
        last_token_usage: { total_tokens: total },
        model_context_window: window,
      },
    },
  });
}

function withRollout(lines, trailingNewline, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-"));
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return run(file).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test("rollout_usage_reads_last_token_count", () =>
  withRollout(
    [
      JSON.stringify({ type: "session_meta", payload: { id: "t" } }),
      tokenCount(1000, 258400),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "hi" } }),
      tokenCount(18578, 258400),
      JSON.stringify({ type: "response_item", payload: { type: "message" } }),
    ],
    true,
    async (file) => {
      assert.deepEqual(await readLastTokenUsage(file), { used: 18578, window: 258400 });
    },
  ));

test("rollout usage skips token_count lines that carry no info and a torn last line", () =>
  withRollout(
    [
      tokenCount(500, 1000),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null } }),
      '{"type":"event_msg","payload":{"type":"token_cou',
    ],
    false,
    async (file) => {
      assert.deepEqual(await readLastTokenUsage(file), { used: 500, window: 1000 });
    },
  ));

test("rollout usage finds a token_count far above a large tail", () =>
  withRollout(
    [
      tokenCount(42, 100),
      ...Array.from({ length: 3000 }, (_, i) =>
        JSON.stringify({ type: "response_item", payload: { type: "message", i, pad: "x".repeat(200) } })),
    ],
    true,
    async (file) => {
      assert.deepEqual(await readLastTokenUsage(file), { used: 42, window: 100 });
    },
  ));

test("rollout_usage_missing_file_is_undefined", async () => {
  assert.equal(await readLastTokenUsage(path.join(os.tmpdir(), "no-such-rollout.jsonl")), undefined);
});

test("rollout usage without any token_count is undefined", () =>
  withRollout([JSON.stringify({ type: "session_meta", payload: {} })], true, async (file) => {
    assert.equal(await readLastTokenUsage(file), undefined);
  }));
