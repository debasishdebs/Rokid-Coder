# Spike results — 2026-11-14 (throwaway, scratchpad only)

Machine: a Mac. Claude Code 2.1.285. Codex CLI 0.163.0; shared app-server
daemon 0.169.0 running (`codex app-server --listen unix:// --managed-daemon`).
tmux is **not** installed.

## 1. Claude Code — follow-up injected via Stop hook: WORKS
- `claude -p --model claude-haiku-4-5-20251001 --settings settings.json "Reply with exactly the word APPLE."`
- `settings.json`: one `Stop` hook (timeout 600 s) that polls `inbox.txt` for 5 s and,
  if present, prints `{"decision":"block","reason":"<text>"}` (once, guarded by a flag file).
- Inbox written 4 s later: "Follow-up from glasses: reply with exactly the word BANANA."
- Transcript (session `4c37ec9c-5de8-444c-afac-2fc5f7d639a6`):
  `user: APPLE prompt → assistant: APPLE → user: "Stop hook feedback: Follow-up from
  glasses…" → assistant: BANANA`. Same session. Hook input carried `session_id`,
  `transcript_path`, `last_assistant_message`, `stop_hook_active`.
- Tested in `-p` mode; interactive mode uses the same hook system (not separately tested).

## 2. Codex — `codex queue` into a closed session: QUEUED, not run
- `codex exec` thread `01a1d63a-6d7c-7c43-8026-f82e2cc51dac` answered APPLE and exited.
- `codex queue --thread … --message "…BANANA"` → "Queued message … for thread …"; nothing ran
  (expected — no client had the thread open).

## 3. Codex — `codex app-server proxy` with plain JSON-RPC lines: NO REPLY
- Proxy closed stdin/broken pipe; no output to `initialize`. Likely needs WebSocket
  framing over the unix socket (as `codex --remote unix://`). Unresolved.

## 4. Codex — `codex queue` into a live TUI session: WORKS
- Debasish started `codex "Reply with exactly the word APPLE."` in a terminal tab.
- Live thread found via `~/.codex/thread-writer-locks/01a1d63f-4bd4-7683-a9ce-1deed791a73b.lock`
  (newer Codex stores history in `~/.codex/*.sqlite`, not rollout JSONL).
- `codex queue --thread 01a1d63f-… --message "Follow-up from glasses: reply with exactly the word BANANA."`
- TUI showed the message and replied `BANANA` ("Worked for 2s") on its own.
