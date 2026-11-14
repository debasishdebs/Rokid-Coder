# Rokid-Coder Plan 2: Phone + Glasses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Nexus Agents phone plugin and the glasses hub speak agentd's protocol v2, so the glasses can do all of these for attached Claude Code and Codex sessions:
- show the board and the alerts
- take approvals, questions and voice follow-ups
- change mode, model and effort, compact, and show context
- follow phone DND

Steering happens only over pinned TLS.

**Architecture:**
- **Phone plugin (`plugins/agents`):** gains a v2 codec, a pure alert coordinator that mirrors agentd's queue (one alert on the glasses, dedupe by id, "shown" acks), a pure board/menu model, voice capture over the Nexus `stt` capability, a TLS server for the daemon-dials-phone path, a pinned TLS client for the pairing path, and Compose/Material3 settings.
- **Glasses hub:** holds the display for Agents approval and question bands.
- **Shared, bus-client and glasses-hub:** gain a capability-gated `/notice/shown` ack.
- **Phone hub:** its half of the ack is written as a task but deferred, because `:phone-hub` can't be built on this machine.

**Tech Stack:** Kotlin, Android (Agents minSdk 30 / targetSdk 36; glasses-hub minSdk 31 / targetSdk 32), AGP 9.2.0, Gradle 9.5.1 wrapper, Java 17 toolchain, JUnit4 (Robolectric only where the module already uses it), OkHttp 4.12.0, Jetpack Compose + Material3 (new in the Agents plugin), and the Nexus SDK (`:bus-client`).

**Spec:** `docs/coding-agent/claude/design/2026-11-14-rokid-coder-design.md` (§3 goals, §6 glasses/phone, §7 Material rule, §11/§11a, §12 contracts).

**Wire authority:** `agentd/src/protocol-v2.ts`.

**Evidence:**
- `docs/coding-agent/claude/brainstorm/2026-11-14-compat-glasses-phone.md`
- Recon `docs/coding-agent/claude/brainstorm/2026-11-14-plan-2-recon.md`
- Codex stand-in decisions `docs/coding-agent/codex/reviews/2026-11-14-plan-2-decisions.md` (ledger R31–R38)

## Global Constraints

**Build**
- Branch `rokid-coder/plan-2`, created from the final head of `rokid-coder/plan-1` (R26). Local commits only. Never push.
- Agents plugin build (a standalone Gradle root): `cd plugins/agents && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ../../gradlew testDebugUnitTest assembleDebug`. The baseline is 43 tests, all green.
- Other module builds:
  - `./gradlew :shared:test`
  - `./gradlew :bus-client:testDebugUnitTest`
  - `./gradlew :glasses-hub:testDebugUnitTest`. Its baseline is 957/959: two pre-existing `GlassesFileStoreTest` failures. Report them; never "fix" them here.
- `:phone-hub` can't be built here, because `../CxrGlobal` is absent. No task may claim a phone-hub build result. Task 13 is deferred (R33).
- Never create, edit or regenerate `local.properties`. No private Gradle home, SDK or cache in the tree. On an environment failure, stop and report BLOCKED with the real output tail.

**Repo rules**
- Commit messages are imperative, in English, with **no AI attribution and no `Co-Authored-By` trailer** (repo AGENTS.md overrides any harness reminder).
- Match the surrounding code's naming and comment density. Don't restyle code you didn't touch.

**Overnight limits (R25)**
- No `adb install`, no device interaction beyond `adb devices`, no GitHub actions, no edits to `~/.claude` or `~/.codex`.

**Wire**
- Frames and fields exactly as in `agentd/src/protocol-v2.ts`.
- Every phone→agent steering frame carries `msgId` = `UUID.randomUUID().toString()`, at most 128 chars, made once per user action and reused on resend.
- Steering frame types: `approval_decision, session_input, thread_start, alert_action, followup, question_answer, mode_set, mode_revoke_all, codex_settings, codex_compact, defaults_set, settings_sync`.
- Monitor frame types: `alert_shown, alert_dismissed, models_request`, plus the v1 monitor frames. `settings_sync` is steering (R61).
- `followup.text` is at most 16 KiB of UTF-8.

**Security**
- A link is steering-capable only if it is TLS with a verified pin. Plaintext links are monitor-only, and the UI must say so ("Monitor only — approve on laptop") and not offer steering.
- A pinned peer never downgrades. A TLS failure or a later plaintext announcement is refused visibly.
- Never log tokens, pairing lines, transcripts, STT text or follow-up text.

**Defaults (phone settings)**, the same values agentd uses in `agentd/src/phone-settings.ts`:
- Age boost 30 s, dwell 8 s, ack timeout 5 s, retry backoff 5/10/20 s.
- Reminder *X* 5 min. Wait limit *Y* 30 min (1800 s). Expire = *Y*.
- Floors: timings ≥ 1 s, reminder ≥ 30 s, wait limit 30 s … 1 h. On the phone, `expireMs` is always set equal to `waitLimitMs` (R29).
- Digest cadence 60 s by default; "Live" is the option.
- Default approval mode is `ask` for both tools.

**SDK limits**
- Notice: title ≤ 32, footer ≤ 40, ≤ 3 actions, action label ≤ 16.
- Card: title ≤ 120, line/sub ≤ 240, badge ≤ 24, ≤ 8 trail entries × 24, ≤ 64 rows, `contentKey` ≤ 128 (hash it).
- Reader: ≤ 240 segments × 4096 chars, 40 000 chars total.
- SDK constructors throw on overflow, so every builder truncates first.

**UI**
- Phone screens use Compose + Material3 with PCA's light mint theme and settings widgets (R31; source `~/Desktop/rokid/proactive-context-agent/android-companion/core/ui/.../theme/PcTheme.kt` and `phone/.../ui/settings/SettingsWidgets.kt`).
- The glasses use hub-rendered `NexusCard`/`NexusReader`/`NexusNotice` only, following PCA's HUD language of brightness tiers mapped to `NexusRowTone`.

**Copy (exact strings)**
- Badges: `CLAUDE`, `CODEX`.
- Mode tags: `PLUGIN`, `LAUNCHER`.
- Temp mode tags: `ASK`, `EDITS`, `ALL`.
- Greyed-out controls: `needs rk claude`.
- Monitor-only banner: `Monitor only — approve on laptop`.
- Follow-up at the cap: `continue on laptop or rk claude`.
- Reset notice: `Approve-all off — <session>: session ended` and `Approve-all off — <session>: helper restarted`.

## Review Focus

1. **A burst of alerts:** three alerts arrive while one is on the glasses. The current one stays for the dwell time, the footer shows `+2 waiting`, each new alert sounds once (never once per retry), and an approval preempts anything else. The test goes in Task 3.
2. **Reconnect:** at `LinkUp` (after `hello_ack`, before any later frame) the phone forgets every alert and closes any card bound to one. agentd requeues its former occupant and dispatches by priority, so the former occupant comes back as `resume` when its turn comes. Parked alerts come back one at a time as reminders. The phone never expects a full replay (R28), and an alert closed while it was away never comes back. The tests go in Tasks 2 and 3.
3. **A plaintext (monitor-only) link:** agentd sends v2 alerts and approval frames only to TLS phones (R40). A plaintext phone must not go silent. It keeps using the v1 `AttentionDecisionEngine` path on session status (NEEDS_YOU/ERROR), with body `Monitor only — approve on laptop` and no actions. Any steering attempt returns `MonitorOnly` without sending. The tests go in Tasks 2 and 4.
4. **STT returns an empty or null final, or `DENIED_BUSY`** (PCA holds the mic): the last partial is used. On busy the card says `Mic busy — try again`, and nothing is sent without an explicit ENTER confirm. The test goes in Task 7.
5. **A malformed pairing `fp`, or a pin mismatch:** the connection is refused with a visible state and never silently treated as legacy plaintext. The test goes in Task 10.
6. **Scope note (ruling R39):** design §12.2 says later alerts are "reached by swiping". In v1 the phone shows only the `+N waiting` count, because agentd sends one alert at a time and the phone never holds the waiting ones. The sessions sorted as NEEDS_YOU on the board show who is waiting. Swiping through queued alerts would need a new agentd frame, so it is deferred.

