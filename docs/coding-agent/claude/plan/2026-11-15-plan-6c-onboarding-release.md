# Rokid-Coder Plan 6c: Phone onboarding, service, release, docs Implementation Plan (DRAFT: split from Plan 6 rev 2; NOT yet Codex-READY)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The single phone app's onboarding, the background service and voice, release CI and versions, the docs, privacy note and device checklist, then the user's hardware gate.

**Depends on:** Plan 6a merged (`:mobile:app`, `HubCore`, `GlassesSurface`, the glasses install API, SAS). Plan 6b merged before T10's release run (installer artifacts).

**Spec:** `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md`. Later sections override earlier ones. Also read `docs/coding-agent/HANDOFF.md`. The original combined plan and its reviews: `2026-11-15-plan-6-v1.md`, and `docs/coding-agent/codex/reviews/2026-11-15-plan-6-*`.

**Status:** this is a DRAFT. Before execution:
1. Revise it to resolve every item in "Open findings to resolve".
2. Get a Codex sol review until READY (U14).
3. Execute with parallel tasks and one Codex review at the end (U15).

## Global Constraints

**Branch and commits**
- Branch `release/1.0.0`. Within a wave, tasks run in parallel worktrees, and ONLY on the files the ownership table gives them (U15).
- After the last wave: ONE Codex sol review, one fix wave, then a Codex re-check.
- Commits are imperative, with NO Co-Authored-By and no AI attribution. Tasks never push; the controller does.

**Never touch**
- `local.properties`. Never create a private SDK, Gradle home or cache in the tree. On an environment failure, stop and report.
- `~/.claude`, `~/.codex`, or the real `~/.rokid-coder`. Tests use temp state dirs. Never type `/model` into a real `claude`. No adb on the user's devices.
- Never print a token, `steer`, the pairing line, a full fingerprint, or SAS nonces into Claude/Codex session output, or into logs above debug.

**Identity and versions**
- Application ids: `io.github.debasishdebs.rokidcoder` (phone) and `io.github.debasishdebs.rokidcoder.glasses`. Kotlin class namespaces may stay `com.anezium.rokidbus.*`.
- Display names: "Rokid Coder" and "Rokid Coder Glasses".
- Version 1.0.0 everywhere. Android versionCode `10000`.
- The release key is NEW, so this is a fresh install (U16).
- Signing env vars stay `NEXUS_RELEASE_KEYSTORE`, `NEXUS_RELEASE_KEYSTORE_PASSWORD`, `NEXUS_RELEASE_KEY_ALIAS`.

**Runtimes and sources**
- Node 22 LTS, pinned to an exact patch version in `computer/runtime/node-version.txt`. Hooks, the LaunchAgent and the scheduled task call `rokid-node`, never bare `node`.
- CxrGlobal is the sibling `<repoRoot>/../CxrGlobal`, pinned at v0.3.0's SHA. `cxr-service-bridge` is pinned to `1.0-20260522.063600-105`. The upstream base SHA is `15cd98ad`.

**Security (U8, R1′, R12′)**
- Pinned mutual TLS on every computer↔phone link. Every NEW pairing passes the SAS code check, on every path, including the QR/pairing-line fallback `[CR 2]`.
- Nexus `SppAuthProtocol`, authenticated enrollment and frame replay protection are untouched.

**Suites**
The parity gate compares test identities AND outcomes, not just counts `[CR 6]`:
- `cd computer && npm test`
- `./gradlew :mobile:app:testDebugUnitTest :glasses-app:testDebugUnitTest :phone-core:testDebugUnitTest :shared:test :bus-client:testDebugUnitTest :ink-engine:test :glasses-hub:testDebugUnitTest`
- Only the 2 known `GlassesFileStoreTest` failures are allowed. They are recorded by name.


## Open findings to resolve (from `docs/coding-agent/codex/reviews/2026-11-15-plan-6-full-rereview.md`)
- **#8: service integration ownership.** T4 must own:
  - removing the existing Agents service
  - rewiring its callers
  - activity-lifecycle integration (app open and notification tap promote the microphone)
  - boot and Stop persistence

  Its tests must exercise those callers.
