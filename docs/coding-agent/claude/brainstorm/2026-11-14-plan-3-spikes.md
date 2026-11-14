# Plan 3 spikes (Task 0)

Date: 2026-11-14. Codex CLI 0.169.0, Node 26.12.0, macOS arm64.

## 1. pty backend: node-pty, no Python fallback needed

**Choice: `node-pty` ^1.1.0** (`agentd/src/launcher/pty.ts`). `agentd/launcher/pty_helper.py` was not written.

It loads under the repo's Node (26.12; the package declares N-API prebuilds) and passes the four pty tests, plus EOF and
kill-after-exit. Process-group kill works: forkpty makes the child a session leader, so `process.kill(-pid)` reaches grandchildren.

**Gotcha, handled in code.** The node-pty 1.1.0 tarball ships `prebuilds/darwin-*/spawn-helper` **without the execute
bit**, and npm 11 does not run node-pty's install script unless it is on the `allowScripts` list. A fresh `npm install`
therefore fails on every spawn with `Error: posix_spawnp failed.` `pty.ts` restores the bit once, before the first spawn
(`chmod 0755` on the helper inside our own `node_modules`). Verified by clearing the bit and re-running the tests. Linux
prebuilds are unaffected. Anyone swapping node-pty versions should re-check this.

## 2. Codex exact-id spike: Path B

**Outcome: `codex resume <id>` on a thread created with `thread/start` and no turn FAILS. Task 5 takes Path B.**

Method (no prompt sent, no tokens spent): over the shared daemon socket (ws over
`~/.codex/app-server-control/app-server-control.sock`, `initialize` with `experimentalApi`), `thread/start {cwd: <tempdir>}`
returned a thread id, and `thread/loaded/list` listed it (loaded on our connection, which stayed open). Then `codex resume <id>`
ran in a pty (cwd = the temp dir, 120x40).

Result, both with plain `codex resume <id>` and with `codex --remote unix:// resume <id>`: the TUI shows "Resuming session..."
and exits with code 1 within the wait:

```
Error: Failed to resume session from ~/.codex/sessions/2026/11/14/rollout-2026-11-14T10-24-55-<id>.jsonl:
thread/resume failed during TUI bootstrap: thread/resume failed: no rollout found for thread id <id> (code -32600)
```

Cause: `thread/start` reports a rollout `path` but writes no file until the thread's first turn, and the TUI's resume goes through
`thread/resume`, which needs the rollout (the same limit noted in `2026-11-14-compat-codex.md`). Sending a first turn would fix
it, but that costs tokens and is excluded from this spike. The "TUI up, confirm in `thread/loaded/list`" step could not run,
because the TUI never came up. (The daemon does list the id, but only because our own spike connection holds it.)

Consequence for Task 5: spawn plain `codex [args...]` in the pty and print `Type rokid:on in Codex to attach this session.`
The plugin's exact-id attach from Plan 1 does the rest. Path B adds no launcher-only capability, which is fine: every Codex
control already works through the daemon.

Side effects on the user's machine: no files were written by us. The two spike threads (empty, no rollout file on disk) stay
loaded in the daemon's memory after `thread/unsubscribe`; they vanish when the daemon next restarts. The daemon was not stopped
or restarted.
