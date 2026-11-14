The previous review actually lists **7 partly fixed items**, plus 3 new findings; all 10 are covered below.

- **#1 — Partly:** file-based readiness replaces missing idle transitions, but dispatch creates a latch that can block its own command.
- **#3 — Partly:** generation checks and cancellation added; launcher-side propagation of latch changes and binding invalidation remains unspecified.
- **#4 — Partly:** conservative draft rules added, but lines 297 and 359 still say Ctrl-U clears the draft, contradicting line 330.
- **#5 — Fixed:** manual PreCompact after dispatch must precede the matching PostCompact.
- **#7 — Fixed:** explicit detach persists across daemon restart and reconnect.
- **#9 — Fixed:** input-close API, EOF escalation and child reaping specified.
- **#10 — Partly:** scanner timing and uncertain recovery added; line 361 still requires Esc/Ctrl-U recovery, contradicting the revised rules.
- **Prior new finding: state-machine deadlocks — Not fixed:** lines 311 and 417 require an idle timestamp newer than dispatch before the first write. An already idle Claude need not update that timestamp until given input; `/model` success cannot clear a latch that prevents `/model` from being typed.
- **Prior new finding: compact input ownership — Fixed:** ownership now extends through correlated compact completion.
- **Prior new finding: Codex signal handling — Fixed:** inherited-stdio foreground-group and signal rules are explicit.

**New Important:**

- [Task 3, lines 319–349](~/Desktop/rokid/Rokid-Coder/.superpowers/sdd/plan-3-draft.md:319): held keys replay unconditionally when ownership ends, including compact timeout or uncertain model recovery. They can enter a still-running command or dialog. **Fix:** retain buffered keys until positive prompt readiness or explicit laptop takeover; test both failure paths.

For the latch deadlock, separate permission to perform the command’s initial write from the post-write freshness barrier, and specify how agentd communicates that barrier to the launcher.

**Verdict: ready after fixes.** Review only; no tests run.