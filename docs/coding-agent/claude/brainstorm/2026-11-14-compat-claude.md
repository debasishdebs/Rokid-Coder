# Claude Code compatibility spikes — 2026-11-14

Claude Code 2.1.285, macOS, Haiku 4.5, no tmux. Throwaway harness (Python `pty` + a tiny VT screen
emulator, hook logger, `--settings` file only): `/private/tmp/claude-501/-Users-debasishkanhar/1fc7a898-3766-43a3-956c-0aefb8f170ab/scratchpad/claude-compat/`
(`drv.py`, `bin/hook.py`, `s1.py`..`s4.py`, `logs/events.jsonl`, `logs/*_screens.txt`).
Roughly 8 interactive sessions, about 17 Haiku turns. All spawned processes were killed.

Legend: **TESTED** = observed in a live pty session here. **DOCS** = from code.claude.com docs or `--help` only.

## INCIDENT — read first
In test 4c I typed `/model sonnet` in the pty. **Claude Code wrote `"model": "sonnet"` into the user's
`~/.claude/settings.json`** (screen: "Set model to Sonnet 5.5 and saved as your default for new sessions").
Before the test the value was `"model": "opus"`. I tried to restore it and the auto-mode classifier blocked
that edit, so I left it alone. **Debasish needs to set it back by hand**: `~/.claude/settings.json` -> `"model": "opus"`
(or run `/model opus` in a normal session). Nothing else in that file changed. (`~/.claude.json` also gained the
folder-trust entry for the scratch `work/` dir; that is the normal trust dialog.)
Design consequence: a pty-driven `/model X` **persists as the user's default**. Do not use it as the model-change path.

## Summary table

| # | Item | Verdict | Mechanism |
|---|------|---------|-----------|
| 1a | Stop hook `{"decision":"block","reason":...}` injects a follow-up, interactive | WORKS (TESTED) | Stop hook polls the agentd inbox |
| 1b | Typing into the prompt box while the hook waits | WORKS, queued (TESTED) | text accepted, queued, not lost |
| 1c | Esc / Ctrl+C cancel the waiting hook | WORKS (TESTED) | hook gets SIGTERM; session returns to idle |
| 1d | Screen while waiting | TESTED | spinner "running Stop hook" |
| 1e | User submits a prompt while hook waits | Hook wins (TESTED) | prompt queues until the hook ends |
| 1f | Timeout ceiling | PARTIAL | 3600 accepted; enforced at the set value; no max found in docs |
| 2 | Approval relay | WORKS (TESTED) | **PermissionRequest** hook |
| 3 | Answer AskUserQuestion from a hook | WORKS (TESTED) | PreToolUse allow + `updatedInput.answers` (also PermissionRequest) |
| 4a | Stop reason "/compact" or "/model" runs as a command | DOESN'T WORK (TESTED) | treated as plain text |
| 4b | Hook output that changes model / compacts | DOESN'T WORK (DOCS + TESTED partly) | only observe/block |
| 4c | Typing `/compact`, `/context`, `/model` into the pty | WORKS (TESTED), `/model` has a side effect | see below |
| 4d | Context / model visibility | WORKS (TESTED) | statusLine JSON, transcript usage, `/context` |
| 5 | Permission mode switch from outside | PARTIAL | PermissionRequest `setMode` (TESTED) or Shift+Tab in pty (TESTED) |
| 6 | Progress signals | WORKS (TESTED) | PreToolUse/PostToolUse `tool_input`; title via transcript `ai-title` / statusLine `session_name` |

## 0. Docs findings (current hook surface)

