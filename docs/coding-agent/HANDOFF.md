# Rokid-Coder handoff (committed; read this first in a new conversation)

Last updated 2026-11-15. The detailed SDD ledgers exist only on the original Mac (`.superpowers/`, git-ignored). This file is the portable summary.

## State
- Repo: `github.com/debasishdebs/Rokid-Coder`. `main` is the untouched upstream Rokid-Nexus base.
- Each plan is on its own branch, and each branch builds on the one before:

  | Branch | What it is |
  |---|---|
  | `rokid-coder/plan-1` | laptop helper and plugins |
  | `rokid-coder/plan-2` | phone and glasses |
  | `rokid-coder/plan-3` | the `rk` launchers |
  | `rokid-coder/plan-4` | the morning feedback |
  | `rokid-coder/plan-5` | cleanup, per-kind sounds, OpenClaw removed |
  | `release/0.8.0` | everything above, versioned, tag `rokid-coder-v0.8.0` |
  | `release/1.0.0` | Plan 6 work: product-ready v1 |

- Last verified on macOS: agentd 685/685 (`cd agentd && npm test`); Agents plugin 482 tests, 0 failures (`cd plugins/agents && ../../gradlew testDebugUnitTest assembleDebug` with JDK 17).
- Not yet done: the device checklist (`docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md`) and the Codex plugin live check. Open items: `docs/coding-agent/MORNING.md`.
- Docs map: design `docs/coding-agent/claude/design/`, plans `docs/coding-agent/claude/plan/`, Codex reviews `docs/coding-agent/codex/reviews/`, releases `docs/coding-agent/releases/`.

## User decisions so far (the key ones; they override older rulings)
- U1/U3/U19: reminders are silent. The sound for each alert kind (approval, question, error, Done, reminder) is a phone setting. Each question gets its own card.
- U4/U13: long voice replies are shown condensed (head … middle … tail) and always sent in full. The word limit is 250 by default, 500 at most.
- U6/U17: guided pairing is built into rk, the plugins, the phone and the glasses. A stale pairing just asks you to pair again, like a website login.
- U7/U16: a pairing signs out after 14 days unused (configurable). The phone presents its own cert, so each phone has its own timer.
- U8: no unencrypted connection anywhere. Links are pinned TLS, mutual on both paths.
- U9: hooks on 127.0.0.1 are trusted as the same user (accepted risk).
- U14/U15: Codex (`gpt-6.1-sol`) does the reviews. Build independent tasks in parallel, then do ONE review pass and one fix wave.
- U18: OpenClaw is removed.
- U25: versions go 0.8.0 → 1.0.0; 1.0.0 is the product-ready release.
- U26: onboarding. Anyone can install. The phone does setup and permissions first, then a Claude/Codex checklist, then says "finish on your laptop". When the laptop pairs (the two-way encrypted link), the phone's setup screen is pinged automatically and continues with the remaining steps. If the user has neither Claude Code nor Codex, `rk claude` / `rk codex` offer to install it.
- U27: v1.0.0 ships downloadable APKs and laptop installers (`.dmg`/`.pkg` and `.exe`) via GitHub Releases. The phone app goes to the Play Store later. Laptop and glasses installs come from the repo.
- U28: **"laptop/computer" means macOS AND Windows.** Windows is in v1.0 where feasible and in v1.1 at any cost. Windows work starts on the user's Windows 11 laptop in a fresh conversation, from this file.
- U29/U30: the repo layout is approved:

  ```
  computer/       agentd + rk (Node/TS), macOS + Windows
  plugin/         claude-code/ + codex/ plugins
  mobile/         ONE phone app: our shell, onboarding and Agents code, linking the Nexus hub core
  glasses/        our glasses app shell + glasses install steps, linking the Nexus glasses hub
  common/         (optional) code our mobile/ and glasses/ share
  vendor/nexus/   upstream Rokid-Nexus as a git subtree, patched minimally
  ```

  - Patches to `vendor/nexus/` are listed in `vendor/nexus/PATCHES.md`.
  - The store, self-updater and other plugins are excluded via the build, not deleted.
  - A weekly GitHub Action pulls upstream, runs every suite and opens a PR.
- U31: ONE phone app, with Nexus embedded. Reasons: two installs add friction, and the open Nexus plugin host would let unvetted third-party plugins draw on the glasses. The merged app exposes no plugin host.

## Plan 6
- The design is `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md`: "done" is §3, my calls are §8, the user's answers U32–U34 are §9.
- Next step: the user approves the design, then the plan is written (writing-plans), then the tasks are built in parallel with one Codex review.
- **Windows requires WSL (U34).** Settle where agentd runs (preferably inside WSL with mirrored networking) at the start of the Windows session.

## Windows work list (for the fresh Windows conversation)
**Plugin mode (target v1.0):**
1. `computer/` (today `agentd/`): `npm install && npm run build && npm test` on Windows 11, then list the failures.
2. The launcher socket: a unix socket (`<configDir>/launcher.sock`, 0600) becomes a Windows named pipe, with an owner-only ACL check replacing the uid/mode checks. See `agentd/src/launcher/` and `agentd/src/tls.ts` (0600/0700 file checks).
3. Autostart: `agentd/scripts/install-launchagent.sh` is macOS-only; Windows needs a Task Scheduler entry. A `run-hidden.vbs` already exists from upstream.
4. Plugin hooks (`plugins/claude-code`, `plugins/codex`): check that hook-forward runs under Windows Claude Code and Codex.

**Launcher mode (v1.0 if feasible, v1.1 at the latest):**

5. `rk claude` / `rk codex` on ConPTY (node-pty): raw mode, the takeover keys (Esc, Ctrl-C), terminal restore without `stty`, and signal handling (no SIGHUP/SIGUSR2). Re-prove the never-type-over-a-draft safety rules.

**Tests:**

6. Add a GitHub Actions `windows-latest` job for agentd tests.

## Hard rules (unchanged)
- Never type `/model` into a real `claude`: it rewrites the user's default model.
- Never edit the user's `~/.claude` or `~/.codex` config. Tests use temp state dirs, never the real `~/.rokid-coder`.
- Never touch `local.properties`.
- Commits are imperative, with no AI attribution or Co-Authored-By (repo AGENTS.md).
- Never print the pairing line, token, steer secret or full fingerprints into a Claude/Codex session.
- Usage budget is tight: tiny prompts and cheap models in live tests.
