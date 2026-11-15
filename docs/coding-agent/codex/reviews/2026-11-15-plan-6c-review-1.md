The plan still has Important blockers. No Critical findings. I reviewed the supplied documents and checked the relevant code in the current flat layout; no builds or tests were run.

References below use **6c** for the reviewed plan and **6a** for its READY foundation plan.

**Part 1 — disposition of inherited findings**

| Item | Status | Reason |
|---|---|---|
| Full-rereview #8: service integration ownership | **RESOLVED** | T4 now owns service removal, caller rewiring, foreground lifecycle integration, boot/Stop persistence, and tests driving the callers (6c:68, 87–153). |
| Full-rereview #5: installer consumer | **RESOLVED** | T5 consumes 6a’s install, installed-version, cancellation and result contracts, with verification retained in core (6c:164, 207–224; 6a:141–148). |
| Full-rereview #16: merge strategy consumer | **RESOLVED** | T10 explicitly uses 6a’s merge strategy and maps conflicts to issues rather than PRs (6c:335–351). Execution-interface gaps remain below. |
| Publication after installer jobs AND T13 | **NOT RESOLVED — Important** | The dependency graph requires installer jobs, but the promotion gate does not establish checklist completeness or CI provenance for the selected candidate (finding 6). |
| Combined-review #10: checks prove their claims | **NOT RESOLVED — Important** | Real platform runs are assigned, but sync validation can exercise the wrong revision and the new script checks lack explicit CI execution (findings 4 and 7). |
| Combined-review #11: product and release gates assigned | **NOT RESOLVED — Important** | About/privacy, warnings, connectors and hardware testing have owners; first-run startup and gate enforcement remain incomplete (findings 2 and 6). |

**Part 2 — fresh findings**