- **#5, consumer side:** T5 consumes 6a's verified local-file glasses install API (`GlassesAppInstaller`), with its installed-version query, cancellation and result callbacks. Don't re-implement verification.
- **#16, consumer side:** T10's upstream-sync Action follows 6a's chosen patch-maintenance strategy (merge-based, with conflict → issue).
- **Release gates:** T10 publishes only after 6b's installer jobs AND T13 pass.

## Tasks (carried over from Plan 6 rev 2; revise them per the findings above)

### Task 4: One foreground service, the microphone only where Android allows (R9, R9′)

**Files:** `mobile/app/**/service/**`, the service and receiver manifest entries.

**Interfaces:**
- **Produces:**
  - `CoderService` (`connectedDevice|microphone`), with `startFromForeground(context)` and `startFromBoot(context)` (`connectedDevice` only)
  - `StateFlow<VoiceAvailability>` with `AVAILABLE`, `NEEDS_APP_OPEN`, `PERMISSION_DENIED`
  - a "Stop" notification action
  - upstream promotion-failure handling kept (`BusHubService.kt:4893-4945`, now inside `HubCore`)

- [ ] **Step 1: Write the failing tests:**
  - `boot_start_never_requests_microphone_type`
  - `voice_needs_app_open_after_boot_and_pointer_shown`
  - `promotion_failure_shows_pointer_not_silence`
  - `stop_action_stops_until_app_opened`
  - `denied_mic_permission_shows_grant_pointer`
- [ ] **Step 2:** Implement, folding in the old `specialUse` service.
- [ ] **Step 3:** Green. Commit `One foreground service with voice started only where Android allows`.

### Task 5: Phone onboarding, bundled glasses install, coexistence, Tailscale connector (§2, §13, R7, R8, U38, U39) `[CR 11]`

**Files:** `mobile/app/**/onboarding/**`, the generated assets, and the manifest `<queries>` (`com.anezium.rokidbus.phone`, `com.tailscale.ipn`).

**Interfaces:**
- **Consumes:**
  - T3 `GlassesSurface`
  - T4 `VoiceAvailability`
  - T6 `SasPairing`, the phone-side UI hooks `onSasCode(code)` → `confirm(ok)`
  - T6 `pair-ready` handling
  - T12's glasses application id and constants
- **Produces:**
  - `enum OnboardingStep { WELCOME, PERMISSIONS, GLASSES, COMPUTER_CHECKLIST, FINISH_ON_COMPUTER, PAIRING, LAPTOP_DONE, TEST_ALERT, SOUNDS, DONE }`, persisted
  - `GlassesInstaller.state` with `NOT_INSTALLED`, `UP_TO_DATE`, `UPDATE_AVAILABLE`, `NEWER_ON_GLASSES`, `INSTALLING`, `FAILED(reason)`
  - `assets/glasses.apk` plus `assets/glasses.json` (package, versionCode, sha256, signerSha256), generated by a Gradle task from `:glasses-app`'s release output
  - **The R8 finding** in the report: does the CXR push need `REQUEST_INSTALL_PACKAGES`?

**Copy (verbatim):**
- Coexistence: `"Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry."`
- `"Finish on your computer"`
- `"Time's up — tap to try again"`
- `"Ready to pair — tap to open the window"`
- Tailscale states: `"Not installed"` / `"Installed — open Tailscale to check it's connected"` / `"Connected"` (only after a tailnet link)
- On FINISH_ON_COMPUTER, the unsigned-installer hint and the download page link (U32), `[CR 11]`:
  - macOS: `"right-click → Open"`
  - Windows: `"More info → Run anyway"`

