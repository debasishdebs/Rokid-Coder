# Morning list for Debasish (overnight run, 2026-11-14)

Everything here was deliberately NOT done overnight. Ruling R25 says outward actions and anything touching your devices need you; Codex can stand in only for design decisions.

The full trace lives in the SDD ledgers under `.superpowers/sdd/*/progress.md` (git-ignored). Every decision is a `Ruling Rnn:` line there, with why and the cost if wrong. Every plan has its own branch (R26), so each one can be reverted on its own.

## Status at a glance
- **Plan 1 (laptop, agentd + plugins):** DONE on branch `rokid-coder/plan-1`, head `98e50c91`. agentd tests pass 375/375.
  - Every task was reviewed, followed by a final whole-branch review and a Codex sol diff review.
  - A live smoke test ran on Haiku and luna: `docs/coding-agent/claude/plan/2026-11-14-plan-1-smoke.md`.
- **Plan 2 (phone + glasses):** DONE (device-free) on branch `rokid-coder/plan-2`, head `6e7e0395`. Task 13 (phone-hub) is DEFERRED because `../CxrGlobal` is missing.
  - Tests: Agents plugin 345/345, agentd 441/441, shared 460, bus-client 151. glasses-hub is 974/976; the 2 failures are pre-existing `GlassesFileStoreTest` ones, not ours.
  - Every task was reviewed, with fix rounds where needed. Then a final whole-branch review, a Codex sol diff review, one fix wave and a re-review.
  - **Nothing has run on a device yet.** Work through `docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md` (50 items).
- **Plan 3 (`rk` launchers): DONE** on branch `rokid-coder/plan-3`, head `3cea4e47`, with 650/650 agentd tests passing.
  - What it adds:
    - `rk claude`: a pty launcher with an exact session binding, safe typing, a pairing prompt and next-step hints
    - `rk codex`: plain codex plus a hint block
    - `/rokid:pair` and a richer `/rokid:status`
  - How it was checked: every task was reviewed, then a final opus review, a Codex sol diff review, one fix wave, a re-review, and the residual R165.
  - The live smoke on Haiku (never `/model`) is in `docs/coding-agent/claude/plan/2026-11-14-plan-3-smoke.md`.

- **Plan 4 (morning feedback): DONE (device-free)** on branch `rokid-coder/plan-4`, head `8974d605` plus this docs commit.
  - Tests the controller ran itself: agentd 672/672; Agents plugin 490 tests with 0 failures. Codex final check: all findings addressed.
  - Details, the open questions and the device checks are in the "Plan 4" section at the end.

- **Plan 5 (cleanup, per-kind sounds, OpenClaw removed): DONE** on branch `rokid-coder/plan-5`. It is based on plan-4 and is on top of everything else.
  - Tests the controller ran: agentd 685/685, twice. A third run hit one flake in an older Codex reconnect test, `codex_socket_reconnect_resubscribes_attached`, which is logged. Agents plugin 482/0 on 3 runs.
  - Codex reviewed it once, followed by one fix wave, and a check confirmed all findings were addressed.

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
     - **Consequence:** an alert you don't touch keeps being re-shown silently and never gets its spoken reminder until Task 13 lands. *Now superseded: per U1, reminders are always silent (Plan 4).*
   - **D1:** phone settings use your LiveFit/PCA light mint Material3 look, not Nexus's dark green.
   - **D7:** the alert sound is a short spoken cue ("Claude needs approval"), not a tone. *Now superseded by U3 (Plan 4): approvals, questions and errors are spoken, Done chimes, reminders are silent.*
9. **Security calls,** in the Plan 1 ledger:
   - **R44:** a separate `steer` secret, carried only in the pairing line. *Since Plan 4 (U8/R169), the token alone gives no access at all: there is no monitor-only mode.*
   - **R45/R57/R58/R60:** PhoneLink trusts a set of phone certificates.
     - Pairing works only inside a 2-minute window that `pair` or `phones allow-next` opens.
     - After a `forget`, a phone needs `allow-next` again.
     - `forget --all` also rotates `steer`.
   - **R54:** *superseded by U8 (Plan 4): plaintext links no longer exist.*
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

