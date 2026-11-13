# Rokid-Coder — Design

Date: 2026-11-14 · Status: draft for approval · Source: brainstorm on 2026-11-13/14
(spike evidence: `../brainstorm/2026-11-14-spike-results.md`)

Legend: **[user]** = decided by Debasish. **[call]** = Claude's call, open to override.
**[spike]** = confirmed by a test on this Mac.

---

## 1. Intent and why

The user's day is context switching: meetings, other tasks, walking around.
He runs long Claude Code and Codex sessions on his laptop, minimises them, and
loses track — today he faces long delays because he can't tell when a task has
finished or is waiting on him.

Rokid-Coder puts those sessions on his Rokid glasses. At a glance he sees what
each session is doing, gets pulled in the moment it needs him (approval, a
question, done), reads the result, and sends the next prompt by voice — without
going back to the desk. **[user]**

Success: he never again discovers a session that finished (or sat blocked on an
approval) long ago without him knowing; and he can keep a session moving from the
glasses for the common cases (approve, answer, follow-up).

## 2. Typical use

- Usually **two sessions at once: one Claude Code, one Codex**. One develops, the
  other reviews. **[user]** The glasses must tell them apart at a glance.
- Sessions are **always started on the laptop**, normally — `claude` / `codex` in a
  terminal. **[user]** The glasses/phone never start sessions in v1.
- The **laptop (or later a VM) is the processor**. Glasses are relay + display
  only; nothing runs on them. **[user]**
- Uses the **accounts already logged in on the laptop** for each CLI. No API keys,
  no separate billing. **[user]**

## 3. Goals, non-goals, anti-goals

### Goals (v1)
1. **Progress HUD** per session: tool badge (Claude / Codex), short heading of the
   work, the file currently being edited, the current step (e.g. "running tests"),
   and a clear **Done**. **[user]**
2. **Update cadence**: once-a-minute digest by default, live as an option (phone
   setting). **Approvals, questions and Done always break through immediately.** **[user]**
3. **Approvals**: an approval request **wakes the HUD** and asks. Approve/deny by
   **tap or voice**. **[user]**
4. **Approval mode** per session, switchable from the glasses. Options shown match
   the tool in use — Claude: ask / accept edits / approve all; Codex: its approval
   policies. Swipe through options, tap to pick, expand an option to read more
   text. **[user]**
5. **Agent questions** (Claude's multiple-choice questions, Codex's equivalent):
   same swipe/tap list; user can move to the question's answer box and fill it by
   **voice**. **[user]**
6. **Reading output**: short summary first, then the full output in pages scrolled
   by tap/swipe. **[user]**
7. **Follow-up prompt by voice** into the **same conversation** (keyed by Claude
   session ID / Codex thread ID). **[user]**
8. **Controls**: change model, compact, check context. Claude: what `/context`
   reports. Codex: token usage shown on its own, and compact as a separate control
   (fallback: combined, if splitting proves hard). **[user]**
9. **Waiting for the user**: when a session is waiting on him, the glasses
   re-notify every *X* minutes until a wait limit *Y* expires; both set in the phone
   app. After expiry the session is "go back to the laptop" — that's acceptable,
   not a bug. **[user]**
10. **Alerts follow phone DND** (glasses DND isn't readable) plus a manual quiet toggle
    (§6.2): in DND or quiet → display only; otherwise
    sound + display. **[user]**
11. **Configuration lives in the phone app.** **[user]**
12. **Released as plugins for both tools** (a Claude Code plugin and a Codex
    plugin) plus the laptop helper. **[user]**

### Non-goals (v1)
- Starting sessions from glasses or phone. (Nexus already can; leave it, don't
  build on it.) **[user]**
- Windows hosts → **v2**; WSL is the likely route. **[user]**
- Remote VM hosts (AWS/GCP) → later, but **don't block it** (see §7). **[user]**
- Codex Desktop App and Claude desktop app sessions. CLI for both. **[user]**
- Shipping to other users / signing other people into their subscriptions. This is
  for personal use. **[call]**

### Anti-goals (would make it a failure even if it "works")
- A session finishes or blocks and the glasses don't say so promptly. (The whole
  point.) **[call, from the why]**
