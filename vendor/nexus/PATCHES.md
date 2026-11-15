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

## Must-not-touch areas

Nexus SPP authentication, authenticated enrollment and replay protection stay exactly as
upstream ships them (R12′). No commit of ours edits these files; a row marked `yes` above
would be the exception, with its review linked.

- `shared/src/main/java/com/anezium/rokidbus/shared/SppAuthProtocol.kt` (the handshake, and
  `RecentNonces`, the replay window)
- `shared/src/main/java/com/anezium/rokidbus/shared/SppHandshakeDeadline.kt`
- `shared/src/main/java/com/anezium/rokidbus/shared/SppKeyProvisioning.kt`
- `shared/src/main/java/com/anezium/rokidbus/shared/SppKeyStore.kt`
- `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/AuthenticatedSppServer.kt`
- `phone-hub/src/main/java/com/anezium/rokidbus/phone/PhoneSppPairing.kt`
- `phone-hub/src/main/java/com/anezium/rokidbus/phone/PhoneSppPairingStorage.kt`
