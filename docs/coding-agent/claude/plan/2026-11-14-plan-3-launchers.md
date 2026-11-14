# Rokid-Coder Plan 3: `rk claude` / `rk codex` Launchers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rk claude` and `rk codex`, which start the real CLI already attached to Rokid-Coder in launcher mode.
- For Claude, the launcher can also type `/compact`, `/model <name>`, and replies after the wait limit *Y* into the terminal.
  - It types one command at a time, only when Claude itself reports idle and the laptop prompt is empty.
  - The glasses then offer everything that design §11a lists for launcher mode.

**Architecture:**
- **`rk`** is a new bin in `agentd` (Node/TS).
- **`rk claude`:**
  - Runs the real `claude` in a pty and passes the user's terminal through.
  - Learns its session id from the file Claude itself writes, `~/.claude/sessions/<claude pid>.json` (`{pid, sessionId, status}`). This proves ownership by construction, with no forgeable header.
  - Reports that id to agentd over a private unix socket. agentd re-reads the same file to verify it.
  - Types commands only after a fresh positive readiness check:
    - `status: "idle"` in that file
    - agentd's hook state is idle
    - no laptop draft
    - output is quiet
- **`rk codex`:** creates the thread first through the shared daemon (`thread/start`), then runs `codex resume <threadId>`. The exact id is known by construction. If the Task 0 spike shows that path is unusable, it falls back to the Codex plugin's hook.

**Tech Stack:** Node ≥ 20, TypeScript (CommonJS), `node:test`, plus `node-pty` or a Python stdlib `pty` helper (Task 0). Unix domain socket, newline JSON.

**Spec:** `docs/coding-agent/claude/design/2026-11-14-rokid-coder-design.md`: §5.1, §11a, §12.4 (exact ids only), and §12.5 (one command at a time; never type while busy or while a hook waits).

**Evidence:** `docs/coding-agent/claude/brainstorm/2026-11-14-compat-claude.md`:
- Test 4c: typing `/compact` and `/model` into a pty works; `/model` saves the user's default; typed slash commands only queue while a Stop hook waits.
- The section on `claude agents --json`: it's backed by `~/.claude/sessions/<pid>.json` with `status: "busy" | "idle"`. This was checked read-only on 2026-11-14: the file holds `pid`, `sessionId`, `status`, `kind`.

**Review:** Codex review `docs/coding-agent/codex/reviews/2026-11-14-plan-3-review.md` (not ready). This version answers all 10 findings (ledger rulings R48–R53).

## Global Constraints

**Branch and commits**
- Branch `rokid-coder/plan-3`, created from the final head of `rokid-coder/plan-2` (R26). Local commits only; never push.
- Tests: `cd agentd && npm test`. Every Plan 1 and Plan 2 agentd test keeps passing.
- No AI attribution and no `Co-Authored-By` trailer.

**Threat model (R48)**
- Processes of the same OS user are trusted. They can type into the user's terminal anyway.
- The boundaries are other local users and the network:
  - The launcher socket is reachable only by the owning user.
  - Binding needs a session file that Claude wrote for a pid that is a descendant of the launcher's own pty child.
  - Nothing in an HTTP hook body or header can bind or steer a launcher session. Any `launcherId` field arriving on the hook HTTP path is stripped.

**Safety**
- Never type `/model` into a real `claude`, in any test or smoke run. It rewrites the user's default model.
  - Model-change tests run only against the fake CLI `agentd/test/fixtures/fake-claude.js`.
  - Live smoke may type `/compact` and plain replies on Haiku, with tiny prompts only.
- Never write to `~/.claude` or `~/.codex`.
  - Reading `~/.claude/sessions/*.json` is allowed.
  - Tests point at a temp dir through `ROKID_CLAUDE_SESSIONS_DIR`.
- No `codex plugin` install (R25).

**Socket (R52)**
- Path: `<configDir>/launcher.sock`, where `configDir` defaults to `~/.rokid-coder` and honours the test override.
- Startup checks, which fail closed:
  - `configDir` must be a real directory (not a symlink), owned by the current uid, mode 0700. Create it if it's absent. Otherwise log `launcher socket disabled: <reason>` and run without launchers.
  - Socket path, checked with lstat:
    - absent → create it
    - a socket owned by us → probe-connect: refused means stale, so unlink and create; it answers means another agentd, so disable launchers
    - anything else → disable launchers
  - chmod the socket to 0600 after listen.