- A glasses reply landing in the wrong session or a new conversation. **[call]**
- Noisy alerts in meetings (ignoring DND). **[user]**
- Silent auto-approval the user didn't choose for that session. **[call]**
- Requiring a special way to launch sessions for the main path. Normal `claude` /
  `codex` must work. **[user + spike]**

## 4. Shape of the system

```
 Laptop (Mac, v1)                          Phone (Android)                Glasses
 ┌──────────────────────────────┐         ┌─────────────────────┐        ┌──────────────┐
 │ claude (normal CLI)          │         │ Nexus host app      │        │ Nexus        │
 │  └ Rokid-Coder Claude plugin │──hooks─▶│  └ Rokid-Coder      │◀─CXR──▶│ glasses-hub  │
 │ codex  (normal CLI)          │         │    Agents plugin    │        │  card / HUD  │
 │  └ Rokid-Coder Codex plugin  │         │    (config, STT,    │        │ (+ CXR direct│
 │ shared Codex app-server      │         │     notifications)  │        │  where Nexus │
 │ agentd (forked, improved)    │◀──WS───▶│                     │        │  falls short)│
 └──────────────────────────────┘ LAN /   └─────────────────────┘        └──────────────┘
                                  Tailscale
```

### 4.1 Base: fork of Rokid-Nexus **[user]**
- New repo **Rokid-Coder** = fork of `github.com/Anezium/Rokid-Nexus` (Apache-2.0),
  local clone at `~/Desktop/rokid/rokid-resources/nexus/Rokid-Nexus`. GitHub fork
  renamed, so upstream PRs stay easy. **[call]** Keep changes upstream-clean where
  practical. **[user]**
- Improve `agentd/` (laptop helper) and `plugins/agents/` (phone plugin + glasses
  card). Use the **CXR SDK directly** where Nexus falls short — e.g. waking the HUD
  for an approval, reliable delivery — applying PCA/LiveFit lessons. **[user]**
- Nexus is also the planned base for PCA v2, so work here should be reusable there.
  **[user]**

### 4.2 What Nexus already gives us (verified by reading the repo)
- `agentd`: Node 20/TS, Windows + macOS. Claude hooks on loopback `127.0.0.1:8791`
  (`install-hooks` merges into `~/.claude/settings.json`), transcript JSONL tailing,
  holds `PreToolUse` for phone Allow/Deny (`approval-manager.ts`), phone link over
  token-authenticated, **unencrypted** WebSocket `:8792` (`phone-link.ts`,
  `ws-server.ts`), QR/JSON pairing, LAN + Tailscale discovery.
- Codex: `agentd/src/codex/` attaches to/starts **its own** `codex app-server` on
  `127.0.0.1:8390`. **Threads started by other Codex clients are monitoring-only.**
- Replies to existing sessions: only via `tmux send-keys` / `screen -X stuff`, off by
  default (`terminal-input.ts`, `allowTerminalInput`).
- `plugins/agents`: board of sessions on the glasses, ENTER opens Allow/Deny or the
  conversation; foreground service; settings for computers/projects; **posts no
  phone notifications** by design.
- No auto-approve, no voice, no TLS.

### 4.3 What PCA/LiveFit teach (from `proactive-context-agent/docs/spikes/2026-10-12-phase0-results.md` and handoffs)
- CXR `sendMessage` rc=0 means handed off, not delivered → **app-level acks**.
- If the glasses activity exits, messages are **silently lost** (they still flow
  while the display sleeps) → must detect/relaunch before sending critical events.
- After a Bluetooth drop the link self-resumes in ~2 s but at ~half throughput.
- Final STT result can be null → fall back to last partial.
- Voice path that works: glasses push-to-talk PCM16 16 kHz → phone on-device STT.
  Nexus also exposes `stt`/`tts` capabilities (`nexus-platform.md`).
- Hi Rokid auth token leaks to logcat (`client-l`) — don't ship verbose logging.

