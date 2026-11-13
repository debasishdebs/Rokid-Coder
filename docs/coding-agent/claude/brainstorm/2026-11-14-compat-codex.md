# Codex compatibility spike — shared app-server daemon (2026-11-14)

Machine: Codex CLI 0.169.0 (brew had updated from 0.163.0), daemon 0.169.0. Model used for all
turns: `gpt-6-luna` (cheapest in `model/list`), effort low, about 12 model turns total.
"TESTED" = run on this Mac. "DOCS" = from docs or generated schema only.
Scratch dir: `/private/tmp/claude-501/-Users-debasishkanhar/1fc7a898-3766-43a3-956c-0aefb8f170ab/scratchpad/codex-compat/`
(working client: `wsclient.py`, `listen.py`, `rpc.py`; pty driver: `ptydrv.py`, `send.sh`, `snap.py`;
generated protocol: `schema/` and `ts/`).

## Transport (solves the open "no reply from proxy" spike)
- Socket: `~/.codex/app-server-control/app-server-control.sock` (symlink to
  `/private/tmp/codex-daemon-501/<hash>`).
- Framing: **WebSocket over the unix socket**. Send `GET / HTTP/1.1` with `Upgrade: websocket`
  and get `101 Switching Protocols`. Frames are text, one JSON-RPC message each. The `jsonrpc` field is
  optional. No auth token is needed for the local socket. `codex app-server proxy` is only a stdio-to-socket
  byte pipe, so it needs the WS handshake too. That is why plain JSON lines got no reply.
- Handshake: request `initialize {clientInfo:{name,title,version}, capabilities:{experimentalApi:true}}`,
  then notification `initialized`.
- Protocol schema: `codex app-server generate-json-schema --out DIR` / `generate-ts --out DIR`. About 130
  client methods and 90 notifications. The stdlib-only Python client is `wsclient.py` (about 60 lines).
- Gotcha: a TUI started with several CLI overrides (`-C … -m … -c … -s … -a …` together) ran its own
  embedded app-server and was invisible to the daemon (`thread/loaded/list` was empty). Plain `codex` (no
  flags) is on the daemon, and its thread appears in `thread/loaded/list` right at launch. I did not find
  which single flag causes it. A later single-flag check (`-m` alone) did show a daemon thread, but that
  run was muddled. Treat "TUI with override flags may not be on the daemon" as unresolved.

## Results

| # | Item | Verdict |
|---|------|---------|
| 1 | Second client lists and subscribes to TUI-owned thread | WORKS |
| 2 | Follow-up into TUI session | WORKS |
| 3 | Approvals on TUI-owned thread | WORKS |
| 4 | Token usage / context fill | PARTIAL |
| 5 | Compaction on its own | WORKS |
| 6 | Model / approval / sandbox change from a client | PARTIAL |
| 7 | Agent questions | PARTIAL |
| 8 | Hooks / plugins | WORKS (Stop hook tested), plugin bundling DOCS |

### 1. List and subscribe: WORKS (TESTED)
- `thread/loaded/list {}` returns `{data:[threadId…]}`. These are the live, daemon-loaded threads, including the
  TUI's, even before its first prompt. `thread/list {limit}` returns history, with `status`
  `{type:"idle"|"active"|"notLoaded"}`, `originator:"codex-tui"`, `cwd`, `name`, `model`.
- A client that never subscribed still gets some broadcasts: `thread/started`, `thread/status/changed`,
  `thread/name/updated`.
- **Subscribe = `thread/resume {threadId, excludeTurns:true}`**. It fails with "no rollout found" if the thread
  has no turn yet. After resume the client gets the full live stream, including turns the TUI user typed
  himself: `turn/started`, `item/started`, `item/completed`, `item/agentMessage/delta`, `turn/completed`,
  `thread/status/changed`, `thread/settings/updated`, `thread/tokenUsage/updated`, `thread/queue/changed`,
  `item/commandExecution/outputDelta`.
- Item shapes: `item.type` is one of `userMessage | agentMessage | reasoning | commandExecution | fileChange |
  contextCompaction | plan …`. `commandExecution` carries `command`, `cwd`, `status`.
  `fileChange` and `turn/diff/updated` exist in the schema (the file-edit path was not exercised).
- Resume sends no replay of past events. Fetch history with `thread/turns/list` or `thread/items/list`.
- Multiple clients plus the TUI on one thread worked fine at the same time.

### 2. Follow-up: WORKS (TESTED, two ways)
- `turn/start {threadId, input:[{type:"text",text}]}` from my client. The TUI showed the user message
  and the reply live, and the TUI stayed usable.
- `codex queue --thread <id> --message <text>` worked again. Daemon clients saw `thread/queue/changed`, and
  then a normal turn started. **Queue is stored in `~/.codex/queue_1.sqlite`**, and the TUI picks it up when idle.