## Plan 2 decisions to review (ledger `.superpowers/sdd/2026-11-14-plan-2-phone-glasses/progress.md`, R71–R128)

**Safety and security** (most important):
- **R96/R104/R109:** one card on screen at a time. Taps only reach the card you can see, and the tap guard re-arms after every alert band.
- **R114/R120:** the link where agentd dials the phone is mutual TLS, and the phone pins agentd's cert.
- **R121:** the phone trusts a new computer only inside the "Add a computer" window. There is no silent first-use trust.
- **R123:** *superseded by U4/U13 (Plan 4):* long replies are shown condensed (head … middle … tail, with Read all) and are always sent in full.
- **R125/R128:** approvals show the actual command first. If agentd had to cut the command, there is no Allow on the glasses.
- **R126:** the phone steers only when agentd's `hello_ack` says `steering: true`. *Since Plan 4, anything else is refused, and the phone shows "Pair again — this computer no longer trusts this phone".*

**Behaviour:**
- **R83:** an alert raised while no phone is linked arrives as new, with sound.
- **R92:** no v1 or v2 double alert.
- **R101:** safety state is shown on the board and menu, not in brief notices.
- **R111:** the phone owns the settings.
- **R112:** the CLI is `agentd`.

**UI:**
- **R88/R89/R90:** board tags, the file name kept on long paths, and an immediately updated "+N waiting".
- **R95/R97:** wording.

**Known interim (R33/R47):** until phone-hub Task 13, an alert you never touch gets no spoken reminder.

## Known risk found overnight (R137, not fixed)
- The hook endpoint, `127.0.0.1:8791` (inherited from Nexus), has no request authentication.
- Another local OS user on the same Mac could forge hook events, for example to attach sessions or fake approval prompts.
- Your own processes are trusted anyway, since they can type into your terminal.
- Proposed fix for later: a per-install hook secret (file mode 0600) that the forwarder sends and agentd checks.


## Your answers this morning (U1–U13), and what follows
They are recorded in every ledger and in `.superpowers/sdd/MASTER-HANDOFF.md`.
- **Already built in Plan 3:**
  - U5: self-explanatory CLI hints
  - U6, launcher side: rk and the plugins prompt you to pair, and `/rokid:pair` exists
- **Plan 4:** U1, U3, U4/U13, U6 (phone and glasses), U7 and U8. It is built; see "Plan 4" below.
- **U9:** the hook endpoint risk is accepted. **U11:** CxrGlobal isn't needed.

## Plan 3 items for you
- **Codex plugin attach** (`rokid:on` inside Codex) was not tested live, because it needs the Codex plugin installed (R25).
- The Plan 3 spike left 2 empty Codex threads in daemon memory. They clear on the next daemon restart.
- Pairing a new phone from inside a session opens a 2-minute window on the same Wi-Fi or Tailscale (R154). Verify it on the device.

## Plan 4 (morning feedback), branch `rokid-coder/plan-4`, based on the plan-3 head `3a623c2c`
Plan: `docs/coding-agent/claude/plan/2026-11-14-plan-4-feedback.md`. It went through 4 Codex sol plan reviews until READY. Every review in Plan 4 was done by Codex (U14). Ledger and rulings R168–R200: `.superpowers/sdd/2026-11-14-plan-4-feedback/progress.md`.