## 5a. Compatibility results (tested 2026-11-14)

Full evidence: `../brainstorm/2026-11-14-compat-{claude,codex,glasses-phone}.md`.
Everything below was tested live on this Mac unless marked DOCS.

| Capability | Claude Code (normal `claude`) | Codex (normal `codex`) |
|---|---|---|
| Progress: tool, file, step | WORKS: Pre/PostToolUse `tool_input` | WORKS: daemon `item/*` events |
| Task heading | WORKS: transcript `ai-title`, `claude agents --json` | WORKS: thread `name` / `thread/name/updated` |
| Done | WORKS: Stop hook | WORKS: `turn/completed` |
| Approvals | WORKS: `PermissionRequest` hook (fires only when a dialog would show) | WORKS: `item/commandExecution/requestApproval`; answering from client dismisses TUI prompt, no double prompt |
| Approval mode switch | Emulated in agentd (auto-answer PermissionRequest); `setMode` only while a prompt is pending | PARTIAL: `approvalPolicy` override rides on next `turn/start` |
| Agent questions | WORKS: PreToolUse on AskUserQuestion, `allow` + `updatedInput.answers`; free text OK | PARTIAL: arrives as async `agentMessage` with `questions[]`; answer = ordinary follow-up |
| Voice follow-up, same conversation | WORKS: Stop hook `decision:block`. Typing at the laptop during the wait is queued, not lost; Esc/Ctrl+C cancels the wait; timeout 3600 accepted. DOCS: max 8 consecutive continuations, reset by tool calls | WORKS: `turn/start` on daemon or `codex queue` |
| Context fill | WORKS: last assistant `usage` from transcript (matches `/context`); statusLine `used_percentage` | PARTIAL: `thread/tokenUsage/updated` event only (cache last value); rollout `token_count` fallback |
| Compact | **NOT via hooks**; only by typing `/compact` into the terminal | WORKS: `thread/compact/start` |
| Model change | **NOT via hooks**; only by typing `/model` into the terminal, and that **also saves it as the global default** | PARTIAL: model override rides on next `turn/start` |

Glasses/phone (Nexus code reading; devices are attached over adb but nothing was run on them):
- **Wake HUD: PARTIAL.** `NexusNotice(wakeDisplay=true)` overlay band with up to 3 actions,
  works over other glasses apps. Wake is a 3 s pulse. A wake on a cold budget always goes through.
  While the budget is hot (within 5 s of the last wake), only new notices get in, and at most 2
  unattended ones until 60 s of quiet (`DisplayWakePolicy.kt` ~L92–124). Only the `assistant`
  plugin may hold the display (≤90 s). Agents plugin never sets
  `wakeDisplay`; Done isn't an alert state. A plugin can't use CXR directly — the phone hub owns the
  only CXR session — so "CXR-direct" means changing **our fork's hubs**.
- **Delivery: NOT SUPPORTED.** No acks/retry/notice replay on the Nexus bus; Agents marks an alert
  delivered on Binder hand-off. `/notice/closed` is **not** an ack: the phone emits it on
  replacement, before the glasses ever received the notice (`PhoneNoticeRouter.kt` ~L65–74).
  We add real acks. See §12.2.
- **Sound: PARTIAL.** No glasses-side audio in Nexus; sound = phone audio routed to the glasses
  over Bluetooth (A2DP), as PCA already does.
- **DND: PARTIAL.** Phone `getCurrentInterruptionFilter()` (no permission, untested on the Samsung);
  glasses have no readable DND.
- **Input/STT: SUPPORTED.** Swipe/tap/ENTER/back; `stt` capability for tap-to-talk (not the wake word;
  Hi Rokid holds the mic).
- **Lists/paged text: SUPPORTED** with existing card types (`richLines`, `NexusReader`, paged notices —
  a notice is paged *or* answerable, not both).
- **Fork/deploy: SUPPORTED** (sideload via adb; phone and glasses hubs must be changed together —
  notice version is exact-match gated; repoint `RELEASES_URL`).
- **Background survival: PARTIAL.** Known Vivo freeze; fix by showing the foreground notification.