DOCS (https://code.claude.com/docs/en/hooks, raw page pulled with curl; statusline, remote-control, hooks-guide pages; `claude --help`):
- Events: SessionStart/End, UserPromptSubmit, UserPromptExpansion, Stop, StopFailure, PreToolUse, PostToolUse, PostToolUseFailure,
  PostToolBatch, PermissionRequest, PermissionDenied, SubagentStart/Stop, TaskCreated/Completed, TeammateIdle, ConfigChange, CwdChanged,
  DirectoryAdded, FileChanged, InstructionsLoaded, Worktree*, Notification, MessageDisplay, PreCompact, PostCompact, **PreModelSwitch**,
  **PostModelSwitch**, Elicitation, ElicitationResult, Setup.
- Hook types: `command`, `http` (POST to https or localhost; response JSON is the decision), `mcp_tool`, `prompt`, `agent`.
  An `http` hook to `127.0.0.1` could replace the shell hop to agentd. Not tested.
- Default `timeout` 600 s (command/http); 30 s for UserPromptSubmit / PreModelSwitch / PostModelSwitch; 10 s MessageDisplay.
- Stop: `decision:"block"` + `reason`, or `hookSpecificOutput.additionalContext` (continues the conversation, labelled "Stop hook feedback",
  no error banner; **not tested**). **Cap: 8 consecutive Stop continuations, reset when Claude calls a tool**
  (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it). Stop does not fire on user interrupt. Stop input also has `background_tasks` and `session_crons`.
- PermissionRequest runs only when a prompt would be shown (or a call would be auto-denied for lack of a prompt). Output:
  `decision.behavior` allow|deny, `updatedInput`, `updatedPermissions` (`setMode`, `addRules`, ...), deny-only `message` / `interrupt`.
  Exit code 2 is ignored for this event.
- PreToolUse output: `permissionDecision` allow|deny|ask|defer, `updatedInput`. `defer` is honoured only with `-p`.
- AskUserQuestion: documented in the PreToolUse section; "supply `answers` via `updatedInput`"; "returning allow alone is not sufficient".
- PreModelSwitch / PostModelSwitch exist (2.1.251+): can block or observe, cannot set a model. PreCompact can block, PostCompact observes.
- statusLine command receives JSON on stdin with `model.id/display_name`, `context_window.used_percentage`, `current_usage`, `session_name`,
  `transcript_path`, `cost`, `rate_limits` (subscribers), `workspace`. Optional `refreshInterval` (min 1 s).
- Remote Control (`claude remote-control`, `claude --remote-control`, `/remote-control`): DOCS only. It is the claude.ai / mobile-app
  bridge via Anthropic servers. Needs claude.ai login. Not available behind an LLM gateway, Bedrock/Vertex/Foundry, or a Claude apps gateway.
  Supports sending prompts, `/compact`, `/context`, `/model X`, `/effort`, `/autocompact`, answering permission prompts and AskUserQuestion from a
  connected device; model picks from a device apply to the current session only. **No local/programmatic API found** — it is a closed channel
  between the CLI and claude.ai, so it is not a usable inbound path for our own helper. Not tested (policy / Enterprise login risk, usage budget).
- `claude agents --json` (TESTED, free): lists live sessions as `[{pid, cwd, kind:"interactive", sessionId, name, status:"busy"|"idle", startedAt}]`.
  Backed by `~/.claude/sessions/<pid>.json`. Useful as a session registry and idle/busy signal.
- `claude --bg`, `claude attach <id>`, `claude logs <id>`, `claude stop <id>` (help text only, not tested): a background-session mode.
  No "send input" subcommand exists. `--input-format stream-json` is `-p` only.

## 1. Stop hook that waits, then blocks

Setup: `claude --model claude-haiku-4-5-20251001 --settings s1.json --strict-mcp-config`, where `s1.json` registers `bin/hook.py` for Stop
(`"timeout": 3600`) plus loggers for PreToolUse, PostToolUse, PermissionRequest, Notification, UserPromptSubmit, PreCompact, PostCompact, PreModelSwitch,
PostModelSwitch, SessionStart, and a `statusLine` command. The Stop hook polls `ctl/inbox` up to 90 s and prints
`{"decision":"block","reason":"<inbox text>"}`.

**1a WORKS (interactive).** Prompt "Reply with exactly the word APPLE." Hook waited, `ctl/inbox` written, hook printed the block JSON.
Screen:
```
⏺ APPLE
⏺ Ran 1 stop hook
  ⎿  Stop hook error: Follow-up from glasses: reply with exactly the word BANANA.
⏺ BANANA
```
Footer shows "Stop hook error occurred · ctrl+o to see". Transcript has `user: "Stop hook feedback: Follow-up from glasses: ..."`, a
`hook_blocking_error` attachment and a `stop_hook_summary` system record. Same session id. The second Stop has `stop_hook_active:true`
and `last_assistant_message:"BANANA"`, so the hook can wait again and chain follow-ups (watch the 8-continuation cap above).
The red "error" styling is cosmetic; `additionalContext` (DOCS) avoids it — test it in the build.

**1b WORKS, queued.** While the hook waited, typed `typed-while-waiting`: the characters appear in the prompt box normally. Pressing Enter
shows the text above the spinner with the hints `ctrl+x ctrl+s to send now` and `Press up to edit queued messages`. Not lost. `UserPromptSubmit`
fires at queue time (logged while the Stop hook was still waiting).

**1c WORKS.** Esc (during a wait) and a single Ctrl+C (separate run) each deliver SIGTERM to the hook (my handler logged `STOP_HOOK_KILLED sig:15`).
Screen: `⎿  Interrupted · What should Claude do instead?`; session stays alive and idle at an empty prompt. Transcript: `hook_cancelled` attachment +
`[Request interrupted by user]`. Queued messages are then processed (after Esc, both queued prompts ran).
Implication: if the user touches the keyboard to cancel, the glasses wait ends silently, so agentd must treat `STOP_HOOK_KILLED` / SIGTERM as "laptop took over".

**1d Screen while waiting:** `✶ Sketching… (running Stop hook · 6s · ↓ 341 tokens)` — the spinner keeps counting up the whole time. Prompt box
stays editable. The Claude reply ("⏺ APPLE") is already printed above it.

**1e Hook wins.** User text submitted during the wait only queues. In the clean run the hook kept waiting 15 s after Enter, then ended on the inbox write, and the
block reason ran first. The queued prompt did not run until the next Stop hook ended (it was released by Esc, later). If the hook ends with no
decision (timeout / empty), the queued prompt runs next. Recommended: agentd watches `UserPromptSubmit` events; on a local prompt it releases the waiting Stop hook with
no decision so the laptop user is never stuck behind the glasses wait.

**1f Timeout.** `"timeout": 3600` on the Stop hook was accepted with no error (hook ran normally). Enforcement tested with `"timeout": 25` and a 90 s hook: Claude
killed it with SIGTERM at 25.1 s, printed nothing alarming, and went idle (`✻ Baked for 26s · done`); a queued prompt then ran. No documented upper bound.
Use `timeout = Y + a few seconds` from the phone setting.

## 2. Approval relay

**WORKS — use `PermissionRequest`.** Prompt "Use the Bash tool to run `ls` and then run `echo hi1 > x1.txt`", default mode:
- `PreToolUse` fired for both calls; `PermissionRequest` fired **only for `echo hi1 > x1.txt`** (not for `ls`). It is the "a dialog is about to show" signal.
- Screen showed the dialog (`Bash command / echo hi1 > x1.txt / Do you want to proceed? 1. Yes 2. Yes, and always allow access to ... 3. No`).
- `Notification` (`notification_type:"permission_prompt"`, `message:"Claude needs your permission"`) fired ~6 s after PermissionRequest. Use PermissionRequest for
  a prompt wake-up, Notification only as a late backup.
- PermissionRequest input: `tool_name`, `tool_input`, `permission_suggestions` (e.g. `[{"type":"addDirectories","directories":[...],"destination":"session"}]`),
  `permission_mode`, `prompt_id`; no `tool_use_id`.
- Allow: stdout `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` -> screen `⎿  Allowed by PermissionRequest hook`, no dialog.
- Deny: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from glasses (test)"}}}` -> `⎿  Denied by PermissionRequest hook`;
  Haiku said "The Bash tool call was denied."
- The hook may block as long as needed (the phone round trip); when it returns nothing, the normal local dialog stays (so the laptop keeps working as a fallback).
  In test 3b the local dialog was visible while the hook waited, so the user can race it; whichever answers first wins (DOCS).
- Not recommended: PreToolUse for approvals. It fires on every tool call (even auto-allowed ones), so it would prompt the phone for `ls`.
  Keep PreToolUse for progress.

## 3. Questions (AskUserQuestion)

**WORKS two ways (both TESTED).** Input shape (PreToolUse `tool_input`):
```json
{"questions":[{"question":"Favorite color?","header":"Color","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}]}
```
**A. PreToolUse (preferred; no dialog flashes on the laptop).** Hook waits for the phone answer, then prints:
```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow",
 "updatedInput":{"questions":[...same array...],"answers":{"Favorite color?":"Blue"}}}}
```
Screen while waiting: `✻ Kneading… (running PreToolUse hook · 5s)` (no dialog). After: `⏺ User answered Claude's questions: ⎿ · Favorite color? → Blue`; Claude replied "You prefer blue."
**B. PermissionRequest.** Same `updatedInput`, wrapped as `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{...}}}}`.
The real dialog (`☐ Color / 1. Red / 2. Blue / 3. Type something. / 4. Chat about this`) is shown on the laptop while the hook waits; after the hook answered the screen showed
`Allowed by PermissionRequest hook`.
**Free text works:** `answers` value `"Purple, because it matches my shirt"` was accepted verbatim and Claude used it. So a voice answer to "answer box" needs no option match.
Multi-select: DOCS say join labels with commas (not tested). Several questions: key `answers` by each question's `question` text (only one tested).
`PostToolUse` then reports `tool_input.answers` and `tool_response.answers`, which gives agentd a confirmation record.

## 4. Model change and compaction from outside

**4a DOESN'T WORK.** Stop reason `/compact` was delivered as text: transcript `user: "Stop hook feedback: /compact"`; Haiku replied that `/compact` is "not a valid command I can execute". `/model ...` would behave the same.

**4b DOESN'T WORK (hook side).** No hook output field sets the model or triggers compaction (DOCS; nothing found in tests). PreModelSwitch can only allow/deny/ask; PreCompact only block. PreModelSwitch input (TESTED):
`{"from_model":"claude-haiku-4-5-20251001","to_model":"claude-sonnet-5-5","requested_model":"sonnet","source":"command","context_tokens":37973,"prompt_cache_warm":true,"cache_ttl":"1h","estimated_cache_write_usd":0.1519,"pricing":"catalog"}`.
Useful for showing the glasses a cost warning. The only external model-change channels are the pty keystrokes (4c) and Remote Control (DOCS, claude.ai only).

**4c Typing into the pty works.** `/context`, `/compact`, `/model` and Shift+Tab are all accepted from pty keystrokes.
- `/compact`: PreCompact (`trigger:"manual"`) -> SessionStart (`source:"compact"`) -> PostCompact fired within 15 s.
- `/context`: prints a grid + category list; the same text is stored in the transcript as a `user`/`local_command` record: `Model: claude-haiku-4-5-20251001 ... Tokens: 36.8k / 200k (18%)`, with categories (system prompt 6.5k, tools 20.5k, skills 2.7k, messages 7k).
- `/model sonnet`: opens a confirm dialog ("Switch model? ... 1. Yes, switch to Sonnet 5.5 / 2. No, go back"), Enter confirms, then `Set model to Sonnet 5.5 and saved as your default for new sessions`.
  PreModelSwitch and PostModelSwitch both fired (`source:"command"`). **Side effect: it rewrote the user's `~/.claude/settings.json` `model` key** (see INCIDENT). The dialog also eats any further typed text until answered.
- While a Stop hook is still waiting, typed slash commands only queue; the pty wrapper must wait for idle (`claude agents --json` `status:"idle"`, or the Stop hook having ended).
  After the idle point a `/compact` typed worked immediately.
- A pty wrapper launcher is therefore viable for `/compact` and `/context`. For model change it works but persists the default; mitigate by restoring the old value afterwards, or only offer it as an advanced option.

**4d Context / model visibility (all TESTED).**
- statusLine JSON (stdin of a `statusLine` command; refreshed on events): `model:{id:"claude-haiku-4-5-20251001",display_name:"Haiku 4.5"}`,
  `context_window:{total_input_tokens,total_output_tokens,context_window_size:200000,current_usage:{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens},used_percentage:20,remaining_percentage:80}`,
  `session_name`, `session_id`, `transcript_path`, `cost:{total_cost_usd,...}`, `version`, `prompt_cache`, `exceeds_200k_tokens`. Also `rate_limits` for subscribers (DOCS).
  Constraint: a statusLine is a single setting, so the plugin cannot add one without clobbering the user's own; it can still be set through `--settings` on a launcher, or the plugin can read the transcript instead.
- Hook inputs do not carry model or context, except SessionStart (`model`), Pre/PostModelSwitch (`from_model`, `to_model`, `context_tokens`) and PostCompact. Common fields include `permission_mode`, `prompt_id`, `effort` (DOCS).
- Transcript JSONL: each `assistant` record has `message.usage`. `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the **latest** assistant record
  = context fill: 10 + 36348 + 443 = 36,801, matching `/context` "36.8k" and the statusLine `used_percentage` formula (input only). Percentage = that / window size (200k; 1M for extended models).
  Note: `transcript_path` can lag in-memory state (docs); Stop input carries `last_assistant_message` so use that for "done" text.

**Recommendation:** read context from the transcript's last `usage` (works with a plain `claude`, no setup). Model from SessionStart + PostModelSwitch hooks. Compact/model change: pty-wrapper launcher only (`rk claude`), otherwise show "do it on the laptop".

## 5. Permission mode from outside

**PARTIAL — two real mechanisms, plus emulation.**
- **PermissionRequest `updatedPermissions` (TESTED):** hook output
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}]}}}`
  allowed that call **and** switched the session: footer changed to `⏵⏵ accept edits on (shift+tab to cycle)`, later hook inputs showed `permission_mode:"acceptEdits"`, and a `Write` call then ran with no prompt.
  Limit: it can only fire when a permission prompt is pending, so it cannot switch an idle session by itself. `bypassPermissions` only applies if the session was launched with bypass available (DOCS, not tested). `destination:"session"` keeps it out of settings files.
- **Shift+Tab in the pty (TESTED):** `\x1b[Z` cycled the footer `manual` -> `accept edits` -> `plan` -> `manual` -> `accept edits` (auto mode not available on Haiku here). Transcript records `permission-mode` entries. Needs a pty wrapper.
- **Emulation (recommended default for plain `claude`):** keep the session in default/ask mode and let agentd answer PermissionRequest per glasses mode:
  `ask` = forward to phone; `accept edits` = auto-allow Edit/Write/NotebookEdit (and optionally safe Bash); `approve all` = auto-allow everything. This needs no mode change in Claude and matches the design's [call].
  Surface the effective mode on the board. Use `setMode` only to keep Claude's own footer in sync.

## 6. Progress signals

TESTED, all from hook inputs:
- `PreToolUse` / `PostToolUse` carry `tool_name`, `tool_input` and `tool_use_id`. Examples: Bash `{"command":"echo hi4 > x4.txt","description":"Write \"hi4\" to x4.txt"}` (the `description` is a ready-made step label);
  Write `{"file_path":".../x5.txt","content":"hi5"}`. PostToolUse adds `tool_response` and `duration_ms`.
- `UserPromptSubmit.prompt` = the user's latest prompt (use for the heading).
- `Stop.last_assistant_message` = the final text for the summary / output reader, plus `background_tasks` (running shells/subagents) to tell "done" from "paused for background work".
- Title: the transcript has `{"type":"ai-title","aiTitle":"Apple"}` records (Claude's own auto session title); statusLine JSON has `session_name`. Both are free; the title appears after the first turn.
- Task list: `TaskCreated` / `TaskCompleted` events exist (DOCS) for sessions that use the task tool. Not tested.
- `prompt_id` ties events of one prompt together. `session_id` + `transcript_path` are in every hook input.

## Recommended mechanism (all main path = plain `claude`)

1. Plugin ships hooks (plugin `hooks.json`; not tested here, `--settings` was used) forwarding to agentd on loopback. Consider `type:"http"` hooks pointing at `127.0.0.1` for those that must wait (Stop, PermissionRequest, AskUserQuestion PreToolUse).
2. Follow-up: Stop hook blocks until a glasses reply (<= Y) then `{"decision":"block","reason":...}`. Release early on local `UserPromptSubmit`, SIGTERM or Y. Handle the 8-continuation cap.
3. Approvals: PermissionRequest hook, held for the phone, mode emulation in agentd. Notification `permission_prompt` only as backup.
4. Questions: PreToolUse on `AskUserQuestion`, wait for the glasses/voice answer, return allow + `updatedInput` with `questions` echoed and `answers`. Free text allowed. Keep the Stop/question waits under the hook `timeout`.
5. Context: transcript `usage`. Model: SessionStart / PostModelSwitch. Session list + idle/busy: `claude agents --json`.
6. Compact, model change and mode switch for already-running plain sessions: not possible without a pty. Offer them only for sessions started via the optional `rk claude` pty launcher (Python-free equivalent in Node `node-pty`), and warn about the `/model` default side effect.

## Untested / open
- `additionalContext` Stop variant, Stop hook as `type:"http"`, plugin-bundled hooks, `bypassPermissions` setMode, multi-select / multi-question answers, `--remote-control`, `--bg` / `attach`, `TaskCreated`.
- Behaviour of two concurrent sessions each with a waiting Stop hook (should be independent, one hook process per session).
- Whether Esc on the laptop during a wait should be treated by agentd as "cancel"; observed: yes, the hook just dies (SIGTERM) and the session stays usable.