---

### Task 0: Compose + Material3 in the Agents build, and the theme

**Files:**
- Modify: `plugins/agents/build.gradle.kts`, `plugins/agents/settings.gradle.kts` (plugin management only if needed)
- Create:
  - `plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/ui/theme/AgentsTheme.kt`, ported from PCA `PcTheme.kt`: colours, typography, shapes; light only.
  - `plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/ui/SettingsWidgets.kt`, ported from PCA: `SettingsPage`, `SettingsCard`, `SwitchRow`, `ChoiceRow`, `TextFieldRow` (keeps the `secret` flag), `NoticeText`, `PrimaryAction`, `SecondaryAction`, `SectionLabel`.
- Test: `plugins/agents/src/test/java/com/anezium/rokidbus/plugin/agents/ui/AgentsThemeTest.kt`

**Interfaces:**
- Produces: `@Composable fun AgentsTheme(content: @Composable () -> Unit)`, plus the widget signatures exactly as in PCA's `SettingsWidgets.kt`. Later tasks call them by those names.

- [ ] **Step 1: Spike, time-boxed to 30 minutes.**
  - Add the Compose compiler plugin pinned to the Kotlin version AGP 9.2.0 uses as built-in. Read it from `./gradlew -q :buildEnvironment` or the resolved KGP in the Gradle cache. Don't copy PCA's 2.0.21.
  - Add `buildFeatures { compose = true }`, `platform("androidx.compose:compose-bom:2024.09.00")`, `material3`, `activity-compose:1.9.2`, and `lifecycle-runtime-compose:2.8.5`.
  - Raise Java to 17 only if the compiler requires it.
  - Run the build command. If it doesn't configure within the time box, stop and report `DONE_WITH_CONCERNS`, with the error tail and the fallback ruling R31 (NexusUi Views with the same section structure). The controller re-plans Task 9.
- [ ] **Step 2: Write the failing test** `agents_theme_uses_pca_palette`. It asserts that the colour constants equal PCA's: `Mint 0xFF14C3A2`, `MintDeep 0xFF0E9F86`, `Sky 0xFF3D8BFF`, `Ink 0xFF15181D`, `InkSoft 0xFF6B7280`, `Line 0xFFECEFF3`, `SurfaceSoft 0xFFF6F8FA`. Keep the constants in a plain `object AgentsColors` so the test needs no Compose runtime.
- [ ] **Step 3:** Port the theme and widgets.
- [ ] **Step 4:** Run the build command. Expected: 44 tests pass, `assembleDebug` succeeds.
- [ ] **Step 5: Commit** `build(agents): add Compose and Material3 with the PCA theme and settings widgets`

---

### Task 0b: agentd wire additions Plan 2 depends on

**Files:**
- Modify: `agentd/src/protocol-v2.ts`, `agentd/src/alerts.ts`, `agentd/src/phone-v2.ts`
- Test: `agentd/test/alerts.test.js`, `agentd/test/phone-v2.test.js`

**Interfaces:**
- `AlertFrame` gains `reason: "new" | "retry" | "reminder" | "resume" | "update"`. Each value is set at the one place it arises:
  - `"new"`: the first dispatch of an id.
  - `"retry"`: a `retryUnacked` re-transmit.
  - `"reminder"`: a dispatch after `remind()` requeued the alert, including parked ones.
  - `"resume"`: a dispatch after a preemption requeue or a `linkUp()` requeue.
  - `"update"`: a waiting-count change, below.
- **Waiting-count updates:** when `waitingCount()` changes while the slot is occupied, agentd re-sends the current alert frame with `reason: "update"` and the new `waiting`. This does not touch `attempts`, `state` or `lastSentAt`. That way `+N waiting` reaches the glasses within the 5 s target even for an alert that is acknowledged and dwelling (design §12.2).
- **New steering frame `launcher_command`:** `{type, v:2, sessionKey, command: "compact" | "model", model?: string, msgId}`.
  - Add it to `FRAME_CLASS` as steering.
  - The handler answers `ack rejected error=not_launcher` for every session until Plan 3 implements it. The phone can then be built against the final shape now.
- `onShown(id)` stays as it is: it is accepted only while the alert is in state `sent`. The phone therefore sends `alert_shown` once per display episode (see Task 3), not once per id.

- [ ] **Step 1: Write failing tests.**
  - `first_dispatch_reason_new`
  - `retry_reason_retry`
  - `reminder_after_dwell_reason_reminder`
  - `parked_alert_comes_back_reason_reminder`
  - `preempted_alert_resumes_reason_resume`
  - `link_up_requeue_reason_resume`
  - `waiting_change_resends_current_with_update_and_keeps_state`
  - `launcher_command_is_steering_and_rejected_not_launcher`
- [ ] **Step 2:** Run `cd agentd && npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(agentd): tell the phone why an alert is sent, push waiting-count changes, reserve launcher_command`

---

### Task 1: The v2 codec and session fields

**Files:**
- Modify:
  - `plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/AgentdProtocol.kt`
  - `AgentModels.kt`
  - `AgentSessionStore.kt`, only to keep the new fields through `upsert`/snapshot.
- Create:
  - `contracts/rokid-coder-v2.fixtures.json`: one example per v2 frame in each direction, keyed by type.
  - `plugins/agents/src/test/java/.../AgentdProtocolV2Test.kt`
  - `agentd/test/fixtures-contract.test.js`

**Interfaces:**
- Produces, in `AgentModels.kt`:
  ```kotlin
  enum class TempMode(val wire: String) { ASK("ask"), ACCEPT_EDITS("acceptEdits"), APPROVE_ALL("approveAll") }
  enum class FollowupState(val wire: String) { WAITING("waiting"), UNAVAILABLE("unavailable"), CAP_REACHED("cap_reached"), READY("ready") }
  data class SessionV2(
      val mode: String, // "plugin" | "launcher"
      val canCompact: Boolean, val canModel: Boolean, val followup: FollowupState,
      val tempMode: TempMode, val nativeMode: String?, val heading: String,
      val currentFile: String?, val step: String?,
      val contextUsed: Long?, val contextWindow: Long?,
      val pendingModel: String?, val pendingEffort: String?, val sandbox: String?,
  )
  // AgentSession gains: val v2: SessionV2? = null
  ```
- New `AgentdAction` variants:
  ```kotlin
  data class Alert(val id: String, val sessionKey: String, val kind: AlertKind, val title: String, val body: String, val actions: List<String>, val question: QuestionPayload?, val waiting: Int, val reason: AlertReason)
  // enum AlertReason { NEW, RETRY, REMINDER, RESUME, UPDATE } (Task 0b); a missing reason parses as NEW
  data class AlertClosed(val id: String, val reason: String)
  data class Ack(val msgId: String, val result: String, val error: String?)
  data class FollowupClosed(val sessionKey: String, val reason: String)
  data class ModeReset(val sessionKey: String, val from: TempMode, val reason: String)
  data class Models(val sessionKey: String, val models: List<String>, val efforts: List<String>, val currentModel: String?, val currentEffort: String?)
  data class DetailRejected(val sessionId: String)
  ```
  - `enum AlertKind { APPROVAL, QUESTION, ERROR, DONE, NOTICE }`
  - `data class QuestionPayload(requestRef, source, items: List<QuestionItem>)`
  - `data class QuestionItem(text, options: List<QuestionOption(label, description?)>, multiSelect, allowFreeText)`
