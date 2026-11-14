# Rokid-Coder Plan 6a: Foundation and Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 1.0 foundation:
- the new repo layout, with upstream Nexus vendored and kept in sync by merge
- the phone and glasses hubs split into reusable cores
- one phone app running the Agents code in-process
- one source of truth for app identity
- commit-then-reveal code pairing, including the credential handover, on every entry point

Plans 6b (installers) and 6c (onboarding and release) build on this.

**Architecture:**
- **Upstream Rokid-Nexus is a git subtree at `vendor/nexus/`.** Our changes inside it are ordinary commits, listed in `vendor/nexus/PATCHES.md`, and upstream updates arrive by `git subtree pull` (a merge).
- **Both hub app modules are split, by recorded commits, into libraries** (`:phone-core`, `:glasses-core`) plus the upstream app shells. Our apps (`:mobile:app`, `:glasses-app`) depend only on the cores.
- **The Agents code calls a private `GlassesSurface`** that is implemented on `HubCore`, in-process.
- **Pairing:** a SAS-confirmed TLS session hands over the long-lived credentials. After that, the existing token + `steer` + pinned-cert admission is unchanged.

**Tech Stack:** Kotlin (AGP 9.2, JDK 17, Compose), Node 22 + TypeScript (CommonJS), git subtree, GitHub Actions (ubuntu, macos, an Android emulator job).

**Spec:** `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md` (§13 > §12 > §11 > §10 > §8 > §1–7) and `docs/coding-agent/HANDOFF.md`. The behaviour contract in `2026-11-14-rokid-coder-design.md` §3 and §12 still applies.

**Review history:** the combined Plan 6 (`2026-11-15-plan-6-v1.md`) and its reviews in `docs/coding-agent/codex/reviews/2026-11-15-plan-6-*`. This plan resolves the full re-review's findings #1–#7 and #16. They are marked `[FR n]`; the remaining items are in 6b and 6c.

## Global Constraints
**Branch and commits**
- Branch `release/1.0.0`. Parallel worktrees within a wave, each touching only its owned paths (U15). Then ONE Codex sol review, one fix wave, and a Codex re-check.
- Commits are imperative, with NO Co-Authored-By and no AI attribution. Tasks never push.

**Never touch**
- `local.properties` and the build environment. On an environment failure, stop and report.
- `~/.claude`, `~/.codex`, or the real `~/.rokid-coder` / `~/.nexus-agentd`. Never type `/model` into a real `claude`. No adb on the user's devices.
- Never write a token, `steer`, a full fingerprint, SAS nonces, or `pair_credentials` contents to Claude/Codex session output or to ANY log level, including debug, malformed-frame and exception paths `[6a-R8]`.

**Identity:** application ids `io.github.debasishdebs.rokidcoder` and `io.github.debasishdebs.rokidcoder.glasses`. Kotlin class namespaces stay `com.anezium.rokidbus.*`.

**Pins:** CxrGlobal is `<repoRoot>/../CxrGlobal` at v0.3.0's SHA. `cxr-service-bridge` is `1.0-20260522.063600-105`. The upstream base is `15cd98ad`.

**Security:**
- Pinned mutual TLS on every computer↔phone link.
- Every NEW pairing, on every path, is SAS-confirmed by a human on both devices, and credentials only flow after that.
- Nexus `SppAuthProtocol`, authenticated enrollment and replay protection are untouched (R12′).

**Suites:** T1 freezes the product suite list (identity + outcome).
- Only the 2 known `GlassesFileStoreTest` failures are allowed, recorded by name.
- The upstream shells (`:phone-hub`, `:glasses-hub`) stay in the suite and must keep building and passing after every task.

## Waves and file ownership
A task edits only its paths. A later wave may edit an earlier wave's paths.