- `turn/start` on a thread with an active turn is documented as a steer ("Ignored when this request steers an
  active turn"). `turn/steer` also exists. Not tested while a turn was running.
- Recommended: `turn/start` over the daemon socket. It is immediate and carries overrides. Use `codex queue`
  as the fallback when the daemon link is down.

### 3. Approvals: WORKS, no double prompt (TESTED both directions)
- Setup: `approvalPolicy:"untrusted"`, so `touch x` asks.
- The server request `item/commandExecution/requestApproval` was **delivered to both the TUI and my
  subscribed client**. JSON-RPC id was a small int (0, 1). Params: `{kind:"command", threadId, turnId, itemId,
  command, cwd, commandActions, proposedExecpolicyAmendment, availableDecisions:["accept",
  {acceptWithExecpolicyAmendment:{…}},"cancel"]}`.
- Answering from my client: reply `{id, result:{decision:"accept"}}`. Other decisions: `acceptForSession`,
  `decline`, `cancel`. The command ran (file created) and the TUI dismissed its prompt on its own. The
  broadcast `serverRequest/resolved {threadId, requestId}` tells every client the request is done.
- Answering in the TUI (`y`): my client got `serverRequest/resolved` and the stale request was cleared. First
  answer wins, so there is **no double prompt**, but the client must drop its pending request on `resolved`.
- Other request types in the schema (DOCS): `item/fileChange/requestApproval`,
  `item/permissions/requestApproval`, `mcpServer/elicitation/request`.
- Caveat: with a read-only sandbox and `on-request`, luna just failed the command and did not escalate, so
  no approval was raised. Approvals were reliable with `untrusted`.
- Design impact: agentd and the TUI race. If the glasses should be the only approver, nothing stops the
  TUI user from answering too, which is fine ("first wins"). Approval requests and their pending state are
  not replayed to a late subscriber (untested).

### 4. Token usage / context fill: PARTIAL (TESTED)
- Event only: `thread/tokenUsage/updated {threadId, turnId, tokenUsage:{total:{totalTokens,inputTokens,
  cachedInputTokens,outputTokens,reasoningOutputTokens}, last:{…}, modelContextWindow:258400}}`, fired after
  each model response (also on compaction). **Context fill = `last.totalTokens / modelContextWindow`**
  (example: 18578 of 258400).
- No client method reads it on demand. `thread/read` and `thread/resume` do not include it, and a
  late subscriber gets no replay.
- On-demand fallback: the rollout JSONL
  (`thread.path`, for example `~/.codex/sessions/2026/11/14/rollout-…<id>.jsonl`) contains `event_msg` /
  `token_count` entries with `info.last_token_usage` and `info.model_context_window`. Reading the last one
  works without compacting. This is written for TUI threads too, so the older "rollouts only for `codex exec`"
  note in the design is wrong for 0.169. `state_5.sqlite.threads.tokens_used` holds the cumulative total only.
- Recommended: cache the last `tokenUsage/updated` per thread, and seed it from the rollout tail on attach.

### 5. Compaction: WORKS (TESTED)
- `thread/compact/start {threadId}` returned `{}`. Events: `turn/started`, `item/started
  {type:"contextCompaction"}`, `item/completed`, `thread/tokenUsage/updated`, `turn/completed`. The TUI
  printed "Context compacted". It runs alone, separate from the usage read.

### 6. Model / approval / sandbox change: PARTIAL (TESTED)
- There is **no stand-alone "set thread settings" method**. The overrides ride on `turn/start`: `model`,
  `effort`, `approvalPolicy`, `sandboxPolicy` (`{type:"readOnly",networkAccess}`, `workspaceWrite`,
  `dangerFullAccess`), `cwd`, `approvalsReviewer`. They apply to this turn and later turns. After each change
  every client gets `thread/settings/updated {threadSettings:{approvalPolicy, sandboxPolicy, model, effort,
  collaborationMode…}}`, and the TUI footer changed to "GPT-6-Luna low".
- `thread/resume` overrides on an already-running thread were **ignored**. The settings did not change.
- So a change takes effect with the next `turn/start` (the next prompt from the glasses). A pure
  "switch model now" with no prompt is not possible, other than a throwaway turn.
- Models: `model/list` returned gpt-6.1-sol (default), gpt-6-astra, gpt-6.1-terra, gpt-6-sol, gpt-6-luna,
  gpt-5.6-*. Efforts: low to max, plus ultra on some.
- Plan mode (`/plan` in the TUI) changed the effort to medium and `collaborationMode.mode` to `plan`.
  Both showed up in `thread/settings/updated`.

### 7. Agent questions: PARTIAL (TESTED)
- In Plan mode the model used `request_user_input`. In 0.169 this does not arrive as the blocking server
  request `item/tool/requestUserInput`. It arrives as an **`agentMessage` item with `delivery:"async"` and
  `questions:[{title, options:["A","B"]}]`** (`text` holds a plain rendering). The turn then ends, and
  the TUI showed the options as text. My client saw it via `item/completed`.
- The answer is a normal follow-up: `turn/start` or `codex queue` with the chosen text. There is no
  structured answer call to match it.
- DOCS/schema only: the blocking path `item/tool/requestUserInput` exists, with `questions:[{id,header,
  question,isOther,isSecret,options}]` and response `{answers:{<qid>:{answers:[string]}}}`. Feature
  `default_mode_request_user_input` is "under development". Handle both shapes.

### 8. Hooks and plugins
- Events (TESTED via `hooks/list` schema `HookEventName`, matches docs): `sessionStart, sessionEnd,
  userPromptSubmit, preToolUse, permissionRequest, postToolUse, preCompact, postCompact, preModelRequest,
  postModelRequest, subagentStart, subagentStop, stop, interrupt`. `hook/started` and `hook/completed` are
  also broadcast to app-server clients.
- Config (DOCS): `~/.codex/hooks.json`, `[hooks]` in `config.toml`, `<repo>/.codex/hooks.json`, or a
  plugin's `hooks/hooks.json`. Handler `type:"command"` (or `mcp_tool`), `timeout` default 600 s,
  `async:true` for background. Non-managed hooks need a trust review. `--dangerously-bypass-hook-trust`
  skips that for automation.
- **Tested**: `codex exec --dangerously-bypass-hook-trust -m gpt-6-luna -c 'hooks.Stop=[{hooks=[{type="command",
  command="/path/hook.sh",timeout=30}]}]' …` with hooks for `SessionStart`, `UserPromptSubmit`, `Stop`.
  The command hook gets JSON on stdin: `{session_id, turn_id, transcript_path, cwd, hook_event_name, model,
  permission_mode, prompt | last_assistant_message, stop_hook_active}`. Stop hook output
  `{"decision":"block","reason":"Follow-up from glasses: reply with exactly the word BANANA."}` made Codex
  **continue the same session and answer BANANA** (second Stop call had `stop_hook_active:true`).
  This is the same mechanism as the Claude Stop-hook spike. Tested in `exec`, not in the interactive TUI.
  Gotcha: `codex exec` waits on stdin when it is not a tty, so use `</dev/null`.
- Other outputs (DOCS): `additionalContext` (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse),
  `permissionDecision:"deny"` / `updatedInput` (PreToolUse), `decision:"allow"|"deny"` (PermissionRequest),
  `continue:false`, `systemMessage`.
- Plugins (DOCS): a plugin can bundle skills, MCP servers, apps and **hooks**. The schema has
  `PluginHookSummary {key,eventName}`, and the docs say plugin hooks need trust review and get `PLUGIN_ROOT`
  and `PLUGIN_DATA`. Plugin CLI: `codex plugin add|list|remove|marketplace`. Manifest filename and layout
  are not confirmed, so a spike on the actual plugin manifest is still needed. Hooks can push events out (the
  command can POST to agentd) and can inject input only through `Stop` block, `additionalContext`, or
  `UserPromptSubmit`.
- `notify` (the older per-turn notify program setting) was not checked.

## Other commands
- `codex remote-control {start|stop|pair}`: DOCS/help only. It manages the daemon with remote control
  enabled (cloud relay, `remoteControl/status/changed` shows `disabled`). `start`/`stop` would touch the
  user's daemon, so I did not run it.
- `codex agents`: an interactive TUI "agent command center" for browsing and switching sessions. Not tested.
  It is not a programmatic API.

## Recommended mechanism for agentd
1. Connect to the daemon over WS on the unix socket. Reconnect on drop. Poll `thread/loaded/list` and
   watch `thread/started`. Call `thread/resume {excludeTurns:true}` for each live thread, and keep a map
   of per-thread state.
2. HUD data: `item/started` for the current command or file and `turn/started` / `turn/completed` / `thread/status/changed`
   for the state. `thread/name/updated` gives a heading. `tokenUsage/updated` gives context fill.
3. Approvals: answer `item/*/requestApproval` over the socket, and clear on `serverRequest/resolved`.
   Implement "approval mode" in agentd by auto-answering `accept` per the mode, or by setting
   `approvalPolicy` on the next `turn/start`.
4. Follow-up: `turn/start` (with model/effort/policy overrides). Fall back to `codex queue`.
5. Compact: `thread/compact/start`. Context: cached token events plus rollout tail.
6. Hooks plugin: a `Stop` hook for "wait for a glasses reply, then block with reason" when the daemon link
   is unavailable, plus `sessionStart` to register a thread.

## Cleanup
All spawned TUI, listener and `codex exec` processes were killed. The user's daemon (pid 14712) was never
touched. Leftover files: stale `~/.codex/thread-writer-locks/01a1d649-….lock` and `01a1d64a-….lock`
(my killed TUIs, so **a lock file does not prove the thread is live**; use `thread/loaded/list`), plus
several test threads in history named "Reply with APPLE/CHERRY". `work/approval_test*.txt` exist in
the scratch dir only.