- New builders on `AgentdProtocolCodec`, each returning the JSON line string:
  - `alertShown(id)`, `alertDismissed(id)`, `alertAction(id, action, msgId)`
  - `followup(sessionKey, text, msgId)`, `questionAnswer(sessionKey, alertId, requestRef, answers: Map<String, Any>, msgId)` (values are `String` or `List<String>`)
  - `modeSet(sessionKey, mode, confirmed, msgId)`, `modeRevokeAll(msgId)`
  - `codexSettings(sessionKey, model?, effort?, msgId)`, `codexCompact(sessionKey, msgId)`
  - `defaultsSet(claude, codex, msgId)`, `settingsSync(timings: AlertTimings, waitLimitMs, msgId)`, `modelsRequest(sessionKey)`
  - `launcherCommand(sessionKey, command: "compact"|"model", model?, msgId)` (Task 0b)
- `object FrameClass { fun isSteering(type: String): Boolean }`: the exact copy of `FRAME_CLASS` in `protocol-v2.ts`, plus `launcher_command`. Unknown types count as steering.
- `data class AlertTimings(ageBoostMs, dwellMs, ackTimeoutMs, retryBackoffMs: List<Long>, reminderMs)`. No `expireMs`: agentd derives expire = `waitLimitMs` (R61).

- [ ] **Step 1: Write the fixtures file.**
  - Each phone→agent example must be accepted by agentd.
  - Each agent→phone example must match the TypeScript interfaces field for field.
- [ ] **Step 2: Write the failing Kotlin tests.**
  - `parses_every_agent_to_phone_v2_fixture`: loads the fixtures file through `File("../../contracts/rokid-coder-v2.fixtures.json")` relative to the module dir and asserts each one parses into the matching action with every field.
  - `every_phone_to_agent_builder_matches_its_fixture`: JSON equality, ignoring `msgId` values.
  - `session_upsert_v2_fields_round_trip_into_SessionV2`
  - `v1_session_without_v2_fields_has_null_v2`
  - `unknown_v2_alert_kind_is_ignored_not_crashed`
  - `followup_text_over_16_KiB_is_refused_by_builder`, using `require`: callers truncate or refuse before calling.
  - `alert_title_body_capped_at_MAX_HUD_LABEL_CHARS_and_MAX_HUD_TEXT_CHARS`
- [ ] **Step 3: Write the failing agentd test** `fixtures-contract.test.js`:
  - `fixture_frame_classes_match_exactly`: an explicit expected map, type → `monitor`/`steering`, for every phone→agent fixture. No type may hit the default bucket.
  - `every_phone_to_agent_fixture_is_accepted_by_its_handler`:
    - Start the daemon test harness with a fake phone over real TLS (`createFakePhone({tls:true})`).
    - Attach a Claude and a Codex session, and raise one approval alert and one question alert, so the fixtures' `sessionKey`/`alertId`/`requestRef` placeholders can be bound. The test substitutes the real ids.
    - Send each fixture, and assert the response that frame really produces:
      - **v2 steering:** `ack applied`, except `launcher_command` → `ack rejected not_launcher`.
      - **Legacy `approval_decision`:** `approval_resolved`, or the hook response, for its `requestId`.
      - **`session_input`:** `session_input_result`.
      - **`thread_start`:** `thread_started`.
      - **Monitor frames:** their own effect.
    - Fixtures that consume an alert or approval (`alert_action`, `question_answer`, `approval_decision`) each run against a fresh alert of their own, in isolated subtests.
  - `malformed_fixture_variants_are_rejected`: a missing `msgId`, a wrong `sessionKey`, and `question_answer` over the limits `phone-v2.ts` enforces.
  - `steering_fixtures_rejected_monitor_only_over_plaintext`
  - The Kotlin `FrameClass` table is checked against the same expected map in a Kotlin test, `frame_class_table_matches_fixture_expectations`, which reads the map from the fixtures file key `"_classes"`.
- [ ] **Step 4:** Implement. Use the existing `JSONObject` helpers and caps in `AgentdProtocol.kt`.
- [ ] **Step 5:** Run the Agents build, and `cd agentd && npm test`. Expected: all pass.
- [ ] **Step 6: Commit** `feat(agents): parse and build agentd protocol v2 frames against shared fixtures`

---

### Task 2: The wire boundary: one gate for every write, and inbound routing

**Files:**
- Create:
  - `AgentdWire.kt`
  - `plugins/agents/src/test/java/.../AgentdWireTest.kt`
- Modify:
  - `AgentdLinkServer.kt` and `AgentdClient.kt`: every outbound line, including the existing v1 `approval_decision`, `session_input` and `thread_start` builders, goes through `AgentdWire.write`. Every inbound v2 action goes to `AgentsRuntime.events`.
  - `AgentsMonitorService.kt`: a new `ACTION_SEND_V2` intent carrying a prebuilt frame line.
  - `AgentSessionStore.kt` (`AgentsRuntime`).

**Interfaces:**
- Produces:
  ```kotlin
  class AgentdWire(private val raw: (String) -> Boolean) {
      fun bind(generation: Long, secure: Boolean)      // called once per authenticated connection after hello_ack
      fun unbind(generation: Long)                     // on close, replacement, auth failure; a stale generation is ignored
      sealed interface Result { object Sent : Result; object MonitorOnly : Result; object NoLink : Result }
      fun write(line: String): Result                  // parses "type", FrameClass.isSteering(type) && !secure → MonitorOnly, nothing written
      val secure: StateFlow<Boolean>                   // false whenever unbound
  }
  object AgentsRuntime {
      /* existing */
      val linkSecure: StateFlow<Boolean>
      val events: MutableSharedFlow<AgentdEvent>       // replay = 0, extraBufferCapacity = 256, ordered; emitted from the transport thread in arrival order
  }
  sealed interface AgentdEvent { data class LinkUp(val generation: Long, val secure: Boolean); data class LinkDown(val generation: Long); data class Action(val action: AgentdAction) }
  ```
- **Classification:** it happens at the final write, from the frame's own `type`. No caller passes a steering flag.
- **Trust:** bound to one authenticated connection generation. A disconnect, a replacement or an auth failure unbinds it before any further write.
- **Order:** `LinkUp` is emitted after `hello_ack` and before the first post-hello action, on both transport roles. Alerts flushed by agentd's `linkUp()` therefore always arrive after the phone has cleared its alert state.
- **When the plugin service isn't running:** the monitor service keeps an `AlertCoordinator` (Task 3) itself, so no alert depends on the plugin service being alive. The plugin service renders from the coordinator's `StateFlow` when it starts.

