# Rokid-Coder patches to vendored Nexus

`vendor/nexus` is upstream [Anezium/Rokid-Nexus](https://github.com/Anezium/Rokid-Nexus),
added as a squashed git subtree at upstream `15cd98ad`. Our changes inside it are
ordinary commits, and every one of them has a row below. Upstream updates arrive as a
merge, from `scripts/upstream-sync.sh` (`git subtree pull --prefix=vendor/nexus upstream
main --squash`). When a merge conflicts, the script aborts it, exits 2, and prints the
conflicted files with the rows here that touch them.

Row format, one row per commit:

- **SHA**: the commit that made the change.
- **Files**: paths relative to `vendor/nexus`, comma-separated. A path ending in `/` stands
  for everything under that directory. The sync script matches conflicts against this
  column, so keep it exact.
- **Purpose**: why we carry the change.
- **Must-not-touch?**: `yes` when the commit touches a must-not-touch area (below). Such a
  commit needs its own security review, and an upstream conflict in it is never resolved
  by taking ours blindly.

| SHA | Files | Purpose | Must-not-touch? |
|---|---|---|---|
| 1e57da9c | `BUSSPEC.md`, `ROADMAP.md`, `docs/PLUGIN_SDK.md`, `plugins/AGENTS.md`, `site/index.html`, `bus-client/src/main/java/com/anezium/rokidbus/client/plugin/NexusPluginCallbacks.kt`, `bus-client/src/main/java/com/anezium/rokidbus/client/plugin/NexusPluginClient.kt`, `bus-client/src/main/java/com/anezium/rokidbus/client/plugin/NexusPluginService.kt`, `bus-client/src/test/java/com/anezium/rokidbus/client/plugin/NexusNoticeActionTest.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/AssistantDisplayEpisode.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/GlassesHub.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/NoticeController.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/NoticeOverlayRenderer.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/RokidBusAccessibilityService.kt`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/SurfaceController.kt`, `glasses-hub/src/test/java/com/anezium/rokidbus/glasses/AgentsNoticeHoldPolicyTest.kt`, `glasses-hub/src/test/java/com/anezium/rokidbus/glasses/NoticeShownAckTest.kt`, `shared/src/main/java/com/anezium/rokidbus/shared/BusConstants.kt`, `shared/src/main/java/com/anezium/rokidbus/shared/GlassesHubCapabilitiesContract.kt`, `shared/src/main/java/com/anezium/rokidbus/shared/NoticeSurfaceContract.kt`, `shared/src/main/java/com/anezium/rokidbus/shared/PhoneHubCapabilitiesContract.kt`, `shared/src/main/java/com/anezium/rokidbus/shared/plugin/PathRules.kt`, `shared/src/test/java/com/anezium/rokidbus/shared/GlassesHubCapabilitiesContractTest.kt`, `shared/src/test/java/com/anezium/rokidbus/shared/NoticeSurfaceContractTest.kt`, `shared/src/test/java/com/anezium/rokidbus/shared/PhoneHubCapabilitiesContractTest.kt`, `shared/src/test/java/com/anezium/rokidbus/shared/plugin/PathRulesTest.kt` | Rokid-Coder's changes up to Plan 6 (`15cd98ad..d60b82af`), re-applied: the optional capability-gated `/notice/shown` ack, the Agents notice hold policy on the glasses, and the matching wire, SDK, plugin-rules, roadmap and site text. | no |
| d11277f9 | `bus-client/src/main/java/com/anezium/rokidbus/client/plugin/NexusPluginClient.kt` | `NexusPluginClient.createWithTransport`, a public factory over a caller-supplied transport, so the phone core can host its app in-process on the SDK's own client (R203). Nothing else changes. | no |
| 011e0eb2 | `phone-core/`, `phone-hub/` | The phone hub split into `:phone-core` (`HubCore`: CXR link, SPP authentication, routing, HUD tiers, input, speech, glasses install; `GlassesSurface`, `GlassesAppInstaller`, `SpeechEngineRegistry`) and the upstream shell `BusHubService` (`BusHubShellService.kt`), per `docs/coding-agent/claude/design/adr-cores.md`. Moves `PhoneSppPairing.kt` and `PhoneSppPairingStorage.kt` byte for byte and the SPP connect/auth/read and key-offer code verbatim. Widened to public for the shell: `PhoneActivityPresentationSettings`, `PhoneHudPositionStore`, `signingCertificateSha256`, `sha256Matches`, `SpeechSttSessionFactory`, `SttTimeoutHandle`, `SttTimeoutScheduler`, `ExecutorSttTimeoutScheduler`, `PostCommitTimeoutSttSession`, `SttEngineException`, `providerError`. | yes (security review of the moved SPP code) |
| 45f2db08 | `phone-core/` | The in-process surface contract tests; `HubCoreConfig` gains an opt-in constructor for the shell's hooks, so the in-process app needs no opt-in. | no |
| 71e0cfa6 | `phone-core/src/test/` | Surface threading, speech-run and restart contract tests. | no |
| 2c55973d | `phone-core/src/test/` | Enabled-gate, revocation-order and hook contract tests. | no |
| 94277fc1 | `phone-core/src/test/` | CXR installer and app-slot tests. | no |
| bcfcbf99 | `phone-core/src/test/` | The core-boundary test: no plugin runtime, cloud speech, kadb or okhttp. | no |
| 4845365c | `phone-hub/src/test/` | Upstream-shell-on-core tests. | no |
| cde75169 | `glasses-core/`, `glasses-hub/`, `phone-hub/src/test/bridge/files_answer_loss.init.gradle` | The glasses hub split: everything moves into `:glasses-core` by renames; `glasses-hub` keeps the application id, version, signing, launcher icons and a shell manifest at `glasses-hub/src/shell/AndroidManifest.xml`. Moves `AuthenticatedSppServer.kt` byte for byte. The core's `BuildConfig.VERSION_NAME` and `BuildConfig.DEBUG` become the host package's version name and debuggable flag. | yes (security review of the moved SPP file) |
| 689d0c51 | `settings.gradle.kts` | Includes `:phone-core` and `:glasses-core` in the standalone Nexus build [6a-R6]. | no |
| a9d477d0 | `shared/src/main/java/com/anezium/rokidbus/shared/AppIdentity.kt`, `shared/src/test/java/com/anezium/rokidbus/shared/AppIdentityTest.kt` | `AppIdentity`, the phone/glasses application-id pair each shell injects (T12, 6a-R2): components are (application id, unchanged class name). `GlassesClasses` names the glasses classes the phone opens. `:shared` holds no pair. | no |
| 3dbbeac9 | `phone-core/src/main/java/com/anezium/rokidbus/phone/HubCore.kt`, `phone-core/src/main/java/com/anezium/rokidbus/phone/HubCoreConfig.kt`, `phone-core/src/test/`, `phone-hub/build.gradle.kts`, `phone-hub/src/main/AndroidManifest.xml`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/BusHubShellService.kt`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/GlassesManualArmCommand.kt`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/GlassesManualArmRunner.kt`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/GlassesManualPairingBackend.kt`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/PhoneCoreRemoteBridge.kt`, `phone-hub/src/main/java/com/anezium/rokidbus/phone/ShellIdentity.kt`, `phone-hub/src/test/` | `HubCoreConfig.identity` replaces the core's `GLASSES_HUB_PACKAGE` (CXR session and installer package). The upstream shell supplies the upstream pair from `BuildConfig` (`PHONE_APPLICATION_ID`, `GLASSES_APPLICATION_ID`); opens `SetupEntryActivity`/`MainActivity` by class name, not `"$package.X"`; builds the manual-arm `PKG`/`SVC`/`SVC_SHORT`, the staged-script paths and `INTERNAL_CORE_PERMISSION` from the pair; the manifest uses `${applicationId}`. Its unit tests get the merged manifest through `-Drokid.mergedManifest`. | no |
| 958475b8 | `glasses-core/src/main/AndroidManifest.xml`, `glasses-core/src/main/assets/rokid-nexus-cmd-bridge.sh`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/AccessibilityWindowRoots.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/CameraActivity.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/GlassesCoreConfig.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmAccessibilityHandoff.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmArmSequence.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmConstants.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmController.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmLocalAdbBootstrapper.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmManualFallback.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmOnboardingStore.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmScripts.kt`, `glasses-core/src/main/java/com/anezium/rokidbus/glasses/SelfArmSessionCommand.kt`, `glasses-core/src/test/`, `glasses-hub/build.gradle.kts`, `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/shell/GlassesHubApplication.kt`, `glasses-hub/src/shell/AndroidManifest.xml`, `glasses-hub/src/test/` | `GlassesCoreConfig` (identity, hub target), provided by each glasses shell's Application through `GlassesCoreConfig.Host`; `GlassesHubApplication` gives the upstream pair. The self-arm commands, accessibility component, manual-arm paths, camera hub target, the `START_SELFARM_WIRELESS` permission and the surface task affinity follow the pair. The watchdog and bridge assets keep upstream's values and `SelfArmScripts` renders the pair in on install; the bridge's self-update (`render_update_candidate`) carries its rendered `CHANNEL` and `PACKAGE` into the successor. The bridge `VERSION` is unchanged: upstream-id bridges already running behave as before. | no |
| ec029f14 | `phone-core/src/test/java/com/anezium/rokidbus/phone/GlassesAppInstallerTest.kt` | Test-only: the slot FIFO test enqueues its waiters with `CoroutineStart.UNDISPATCHED` instead of sleeping, and releases every acquired operation in `finally`. No production change. | no |

## Must-not-touch areas

Nexus SPP authentication, authenticated enrollment and replay protection stay exactly as
upstream ships them (R12′). No commit of ours edits these files; a row marked `yes` above
would be the exception, with its review linked. Moving one of them byte for byte is such an
exception: CI checks their blob ids against upstream `15cd98ad`
(`.github/suite-baselines/spp-blobs.txt`).

- `shared/src/main/java/com/anezium/rokidbus/shared/SppAuthProtocol.kt` (the handshake, and
  `RecentNonces`, the replay window)
- `shared/src/main/java/com/anezium/rokidbus/shared/SppHandshakeDeadline.kt`
- `shared/src/main/java/com/anezium/rokidbus/shared/SppKeyProvisioning.kt`
- `shared/src/main/java/com/anezium/rokidbus/shared/SppKeyStore.kt`
- `glasses-core/src/main/java/com/anezium/rokidbus/glasses/AuthenticatedSppServer.kt`
- `phone-core/src/main/java/com/anezium/rokidbus/phone/PhoneSppPairing.kt`
- `phone-core/src/main/java/com/anezium/rokidbus/phone/PhoneSppPairingStorage.kt`

**Note on rename tracking (controller ruling R210, 2026-11-15):** `HubCore.kt` is 47.7% similar to upstream `BusHubService.kt`, below git's 50% rename threshold. An upstream edit to `phone-hub/.../BusHubService.kt` therefore shows as a modify/delete conflict on `git subtree pull`. `scripts/upstream-sync.sh` exits 2, the sync Action opens an issue, and the change is ported by hand into `phone-core/.../HubCore.kt` or the shell `BusHubShellService.kt`, per `docs/coding-agent/claude/design/adr-cores.md`.