- Frames:
  - Newline JSON, at most 64 KiB per line. An overlong line, bad JSON or an unknown type closes the connection.
  - `launcher_hello` within 5 s, exactly once per connection. A duplicate `launcherId` (still connected) is refused.

**Launcher → agentd frames**
- `{type:"launcher_hello", v:1, launcherId, provider:"claude"|"codex", childPid}`
- `{type:"launcher_bind", sessionId}`
- `{type:"command_result", cmdId, ok, error?}`. `error` is one of `busy | timeout | dialog_not_seen | exited | not_ready | laptop_draft | cancelled | taken_over | uncertain`.
- `{type:"command_written", cmdId, at}`: sent right after a command's first write. `at` is epoch ms.
- `{type:"laptop_state", draft: boolean}`. Sent on change, at most every 250 ms.

**agentd → launcher frames**
- `{type:"type_command", cmdId, gen, notBefore?, command:"compact"|"model"|"text", model?, text?}`
- `{type:"bind_accepted", gen}`, `{type:"bind_rejected", reason}`, `{type:"compact_done", cmdId}`, `{type:"binding_state", gen, uncertain: boolean}`. The last is sent on every change, so the launcher's copy of `gen` and of `uncertain` is never stale.
- `{type:"cancel_command", cmdId}`
- A `command_result` is accepted only on the connection that received that `cmdId`, and only once.

**Timing**

| Window | Value |
|---|---|
| Output quiet before a write | 500 ms |
| Readiness wait before `busy` | 60 s |
| Compact completion | 180 s |
| `/model` dialog (`Switch model?`) | 5 s |
| `/model` result (`Set model to`) | 10 s |
| Text paste | bracketed paste `\x1b[200~…\x1b[201~` then `\r`, ≤ 16 KiB |

- Claude models offered: `opus`, `sonnet`, `haiku`.

**Copy (exact)**
- `rk claude` banner: `Rokid-Coder launcher: attached. From the glasses you can reply at any time, compact, and change model (changing model also sets your default for new sessions).`
- `rk codex` banner: `Rokid-Coder launcher: attached. All controls work from the glasses.`
- `Rokid-Coder: agentd isn't running — this session is not attached.`

## Review Focus