- [ ] **Step 1: Write the failing tests.**
  - `steering_types_on_insecure_binding_return_MonitorOnly_and_write_nothing`: covers every steering type in `FrameClass`, including the v1 ones.
  - `unknown_type_is_steering`
  - `monitor_frames_write_on_insecure_binding`
  - `unbind_then_write_steering_is_NoLink_or_MonitorOnly_never_Sent`
  - `stale_generation_unbind_does_not_clear_new_binding`
  - `secure_to_plaintext_reconnect_blocks_steering`: bind gen 1 secure, unbind, bind gen 2 insecure, then `write(alert_action)` gives MonitorOnly.
  - `link_up_event_precedes_first_action_on_both_transports`: drive `AgentdLinkServer.LinkConnection` over a real local socket, and `AgentdClient` through its existing test seam, or extract the message handler to test it.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): gate every agentd write by frame type and link trust; route v2 events in order`

---

### Task 3: The alert coordinator (pure)

**Files:**
- Create:
  - `AlertCoordinator.kt`
  - `plugins/agents/src/test/java/.../AlertCoordinatorTest.kt`

**Interfaces:**
- Consumes: `AgentdAction.Alert`/`AlertClosed` (Task 1), `SteeringGate` (Task 2).
- Produces:
  ```kotlin
  class AlertCoordinator(private val clock: () -> Long) {
      sealed interface Effect {
          data class Show(val alert: AgentdAction.Alert, val wake: Boolean, val sound: Boolean) : Effect
          data class Update(val alert: AgentdAction.Alert) : Effect                    // same id re-sent: refresh "+N waiting" without re-sounding
          object Hide : Effect
          data class Send(val line: String, val steering: Boolean) : Effect
          data class Brief(val title: String, val body: String) : Effect
          data class Invalidate(val alertId: String) : Effect                          // drop bound decision/question card and voice draft
      }
      fun onAlert(alert: AgentdAction.Alert): List<Effect>
      fun onAlertClosed(id: String, reason: String): List<Effect>
      fun onLinkUp(): List<Effect>                                  // forget every alert (R28)
      fun onShownEvidence(id: String): List<Effect>                 // hub /notice/shown, or interim evidence (R33)
      fun onAction(id: String, action: String, secure: Boolean): List<Effect>
      fun onBandClosed(id: String, reason: NexusNoticeCloseReason): List<Effect>
      val current: AgentdAction.Alert?
  }
  ```
- `onAlert` acts on `alert.reason` (Task 0b). Sound and wake are decided separately.

| reason | band up for this id | band not up |
|---|---|---|
| `NEW`, `REMINDER` | `Show(wake = true, sound = true)`: a fresh band, which replaces the current one, and a new episode with its evidence reset | `Show(wake = true, sound = true)`, new episode |
| `RETRY` | `Update` (same episode; re-send `alert_shown` if this episode has evidence) | `Show(wake = unconfirmed, sound = false)`, new episode |
| `RESUME` | `Update` (same episode) | `Show(wake = unconfirmed, sound = false)`, new episode |
| `UPDATE` | `Update` (refreshes `+N waiting`) | ignored |

- **`unconfirmed`:** this id has no display evidence yet, and the phone hasn't asked for a wake for it in the last 60 s. That gives a bounded fresh wake after a failed or throttled first wake. The glasses hub's own wake budget still applies on top.
- **A display episode** is one band instance, from `showNotice` until that band closes. Evidence belongs to the episode and survives `RETRY`/`RESUME` updates of the same band.
- **`alert_shown`:** sent when the current episode first gets evidence. It is sent again on each `RETRY` that arrives while that episode has evidence, which heals a lost ack (agentd accepts `onShown` only while the alert is `sent`).
- **Display evidence for the current episode (R33):**
  - the hub's `/notice/shown` (Task 12)
  - `/notice/action`
  - `/notice/input`
  - `/notice/closed` with reason `USER`
  - **These never count:** `TIMEOUT`, `REPLACED`, `OWNER`, `DISCONNECT`, and a `SENT` return. The glasses can time out a band that was never attached (R47). So until Task 13 lands, a band nobody touches stays unconfirmed: agentd keeps retrying silently with bounded wakes and doesn't move on to reminders. The device checklist records this as a known interim behaviour.
- **Closes:**
  - `USER` close → `alert_shown` (if this episode hasn't sent it yet), then `alert_dismissed`. agentd parks approvals and questions (R22), and they come back as `REMINDER` under the same id, which is shown normally.
  - `TIMEOUT` close → nothing is sent. The episode ends, and the next `RETRY`/`REMINDER` shows a new band.
- **Actions** are local or wire:
  - **Wire:** `allow`, `deny` → `alert_action {id, action, msgId}`, only when `AgentdWire.secure`. Otherwise `Brief("Monitor only", "approve on laptop")`.
  - **Local:** `more` opens the decision card, `answer` opens the question card, and `later` works as a `USER` dismiss.
  - One `msgId` per (id, action), reused if the same action is retried.
- **Order:** a new id while another is current replaces it. agentd owns dwell and preemption.
- **Invalidation:** `onAlertClosed(id)`, `LinkDown`, the session leaving the board, and `followup_closed` for that session all invalidate any decision or question card or voice draft bound to that id. A late confirm on an invalidated card sends nothing and briefs `No longer waiting`.
- **Link up:** `onLinkUp()` forgets every alert, hides the band, and invalidates bound cards. agentd then requeues its former occupant and dispatches by priority. A higher-priority queued alert may come first. The former occupant comes back as `RESUME` when its turn comes, and parked alerts come back as `REMINDER`. The phone never expects a full replay, or any order beyond agentd's (R28).
- **Footer:** `+N waiting` when `waiting > 0`.

- [ ] **Step 1: Write the failing tests.** Drive them with frames recorded from agentd's real `AlertQueue`: a small Node script `agentd/test/record-alert-sequences.js` writes `contracts/alert-sequences.json`, which the Kotlin test replays. Scenarios: burst, reminder, lost ack, preemption, park→reminder, linkUp.
  - `new_shows_with_sound_retry_updates_silently`
  - `reminder_after_timeout_shows_with_sound` (Review Focus 1)
  - `lost_shown_ack_is_resent_on_retry`
  - `update_reason_refreshes_waiting_without_sound` (Review Focus 1)
  - `preempted_alert_resumes_without_sound`
  - `user_close_sends_shown_then_dismissed_and_reminder_shows_again`
  - `timeout_close_is_not_evidence_and_next_retry_shows_new_band`
  - `failed_first_wake_then_retry_wakes_once_within_60s`
  - `evidence_survives_retry_update_of_same_band_and_reacks`
  - `reminder_while_band_up_reshows_with_sound_and_resets_evidence`
  - `replaced_owner_disconnect_close_never_count`
  - `allow_on_secure_sends_alert_action_once_with_reused_msgId`
  - `more_answer_later_are_local_never_alert_action`
  - `allow_on_insecure_briefs_monitor_only_and_writes_nothing`
  - `alert_closed_invalidates_bound_card_and_late_confirm_sends_nothing`
  - `link_up_forgets_and_hides_then_higher_priority_alert_may_come_first` (Review Focus 2)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): mirror agentd's alert queue with shown, dismissed and bound actions`

---

### Task 4: Notice bands for alerts, wired into the plugin service

**Files:**
- Create:
  - `AlertNotices.kt`, a pure builder.
  - `plugins/agents/src/test/java/.../AlertNoticesTest.kt`
- Modify `AgentsPluginService.kt`:
  - apply `AlertCoordinator` effects
  - override `onNexusNoticeAction` and `onNexusNoticeClosed`
  - route `onNexusNoticeInput` evidence
  - when the link is secure, skip `AttentionDecisionEngine` for agentd providers (keep it for OpenClaw); on a monitor-only link keep it, with body `Monitor only — approve on laptop` (R40)
  - ignore v1 `approval_request` for alerting once any v2 frame has been seen on the link

**Interfaces:**
- Produces: `object AlertNotices { fun build(alert: AgentdAction.Alert, monitorOnly: Boolean, wake: Boolean): NexusNotice }`. `wakeDisplay = wake && kind != NOTICE`. The kind rules below give the default when `wake` is true.
  - **Approval:** `wakeDisplay = true`; actions `allow` "Allow", `deny` "Deny", `more` "More" (glyphs `check`, `close`, `dot`); `ttlMs = 45_000`. Title `CLAUDE · approve` / `CODEX · approve` from the session key provider. Body = `alert.body` capped to 8 measured lines.
  - **Question:** `wakeDisplay = true`; actions `answer` "Answer", `later` "Later"; `ttlMs = 45_000`.
  - **Done / error:** `wakeDisplay = true`; `interactive = true`; no actions; `ttlMs = 12_000`; footer `TAP read`.
  - **Notice:** `wakeDisplay = false`; `ttlMs = 8_000`.
  - **Footer:** `+N waiting` when N > 0, otherwise the kind's footer.
  - **Monitor-only approval:** actions `more` only, body suffixed with `Monitor only — approve on laptop`.
  - Only approval and question bands carry actions. The glasses-hub hold (Task 11) keys on "Agents band with at least one action", so done, error and notice bands never hold. A monitor-only approval keeps its single `more` action and still holds, so the wearer has time to read it.
- Behaviour:
  - `more` opens the decision card bound to the alert id.
  - `answer` opens the question card (Task 7).
  - A done/error tap opens the output reader, summary first: a HEADER segment with `alert.body` (the summary), then the full `lastAssistantText`/conversation as PROSE segments, `anchor = TOP`. That is design goal 6, "short summary first, then the full output in pages".
  - Agentd re-sends are rendered with `updateNotice` when the id is unchanged (no re-wake, no re-sound).

