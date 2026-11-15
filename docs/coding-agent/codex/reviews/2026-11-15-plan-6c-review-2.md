Important blockers remain; no Critical findings. I checked the current flat-layout sources against the post-6a contracts. No builds or tests were run.

References: **6c** = `docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md`; **6a** and **6b** = the supplied sibling plans.

**Part 1 — disposition of previous findings**

| Item | Status | Reason |
|---|---|---|
| Review-1 #1: package queries | **RESOLVED** | The allowlist retains Hi Rokid/CXR and speech discovery, with real-device authorization and speech checks (6c:253–261, 303). |
| Review-1 #2: first-run service startup | **RESOLVED** | GLASSES explicitly starts the service and awaits readiness without requiring another process foreground event (6c:199, 287). |
| Review-1 #3: microphone release | **RESOLVED** | Product entitlement persists until service end; normal completion, cancellation and errors have explicit coverage (6c:130–153). |
| Review-1 #4: sync inputs and validation revision | **NOT RESOLVED — Important** | Arguments and SHA propagation are assigned, but applying the revision to **every** checkout breaks the separate CxrGlobal checkout; see finding 1. |
| Review-1 #5: default-branch prerequisite | **RESOLVED** | P1 is mandatory before dispatch verification and publication (6c:398, 489–490). |
| Review-1 #6: promotion evidence and provenance | **NOT RESOLVED — Important** | Schema and provenance checks are substantially improved, but stale ancestor execution reviews still qualify; see finding 5. |
| Review-1 #7: script checks in CI | **RESOLVED** | `tests.yml` explicitly runs Node script tests, both build-logic plugins’ tests and actionlint; candidate suites gate draft creation (6c:336, 349, 393). |
| Review-1 #8: pairing crash recovery | **RESOLVED** | A baseline is persisted before either path, and authenticated reconnect completes the interrupted attempt (6c:204, 211–217, 295–296). |
| Review-1 #9: current secure-link state | **RESOLVED** | StateFlow ownership, connection keys, close handling, clearing and late-subscription tests are specified (6c:213–217, 297–298). |
| Review-1 #10: token-created PR behavior | **RESOLVED** | The rationale acknowledges approval-required PR runs and assigns inline suites as the evidence (6c:378). |
| Full-rereview #8: service integration ownership | **RESOLVED** | T4 owns service removal, callers, lifecycle integration, boot/Stop persistence and caller tests (6c:68, 87–165). |
| Full-rereview #5: installer consumer | **RESOLVED** | T5 consumes 6a’s verified local-file install, version, cancellation and result contracts (6c:176, 230–245; 6a:141–148). |
| Full-rereview #16: merge-strategy consumer | **RESOLVED** | T10 extends the merge script and assigns conflict reporting and suite-failure handling (6c:368–390). |
| Release gates: installer jobs AND T13 | **NOT RESOLVED — Important** | The required promotion schema omits 6b’s mandatory macOS minimum-OS gate; see finding 4. |
| Combined #10: checks prove their claims | **NOT RESOLVED — Important** | Dependency checkout assertions, reusable-workflow provenance fixtures and the voice emulator test still have substantive gaps; see findings 1, 3 and 7. |
| Combined #11: product/release gates assigned | **NOT RESOLVED — Important** | First-run boot eligibility and mandatory installer evidence remain incomplete; see findings 4 and 6. |

**Part 2 — fresh review**

1. **[Important] “Every checkout” would replace CxrGlobal’s pinned revision with a Rokid-Coder commit.**

   Evidence: [6c:376](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:376) requires every checkout in the reusable workflows to use `inputs.ref || github.sha`; its static test repeats that requirement at 6c:411. However, the existing [tests.yml:32](~/Desktop/rokid/Rokid-Coder/.github/workflows/tests.yml:32) separately checks out `Anezium/CxrGlobal`. The plan also requires that dependency to remain pinned to its own SHA (6c:52).

   A product merge SHA generally does not exist in the CxrGlobal repository. Following the stated rule therefore breaks validation, while the named static test rewards that breakage.

   **Fix:** apply revision propagation only to checkouts of this repository. Preserve explicitly pinned dependency checkouts. Test both rules, and report the product checkout SHA separately from dependency SHAs.

2. **[Important] Draft creation requires an asset that it has not generated yet.**

   Evidence: `SHA256SUMS` belongs to `release-assets.txt` and is produced by `draft` (6c:323–330). [6c:350](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:350) then requires downloading **every** listed asset and failing on any missing asset, before generating `SHA256SUMS` on the next line.

   **Fix:** distinguish downloaded inputs from generated outputs in the asset manifest. Download producer artifacts, generate checksums over the payload files, then verify the final upload set. Add a successful draft-assembly fixture that begins without `SHA256SUMS`, alongside the missing-payload negative case.

