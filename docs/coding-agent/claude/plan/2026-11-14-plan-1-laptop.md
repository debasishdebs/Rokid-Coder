# Rokid-Coder Plan 1: Laptop Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mac side of Rokid-Coder work end to end against a scripted fake phone:
- opt-in attach for normal `claude` and `codex` sessions
- progress, approvals, questions, follow-ups, Codex controls
- temporary approval modes
- the alert lifecycle
- a pinned-TLS phone link

**Architecture:**
- Fork Rokid-Nexus and extend its `agentd` (Node/TS).
- Claude events arrive through a new Rokid-Coder Claude Code plugin whose hooks reuse `agentd`'s existing `hook-forward` → `127.0.0.1:8791/hook` path.
- Codex is reached by connecting `agentd` to the user's **shared** Codex app-server daemon (WebSocket over its unix socket), replacing the private `:8390` server.
- New policy and alert logic lives in small pure modules with fake-clock unit tests. They are wired into the existing `daemon.ts`, `approval-manager.ts`, `codex/monitor.ts`, `phone-link.ts` and `ws-server.ts`.

**Tech Stack:**
- Node ≥20 (local is v26), TypeScript 5.8, CommonJS.
- `node:test` running on compiled `dist/`.
- `ws` ^8.18 (already a dependency; it supports `ws+unix://`).
- New dependency `selfsigned` for the TLS certificate.
- Claude Code 2.1.285, Codex CLI and daemon 0.169.0.

**Spec:** `docs/coding-agent/claude/design/2026-11-14-rokid-coder-design.md`. Read it first, especially §5a, §11a and §12. Evidence is in `docs/coding-agent/claude/brainstorm/`. Working reference scripts are in `docs/coding-agent/claude/brainstorm/spike-scripts/`.

**Plan series:**
- This is Plan 1 of 3.
- Plan 2 covers the phone and glasses: Agents plugin UI, hub wake and ack changes, STT, phone TLS server, device tests.
- Plan 3 covers the `rk claude` / `rk codex` launchers: pty wrapper, `/compact`, `/model`, replies after *Y*.
- Plan 2 consumes the protocol frames defined in Task 9 of this plan.

## Global Constraints

- macOS only in v1. Don't break Windows code paths in Nexus, but don't test them.
- **Never edit the user's `~/.claude/settings.json` or `~/.codex/config.toml` in tests or spikes.** Use `claude --settings <file>`, `--plugin-dir`, and Codex `-c` overrides. Typing `/model` into Claude saves it as the global default, so never do it in tests.
- **Never stop or restart the user's Codex daemon** (`codex app-server … --managed-daemon`).
- Live model runs: Claude `--model claude-haiku-4-5-20251001`, Codex `-m gpt-6-luna -c model_reasoning_effort=low`, tiny prompts. Usage budget is tight.
- Sessions are **opt-in**. An unattached session sends nothing, gets no subscription, has no output forwarded and gets no auto-approval (§12.4).
- Sessions are identified by exact id only: Claude `session_id`, Codex thread id (`CODEX_THREAD_ID` / hook `session_id`). Never match by cwd.
- New state lives in `~/.rokid-coder/`: `attached.json`, `applied-ids.json`, `tls/`. Existing Nexus config stays in `~/.nexus-agentd/config.json`.
- Temporary approve-all exists only in `agentd` memory. It is never sent to Codex as a native `approvalPolicy`, and it resets on session end or `agentd` restart, with a user notice (§12.1).
- Thresholds are config values with these defaults:
  - age boost 30 s
  - dwell 8 s
  - ack timeout 5 s
  - retry backoff 5 s / 10 s / 20 s
  - reminder interval *X* = 5 min
  - wait limit *Y* = 30 min (max 3600 s)
  - Stop continuation cap 8
  - applied-id retention 24 h
- Steering frames are accepted only over a TLS link. A plaintext link is monitor-only. The exhaustive steering list is `classifyFrame` in Task 0b, covering v1 and v2 frames. Unknown frame types count as steering.
- Docs layout: plans in `docs/coding-agent/claude/plan/`, Codex reviews in `docs/coding-agent/codex/reviews/`.

## Review Focus

1. **Two sessions alert at once**, for example a Claude approval while a Codex Done is showing. Expect the approval to preempt Done. Done comes back afterwards, and each answer reaches only its own session. Test: Task 8 `preempts_done_with_approval_and_requeues`.
2. **Phone drops while an approval is pending.** Expect the approval to fall back to the laptop prompt, the alert to become `expired` with reason `phone_disconnected`, and a late answer from the phone to be ignored and not applied. Test: Task 10 `late_decision_after_disconnect_is_ignored`.
3. **The same follow-up is sent twice after a reconnect.** Expect it to run once, with both copies acked. The dedup must also survive an `agentd` restart. Test: Task 8 `applied_ids_survive_restart`.
4. **The user types at the laptop while the Stop hook waits for the glasses.** Expect the wait to be released at once, the pending glasses reply to be cancelled, and the phone to be told. Test: Task 6 `laptop_prompt_releases_stop_wait`.
5. **Approve-all is still on when `agentd` restarts.** Expect it to come back as `ask`, with a reset notice queued per session once the phone links. Test: Task 5 `restart_emits_reset_notice_for_prior_approve_all`.

---

## File Structure

All paths are relative to the Rokid-Coder repo root (the forked Nexus).