- [ ] **Step 1: Write the failing tests.**
  - `approval_band_wakes_with_allow_deny_more_and_45s_ttl`
  - `question_band_has_answer_later`
  - `done_band_is_interactive_without_actions_and_12s`
  - `notice_kind_does_not_wake`
  - `footer_shows_plus_n_waiting`
  - `titles_and_bodies_never_exceed_sdk_limits_for_long_input` (feeds 10 KB strings; no exception)
  - `monitor_only_approval_has_no_allow_deny`
  - `monitor_only_link_keeps_v1_status_attention_with_approve_on_laptop_copy` (Review Focus 3)
  - `summary_first_reader_segments`
- [ ] **Step 2:** Implement `AlertNotices`, then wire it.
  - The monitor service owns the one `AlertCoordinator` (Task 2).
  - It posts the coordinator's effects through the sibling `AgentsPluginService`, which it already keeps alive for alerts: `Show` → `showNotice`; `Update` → `updateNotice`; `Hide` → `hideNotice`; `Send` → `AgentdWire.write`.
  - Notice callbacks (`onNexusNoticeAction`, `onNexusNoticeClosed`, `onNexusNoticeInput`) go back to the coordinator.
  - Test the full chain with `summary_first_reader_segments` in `AlertNoticesTest`.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): wake the glasses for approvals, questions and Done with id-bound bands`

---

### Task 5: The v2 board and the digest cadence

**Files:**
- Create:
  - `BoardModel.kt`
  - `DigestGate.kt`
  - tests `BoardModelTest.kt`, `DigestGateTest.kt`
- Modify `AgentsPluginService.kt`: `sessionsCard()` uses `BoardModel`; board pushes go through `DigestGate`.

**Interfaces:**
- Produces:
  ```kotlin
  object BoardModel { fun row(session: AgentSession, selected: Boolean, now: Long, waiting: Int): NexusCardLine }
  class DigestGate(private val clock: () -> Long, var periodMs: Long /* 60_000 or 0 = live */) {
      fun shouldPush(previous: List<AgentSession>?, next: List<AgentSession>): Boolean
      fun nextFlushAt(): Long?   // when held changes exist: the time the trailing push is due; the service schedules one delayed render for it
  }
  ```
- Board row:
  - `badge` = `CLAUDE`/`CODEX`.
  - `text` = `v2.heading` falling back to `displayTitle`.
  - `sub` = `currentFile · step`, each part omitted when absent.
  - `trail` = [state (`ASK` when needs_you, `RUN`, `ERR`, `done`), mode tag (`PLUGIN`/`LAUNCHER`), temp tag (`ASK`/`EDITS`/`ALL`), and the native mode when it is permissive (for example `never`)].
  - `ALL` uses tone ALERT, so approve-all is always visible.
- `waiting` (from the current alert's `waiting`) renders as a first board row `+N waiting` (tone ALERT) when N > 0.
- Digest rule: push immediately when a session is added or removed, or its status changes to/from NEEDS_YOU, DONE or ERROR, or `tempMode` changes. Otherwise push at most once per `periodMs`. `periodMs == 0` means live. The open HUD board always shows the latest on user input.

- [ ] **Step 1: Write the failing tests.**
  - `row_shows_badge_heading_file_step_and_mode_tags`
  - `approve_all_row_is_alert_tone_with_ALL_tag`
  - `plugin_mode_claude_row_tag_PLUGIN`
  - `digest_holds_progress_updates_for_period`
  - `digest_pushes_status_change_to_done_immediately`
  - `live_mode_pushes_everything`
  - `row_strings_capped_for_sdk`
  - `held_change_is_flushed_at_period_end_even_without_new_traffic`: clock test using `nextFlushAt`
  - `waiting_row_shown_when_n_positive`
- [ ] **Step 2:** Implement and wire.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): v2 board rows with tool badge, file, step and mode tags; minute digest`

---

### Task 6: Session control menu

**Files:**
- Create:
  - `ControlMenu.kt` (pure model + key handling)
  - `ControlMenuTest.kt`
- Modify `AgentsPluginService.kt`: ENTER on a board row opens the control menu (today it opens the conversation; the conversation becomes the menu row `Read output`). Handle the `models` frame and pending settings.

**Interfaces:**
- Produces:
  ```kotlin
  sealed interface MenuItem { val label: String; val sub: String?; val enabled: Boolean }
  // items, in order: Reply by voice · Approval mode · Model · Effort (Codex) · Compact · Context · Read output
  object ControlMenu {
      fun items(session: AgentSession, secure: Boolean): List<MenuItem>
      fun modeOptions(provider: AgentProvider): List<TempMode>   // both tools: ASK, ACCEPT_EDITS, APPROVE_ALL
  }
  ```
- Rules:
  - **Reply by voice** is enabled when `followup` is WAITING or READY, for any provider. agentd sends READY for Codex and for Claude launcher sessions (Plan 3). At CAP_REACHED its sub is `continue on laptop or rk claude`. At UNAVAILABLE its sub is `session not waiting`.
  - **Approval mode:** the sub shows the current temp mode, the native mode and, when present, the sandbox policy (`sandbox: <value>`, read only, design §12.6). Picking APPROVE_ALL opens a confirm card (`Approve everything in <heading>?` with `Yes, approve all` and `Cancel`), and only `Yes` sends `mode_set{confirmed:true}`. Other modes send `confirmed:false`.
  - **Model / Compact:** when `canModel`/`canCompact` is false, the item is disabled with sub `needs rk claude`. When true for a Claude session (launcher, Plan 3), Compact sends `launcher_command{command:"compact"}` after a confirm. Model asks for confirmation with the warning `This also changes the default for new sessions`, then sends `launcher_command{command:"model", model}`. The model list for Claude is fixed (`opus`, `sonnet`, `haiku`). Until Plan 3, agentd answers `rejected not_launcher`, and the phone briefs `Not applied: not_launcher`.
  - **Model (Codex):** sends `models_request`, then shows a list from the `models` frame. Picking sends `codex_settings{model}`. The sub shows `pending` while `pendingModel != null`. Effort works the same way, with `efforts`.
  - **Compact (Codex):** asks for confirmation first, then sends `codex_compact`.
  - **Context:** the sub is `NN% · used/window` (k-rounded), from `contextUsed/contextWindow`, or `unknown`.
  - Every steering item is disabled with sub `Monitor only — approve on laptop` when `!secure`.
  - `ack rejected` with any error → brief notice `Not applied: <error>`.
  - `followup_closed` → brief notice by reason: `laptop` → `Laptop took over`, `timeout` → `Reply window closed`, `cancelled` → `Reply cancelled`.
  - `mode_reset` → notice `Approve-all off — <heading>: session ended | helper restarted | revoked`.

- [ ] **Step 1: Write the failing tests.**
  - `claude_plugin_mode_greys_model_and_compact_with_needs_rk_claude`
  - `codex_enables_model_effort_compact`
  - `approve_all_requires_confirm_and_sends_confirmed_true`
  - `followup_cap_reached_shows_continue_on_laptop`
  - `insecure_disables_all_steering_items`
  - `context_sub_formats_percent_and_k`
  - `pending_model_shows_pending`
  - `mode_reset_notice_copy_per_reason`
  - `followup_closed_copy_per_reason`
  - `claude_launcher_ready_enables_reply_and_launcher_commands`
  - `launcher_model_shows_default_change_warning`
  - `sandbox_shown_read_only`
