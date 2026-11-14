**Not ready.** I found six Important issues and one Minor contract mismatch. No Critical finding.

1. **Important — Rebinding discards model-command uncertainty.**  
   [launcher-hub.ts:644](~/Desktop/rokid/Rokid-Coder/agentd/src/launcher/launcher-hub.ts:644), [rk.ts:340](~/Desktop/rokid/Rokid-Coder/agentd/src/rk.ts:340)  
   Disconnecting during a model command makes the launcher uncertain, but reconnecting creates a binding with `uncertain: false` and overwrites that local state. Neither a laptop `UserPromptSubmit` nor fresh idle evidence is required. This breaks the recovery contract; the input-holding guard provides additional protection but does not justify clearing uncertainty.  
   **Fix:** preserve uncertainty and its write timestamp across reconnects for the same child/session. Synchronize that state before allowing commands. Add a reconnect-during-model regression test with an unchanged idle session file.

2. **Important — An acknowledged compact survives link loss and keeps owning input.**  
   [launcher-client.ts:152](~/Desktop/rokid/Rokid-Coder/agentd/src/launcher/launcher-client.ts:152)  
   `running` is cleared when the compact’s immediate `command_result ok` resolves, while `Typist` remains in `compacting`. Consequently, `onLinkDown()` cannot cancel it. After agentd restarts, the new daemon has no compact watch and cannot send its correlated `compact_done`. Laptop keys remain held and new commands return `busy`, potentially until the original 180-second deadline—even after Claude becomes idle.  
   **Fix:** track input ownership separately from result delivery, and cancel the active typist operation on link loss even after its result was acknowledged. Test restart after compact’s initial `ok`, followed by fresh idle and laptop input.

3. **Important — EOF escalation can leave a stubborn grandchild running.**  
   [rk.ts:402](~/Desktop/rokid/Rokid-Coder/agentd/src/rk.ts:402)  
   EOF escalation sends group SIGHUP without setting `sweepGroup`. If Claude exits on HUP but a grandchild ignores it, `finish()` clears the pending KILL timer and skips the final group sweep. The grandchild survives despite rk having forcibly terminated Claude.  
   **Fix:** enable group sweeping when EOF reaches signal escalation. Preserve background jobs only when Claude exits before escalation. The current EOF test uses `FAKE_GRANDCHILD: "1"`; add the `"stubborn"` variant already used by the SIGTERM tests.

4. **Important — Terminal restoration omits modes used by the real TUI.**  
   [terminal.ts:37](~/Desktop/rokid/Rokid-Coder/agentd/src/launcher/terminal.ts:37)  
   Restoration handles termios, cursor visibility, and bracketed paste, but does not leave the alternate screen or disable mouse reporting. Killing Claude/Codex mid-TUI can therefore leave the shell on the alternate screen or receiving mouse escape sequences. The smoke report confirms alternate-screen use; the fake and restoration assertions exercise only cursor and paste modes.  
   **Fix:** restore the additional terminal modes owned by the child, accounting for their initial state where necessary. Extend forced-exit tests to enable alternate-screen and mouse modes and verify their restoration.

5. **Important — Codex lacks the fatal-error cleanup installed for Claude.**  
   [rk.ts:490](~/Desktop/rokid/Rokid-Coder/agentd/src/rk.ts:490)  
   `runCodex()` restores the terminal on spawn failure and child exit, and forwards TERM/HUP, but installs no `uncaughtException`/`unhandledRejection` cleanup. An unexpected parent error after spawn lets Node exit immediately, leaving Codex running and potentially leaving its terminal settings active. The Claude fatal-error test does not cover this path.  
   **Fix:** give Codex a centralized fatal shutdown path that terminates and reaps its owned child, restores the terminal, and exits with failure. Add the corresponding Codex fatal-error test.

6. **Important — Failed terminal-state capture still permits entering raw mode.**  
   [terminal.ts:18](~/Desktop/rokid/Rokid-Coder/agentd/src/launcher/terminal.ts:18), [rk.ts:214](~/Desktop/rokid/Rokid-Coder/agentd/src/rk.ts:214)  
   On a TTY, a failed or timed-out `stty -g` silently returns `undefined`. `runClaude()` nevertheless calls `setRawMode(true)`. Every later restore then skips termios restoration, so the “saved terminal state restored on every exit” guarantee cannot hold.  
   **Fix:** distinguish non-TTY input from capture failure. On a TTY, fail before changing terminal settings if the original state cannot be saved. Test failed state capture explicitly.

7. **Minor — Launcher-side framing does not enforce the documented socket contract.**  
   [rk.ts:128](~/Desktop/rokid/Rokid-Coder/agentd/src/rk.ts:128)  
   Complete lines are parsed before any size check; only the unfinished remainder is bounded, using UTF-16 string length rather than bytes. Malformed JSON and unknown frame types are ignored instead of closing the connection. Thus a newline-terminated oversized frame bypasses the limit, and enforcement differs between launcher and hub. Under the same-user trust model this is chiefly a robustness mismatch.  
   **Fix:** enforce the byte limit on every line before parsing, validate recognized frame shapes, and close on malformed or unknown frames. Add launcher-side tests matching the hub framing tests.

The inspected hub path strips HTTP `launcherId`, verifies session ownership through the claimed child’s process tree, and protects the socket with directory/socket permissions. The synchronous Stop-delivery latch addresses the specified follow-up race. Pairing via the hook forwarder uses the protected socket; admission consumes the window, and Enter closes the launcher prompt’s window.

Verification: `tsc --noEmit` exited 0. Focused tests against existing `dist` output ended with:

```text
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

I did not run `npm test`: it rebuilds and writes files, which this read-only session prohibits. No files were edited.