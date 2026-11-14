**Verdict: not ready.**

Previous findings:

1. **Partly fixed** — Explicit states and synchronous Stop delivery marking added; idle transitions remain incomplete.
2. **Fixed** — Owned-session verification, exclusive bindings, and HTTP isolation satisfy R48–R49.
3. **Partly fixed** — Generation and cancellation added, but Task 3’s final-write gate checks neither current generation nor agentd’s hook state; a newly opened hold can still race a delayed write.
4. **Partly fixed** — Input ownership added, but `LaptopInput` misses drafts recalled with Up/history; Ctrl-U also does not guarantee an empty prompt when the cursor has moved.
5. **Partly fixed** — Real compact hooks registered; completion matches session/generation but lacks operation correlation, so an unrelated PostCompact can satisfy it.
6. **Fixed** — Unproven Codex environment propagation replaced with a prerequisite spike and explicit fallback.
7. **Partly fixed** — Retirement and live decoration specified; in-memory detach suppression disappears on daemon restart, allowing reconnect to undo `/rokid:off`.
8. **Fixed** — Socket validation, bounded framing, handshake deadline, and connection-scoped results address R52.
9. **Partly fixed** — Saved terminal state and signal cleanup added; stdin EOF merely closes input, without guaranteed child termination/reaping, and `PtyChild` exposes no input-close method.
10. **Partly fixed** — Incremental parsing and stateful fake added; recovery still assumes Esc/Ctrl-U succeeded, and the scanner starts at command creation rather than necessarily at its first write.

New findings:

- **Important — Task 4, lines 389–409: state-machine deadlocks.** SessionStart and every dispatch set `busy`, but successful `/model` has no transition back to idle. Stop without a hold also has no idle transition: existing `StopWait.hold()` returns immediately when no trusted phone exists or the continuation cap is reached, emitting no release event. **Fix:** specify positive idle reconciliation and transitions for successful commands and unheld Stops; test startup, two consecutive model commands, and cap-reached late replies.

- **Important — Task 3, lines 315–323; Task 4, line 408: input ownership ends before compact completion.** Typist resolves after the echoed command and replays held keys while compaction is still running. This can queue laptop input and make compact completion ambiguous. **Fix:** retain input ownership through correlated PostCompact or explicit takeover; test typing during compaction.

- **Important — Task 5, lines 458–459: inherited-stdio Codex cannot use Task 2’s terminal/signal rules unchanged.** Without raw mode, terminal Ctrl-C signals `rk` directly; “SIGINT arrives as a byte” no longer applies. Process-group ownership is also unspecified. **Fix:** define separate foreground terminal and signal handling for Codex, with Ctrl-C, termination, and terminal-restoration tests.

Review only; no tests run.