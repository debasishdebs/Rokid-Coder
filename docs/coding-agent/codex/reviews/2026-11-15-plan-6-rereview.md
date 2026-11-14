1. **RESOLVED** — T2 restores `phone-core`, defines host ownership, and requires a reviewed ADR before implementation.
2. **RESOLVED** — T6 explicitly requires SAS on QR/pairing-line fallback; no bypass remains.
3. **RESOLVED** — T6 assigns both admission paths, ordered frames, TLS fingerprints, confirmation IPC, competing-peer rejection, and abort tests.
4. **NOT RESOLVED** — The ownership table excludes required edits: T3’s caller-test APK, T5’s Gradle asset-generation wiring, and T8’s `rk` gate; T3 also requires the emulator job before T10 produces it.
5. **RESOLVED** — T2 requires every SDK interaction, callback, lifecycle, and cancellation contract to have an ADR-defined replacement.
6. **RESOLVED** — T1 retains `:kadb-compat` and upstream module names, and compares test identities/outcomes including phone-hub, ink-engine, and transport tests.
7. **NOT RESOLVED** — T12 owns only the phone-core constants file, preventing replacement of identity literals in phone-core consumers such as the relocated `GlassesManualArmRunner`.
8. **RESOLVED** — T7b moves prerequisites to `installation-check` and specifies console-user setup, plugin installation, LaunchAgent startup, and pairing.
9. **NOT RESOLVED** — T7a now produces Linux x64, but T8 cannot implement its Windows launcher gate within its assigned files.
10. **NOT RESOLVED** — The separate caller APK and real release runs are added, but T7b still treats removing CLT from `PATH` as the clean-machine gate; T8 permits skipping WSL execution.
11. **RESOLVED** — T5/T7b/T11 own the missing product copy and privacy work; T13 explicitly blocks publication on the hardware matrix.

New **Important** problems:

- **New Gradle modules have no registration owner, and glasses naming conflicts.** After T1, nobody owns root `settings.gradle.kts` to register `:phone-core`, `:mobile:app`, the caller APK, or the glasses app. The suite requests `:glasses:app`, while T12 produces `:glasses-app`. Assign registration and use one module name throughout. ([Plan:54](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6-v1.md:54), [ownership:64](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6-v1.md:64))

- **Identity constants have no viable glasses-side consumption contract.** T12 puts every identity in the Android phone-core library, but also requires glasses sources, manifests, and scripts to consume them. Define a shared build/source input and manifest substitutions; no task produces that bridge. ([Plan:353](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6-v1.md:353))

- **Pairing confirmations are not bound to an attempt.** `pair_confirm{ok}` has no attempt identifier, while status reaches every attached client. A delayed confirmation from an aborted attempt can approve a subsequent attempt. Include an attempt identifier in status/confirmation and reject stale confirmations. ([Plan:236](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6-v1.md:236))

- **WSL setup consumes macOS-only steps.** T8 explicitly imports T7b’s steps 1–7 “exactly,” including LaunchAgent bootstrap; WSL cannot execute `launchctl`. Define Windows-specific setup with scheduled-task startup and explicit Linux bundle placement. ([Plan:314](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6-v1.md:314))

VERDICT: NOT READY