3. **[Important] Promotion checks caller job IDs as though they were REST job records.**

   Evidence: [6c:362](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:362) requires API-visible successful jobs named `suites`, `android-install`, `macos` and `windows`. Those are reusable-workflow calls (6c:336, 343, 348), whose executed jobs are expanded child jobs, including nested workflows and matrix variants—not standalone runner jobs for those caller keys. The [jobs API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run) returns execution job records; [reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows) can contain multiple jobs and matrices.

   The fake-`gh` success fixture at 6c:409 can therefore pass with a response shape that a real release run never produces, leaving every real promotion rejected.

   **Fix:** define stable names for the required expanded jobs and matrix cells, or create explicit non-reusable summary jobs that validate all child outcomes. Validate paginated API responses against that contract. Capture a real release-run response for the provenance fixture and test a missing/skipped child and missing architecture.

4. **[Important] The publication schema drops 6b’s mandatory macOS gate.**

   Evidence: [6c:356](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:356) builds the schema from T11’s IDs and the Windows-session rows. T11 includes no macOS minimum-OS rows (6c:452–481). Yet [6b:502](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6b-installers.md:502) defines M1–M3—macOS 13 GUI installation, x64 runtime under Rosetta, and macOS 12 refusal—and explicitly prohibits publication without their passing results at 6b:507.

   Hosted installer jobs and the ordinary real-Mac install row do not establish those minimum-OS claims.

   **Fix:** carry M1–M3 into the fixed required schema, either as checklist rows or through a strictly parsed gate document. Bind their results to tested candidate lineage. Add fixtures rejecting missing, blank and failed macOS gate evidence. Preserve 6b’s distinction that Windows W1–W8 are mandatory while W9 controls the optional launcher feature.

5. **[Important] An ancestor READY review does not prove that the candidate’s code was reviewed.**

   Evidence: [6c:360](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:360) accepts any suitably named execution review whose reviewed commit is an ancestor of the candidate. A READY review of commit A still passes after an unreviewed implementation change B. The negative fixtures reject unrelated or non-ancestor reviews, but do not reject this case (6c:407).

   That fails to enforce T13’s requirement for a replacement review after fix waves (6c:503), even when candidate builds and hardware smoke tests succeed.

   **Fix:** require cumulative execution-review coverage of the candidate’s implementation tree. Permit subsequent differences only in a narrow list of review/checklist evidence files, or validate explicitly reviewed commit ranges. Add a negative fixture containing a valid ancestor READY review followed by an unreviewed code change.

6. **[Important] First-run GLASSES startup does not establish boot eligibility.**

   Evidence: [6c:117](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:117) assigns `everStartedFromForeground = true` to the process foreground observer, conditional on onboarding allowing startup. The first foreground event happens at WELCOME, where that condition is false. GLASSES later calls `startFromForeground` directly (6c:199), but that method’s contract only starts/promotes the service (6c:100).

   A user can finish initial onboarding and reboot without another process foreground transition. The boot receiver then sees `everStartedFromForeground == false` and starts nothing (6c:110), contrary to the specified connected-device-only boot behavior.

   **Fix:** make an accepted `startFromForeground` centrally persist foreground-start eligibility and clear the user-stop flag. Add a test covering fresh storage → WELCOME → GLASSES → DONE → reboot, with no intermediate background/reopen. Assert that boot starts connected-device only.

7. **[Important] The emulator voice test supplies audio through the wrong source.**

   Evidence: [6c:164](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:164) proposes two HubCore STT sessions using the emulator’s virtual microphone and asserts that both record audio. The actual implementation forwards incoming glasses PCM through [SpeechSessionManager.kt:392](~/Desktop/rokid/Rokid-Coder/phone-hub/src/main/java/com/anezium/rokidbus/phone/speech/SpeechSessionManager.kt:392), and supplies a descriptor through `RecognizerIntent.EXTRA_AUDIO_SOURCE` in [AndroidSttSession.kt:338](~/Desktop/rokid/Rokid-Coder/phone-hub/src/main/java/com/anezium/rokidbus/phone/speech/AndroidSttSession.kt:338).

   Virtual phone-microphone audio does not exercise that supplied PCM path. The test also needs a defined recognizer on the chosen image; its presence and support cannot be inferred from the image name.

   **Fix:** inject deterministic audio through the glasses transport seam into the real STT pipeline. Specify the recognizer/service setup and observable successful session completion. Separately assert the platform foreground-service type across backgrounding, cancellation, error and both sessions. Keep real speech-engine compatibility in the hardware gate.

8. **[Important] An existing final tag can point publication at the wrong source commit.**

   Evidence: [6c:364](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6c-onboarding-release.md:364) relies on `gh release create --target <rc commit>` to associate the final release with the tested commit. GitHub uses `target_commitish` when creating a new tag; it is ignored when the tag already exists. See the [release creation API](https://docs.github.com/en/rest/releases/releases#create-a-release).

   The plan explicitly anticipates someone pushing a final tag (6c:334). Rejecting that tag’s build leaves the tag present, so later promotion can attach tested RC assets to a different commit.

   **Fix:** before publication, refuse an existing final tag unless its peeled commit equals the tested RC commit. Also refuse an existing final release unless following an explicitly verified retry path. Add a fake-`gh` fixture for an existing final tag pointing elsewhere.

VERDICT: NOT READY