- [ ] **Step 2:** Implement and wire. Menu cards are `richLines` with the hub selection rail. Swipe moves; ENTER picks; BACK returns to the board. A row whose text is longer than 240 chars opens a reader on ENTER (the design's "expand to read the full text").
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): per-session control menu for mode, model, compact, context and replies`

---

### Task 7: Voice: follow-ups and question answers over `stt`

**Files:**
- Create:
  - `VoiceCapture.kt` (a pure state machine over `NexusSpeechCallbacks` events)
  - `QuestionFlow.kt` (pure)
  - tests `VoiceCaptureTest.kt`, `QuestionFlowTest.kt`
- Modify:
  - `AndroidManifest.xml`: `CAPABILITIES=surfaces,stt,tts`; `RECEIVE_PREFIXES=/plugin/agents,/system/plugin,/stt,/tts/started,/tts/done`.
  - `AgentsPluginService.kt`: the reply card and the question card.

**Interfaces:**
- Produces:
  ```kotlin
  class VoiceCapture {
      sealed interface State { object Idle; object Listening; data class Heard(val text: String); data class Failed(val message: String) }
      fun onStarted(); fun onPartial(text: String); fun onFinal(text: String?); fun onStopped(reason: NexusSpeechStopReason)
      val state: State
      fun confirmedText(): String?    // non-null only in Heard with non-blank text
  }
  object VoiceApproval { fun match(text: String): ApprovalDecision? }
  class QuestionFlow(val alertId: String, val sessionKey: String, val payload: QuestionPayload) {
      fun toggle(itemIndex: Int, optionIndex: Int)      // single-select replaces; multiSelect toggles
      fun setFreeText(itemIndex: Int, text: String)     // only when allowFreeText
      fun answers(): Map<String, Any>?                   // null until every item has an answer; key = item.text; value String or List<String>
  }
  ```
- `VoiceCapture` rules:
  - A null or blank final → the last non-blank partial.
  - `DENIED_BUSY` → `Failed("Mic busy — try again")`.
  - `DENIED_NO_LINK` / `LINK_LOST` → `Failed("Glasses link lost")`.
  - `NO_SPEECH` → `Failed("Didn't catch that")`.
  - Nothing is sent until ENTER is pressed on the `Heard` card: `Send` / `Speak again` / `Cancel`.
- **Follow-up:** sends `followup{sessionKey, text, msgId}`; the text is capped at 16 KiB.
- **Voice approval (design goal 3):** the decision card (`more`) has a row `Say allow or deny`.
  - `VoiceApproval.match(text)` normalises the text (lowercase, trim, strip punctuation, collapse spaces), then accepts only a complete utterance from a fixed allowlist.
    - ALLOW: `allow`, `approve`, `yes`, `ok`, `okay`, `allow it`, `approve it`, `yes allow`, `yes approve`.
    - DENY: `deny`, `no`, `reject`, `deny it`, `reject it`, `no deny`.
    - Anything else → null → `Say allow or deny`. That includes extra words and negations such as `don't allow` or `do not approve`.
  - A match shows a confirm card, `Allow?`/`Deny?` with `Confirm` / `Cancel`. Only `Confirm` sends `alert_action`.
- **Invalidation:** an `Invalidate(alertId)` effect, a `LinkDown`, or a `followup_closed` for the session stops any running speech session (`stop()`) and closes the card. A late `onSpeechFinal` after invalidation is dropped.
- **Question card:** one item per page. Option rows are followed by an `Answer box (voice)` row when `allowFreeText`. The last page has `Send answer`, which sends `question_answer{sessionKey, alertId, requestRef, answers, msgId}`.

- [ ] **Step 1: Write the failing tests.**
  - `null_final_falls_back_to_last_partial` (Review Focus 4)
  - `blank_final_and_no_partial_is_failed_didnt_catch`
  - `denied_busy_is_mic_busy` (Review Focus 4)
  - `confirmed_text_only_after_heard`
  - `single_select_replaces`
  - `multi_select_toggles_list`
  - `free_text_only_when_allowed`
  - `answers_null_until_all_items_answered`
  - `answers_keyed_by_question_text`
  - `voice_approval_matches_allow_and_deny_words`
  - `voice_approval_ambiguous_or_unknown_is_null`
  - `voice_approval_negated_or_extra_words_is_null` (`don't allow`, `do not approve`, `allow it please`, `no allow`)
  - `late_final_after_invalidate_is_dropped`
- [ ] **Step 2:** Implement and wire. Use `nexusSpeechSession(callbacks)` and `start("auto")`. Callbacks run on the main thread. Never log the text.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): tap-to-talk follow-ups and question answers over the stt capability`

---

### Task 8: Sound, DND, quiet, and the visible monitor notification

**Files:**
- Create:
  - `AlertSoundPolicy.kt` (pure)
  - `InterruptionFilterReader.kt`
  - `AlertSoundPolicyTest.kt`
- Modify:
  - `AgentsPluginService.kt`: speak the cue on `Effect.Show(sound = true)`.
  - `AgentNotifications.kt`: a visible, low-importance ongoing notification "Agents monitoring · <n> sessions" with `Settings` and `Stop` actions. `Stop` turns the Monitoring switch off and stops the service.
  - `AndroidManifest.xml`: add `POST_NOTIFICATIONS`.
  - `plugins/AGENTS.md`: add a short "Agents monitoring exception" paragraph under §3.5 (R32).

**Interfaces:**
- Produces:
  ```kotlin
  object AlertSoundPolicy {
      fun shouldSpeak(dnd: DndState, quiet: Boolean, glassesVolume: Int?, worn: Boolean?): Boolean
      fun cue(kind: AlertKind, provider: AgentProvider): String
      // "Claude needs approval" / "Codex needs approval", "Claude has a question", "Claude is done", "Claude hit an error"; NOTICE → none
  }
  enum class DndState { OFF, ON, UNKNOWN }
  class InterruptionFilterReader(context: Context) { fun read(): DndState }   // INTERRUPTION_FILTER_ALL → OFF; NONE/PRIORITY/ALARMS → ON; else UNKNOWN
  ```
- Speak only when all of these hold:
  - DND is OFF (UNKNOWN counts as quiet, design §6.2)
  - `!quiet`
  - the volume is not 0
  - the glasses are not known to be off the head
- Cues go through `nexusTtsSession`. `TTS_RATE_LIMITED` or `UNAVAILABLE` is ignored silently; the display still shows the alert.
- The quiet toggle lives in `AgentsConfigStore` (`alerts.quiet`) and is shown on the phone (Task 9) and as the first board-menu row on the glasses (`Quiet: on/off`).

- [ ] **Step 1: Write the failing tests.**
  - `dnd_on_is_silent`
  - `dnd_unknown_is_silent`
  - `quiet_is_silent`
  - `volume_zero_is_silent`
  - `not_worn_is_silent`
  - `all_clear_speaks`
  - `cue_copy_per_kind_and_provider`
  - `notice_kind_has_no_cue`
- [ ] **Step 2:** Implement. Request `POST_NOTIFICATIONS` when the Monitoring switch is turned on (Android 13+). If it's denied, settings shows `Notifications off — Android may pause Agents`. No repeated prompts.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): spoken alert cue that follows phone DND and quiet; visible monitor notification`

---

### Task 9: Compose settings

**Files:**
- Create:
  - `ui/SettingsScreen.kt`
  - `AlertSettings.kt` (pure model + validation + serialization)
  - `AlertSettingsTest.kt`
- Modify:
  - `AgentsSettingsActivity.kt`: becomes a `ComponentActivity` with `setContent { AgentsTheme { SettingsScreen(...) } }`.
  - `AgentsConfigStore.kt`: persists `AlertSettings`.
  - `AgentsMonitorService.kt`: sends `settings_sync` and `defaults_set` on every secure link up and on change. Both are steering (R61), so they go only when secure.
- Keep `AddComputerActivity`, `ComputerActivity`, `ProjectPickerActivity` and `NewThreadActivity` as Views in v1, launched from the Compose screen (ruling R43: re-skin later).
- In `AddComputerActivity`, the pairing-line field becomes secret input: `InputType.TYPE_CLASS_TEXT or TYPE_TEXT_VARIATION_PASSWORD or TYPE_TEXT_FLAG_NO_SUGGESTIONS`, `importantForAutofill = no`. It is never logged.

