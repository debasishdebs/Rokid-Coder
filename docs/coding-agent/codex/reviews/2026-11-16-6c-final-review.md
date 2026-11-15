Reviewed commit: 083fc4a1baa7bd05645f1b1805b0fc9dc684e8ce

**Task 4 — Spec verdict: PARTIAL**

- [Important] `mobile/app/src/main/java/com/anezium/rokidbus/plugin/agents/service/CoderService.kt:97`: speech-triggered `promote(true)` checks permission but not foreground visibility. After boot it can request the microphone before the app opens, relying on Android to refuse. **Fix:** when the microphone is not already held, require `processStarted()`; otherwise return the open-app error and display its pointer.
- [Important] `mobile/app/src/main/java/com/anezium/rokidbus/plugin/agents/VoiceCapture.kt:101`: microphone promotion failure becomes “Glasses link lost,” contradicting the boot recovery instruction. **Fix:** preserve the voice-unavailable reason through the speech result and render the open-app/permission pointer.
- [Important] `mobile/app/src/androidTest/java/com/anezium/rokidbus/plugin/agents/service/CoderBootOnDeviceTest.kt:52`: the required two-session background voice test remains absent. **Fix:** add deterministic PCM injection and exercise two complete sessions after HOME through the real speech pipeline.

The single-service declaration, connectedDevice-only boot request, persisted Stop, and upstream promotion policy are otherwise consistent with the plan.

**Task 5 — Spec verdict: PARTIAL**

- [Critical] `mobile/app/src/main/java/com/anezium/rokidbus/plugin/agents/onboarding/PairingStepController.kt:127`: Confirm reads the **current** attempt when tapped. If attempt B replaces displayed attempt A before rendering catches up, the tap confirms B. The existing `confirm(AttemptView, …)` guard cannot help because it receives B. **Fix:** retain the exact displayed `AttemptView`, capture it in the rendered buttons, and reject any changed attempt/code; add a replacement-before-click regression test.

Persisted onboarding recovery, Bluetooth permission requests, coexistence warning/retry, tailnet-link status, verification before APK push, and the documented absence of `REQUEST_INSTALL_PACKAGES` are supported by the implementation.

**Task 10 — Spec verdict: PARTIAL**

- [Important] `.github/workflows/emulator.yml:106`: `checkRelease` consumes the release APK, which now generates the bundled release glasses asset. This job supplies no signing credentials; `GlassesApkMetadata.read` rejects unsigned APKs, and release asset generation requires a pin. Thus normal tests—and release’s called suites—have a likely clean-run failure. **Fix:** generate an ephemeral CI signing key and override its pin for this isolated validation build; retain the committed signer pin for shipping artifacts.
- [Important] `.github/workflows/emulator.yml:350`: downloaded bundletool executes without checksum verification. **Fix:** commit its SHA-256 and verify before execution. Apply equivalent verification to the executable download chain at `.github/workflows/tests.yml:90`.

Signing requirements, draft-only RC creation, required checklist/READY-review checks, artifact hash comparison, and conflict-to-issue handling are present. The empty release signer pin remains a documented controller prerequisite.

**Task 11 — Spec verdict: PARTIAL**

- [Important] `PRIVACY.md:3` and `:25`: “runs no servers” and “Every link … uses … TLS” overstate reality: the daemon runs local HTTP/HTTPS listeners, and discovery uses plaintext UDP. About repeats the server claim. **Fix:** say “no hosted backend or telemetry,” describe local listeners/storage, and scope TLS to application sessions while naming discovery and loopback exceptions.
- [Minor] `glasses/README.md:15`, `:22`: RECHECK remains and signing documentation names the unused Gradle script. Similar markers remain in the other install guides, release notes, and checklist. **Fix:** reconcile against merged implementations, remove markers, and document `rokid.release-signing`.

Observed checks: version consistency, checklist lint (75 required rows), and docs-secret scan passed. Scoped test tail:

```text
ℹ tests 15
ℹ pass 14
ℹ fail 0
ℹ skipped 1
```

Actionlint was unavailable. Gradle/emulator builds were not run in this read-only environment.

VERDICT: NOT READY