## 5. Per-tool integration (main path = normal CLI, no launcher) **[user + spike]**

### 5.1 Claude Code
- **Rokid-Coder Claude plugin** bundles the hooks (instead of agentd editing
  `~/.claude/settings.json`). **[call]** Hooks forward events to agentd on loopback.
- **Follow-up from glasses — [spike] confirmed**: the plugin's **Stop hook** waits
  for a glasses reply and returns `{"decision":"block","reason":"<prompt>"}`; Claude
  continues **in the same session** with that text. Wait limit = phone setting *Y*
  (hook `timeout` set to match). Note: the text arrives labelled as "Stop hook
  feedback", not as a user message — acceptable; builder may wrap it in clear
  framing.
- After *Y* expires the hook releases; the session is idle at the prompt and the
  user continues at the laptop. **[user]**
- **Approvals** use the `PermissionRequest` hook, not `PreToolUse` (which fires on every
  call). **[spike]** Nexus already holds approvals on `PermissionRequest` and not on
  `PreToolUse` (`agentd/src/daemon.ts` `processHook`). That is kept.
- **Approval mode, one mechanism in both modes**: agentd answers `PermissionRequest`
  automatically according to the mode chosen on the glasses (ask / accept edits =
  auto-allow edit tools / approve all). Claude's own mode on the laptop is left as is.
  It can only make Claude ask *less*, never more. The launcher does not use Shift+Tab
  for this. **[call]**
- **Questions**: `PreToolUse` on AskUserQuestion returns `allow` + `updatedInput` with
  `answers:{questionText: label}`. **[spike]**
- **Context**: last assistant `usage` in the transcript (matches `/context`). **[spike]**
- **Model change / compact**: not possible via hooks. Only by typing into the
  terminal. See §11 ruling.
- **Optional launcher**: `rk claude` = a small pty wrapper around the real `claude`
  (no tmux needed; also works on Windows later) that can type `/compact`, `/model`,
  Shift+Tab, and replies after the wait expires. Note `/model` typed this way also
  saves the model as the global default. **[call]**

### 5.2 Codex (CLI and shared app-server daemon both 0.169 on this Mac; brew updated from 0.163 during testing)
- Normal `codex` sessions run on the **shared local app-server daemon**
  (`daemon_auto_start`; `codex app-server --listen unix:// --managed-daemon`).
- **Follow-up from glasses — [spike] confirmed**: `codex queue --thread <id>
  --message <text>` into a live TUI session → the TUI picked it up and answered in
  the same thread within seconds. If the session isn't open, the message stays
  queued (fine). **[user]**
- Thread IDs: newer Codex stores threads in `~/.codex/*.sqlite`
  (`thread_history_1`, `queue_1`, `state_5`), with `~/.codex/thread-writer-locks/<id>.lock`
  (lock files survive killed TUIs, so use `thread/loaded/list` to find live threads).
  Rollout JSONL is written for TUI threads too (`thread.path`). Seed context fill on
  attach from its last `token_count` entry.
- **Change vs Nexus**: instead of agentd's private app-server on :8390, agentd
  connects to the **shared daemon** so normal TUI threads get status, token usage,
  approvals, model and compact — not just monitoring. **[spike]** Socket
  `~/.codex/app-server-control/app-server-control.sock`, WebSocket over the unix
  socket, one JSON-RPC message per text frame, no local auth; `initialize` then
  `initialized`; subscribe with `thread/resume {threadId, excludeTurns:true}`; live
  threads from `thread/loaded/list`. Reference client:
  `../brainstorm/spike-scripts/codex/wsclient.py`.
- **Rokid-Coder Codex plugin**: Codex `plugins` and `hooks` features are stable in
  this version. Use for whatever the daemon link doesn't cover (e.g. pushing events).
  **[call]**
- **Context vs compact separate**: app-server emits token-usage updates (per Codex
  research), so context is shown continuously; compact is its own control.

## 6. Glasses and phone behaviour