**Interfaces:**
- Produces:
  ```kotlin
  data class AlertSettings(
      val digestPeriodMs: Long = 60_000, val waitLimitMs: Long = 1_800_000, val reminderMs: Long = 300_000,
      val ageBoostMs: Long = 30_000, val dwellMs: Long = 8_000, val ackTimeoutMs: Long = 5_000,
      val retryBackoffMs: List<Long> = listOf(5_000, 10_000, 20_000),
      val defaultClaude: TempMode = TempMode.ASK, val defaultCodex: TempMode = TempMode.ASK, val quiet: Boolean = false,
  ) {
      fun validated(): AlertSettings     // floors: timings ≥ 1000, reminder ≥ 30_000, waitLimit in 30_000..3_600_000; defaults only ASK/ACCEPT_EDITS
      fun timings(): AlertTimings        // no expireMs on the wire; agentd uses waitLimitMs (R61)
  }
  ```
- **Sections** (PCA `SettingsPage` / `SettingsCard`):
  - **Monitoring:** the switch and the link state, including `Secure (TLS)` / `Monitor only — approve on laptop`.
  - **Computers:** the existing list, `Add a computer`, and the phone TLS fingerprint (Task 10).
  - **Alerts:** cadence `Every minute` / `Live`; wait limit *Y* (5/15/30/60 min); reminder *X* (1/2/5/10 min); `Advanced` with the four timings.
  - **Sound:** quiet switch; `Follows phone Do Not Disturb`.
  - **Approval:** default mode per tool (Ask / Accept edits); `Turn off approve-all everywhere` (sends `mode_revoke_all`, steering).
  - **Mode limits** (§11a, exact text):
    - `Plugin mode (claude + /rokid:on): no compact or model change from the glasses; replies only while the session waits.`
    - `Launcher mode (rk claude): everything, including after the wait.`
  - **Background:** the existing battery and freeze status.
  - **Plugin:** uninstall.

- [ ] **Step 1: Write the failing tests.**
  - `defaults_match_agentd`
  - `floors_applied`
  - `wait_limit_clamped_30s_to_1h`
  - `timings_frame_has_no_expireMs`
  - `approve_all_never_a_default`
  - `serialization_round_trip`
  - `settings_sync_frame_from_settings_matches_fixture`
- [ ] **Step 2:** Implement and wire.
- [ ] **Step 3:** Run the Agents build. Expected: pass. `assembleDebug` succeeds.
- [ ] **Step 4: Commit** `feat(agents): Material settings for alerts, sound, approval defaults and mode limits`

---

### Task 10: Phone TLS: server for daemon-dials-phone, pinned client for pairing

**Files:**
- Create:
  - `PhoneTlsIdentity.kt` (interface + AndroidKeyStore implementation)
  - `CertPins.kt` (pure)
  - tests `CertPinsTest.kt`, `PhoneTlsServerTest.kt` (JVM TLS loopback using a PKCS12 test fixture under `src/test/resources`, generated once with `keytool` and committed)
- Modify:
  - `AgentdLinkServer.kt`: `SSLServerSocket` from `PhoneTlsIdentity`; the discovery reply gains `"tls":true`.
  - `AgentsConfigStore.kt`: `AgentdPairingParser` reads `fp`.
  - `AgentdClient.kt`: pinned `wss://` when `fp` is present.
  - `AgentsMonitorService.kt`: the OkHttp client gets the pinned trust manager.

**Interfaces:**
- Consumes: agentd Plan 1 Task 11 contract.
  - The pairing line `fp` is Node `cert.fingerprint256`: colon-separated uppercase SHA-256 of the DER cert.
  - The pairing line also carries `steer`, a base64url secret (R44). It's needed for steering over the WebSocket path: the phone sends it as `hello.steer` on the pinned `wss://` connection only, never on `ws://`. It is stored like `fp`, as secret preferences key `agentd.steer`, and is never logged or shown.
  - On the daemon-dials-phone path, agentd keeps a set of trusted phone certificates (R45). It refuses an unknown phone certificate before sending its hello, and refuses plaintext once any phone is pinned. Adding a second phone needs `rokid-coder phones allow-next` on the laptop, and the settings text says so.
  - The discovery reply carries `"tls": true`.
  - agentd pins the phone cert on the first authenticated hello.
- Produces:
  ```kotlin
  interface PhoneTlsIdentity { fun sslContext(): SSLContext; fun fingerprint256(): String }
  class KeystorePhoneTlsIdentity(alias: String = "rokid-coder-phone-tls") : PhoneTlsIdentity   // EC P-256 or RSA-2048 key in AndroidKeyStore, self-signed cert, CN rokid-coder-phone, 10 y
  object CertPins {
      fun fingerprint256(der: ByteArray): String             // "AB:CD:..." uppercase
      fun parse(fp: String?): PinParse                       // Absent | Valid(fp) | Malformed
      fun trustManager(expected: String): X509TrustManager   // whole-cert pin, rejects any other leaf
  }
  ```
- Rules:
  - The pairing line with a valid `fp` → `wss://host:port` with the pinned trust manager → `linkSecure = true` after `hello_ack`.
  - Absent `fp` → legacy `ws://`, `linkSecure = false`.
  - `fp` present but `steer` absent → pinned `wss://` monitor-only. agentd never trusts a client without `steer`, so `linkSecure` stays false and settings shows `Re-pair to allow approvals`.
  - Malformed `fp` → the pairing is refused with `Pairing line has a bad fingerprint`.
  - A pin mismatch → the connection is refused, the state reads `Computer's certificate changed — re-pair`, and there is no fallback to `ws://`.
  - On the inbound path every accepted connection is TLS, so `linkSecure = true` once hello completes. agentd decides its own trust TOFU.
  - The two paths stay mutually exclusive (R35).
  - The phone fingerprint is shown in settings so the user can compare it with `agentd`'s log.
- **Pin storage:**
  - `AgentdConfig` gains `fp: String?`. `saveAgentd`/`loadAgentd` persist it as key `agentd.fp`.
  - A stored legacy slot without `fp` stays legacy (monitor-only) until it is re-paired with a line that carries `fp`.
  - A slot with `fp` is never overwritten by a line without `fp`. That is refused as `Pairing line has no fingerprint — this computer is pinned`.
  - The pin is removed only by `Forget` or by re-pairing.
- **Pinned client:**
  - The pinned `OkHttpClient` is a separate builder from the shared one.
  - Its `hostnameVerifier` returns true only when the session's leaf certificate matches the pin, because agentd's self-signed cert has no SANs for LAN or Tailscale names. That relaxation lives only on this client.
  - The token goes in the `hello`, which is written only after the TLS handshake has verified the pin. OkHttp opens the socket before `onOpen`.

- [ ] **Step 1: Write the failing tests.**
  - `fingerprint_format_matches_node_fingerprint256`: fixture DER plus the expected string, computed once with `openssl x509 -fingerprint -sha256` and pasted into the test.
  - `parse_absent_valid_malformed`
  - `pinned_trust_manager_accepts_expected_rejects_other` (Review Focus 5)
  - `tls_server_accepts_tls_client_and_line_protocol_unchanged` (loopback, fixture identity)
  - `discovery_reply_has_tls_true`
  - `malformed_fp_pairing_is_refused_not_legacy` (Review Focus 5)
  - `fp_persists_across_store_reload`
  - `pinned_slot_refuses_line_without_fp`
  - `pinned_websocket_handshake_against_local_tls_server` (OkHttp `MockWebServer` is a new test dependency; use `okhttp-tls` `HeldCertificate` for the server cert, test scope only)
  - `pinned_client_accepts_ip_host_without_san_only_with_matching_pin`
  - `steer_sent_only_in_wss_hello_never_in_ws_hello`
  - `fp_without_steer_is_monitor_only`