- [ ] **Step 1: Write the failing tests:**
  - `onboarding_resumes_at_first_incomplete_step_after_process_death`
  - `permissions_step_explains_each_permission_and_continues_on_deny_with_pointer`
  - `glasses_step_installs_bundled_apk_after_verification`
  - `newer_on_glasses_is_left_with_warning`
  - `pairing_window_opens_on_pair_ready_or_button_not_earlier`
  - `pairing_check_offers_tailscale_and_qr_when_unreachable`
  - `laptop_done_advances_on_first_secure_link`
  - `upstream_nexus_installed_shows_stop_hub_and_retry`
  - `tailscale_status_never_claims_connected_without_a_tailnet_link`
  - `sas_code_shown_and_confirm_required_before_done`
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Green. Commit `Guided onboarding with bundled glasses install, coexistence and the Tailscale connector`.

### Task 10: Versions, signing, release CI, upstream sync (§3.6–3.8) `[CR 4, CR 10]`

**Files:** see the ownership table. This task runs after T5, T7b, T8 and T12.

**Interfaces:**
- **Versions:** 1.0.0 and versionCode 10000 everywhere.
- **Glasses-signer pin:** `glassesApkSignerSha256` is derived from the release key's cert. The release build fails if the pin and the cert differ.
- **`release.yml`** on tag `rokid-coder-v*`. Each artifact is built on its own platform job:
  - signed APK + AAB (ubuntu)
  - pkgs + dmg (macos, both architectures)
  - exe (windows)
  - every artifact's install job is re-run before the GitHub Release is published as a **draft**
  - publication waits for T13
- **`upstream-sync.yml`:** weekly `git subtree pull --prefix=vendor/nexus upstream main --squash`, then all suites, then a PR only if they pass. If a patch from `PATCHES.md` no longer applies, it opens an issue instead.
- **`tests.yml`:** a macos, ubuntu and windows matrix, plus the emulator job.
- **The R8 result from T5:** if `REQUEST_INSTALL_PACKAGES` is not needed, T3's manifest check rejects it.

- [ ] **Step 1: Write the failing checks:**
  - `glasses_signer_pin_matches_release_key`
  - the release workflow on a test tag produces every artifact and its install job passes (a real run, not lint)
  - `upstream_sync_opens_pr_only_when_suites_pass`, tested on a fork branch with a synthetic upstream commit
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit `Release 1.0.0 identity, signing and CI, plus a weekly upstream sync`.

### Task 11: Privacy note, READMEs, About screen, device checklist (R10, R11) `[CR 11]`

**Files:** see the ownership table.

- [ ] **Step 1: `PRIVACY.md` and the in-app About screen** (`mobile/app/**/about/**`) say, in substance (R11):
  - Rokid-Coder runs no servers and collects nothing.
  - Data leaves your devices only through services you already use:
    - the Claude/Anthropic and Codex/OpenAI CLIs
    - your Android speech engine, which may be online
    - Tailscale, if you choose it

  Test: `about_screen_links_privacy_note`.
- [ ] **Step 2: The per-folder READMEs** give install steps only, including the unsigned-installer step (U32) and Tailscale as optional.
- [ ] **Step 3: The device checklist,** `docs/coding-agent/claude/plan/2026-11-15-v1-device-checklist.md`, rewritten for the single app. It must cover R10's list for BOTH CLIs on macOS AND Windows (WSL), plus SAS mismatch, coexistence, the Tailscale connector and the R191 chime. Every item has a result column.
- [ ] **Step 4:** Grep the docs for secrets and full fingerprints; there must be none. Commit `docs: 1.0 privacy note, per-folder install guides and the device checklist`.

### Task 13: The hardware gate (the user runs it) `[CR 11]`
- The user runs the T11 checklist on their glasses and phone, with one macOS and one Windows 11 (WSL) computer, using Claude Code and Codex.
- The draft GitHub Release from T10 is published only when every required item passes. Failures go into a fix wave and the affected items are re-run.
- `ROKID_RK_WINDOWS_VERIFIED` comes from this run. If it's unset, 1.0 ships with the Windows launcher hint (U33).