### 6.1 Glasses HUD **[user, layout = call]**
- **Board**: one row per session — `CLAUDE` / `CODEX` badge, heading, current file,
  step, state (working / waiting on you / done / error).
- **Wake events**: approval, question, done, error → wake HUD, show the item,
  sound unless DND.
- **Digest**: otherwise update once a minute (or live, per setting).
- **Lists** (approval options, modes, models, question options): swipe to move, tap
  to pick, expand to read the full text.
- **Answer box**: navigate to it, push-to-talk, see transcript, confirm to send.
- **Output reader**: summary page, then paged full output.
- **Reminder loop**: while waiting on the user, re-alert every *X* until *Y*.
- Display is green monochrome; keep it to a few short lines (`rokid-platform-notes.md`).

### 6.2 Phone app (Agents plugin settings) **[user]**
- Update cadence (digest 1 min default / live).
- Wait limit *Y* and reminder interval *X*.
- Default approval mode per tool.
- Pairing / computers (exists in Nexus).
- Sound behaviour follows **phone** DND (glasses have no readable DND), plus a manual
  "quiet" toggle in the phone app and on the glasses. If DND state can't be read,
  treat as quiet (display only). **[call]**

## 7. Constraints
- **v1 host: macOS only.** Windows v2 (WSL likely). **[user]**
- **Remote VM later**: keep the phone↔host link host-agnostic (Tailscale already
  works this way); don't assume loopback-only for anything except hooks →
  agentd. **[user + call]**
- **Security**: Nexus's phone link is unencrypted WS. Rokid-Coder adds a pinned-TLS link
  for anything that steers a session (§12.1). The current approval mode is always visible
  on the board. **[call]**
- **Accounts**: drive the official CLIs with the user's own login. Anthropic's Agent
  SDK rule restricts third-party products signing users into claude.ai; personal
  use of the real CLI is fine. Revisit if ever distributed. **[call]**
- **Usage budget is tight this month** — spikes and tests should use tiny prompts
  and cheap models. **[call]**

## 8. Repo and docs layout **[user]**
```
Rokid-Coder/                     (fork of Rokid-Nexus)
  docs/coding-agent/claude/brainstorm/   notes, spike results
  docs/coding-agent/claude/design/       this document
  docs/coding-agent/claude/plan/         implementation plan(s)
  docs/coding-agent/codex/reviews/       Codex diff reviews
```
Codex acts as diff reviewer (as on PCA). **[user, from PCA practice]**

## 9. Open items
Resolved by the 2026-11-14 compatibility tests (see §5a). Remaining:
1. ~~Claude model change and compact~~: resolved by §11a. Both modes ship, and each
   mode's limits are shown to the user.
2. Codex TUI started with several override flags together ran an embedded server
   invisible to the daemon; plain `codex` is fine. Isolate which flag. **Builder spike.**
3. Codex plugin manifest bundling hooks — docs only. **Builder spike.**
4. On-device tests (wake pulse, ack round-trip, A2DP sound, Samsung DND read) —
   prioritised list in `../brainstorm/2026-11-14-compat-glasses-phone.md`.
5. Stale `~/.codex/thread-writer-locks/*.lock` files survive killed TUIs — use
   `thread/loaded/list`, not lock files, to find live threads.

## 11a. Ruling: two Claude modes, both in v1 **[user, 2026-11-14]**
Both are supported, and **the user is told each mode's limits clearly**: on the
glasses board (a mode tag on the session row), in the session's control menu, in
the phone app, and in the `/rokid` and `rk claude` startup text.

| | Plugin mode: normal `claude` + `/rokid` | Launcher mode: `rk claude` |
|---|---|---|
| Progress, Done, approvals, questions, context | ✅ | ✅ |
| Voice follow-up | ✅ while the session waits (limit *Y*); after that, continue at the laptop | ✅ always, also after *Y* expires |
| Approval-mode switch | ✅ (agentd auto-answers) | ✅ (same mechanism) |
| Compact | ❌: shown greyed out as "needs rk claude" | ✅ |
| Model change | ❌: shown greyed out as "needs rk claude" | ✅, with a warning that it also changes the default for new sessions |