- [ ] **Step 2:** Implement. The `AndroidKeyStore` implementation isn't JVM-testable, so it stays a thin adapter, and the tests use a `FixturePhoneTlsIdentity` built from the PKCS12 fixture.
- [ ] **Step 3:** Run the Agents build. Expected: pass.
- [ ] **Step 4: Commit** `feat(agents): TLS link server and pinned pairing client; plaintext stays monitor-only`

---

### Task 11: Glasses hub: hold the display for Agents approval and question bands

**Files:**
- Modify:
  - `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/AssistantDisplayEpisode.kt` (`NoticeDisplayHoldPolicy`)
  - `NoticeController.kt` (the `engaged` argument at `applyDecision`)
- Test: extend `DisplayHoldLifecycleTest.kt` and `NoticeOverlayRendererTest.kt`, or add `AgentsNoticeHoldPolicyTest.kt`.

**Interfaces:**
- Produces:
  - In `NoticeDisplayHoldPolicy`: `const val AGENTS_PLUGIN_ID = "agents"`, `fun agentsNoticeHoldsDisplay(surfaceId: String, actionCount: Int): Boolean = surfaceId == "agents:notice" && actionCount >= 1` (R34). Approval and question bands carry actions; done, error and notice bands carry none.
  - Use a separate episode owner `"agents:episode"` with the same 90 s ceiling, through `AssistantEpisodeHoldLifecycle(ceilingMs, ownerId)`, which is already parameterised. Leave every assistant signal function untouched.
  - New pure signal functions for Agents: `agentsEpisodeNoticeShownSignal(surfaceId, actionCount)` → Engage or None, and `agentsEpisodeNoticeClosedSignal(surfaceId, reason)`, where **every** reason (USER, OWNER, TIMEOUT, REPLACED, DISCONNECT) → End.
  - An Agents band redrawn with zero actions → End. Any surface presented → End.
  - An assistant engaged notice ends the Agents episode, and vice versa, so only one hold exists at a time.
  - `NoticeController` passes `content.actions.size` alongside the existing `engaged` and calls the Agents signals next to the assistant ones.
  - Assistant behaviour is unchanged.

- [ ] **Step 1: Write the failing tests.**
  - `agents_band_with_actions_engages_hold`
  - `agents_band_without_actions_does_not_hold`
  - `other_plugin_band_with_actions_does_not_hold`
  - `assistant_behaviour_unchanged` (keep every existing assertion green)
  - `agents_hold_ends_on_user_owner_timeout_replaced_disconnect` (one case per reason)
  - `agents_hold_ends_when_redrawn_without_actions`
  - `assistant_engaged_notice_ends_agents_hold_and_vice_versa`
  - `agents_hold_capped_at_90s`
- [ ] **Step 2:** Implement, keeping the change minimal and upstream-clean.
- [ ] **Step 3:** Run `./gradlew :glasses-hub:testDebugUnitTest :glasses-hub:assembleDebug`. Expected: everything passes except the 2 known `GlassesFileStoreTest` failures, and the APK assembles. Paste the tail.
- [ ] **Step 4: Commit** `feat(glasses-hub): hold the display for Agents approval and question bands`

---

### Task 12: `/notice/shown`: shared contract, SDK callback, glasses emission (capability-gated)

**Files:**
- Modify:
  - `shared/.../BusConstants.kt`: `BusPaths.NOTICE_SHOWN = "/notice/shown"`, and a new `BusCapabilityBits` value `NOTICE_SHOWN_ACK` (next free bit).
  - `shared/.../NoticeSurfaceContract.kt`: `shownPayload(noticeId, identity)`.
  - `shared/.../plugin/PathRules.kt`: add `NOTICE_SHOWN` to `isDirectReply` and `isOwnerScoped`.
  - `shared/.../GlassesHubCapabilitiesContract.kt`: the glasses advertise `NOTICE_SHOWN_ACK` in `features`.
  - `shared/.../PhoneHubCapabilitiesContract.kt`: the phone may advertise `NOTICE_SHOWN_ACK` toward the glasses.
  - **Rule:** the plugin-facing capability bit is set by the phone hub only when the glasses advertised it and the phone hub supports it (an intersection). The intersection logic lives in phone-hub (Task 13). Until then a stock phone hub never sets the bit, so `supportsNoticeShownAck` is false and the plugin uses interim evidence.
  - `bus-client/.../NexusPluginClient.kt`: add `onNoticeShown()` to `NexusPluginCallbacks`, deliver it for `NOTICE_SHOWN` only when `acceptsNoticeCallback(payload)` holds, and add `val supportsNoticeShownAck: Boolean` (the plugin-facing bit).
  - `bus-client/.../NexusPluginService.kt`: `open fun onNexusNoticeShown() {}`.
  - `glasses-hub/.../NoticeController.kt`: emit when the renderer reports the band attached, only if the phone advertised `NOTICE_SHOWN_ACK`.
  - The Agents plugin: `onNexusNoticeShown` → `AlertCoordinator.onShownEvidence(currentId)`.
  - `docs/PLUGIN_SDK.md` and `BUSSPEC.md` "Notice protocol v1": document the path as optional and capability-gated.
- Keep `NoticeSurfaceContract.VERSION = 5` unchanged, so stock hubs keep working.

- [ ] **Step 1: Write the failing tests.**
  - shared: `shown_payload_shape`, `notice_shown_is_direct_owner_scoped_reply`
  - bus-client: `notice_shown_delivered_only_for_own_current_notice`
  - glasses-hub: `shown_emitted_once_per_show_when_attached_and_phone_supports_ack`, `not_emitted_without_phone_capability`, `glasses_capabilities_advertise_notice_shown_ack`
  - bus-client: `supports_notice_shown_ack_false_without_plugin_bit` (old/new combinations: stock phone with new glasses → false; new phone with stock glasses → false, enforced in Task 13)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Run the shared, bus-client, glasses-hub and Agents builds. Expected: pass (glasses-hub with the 2 known failures).
- [ ] **Step 4: Commit** `feat(notice): optional capability-gated /notice/shown ack from the glasses`

---

### Task 13 (DEFERRED: needs `../CxrGlobal`; do not execute overnight, R33)

**Files:**
- Modify:
  - `phone-hub/.../BusHubService.kt`: route `NOTICE_SHOWN` from the glasses to `noticeRouter.handleGlassesShown`, advertise `NOTICE_SHOWN_ACK`, and add the path to the journal INPUT category.
  - `phone-hub/.../PhoneNoticeRouter.kt` and `PhoneNoticeState.kt`: a non-consuming identity check, then `deliverLocal(NOTICE_SHOWN)`.
  - `phone-hub/.../NexusUpdateChecker.kt`: repoint `RELEASES_URL` to the fork's releases.

**Steps:**
- Tests: `PhoneNoticeRouterTest` `shown_from_glasses_delivered_to_owner_only_for_current_identity`, and `NexusUpdateCheckerTest` updated for the URL.
- Build `./gradlew :phone-hub:testDebugUnitTest :phone-hub:assembleDebug` (no flag).
- Commit `feat(phone-hub): route the glasses /notice/shown ack to the notice owner`.

---

### Task 14: Device checklist, docs, and command names

**Files:**
- Create: `docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md`, one checkbox per item from R38.
- Modify:
  - `plugins/agents/README.md`: v2, TLS pairing, voice, the stt/tts grant re-approval, and mode limits.
  - Design §11a: the command names `/rokid:on|off|status` (Claude) and `rokid:on|off|status` (Codex).

**Checklist items (R38):**
- the end-to-end shown ack (after Task 13)
- sleeping-panel wake and the first tap
- hold release
- burst and reconnect
- DND/quiet and A2DP
- STT contention with PCA and a null final
- TLS pin persistence and rejection
- Samsung background survival
- coexistence with PCA (touchpad gestures)
- the stt/tts grant re-approval in Nexus

**Steps:**
- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run all four buildable suites once more and paste the tails into the commit body.
- [ ] **Step 3: Commit** `docs: Plan 2 device checklist, Agents v2 README and command names`