| Wave | Task | Owns |
|---|---|---|
| 0 | **T1** restructure, sync strategy, parity | the whole tree (a move); `settings.gradle.kts`; `vendor/nexus/PATCHES.md`; `.github/workflows/{tests,upstream-validation}.yml` |
| 1 | **T2** cores ADR + phone/glasses core split | `vendor/nexus/{phone-hub,phone-core,glasses-hub,glasses-core}/**`; `vendor/nexus/settings.gradle.kts` (core registrations for the standalone build) `[6a-R6]`; `docs/coding-agent/claude/design/adr-cores.md`; PATCHES.md entries for T2 |
| 1 | **T6** SAS pairing + credential handover + every entry point | `computer/src/{pairing,phone-link,ws-server,daemon,cli,protocol-v2,attach-command,hook-forward}.ts`, `computer/src/pairing/**`, `computer/src/launcher/{launcher-hub,pair-prompt}.ts`, `computer/test/**sas**`, `computer/test/pairing*`; `mobile/agents/**/{AgentdLinkServer,AgentdClient,AgentsConfigStore,SasPairing,AddComputerActivity,GuidedPairing,GlassesPairingCard,AgentsPluginService,GlassesScreen,AgentsMonitorService,PairingRecord}*.kt` + their tests (the glasses and runtime event wiring) `[6a-R5]`; `contracts/**` |
| 2 | **T3** one app: `GlassesSurface` + merge Agents | `mobile/app/**` (create), `mobile/agents/**` (move, then delete), `mobile/caller-test/**`, `.github/workflows/emulator.yml` |
| 2 | **T12** identity | `gradle.properties` identity keys; `glasses/app/**`; identity-literal commits across `vendor/nexus/{shared,phone-core,phone-hub,glasses-core,glasses-hub}/**` (literals and the AppIdentity plumbing only); PATCHES.md entries for T12 |

T3 and T12 don't share files: T3 owns `mobile/**` behaviour, and T12 owns identity literals in `vendor/**` and the glasses app shell.

## Review Focus
1. **A pairing started from `/rokid:pair` inside Claude.** Expected: even if a same-user command confirms on the computer, nothing pins without the human confirm on the phone, and the reply points to comparing the codes. Tests: T6 `rokid_pair_in_session_never_confirms_and_points_to_terminal` and `direct_socket_confirm_without_phone_confirm_never_pins`.
2. **An existing 0.8.x-style pairing line pasted into Add a computer** (it carries token and `steer`). Expected: refused with `"This pairing line is from an older version — pair again"`. Credentials never come from a line any more. Test: T6 `legacy_line_with_secrets_refused`.
3. **The phone already paired, reconnecting the next day.** Expected: no SAS; the existing pinned cert + token + `steer` admission. Test: T6 `pinned_reconnect_needs_no_sas_on_both_transports`.
4. **An upstream sync that conflicts with one of our patches.** Expected: an issue that names the conflicted files and the PATCHES.md entries, never a broken PR. Test: T1 `sync_conflict_opens_issue_naming_patches` (the workflow logic is exercised by a script test).
5. **A hard-coded component built from the package plus a class suffix** (`BusHubService.kt:3978,4020`). Expected: it resolves to an existing class in our app. Test: T12 `every_built_component_resolves_to_a_real_class`.

---

### Task 1: Restructure, merge-based upstream sync, parity gate `[FR 7, FR 16]`

**Files:**
- Create: `vendor/nexus/` (`git subtree add --prefix=vendor/nexus upstream 15cd98ad --squash`); `vendor/nexus/PATCHES.md`; `vendor/CxrGlobal` → a symlink to `../../CxrGlobal`, so that upstream's own `../CxrGlobal` resolves inside `vendor/nexus`; `.github/workflows/upstream-validation.yml`; `scripts/upstream-sync.sh`.
- Move:
  - `agentd/` → `computer/`
  - `plugins/claude-code` → `plugin/claude-code`
  - `plugins/codex` → `plugin/codex`
  - `plugins/agents` → `mobile/agents` (the module `:mobile:agents`)