1. **[Important] The “exactly Nexus and Tailscale” query assertion breaks required integrations.**  
   Evidence: [6c:270](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:270) requires exactly those queries, while T5 consumes `CxrLAuth.requestAuthorization`. That function first checks Hi Rokid through `getPackageInfo` and returns “not installed” if it is invisible ([CxrLAuth.kt:25](~/Desktop/rokid/Rokid-Coder/phone-hub/src/main/java/com/anezium/rokidbus/phone/CxrLAuth.kt:25)). The Android speech implementation also queries recognition services. Android documents manifest queries for [speech recognition](https://developer.android.com/reference/android/speech/SpeechRecognizer) and [TTS](https://developer.android.com/reference/android/speech/tts/TextToSpeech).

   **Fix:** define an allowlist retaining Hi Rokid/CXR and Android speech discovery, alongside Nexus and Tailscale. Reject plugin-discovery queries specifically. Add device checks for authorization and speech discovery; the current Robolectric fakes bypass these dependencies.

2. **[Important] First-run onboarding can reach GLASSES without starting the service.**  
   Evidence: [6c:115](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:115) starts the service only on process `ON_START`, conditional on onboarding permission. [6c:172](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:172) makes that condition true at GLASSES. Moving through screens while the app stays foreground does not generate another process `ON_START`; [ProcessLifecycleOwner](https://developer.android.com/reference/androidx/lifecycle/ProcessLifecycleOwner) reports process foreground transitions. Thus the initial event is rejected at WELCOME, with no specified startup when GLASSES begins.

   **Fix:** explicitly start/await `CoderService` when a visible onboarding activity transitions into GLASSES. Test WELCOME → permissions → GLASSES without backgrounding the app, asserting the real startup path runs before CXR operations.

3. **[Important] Microphone release behavior is undefined for the persistent voice entitlement.**  
   Evidence: [6c:125](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:125) exposes `releaseMicrophone()` but specifies only `ensureMicrophone()`. Existing STT cleanup invokes release ([AndroidSttSession.kt:616](~/Desktop/rokid/Rokid-Coder/phone-hub/src/main/java/com/anezium/rokidbus/phone/speech/AndroidSttSession.kt:616)); upstream release clears the request and updates foreground types ([BusHubService.kt:4955](~/Desktop/rokid/Rokid-Coder/phone-hub/src/main/java/com/anezium/rokidbus/phone/BusHubService.kt:4955)). Retaining that behavior can remove the microphone type after the first utterance, leaving subsequent background voice dependent on a promotion that Android can reject. The spec requires access to persist while this service runs.

   **Fix:** distinguish the app-open microphone entitlement from an individual STT session’s acquisition. Define product `releaseMicrophone()` accordingly while preserving upstream-shell behavior. Test two complete push-to-talk sessions after backgrounding, plus cancellation/error cleanup, on a current Android emulator.

4. **[Important] Upstream-sync inputs and validation revisions are not connected end to end.**  
   Evidence: [6c:336](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:336) introduces `upstream_ref`, and Step 4 requires synthetic refs. But [6a:92](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6a-foundation-pairing.md:92) fixes the script command to `upstream main`; T10 neither owns that script nor defines parameter forwarding. At 6c:342 only `tests.yml` explicitly receives the merged branch; propagation through `upstream-validation.yml` and nested emulator/Windows calls is unspecified. Reusable workflows retain the caller’s event SHA unless checkout is explicitly overridden. [GitHub documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

   **Fix:** assign script parameterization to T10, define URL/ref arguments, output the immutable merge SHA, and pass it through every validation checkout. Test the selected synthetic ref and assert every job reports that merge SHA.

5. **[Important] Dispatch is not a fallback while the workflows are absent from the default branch.**  
   Evidence: [6c:337](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:337) says sync can run by dispatch until `release/1.0.0` becomes default. The same dependency affects `publish-release`. GitHub requires the dispatch workflow to exist on the default branch; the untouched upstream `main` lacks these workflows. [GitHub dispatch rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

   **Fix:** make default-branch/workflow registration a required controller prerequisite before T10’s dispatch checks and T13 publication, rather than an optional scheduling setup.

6. **[Important] The promotion gate accepts incomplete hardware evidence and does not verify candidate CI provenance.**  
   Evidence: [6c:324](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:324) checks all *present* required rows, explicitly checking presence only for Windows-session rows. Removing another required row—or changing `Required` to `no`—can pass. Any READY review under the directory qualifies, including an unrelated 6a review. Publication verifies draft checksums but not that the selected draft came from the successful installer/install-test run. The negative fixtures at 6c:369 do not exercise these cases.

   **Fix:** validate against a fixed required-ID/platform/CLI schema; reject missing, duplicate or downgraded required rows. Bind the final review to the 6c implementation and the candidate to its successful release run, commit and asset digests. Add negative fixtures for omitted matrix cells, unrelated READY reviews and missing/failed installer provenance.

7. **[Important] The new release and sync script tests have no explicit CI job.**  
   Evidence: [6c:363](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:363) assigns `node --test scripts/test`, TestKit and actionlint checks. The `tests.yml` jobs at 6c:355–360 cover computer, Android, emulator and Windows suites without explicitly running these new checks. `release.yml` also has no dependency on a successful product/script suite run for its candidate SHA.

   **Fix:** add an owned CI job for repository-script tests and workflow lint, explicitly include the TestKit checks, and require successful candidate suites before creating/promoting the draft. Record these jobs in T10 Step 4.

8. **[Important] Pairing recovery can strand an already-paired first computer.**  
   Evidence: [6c:174](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:174) resumes PAIRING at FINISH_ON_COMPUTER. Completion at 6c:192–198 requires a secure-link event for a machine absent from the window’s baseline. If credentials become durable and the process dies before onboarding records completion, that computer is now “known”; reconnect cannot satisfy the rule. The QR path also lacks an explicit baseline capture when no window opens.

   **Fix:** persist the onboarding attempt/baseline before either pairing path and retain the successfully paired machine identity across process death. Resume by accepting an authenticated reconnect for that completed onboarding attempt. Test crashes between credential persistence, secure-link notification and onboarding persistence, plus direct QR entry.

9. **[Important] Tailscale’s “current secure links” input has no defined producer.**  
   Evidence: [6c:198](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:198) produces a connection-event `SharedFlow`, while 6c:228–231 consumes a current-link collection and promises “Connected” only while a tailnet link exists. No disconnect/removal or initial snapshot contract is assigned. A late subscriber can miss the connection; retaining events can leave stale Connected status.

   **Fix:** expose an active secure-link `StateFlow` keyed by transport/connection identity, remove entries on disconnect, and clear it on Stop. Test late subscription, disconnect, reconnect and simultaneous LAN/tailnet links.

10. **[Minor] The blanket statement about token-created PRs is outdated.**  
    Evidence: [6c:342](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:342) says a PR created using `GITHUB_TOKEN` triggers no workflow. Current GitHub documentation says certain PR events create approval-required runs. Inline suites remain a valid design; release-event recursion suppression remains valid. [GitHub token behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)

    **Fix:** update the rationale and define how redundant approval-required PR runs are handled.

The wave ordering resolves the earlier T4/T5 manifest and caller conflicts, and T10 follows installer integration. The direct activity notification intent avoids a notification trampoline; connected-device-only boot startup follows the intended platform model. Those improvements do not remove the blockers above.

VERDICT: NOT READY