| Path | Responsibility |
|---|---|
| `agentd/src/attach-registry.ts` (new) | Persisted set of attached `{provider, id}`, plus `isAttached` gate |
| `agentd/src/approval-policy.ts` (new) | Per-session temporary mode, auto-answer decision, reset notices |
| `agentd/src/stop-wait.ts` (new) | Holds Claude Stop hooks for glasses follow-ups; continuation cap; laptop release |
| `agentd/src/question-relay.ts` (new) | Holds Claude AskUserQuestion `PreToolUse`; builds the `updatedInput` answer |
| `agentd/src/alerts.ts` (new) | Alert queue and lifecycle (pure, fake clock) |
| `agentd/src/applied-ids.ts` (new) | Persisted message-id dedup |
| `agentd/src/tls.ts` (new) | Self-signed cert generation, fingerprint, pin store |
| `agentd/src/protocol-v2.ts` (new) | Types for every new phone frame (the contract for Plan 2) |
| `agentd/src/codex/daemon-socket.ts` (new) | Shared-daemon socket path and `ws+unix` endpoint |
| `agentd/src/codex/rollout-usage.ts` (new) | Reads the last `token_count` from a rollout JSONL |
| `agentd/src/daemon.ts`, `approval-manager.ts`, `codex/monitor.ts`, `phone-link.ts`, `ws-server.ts`, `session-store.ts`, `types.ts`, `config.ts`, `pairing.ts` (modify) | Wiring |
| `plugins/claude-code/` (new) | Claude Code plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `commands/rokid.md`, `bin/hook-forward.js` (copied at build) |
| `plugins/codex/` (new) | Codex plugin: hooks → the same forwarder; attach phrase |
| `.claude-plugin/marketplace.json` (new) | Repo-local marketplace listing both plugins |
| `agentd/test/*.test.js` (new per module) | Unit tests; `agentd/test/fake-phone.js` is the scripted phone |

---

### Task 0: Create the Rokid-Coder repo and baseline

**Files:**
- Create: the repo at `~/Desktop/rokid/Rokid-Coder` (fork contents + existing `docs/coding-agent/`)

**Interfaces:**
- Produces: a git repo whose `agentd` tests pass unchanged.

- [ ] **Step 1: Clone Nexus history into a temp folder next to the docs**

```bash
cd ~/Desktop/rokid
git clone rokid-resources/nexus/Rokid-Nexus Rokid-Coder-src
cp -R Rokid-Coder/docs/coding-agent Rokid-Coder-src/docs/
mv Rokid-Coder Rokid-Coder-docs-backup && mv Rokid-Coder-src Rokid-Coder
cd Rokid-Coder && git remote rename origin nexus-local && git remote add upstream https://github.com/Anezium/Rokid-Nexus.git
```

- [ ] **Step 2: Baseline**

Run: `cd agentd && npm install && npm test`
Expected: all existing tests PASS. Record the count in the commit message.

- [ ] **Step 3: Commit the docs**

```bash
git checkout -b rokid-coder/plan-1
git add docs/coding-agent && git commit -m "docs: Rokid-Coder design, compat evidence, plan 1"
```

- [ ] **Step 4: GitHub fork. Stop and ask the user first; it is outward-facing.**

Only after a yes: `gh repo fork Anezium/Rokid-Nexus --fork-name Rokid-Coder --clone=false`, then add it as `origin` and push the branch. Delete `Rokid-Coder-docs-backup` after the user confirms the move looks right.

---

### Task 0b: Shared types, config migration and test harness