- Delete: the root copies of upstream content.
- Modify: the root `settings.gradle.kts`.
  - Upstream modules keep their ORIGINAL names, with a new `projectDir`: `:shared`, `:bus-client`, `:ink-engine`, `:kadb-compat`, `:phone-hub`, `:glasses-hub` → `vendor/nexus/<name>`.
  - These are pre-registered behind `if (file(dir).exists())`: `:phone-core` → `vendor/nexus/phone-core`, `:glasses-core` → `vendor/nexus/glasses-core`, `:mobile:app`, `:mobile:caller-test`, `:mobile:agents`, `:glasses-app` → `glasses/app`.
  - `cxrGlobalDirectory = rootDir.parentFile.resolve("CxrGlobal")`.
- Modify: the root `package.json` workspaces (`computer`, `plugin/claude-code`, `plugin/codex`); both marketplace files; `computer/scripts/bundle-plugins.js`; `.github/workflows/tests.yml` paths.
- Create: the root `README.md`, and stub READMEs for `computer/`, `plugin/`, `mobile/` and `glasses/`.

**Interfaces:**
- **Patch-maintenance strategy (merge-based)** `[FR 16]`:
  - Our changes inside `vendor/nexus` are ordinary commits.
  - `PATCHES.md` lists each one as `SHA | files | purpose | must-not-touch?`.
  - `scripts/upstream-sync.sh` runs `git subtree pull --prefix=vendor/nexus upstream main --squash`.
    - **On a conflict:** abort, exit 2, and print the conflicted files and the PATCHES.md rows that touch them. Plan 6c's Action turns that into an issue.
    - **On a clean merge:** exit 0, and the caller runs every suite.
- **The product suite list,** frozen in `.superpowers/sdd/plan-6a/suites.txt` `[FR 7]`:
  - computer `npm test`
  - `:shared:test`, `:bus-client:testDebugUnitTest`, `:ink-engine:test`
  - `:phone-hub:testDebugUnitTest`, `:glasses-hub:testDebugUnitTest`
  - `:mobile:agents:testDebugUnitTest`
  - later, `:phone-core`, `:glasses-core`, `:mobile:app`, `:glasses-app`
