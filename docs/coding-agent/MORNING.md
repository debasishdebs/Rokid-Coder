# Morning list for Debasish (overnight run, 2026-11-14)

Everything here was deliberately NOT done overnight. Ruling R25 says outward actions and anything touching your devices need you; Codex can stand in only for design decisions.

The full trace lives in the SDD ledgers under `.superpowers/sdd/*/progress.md` (git-ignored). Every decision is a `Ruling Rnn:` line there, with why and the cost if wrong. Every plan has its own branch (R26), so each one can be reverted on its own.

## Status at a glance
- **Plan 1 (laptop, agentd + plugins):** DONE on branch `rokid-coder/plan-1`, head `98e50c91`. agentd tests pass 375/375.
  - Every task was reviewed, followed by a final whole-branch review and a Codex sol diff review.
  - A live smoke test ran on Haiku and luna: `docs/coding-agent/claude/plan/2026-11-14-plan-1-smoke.md`.
- **Plan 2 (phone + glasses):** the plan has been reviewed 3× by Codex and is ready. Execution is on branch `rokid-coder/plan-2`; see the progress note at the end of this file.
- **Plan 3 (`rk` launchers):** the plan has been reviewed 3× by Codex and is ready. It runs after Plan 2, on `rokid-coder/plan-3`.

## Needs you: actions
1. **GitHub:** create the GitHub fork `Rokid-Coder` and push the branches. This is Plan 1 Task 0 step 4.
2. **Codex plugin install check.** It writes to `~/.codex`. The exact commands and cleanup are in `.superpowers/sdd/2026-11-14-plan-1-laptop/task-4-report.md`. Don't use `-c` overrides or `--dangerously-bypass-hook-trust`: they move the TUI off the shared daemon (R11).
3. **Your Claude default model is still `sonnet`** in `~/.claude/settings.json`. A test typed `/model` earlier and changed it. Run `/model opus` in a normal session to restore it.
4. **CxrGlobal:** `:phone-hub` can't build without the private `../CxrGlobal` checkout next to the repo. Once it's in place, run the deferred Plan 2 Task 13 (phone-hub `/notice/shown` routing). Until then the glasses' "shown" ack can't work end to end (see R33/R47 below).
5. **Devices:** sideload the forked glasses hub and the Agents plugin over adb, then run the Plan 2 device checklist. The Agents plugin will ask again for "Speech to text" and "Text to speech" in Nexus Plugin access.
6. **Cleanup:** delete `~/Desktop/rokid/Rokid-Coder-docs-backup` once you're happy.
7. **Smoke-test side effects:**
   - Codex itself updated its first-run counters in `~/.codex/config.toml` when its TUI started. We didn't edit the file.
   - Test threads from the smoke runs (tiny prompts) are in your Claude and Codex history.

## Needs your review: decisions taken overnight
8. **Codex sol stand-in decisions for Plan 2,** `docs/coding-agent/codex/reviews/2026-11-14-plan-2-decisions.md` (ledger R31–R38):
   - **Please confirm D3 (R33).** Until phone-hub Task 13 lands, an alert counts as shown only when you act on it or dismiss it.
     - My R42 had also counted a glasses timeout as "shown". Codex showed it was unsafe, so it is withdrawn (R47).
     - **Consequence:** an alert you don't touch keeps being re-shown silently and never gets its spoken reminder until Task 13 lands.
   - **D1:** phone settings use your LiveFit/PCA light mint Material3 look, not Nexus's dark green.
   - **D7:** the alert sound is a short spoken cue ("Claude needs approval"), not a tone.
9. **Security calls,** in the Plan 1 ledger:
   - **R44:** a separate `steer` secret, carried only in the pairing line. The old token alone gives monitor-only access.
   - **R45/R57/R58/R60:** PhoneLink trusts a set of phone certificates.
     - Pairing works only inside a 2-minute window that `pair` or `phones allow-next` opens.
     - After a `forget`, a phone needs `allow-next` again.
     - `forget --all` also rotates `steer`.
   - **R54:** a plaintext, monitor-only phone can still use `fs_list` and see detail text, as in v1.
   - **R61:** `settings_sync` now needs the secure link.
10. **Other notable rulings:**
    - **R8/R10:** the command names are Claude `/rokid:on|off|status` and Codex plain-text `rokid:on|off|status`.
    - **R14/R15:** approve-all never answers questions or plans.
    - **R39:** v1 shows only a "+N waiting" count; you can't swipe through the queued alerts.
    - **R62/R68/R69:** a laptop answer settles the glasses approval. A laptop "No" or interrupt is not an error alert.
11. **Deferred minors,** in the ledger under `minor (deferred)`, for a later pass. The main ones:
    - matching two identical pending approvals (twins)
    - lowering Y while a question is held
    - the `pair` window also opening for wss-only pairing
    - a local DoS on the TLS sniffer

## Plan 2/3 progress
(updated at the end of the run)