**What it adds:**
- **Encrypted links only (U8).** agentd and the phone talk over TLS only, pinned both ways. On wss the phone now presents its own certificate. Nothing is unencrypted any more, and there is no "monitor only" mode.
- **Pairings expire when unused (U7).** A pairing not used for N days (default 14, choices 3/7/14/30/90) is signed out on both sides. A connected link never expires.
- **Guided pairing (U6).** On the phone, Add a computer walks you through three steps. On the glasses there is a "Pair a computer" row with a countdown.
- **Alert history (U1).** The phone records each alert's outcome (acted, dismissed, timed out, handled on laptop) in Settings → Alert history. Reminders are now silent.
- **Sounds (U3).** Approvals, questions and errors are spoken. Done plays a short chime, and only over Bluetooth, never the phone speaker. Each question gets its own card, followed by a "Review answers" card.
- **Long voice replies (U4/U13).** They are shown condensed (head … middle … tail) with "Read all", and the full text is always sent. The word limit is 250 by default, 500 at most.
- **Already-sent notice (R152).** If a command was already sent, you see "Already sent — check laptop" and can choose to send again. A consumed command is never sent twice by accident.

**How it ran:** Tasks 1–6 were built and reviewed one at a time. Tasks 7–10 were built in parallel at your request (U15). Codex then did one review pass over Tasks 6–10, followed by one fix wave. Results are in the status line below.

**Phones paired before Plan 4 must pair once more.** Run `agentd pair` or type `/rokid:pair`, then tap "Open the door" in the phone's Add a computer screen.

**Decisions I made on assumption. Please confirm or overrule them (cheap to flip):**
1. **R168: the phone's own cert is required on wss.** That is how each phone gets its own sign-out timer. The cost is one re-pair.
2. **R169: a stale or unknown pairing gets nothing.** It sees "Pair again" rather than a read-only view.
3. **R170: answered by U18.** OpenClaw was removed in Plan 5, in commit `Remove the OpenClaw provider`. That one commit can be reverted on its own.
4. **R172: errors are still spoken.** You named only approvals, questions and Done.
5. **R174: history is shown on the phone only.** Do you want a "Recent alerts" list on the glasses?
6. **R191: the chime can only blip on the speaker if Bluetooth drops within its 0.18 s.** This goes on the device checklist.

**Device checks (no adb from me):** the 12 new Plan 4 items in `docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md`.

**Known residuals (logged in the Plan 4 ledger; none of them is a safety issue):**
- A computer reached both ways (dialled and inbound) counts as two machines. It fails safe.
- Glasses row fitting is a cautious estimate, so "Read all" shows on most longer replies.
- The Android chime player has no unit tests and needs the device check (R191).
- Kept command ids last as long as the plugin service does.

## Plan 5 (2026-11-15 night), branch `rokid-coder/plan-5`
Plan: `docs/coding-agent/claude/plan/2026-11-15-plan-5-cleanup.md`. Your answers U16–U21 are in its header. Ledger: `.superpowers/sdd/2026-11-15-plan-5-cleanup/progress.md`.
- **Sound per alert type, set on the phone (U19).** Settings → Alerts has a row for approval, question, error, Done and reminder, each with Speak, Chime or Silent. The defaults: approval, question and error speak; Done chimes; reminders are silent.
- **OpenClaw removed (U18).** Nothing agentd-related depended on it. One shared text helper moved to `SingleLine.kt`, and old `openclaw.*` prefs are cleared once.
  - **Behaviour change:** monitoring now follows only the agentd switch.
  - I edited the plugin CHANGELOG's 1.0.0 lines in place, assuming 1.0.0 never shipped. Please confirm.
- **`rk` fixes from Plan 3's review.** Stale "uncertain" state is no longer re-sent. Esc and Ctrl-C take over on non-Latin keyboard layouts too. Ctrl-C at the `rk codex` hint now aborts instead of starting Codex. Closed sessions are pruned. The pairing call checks the socket owner. The terminal is restored even when the hint is killed.
- **Tests fixed.**
  - The parallel test daemons raced on shared env settings, and that race is fixed.
  - The smoke test now runs isolated, and `npm run smoke` passes.
  - Three timing flakes were fixed, and one older race in the phone's inbound link was fixed with them.
  - **Still open:** the flake `codex_socket_reconnect_resubscribes_attached`.
- **Worktrees removed (U21).** Their branches are kept for the trace.

**Next: Plan 6 (product-ready + Play Store).** We're in the design discussion now.
