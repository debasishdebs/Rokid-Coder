# Rokid-Coder Plan 5: Cleanup, per-kind sounds, OpenClaw

**Goal:** Clear the logged minors from Plans 3–4, make the sound for each alert kind a phone setting (U19), and remove OpenClaw if that breaks nothing (U18).
**Branch:** `rokid-coder/plan-5`, off the `rokid-coder/plan-4` head `36725512`. Tasks run in parallel worktrees (U15), followed by ONE Codex sol review and one fix wave.
**Spec:** the design doc plus the USER DECISIONS U1–U21 in `.superpowers/sdd/MASTER-HANDOFF.md`. Global constraints are the same as Plan 4 (`2026-11-14-plan-4-feedback.md`, "Global Constraints"):
- local commits only
- no Co-Authored-By
- never touch local.properties, ~/.claude, ~/.codex or ~/.rokid-coder
- no adb
- never build :phone-hub
- tests first, with RED captured

Suites:
- agentd: `cd agentd && npm test` (baseline 672)
- plugin: `cd plugins/agents && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ../../gradlew testDebugUnitTest assembleDebug` (baseline 490)

## User decisions behind this plan (2026-11-15)
- **U16:** keep the phone client cert on wss (R168). v1 will be a fresh install anyway.
- **U17:** a stale or unknown pairing gets nothing but a re-pair prompt, "like a website asking you to log in again" (R169 confirmed).
- **U18:** remove OpenClaw if that doesn't break functionality; if it would, report what breaks.
- **U19:** errors stay spoken. The sound for every alert state is configurable on the phone.
- **U20:** the R191 chime residual is accepted and checked on the device.
- **U21:** run all of this now.

### Task 1: agentd test infrastructure
- **`test/helpers/daemon.js` `freePort`:** the EADDRINUSE race under parallel load. Bind port 0 and pass the live listener or port through without closing and re-opening it, or retry on EADDRINUSE with a fresh port, at most 5 times.
  - Test: `parallel_daemons_never_collide_on_ports`, which starts 8 daemons concurrently.
- **`test/smoke.js`:** it fails at the `session_upsert` step because the smoke session is never attached. Attach it the way the plugin does (`/rokid:on` hook path, or the attach API used by the tests), so the smoke run passes end to end against a temp state dir.
  - Add `npm run smoke` if it's missing. Never touch the real ~/.rokid-coder or ~/.nexus-agentd.

### Task 2: agentd launcher minors (Plan 3 final-rereview N1–N7, M10, armPairing)
Read `docs/coding-agent/claude/plan/.p3-final-rereview.tmp` (a copy of the Plan 3 final re-review) for N1–N7. Fix each in `agentd/src/launcher/*`, `agentd/src/rk.ts` and `agentd/src/daemon.ts`, with one test each:
- **N1/N2:** a stale `uncertain` is re-sent at bind or rebind. Only send what the launcher currently holds.
- **N3/N6:** kitty-protocol cases, including a non-Latin layout. For Esc and Ctrl-C, match the base-layout key code field, as well as Enter in report-all-keys mode.
- **N4:** a takeover chunk passes through whole. Split at the takeover key.
- **N5:** the R151 bell can break a split OSC. Don't insert anything inside an escape sequence.
- **N7:** Ctrl-C at the `rk codex` hint must abort (exit 130), not start Codex.
- **M10:** prune a session's launcher records on SessionEnd.
- **The hook-forward armPairing owner check:** arming pairing through hook-forward must check the same socket owner/uid as the launcher socket path, and refuse otherwise.

### Task 3: phone minors
- **The `AgentdClient.kt:186-190` race:** the connection loop's generation check and its `publish(CONNECTING)` can race a concurrent `stop()`. Do the check and the publish under `stateLock`.
  - Test: `stop_during_connect_never_leaves_connecting`.
- **Rename `AgentdWire.Result.MonitorOnly` to `NotSecure`,** with its call sites and tests. There is no behaviour change.

### Task 4: the sound for each alert kind as a phone setting (U19)
- **Settings:** in `AlertsCard`, one row per alert state. Each row takes Speak, Chime or Silent.

  | State | Key | Default |
  |---|---|---|
  | Approval | `sound.approval` | Speak |
  | Question | `sound.question` | Speak |
  | Error | `sound.error` | Speak |
  | Done | `sound.done` | Chime |
  | Reminder | `sound.reminder` | Silent (U1) |

  - Each row's sub-line says what it means. "Speak" = `"says '<Name> needs approval'"` (and the same pattern for the other kinds); "Chime" = `"short tone, glasses only"`; "Silent" = `"display only"`.
- **Policy:** `AlertSoundPolicy.sound(kind, provider, reason, prefs)` uses the setting.
  - RETRY, RESUME and UPDATE stay silent always.
  - The existing DND, quiet, volume and worn gates still apply.
  - Chime keeps all of R185/R188/R191 (Bluetooth only, fail closed).
- **Tests:**
  - `each_kind_follows_its_setting`
  - `defaults_match_u3`
  - `reminder_setting_applies_only_to_reminders`
  - `retry_resume_update_always_silent`

### Task 5: OpenClaw — removal if safe (U18)
1. **Investigate first.** List every OpenClaw dependency in plugins/agents: `OpenClawClient.kt`, `OpenClawProtocol.kt`, `Ed25519.kt`, the config keys, `AddComputerActivity` openClawCard, `BoardCards`/`BoardModel` rows, the `AlertBand` v1 attention path (used only by OpenClaw since Plan 4), `AgentsMonitorService`, `ControlMenu`, and `AlertSoundPolicy` names. Check whether anything agentd-related uses them, e.g. Ed25519, the v1 attention engine, or provider enums.
2. **If removal breaks nothing agentd-related:** remove OpenClaw completely.
   - Code, settings UI, config keys, the v1 attention path if it becomes unused, tests that exist only for OpenClaw, and the README/docs mentions.
   - Keep a stored `openclaw.*` pref harmlessly ignored, or clear it once on upgrade.
   - Put it in ONE commit, `Remove the OpenClaw provider`, so it can be reverted alone.
3. **If something agentd-related depends on it:** do NOT remove it. Write the findings (what would break, and the smallest safe path) in the report, and commit nothing for this task.

- Test: the whole plugin suite stays green, and none of the remaining tests reference OpenClaw.