- `/rokid` is a slash command from the Rokid-Coder Claude plugin. It attaches the current session
  to the glasses. My call: sessions are opt-in, so unattached sessions don't send anything.
- `rk claude` starts attached.
- Codex needs no mode split. All capabilities work on normal `codex` sessions through the shared
  daemon.
- **Codex is opt-in too** **[user]**, the same way as Claude. A Rokid-Coder Codex plugin command or
  skill attaches the current thread, and `rk codex` starts attached. Unattached daemon threads are
  never shown. **Builder spike:** how a Codex plugin command/skill learns its own thread ID to
  register it with agentd. **Resolved 2026-11-14 [spike]:** Codex sets `CODEX_THREAD_ID` (= `CODEX_SESSION_ID`)
  in the env of every command it runs, and hook inputs carry `session_id`. Commands run inside the session have
  network disabled by the sandbox (`CODEX_SANDBOX_NETWORK_DISABLED=1`), so **attach from a hook** (e.g.
  `UserPromptSubmit` spotting the attach command), not from a sandboxed shell command. Never by cwd (§12.4).

## 11. Calls made after the builder check **[call]**
- Sound plays through the glasses via phone audio over Bluetooth. Phone shows only the
  foreground-service notification (needed for background survival); no per-event phone
  notifications.
- Approvals: Claude via `PermissionRequest` only (existing allowlists still apply); Codex via
  daemon approval requests. The glasses approval mode decides how those are answered.
- Codex model / approval-policy changes from the glasses apply on the next follow-up; the
  HUD shows them as "pending" until then.
- Wake: extend our fork's hubs so Agents can raise a `wakeDisplay` notice for approval,
  question and Done, with a longer hold than the 3 s pulse, within the reminder loop.
- `glasses-hub` and `phone-hub` in the fork are ours to change; deploy over adb, test on
  the user's glasses and phone.
- Plugins install from the Rokid-Coder repo as a marketplace for both tools; no public
  publishing.
- Latency target: approvals, questions and Done on the glasses within ~5 s.
- No fixed build order **[user]**. The plan decides the slicing as it goes, based on risk and
  what each slice unlocks.

## 10. Left to the builder
Exact HUD layout and wording, protocol additions between agentd and the plugin,
digest content, how the heading is derived (first prompt summary vs agent's own
title), test strategy, and slicing into versions toward v1 (as was done for PCA).

## 12. Contracts and failure modes (from Codex design review, 2026-11-14)
Review: `../../codex/reviews/2026-11-14-design-review.md`. Every finding was checked against
the code or the evidence and accepted. All items here are **[call]** unless marked otherwise.

### 12.1 Securing the phone link (review #1)
- Nexus sends its bearer token over plaintext WebSocket (`agentd/src/phone-link.ts` ~L406–424).
  Steering (approvals, prompts, mode changes) must not run over that.
- v1 adds **TLS on the phone link**, with agentd's self-signed certificate fingerprint carried in
  the pairing QR and pinned by the phone. Tailscale stays optional.
- With no TLS (old pairing), the link is monitor-only.
- **Approve-all** is per session and needs an explicit confirm on the glasses. It resets to the
  default mode when the session ends or agentd restarts. The phone can revoke it for all sessions.
