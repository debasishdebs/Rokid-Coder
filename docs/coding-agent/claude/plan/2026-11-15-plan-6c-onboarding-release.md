# Rokid-Coder Plan 6c: Phone onboarding, the foreground service and voice, release CI, docs, and the hardware gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the 1.0 product on top of Plan 6a's foundation:
- one foreground service in the phone app, with the microphone only where Android allows it (R9, R9′)
- the guided phone onboarding of §2: permissions, the bundled glasses install, coexistence with upstream Nexus, the computer checklist, SAS pairing, "laptop done", the test alert and sounds, and the Tailscale connector (U38, U39, §13)
- versions 1.0.0, our release signing, release CI that builds and install-tests every artifact into a DRAFT release, and the weekly upstream sync Action
- the privacy note, the About screen, per-folder install READMEs and the single-app device checklist
- the user's hardware gate (T13), which alone unlocks publishing

**Architecture:**
- **`CoderService`** is the app's only service. It hosts `HubCore` (6a T2) and the Agents runtime (`AgentsCore` plus the agentd transports that `AgentsMonitorService` hosts today). Everything else in the app reaches it through an in-process handle, never through service intents.
- **Onboarding** is a persisted state machine in `:mobile:app`. It drives existing producers: `HubCore.glassesInstaller` (6a), `PairingAttempts` (6a T6), the secure-link signal, and the alert path. It re-implements none of them.
- **Release** is tag-driven: an `rc` tag builds and install-tests every artifact into a draft prerelease. After T13 passes on exactly those bytes, a gated, manual `publish-release` workflow promotes them to the final `rokid-coder-v1.0.0` release.

**Tech Stack:** Kotlin (AGP 9.2, JDK 17, Compose, Robolectric), Gradle tasks with apksig, Node 22 (`node --test`) for repo scripts, GitHub Actions (ubuntu, macos, windows, an Android emulator job).

**Depends on:**
- Plan 6a merged: `:mobile:app`, `HubCore`, `GlassesSurface`, `GlassesAppInstaller`, `PairingAttempts` / `PairingRecord`, the injected `AppIdentity`, `scripts/upstream-sync.sh`, `checkReleaseManifest` and the dex checks.
- Plan 6b merged before wave 3 (T10 consumes its installer artifacts and their install jobs). Waves 1–2 may run in parallel with 6b.

**Spec:** `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md` (§13 > §12 > §11 > §10 > §8 > §1–7) and `docs/coding-agent/HANDOFF.md`. The behaviour contract of `2026-11-14-rokid-coder-design.md` §3 and §12 still applies.

**Review history:** split from the combined Plan 6 (`2026-11-15-plan-6-v1.md`; reviews `docs/coding-agent/codex/reviews/2026-11-15-plan-6-*`). This plan resolves the items of the full re-review (`…plan-6-full-rereview.md`) that 6c owns:
- `[FR 8]` service integration ownership
- `[FR 5]` the consumer side of the glasses install API
- `[FR 16]` the consumer side of the upstream sync
- `[FR gate]` publication waits for 6b's installer jobs AND T13

It also keeps the combined review's `[CR 10]` (checks that prove their claims: real platform runs, not lint) and `[CR 11]` (product and release gates assigned and enforced). Plan 6c's own reviews: `docs/coding-agent/codex/reviews/2026-11-15-plan-6c-review-<n>.md`.

## Global Constraints

**Branch and commits**
- Branch `release/1.0.0`. Within a wave, tasks run in parallel worktrees, each touching ONLY the paths the ownership table gives it (U15). A later wave may edit an earlier wave's paths.
- After the last code wave (wave 3): ONE Codex sol review of the 6c diff, one fix wave, then a Codex re-check.
- Commits are imperative, with NO Co-Authored-By and no AI attribution. Tasks never push and never create tags; the controller does. Steps marked **(controller)** run only after the controller pushes.