This task exists to fix ordering (plan review #10). Later tasks import from it.

**Files:**
- Create: `agentd/src/protocol-v2.ts` (types only at this stage), `agentd/test/fake-phone.js` (harness), `agentd/test/config-migration.test.js`
- Modify: `agentd/src/config.ts` (parser + defaults), `agentd/src/types.ts`

**Interfaces:**
- Produces:
  - Every v2 frame type listed in Task 9, plus `AlertFrame`, `SessionKey = \`${AgentProvider}:${string}\``, and `sessionKeyOf(provider, id): SessionKey`.
  - `classifyFrame(type: string): "monitor" | "steering"` with an exhaustive table covering v1 and v2 frames:
    - **steering:** `approval_decision`, `session_input`, `thread_start`, `alert_action`, `followup`, `question_answer`, `mode_set`, `mode_revoke_all`, `codex_settings`, `codex_compact`, `defaults_set`.
    - **monitor:** `hello`, `hello_ack`, `hello_reject`, `refresh`, `detail_open`, `detail_close`, `ping`, `pong`, `fs_list`, `alert_shown`, `alert_dismissed`, `settings_sync`, `models_request`.
    - Unknown types count as steering (fail closed).
  - Config parser additions:
    - `codex.useSharedDaemon` (default `true`) and `codex.socketPath` (optional).
    - `rokidCoder: { stateDir: string }`, defaulting to `~/.rokid-coder`.
    - Old config files parse unchanged.
  - `test/fake-phone.js` exports `createFakePhone({ transport: "phonelink" | "wshub", tls: boolean, pin?: string })`, which returns `{ frames: object[]; send(frame): void; waitFor(type, pred?): Promise<object>; close(): void }`. It can also be run as a CLI (Task 9 extends it).
- [ ] **Step 1: Write failing tests**
  - `old_config_parses_with_new_defaults`
  - `classify_frame_is_exhaustive_and_unknown_is_steering`
  - `fake_phone_receives_snapshot_on_both_transports`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `chore(agentd): v2 protocol types, frame classification, config migration, fake phone harness`

---

### Task 1: Attach registry and opt-in gate

**Files:**
- Create: `agentd/src/attach-registry.ts`, `agentd/test/attach-registry.test.js`
- Modify: `agentd/src/daemon.ts` (`processHook`), `agentd/src/session-store.ts`

**Interfaces:**
- Consumes: `createFakePhone`, `sessionKeyOf` (Task 0b).
- Produces:
  - `class AttachRegistry { constructor(opts: { file: string; now?: () => number }); attach(provider: AgentProvider, id: string, mode: SessionMode): void; detach(provider: AgentProvider, id: string): void; isAttached(provider: AgentProvider, id: string): boolean; mode(provider: AgentProvider, id: string): SessionMode | undefined; list(): AttachedEntry[] }`
  - `type SessionMode = "plugin" | "launcher"`
  - `interface AttachedEntry { provider: AgentProvider; id: string; mode: SessionMode; attachedAt: number }`
  - Default file: `~/.rokid-coder/attached.json`, written atomically (write a temp file, then rename).

- [ ] **Step 1: Write failing tests**
  - `attach_persists_across_instances`: attach `("claude","s1","plugin")`; a new `AttachRegistry` on the same file gives `isAttached("claude","s1") === true`.
  - `detach_removes`.
  - `ids_are_exact_not_prefix`: attached `s1` doesn't make `s10` attached.
  - `corrupt_file_starts_empty_and_logs`.
- [ ] **Step 2:** Run `cd agentd && npm test`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `AttachRegistry`.**
- [ ] **Step 4: Gate every path, not just `processHook`** (plan review #1)

For a payload whose session isn't attached, return `{}` after a cheap check. The only exception is the attach command (Task 2). Gate each of these as well:
- `SessionStore.addDiscovered`, so discovered sessions aren't stored unless attached.
- `SessionStore.onUpsert` publication to **both** `PhoneLink` and `WsHub`.
- `detailProvider` / `onDetailOpen` (`daemon.ts` ~L53–66): reject with `not_attached`.
- `CodexMonitor` broadcast adoption (`adoptStartedThread`, ~L1036): never adopt unless attached.
- Approvals and every command handler.

Add `AttachRegistry.onChange(listener)`. **Detach** must:
- stop tailing
- cancel any `StopWait` / `QuestionRelay` hold (they resolve `{}`)
- call `CodexMonitor.unsubscribe`
- expire the session's alerts
- send `session_removed` on both transports

Tests, using `createFakePhone` from Task 0b on both transports:
- `unattached_hook_is_ignored`
- `unattached_discovered_session_not_published`
- `detail_open_for_unattached_rejected`
- `codex_broadcast_thread_not_adopted_unless_attached`
- `detach_stops_tailing_and_removes_session`
- [ ] **Step 5:** Run `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(agentd): opt-in attach registry gates all session traffic`

---

### Task 2: Claude Code plugin and `/rokid` attach

**Files:**
- Create:
  - `plugins/claude-code/.claude-plugin/plugin.json`
  - `plugins/claude-code/hooks/hooks.json`
  - `plugins/claude-code/commands/rokid.md`
  - `.claude-plugin/marketplace.json`
- Modify:
  - `agentd/package.json`: add a script `bundle:plugins` that copies `dist/hook-forward.js` to `plugins/claude-code/bin/hook-forward.js` and `plugins/codex/bin/hook-forward.js`, and run it from `build`.
  - `agentd/src/daemon.ts`
  - `agentd/src/hook-forward.ts`: read the deadline from `ROKID_CODER_HOOK_DEADLINE_MS`, falling back to `approvalTimeoutFromEnv() + 5000`. **The forwarder must be standalone** (plan review #2): drop the `./approval-manager` import, inline the env parsing, and import nothing relative, only `node:*`. Forward `ROKID_CODER_PROVIDER` as header `x-rokid-provider`.
  - Tests in `hook-forward.test.js`:
    - `forwarder_has_no_relative_requires`, which scans `dist/hook-forward.js` for `require("./`.
    - `plugin_bin_runs_standalone_and_sends_provider_header`, which runs the **copied** `plugins/claude-code/bin/hook-forward.js` from a temp dir against a test HTTP server.

**Interfaces:**
- Consumes: `AttachRegistry` (Task 1).
- Produces:
  - Function `parseAttachCommand(prompt: string): { action: "attach" | "detach" | "status" } | undefined`. It recognises `/rokid`, `/rokid off` and `/rokid status`, with leading spaces allowed, and is case-sensitive.
  - The attach reply is a `UserPromptSubmit` response of `{ decision: "block", reason: <text> }`.
  - The attach text, from §11a, must state the limits: `Attached to Rokid-Coder (plugin mode). Works: progress, approvals, questions, context, voice follow-ups while waiting. Not available: compact, model change — use "rk claude" for those.`

- [ ] **Step 1: Verify how `/rokid` reaches hooks (spike gate)**

Load the plugin with `claude --plugin-dir plugins/claude-code --model claude-haiku-4-5-20251001` in a pty. Drive it with `docs/coding-agent/claude/brainstorm/spike-scripts/claude/drv.py` patterns. Type `/rokid`, then check whether `UserPromptSubmit` fires with `prompt` starting `/rokid`.
- If it does, `commands/rokid.md` is just a description, and the hook does the work.
- If not, `commands/rokid.md` runs `!node ${CLAUDE_PLUGIN_ROOT}/bin/attach.js ${CLAUDE_SESSION_ID}`. Verify that substitution exists first. Record which one worked in the commit message.

- [ ] **Step 2: Write failing tests** in `agentd/test/attach-command.test.js`:
  - `parses_attach_detach_status`
  - `non_command_prompt_is_undefined` (`"/rokidx"`, `"please /rokid"`)
  - `attach_hook_blocks_prompt_and_attaches`: a `UserPromptSubmit` with `/rokid` and `session_id "s1"` returns `decision "block"`, the reason contains `Not available: compact, model change`, and the registry has `s1`.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement `parseAttachCommand` and handle it in `processHook`.** This happens before the attach gate. Write `hooks/hooks.json`: every event in `settings.ts` `HOOK_EVENTS` runs `node ${CLAUDE_PLUGIN_ROOT}/bin/hook-forward.js`, with `timeout: 3600` on `Stop` and `PreToolUse` and the default elsewhere. Set `ROKID_CODER_HOOK_DEADLINE_MS=3605000` in the command's env prefix.
- [ ] **Step 5:** Run `npm test`. Expected: PASS. Manual: in a pty session with `--plugin-dir`, `/rokid` shows the attach text, and `curl -s 127.0.0.1:8791/health` reports `sessions: 1`. This needs only Tasks 1–2.
- [ ] **Step 6:** Update `agentd/README.md`: plugin install replaces `install-hooks`. Keep that command, but mark it legacy, because it edits `~/.claude/settings.json`.
- [ ] **Step 7: Commit** `feat: Rokid-Coder Claude Code plugin with /rokid opt-in`

---

### Task 3: Codex shared-daemon connection

**Files:**
- Create: `agentd/src/codex/daemon-socket.ts`, `agentd/src/codex/rollout-usage.ts`, `agentd/test/codex-daemon-socket.test.js`, `agentd/test/rollout-usage.test.js`
- Modify: `agentd/src/codex/monitor.ts`, `agentd/src/types.ts` (`CodexConfig`)

**Interfaces:**
- Produces:
  - `defaultDaemonSocketPath(home = os.homedir()): string`, which returns `<home>/.codex/app-server-control/app-server-control.sock`.
  - `daemonEndpoint(socketPath: string): string`, which returns `ws+unix://${socketPath}:/`.
  - `readLastTokenUsage(rolloutPath: string): Promise<{ used: number; window: number } | undefined>`. It reads the last `event_msg` whose `payload.type === "token_count"` and takes `info.last_token_usage.total_tokens` and `info.model_context_window`.
  - `CodexConfig` becomes `{ enabled: boolean; port: number; socketPath?: string; useSharedDaemon: boolean }`, defaulting to `useSharedDaemon: true`.
  - `CodexMonitor.subscribe(threadId: string): Promise<void>` (does `thread/resume`, then seeds context) and `CodexMonitor.unsubscribe(threadId: string): void`. Tasks 4 and 10 call them.

- [ ] **Step 1: Write failing tests**
  - `endpoint_is_ws_unix`.
  - `rollout_usage_reads_last_token_count`: a fixture JSONL with two `token_count` lines returns the second `{used, window}`.
  - `rollout_usage_missing_file_is_undefined`.
  - In `codex-monitor.test.js`, add `shared_daemon_never_spawns`: with `useSharedDaemon` true and a fake `ws` server listening on a temp unix socket, `launch` is never called.
  - Also `subscribes_only_attached_threads`: when the fake server answers `thread/loaded/list` with `[a, b]` and only `b` is attached, `thread/resume` is sent only for `b`, with `excludeTurns: true`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - With `useSharedDaemon`, `CodexMonitor.endpoint()` returns `daemonEndpoint(...)` and the spawn/terminate path is skipped.
  - Handshake: `initialize {clientInfo:{name:"rokid-coder-agentd",title:"Rokid-Coder",version}, capabilities:{experimentalApi:true}}`, then `initialized`.
  - Live threads come from `thread/loaded/list`; subscribe with `thread/resume {threadId, excludeTurns:true}` and retry later on "no rollout found".
  - Seed context from `readLastTokenUsage(thread.path)` after resume.
  - Drop the global `WebSocket` for the `ws` package (it supports `ws+unix`). Reference client: `docs/coding-agent/claude/brainstorm/spike-scripts/codex/wsclient.py`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS. **Manual check deferred to Task 4 Step 5,** because it needs the attach command: plain `codex` gets attached, and the log shows `codex_thread_subscribed`.
- [ ] **Step 5: Commit** `feat(agentd): attach to the shared Codex app-server daemon`

---

### Task 4: Codex plugin and attach

**Files:**
- Create: `plugins/codex/` (manifest per the Codex plugin docs, hooks config, `bin/hook-forward.js` via `bundle:plugins`), `agentd/test/codex-attach.test.js`
- Modify: `agentd/src/daemon.ts`

**Interfaces:**
- Consumes: `parseAttachCommand` (Task 2), `AttachRegistry`.
- Produces: Codex `UserPromptSubmit` hook payloads go to `/hook` with `session_id` = thread id, and attach works exactly as in Claude. Payloads are told apart by a `provider` hint the forwarder adds: `ROKID_CODER_PROVIDER=codex` in the hook command env, sent as `x-rokid-provider` header.

- [ ] **Step 1: Spike gate**
  1. Read the Codex plugin and hooks docs (`https://developers.openai.com/codex`), plus `codex app-server generate-json-schema` output for hook input shapes.
  2. Build the smallest plugin whose `UserPromptSubmit` hook runs the forwarder, and install it from the local marketplace (`codex plugin marketplace add <repo path>`).
  3. In plain `codex`, typing `/rokid` either reaches the hook, or the TUI rejects it as an unknown command. If it's rejected, the attach phrase for Codex is `rokid attach`. The hook blocks it either way.
  4. Record whether hook trust prompts appear, and how the user approves them once.
- [ ] **Step 2: Write failing tests**
  - `codex_attach_uses_thread_id`: a payload with header `x-rokid-provider: codex` and `session_id "t1"` gives `registry.isAttached("codex","t1")`.
  - `codex_attach_text_says_full_support`: the reason says all controls are available in plugin mode for Codex.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement.** In `http-server.ts`, read the header into `payload.__provider`, and branch on it in `processHook`. When a Codex thread gets attached, `CodexMonitor.subscribe(threadId)` is called immediately.
- [ ] **Step 5:** Run `npm test`. Expected: PASS. Manual: in plain `codex`, the attach phrase shows the attach text, and the thread appears in `GET /health` sessions.
- [ ] **Step 6: Commit** `feat: Rokid-Coder Codex plugin with opt-in attach`

---

### Task 5: Temporary approval modes

**Files:**
- Create: `agentd/src/approval-policy.ts`, `agentd/test/approval-policy.test.js`
- Modify: `agentd/src/approval-manager.ts` (`requestDecision`, `request`), `agentd/src/daemon.ts`

**Interfaces:**
- Produces:
  - `type TempMode = "ask" | "acceptEdits" | "approveAll"`
  - `class ApprovalPolicy { constructor(opts: { now?: () => number }); set(sessionKey: string, mode: TempMode, confirmed: boolean): { ok: true } | { ok: false; error: "confirm_required" }; get(sessionKey: string): TempMode; decide(sessionKey: string, request: ApprovalRequest): "allow" | undefined; endSession(sessionKey: string): ResetNotice | undefined; takeRestartNotices(): ResetNotice[]; revokeAll(): ResetNotice[] }`
  - `interface ResetNotice { sessionKey: string; from: TempMode; reason: "session_ended" | "helper_restarted" | "revoked" }`
  - `sessionKey` = `${provider}:${id}` (`sessionKeyOf`, Task 0b).
  - **`ApprovalRequest` gains `provider: AgentProvider`, `sessionKey: SessionKey` and `approvalKind: "command" | "fileChange" | "tool"`** (plan review #5).
    - The Claude adapter sets `approvalKind` to `"fileChange"` for `Edit`, `Write`, `MultiEdit` and `NotebookEdit`, and `"tool"` otherwise.
    - The Codex adapter sets it from the server-request method (`item/commandExecution/requestApproval` → `"command"`, file-change approval → `"fileChange"`), not from the display label `"File change"` (`monitor.ts` ~L208).
  - `decide` uses only `approvalKind` and the mode.
  - `acceptEdits` auto-allows `approvalKind === "fileChange"`.
  - Defaults from `defaults_set` (Task 9) apply at attach. A default can only be `ask` or `acceptEdits`, because approve-all always needs a live confirm.
  - Test: `codex_normalized_file_change_request_counts_as_file_change`, which feeds the real `describeCodexApproval` output through the adapter.
  - `approveAll` needs `confirmed: true`.
  - Persistence for restart notices only: `~/.rokid-coder/approve-all.json` records which sessions had approve-all, so the next start can emit `helper_restarted`. The mode itself always starts as `ask`.

- [ ] **Step 1: Write failing tests**
  - `default_is_ask_and_decide_returns_undefined`
  - `approve_all_requires_confirm`
  - `accept_edits_allows_edit_not_bash`
  - `session_end_returns_reset_notice`
  - `restart_emits_reset_notice_for_prior_approve_all`
  - `revoke_all_resets_every_session`
  - In `approval-manager.test.js`: `policy_allow_skips_phone`. With `approveAll` set, `requestDecision` resolves `"allow"`, and the `FakeTransport` received no `approval_request` frame.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - `ApprovalManager` takes an optional `policy: ApprovalPolicy`. It calls `policy.decide` before sending to the phone.
  - Codex approvals go through the same `requestDecision`, so Codex's native `approvalPolicy` is never touched.
  - `SessionEnd`, and Codex `thread/closed` or archived, call `endSession`.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): temporary per-session approval modes with reset notices`

---

### Task 6: Claude follow-ups through the Stop hook

**Files:**
- Create: `agentd/src/stop-wait.ts`, `agentd/test/stop-wait.test.js`
- Modify: `agentd/src/daemon.ts`, `agentd/src/http-server.ts` (expose request-closed signal to `onHook`)

**Interfaces:**
- Produces:
  - `class StopWait { constructor(opts: { waitLimitMs: number; continuationCap: number; now?: () => number; setTimer?: typeof setTimeout }); hold(sessionId: string, closed: AbortSignal): Promise<HookResponse>; deliver(sessionId: string, text: string, msgId: string): "delivered" | "not_waiting" | "cap_reached"; releaseByLaptop(sessionId: string): void; noteToolUse(sessionId: string): void; state(sessionId: string): { waiting: boolean; continuationsLeft: number } }`
  - `hold` resolves `{ decision: "block", reason: "Follow-up from Rokid glasses:\n" + text }` on delivery.
  - It resolves `{}` on timeout (`waitLimitMs`), on `releaseByLaptop`, on `closed` abort (Esc / Ctrl+C kills the hook process and the HTTP request closes), or when the cap is reached.
  - `continuationCap` default 8. It resets on `noteToolUse` (any `PreToolUse`).
  - Each release fires `onRelease(sessionId, reason: "timeout" | "laptop" | "cancelled" | "delivered")` so the phone gets `followup_closed`.

- [ ] **Step 1: Write failing tests** (fake timers)
  - `delivers_followup_as_block_reason`
  - `times_out_to_empty_response`
  - `laptop_prompt_releases_stop_wait`: a `UserPromptSubmit` for the same session, from the laptop and not an attach command, calls `releaseByLaptop`. `hold` then resolves `{}`, and the release reason is `laptop`.
  - `abort_signal_releases_as_cancelled`
  - `cap_reached_after_8_then_reset_by_tool_use`
  - `deliver_when_not_waiting_returns_not_waiting`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement**
  - In `processHook`, for attached Claude sessions: `Stop` returns `stopWait.hold(...)`. `PreToolUse` calls `noteToolUse`. Non-attach `UserPromptSubmit` calls `releaseByLaptop`.
  - Change `HookHttpServer` so `onHook` receives `(payload, closed: AbortSignal)`. **Don't use `request.on("close")`** (plan review #3): it also fires after a normal request finishes. Abort on `response.on("close")` when `!response.writableEnded`, which means the client socket went away before the reply. Handle requests that never finish separately, with `request.on("aborted")` / an error before `end`.
  - Add integration tests in `http-server.test.js`:
    - `intact_held_post_is_not_aborted`: the hold resolves after 2 s and the client gets the body.
    - `killed_forwarder_aborts_hold`: a client socket destroyed mid-hold gives abort reason `cancelled`.
  - `waitLimitMs` comes from config *Y*.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Manual check, deferred to Task 12 Step 3,** because it needs the Task 9 fake-phone CLI. Use a pty session with the plugin, attached and on Haiku. Ask "Reply APPLE". Send a follow-up through `test/fake-phone.js followup <sid> "Reply BANANA"` (Task 9) and check that BANANA appears. Then type at the laptop during a second wait, and check that the fake phone logs `followup_closed reason=laptop`.
- [ ] **Step 6: Commit** `feat(agentd): glasses follow-ups via held Stop hook with cap and laptop release`

---

### Task 7: Claude questions and Codex controls

**Files:**
- Create: `agentd/src/question-relay.ts`, `agentd/test/question-relay.test.js`
- Modify: `agentd/src/daemon.ts`, `agentd/src/codex/monitor.ts`, `agentd/test/codex-monitor.test.js`

**Interfaces:**
- Produces:
  - `class QuestionRelay { hold(payload: HookPayload, closed: AbortSignal): Promise<HookResponse>; answer(toolUseId: string, answers: Record<string, string>, msgId: string): boolean }`. It applies when `tool_name === "AskUserQuestion"` on `PreToolUse`.
  - The answer response is `{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...tool_input, answers } } }`. Keys are the question text; values are the label or free text.
  - Laptop answer or abort resolves `{}`, leaving the question to the TUI.
  - `CodexMonitor` additions:
    - `followUp(threadId, text, msgId, pending?: { model?: string; effort?: string }): Promise<"started" | "queued">`. It uses `turn/start` when the thread is idle, otherwise `codex queue` (spawned `codex queue --thread <id> --message <text>`), keeping `pending` for the next `turn/start`.
    - `compact(threadId): Promise<void>` → `thread/compact/start`.
    - `contextFill(threadId): { used: number; window: number } | undefined`, from the cached last `thread/tokenUsage/updated` or the rollout seed.
    - `listModels(): Promise<string[]>` → `model/list`.
  - Settings show as `applied` only on `thread/settings/updated`.
  - **Question contract** (plan review #6), with these types in `protocol-v2.ts`:
    - `QuestionPayload { requestRef: string; source: "claude_tool" | "codex_async" | "codex_rpc"; items: { text: string; options: { label: string; description?: string }[]; multiSelect: boolean; allowFreeText: boolean }[] }`
    - A `question` alert carries `question: QuestionPayload`.
    - The phone answers with `question_answer {sessionKey, alertId, requestRef, answers: Record<itemText, string | string[]>, msgId}`.
  - Routing by `source`:
    - `claude_tool`: `requestRef` = `tool_use_id`, then `QuestionRelay.answer`.
    - `codex_async`: `requestRef` = item id, then `followUp` with the answers formatted as `Q: … / A: …` lines.
    - `codex_rpc`: `requestRef` = the server request id. Reply to the pending `item/tool/requestUserInput` request with the schema's response shape, taken from `generate-json-schema` (`ToolRequestUserInputResponse`).
  - The Claude adapter maps array answers (multiSelect) to labels joined with `", "` in `updatedInput.answers`.
  - Tests: `claude_question_round_trip`, `codex_async_question_answer_becomes_followup`, `codex_rpc_question_answer_replies_to_request_id`, `multiselect_answer_joined_for_claude`. Task 9 re-runs all three as serialized frames through `createFakePhone` on both transports (`question_round_trip_serialized_<source>_<transport>`).
  - Codex questions come through as an `agentMessage` with `questions[]` (async) and are answered as a normal `followUp`. Also handle `item/tool/requestUserInput` if it arrives.

- [ ] **Step 1: Write failing tests**
  - `answer_builds_updated_input_with_answers`: given `tool_input {questions:[{question:"Pick",options:[...]}]}`, `answer(id,{Pick:"B"})`, the response matches the shape above exactly.
  - `abort_resolves_empty`.
  - In `codex-monitor.test.js`, against the fake socket server:
    - `followup_idle_uses_turn_start_with_pending_model`
    - `followup_busy_queues_and_keeps_pending`
    - `settings_applied_only_on_settings_updated`
    - `compact_calls_thread_compact_start`
    - `context_fill_from_token_usage_event`
    - `async_questions_message_maps_to_question_alert`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Reference shapes: `docs/coding-agent/claude/brainstorm/2026-11-14-compat-claude.md` §3 and `2026-11-14-compat-codex.md` §2, §4–7.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): Claude question relay and Codex follow-up/compact/context/model`

---

### Task 8: Alert engine and message-id dedup

**Consumes:** `AlertFrame`, `SessionKey` (Task 0b).

**Files:**
- Create: `agentd/src/alerts.ts`, `agentd/src/applied-ids.ts`, `agentd/test/alerts.test.js`, `agentd/test/applied-ids.test.js`

**Interfaces:**
- Produces:
  - `type AlertKind = "approval" | "question" | "error" | "done" | "notice"`. `notice` covers reset notices and approvals that expired on disconnect. Its priority sits between error and done.
  - `type AlertState = "queued" | "sent" | "shown" | "acted" | "dismissed" | "expired"`.
  - `interface Alert { id: string; sessionKey: string; kind: AlertKind; title: string; body: string; actions?: string[]; createdAt: number; state: AlertState; attempts: number; promoted: boolean }`.
  - `interface AlertTimings { ageBoostMs: number; dwellMs: number; ackTimeoutMs: number; retryBackoffMs: number[]; reminderMs: number; expireMs: number }`. Defaults per Global Constraints.
  - `class AlertQueue { constructor(timings: AlertTimings, sink: (frame: AlertFrame) => boolean, now?: () => number); push(a: Omit<Alert,"id"|"state"|"attempts"|"promoted">): string; onShown(id: string): void; onActed(id: string): void; onDismissed(id: string): void; tick(): void; waitingCount(): number; current(): Alert | undefined; expireSession(sessionKey: string, reason: string): void }`.
  - Priority: approval > question > error > notice > done, then oldest first. After `ageBoostMs` an alert is promoted to approval level.
  - A shown alert stays for `dwellMs` unless acted on; only an approval preempts it inside the dwell. A preempted alert goes back to the queue head.
  - Not shown within `ackTimeoutMs`: resend per `retryBackoffMs`. While `shown` and not acted: re-send every `reminderMs` until `expireMs` (*Y*), then `expired`.
  - Every frame carries `waiting: waitingCount()`.
  - `class AppliedIds { constructor(file: string, retentionMs: number, now?: () => number); seen(msgId: string): boolean; record(msgId: string): void }` writes `~/.rokid-coder/applied-ids.json` atomically and prunes entries older than retention.

- [ ] **Step 1: Write failing tests** (fake clock, fake sink)
  - `orders_by_priority_then_age`
  - `age_boost_promotes_after_30s`
  - `dwell_holds_shown_alert_8s`
  - `preempts_done_with_approval_and_requeues`
  - `retries_until_shown_with_backoff`
  - `reminds_every_X_until_Y_then_expires`
  - `waiting_count_in_every_frame`
  - `expire_session_drops_its_alerts_only`
  - `applied_ids_survive_restart`: record `m1`, then a new instance gives `seen("m1") === true`.
  - `applied_ids_prune_after_retention`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement both modules.** They are pure logic; the only I/O is `AppliedIds` file writes.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): alert queue lifecycle and persisted message-id dedup`

---

### Task 9: Phone protocol v2 and fake phone

**Files:**
- Create: `agentd/test/protocol-v2.test.js`
- Modify (both created in Task 0b): `agentd/src/protocol-v2.ts`, `agentd/test/fake-phone.js`
- Modify: `agentd/src/phone-link.ts` (`handleMessage` switch), `agentd/src/ws-server.ts`, `agentd/src/types.ts` (`Session`), `agentd/src/daemon.ts` (wire everything)

**Interfaces:**
- Produces (the contract Plan 2 builds against; every frame has `v: 2`).
  - **Agent → phone**
    - `session_upsert` gains: `mode: SessionMode`, `capabilities: { compact: boolean; model: boolean; followup: "waiting" | "unavailable" | "cap_reached" | "ready" }`, `tempMode: TempMode`, `nativeMode?: string`, `heading: string`, `currentFile?: string`, `step?: string`, `context?: { used: number; window: number }`, `pendingSettings?: { model?: string; effort?: string }`.
    - `alert {id, sessionKey, kind, title, body, actions?, question?: QuestionPayload, waiting}`. `question` is required when `kind === "question"`. `QuestionPayload` is defined in Task 7.
    - `ack {msgId, result: "applied" | "duplicate" | "rejected", error?}`.
    - `followup_closed {sessionKey, reason}`.
    - `mode_reset {sessionKey, from, reason}`.
  - **Phone → agent**
    - `alert_shown {id}`, `alert_action {id, action, msgId}`, `alert_dismissed {id}`.
    - Steering frames:
      - `followup {sessionKey, text, msgId}`
      - `question_answer {sessionKey, alertId, requestRef, answers: Record<string, string | string[]>, msgId}`. This is the single contract, and it is the same as Task 7's.
      - `mode_set {sessionKey, mode, confirmed, msgId}`
      - `mode_revoke_all {msgId}`
      - `codex_settings {sessionKey, model?, effort?, msgId}`
      - `codex_compact {sessionKey, msgId}`
  - Every steering frame goes through `AppliedIds`: a duplicate gives `ack duplicate` and doesn't run again.
  - `capabilities` comes from mode and provider: Claude plugin `{compact:false, model:false}`; Claude launcher `{true,true}` (Plan 3); Codex `{true,true}`.
  - `heading`:
    - Claude: transcript `ai-title`, or else the first user prompt cut to 48 characters.
    - Codex: thread `name`, or else the first prompt.
  - `currentFile` / `step`:
    - Claude: `tool_input.file_path` / `tool_input.description`.
    - Codex: `fileChange` path / `commandExecution.command`.
  - `test/fake-phone.js` is a CLI that pairs, prints every frame, and sends any frame from argv, for example `followup <sessionKey> <text>`. It works over both the plaintext and TLS links.
  - **Alert sources:**
    - `approval`: `ApprovalManager`, when the policy doesn't auto-allow.
    - `question`: `QuestionRelay`, and Codex `questions[]`.
    - `done`: Claude `Stop` for an attached session, once `StopWait` holds it. Codex `turn/completed` with status `completed`.
    - `error`: a transcript `error`, or Codex `turn/completed` with status `failed`.
    - `notice`: `mode_reset`, and approvals that expired on disconnect.
  - **Claude context:** from the transcript's last assistant `usage`, as `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. The window is 200 000, or 1 000 000 when the model id ends `[1m]`. Extend `transcript.ts` `TranscriptUpdate` with `context?: {used, window}`.
  - **`nativeMode`:**
    - Claude: hook input `permission_mode`.
    - Codex: thread `approvalPolicy`, read-only.
  - **Phone → agent `settings_sync {v:2, timings: AlertTimings, waitLimitMs, msgId}`:** the phone app owns the thresholds (§12.2). `agentd` applies them to `AlertQueue` and `StopWait`, caps `waitLimitMs` at 3 600 000, and persists them in `~/.rokid-coder/settings.json`. It is not a steering frame, so it's allowed on plaintext.
  - **Update cadence:** `agentd` sends upserts live. The once-a-minute digest is throttled on the phone (Plan 2).
  - **Control frames** (plan review #9):
    - Phone → agent `models_request {sessionKey}` (monitor class).
    - Agent → phone `models {sessionKey, models: string[], efforts: string[], current: {model, effort}}`. Codex answers from `model/list`. For Claude in plugin mode the list is empty, and `capabilities.model` is false.
    - `session_upsert` also carries `sandbox?: string`, which is read-only in v1.
    - **Default approval modes are a separate steering frame** (plan rereview): `defaults_set {defaultModes: { claude: "ask" | "acceptEdits"; codex: "ask" | "acceptEdits" }, msgId}`. It needs TLS and is persisted in `~/.rokid-coder/settings.json`. `settings_sync` carries only timings and the wait limit, and must reject any `defaultModes` key.
  - **One authorization gate** (plan review #4): both `PhoneLink.handleMessage` and `WsHub` call `authorize(frame, link)` before any handler. It uses `classifyFrame` from Task 0b: steering needs TLS, and unknown types are steering. There is no per-handler checking.
  - Tests:
    - `models_request_returns_codex_models`
    - `default_mode_applied_at_attach`
    - `plaintext_defaults_set_rejected_and_not_persisted_on_both_transports`
    - `settings_sync_with_default_modes_key_is_rejected`
    - `every_steering_frame_rejected_over_plaintext_on_both_transports`, which loops over the full steering list, including v1 `approval_decision`, `session_input`, `thread_start` and v2 `alert_action`.

- [ ] **Step 1: Write failing tests** in `protocol-v2.test.js`, with `fake-phone` as a library:
  - `upsert_carries_mode_and_capabilities_for_claude_plugin`
  - `duplicate_followup_acked_once_applied_once`
  - `mode_set_approve_all_without_confirm_is_rejected`
  - `unattached_session_never_upserted`
  - `alert_frames_include_waiting_count`
  - `codex_turn_completed_pushes_done_alert`
  - `claude_context_from_transcript_usage`: a fixture with usage `10 + 36348 + 443` gives `used 36801`, `window 200000`.
  - `settings_sync_updates_wait_limit_and_caps_at_3600s`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement the types, handlers and wiring.** Keep v1 frames working, because the existing Agents plugin still renders.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): phone protocol v2 and fake phone harness`

---

### Task 10: Reconnect behaviour

**Files:**
- Modify: `agentd/src/approval-manager.ts` (`onLinkDisconnected`), `agentd/src/codex/monitor.ts` (reconnect), `agentd/src/daemon.ts`
- Test: `agentd/test/reconnect.test.js`

**Interfaces:**
- Consumes: `AlertQueue.expireSession`, `ApprovalPolicy.takeRestartNotices`, `CodexMonitor.subscribe`.
- Produces:
  - On phone disconnect, each pending approval resolves locally (existing behaviour), and its alert becomes `expired` with body `Answer on laptop`.
  - On reconnect, send a snapshot, then the current alerts and `mode_reset` notices.
  - When the Codex daemon socket reconnects, re-run `thread/resume` for every attached thread and re-seed context.
  - **One lifetime per request** (plan review #7):
    - `ApprovalManager`'s timeout comes from `settings_sync.waitLimitMs` (*Y*), replacing the fixed `DEFAULT_APPROVAL_TIMEOUT_MS = 120_000`.
    - The plugin's `PermissionRequest` hook timeout becomes 3600 too.
    - Any terminal outcome expires the linked alert with the matching reason, and any later `alert_action` gets `ack rejected error=expired`. Terminal outcomes are: timeout, answered on the laptop (`local`), `upstream_resolved`, and a disconnect of **either** transport.
    - `WsHub` exposes `onConnected` / `onDisconnected` and the daemon wires them to `approvals.onLinkConnected` / `onLinkDisconnected`. Today only `PhoneLink` does this (`ws-server.ts` ~L159).
  - **History recovery** (plan review #8):
    - Codex resume replays nothing. On attach and on every resubscribe, fetch recent history with `thread/turns/list`, paging until 40 messages (the `DETAIL_MESSAGE_LIMIT`) or the start, and rebuild `lastAssistantText` / detail.
    - Claude tailing starts at EOF (`transcript.ts` ~L212). On attach and on phone reconnect, rebuild from `readRecentMessages(transcriptPath, 40)` (`transcript-messages.ts`) before tailing.

- [ ] **Step 1: Write failing tests**
  - `late_decision_after_disconnect_is_ignored`: an approval is pending, the link drops, then `alert_action allow` arrives after the reconnect. Expect `ack rejected error=expired`, and no `allow` sent to the hook.
  - `reconnect_replays_snapshot_and_alerts`.
  - `codex_socket_reconnect_resubscribes_attached`.
  - `approval_timeout_follows_wait_limit`.
  - `wshub_disconnect_expires_pending_approval`.
  - `laptop_answer_expires_alert_and_rejects_late_phone_answer`.
  - `codex_resubscribe_rebuilds_missed_output_from_turns_list`: the fake server has 2 turns that happened during the gap, and both appear in the detail.
  - `claude_attach_mid_session_rebuilds_recent_messages`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): reconnect expiry, replay and Codex resubscribe`

---

### Task 11: Pinned TLS, with plaintext monitor-only

**Files:**
- Create: `agentd/src/tls.ts`, `agentd/test/tls.test.js`
- Modify:
  - `agentd/src/phone-link.ts`: `connect` becomes `tls.connect` when the phone advertises TLS.
  - `agentd/src/ws-server.ts`: serve `wss` with the `agentd` cert.
  - `agentd/src/pairing.ts`: add `fp` to the payload.
  - `agentd/src/config.ts`.
  - `agentd/package.json`: add `selfsigned`.

**Interfaces:**
- Produces:
  - `ensureAgentCert(dir = "~/.rokid-coder/tls"): { key: string; cert: string; fingerprint256: string }`. Generates once with `selfsigned`, CN `rokid-coder-agentd`, 10-year validity.
  - `class PinStore { constructor(file: string); pinFor(phoneId: string): string | undefined; pin(phoneId: string, fp: string): void }`.
  - `isSteeringAllowed(link: { tls: boolean }): boolean`.
- **Pinning, in both directions:**
  - The phone pins `agentd` by the `fp` in the pairing line/QR. This is the WsHub path.
  - `agentd` dials the phone (PhoneLink: the phone is the TLS server), so `agentd` pins the phone's cert on the first hello the user accepts on the glasses. This is trust-on-first-use, and a later mismatch is refused and logged.
  - **This adds to design §12.1**, because Nexus's link runs phone-as-server. Flag it in the commit message and in the plan review.
- Steering frames on a non-TLS link get `ack rejected error=monitor_only`.

- [ ] **Step 1: Write failing tests**
  - `cert_generated_once_and_stable_fingerprint`
  - `pairing_payload_includes_fp`
  - `plaintext_link_rejects_steering_frames`
  - `tls_link_with_wrong_pin_is_refused`: use a local `tls.createServer` with a different cert.
  - `tls_link_accepts_steering`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `checkServerIdentity` to compare `cert.fingerprint256` against the pin.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): pinned TLS phone link; plaintext is monitor-only`

---

### Task 12: End-to-end laptop smoke test, live but tiny

**Files:**
- Create: `docs/coding-agent/claude/plan/2026-11-14-plan-1-smoke.md` (results log)

- [ ] **Step 1:** `cd agentd && npm test`. Expected: every test passes.
- [ ] **Step 2:** Run `node dist/cli.js run`, then `node test/fake-phone.js --tls`, and pair.
- [ ] **Step 3: Claude, on Haiku.** In a pty session with `--plugin-dir plugins/claude-code`:
  1. `/rokid`: the fake phone gets `session_upsert mode=plugin capabilities.compact=false`.
  2. Ask it to `echo hi > x.txt`: an `alert kind=approval` arrives. Send `alert_action allow`: the file is created.
  3. Follow-up `Reply BANANA`: BANANA appears.
  4. Prompt it to ask a question: an `alert kind=question` arrives. Answer it: the answer reaches Claude.
- [ ] **Step 4: Codex, on luna.** In plain `codex`:
  1. Type the attach phrase: an upsert arrives.
  2. Send `followup`: the reply appears in the TUI.
  3. Send `codex_compact`: the item `contextCompaction` is seen.
  4. Send `codex_settings model=gpt-6-luna`: it shows pending, then applied after the next turn.
- [ ] **Step 5:** Set approve-all with confirm, restart `agentd`, then reconnect: the fake phone gets `mode_reset reason=helper_restarted`.
- [ ] **Step 6:** Write the results log, then commit with `docs: plan 1 smoke results`.
- [ ] **Step 7: Codex review of the branch diff,** following the PCA practice: `codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only "Review the diff of branch rokid-coder/plan-1 against main …" -o docs/coding-agent/codex/reviews/2026-11-14-plan-1-diff-review.md`.