- **The user is told whenever approve-all resets [user]:** a glasses alert ("Approve-all off —
  <session>: session ended / helper restarted"). After a helper restart it is sent once the phone
  reconnects, for each session that had it on. The session row then shows the mode it fell back to.

### 12.2 Alert lifecycle and delivery (review #2, #7)
- Every alert (approval, question, Done, error) has an id and moves through these states:
  `queued → sent → shown (glasses ack) → acted / dismissed → expired`.
- **Only a glasses-side "shown" ack counts as delivered.** `/notice/closed` (with reason
  REPLACED) never counts.
- No ack within ~5 s: retry with backoff. Then the reminder loop runs every *X* until *Y* expires.
- **Alert queue:** Nexus has one notice slot, so agentd and the plugin keep a queue of all pending
  alerts across sessions. Priority: approval > question > error > Done. Within a priority, oldest
  first.
- **No starvation:** an alert waiting longer than 30 s moves to the front of its priority class and
  is then treated as an approval-level alert.
- **Dwell and preemption:** a shown alert stays at least 8 s, or until it is acted on. Only an
  approval can preempt it before then. A preempted alert goes back to the head of the queue.
- **All thresholds here are phone-app settings [user]:** the 30 s age boost, 8 s dwell, retry
  backoff, ~5 s target, *X* and *Y*. The values given are defaults.
- **5 s target:** applies to the first alert of a burst. Any later ones show as "+N waiting" on the
  current alert within 5 s and are reached by swiping.
- An answer is bound to its alert id and session id, so it can never land on another session.
  The board shows "+N waiting".

### 12.3 Reconnects (review #3)
- When the phone disconnects, any approval still pending falls back to the laptop prompt. The
  glasses mark it "expired — answer on laptop" and never show it as still actionable. Nexus
  already cancels on disconnect (`approval-manager.ts` ~L293–296); we keep that and make it visible.
- On reconnect, agentd re-subscribes to each attached Codex thread (`thread/resume`), rebuilds
  history from `thread/turns/list`, and re-seeds context from the rollout. Claude state comes back
  from the transcript.
- Every reply/answer/command from the glasses carries a unique message id (UUID made on the phone).
  agentd keeps the ids it has applied on disk (`~/.rokid-coder/applied-ids`, kept 24 h), so it
  survives a restart. A repeated id is acked again but not run again.
- The hook wait limits match *Y* from the phone setting.

### 12.4 Attaching sessions, with exact ids (review #4)
- A session is identified **only by its exact id**, never by matching the working folder.
  - Claude: `session_id` from the hook input. `/rokid` runs a hook or command that sends the
    current `session_id` to agentd.
  - Codex: the thread id, from the hook input `session_id` / env `CODEX_THREAD_ID` (§11a). Matching by
    folder is not allowed.
- Attach and detach survive an agentd restart, and also `claude --resume` / `codex resume` of the
  same id.
- Until a session is attached, its hooks send nothing, there are no subscriptions, no output is
  forwarded, and no auto-approvals happen.

### 12.5 Claude follow-ups and taking over at the laptop (review #5, #8)
- agentd counts consecutive Stop continuations per session (cap 8, reset by tool calls).
- When the cap is reached in plugin mode, the glasses don't take new voice prompts. They show
  "continue on laptop or rk claude". No prompt is accepted that can't be delivered.
- Taking over at the laptop: a `UserPromptSubmit` hook on the laptop releases any waiting Stop
  hook straight away. Any half-finished voice reply is then cancelled, and the glasses say so.
  Esc / Ctrl+C at the laptop has the same effect.
- **Launcher mode:** `rk claude` sends one command at a time. It never types while Claude is busy
  or a hook is waiting. Each command waits for the prompt to be idle.

### 12.6 Codex settings changes (review #6)
- When idle: a follow-up from the glasses uses `turn/start` with any pending settings (model,
  effort), not `codex queue`.
- `codex queue` is used only when `turn/start` isn't possible, and pending settings are then kept
  for the next `turn/start`.
- During a busy turn: settings stay pending.
- **The approval mode from the glasses is never sent to Codex as a native `approvalPolicy`.** As with
  Claude, agentd auto-answers individual approval requests according to the mode on the glasses, and the
  thread's native policy stays one that asks. That way approve-all lives only in agentd's memory and
  really resets when agentd restarts or the session ends (§12.1). Pending settings from the glasses are
  therefore model and effort only.
- **Permanent approve-all is laptop-only [user]:** set it natively on the laptop (Codex `-a never` /
  config, Claude's own permission mode). The glasses can only set the temporary one held by agentd. The
  board shows the session's native mode as well, so a permanently permissive session is visible.
- A setting shows as **applied** only when `thread/settings/updated` confirms it.
- The sandbox policy is a separate control from the approval policy. In v1 it is shown but not
  changed from the glasses.