**Never touch**
- `local.properties` and the build environment. Never create a private SDK, Gradle home or cache in the tree. On an environment failure, stop and report.
- `~/.claude`, `~/.codex`, or the real `~/.rokid-coder` / `~/.nexus-agentd`. Tests use temp state dirs. Never type `/model` into a real `claude`. No adb on the user's devices (an emulator in CI is fine).
- Never write a token, `steer`, a full fingerprint, SAS nonces, `pair_credentials` contents or a pairing line to Claude/Codex session output or to ANY log level, including debug and exception paths (6a's rule).
- No task creates, reads or prints the release keystore or its passwords. Tests that need a key generate a throwaway one in a temp dir.

**Identity and versions**
- Application ids `io.github.debasishdebs.rokidcoder` (phone) and `io.github.debasishdebs.rokidcoder.glasses`, both supplied through 6a's injected `AppIdentity`. Kotlin namespaces stay `com.anezium.rokidbus.*`.
- Display names "Rokid Coder" and "Rokid Coder Glasses".
- Our artifacts are version 1.0.0, with Android versionCode `10000`. The vendored upstream shells (`:phone-hub`, `:glasses-hub`) keep upstream's versions; they are not shipped.
- The release key is NEW, so this is a fresh install (U16). One key signs both APKs. The signing env vars stay `NEXUS_RELEASE_KEYSTORE`, `NEXUS_RELEASE_KEYSTORE_PASSWORD`, `NEXUS_RELEASE_KEY_ALIAS` (PKCS12, key password = store password, as `gradle/plugin-release-signing.gradle` does today).

**Pins:** CxrGlobal is `<repoRoot>/../CxrGlobal` at v0.3.0's SHA (CI checks it out by SHA, not by tag). `cxr-service-bridge` is `1.0-20260522.063600-105`. The upstream base is `15cd98ad`.

**Security (U8, R1′, R12′)**
- Pinned mutual TLS on every computer↔phone link. Every NEW pairing is SAS-confirmed by a human on the phone, on every path, including the QR / pairing-line fallback. Onboarding only displays and forwards 6a's SAS state; it never confirms on its own.
- Nexus `SppAuthProtocol`, authenticated enrollment and replay protection are untouched.

**Suites**
- Every task ends green on the product suite list frozen by 6a T1 (`.superpowers/sdd/plan-6a/suites.txt`, as 6a's later tasks extended it), plus `node --test scripts/test` and 6b's suites once merged.
- Only the 2 known `GlassesFileStoreTest` failures are allowed, by name. The upstream shells keep building and passing.

## Waves and file ownership

Paths are after 6a: the former `plugins/agents` sources live in `:mobile:app` (`mobile/app/src/main/java/com/anezium/rokidbus/plugin/agents/…`, written below as `mobile/app/**/X.kt`).

| Wave | Task | Owns |
|---|---|---|
| 1 | **T4** one foreground service `[FR 8]` | create `mobile/app/**/service/**` (`CoderService`, `CoderRuntime`, `CoderBootReceiver`, `VoiceAvailability`, `ServicePrefs`, `CoderNotifications`, `ForegroundStarter`); delete `mobile/app/**/{AgentsMonitorService,AgentNotifications}.kt`; caller rewiring ONLY in `mobile/app/**/{AgentsSettingsActivity,ProjectPickerActivity,ComputerActivity,NewThreadActivity,AddComputerActivity,AgentsCore,GuidedPairing}.kt`; `mobile/app/**/RokidCoderApp.kt` (the process-lifecycle observer only); in `mobile/app/src/main/AndroidManifest.xml` the `<service>` and `<receiver>` entries and the foreground-service, boot and `RECORD_AUDIO` `<uses-permission>`s; the foreground seam in `vendor/nexus/phone-core/**` and its use in `vendor/nexus/phone-hub/**` (one recorded patch, plus its `vendor/nexus/PATCHES.md` row); tests `mobile/app/src/test/**/service/**`, `mobile/app/src/androidTest/**/service/**`; one step in `.github/workflows/emulator.yml` |
| 2 | **T5** onboarding, glasses install, coexistence, Tailscale | create `mobile/app/**/onboarding/**`, `mobile/app/**/connectors/**`; `mobile/app/**/MainActivity.kt` (the launcher router); create the included build `build-logic/**` (the `rokid.glasses-asset` plugin and its unit and TestKit tests) and the one `includeBuild("build-logic")` line in the root `settings.gradle.kts` `pluginManagement`; in `mobile/app/build.gradle.kts` the plugin application, its variant wiring and the `GLASSES_SIGNER_SHA256` BuildConfig field; in `glasses/app/build.gradle.kts` the outgoing `glassesApk` configuration only; in the manifest the `<queries>`, the onboarding and router activity entries and the launcher intent-filter; `AgentSessionStore.kt` (the `announceSecureConnection` / `announceSecureLinkClosed` signatures and the new `activeSecureLinks` state) plus their call sites in `AgentdClient.kt`, `AgentdLinkServer.kt` and `service/CoderService.kt` (clear on Stop); the Connectors row in `AgentsSettingsActivity.kt`; one `raiseLocalTestAlert` entry in `AlertCoordinator.kt`; the autostart predicate line in `RokidCoderApp.kt`; `docs/coding-agent/claude/design/r8-install-permission.md`; tests `mobile/app/src/test/**/{onboarding,connectors}/**` and `mobile/app/src/androidTest/**/onboarding/**` |
| 3 | **T10** versions, signing, release CI, upstream sync `[FR 16, FR gate]` | `.github/workflows/{release,publish-release,upstream-sync,tests}.yml`; the `on: workflow_call` trigger, a `ref` input and the checkouts that use it in `.github/workflows/emulator.yml`, `.github/workflows/upstream-validation.yml` and 6b's installer and Windows-test workflows; deleting the root upstream release workflows (`app-release.yml`, `plugin-release.yml`, `sdk-release.yml`, `sdk.yml`, `pages.yml`) if 6a left them; `scripts/{check-versions,release-gate,publish-release,upstream-sync-decide}.mjs`, `scripts/{release-assets.txt,checklist-required.json}`, `scripts/test/{versions,release-gate,publish,upstream-sync}*.test.mjs`; the `--remote`/`--ref` arguments and the `MERGE_SHA` output of `scripts/upstream-sync.sh` (6a's script) and its test cases; the `rokid.release-signing` plugin in `build-logic/**` and its tests; in `gradle.properties` the keys `rokid.versionName`, `rokid.versionCode`, `rokid.releaseSignerSha256`; the version and signing lines of `mobile/app/build.gradle.kts` and `glasses/app/build.gradle.kts`; the `version` fields of `computer/package.json`, `plugin/claude-code/.claude-plugin/plugin.json`, `plugin/codex/.codex-plugin/plugin.json` and the two marketplace files; the `CLIENT_VERSION` line of `computer/src/codex/monitor.ts` |
| 3 | **T11** privacy, About, READMEs, checklist `[CR 11]` | `PRIVACY.md`; `README.md` and `{computer,plugin,mobile,glasses}/README.md`; create `mobile/app/**/about/**` and `mobile/app/src/main/res/values/strings_about.xml`; the About row in `AgentsSettingsActivity.kt`; the `AboutActivity` manifest entry; `docs/coding-agent/claude/plan/2026-11-15-v1-device-checklist.md`; `docs/coding-agent/releases/1.0.0.md`; `scripts/check-docs-secrets.mjs` and `scripts/test/docs-secrets.test.mjs`; tests `mobile/app/src/test/**/about/**` |
| 4 | **T13** hardware gate `[FR gate]` | none in code (the user runs it); the results go into the T11 checklist |

T4 and T5 both edit the manifest, `AgentsSettingsActivity.kt` and `RokidCoderApp.kt`, so they are serial (wave 1, then 2). In wave 3, T10 and T11 share no file: T10 owns the version, signing and workflow lines, and T11 owns the docs, About and checklist. T10's release gate parses T11's checklist through the format contract and the required-row IDs fixed in T11 Step 4 (not through shared code); T10 writes those IDs into `scripts/checklist-required.json`.

## Review Focus
1. **The phone reboots, then the user presses push-to-talk on the glasses before opening the app.** Expected: the boot start used `connectedDevice` only. Voice shows "Open Rokid Coder once to turn on voice" on the glasses and in the notification, with no crash and no silent failure. After the app is opened once, push-to-talk works. Tests: T4 `boot_start_never_requests_microphone_type`, `voice_needs_app_open_after_boot_and_pointer_shown`, and the emulator `boot_receiver_starts_connected_device_only_on_device`.
2. **The user taps Stop in the notification, then reboots.** Expected: nothing starts at boot. Everything stays stopped until the app is opened, and then it starts with voice. Test: T4 `stop_survives_reboot_until_app_opened`.
3. **The app is killed while the pairing window is open.** Expected: onboarding resumes at FINISH_ON_COMPUTER, with no window open, nothing pinned, and the "Ready to pair" button shown. Tests: T5 `onboarding_resumes_at_first_incomplete_step_after_process_death` and `pairing_resumed_after_process_death_starts_at_finish_on_computer`.
4. **Upstream Rokid Nexus is installed and still holds the glasses link.** Expected: the Stop-hub guidance and Retry. Retry succeeds only when our CXR connect does; Nexus being installed is a warning, not a block. Tests: T5 `upstream_nexus_installed_shows_stop_hub_and_retry` and `coexistence_is_a_warning_cxr_connect_decides`.
5. **A release candidate is tagged before T13 has passed, or someone tries to publish other bytes than those tested.** Expected: only a draft prerelease exists. `publish-release` refuses unless every required row of the fixed schema is present and PASS for that rc lineage, the draft came from a fully successful `release.yml` run of that rc's commit, its SHA256SUMS match, and the 6a, 6b and 6c execution reviews are READY. Tests: T10 `release_gate_refuses_unless_every_required_item_passes` and `publish_promotes_exact_tested_artifacts`.

---

### Task 4: One foreground service, with the microphone only where Android allows (R9, R9′) `[FR 8]`

**Files:** see the ownership table. The existing service being replaced is today's `plugins/agents/…/AgentsMonitorService.kt` (`specialUse`, `agent-session-monitoring`). Its callers are:
- `AgentsSettingsActivity.kt:75,91,104,134-135,145,169`
- `ProjectPickerActivity.kt:166`
- `ComputerActivity.kt:74`
- `NewThreadActivity.kt:171`
- `AddComputerActivity.kt:98,112,368,371`
- `AgentNotifications.kt:71` (Stop)
- the former `AgentsPluginService.kt` (`AgentsCore` after 6a T3) at `:108,123,127,205,359,563,631,639,712,857,1170`
- `GuidedPairing.kt:121` (`openGuidedDoor`'s reconcile)

**Interfaces:**
- **Produces:**
  - `class CoderService : Service`, declared `android:exported="false"` with `android:foregroundServiceType="connectedDevice|microphone"`. It hosts `HubCore` (start/stop), `AgentsCore`, and everything `AgentsMonitorService` ran: the `AgentdClient` and `AgentdLinkServer` transports, the TTL tick, prune, the freeze-watch heartbeat, settings sync and the test link. Behaviour is unchanged, apart from what this task specifies.
  - `CoderService.startFromForeground(context)`: callable only while an activity of ours is started (it checks `ProcessLifecycleOwner` ≥ STARTED and is a no-op otherwise). It starts or promotes with `CONNECTED_DEVICE | MICROPHONE` when `RECORD_AUDIO` is granted, and `CONNECTED_DEVICE` only when it isn't. Every accepted call, whoever makes it, itself persists `everStartedFromForeground = true` and clears `stoppedByUser` (with `commit()`) before starting, so boot eligibility never depends on which caller started the service.
  - `CoderService.startFromBoot(context)`: `CONNECTED_DEVICE` only, never the microphone. A sticky restart (null intent) is treated the same way.
  - `CoderService.voice: StateFlow<VoiceAvailability>`, where `enum class VoiceAvailability { AVAILABLE, NEEDS_APP_OPEN, PERMISSION_DENIED }`.
  - `fun interface ForegroundStarter { fun start(id: Int, notification: Notification, types: Int) }`: the seam tests replace. In production it calls `ServiceCompat.startForeground`.
  - `object CoderRuntime`: the in-process command surface that replaces every `AgentsMonitorService` companion helper, with the same names and arguments: `reconcile()`, `openDetail(session)`, `closeDetail()`, `decideApproval(requestId, decision)`, `sendSessionInput(requestId, sessionId, text)`, `sendV2(frame)`, `requestFolders(requestId, path)`, `requestThreadStart(…)`, `forgetMachine(machineId)`, `pushSettings()`, `testLink(provider)`.
    - From an activity, `CoderRuntime.fromActivity(activity) { … }` calls `startFromForeground` if the service isn't running (allowed, because the activity is visible), then runs the command once the service is up.
    - Code that runs inside the service (`AgentsCore`, the transports) calls it directly.
    - Nothing in the app calls `startService` / `startForegroundService` except `CoderService.startFrom*`.
  - `CoderRuntime.ready: StateFlow<Boolean>`, true while the service is up with `HubCore` started. Onboarding awaits it before any CXR call.
  - `ServicePrefs`: `stoppedByUser: Boolean` and `everStartedFromForeground: Boolean`, written with `commit()` so they survive process death.
  - `CoderBootReceiver` (`exported="false"`, `BOOT_COMPLETED` and `MY_PACKAGE_REPLACED`). It calls `startFromBoot` only when `everStartedFromForeground && !stoppedByUser`. This is the same pure-policy shape as upstream's `HubStartupPolicy` (`HubStartupReceiver.kt:33-47`), and is tested the same way.
  - **The notification** (`CoderNotifications`, one low-importance channel, folding in the old "Agents monitoring" one):
    - It shows the link and session count.
    - On `NEEDS_APP_OPEN` it reads "Open Rokid Coder once to turn on voice"; on `PERMISSION_DENIED`, "Microphone is off — tap to grant".
    - Its content intent is `PendingIntent.getActivity` for the app's launch intent (`packageManager.getLaunchIntentForPackage`), never a service or receiver trampoline. The opened activity promotes the service through the lifecycle observer.
    - It has two actions: **Settings** (an activity), and **Stop** (`PendingIntent.getService` with `ACTION_STOP` to `CoderService` itself).
- **Lifecycle integration:** `RokidCoderApp` registers a `ProcessLifecycleOwner` observer.
  - On every app foreground (`ON_START`), including opening the app from the notification, it calls `startFromForeground` (which clears `stoppedByUser` and sets `everStartedFromForeground`).
  - It does this only when `CoderAppLifecycle.autoStartAllowed()` is true. That defaults to `{ true }`; T5 points it at onboarding.
  - A process `ON_START` happens only when the app comes to the foreground, not when screens change inside it. So any in-app transition that needs the service (T5's entry into GLASSES) calls `startFromForeground` itself, from its visible activity, and awaits `CoderRuntime.ready`.
- **Stop:**
  1. Set `stoppedByUser = true`.
  2. Stop `HubCore`, `AgentsCore` and the transports.
  3. `stopForeground(STOP_FOREGROUND_REMOVE)`, then `stopSelf()`. Return `START_NOT_STICKY`.

  The 0.8 behaviour of switching Monitoring off (`AgentsConfigStore.stopMonitoring()`, `AgentsMonitorService.kt:160-164`) is replaced: Stop no longer changes `agentdEnabled`, so opening the app restores exactly what ran before.
- **Voice and the upstream promotion handling (R9′)**, consumed from `HubCore`:
  - T4 adds the seam `HubCoreConfig.foreground: HubForegroundHost`, with `fun ensureMicrophone(): SttError?` and `fun releaseMicrophone()`. It is a recorded patch with a `PATCHES.md` row. If 6a's `adr-cores.md` already defines an equivalent seam, T4 uses that one instead, records the mapping in the patch row, and adds nothing.
  - `HubCore` calls the seam where upstream calls `requestSpeechMicrophoneForegroundOnMain` / `releaseSpeechMicrophoneForegroundOnMain` (`BusHubService.kt:4948-4957`).
  - The logic of `startForegroundWithType` (`BusHubService.kt:4893-4945`) moves, unchanged, into `phone-core`'s `ForegroundPromotion`. That logic is: try `startForeground` with the microphone type; on failure, log, fall back to connected-device, and return `SttError(SOURCE_UNAVAILABLE, …)`. The upstream shell's `BusHubService` and our `CoderService` both use `ForegroundPromotion`, so the upstream shell's suite stays identical.
  - **Two different things are kept apart:**
    - the service's microphone *entitlement*: the microphone type, acquired from a foreground start and held until Stop or service end
    - one STT session's *use* of the microphone

    `ForegroundPromotion` takes a policy `holdMicrophoneUntilStop: Boolean`. The upstream shell passes `false`, which keeps upstream's behaviour: release clears the request and drops the type again (`BusHubService.kt:4955-4959`, called from `AndroidSttSession.kt:616-618`). `CoderService` passes `true`.
  - In `CoderService`:
    - `ensureMicrophone()` returns null at once when the microphone type is held.
    - Otherwise it tries the promotion. A failure, including `ForegroundServiceStartNotAllowedException` or `SecurityException` from the background, sets `NEEDS_APP_OPEN` and returns the error.
    - `releaseMicrophone()` ends only the session's use. It never re-calls `startForeground` without the microphone type, so a second push-to-talk from the background needs no new promotion. That holds whether the session ends normally, is cancelled, or ends in an error.
    - `HubCore` turns an `ensureMicrophone()` error into the glasses notice "Open Rokid Coder once to turn on voice" through `GlassesSurface`. That covers the one path where the user tries voice while it is off. Never silence.
  - `RECORD_AUDIO` denied gives `PERMISSION_DENIED`, a "Grant" pointer in the notification and on the glasses, and connected-device only. When the app is next opened with the permission granted, the service promotes.
- **Battery:** the existing battery-exemption request (`AgentsUiBits.kt:46-52`) stays behind its explained setting. T5's permissions step uses it.

- [ ] **Step 1: Write the failing tests** (Robolectric with a fake `ForegroundStarter`, a fake `GlassesSurface` and a fake `HubCore` transport, unless marked otherwise):
  - `boot_start_never_requests_microphone_type`
  - `sticky_restart_is_treated_as_boot`
  - `boot_receiver_starts_only_after_a_foreground_start_and_never_when_stopped`
  - `first_start_from_any_caller_makes_boot_eligible`: fresh storage, the process `ON_START` rejected by `autoStartAllowed`, then a direct `startFromForeground` (as T5's GLASSES entry makes), then a simulated reboot with no reopen. Boot starts connected-device only.
  - `app_open_promotes_to_microphone_when_permission_granted`
  - `notification_tap_is_an_activity_intent_and_promotes_on_open`
  - `voice_needs_app_open_after_boot_and_pointer_shown`: the notification text, plus the glasses notice when push-to-talk is attempted
  - `promotion_failure_shows_pointer_not_silence`: the starter throws `SecurityException`; the service falls back to connected-device, `voice` is `NEEDS_APP_OPEN`, and the STT error reaches the glasses notice
  - `denied_mic_permission_shows_grant_pointer`
  - `stt_release_keeps_microphone_entitlement_in_product`: after a session ends normally, after a cancel, and after an STT error, the fake starter never receives a `startForeground` without the microphone type, and `voice` stays `AVAILABLE`
  - `upstream_policy_still_drops_microphone_on_release`: `ForegroundPromotion` with `holdMicrophoneUntilStop = false` behaves exactly as `BusHubService.kt:4955-4959` does today
  - `stop_action_stops_until_app_opened`
  - `stop_survives_reboot_until_app_opened`
  - `stop_keeps_monitoring_setting_unchanged`
  - `every_former_monitor_caller_reaches_coder_runtime`: one case per caller listed under **Files**, driving the real activity (Robolectric) or the `AgentsCore` entry point, and asserting that the fake runtime got the command with the same arguments
  - `activity_commands_start_the_service_when_stopped_then_run`
  - `no_service_start_outside_coder_service`: a source scan of `mobile/app/src/main` for `startService(` / `startForegroundService(` outside `service/`
  - `merged_manifest_declares_one_service_without_special_use`: exactly one `<service>` (ours, not exported, `connectedDevice|microphone`), no `FOREGROUND_SERVICE_SPECIAL_USE`, and no `AgentsMonitorService`
  - `upstream_shell_foreground_behaviour_unchanged`: the `:phone-hub` suite identities and outcomes are unchanged after the `ForegroundPromotion` extraction
  - emulator (`connectedAndroidTest` on a current API 35 `google_apis` image, plus a step in `emulator.yml`):
    - `boot_receiver_starts_connected_device_only_on_device`: on the rooted emulator image, broadcast `BOOT_COMPLETED` to our package, then assert from `dumpsys activity services` that the running service type is connected-device without the microphone.
    - `voice_survives_background_across_two_sessions_on_device`: open the app, then send it HOME. Run two complete push-to-talk sessions through the real STT pipeline, with deterministic PCM injected at the glasses-transport seam (the fake CXR transport that 6a T2's contract tests use). That PCM reaches the recognizer through `RecognizerIntent.EXTRA_AUDIO_SOURCE` (`SpeechSessionManager.kt:392`, `AndroidSttSession.kt:338`), the same path the glasses' audio takes.
      - The recognizer is a fake `RecognitionService` shipped in the androidTest APK. The job makes it the default with `settings put secure voice_recognition_service`. It reads the supplied audio pipe and returns a fixed final result once it has read the injected bytes.
      - A cancel and an STT error are injected between the two sessions.
      - Assert that both sessions reach their final result, and, separately, that `dumpsys activity services` shows the microphone type after backgrounding, after the cancel, after the error, and after each session.
      - Real speech-engine compatibility is T13 row `SPEECH`, not this test.
- [ ] **Step 2:** Implement: fold `AgentsMonitorService` into `CoderService`, rewire every caller, delete the old service and its manifest entry, and add the `ForegroundPromotion` seam patch.
- [ ] **Step 3:** Green on the full suite list and the emulator job. Commit `Run one foreground service and start voice only where Android allows it`.

### Task 5: Phone onboarding, the bundled glasses install, coexistence and the Tailscale connector (§2, §13, R7, R8, U38, U39) `[FR 5]` `[CR 11]`

**Files:** see the ownership table.

**Interfaces:**
- **Consumes:**
  - `CoderService` / `CoderRuntime` / `VoiceAvailability` (T4)
  - `GlassesSurface` (6a T3)
  - `HubCore.glassesInstaller: GlassesAppInstaller` (6a T2) `[FR 5]`: `install(apk, expected, onProgress): InstallResult`, `installedVersion(): Long?`, `cancel()`, `GlassesApkMetadata`
  - `PairingAttempts.state` / `confirm(attempt, ok)` and `PairingRecord` (6a T6)
  - 6a T6's `pair-ready` gate. The onboarding pairing screen registers through the same pairing-screen-visible hook that Add a computer uses; Step 1 records the exact symbol.
  - `AppIdentity.glassesApplicationId` (6a T12)
  - `CxrLAuth.requestAuthorization` (the Rokid authorization screen, as upstream `MainActivity.kt:1281` uses it). Its token goes to `HubCore`.
- **Produces:**
  - `enum OnboardingStep { WELCOME, PERMISSIONS, GLASSES, COMPUTER_CHECKLIST, FINISH_ON_COMPUTER, PAIRING, LAPTOP_DONE, TEST_ALERT, SOUNDS, DONE }`. Each step's completion is persisted with `commit()` in `OnboardingStore`.
  - `MainActivity` is the launcher. It routes to `OnboardingActivity` (at the first incomplete step) until DONE, and to the home screen (`AgentsSettingsActivity`) after.
  - `OnboardingStore.serviceAllowed()`, which T4's `CoderAppLifecycle.autoStartAllowed` points at. It is true from the GLASSES step on.
- **Step rules:**
  - **Resume:** open at the first incomplete step. FINISH_ON_COMPUTER and PAIRING are one screen with two states, and a window never survives the process, so a resumed PAIRING shows FINISH_ON_COMPUTER, with no window open.
  - **PERMISSIONS:** one screen each, with the reason, in this order:
    - Bluetooth / nearby devices: the runtime permissions in the merged manifest that `HubCore`'s CXR link needs
    - microphone
    - notifications (API 33+)
    - battery optimisation (the existing explained request)

    A denial continues, with the feature shown as off and a "Grant" pointer. The step is complete once each permission has been asked.
  - **GLASSES:**
    1. The coexistence check first (below).
    2. CXR authorization and connect.
    3. The glasses app state.

    On entering GLASSES (in the foreground, with no process `ON_START`), the screen calls `CoderService.startFromForeground` itself and awaits `CoderRuntime.ready` before any CXR call (T4's rule).

    A "Not now" goes on, but leaves GLASSES incomplete, so the next app open resumes there. DONE requires every step.
  - **COMPUTER_CHECKLIST:** "Which do you use? Claude Code / Codex / both / neither", persisted. It selects the copy and the test-alert provider. With "neither", the next screen says that `rk claude` / `rk codex` offer the install later.
  - **FINISH_ON_COMPUTER / PAIRING (§13.5):**
    - On first entry, before either pairing path can start, onboarding persists (with `commit()`) `OnboardingPairing{baselineMachineIds}`: the machine ids of every `PairingRecord` that exists then. Later entries and resumes reuse the persisted baseline; it is cleared only at DONE.
    - The screen registers as a pairing screen while it is started.
    - The window opens ONLY on a 6a `pair-ready` announcement or the "Ready to pair — tap to open the window" button, through `openGuidedDoor` (rewired by T4). Entering the screen does not open it.
    - An expired window shows "Time's up — tap to try again".
    - An expiry with no peer seen, or the "Use it away from home" link, offers the Tailscale connector and "Scan the code on your computer instead", which opens 6a's Add a computer scan. SAS still applies there.
  - **SAS:** while `PairingAttempts.state` has a `code`, the screen shows "Does your computer show 123 456?" with **Codes match** and **Codes don't match**. They call `PairingAttempts.confirm(attempt, ok)`, from on-device touch only.
    - On ABORTED, the screen shows "Nothing was paired — tap to try again", with the reason for a mismatch or a second device.
  - **LAPTOP_DONE (§2.6):** completes as soon as `AgentsRuntime.activeSecureLinks` holds a link whose machine id is absent from the persisted baseline, from either the window path or the QR path. It shows "Paired with <name> ✓".
    - Because the baseline is persisted before pairing and the rule reads current state (not a one-shot event), a crash at any point still completes. If the process dies after the credentials became durable but before onboarding recorded the step, the resumed screen completes on that computer's next authenticated reconnect, because its machine id is still not in the baseline.
    - `activeSecureLinks: StateFlow<Map<LinkKey, SecureLink>>`, where `LinkKey(transport, connectionId)` and `SecureLink(machineId, name, remoteAddress)`.
      - An entry is added only by `announceSecureConnection`, which is fed only by a secure `hello_ack` and a secure inbound bind (`AgentSessionStore.kt:568-576`). T5 adds `transport`, `connectionId` and `remoteAddress` to that signature and passes them from `AgentdClient` and `AgentdLinkServer`.
      - An entry is removed by the new `announceSecureLinkClosed(key)`, called on every close or failure of that connection in both transports.
      - The map is cleared on Stop and in `CoderService.onDestroy`.
      - A late subscriber reads the current map, so nothing is missed.
  - **TEST_ALERT:** `AlertCoordinator.raiseLocalTestAlert(provider)` raises a local Done-kind alert ("Test alert — Rokid Coder is set up") through the same path real alerts take, so the user's sound for that kind applies. It never goes through agentd. The step offers "I saw it" and "I didn't see it"; the latter shows the glasses-connection pointer, then continues.
  - **SOUNDS:** the existing per-kind sound settings (U1), embedded. Then DONE.
- **Coexistence (§13.3):**
  - `<queries>` declares `com.anezium.rokidbus.phone` (see the allowlist below).
  - When that package is installed, the screen shows, verbatim: `"Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry."`
  - Buttons: **Open Rokid Nexus** (its launch intent), **App info** (`Settings.ACTION_APPLICATION_DETAILS_SETTINGS` for that package, where force-stop and uninstall are; so no `REQUEST_DELETE_PACKAGES` is needed), and **Retry**.
  - Retry attempts the CXR connect. Success continues even if Nexus is still installed.
- **The bundled glasses app (R7)** `[FR 5]`:
  - The `generateGlassesAsset` task (from the `rokid.glasses-asset` plugin in the included build `build-logic/`, applied by `mobile/app/build.gradle.kts`) consumes `:glasses-app`'s per-variant APK through the outgoing `glassesApk` configuration (not a cross-project task path). It writes `glasses.apk` plus `glasses.json` `{packageName, versionCode, sha256, signerSha256}`, computed with apksig, into `build/generated/glassesAsset/<variant>/`. This directory is registered with `variant.sources.assets.addGeneratedSourceDirectory`; nothing is committed under `src/main/assets`.
  - **Release:** the task fails if the APK's signer differs from `rokid.releaseSignerSha256`. That property is a placeholder until T10 sets it, so T5 tests the check with a throwaway key. The phone's expected signer is `BuildConfig.GLASSES_SIGNER_SHA256` (that pin), never the json's value.
  - **Debug:** the expected signer is the json's value, documented as "not a pin".
  - The apksig metadata reading and the pin comparison live in `build-logic` as plain functions with unit tests. The task itself has TestKit functional tests. Both run with `./gradlew -p build-logic test`, which T5 adds to the suite list.
  - `GlassesInstallController`:
    - It copies the asset to `noBackupFilesDir/glasses/` and calls `glassesInstaller.install(file, expected, onProgress)`, where `expected = GlassesApkMetadata(AppIdentity.glassesApplicationId, json.versionCode, json.sha256, pinnedSigner)`.
    - It deletes the copy afterwards.
    - Verification (package, version, digest, signer) is the core's, so onboarding imports no apksig.
    - It calls `cancel()` when the user leaves the step mid-install.
  - **State** `GlassesInstallState`, from `installedVersion()` against the bundled versionCode: `NOT_INSTALLED` (null), `UPDATE_AVAILABLE` (older), `UP_TO_DATE`, `NEWER_ON_GLASSES` (left alone, with a warning), `INSTALLING(progress)`, `FAILED(reason)` (a visible error and Retry).
  - **Result mapping:**

    | `InstallResult` | State |
    |---|---|
    | `Installed`, `AlreadyCurrent` | `UP_TO_DATE` |
    | `NewerOnGlasses` | `NEWER_ON_GLASSES` |
    | `Cancelled` | the state before the install |
    | `Failed(r)` | `FAILED(r)` |

    The step is complete on `UP_TO_DATE` or `NEWER_ON_GLASSES`. The same controller backs a "Glasses app" row on the home screen, for later updates.
- **The Tailscale connector (U38, §13.2)**, in Settings → Connectors → Tailscale and in the pairing fallback:
  - The status is a pure function `tailscaleStatus(installed, activeSecureLinks.value)`:
    - `"Not installed"`
    - `"Installed — open Tailscale to check it's connected"`
    - `"Connected"`, ONLY while a secure link's `remoteAddress` is in `100.64.0.0/10` or `fd7a:115c:a1e0::/48`
  - Detection uses the `<queries>` package `com.tailscale.ipn`.
  - Steps: "Get Tailscale" (`market://details?id=com.tailscale.ipn`, falling back to https), then "Sign in with the same account on your computer".
- **The `<queries>` allowlist.** `merged_manifest_queries_match_allowlist` checks the release merged manifest, in both directions, against exactly:
  - kept from upstream for the core (`phone-hub/src/main/AndroidManifest.xml:33-52`):
    - the Hi Rokid package `com.rokid.sprite.global.aiapp`, which `CxrLAuth.isGlobalHiRokidInstalled` needs (`CxrLAuth.kt:25-35`)
    - the intents `com.rokid.sprite.aiapp.externalapp.AUTHORIZATION` and `…MEDIA_STREAM_SERVICE`
    - `android.intent.action.TTS_SERVICE`
    - `android.speech.RecognitionService`, if the core's Android recognizer discovers services by intent (T5 checks and records which)
  - ours: `com.anezium.rokidbus.phone` (coexistence) and `com.tailscale.ipn`

  It must reject the plugin and host actions (`com.anezium.rokidbus.action.{PLUGIN,CLIENT,HUB}`) and the Patcher and Morphe packages.
- **Download copy (U32)** on FINISH_ON_COMPUTER, verbatim:
  - `"Finish on your computer"`
  - the link `https://github.com/debasishdebs/Rokid-Coder/releases/latest`, with Copy and Share
  - a macOS / Windows switch. macOS: `"right-click → Open"`. Windows: `"More info → Run anyway"`, plus "Windows needs WSL 2 — the installer checks it for you".
  - also the strings `"Time's up — tap to try again"` and `"Ready to pair — tap to open the window"`
- **The R8 finding** `[CR 11]`: T5 writes `docs/coding-agent/claude/design/r8-install-permission.md`. The evidence:
  - The CXR path is `appUploadAndInstall` (`BusHubService.kt:4453`, in core after 6a): the phone uploads, and the install happens on the glasses.
  - The release merged manifest has no `REQUEST_INSTALL_PACKAGES`. If a library contributes it, `tools:node="remove"` removes it.
  - The release dex has no `PackageInstaller` / `ACTION_INSTALL_PACKAGE` use outside excluded code.

  The conclusion is "not needed", to be confirmed by T13 row `GLS-INSTALL`. Then 6a's `checkReleaseManifest` keeps rejecting the permission. If T13 disproves it, the fix wave adds the permission and the single allowance `checkReleaseManifest` reads, and the file records it as the Play blocker (R8).

- [ ] **Step 1: Write the failing tests** (Robolectric, with fakes for `GlassesAppInstaller`, `PairingAttempts`, `HubCore`'s link and `CxrLAuth`):
  - `onboarding_resumes_at_first_incomplete_step_after_process_death`
  - `pairing_resumed_after_process_death_starts_at_finish_on_computer`
  - `permissions_step_explains_each_permission_and_continues_on_deny_with_pointer`
  - `glasses_step_installs_bundled_apk_after_verification`: the fake installer receives the copied file and exactly the pinned `GlassesApkMetadata`
  - `onboarding_never_verifies_apks_itself`: a source and dependency scan, with no apksig in `onboarding/**`
  - `install_states_follow_installed_version_and_results`, with one case per row of the mapping
  - `newer_on_glasses_is_left_with_warning`
  - `failed_install_shows_error_and_retry`
  - `leaving_mid_install_cancels`
  - `bundled_asset_metadata_matches_built_glasses_apk` (`build-logic`, a TestKit test on a fixture APK)
  - `release_asset_generation_fails_on_signer_pin_mismatch` (`build-logic`, a throwaway key)
  - `release_variant_pins_signer_from_properties_not_asset`
  - `glasses_step_starts_service_without_backgrounding`: WELCOME → PERMISSIONS → GLASSES in one foreground session. `startFromForeground` is called, and no CXR call happens before `ready`.
  - `upstream_nexus_installed_shows_stop_hub_and_retry`
  - `coexistence_is_a_warning_cxr_connect_decides`
  - `pairing_window_opens_on_pair_ready_or_button_not_earlier`
  - `expired_window_shows_times_up_and_retries`
  - `pairing_check_offers_tailscale_and_qr_when_unreachable`
  - `sas_code_shown_and_confirm_required_before_done`
  - `sas_mismatch_pairs_nothing_and_offers_retry`
  - `laptop_done_advances_on_first_secure_link`, for both the window path and a direct QR entry with no window, and never on an insecure or baseline machine
  - `laptop_done_survives_crash_between_pairing_and_step_record`: process death after `pair_committed` but before the secure link; and process death after the secure link but before the step commit. Both complete on the resumed screen's next authenticated reconnect.
  - `active_secure_links_track_open_links`: a late subscriber sees the current links; a disconnect removes its entry; a reconnect adds a new one; simultaneous LAN and tailnet links are both kept; Stop clears them
  - `tailscale_status_never_claims_connected_without_a_tailnet_link`, including a tailnet link that has closed
  - `test_alert_uses_the_real_alert_path_and_kind_sound`
  - `finish_on_computer_shows_link_and_unsigned_installer_hint_per_os`
  - `merged_manifest_queries_match_allowlist`
  - `release_manifest_has_no_request_install_packages` (runs 6a's `checkReleaseManifest` on the release variant)
- [ ] **Step 2:** Implement. Write the R8 file. Fakes bypass Hi Rokid authorization and speech discovery, so T13 rows `CXR-AUTH` and `SPEECH` check them on the real phone.
- [ ] **Step 3:** Green on the full suite list. Commit `Guide setup on the phone, with the bundled glasses install, coexistence and the Tailscale connector`.

### Task 10: Versions, signing, release CI, and the upstream sync (§3.6–3.8) `[FR 16]` `[FR gate]` `[CR 10]`

**Files:** see the ownership table. It runs after T5, and after 6b is merged.

**Interfaces:**
- **Versions:**
  - `gradle.properties` holds `rokid.versionName=1.0.0` and `rokid.versionCode=10000`. `:mobile:app` and `:glasses-app` read them.
  - The `computer` package and both plugin manifests say `1.0.0`. The marketplace files carry no version today; `check-versions` fails if one gains a version that differs.
  - `computer/src/codex/monitor.ts:80`'s `CLIENT_VERSION` reads `computer/package.json` instead of a literal.
  - `scripts/check-versions.mjs --expect <v>` lists every one of these fields, plus the version that 6b's installers stamp (as 6b's final plan names it). It fails on any mismatch. It also fails if any tracked file outside `docs/`, `vendor/`, lockfiles and a named fixture allowlist still contains `0.8.0`, so a field it doesn't list can't slip through.
- **Signing:**
  - The `rokid.release-signing` plugin (ours, in `build-logic/`, applied by `:mobile:app` and `:glasses-app`) reads the three `NEXUS_RELEASE_*` env vars, with the same rules as upstream's script. Unlike upstream, any `assembleRelease` / `bundleRelease` without them FAILS ("release builds must be signed"), instead of producing an unsigned APK.
  - `verifyReleaseSignerPin` (a dependency of both release assemblies) computes the SHA-256 of the alias's certificate and fails unless it equals `rokid.releaseSignerSha256`. That property is a public certificate digest, committed, and it is what the phone pins (T5).
- **User action, before the first rc** (printed by T10, never done by a task):
  1. Create the PKCS12 key outside the repo: `keytool -genkeypair -v -storetype PKCS12 -keystore <outside>/rokid-coder-release.p12 -alias rokid-coder -keyalg RSA -keysize 4096 -validity 10000`.
  2. Add the secrets `NEXUS_RELEASE_KEYSTORE_B64`, `NEXUS_RELEASE_KEYSTORE_PASSWORD`, `NEXUS_RELEASE_KEY_ALIAS`.
  3. Hand the controller the certificate's SHA-256 (`keytool -list -v`) for `rokid.releaseSignerSha256`.
- **Release assets** (`scripts/release-assets.txt` is the single list; each line is `artifact name | kind | producing job or workflow`, where kind is `payload` (downloaded from a producer) or `generated` (made by `draft`)):

  | Asset | Produced by |
  |---|---|
  | `rokid-coder-1.0.0.apk`, `rokid-coder-1.0.0.aab`, `rokid-coder-glasses-1.0.0.apk` | `release.yml` `android` |
  | `rokid-coder-1.0.0-macos-arm64.dmg`, `rokid-coder-1.0.0-macos-x64.dmg` (each holding its `.pkg`) | 6b's macOS installer workflow |
  | `rokid-coder-1.0.0-windows-x64.exe` | 6b's Windows installer workflow |
  | `SHA256SUMS` (kind `generated`) | `release.yml` `draft` |

  6b's workflows are consumed by artifact name only. T10 adds `on: workflow_call` with `version` and `ref` inputs to them if they lack them. If 6b's final names differ, this file and the checklist header are the only places to change.
- **`release.yml`:**
  - **Trigger:** tags `rokid-coder-v*`. A tag without an `-rc.N` suffix fails at once with "Final releases are created by publish-release from a tested rc", so a final tag push never rebuilds.
  - **`verify`** (ubuntu): parse the tag. `rokid-coder-v1.0.0-rc.3` expects `1.0.0`. Run `check-versions.mjs`.
  - **`suites`:** `tests.yml` via `workflow_call` with `ref` = the tag's commit. Every product, script and platform suite must pass for this exact commit.
  - **`android`** (ubuntu, JDK 17):
    - Check out CxrGlobal by SHA, as a sibling.
    - Decode the keystore into `$RUNNER_TEMP` (umask 077), as today's `app-release.yml` does.
    - Run `verifyReleaseSignerPin`, `:glasses-app:assembleRelease`, `:mobile:app:assembleRelease`, `:mobile:app:bundleRelease`, `:mobile:app:checkReleaseManifest` and 6a's dex checks on the release output.
    - Check `apksigner verify --print-certs` on both APKs against the pin.
    - Upload the three Android assets.
  - **`android-install`** (ubuntu, the emulator, using `emulator.yml` via `workflow_call`):
    - `adb install` the exact uploaded phone APK.
    - Assert the package id, versionCode 10000 and the signer, start the launcher activity, and assert the onboarding WELCOME screen with a UI Automator check.
    - Assert the bundled `glasses.json` inside the APK matches the glasses asset.
    - For the AAB, check `jarsigner -verify` and `bundletool dump manifest` (package and versionCode).
  - **`macos`, `windows`:** call 6b's installer workflows with `version` and `ref` = the tag's commit. Each builds its artifact AND runs its own install job against that exact file, on its platform. These jobs are 6b's, and their pass is required `[FR gate]`.
  - **`release-summary`** (ubuntu, an ordinary job, not a reusable call): needs `verify`, `suites`, `android`, `android-install`, `macos` and `windows`. It runs only if every one of them succeeded, re-checks each `needs.<job>.result == 'success'`, and writes `release-provenance.json` (`{run_id, commit, results}`) as an Actions artifact. Reusable-workflow calls appear in the jobs API only as expanded child jobs (`<caller> / <child>`, per matrix cell), so this one stable job name is what promotion checks.
  - **`draft`** (needs `release-summary`):
    - Download every `payload` asset in `release-assets.txt`. A missing one fails the run.
    - Generate `SHA256SUMS` over the payload files, and also upload it as this run's Actions artifact `release-sha256sums`.
    - Check that the upload set is exactly the payload plus the generated files.
    - `gh release create <tag> --draft --prerelease --verify-tag`, with every asset. The notes are `docs/coding-agent/releases/1.0.0.md` plus a provenance footer: `Built by run: <run id>` and `Commit: <sha>`.
    - CI never creates a non-draft release.
- **`publish-release.yml`** `[FR gate]`:
  - `workflow_dispatch` on `release/1.0.0` with input `rc_tag`. It runs in the GitHub Environment `release`, whose required reviewer is the user (the controller asks the user to configure that). The gate reads the checklist as committed on that branch.
  - `scripts/release-gate.mjs` (pure, tested) checks the checklist against the fixed schema `scripts/checklist-required.json`. The schema lists every required row by ID, with its Platform and CLI; T10 fills it from T11 Step 4's ID list, including 6b's gate rows. The gate refuses unless all of these hold:
    - The checklist's `Tested build:` header equals `rc_tag`.
    - Every schema ID appears exactly once, with the schema's Platform and CLI, `Required = yes`, and `Result = PASS`. A missing row, a duplicate ID, or a row downgraded to `Required = no` refuses. Rows that aren't in the schema may exist only with `Required = no`.
    - Every required row's `Tested on` is an rc tag whose commit is an ancestor of (or equal to) the rc commit, and the schema's smoke rows (`INSTALL-*`, `PAIR-*`, `ALERT-*`) are tested on `rc_tag` itself.
    - The header's `Final reviews:` lists exactly one execution review file for each of 6a, 6b and 6c under `docs/coding-agent/codex/reviews/` (the file name contains `plan-6a`, `plan-6b` or `plan-6c`, and `exec`). Each file contains a `Reviewed commit: <sha>` line, where that commit is an ancestor of the rc commit (`git merge-base --is-ancestor`), and ends with `VERDICT: READY`. The controller's execution-review prompts ask for that line.
    - **Coverage:** some listed READY review (a plan's execution review, or a fix-wave re-check listed alongside them) must have a `Reviewed commit` C where `git diff --name-only C <rc commit>` touches only the evidence paths: the device checklist and `docs/coding-agent/codex/reviews/**`. So any code change after the last review refuses until it is re-checked.
  - `scripts/publish-release.mjs`:
    1. Before anything else: if the tag `rokid-coder-v1.0.0` already exists and its peeled commit is not the rc commit, or a release `rokid-coder-v1.0.0` already exists, refuse, and name what the user must delete. `--target` is ignored for an existing tag, so this check is what binds the final tag to the tested commit.
    2. Read the rc draft's provenance footer. Through `gh api --paginate`, check that the run is `release.yml`, triggered by `push` of `rc_tag`, with `head_sha` = the rc tag's commit and conclusion `success`. Its jobs list must contain exactly one `release-summary` and one `draft`, both `success`. Its `release-provenance.json` artifact must name the same commit and `success` for all six needs. Anything else refuses.
    3. Download the draft's assets. They must match its `SHA256SUMS`, and that file must equal the run's `release-sha256sums` artifact.
    4. Create the final release `rokid-coder-v1.0.0` (`gh release create --target <rc commit>`, `--latest`, not a prerelease) with exactly those files and the same notes.
    5. Delete the rc draft.

    A release or tag created with `GITHUB_TOKEN` starts no `push` run, so nothing rebuilds.
- **`upstream-sync.yml`** `[FR 16]`, which follows 6a's merge-based strategy:
  - **Triggers:** a weekly `schedule` and `workflow_dispatch` (inputs `upstream_url` and `upstream_ref`, defaulting to `https://github.com/Anezium/Rokid-Nexus.git` and `main`). Both work only from the default branch (see the prerequisite below).
  - **The script interface (T10 extends 6a's script):** `scripts/upstream-sync.sh [--remote <url>] [--ref <ref>]`, defaulting to the `upstream` remote and `main`. It keeps 6a's exits (2 on a conflict, printing the files and PATCHES rows; 0 on a clean merge) and, on a merge, prints `MERGE_SHA=<sha>` as its last line. 6a's existing tests still pass unchanged.
  - **Job `sync`:** check out with `fetch-depth: 0`. Create `upstream-sync/<date>` and run the script with the inputs. Output `{code, changed, branch, merge_sha, report}`:
    - **Exit 2:** a conflict. The report holds the conflicted files and their `PATCHES.md` rows.
    - **Exit 0 with no new commit:** nothing to do.
    - **Exit 0 with a merge:** push the branch.
  - **Jobs `suites`** (`tests.yml` via `workflow_call`) and **`upstream`** (`upstream-validation.yml` via `workflow_call`) run only when there is a merge, both with `ref` = `merge_sha` (an immutable SHA, not the branch name).
    - A reusable workflow otherwise checks out the caller's event SHA. So every checkout OF THIS REPOSITORY (an `actions/checkout` step with no `repository:`, or with this repository) in `tests.yml`, `upstream-validation.yml`, `emulator.yml` and 6b's Windows-test workflow uses `ref: ${{ inputs.ref || github.sha }}`, and `tests.yml` forwards its `ref` to the workflows it calls.
    - Dependency checkouts keep their own pins and never take `inputs.ref`. The CxrGlobal checkout uses the pinned SHA, from one `CXRGLOBAL_SHA` value per workflow that `check-versions.mjs` also verifies.
    - Every job writes the product checkout's `git rev-parse HEAD` as an output, and its dependency SHAs separately. `report` treats any job whose product SHA differs from `merge_sha` as `Upstream sync error`.
    - Suites run inside this workflow, so the PR's evidence doesn't depend on PR-triggered runs. Events caused by `GITHUB_TOKEN` start no normal runs, though some pull-request runs can be created waiting for approval. The PR body links this sync run, and those pending runs are not required.
  - **Job `report`** (`if: always()`): `scripts/upstream-sync-decide.mjs` maps the outcomes to exactly one action:

    | Outcome | Action |
    |---|---|
    | exit 0, no change | none |
    | merge, both suites jobs pass | open a PR, or update the open one |
    | merge, a suites job fails | an issue `Upstream sync breaks suites` naming the failed jobs, with the branch kept and NO PR |
    | exit 2 | an issue `Upstream sync conflict`, with the report (6a's printed files and PATCHES rows) and NO PR |
    | any other exit | an issue `Upstream sync error` |

    Issues carry the label `upstream-sync`. A repeat outcome comments on the open issue instead of opening another.
  - **Permissions:** `contents: write`, `pull-requests: write`, `issues: write`. The merge commit uses the `github-actions[bot]` identity, with no AI attribution.
- **`tests.yml`:**
  - **Triggers:** `push`, `pull_request` and `workflow_call` (input `ref`, forwarded to every called workflow).
  - **`scripts`** (ubuntu): `node --test scripts/test`, `./gradlew -p build-logic test` (the TestKit and unit tests of both plugins), and `actionlint` on every workflow.
  - **`computer`:** `npm ci && npm test` on `ubuntu-latest` (which also stands for the WSL Linux build) and `macos-latest`.
  - **`android`** (ubuntu): the Gradle product suites. `scripts/check-test-results.mjs` (6a's, if it exists; otherwise T10 adds it) parses the JUnit XML and allows only the 2 named `GlassesFileStoreTest` failures.
  - **`emulator`:** `emulator.yml` via `workflow_call`.
  - **`windows`** (`windows-latest`): 6b's Windows CI tests (Pester and the mocked-`wsl.exe` node tests) via `workflow_call`. Hosted Windows runners can't run WSL2, and on Windows agentd runs inside WSL (R4), so the Linux build of the computer suite runs on ubuntu, and the Windows host's own code runs here. This is how §3.8's "macOS and Windows runners" is met.
- **Controller prerequisite (P1), required before T10 Step 4 and before T13:** GitHub runs `schedule` and `workflow_dispatch` only from workflows on the default branch, and today the default branch, `main`, is the untouched upstream base without these files. So the user makes `release/1.0.0` the default branch (or merges these workflows into the default branch). The controller asks the user and records the answer. Without it, neither the sync dispatch checks nor `publish-release` can run, and the release stays a draft.
- **Old workflows:** the upstream release and publishing workflows at the root (`app-release.yml` on `v*` tags, `plugin-release.yml`, `sdk-release.yml`, `sdk.yml`, `pages.yml`) are deleted if 6a left them, because they would build or publish upstream modules from our repo. Upstream's own workflows live inert under `vendor/nexus/.github/`.

- [ ] **Step 1: Write the failing checks** (`node --test scripts/test`, plus Gradle TestKit where marked):
  - `glasses_signer_pin_matches_release_key` (TestKit, with a throwaway PKCS12 key, for both a match and a mismatch)
  - `release_build_without_keystore_fails` (TestKit)
  - `every_version_field_is_1_0_0`: the real tree passes, and a fixture with one stray `0.8.0` fails, naming the file
  - `rc_tag_expects_plain_version_and_final_tag_is_refused`
  - `draft_assembly_starts_without_sha256sums_and_uploads_exact_set`, and `draft_fails_on_a_missing_payload_asset`
  - `release_gate_refuses_unless_every_required_item_passes`: fixtures for a blank result, a FAIL, `N/A` on a required row, an omitted matrix cell, a duplicate ID, a required row downgraded to `no`, a wrong Platform or CLI on a schema row, a missing Windows-session row, a wrong `Tested build`, a smoke row tested on an older rc, a `Tested on` rc that isn't an ancestor, a missing plan's review, an unrelated READY review (a plan review, not an execution review), a review whose `Reviewed commit` isn't an ancestor, a final review that isn't READY, an ancestor READY review followed by an unreviewed code change, and a missing, blank or FAIL `MACG-M*` row
  - `release_gate_lints_the_real_checklist`: the real checklist with blank results passes `--lint` (the format and every schema ID present)
  - `publish_promotes_exact_tested_artifacts`: with a fake `gh` on PATH, each of these refuses: a hash mismatch, a `SHA256SUMS` that differs from the run artifact, a missing provenance footer, a run that failed, a run whose `head_sha` differs, a missing or failed `release-summary`, a provenance artifact with one need not `success`, an existing final tag pointing elsewhere, and an existing final release. Success uploads exactly the rc's files to the final tag.
    - The jobs-API fixture starts as a synthetic response in the real shape (paginated, with expanded `<caller> / <child>` names and matrix cells). In T10 Step 4 the controller replaces it with the response captured from the rc.1 run, and the test must still pass.
  - `sync_script_honours_remote_and_ref_and_prints_merge_sha`, on 6a's temp-repo fixture
  - `every_called_workflow_checks_out_inputs_ref`: a static scan of every checkout step in the reusable workflows. Checkouts of this repository use `inputs.ref || github.sha`; a CxrGlobal checkout uses `CXRGLOBAL_SHA` and fails the test if it references `inputs.ref`.
  - `report_flags_a_job_that_tested_another_commit`
  - `upstream_sync_opens_pr_only_when_suites_pass`, `sync_conflict_opens_issue_not_pr`, `suite_failure_opens_issue_and_keeps_branch`, `no_upstream_change_does_nothing` and `repeat_outcome_comments_on_open_issue`. These drive `upstream-sync-decide.mjs` with a fake `gh`, and drive the real `scripts/upstream-sync.sh` against 6a's temp-repo fixture (a clean synthetic upstream commit, and a conflicting one).
  - `no_other_workflow_creates_releases`: a static scan of `.github/workflows/` (only `release.yml` drafts, only `publish-release.yml` publishes)
  - `workflows_lint`: `actionlint` on every workflow (lint only; the proof is the controller runs below)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Green. Commit `Release 1.0.0 identity, signing and CI, plus a weekly upstream sync`.
- [ ] **Step 4 (controller, after the 6c review's fix wave is pushed, and after P1)** `[CR 10]`: real runs, recorded in `.superpowers/sdd/plan-6c/ci-runs.md` with run URLs.
  - `tests.yml` is green on ubuntu, macos, windows, the emulator and the `scripts` job.
  - `release.yml` on `rokid-coder-v1.0.0-rc.1` produces every asset in `release-assets.txt`. Every install job passes, and the result is a draft prerelease only.
  - `upstream-sync.yml` by dispatch, against two throwaway refs (`ci/synthetic-upstream-clean` and `ci/synthetic-upstream-conflict`: upstream `main` plus one commit; the second touches a `PATCHES.md` file): the first opens a PR, and the second opens an issue naming the patch. In the clean run, every job reports the same `merge_sha`. Then close them and delete the refs.
  - A dispatch of `publish-release.yml` with the untested checklist is refused by the gate.

### Task 11: The privacy note, the About screen, READMEs and the device checklist (R10, R11, U32) `[CR 11]`

**Files:** see the ownership table.

- [ ] **Step 1: Write the failing tests:**
  - `about_screen_links_privacy_note`: the About screen (reached from a Settings row) shows the version and the privacy text, and links `https://github.com/debasishdebs/Rokid-Coder/blob/release/1.0.0/PRIVACY.md` (`main` is still the upstream base)
  - `in_app_privacy_text_matches_privacy_md`: a unit test that reads `PRIVACY.md` from the repo and `strings_about.xml`, and checks that both name the same three outbound paths and say "no servers" and "collects nothing"
  - `docs_contain_no_secrets_or_full_fingerprints`: `scripts/check-docs-secrets.mjs` over the files T11 owns, plus `docs/coding-agent/**`. It flags 64-hex and 32-pair colon-hex runs, `"token"` / `"steer"` values, and v1/v2 pairing-line JSON with real-looking hosts. `gradle.properties` is not in the scanned set: its `rokid.releaseSignerSha256` is a public certificate digest, not a pairing fingerprint.
- [ ] **Step 2: `PRIVACY.md`, and the same text in the About screen,** say in substance (R11):
  - Rokid-Coder runs no servers and collects nothing.
  - Data leaves your devices only through services you already use:
    - the Claude/Anthropic and Codex/OpenAI CLIs
    - your Android speech engine, which may be online
    - Tailscale, if you choose it
  - The 1.0 app has no cloud speech engines and no analytics.
- [ ] **Step 3: The READMEs** give install steps only:
  - **Root:** what it is in two lines, the download link, and links to the four folder READMEs.
  - **`computer/`:** the `.dmg`/`.pkg` and `.exe`, the unsigned-installer step (macOS `right-click → Open`, Windows `More info → Run anyway`; U32), the prerequisites (macOS 13+; Windows 11 22H2+ with WSL 2), the skippable CLI step, pairing, Tailscale as optional, and uninstall.
  - **`plugin/`:** that the installer sets the plugins up, plus the manual commands.
  - **`mobile/`:** install the APK, follow the setup, and the coexistence note.
  - **`glasses/`:** installed from the phone over the Rokid link, with no PC or adb.
  - **`docs/coding-agent/releases/1.0.0.md`:** the release body (the "download page" of U32), with the same unsigned-installer step and the asset list.
- [ ] **Step 4: The device checklist** `docs/coding-agent/claude/plan/2026-11-15-v1-device-checklist.md`, rewritten for the single app and carrying forward the still-valid items of `2026-11-14-plan-2-device-checklist.md`.
  - **The format contract** (T10's gate parses it, and its schema lists the required IDs below):
    - The header lines are `Tested build: <rc tag>`, `Final reviews: <file>, <file>, <file>` (the 6a, 6b and 6c execution reviews), and `ROKID_RK_WINDOWS_VERIFIED: <yes|no>`.
    - The rows are markdown tables with the columns `| ID | Area | Item | Platform | CLI | Required | Tested on | Result | Notes |`.
    - `Platform` is `macOS`, `Windows (WSL)` or `phone/glasses`. `CLI` is `Claude Code`, `Codex` or `—`. `Required` is `yes` or `no`. `Tested on` is the rc tag the result came from. `Result` is `PASS`, `FAIL`, `N/A` or blank.
    - IDs are unique. In the IDs below, `<P>` is `MAC` or `WIN`, and `<C>` is `CC` (Claude Code) or `CX` (Codex).
  - **The required rows,** each with its steps and expected result:
    - **One per platform and CLI** (R10), `<ITEM>-<P>-<C>`:
      - `ATTACH`: attaching a session
      - `APPROVE`: approvals and questions
      - `REPLY`: same-session replies
      - `ALERT`: alerts on the glasses within about 5 s (a smoke row)
      - `DND`: DND and quiet
      - `RECONNECT`: disconnect and reconnect
      - `EXPIRY`: pairing expiry
      - `REVOKE`: revocation
      - `LAUNCH`: the launcher typing-safety rules. Required on `MAC`. The `WIN` rows are `Required = no` (U33); with `WINS-W9` they set the `ROKID_RK_WINDOWS_VERIFIED` header.
    - **One per platform** (CLI `—`), `<ITEM>-<P>`:
      - `INSTALL` and `PAIR`: install from the draft, and the first pairing (smoke rows)
      - `UPGRADE`: installer upgrade, 0.8.0 → 1.0 on the computer side
      - `UNINSTALL`: uninstall, keeping state unless purged
      - `REC-KILL`, `REC-OFFLINE`, `REC-MISMATCH`: onboarding recovery (the app killed halfway, the computer offline, a code mismatch)
    - **Phone and glasses** (Platform `phone/glasses`, CLI `—`):
      - `GLS-INSTALL`: the glasses app installed from the phone with `REQUEST_INSTALL_PACKAGES` absent (R8)
      - `GLS-NEWER`: newer on the glasses is left alone, with the warning
      - `GLS-UPSTREAM`: an upstream Nexus glasses app is already on the glasses
      - `CXR-AUTH`: the Hi Rokid authorization from onboarding
      - `SPEECH`: Android speech recognition and TTS on the real phone
      - `BOOT-VOICE`: reboot, then voice (R9′)
      - `STOP-PERSIST`: Stop, reboot, still stopped until opened
      - `COEXIST`: upstream Nexus running, then the Stop-hub guidance and Retry
      - `SAS-MISMATCH` and `SAS-SECOND`: a code mismatch, and a second device answering
      - `TS-STATES`: the Tailscale connector states
      - `CHIME-BT` and `CHIME-NOSPEAKER`: the R191 chime rows, carried forward
      - `ABOUT`: the About and privacy text
    - **6b's recorded gates**, carried into the checklist with 6b's final wording:
      - `MACG-M1`, `MACG-M2`, `MACG-M3` (6b T7b Step 5: the macOS 13 VM GUI install, the x64 bundle under Rosetta, the macOS 12 refusal). Platform `macOS`, required.
      - `WINS-W1` … `WINS-W8` (6b T8 Step 5: the real WSL2 install, binding, networking and plugin-mode rows). Platform `Windows (WSL)`, required.
      - `WINS-W9` (the `rk` safety suite on Windows) is `Required = no`. With `LAUNCH-WIN-*`, it decides `ROKID_RK_WINDOWS_VERIFIED`.
  - Further rows carried forward from the old checklist may be added with `Required = no`.
- [ ] **Step 5:** Run `scripts/check-docs-secrets.mjs`. Green. Commit `docs: 1.0 privacy note, About screen, install guides and the device checklist`.

### Task 13: The hardware gate (the user runs it) `[FR gate]` `[CR 11]`

Nothing is published before this passes. The release stays a draft prerelease, and `publish-release` refuses to promote it.

- [ ] **Step 1 (controller):**
  - Make sure P1 and T10 Step 4 are recorded, and that the execution reviews of 6a, 6b and 6c are READY, each with its `Reviewed commit:` line.
  - Tag `rokid-coder-v1.0.0-rc.N`, and wait for its draft.
  - Fill in the checklist header's `Tested build` and `Final reviews`.
- [ ] **Step 2 (user):** install from that draft only, then run the T11 checklist:
  - on the user's glasses and phone
  - with one macOS and one Windows 11 (WSL) computer
  - with Claude Code AND Codex

  This includes 6b's gate rows (`MACG-M*` in a macOS 13 VM, as 6b specifies, and `WINS-W*`). Record every result with its `Tested on` rc.
- [ ] **Step 3:** For any required FAIL:
  1. A fix wave.
  2. A new rc.
  3. Re-run the failed rows, every row in the areas the fix touched, and the smoke rows (`INSTALL-<P>`, `PAIR-<P>`, `ALERT-<P>-<C>`).
  4. Update `Tested build`. A fix-wave diff gets its own Codex re-check, which replaces that plan's entry in `Final reviews`.
- [ ] **Step 4:** `ROKID_RK_WINDOWS_VERIFIED` comes from `WINS-W9` and the `LAUNCH-WIN-*` rows.
  - If they all PASS, the fix wave sets it where 6b reads it, then a new rc re-runs those rows and the Windows smoke rows.
  - Otherwise, 1.0 ships with the Windows launcher hint (U33).
- [ ] **Step 5 (user):** dispatch `publish-release.yml` with the passing rc and approve the `release` environment. The gate checks the checklist, the hashes and the review, then publishes exactly the tested files as `rokid-coder-v1.0.0`.