1. **A half-typed laptop draft, then a pause** (Codex #4). The launcher must never append to it. A command waits until the draft is submitted or cleared. Then it either runs or, after 60 s, fails `laptop_draft`. Test in Task 3.
2. **A follow-up was just delivered through the Stop hook** (Codex #1). agentd marks the session busy synchronously, before the hook returns. No `type_command` can follow until Claude's own status is idle again. Test in Task 4.
3. **A forged bind** (Codex #2). A launcher sends `launcher_bind` for another session's id, or for a session file whose pid isn't in its own child's process tree. It is refused, and nothing changes. Test in Task 1.
4. **The launcher exits, or agentd restarts, mid-command** (Codex #7). The pending command fails `exited`. Launcher capabilities are advertised only while a live binding exists. After an agentd restart every launcher session shows plugin mode until its launcher reconnects and rebinds. Test in Task 4.
5. **Terminal and child cleanup** (Codex #9). The saved terminal state is restored exactly on every exit path, and no child process is left behind. Test in Task 2.

---

### Task 0: pty backend and the Codex exact-id spike (time-boxed 45 min)

**Files:**
- Modify: `agentd/package.json`
- Create:
  - `agentd/src/launcher/pty.ts`
  - `agentd/test/pty.test.js`
  - `docs/coding-agent/claude/brainstorm/2026-11-14-plan-3-spikes.md`

**Interfaces:**
- Produces:
  ```ts
  export interface PtyChild {
    readonly pid: number;
    write(data: string): void; resize(cols: number, rows: number): void; endInput(): void;   // writes the tty EOF char (\x04)
    onData(cb: (chunk: string) => void): void; onExit(cb: (code: number | null, signal: string | null) => void): void;
    kill(signal?: NodeJS.Signals): void;      // signals the child's process group
  }
  export function spawnPty(file: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; cols: number; rows: number }): PtyChild;
  ```

- [ ] **Step 1: pty backend.** Try `npm install node-pty`.
  - If it loads under the repo's Node, use it.
  - Otherwise bundle `agentd/launcher/pty_helper.py` (Python 3 stdlib `pty.fork` with a select loop; a resize side-channel through `TIOCSWINSZ`; the child pid reported on the first line).
  - Record the choice in the spikes doc.
- [ ] **Step 2: Codex spike.** It costs no tokens: no prompt is sent.
  1. Over the shared daemon socket, using the existing `agentd/src/codex/daemon-socket.ts` client, call `thread/start` with `{cwd: <temp dir>}` and record the thread id.
  2. Spawn `codex resume <id>` in the pty. Confirm that `thread/loaded/list` on the daemon lists that id while the TUI is up, then quit the TUI with `/quit` or Ctrl-C.
  3. Record the outcome in the spikes doc. If it fails, record the exact error. Task 5 then uses the fallback.
  4. Do NOT stop or restart the user's daemon.
- [ ] **Step 3: Write the failing tests.**
  - `pty_echoes_child_output`: run `/bin/sh -c 'printf ready; read x; printf got:$x'`, write `hi\r`, and expect `got:hi`.
  - `pty_reports_exit_code_and_signal`
  - `pty_resize_reaches_child`: `stty size` prints `40 100`.
  - `pty_kill_signals_process_group`: the child spawns a grandchild `sleep 60`; after `kill`, neither is alive.
- [ ] **Step 4:** Implement, then run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): pty backend for rk; record the Codex resume spike`

---

### Task 1: The launcher socket and owned-session binding

**Files:**
- Create:
  - `agentd/src/launcher/launcher-hub.ts`
  - `agentd/src/launcher/claude-sessions.ts`
  - tests `agentd/test/launcher-hub.test.js`, `agentd/test/claude-sessions.test.js`
- Modify:
  - `agentd/src/daemon.ts`: start the hub, reconcile at startup, strip `launcherId` from hook payloads.
  - `agentd/src/attach-registry.ts`: remember explicit detaches.

**Interfaces:**
- Produces:
  ```ts
  // claude-sessions.ts
  export function readClaudeSession(dir: string, pid: number): { pid: number; sessionId: string; status: "idle" | "busy" | string } | undefined;
  export function descendantPids(rootPid: number): number[];      // via `ps -A -o pid=,ppid=`; rootPid included
  export function findOwnedClaudeSession(dir: string, rootPid: number): { pid: number; sessionId: string; status: string } | undefined;

  // launcher-hub.ts
  export interface Binding { key: SessionKey; launcherId: string; gen: number; childPid: number; claudePid?: number }
  export class LauncherHub {
    constructor(opts: { configDir: string; claudeSessionsDir: string; logger: Logger; registry: AttachRegistry });
    start(): Promise<void>; stop(): Promise<void>;
    binding(key: SessionKey): Binding | undefined;               // live bindings only
    send(key: SessionKey, cmd: Omit<TypeCommand, "cmdId" | "gen">): Promise<CommandResult>;
    cancel(key: SessionKey, reason: "cancelled" | "taken_over"): void;
    laptopDraft(key: SessionKey): boolean;
    onChange(cb: (key: SessionKey) => void): void;
  }
  ```
- **Bind rule** (Claude, R49). On `launcher_bind{sessionId}`, agentd runs `findOwnedClaudeSession(dir, hello.childPid)`. It accepts only when all of these hold:
  - the file's `sessionId` equals the claimed id;
  - the file's pid is in `descendantPids(childPid)`;
  - `childPid` is alive;
  - no other live binding owns that session key;
  - the session isn't in the explicit-detach set.

  Otherwise it replies `{type:"bind_rejected", reason}` and changes nothing. On accept: `gen += 1`, then `registry.attach("claude", id, "launcher")`.
- **Rebind:** `launcher_bind` with a new session id, from the same launcher (`/clear`, resume): the old binding is retired, its pending command is cancelled (`cancelled`), and the old session's mode becomes `plugin`. A late hook from the retired session has no effect on bindings, because hooks never bind.
- **Explicit detach** (R51). `/rokid:off` on a launcher session records `{key, launcherId, childPid}` in a persisted explicit-detach list in `attached.json`. That launcher's auto-bind for that key is refused, including after an agentd restart and launcher reconnect. The entry is dropped when `/rokid:on` runs for that session, or when `childPid` is no longer alive (checked at bind time and at startup).
- **Startup reconciliation:** at daemon start, every session that `attached.json` records as `launcher` is rewritten to `plugin`. Launcher mode exists only with a live binding.
- **Codex** (Task 5): the launcher sends `launcher_bind{sessionId: threadId}`. agentd accepts it only if this launcher's own `rk_codex_thread_start` request created that thread (agentd records it, below).

- [ ] **Step 1: Write the failing tests.** Use a temp sessions dir with fixture files and real child processes from `spawn("sleep", ["30"])`.
  - `bind_accepted_for_owned_session_file`
  - `bind_rejected_for_other_sessions_id` (Review Focus 3)
  - `bind_rejected_when_file_pid_not_descendant` (Review Focus 3)
  - `bind_rejected_when_key_owned_by_another_launcher`
  - `duplicate_launcher_id_refused`
  - `hello_deadline_5s`
  - `oversize_line_and_bad_json_close_connection`
  - `command_result_from_other_connection_ignored`
  - `rebind_retires_old_and_cancels_pending`
  - `explicit_detach_blocks_auto_bind_until_launcher_exits`
  - `explicit_detach_survives_agentd_restart_and_reconnect`
  - `startup_rewrites_launcher_mode_to_plugin` (Review Focus 4)
  - `socket_dir_wrong_mode_or_symlink_disables_launchers`
  - `live_foreign_socket_not_unlinked`
  - `stale_socket_unlinked`
  - `hook_payload_launcher_id_stripped`
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): launcher socket with owned-session binding`

---

### Task 2: The `rk` CLI: spawn, pass-through, exact terminal restore, child cleanup

**Files:**
- Create:
  - `agentd/src/rk.ts`
  - `agentd/src/launcher/terminal.ts`
  - `agentd/test/rk.test.js`
  - `agentd/test/fixtures/fake-claude.js`
- Modify: `agentd/package.json`, adding the bin `"rk": "dist/rk.js"`.

**Interfaces:**
- Produces, in `terminal.ts`:
  ```ts
  export function saveTerminal(): string | undefined;          // `stty -g` on the controlling tty; undefined when stdin is not a TTY
  export function restoreTerminal(saved: string | undefined): void;  // idempotent: `stty <saved>`, then `\x1b[?25h`, `\x1b[?2004l` (bracketed paste off)
  ```

**`rk claude [args…]`:**
- Save the terminal state, put stdin in raw mode, then spawn `claude` (or `ROKID_RK_CLAUDE_BIN` for tests) with the args unchanged, in a pty at the current size. SIGWINCH resizes it.
- Connect to the hub and send `launcher_hello`.
- Poll `findOwnedClaudeSession` every 500 ms until it finds a session (give up after 30 s, and stay unattached), then send `launcher_bind`. Keep polling every 2 s to catch a session change after `/clear` or a resume.

**`rk codex [args…]`:** see Task 5. It refuses `-c` and `--dangerously-bypass-hook-trust` with:
`rk codex: -c and --dangerously-bypass-hook-trust move Codex off the shared daemon; run plain codex for those.`

**Exit handling** (Review Focus 5, R53):

| Situation | Handling |
|---|---|
| Child exits | `restoreTerminal`, then exit with the child's code. A signal maps to exit 128 + signal number. |
| SIGHUP or SIGTERM to `rk` | Forward the signal to the child's process group. After 3 s send SIGKILL, reap the child, restore the terminal, and exit 128 + signal number. |
| SIGINT | Arrives as a byte in raw mode and is passed through. No special handling. |
| Ctrl-Z | Passed through to the child as a byte. `rk` never stops itself. |
| Spawn failure | Restore the terminal, print `rk: could not start claude: <error>`, exit 127. |
| stdin EOF | `endInput()`. If the child hasn't exited within 10 s, SIGHUP its process group, then SIGKILL after 3 s. Reap the child and restore the terminal. |
| Uncaught error | Handled the same way as SIGTERM. |

**Fake CLI** (`fake-claude.js`):
- It models an editable prompt line. It echoes typed characters into an internal `line` buffer. `\r` submits the line, `\x15` clears it, and `\x1b` closes a dialog.
- It writes its own `sessions/<pid>.json` into `ROKID_CLAUDE_SESSIONS_DIR` with `status` `busy` or `idle`.
- `/compact` → busy, then sends PostCompact through the real `hook-forward`, then idle.
- `/model X` → prints `Switch model?` and waits. `\r` → `Set model to X`, then idle.
- With `FAKE_NO_DIALOG=1`, `/model` prints nothing.
- With `FAKE_BUSY_MS`, it stays busy for that long, with no output.
- It exposes its final `{line, dialogOpen, model}` on SIGUSR2 to a file, so tests can assert the end state.

- [ ] **Step 1: Write the failing tests.**
  - `rk_claude_runs_fake_and_returns_exit_code`
  - `signal_exit_maps_to_128_plus_n`
  - `binds_owned_session_from_sessions_file`
  - `rk_codex_refuses_dash_c`
  - `banner_text_exact`
  - `unreachable_agentd_prints_line_and_still_runs`
  - `terminal_state_identical_after_exit_sigterm_sighup_and_throw` (Review Focus 5): run `rk` inside an outer pty and compare `stty -g` before and after on that same pty.
  - `no_child_or_grandchild_left_after_sigterm` (Review Focus 5)
  - `spawn_failure_exit_127_and_terminal_restored`
  - `stdin_eof_ends_child_and_reaps`
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(agentd): rk claude launcher with exact terminal restore and child cleanup`

---

### Task 3: The typist: readiness, input ownership, and command-scoped parsing

**Files:**
- Create:
  - `agentd/src/launcher/typist.ts`
  - `agentd/src/launcher/output-scanner.ts`
  - tests `agentd/test/typist.test.js`, `agentd/test/output-scanner.test.js`

**Interfaces:**
- Produces:
  ```ts
  export class OutputScanner {            // command-scoped: created when a command starts, sees only output after that
    constructor(maxBytes = 8192);
    push(chunk: string): void;             // strips ANSI/OSC incrementally (sequences may span chunks); keeps a bounded tail
    seen(marker: string): boolean;         // marker matched in text pushed since construction
  }
  export class LaptopInput {               // tracks the user's draft
    key(data: string): "pass" | "hold";    // while automation owns input → "hold" (buffered), except Esc / Ctrl-C → takeover
    readonly draft: boolean;               // see Draft tracking: cleared only by \r or \x03 (Ctrl-C)
    flushHeld(): string;                   // keys held during automation; replayed only on positive readiness or takeover (see Input ownership)
  }
  export class Typist {
    constructor(pty: PtyChild, input: LaptopInput, ready: () => boolean /* sessions file idle */, clock: Clock);
    run(cmd: TypeCommand): Promise<CommandResult>;   // one at a time; a concurrent run → busy
    cancel(cmdId: string): void;
  }
  ```

**Readiness (R50, R55).** Checked immediately before EACH write, never only once.
- All of these must hold:
  - `ready()` returns true. That needs:
    - the owned sessions file reads `status: "idle"`;
    - its `statusUpdatedAt` is later than the command's `notBefore` (Task 4), when the command carries one. `notBefore` is agentd's latch from earlier activity (a previous command, or a Stop delivery). The command's own dispatch never sets it;
    - the command's `gen` equals the launcher's current binding generation, from `bind_accepted{gen}`.
  - `!input.draft`
  - 500 ms of output quiet
  - the command hasn't been cancelled
- When a Stop hook is about to hold, Claude still reads `busy`, so the file check also covers a hold that opens after dispatch. agentd additionally sends `cancel_command` the moment a hold opens, an approval or question becomes pending, or the binding changes.
- The wait times out at 60 s: with `laptop_draft` if a draft was the blocker, and with `busy` otherwise.

**Input ownership (Codex #4).** It starts at the command's first write and ends when the command completes. For `compact`, that means through the correlated PostCompact (Task 4), or 180 s.
- While automation owns input, the user's keys are held.
- **Esc or Ctrl-C** → `taken_over`. Automation stops at once and writes nothing more. The key passes through, and held keys are replayed right after it: the user has taken over, so their keys are theirs.
- **Release on success or failure:** held keys are replayed only once the prompt is positively ready. That means the sessions file reads `status: idle` with `statusUpdatedAt` later than this command's first write, and the binding isn't `uncertain`. Until then, including after a compact timeout or a failed model recovery, the keys stay held, and only an Esc or Ctrl-C takeover releases them (Codex re-review 2).
- **Which writes are gated:**
  - Only a command's first write needs the file readiness check.
  - Later writes in the same command, such as the `/model` confirm `\r`, are gated by the scanner state machine plus not-cancelled and not-taken-over.

**Draft tracking.** It is conservative, because prompt contents aren't observable.
- These set `draft = true`:
  - any printable key or paste
  - Up/Down arrows, which can recall history
  - Tab
  - Backspace
- Only `\r` (submit) or `\x03` (Ctrl-C) clears it. Ctrl-U doesn't, because with a moved cursor it doesn't guarantee an empty line.
- The `OutputScanner` for a command is created at that command's first write, not when the command is created.

**Commands**

`compact`:
1. Write `/compact\r`.
2. Resolve `ok` once it is written. Input ownership stays held until agentd's `compact_done{cmdId}` (Task 4), takeover, or 180 s. Completion is decided by agentd.

`model`:
1. Write `/model <alias>\r`.
2. The scanner waits up to 5 s for `Switch model?`, seen only after the write.
3. Write `\r`.
4. Wait up to 10 s for `Set model to` → `ok`.

Model recovery, on either timeout:
1. Write `\x1b`.
2. Wait 1 s for quiet.
3. Resolve `dialog_not_seen`.
4. Mark the binding `uncertain`. While a binding is uncertain, agentd refuses every `launcher_command` for that session with `rejected uncertain`. It stays that way until a UserPromptSubmit hook from the laptop, or a fresh `status: idle` with a newer `statusUpdatedAt`, shows that the prompt is usable again. Esc success is never assumed (Codex #10).

The test asserts the fake's final state: `dialogOpen:false`, `line:""`, and the model unchanged (Review Focus 1 and Codex #10).

`text`:
1. Bracketed paste, then `\r`.
2. Resolve `ok` once the paste has been written.

- [ ] **Step 1: Write the failing tests** (fake pty, fake clock, fake ready).
  - `never_types_over_laptop_draft_and_fails_laptop_draft_after_60s` (Review Focus 1)
  - `draft_cleared_by_enter_or_ctrl_u_then_command_runs`
  - `paste_marks_draft`
  - `confirm_write_gated_by_scanner_not_by_file` (`/model` confirm proceeds while the file reads busy during the dialog)
  - `cancel_between_model_writes_sends_esc_only_and_marks_uncertain`
  - `user_keys_held_during_model_and_replayed_after_positive_idle`
  - `held_keys_not_replayed_after_compact_timeout_until_idle_or_takeover`
  - `held_keys_not_replayed_after_failed_model_recovery_until_idle_or_takeover`
  - `esc_during_model_takes_over_and_writes_nothing_more`
  - `model_no_dialog_recovers_and_fake_state_clean`
  - `stale_marker_before_write_not_accepted`
  - `marker_split_across_chunks_and_ansi_matched`
  - `scanner_bounded_at_8k`
  - `cancel_while_waiting_writes_nothing`
  - `up_arrow_recall_marks_draft`
  - `ctrl_u_does_not_clear_draft`
  - `keys_held_through_compact_until_compact_done`
  - `stale_gen_command_dropped_before_write`
  - `statusUpdatedAt_older_than_notBefore_is_not_ready`
  - `already_idle_session_first_write_allowed_without_new_timestamp`
  - `scanner_starts_at_first_write`
  - `failed_model_recovery_marks_uncertain`
- [ ] **Step 2:** Implement, then wire it into `rk claude`:
  - Socket `type_command` → `Typist.run` → `command_result`.
  - `cancel_command` → `Typist.cancel`.
  - `laptop_state` is sent on draft changes.
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(agentd): type commands only into an idle, empty prompt, with laptop takeover`

---

### Task 4: agentd routing: the session state machine, `launcher_command`, post-*Y* follow-ups, capabilities

**Files:**
- Create:
  - `agentd/src/launcher/session-state.ts`
  - `agentd/test/session-state.test.js`
  - `agentd/test/launcher-routing.test.js`
- Modify:
  - `agentd/src/phone-v2.ts` (the `launcher_command` handler replaces the Plan 2 stub; decoration)
  - `agentd/src/daemon.ts`
  - `plugins/claude-code/hooks/hooks.json`: register `PreCompact` and `PostCompact` (and `SessionStart` if it's missing) to the same forwarder, so real completion is observable (Codex #5).

**Interfaces:**
- Produces:
  ```ts
  export type LaunchState = "busy" | "held" | "ready";
  export class SessionStates {
    constructor(readSession: (claudePid: number) => { status: string; statusUpdatedAt: number } | undefined, clock: () => number);
    latch(key: SessionKey, at: number): void;  // synchronous, on Stop delivery and on command_written{cmdId, at}
    clearLatch(key: SessionKey): void;
    onHook(key: SessionKey, event: string, payload: Record<string, unknown>): void;   // PreCompact/PostCompact correlation, UserPromptSubmit clears uncertain
    state(key: SessionKey): LaunchState;
  }
  ```

**Readiness in agentd (R55).** It replaces a hook-driven idle state, so it can't deadlock.
- A session is `ready` when all of these hold:
  - no StopWait is held;
  - no approval or question is pending;
  - the binding isn't `uncertain`;
  - agentd's own read of the owned sessions file, from `claudePid` in the binding, shows `status: "idle"`;
  - that read's `statusUpdatedAt` is later than the session's `latchAt`, if a latch is set.
- **The latch is a post-write freshness barrier, never a pre-write block on the command itself.**
  - agentd sets `latchAt` synchronously in two places:
    - on a Stop-hook `delivered` release, before the hook response returns (Review Focus 2);
    - on the launcher frame `{type:"command_written", cmdId, at}`, which the launcher sends right after a command's first write.
  - While a command is in flight, agentd dispatches no other command to that session.
  - The next `type_command` carries `notBefore: latchAt`, which is how the barrier reaches the launcher.
  - An already-idle Claude with no latch is ready immediately; a fresh timestamp isn't needed.
  - A set latch clears in any of these cases:
  - `command_result ok` for `model`, because `/model` may never flip the status;
  - `compact_done` for this compact;
  - a sessions-file `status: idle` whose `statusUpdatedAt` is later than `latchAt`.
- **Unheld Stops need no special handling:** `StopWait.hold()` returns immediately with no trusted phone or at the cap, and Claude's own status then goes idle.
- **Polling:** while a command waits, agentd re-reads the file every 250 ms, up to 60 s.
- **`state(key)`** is `held` when a StopWait is held, `ready` when the conditions above hold, and `busy` otherwise.
- **Compact correlation:** a compact completes on a PreCompact with `trigger: "manual"` received after its dispatch, followed by a PostCompact for the same session, binding gen and generation. An `auto`-trigger compact never completes a launcher command. agentd then sends `compact_done{cmdId}` to the launcher.

**`launcher_command {sessionKey, command, model?, msgId}`**
- Steering, TLS only.
- Rejections:
  - no live binding → `rejected not_launcher`
  - `model` outside `opus|sonnet|haiku` → `rejected bad_model`
- Otherwise it waits up to 60 s for state `ready`, then dispatches `type_command` with the binding's `gen`.
- Results:
  - `compact` is `applied` when PostCompact for this session and this binding generation arrives within 180 s of the dispatch, and `rejected timeout` otherwise. Commands are serialised through completion.
  - `model` and `text` are `applied` when the typist reports `ok`.
  - Any other result → `rejected <error>`.
- While waiting or running, a binding change (gen differs), a detach, or a session end → `cancel_command` and `rejected cancelled`.
- `AppliedIds` dedups commands by `msgId`.

**Follow-up in launcher mode**
- state `held` → the existing `StopWait.deliver` path.
- state `ready` → `type_command{command:"text"}`.
- `busy` → wait for idle (60 s), then `rejected busy`.

**Decoration**
- Only while `binding(key)` is live:
  - `mode:"launcher"`, `capabilities.compact = true`, `capabilities.model = true`
  - `followup`: `waiting` when held, `ready` when ready and the laptop has no draft, `unavailable` otherwise
- Otherwise: plugin-mode decoration (Review Focus 4).

- [ ] **Step 1: Write the failing tests.**
  - `delivered_followup_marks_busy_before_hook_returns` (Review Focus 2)
  - `consecutive_followups_never_type_while_claude_continues`
  - `silent_busy_period_does_not_count_as_idle` (busy with no output)
  - `startup_idle_session_is_ready_without_any_hook`
  - `two_consecutive_model_commands_both_run` (the second runs after the first's `ok` clears the latch)
  - `first_command_on_idle_session_not_blocked_by_its_own_dispatch`
  - `cap_reached_unheld_stop_then_late_reply_types`
  - `auto_compact_does_not_complete_launcher_compact`
  - `uncertain_binding_rejects_until_laptop_prompt`
  - `launcher_command_on_plugin_session_rejected_not_launcher`
  - `compact_applied_only_on_post_compact_of_same_generation`
  - `compact_timeout_rejected`
  - `rebind_during_wait_cancels_and_rejects_cancelled`
  - `model_applied_after_typist_ok`
  - `bad_model_rejected`
  - `no_type_command_while_held`
  - `followup_while_held_uses_stop_hook`
  - `followup_after_y_types_when_idle`
  - `launcher_exit_mid_command_rejects_exited_and_reverts_to_plugin` (Review Focus 4)
  - `bundled_hooks_json_registers_pre_and_post_compact` (reads the real `plugins/claude-code/hooks/hooks.json`)
  - `duplicate_msgId_not_retyped`
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(agentd): route glasses compact, model and late replies to the rk launcher by session state`

---

### Task 5: `rk codex`

**Files:**
- Modify:
  - `agentd/src/rk.ts`
  - `agentd/src/launcher/launcher-hub.ts`: a new socket frame `{type:"codex_thread_start", cwd}` → agentd calls `thread/start` on the shared daemon and replies `{type:"codex_thread", threadId}`, recording that this launcher created it.
- Test: `agentd/test/rk-codex.test.js`, against the fake daemon server the Codex monitor tests already use.

**Interfaces / rules**
- **Path A** (the Task 0 spike passed):
  1. `codex_thread_start{cwd: process.cwd()}` → `launcher_bind{sessionId: threadId}`, accepted because this launcher created that thread.
  2. Spawn `codex resume <threadId> [args…]` with `stdio:"inherit"`.
  3. The exit code passes through.
- **Terminal and signals for `rk codex`** (no pty, inherited stdio, Codex #new-3):
  - Codex runs in `rk`'s own process group in the terminal foreground. `rk` saves `stty -g` before spawning and restores it after the child exits, as a safety net, since Codex restores its own.
  - While the child runs, `rk` ignores SIGINT and SIGQUIT, so a terminal Ctrl-C reaches Codex and not `rk`'s exit path.
  - SIGTERM or SIGHUP to `rk` → forward to the child pid, then SIGKILL after 3 s, reap, and exit 128 + n.
  - The child's own exit code is returned.
  - SIGTSTP is left at its default, so job control suspends both.
- **Path B** (the spike failed, R25-safe): spawn plain `codex [args…]` and print `Type rokid:on in Codex to attach this session.` The Codex plugin's existing exact-id attach (Plan 1) does the rest. Record in the spikes doc which path shipped. Path B adds no launcher-only capability. Codex needs none, since every control works through the daemon.
- Codex sessions are decorated exactly like plugin-mode Codex (all capabilities), with the board tag `LAUNCHER` on Path A.

- [ ] **Step 1: Write the failing tests.**
  - `codex_thread_start_binds_created_thread_only`
  - `bind_of_thread_not_created_by_this_launcher_rejected`
  - `resume_args_passed_through`
  - `path_b_prints_attach_hint`
  - `ctrl_c_in_terminal_reaches_codex_not_rk`: SIGINT to the foreground group in a test pty; `rk` stays alive until the fake child exits and returns its code.
  - `sigterm_forwarded_and_terminal_restored`
- [ ] **Step 2:** Implement whichever path Task 0 recorded.
- [ ] **Step 3:** Run `npm test`. Expected: PASS.
- [ ] **Step 4: Commit** `feat(agentd): rk codex starts a thread it owns and resumes it`

---

### Task 6: Live smoke (tiny), docs, and the Codex diff review

**Files:**
- Create: `docs/coding-agent/claude/plan/2026-11-14-plan-3-smoke.md`
- Modify:
  - design §11a: mark the launcher column delivered, with the banner text
  - `agentd/README.md`: an `rk` section with each mode's limits

- [ ] **Step 1:** Run `npm test`. Expected: all tests pass.
- [ ] **Step 2: Live check with Claude on Haiku,** in a throwaway temp dir, with agentd and `node test/fake-phone.js --tls` connected.
  1. Run `rk claude --model haiku --plugin-dir <repo>/plugins/claude-code`.
  2. **Startup:** the phone gets `session_upsert mode=launcher capabilities.compact=true`.
  3. **Compact:** send `say OK`. Once the sessions file reads idle, send `launcher_command compact`, which should be `applied` after the real PostCompact.
  4. **Late reply:** with *Y* at 30 s through `settings_sync`, let the Stop wait expire, then send `followup "Reply BANANA"`. BANANA should appear, typed rather than hook-delivered.
  5. **Never send `launcher_command model`.**
- [ ] **Step 3: Codex check.**
  - **Path A:** run `rk codex`, check that the phone gets the upsert for the created thread, then quit without prompting (no tokens).
  - **Path B:** needs the plugin installed, so it goes on the morning list.
- [ ] **Step 4:** Write the results log and the docs, then commit `docs: plan 3 smoke results and rk docs`.
- [ ] **Step 5: Codex review of the plan-3 diff:**
  ```
  codex exec -m gpt-6.1-sol -c model_reasoning_effort=medium -s read-only "Review the diff rokid-coder/plan-2..rokid-coder/plan-3 …" -o docs/coding-agent/codex/reviews/2026-11-14-plan-3-diff-review.md
  ```
