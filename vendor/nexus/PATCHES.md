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