- **Upstream validation** `[FR 7]`: `upstream-validation.yml` builds `vendor/nexus` standalone with upstream's own `settings.gradle.kts` and runs upstream's full test list (the plugins and probes we don't ship), so upstream remains verified.

- [ ] **Step 1: Baseline.**
  - List the commands from today's `.github/workflows/tests.yml` for the modules we keep, plus `:phone-hub:testDebugUnitTest` and `:ink-engine:test`.
  - Run them, and save `class#method → outcome` to `.superpowers/sdd/plan-6a/baseline-tests.txt`.
  - Separately run upstream's excluded-module suites, and save them to `baseline-upstream.txt`.
- [ ] **Step 2:** Add the subtree and the CxrGlobal symlink.
- [ ] **Step 3:** Re-apply our module changes.
  - Run `git diff 15cd98ad..HEAD -- phone-hub glasses-hub shared bus-client ink-engine kadb-compat | git apply --directory=vendor/nexus`.
  - Commit it as `Apply Rokid-Coder changes to vendored Nexus`, and add its row to PATCHES.md, marking the SPP auth and replay areas as must-not-touch.
- [ ] **Step 4:** Move our code, delete the root copies, and fix paths and CI.
- [ ] **Step 5: Parity gate.**
  - The product suite identities and outcomes must equal `baseline-tests.txt` exactly.
  - `upstream-validation` must equal `baseline-upstream.txt`.
  - `:phone-hub:assembleDebug`, `:glasses-hub:assembleDebug` and `:mobile:agents:assembleDebug` build.
- [ ] **Step 6:** Write the failing test `sync_conflict_opens_issue_naming_patches`, a bats/node script test. It creates a temp repo with a synthetic upstream commit that conflicts with a recorded patch, and asserts exit 2 and the printed names. Add a clean-commit case, which exits 0.
- [ ] **Step 7:** Commit `Move to the computer/plugin/mobile/glasses/vendor layout with merge-based upstream sync`.

### Task 2: The cores ADR, then the phone and glasses core split `[FR 4, FR 5, FR 6]`

**Files:**
- Create: `docs/coding-agent/claude/design/adr-cores.md`; `vendor/nexus/phone-core/**`; `vendor/nexus/glasses-core/**` (Android libraries).
- Modify: `vendor/nexus/phone-hub/**` and `vendor/nexus/glasses-hub/**`, which become thin shells over the cores.

**Interfaces (the ADR fixes every row before code):**
1. **The SDK interaction inventory:** every call and callback of the Agents code through `NexusPluginService` and the SDK, found by grepping `mobile/agents`. It covers:
   - cards: show, update, close, and readers/paged output
   - notices: show, update, hide, with shown, action and closed callbacks
   - text commit, and card input
   - TTS: speak, started, done, error, stop
   - STT: start, partial, final, error, stop
   - wake, device info, and lifecycle (open, background, close)

   Each row gets its `GlassesSurface` method, its threading, and its cancellation semantics.
2. **The `BusHubService` coupling map** (evidence includes `BusHubService.kt:953`):
   - **moves to `HubCore`:** the CXR link, SPP auth, rendering, input, speech, glasses install
   - **stays in the shell:** plugin discovery, registry, external runtime, store, updater, Patcher, GitHub-release resolution, and **manual ADB glasses setup** (`:kadb-compat`, `GlassesManualArmRunner`, its resources). The product installs the glasses app over CXR only `[6a-R7]`.
3. **The `:phone-core` API:**
   - `class HubCore(context, config: HubCoreConfig)`, with `start()`, `stop()`, `surface(): GlassesSurface`, `glassesInstaller: GlassesAppInstaller`, and `speech: SpeechEngineRegistry`.
   - `interface GlassesSurface`, plus the types `SpeechListener`, `TtsCallbacks`, `NoticeCallbacks`, `GlassesDeviceInfo` and `SurfaceState`, exactly as the inventory requires.
   - `GlassesAppInstaller` `[FR 5]`:
     - `suspend fun install(apk: File, expected: GlassesApkMetadata, onProgress: (Int) -> Unit): InstallResult`
     - `suspend fun installedVersion(): Long?`
     - `fun cancel()`
     - `GlassesApkMetadata(packageName, versionCode, sha256, signerSha256)`
     - `InstallResult` is `Installed`, `AlreadyCurrent`, `NewerOnGlasses`, `Cancelled`, `Failed(reason)`.
     - The verification helpers (`GlassesApkVerificationPolicy` and the apksig use) move into core.
     - GitHub-release download stays in the upstream shell, and calls `install(file, …)`.
   - `SpeechEngineRegistry` `[FR 6]`: core ships only the Android system recognizer and TTS. The upstream shell registers `CloudSttSessionFactory` and the cloud settings (`SpeechSessionManager.kt:107-109`, `SpeechSettingsActivity.kt:271-279`); our app never does.
4. **The `:glasses-core` split** `[FR 4]`: `glasses-hub`'s code, resources, AIDL and manifest components move into a library. `glasses-hub` keeps the upstream application id, signing and manifest as a thin shell. Our `:glasses-app` (T12) is a second thin shell. The product tests are `:glasses-core`'s plus `:glasses-app`'s.

- [ ] **Step 1:** Write the ADR. The controller gets a Codex review of the ADR, and nothing else in T2 starts until it says READY.
- [ ] **Step 2: Write the failing tests:**
  - `upstream_shells_build_and_pass_on_the_cores`: the `:phone-hub` and `:glasses-hub` suites, with identities unchanged
  - `phone_core_has_no_plugin_runtime_or_cloud_speech_types`: an API and dependency check
  - `glasses_surface_contract_tests`: one per inventory row, against `HubCore` with a fake CXR transport
  - `installer_verifies_before_every_push_and_reports_each_result`
  - `installer_cancel_stops_push`
- [ ] **Step 3:** Implement both splits as recorded commits, with PATCHES.md rows.
- [ ] **Step 4:** Green, in BOTH the root build and the standalone `vendor/nexus` build (`upstream-validation`) `[6a-R6]`. Commit `Split the Nexus phone and glasses hubs into reusable cores`.

### Task 3: One app: `:mobile:app` runs the Agents code through `GlassesSurface`

**Files:**
- Create: `mobile/app/**`. This includes `HubGlassesSurface` (a thin adapter, or the `HubCore.surface()` instance), our `AndroidManifest.xml`, the `:mobile:app:checkReleaseManifest` task, and `mobile/caller-test/**`.
- Move: `mobile/agents/src/**` into `mobile/app`, then delete `mobile/agents` (its guarded registration drops out).
- Create: `.github/workflows/emulator.yml`.

**Interfaces:**
- **Consumes:** T2's `HubCore` and `GlassesSurface`.
- **Produces:** `AgentsCore(surface: GlassesSurface, …)`, which replaces `AgentsPluginService`. Plan 6c's T4 owns the service and the lifecycle wiring around it.

- [ ] **Step 1: Write the failing tests:**
  - The former Agents suite runs against a fake `GlassesSurface`. Its identities are unchanged, or renamed one-to-one with a mapping file.
  - **`checkReleaseManifest` fails on any of:**
    - an exported service other than ours
    - a PLUGIN `<queries>` entry
    - `usesCleartextTraffic="true"`
    - `REQUEST_INSTALL_PACKAGES`, unless Plan 6c records that it is needed
  - **A dex check** (`apkanalyzer dex packages`) fails if the APK contains any of:
    - store or updater classes
    - Patcher, `ExternalPlugin*`, `PhonePluginDiscovery`/`Registry`
    - `CloudStt*` / cloud speech `[FR 6]`
  - **Dependency-graph check** `[6a-R7]`: `:mobile:app:dependencies --configuration releaseRuntimeClasspath` has no `:kadb-compat`, and the dex has no `com.flyfishxu.kadb` classes.
  - **`unrelated_apk_cannot_bind_or_start_our_services`:** an emulator `connectedAndroidTest`. `caller-test`, signed with another key, is refused for every service.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Green, including the emulator job. Commit `Run the Agents code in-process in one phone app`.

### Task 6: SAS pairing, the credential handover, and every entry point `[FR 1, FR 2]`

**Files:** see the ownership table.

**Interfaces:**
- **Where pairing runs:** on the FIRST link that forms while both sides have a window open, over either transport:
  - **PhoneLink:** agentd finds the phone by discovery and dials it. The phone's door must be open.
  - **wss:** the phone dials agentd at an address from a `pair-ready` announcement or from a QR code. agentd's allow-next must be open.
- **Before `PINNED`,** each side accepts an UNPINNED peer cert, and only for SAS frames. Any other frame aborts.
- **The SAS state machine:** as in combined Plan 6 rev 2 T6:
  - States: `IDLE → WINDOW_OPEN → PEER_TLS → COMMIT_SENT → NONCE_RECEIVED → REVEALED → AWAITING_CONFIRM → PINNED | ABORTED(reason)`.
  - Frames in order: `sas_commit`, `sas_nonce`, `sas_reveal`, `sas_confirm{attempt, ok}` (both directions).
  - Formulas as in R1′. Fingerprints are canonical uppercase colon-hex SHA-256 of the DER, taken from the TLS handshake.
  - One attempt per window. A second peer gives `ABORTED(second_peer)`.
  - Stale or foreign attempt ids are ignored.
- **The credential handover** `[FR 1]`: after `PINNED`, on the same SAS-authenticated TLS session, agentd sends `pair_credentials{v:2, attempt, token, steer, machineId, machineName, wsHost, wsPort}`.
  - **The phone stores it:**
    - the outbound slot `agentd.*`, with token, `steer`, fp = the pinned agentd fp, host and port
    - the machine trust record `machine.*`, with token and the pinned cert, for PhoneLink
    - then `pair_credentials_ack{attempt}`
  - **agentd** has already pinned the phone's fp (`PinStore.add`).
  - **Commit protocol (the phone becomes durable first; agentd becomes durable last)** `[6a-R4′]`:
    1. agentd stores the phone pin as PROVISIONAL in PinStore. Entry v4: `{fp, addedAt, lastUsedAt, state:"durable"|"provisional", attempt?, provisionalUntil?}`, with `provisionalUntil = now + 10 min`, persisted so it survives a restart. It then sends `pair_credentials`.
    2. The phone persists the credentials DURABLE, as one atomic `PairingRecord` write, then sends `pair_committed{attempt}`. If the write fails, it sends `pair_abort{attempt, reason:"storage"}` and agentd deletes the provisional pin.
    3. agentd receives `pair_committed` and marks the pin DURABLE.
  - **A provisional pin is never admissible for normal links,** except through *recovery admission*: a normal hello from that exact fp that carries the valid token and `steer` before `provisionalUntil` proves the phone stored the credentials. agentd then promotes the pin to DURABLE and admits the link. That covers a lost `pair_committed`, and an agentd restart between steps 1 and 3.
    - **PhoneLink recovery** `[6a-R4″]`: on PhoneLink, agentd dials and sends the hello, and no `steer` travels in it (`phone-link.ts:551`). So when agentd dials a phone whose pin is PROVISIONAL, it sends `pair_commit_query{attempt}` first, before the normal hello, on the mutually pinned TLS session. The phone answers `pair_committed{attempt, proof}`, where `proof = HMAC-SHA256(key = steer, "rokid-commit-v1" ‖ attempt ‖ agentdFp ‖ phoneFp)` and steer is the value it received in `pair_credentials`. agentd checks the proof against its own steer, promotes the pin to DURABLE, and only then continues with the normal PhoneLink hello. A wrong or missing proof means no promotion and no hello: the link closes. On wss, the phone's normal hello carrying token and steer is the proof.
    - Tests: `phonelink_recovery_promotes_with_valid_proof_only`, `phonelink_wrong_proof_closes_without_hello`.
  - **Expiry:** after `provisionalUntil`, provisional pins are purged by the existing sweeps. A phone that never stored credentials leaves nothing behind. A phone that did, but missed the window, gets `repair_needed` and re-pairs. No asymmetric durable trust can remain.
  - **Resending** a frame for the same attempt is idempotent.
  - **Tests (fault injection at every boundary):**
    - `phone_storage_failure_aborts_and_agentd_drops_provisional`
    - `lost_pair_committed_recovered_by_first_valid_hello`
    - `agentd_restart_between_send_and_commit_recovers_via_hello`
    - `provisional_pin_never_admits_without_token_and_steer`
    - `provisional_expiry_purges_and_phone_gets_repair_needed`
    - `phone_crash_before_persist_leaves_no_trust_anywhere`
    - `duplicate_credentials_frame_is_idempotent`
  - **Both close the pairing session.** Normal links then reconnect with today's admission:
    - wss: pinned cert + token + `steer` + `hello_ack.steering`
    - PhoneLink: mutual pinned certs + token
- **Already-pinned reconnects** use no SAS. They are unchanged.
- **One logical pairing per (computer, phone)** `[6a-R3]`:
  - The phone keeps ONE `PairingRecord`, keyed by agentd machineId plus the pinned agentd fp. It holds both the outbound slot and the PhoneLink machine trust.
  - Forget, TTL expiry and refusal all act on the whole record, and live links on BOTH transports are disconnected.
  - The TTL's last-used time is the max of both transports' activity.
  - On agentd:
    - Rotating `steer` (`pair --rotate-steer`) also forgets every phone pin. PhoneLink checks the pin, not `steer` (`phone-link.ts:347`), so rotation must remove the pins, or it wouldn't revoke anything.
    - `phones forget <fp>` revokes that phone on both transports.
  - Every one of these needs a new SAS pairing.
  - **Tests:**
    - `forget_on_phone_revokes_both_transports`
    - `forget_on_agentd_revokes_both_transports`
    - `rotate_steer_forgets_pins_and_blocks_phonelink_too`
    - `ttl_uses_latest_activity_of_either_transport`
    - `revoked_pairing_cannot_reconnect_in_either_direction`
- **The QR / pairing line, v2:** `{v:2, kind:"rokid-coder", host, port, fp}`. It carries NO token or `steer`. The phone uses it only to dial wss and then runs SAS.
  - A legacy v1 line that carries token or `steer` is refused with `"This pairing line is from an older version — pair again"`.
- **`pair-ready` announcement:** UDP `{"nexus":"agentd-pair-ready","v":1,"machineName","host","wsPort","attempt"}`. It carries no secrets.
  - The phone acts on it only while onboarding PAIRING or Add a computer is open.
  - Once per attempt, and at most one window per 30 s from announcements.
- **Entry points** `[FR 2]`: every one shows the code and takes a HUMAN confirmation.

  | Entry point | Shows the code / confirms on |
  |---|---|
  | `agentd pair` (CLI) | the terminal, `[y/N]` |
  | `rk` startup pair prompt (`pair-prompt.ts`, before claude spawns) | the terminal |
  | the installer's pairing step (Plan 6b) | a launcher-socket client using the same IPC |
  | `/rokid:pair` (Claude) and `rokid:pair` (Codex) | they open agentd's window, and the reply says: `"Compare the 6-digit code on your phone with the one in a terminal (run agentd pair) — confirm on the phone"`. A computer-side confirm alone never pairs (see the trust boundary). |
  | phone: Add a computer, onboarding | the code and Confirm/Cancel |
  | glasses: the Pair a computer card | the code and Tap to confirm / Back to cancel, sent through the phone |

- **Phone API, for 6c** `[6a-R5]`: `PairingAttempts.state: StateFlow<AttemptView?>`, where `AttemptView(attempt: String, state: AttemptState, code: String?, peerName: String)`, and `PairingAttempts.confirm(attempt: String, ok: Boolean)`. A stale attempt id is a no-op. The phone UI and the glasses card are the only callers.
- **IPC:** `pair_status{attempt, state, code?}` and `pair_confirm{attempt, ok}` over the 0600 launcher socket, for every computer-side client.
- **The trust boundary, stated plainly** `[6a-R1]`:
  - Same-user processes on the computer are trusted (U9, R48). A model-launched command can reach the socket and send `pair_confirm`, and nothing on the computer can prevent that. So the computer-side confirm is a UX step, NOT a security boundary.
  - **The security property:** a pairing reaches `PINNED` only when BOTH sides confirm. The phone-side confirm (phone screen, or glasses tap through the phone) is a human act on a device the model can't reach. The user compares the phone's code with the one the computer displays.
  - The `/rokid:pair` reply and every entry point tell the user to compare the codes and confirm on the phone.
  - **Tests:**
    - `direct_socket_confirm_without_phone_confirm_never_pins`
    - `phone_confirm_requires_on_device_input_not_a_frame` (the phone never auto-confirms from network input)

- [ ] **Step 1: Write the failing tests (TS and Kotlin, on both transports):**
  - `sas_vectors_match_on_node_and_kotlin`
  - `reveal_not_matching_commit_aborts`
  - `out_of_order_frame_aborts`
  - `second_commit_in_window_aborts`
  - `second_peer_aborts_both`
  - `no_pin_or_steering_before_both_confirm`
  - `credentials_sent_only_after_both_confirm_and_agentd_durable_only_after_pair_committed`
  - `pinned_reconnect_needs_no_sas_on_both_transports`
  - `mismatch_discards_both_pins_and_closes_window`
  - `disconnect_mid_attempt_aborts_and_discards`
  - `qr_v2_has_no_secrets_and_still_requires_sas`
  - `legacy_line_with_secrets_refused`
  - `stale_confirm_from_aborted_attempt_rejected`
  - `nonces_and_credentials_never_logged`
  - `pair_ready_one_shot_and_ignored_outside_pairing_screens`
  - `rokid_pair_in_session_never_confirms_and_points_to_terminal`
  - `glasses_card_confirm_reaches_attempt`
  - `rotate_steer_requires_new_sas_pairing`
- [ ] **Step 2:** Implement. The controller runs a separate Codex review of this diff.
- [ ] **Step 3:** Commit `Confirm every new pairing with a code, then hand over credentials`.

### Task 12: Identity in one place, and the glasses app shell `[FR 3, FR 4]`

**Files:** see the ownership table.

**Interfaces:**
- **Three distinct identities** `[FR 3]`:
  1. **Application ids** come from `gradle.properties` (`rokid.phoneApplicationId`, `rokid.glassesApplicationId`).
  2. **Class FQNs** stay unchanged (namespace `com.anezium.rokidbus.*`), for example `com.anezium.rokidbus.glasses.SetupEntryActivity`.
  3. **Components** are `ComponentName(applicationId, classFqn)`, and flattened strings are `"$applicationId/$classFqn"`.
- **`AppIdentity` is injected, not compiled into `:shared`** `[6a-R2]`.
  - `:shared` defines `data class AppIdentity(val phoneApplicationId: String, val glassesApplicationId: String)`, with `glassesComponent(classFqn)` and `phoneComponent(classFqn)`.
  - Each APP SHELL supplies its own pair through its BuildConfig and `HubCoreConfig.identity` / `GlassesCoreConfig.identity`:
    - `:mobile:app` and `:glasses-app` supply the Rokid Coder pair.
    - The upstream `:phone-hub` and `:glasses-hub` supply the upstream pair.
  - The cores read identity only from that config, never from constants.
  - Test: `each_shell_targets_its_own_pair`, which checks the exact target package and component strings for both app pairs.
- Every literal that names an APPLICATION or COMPONENT is replaced with `Identity`: e.g. `BusHubService.kt:3978,4020`, `GlassesManualArmRunner.kt:130`, storage paths, permission names, and generated watchdog/bridge scripts and setup commands. Namespace imports and class names are not touched.
- **Manifests** use `${applicationId}` and `manifestPlaceholders`.
- **`:glasses-app`** (`glasses/app/`) is a thin app over `:glasses-core`, with our application id, signing config and manifest. The upstream `:glasses-hub` keeps upstream's id.

- [ ] **Step 1: Write the failing tests:**
  - `every_built_component_resolves_to_a_real_class`: Robolectric `PackageManager` resolution, in both apps and both shells
  - `generated_scripts_and_commands_target_identity_ids`
  - `no_application_or_component_literal_outside_identity`: a namespace-aware check that flags string literals used as packages or components (`ComponentName(`, `setPackage(`, `"package:"`, `am start`/`pm` commands), never imports or class names
  - `glasses_app_application_id_is_ours_and_upstream_shell_unchanged`
- [ ] **Step 2:** Implement, as recorded commits with PATCHES.md rows.
- [ ] **Step 3:** Green, in the root build and the standalone `vendor/nexus` build, with the upstream shells passing. Commit `Inject app identity per shell, and add the Rokid Coder glasses app`.
