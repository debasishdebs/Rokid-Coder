# Rokid-Coder Plan 4: The Morning Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user's 2026-11-14 morning decisions:
- TLS everywhere (U8)
- pairings that sign out when unused (U7)
- guided pairing on the phone and glasses (U6)
- an alert history with silent reminders (U1)
- a sound per alert kind and one card per question (U3)
- condensed long voice replies that are sent in full (U4/U13)
- visible duplicate acks (R152)

**Architecture:**
- **agentd (Node/TS)** drops every plaintext listener and dial, and requires the phone's client certificate on wss as well. Every phone is then one pinned fingerprint on both paths: wss (phone → agentd :8792) and PhoneLink (agentd → phone :8792). That fingerprint carries a `lastUsedAt` that drives the usage TTL.
- **The Agents plugin (Kotlin)** dials wss only, with its `PhoneTlsIdentity` as the client cert. It applies the same TTL to the computers it trusts, and gains the UX features. All of those are phone-side state; the only wire changes are listed in Task 1 and Task 2.

**Tech Stack:**
- agentd: Node ≥ 20, TypeScript (CommonJS), `node:test`
- plugin: Kotlin, OkHttp, Jetpack Compose (settings) and NexusUi Views (AddComputerActivity), JUnit; Android `AudioTrack`/`AudioManager` for the chime

**Spec:** `docs/coding-agent/claude/design/2026-11-14-rokid-coder-design.md` (§6, §11, §12.1, §12.2), as amended by the user decisions U1–U14 in `.superpowers/sdd/MASTER-HANDOFF.md` ("USER DECISIONS"). Where they conflict, U-decisions win over the design and over rulings R1–R167.

**Evidence:** the code maps of 2026-11-14 (agentd transport and pins; plugin alerts, voice and settings), summarised in this plan's file references.

## Global Constraints

**Branch and commits**
- Branch `rokid-coder/plan-4`, created from the `rokid-coder/plan-3` head `2345187e`. Local commits only; never push.
- Imperative messages, no AI attribution, no `Co-Authored-By` trailer (repo AGENTS.md).

**Tests**
- agentd: `cd agentd && npm test`. Baseline 650/650.
- Plugin: `cd plugins/agents && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ../../gradlew testDebugUnitTest assembleDebug`. Baseline 345.
- If `:shared`/`:bus-client`/`:glasses-hub` are touched: `JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew :shared:test :bus-client:testDebugUnitTest :glasses-hub:testDebugUnitTest --continue`. The only allowed failures are the 2 known `GlassesFileStoreTest` ones.
- Every test that is removed must be named in the task report with the reason. A plaintext test is either deleted or flipped into a "plaintext is refused" test, never silently dropped.

**Hard limits**
- Never touch `local.properties`. Never build `:phone-hub`.
- No adb. Never touch `~/.claude`, `~/.codex`, or the real `~/.rokid-coder`; tests use the state-dir override.
- No subagents inside a task.
- Never print a token, `steer`, the pairing line, or a full fingerprint into anything a Claude or Codex session can see (R153). The `agentd` CLI in a terminal may print them, as today.

**Transport (U8, supersedes R40/R54)**
- No unencrypted Rokid-Coder phone link exists after this plan: no `ws://`, and no plaintext TCP PhoneLink.
- The only accepted link on either path is TLS (≥ 1.2), pinned both ways.
  - wss (phone → agentd): the phone's client cert, the token, and `steer`.
  - PhoneLink (agentd → phone): unchanged, mutual certs plus the token. No `steer` is added there.
  - Anything else is refused at hello.
- There is no "monitor-only" mode any more.
- Out of scope, and unchanged:
  - the loopback hook port `127.0.0.1:8791` (U9)
  - the 0600 launcher unix socket
  - OpenClaw's link, which is upstream Nexus
  - the Nexus phone↔glasses hub link

**Copy (U5)**
- Every new state the user can land in shows a next step where they are: phone screen, glasses row, or CLI line. Exact strings are given per task; implementers use them verbatim.

**Settings**

| Setting | Key | Default | Choices |
|---|---|---|---|
| Sign out unused computers | `security.pairing_ttl_days` | 14 | 3 / 7 / 14 / 30 / 90 |
| Voice reply word limit | `voice.word_limit` | 250 | 100 / 150 / 250 / 500 (max 500) |
| History: keep after session closes | `history.keep_after_session` | false | — |
| History window | `history.window_hours` | 24 | 1 / 4 / 12 / 24 (max 24) |

- The pairing TTL syncs to agentd. The other three are phone-only.

## Review Focus

1. **An existing phone paired before Plan 4** (wss line, no client cert pinned at agentd) reconnects after the upgrade. Expected: agentd refuses it with `hello_reject repair_needed`, and the phone shows "Pair again" on the settings screen and as a glasses row, with no reconnect storm (AUTH_FAILED backoff). Task 3 test `pre_plan4_pairing_gets_pair_again_not_a_loop`.
2. **The clock moves backwards, or a `lastUsedAt` is in the future.** Expected: it is clamped to now on read, so the entry neither expires at once nor lives forever. Task 2 `future_last_used_is_clamped_to_now`; Task 4 `future_last_used_is_clamped_on_phone`.
3. **A long voice reply that is one huge "word"** (a URL, or a no-space language). Expected: the condensed display also caps each token at 40 chars with `…`, so the card stays readable. The full text is still sent. Task 8 `one_giant_token_is_capped_in_display_only`.
4. **The session ends while its alert is pending, or while the question deck is on card 2 of 3.** Expected: the history entry ends `WITHDRAWN`, and the deck closes with the "No longer waiting" brief. Task 6 `session_end_marks_pending_withdrawn`; Task 7 `withdraw_mid_deck_closes_deck_with_brief`.
5. **The chime when no Bluetooth output is connected.** Expected: it never plays on the phone speaker; it is dropped and logged. Task 7 `chime_dropped_without_bt_output`.

---

### Task 1: agentd is TLS-only, with the phone's client cert on wss (U8)

**Files:**
- Modify: `agentd/src/ws-server.ts`
  - TLS required
  - delete `plain`, `route()`, `TLS_HANDSHAKE_BYTE`, `plainServer`
  - `requestCert`
  - client-cert check in the hello handling at 316-357
- Modify: `agentd/src/phone-link.ts`
  - always `tls.connect`
  - delete the plaintext `connect` branch at 513-525 and 548-554, `refusePlaintext`, and the `announcement.tls === false` handling at 509 (log and ignore such announcements)
- Modify: `agentd/src/config.ts:64-95`
  - `tls://` stays accepted for old configs and means nothing
  - an unprefixed target is TLS
  - fix the doc comment
- Modify: `agentd/src/daemon.ts:124-127, 466-468`. Drop the monitor-only comments; `trusted` is always true for an accepted link.
- Modify: `agentd/src/cli.ts:70`. The listening line says `wss` on 0.0.0.0:<wsPort>.
- Modify: `agentd/README.md:65-78`. TLS-only, plus the re-pair note for phones paired before Plan 4.
- Modify: `contracts/rokid-coder-v2.fixtures.json`. Replace the plaintext/monitor-only fixtures with the refusal fixture.
- Tests: `agentd/test/tls.test.js`, `protocol-v2.test.js`, `fixtures-contract.test.js`, `config-migration.test.js`, `ws-server.test.js`, `phone-link.test.js`, `smoke.js`. Helpers: `test/fake-phone.js:84,258` and `test/helpers/daemon.js:75` default to `tls=true`, and the fake phone carries a fixture client cert.

**Interfaces:**
- **Produces, wire:**
  - wss `hello_reject` is `{type:"hello_reject", v:2, reason}`, sent before close. `reason` is one of:
    - `"repair_needed"`: no client cert; a cert that isn't pinned while no allow-next window is open; a missing or wrong `steer`
    - `"bad_token"`
  - The socket then closes with 4403.
  - `hello_ack.steering` stays in the frame and is always `true`.
- **Produces, behaviour:**
  - A wss client whose cert isn't pinned, connecting inside an allow-next window with the right token and `steer`, is pinned with `PinStore.add(fp)`. That consumes the window the same way `trustPeer` does on PhoneLink.
  - No pin or window state changes until the token, `steer` and cert eligibility have all passed. A failed hello leaves both untouched.
  - WsHub takes the shared `PinStore` (constructor option `pins`) and keeps each peer's fingerprint on its `ClientState`.
  - `isTrusted`/`grantsSteering` also require `pins.has(peerFp)`.
  - `recheckTrust` runs on changes to the pins file as well as the `steer` file. A pin that is forgotten (CLI or TTL) closes that wss peer live, with `link_trust false` and then 4403.
- **TLS settings:** `https.createServer({ requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.2", … })`. This lets self-signed phone certs and missing certs reach the hello handler, which decides at the application level.
  - Fingerprint: `normalizeFingerprint(createHash("sha256").update(socket.getPeerCertificate(true).raw).digest("hex"))`.
  - An empty cert object means "no cert".
  - A non-TLS first byte on :8792 is destroyed, with the log `ws_plaintext_refused`.
- **Keeps:** `authorize`/`gateFrame` stay as defence in depth. The `monitor_only` error string stays, and is now unreachable for accepted links.

- [ ] **Step 1: Flip the helpers.** `createFakePhone` and `withDaemon` default to TLS. The fake phone presents a fixture client cert, and `pinFakePhone(daemon)` arms or pins it. Run `npm test` and record which tests fail, so the list of plaintext tests is known.
- [ ] **Step 2: Write the failing tests:**
  - `plain_ws_on_8792_is_refused_and_logged`: a raw `ws://` upgrade gets no response bytes, the socket is destroyed, and the log contains `ws_plaintext_refused`.
  - `wss_without_client_cert_gets_repair_needed`
  - `wss_with_unpinned_cert_outside_window_gets_repair_needed`
  - `wss_with_unpinned_cert_inside_window_is_pinned_and_steers`: `hello_ack.steering === true`, `pins.has(fp)`, and the window is closed afterwards.
  - `wss_with_pinned_cert_but_wrong_steer_gets_repair_needed`
  - `failed_hello_inside_window_leaves_pins_and_window_unchanged`: wrong `steer`, and separately a wrong token, with an unpinned cert inside the window. Afterwards `pins.list()` is unchanged and `allowNextOpen` is still true.
  - `wss_upgrade_without_any_client_cert_reaches_hello_and_gets_repair_needed`
  - `forgetting_a_pin_closes_its_wss_peer_live`: `phones forget <fp>` while connected over wss gives `link_trust false`, then close 4403. A second, still-pinned wss phone stays connected.
  - `phone_link_never_dials_plaintext`: the announcement `{tls:false}` causes no `net.connect`, and the log contains `phone_announcement_plaintext_ignored`.
  - `unprefixed_target_dials_tls`
  - `wshub_requires_a_cert`: the constructor throws without `tls`.
- [ ] **Step 3: Implement.**
  - Order inside hello: token, then `steer`, then cert eligibility (pinned, or the window open). Pinning comes after all three pass.
  - Each failure sends its reason and closes.
  - Never log the token, the `steer`, or the full fp; `shortFingerprint` only.
- [ ] **Step 4: Delete or flip every plaintext test** listed in the code map (the `tls.test.js` monitor-only set, the `protocol-v2.test.js` plaintext set, the `phone-link.test.js` plain-TCP fake-phone set, which moves to TLS fakes). List each one in the report.
- [ ] **Step 5:** `npm test` passes. Commit `Make every phone link TLS with the phone's client certificate`.

### Task 2: Usage-based pairing TTL in agentd (U7)

**Files:**
- Modify: `agentd/src/tls.ts`. PinStore moves to file v3: entries `{fp, addedAt, lastUsedAt}`, migrated from v2 bare strings with `addedAt = lastUsedAt = migration time`.
- Modify: `agentd/src/phone-link.ts` (`onHelloAck`/`trustPeer`), `agentd/src/ws-server.ts` (successful hello). Both call `touch`.
- Modify: `agentd/src/daemon.ts`. An hourly `expire` timer, and an expiry run at startup. Expiry triggers the existing live revocation (`recheckTrust` on both hubs, through the pins file watch).
- Modify: `agentd/src/phone-settings.ts`, `agentd/src/phone-v2.ts:878-906`. `settings_sync` accepts `pairingTtlDays` (integer 1..365), persisted in `settings.json`; anything else gives `bad_settings`.
- Modify: `agentd/src/cli.ts:161-204`. `phones list` adds `last used <n> days ago · signs out in <m> days`.
- Modify: `contracts/rokid-coder-v2.fixtures.json` (`settings_sync` example).
- Test: `agentd/test/tls.test.js`, `agentd/test/protocol-v2.test.js`.

**Interfaces:**
- **Produces:**
  - `PinStore.touch(fp: string, now: number): void`. Writes at most once per hour per fp, tracked in memory, always through `commit`.
  - `PinStore.expire(now: number, ttlMs: number): string[]` returns the forgotten fps.
  - `PinStore.isTrusted(fp: string, now: number, ttlMs: number): boolean`. Pinned and not stale; a stale entry is expired (removed) on the spot.
    - EVERY admission and trust check uses it. That covers PhoneLink `mayTrust` (phone-link.ts:641), `trustPeer` (911), the `trusted` getter (326), and WsHub hello and `isTrusted`.
    - So an expired phone can't reconnect and renew itself between hourly sweeps.
    - `touch` is called only after admission.
  - `has(fp)` stays for the CLI only.
  - `PinStore.entries(): {fp, addedAt, lastUsedAt}[]`
  - `DEFAULT_PAIRING_TTL_DAYS = 14`
- **Wire:** `settings_sync` gains the optional `pairingTtlDays`. The phone's Task 4 sends it.

- [ ] **Step 1: Write the failing tests:**
  - `v2_pins_migrate_to_v3_with_now_as_last_used`
  - `touch_writes_at_most_hourly`
  - `pin_unused_for_ttl_is_expired_and_link_revoked`: with fake time, a phone connected 15 days ago is revoked live, gets a `link_trust false` frame, and is gone from the file.
  - `connected_phone_never_expires`: hourly touches while the link is up, on both PhoneLink and wss.
  - `expired_phone_reconnecting_before_sweep_is_refused`: TTL passed, no sweep has run, and a reconnect over wss and over PhoneLink is refused. The entry is removed and was never touched.
  - `future_last_used_is_clamped_to_now`
  - `settings_sync_pairing_ttl_days_validated_and_persisted`: 0 and 366 give `bad_settings`; 30 persists and applies to the next expire.
  - `phones_list_shows_last_used_and_sign_out_in`
- [ ] **Step 2: Implement.**
  - Clamp `lastUsedAt` to `min(lastUsedAt, now)` on read.
  - `expire` logs `phone_pairing_expired <shortfp> unused_days=<n>`.
  - The TTL comes from `settings.json`, falling back to `DEFAULT_PAIRING_TTL_DAYS`.
- [ ] **Step 3:** `npm test` passes. Commit `Sign out phones whose pairing goes unused for the TTL`.

### Task 3: The phone dials wss only, with its client cert (U8, phone side)

**Files:**
- Modify (in `plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/`, P below):
  - `AgentdClient.kt`:
    - delete the `ws://` branch at 21-24
    - no `fp` means no dial
    - `hello_ack.steering != true`, `hello_reject`, or `LinkTrust(false)` means AUTH_FAILED with the detail `REPAIR_TO_STEER`
  - `PhoneTlsIdentity.kt`:
    - Add `fun keyManager(): X509ExtendedKeyManager` to the `PhoneTlsIdentity` interface, implemented by `KeystorePhoneTlsIdentity` and `FixturePhoneTlsIdentity`.
    - `SingleKeyManager.chooseClientAlias` (136), `chooseEngineClientAlias` and `getClientAliases` return `ALIAS` when one of the `keyType`s matches the key algorithm, the same as `aliasFor`. The server-side methods are unchanged.
  - `CertPins.kt:92` `pinnedOkHttpClient(base, pin, identity: PhoneTlsIdentity)`: `SSLContext.init(arrayOf(identity.keyManager()), arrayOf(trust), null)`. The server pin check (trust manager plus hostname verifier) is unchanged.
  - Callers in `AgentdClient.kt` / `WebSocketSupport.kt` pass the identity.
  - `AgentsConfigStore.kt`: `AgentdPairingParser` refuses a line without `fp` or `steer`.
  - `AgentdProtocol.kt`: parse `hello_reject{reason}`.
- Modify `P/AlertNotices.kt:22,191-200`, `P/AlertCoordinator.kt:277-293`, `P/AlertBand.kt`, `P/ui/SettingsScreen.kt`. Remove monitor-only:
  - Delete the monitor-only body and `MONITOR_ONLY_TITLE`.
  - A steering press with no secure link shows the brief `Not sent` / `Computer not connected`.
  - Allow and Deny are never omitted for monitor-only reasons (still omitted for `truncated`, per R128).
  - v1 status alerts (`AlertBand.raiseAttention`) are OpenClaw-only, and the agentd branch of `v1AttentionSuppressed` is deleted.
- Tests: `PinnedPairingTest`, `AgentdLinkSecurityTest`, `AgentdProtocolV2Test`, `AlertNoticesTest`, `AlertCoordinatorTest`, `ui/SettingsScreenTest`, `AgentsConfigStoreV2SeenTest`.

**Interfaces:**
- **Consumes:** Task 1's `hello_reject{reason}` and its always-true `steering`.
- **Produces:** `AgentdClient` exposes `needsRepair: Boolean` in its link state. Task 5 renders it.

**Copy (verbatim)**
- `REPAIR_TO_STEER = "Pair again — this computer no longer trusts this phone"`
- Refused old line: `"This pairing line is from an older agentd — run agentd pair again"`
- Settings trust label: `"Secure (TLS)"` / `"Not connected — pair again"`

- [ ] **Step 1: Write the failing tests:**
  - `line_without_fp_is_refused_with_copy`
  - `saved_slot_without_fp_is_never_dialled`
  - `wss_client_presents_phone_identity`: with a fixture TLS server that needs client auth, the handshake succeeds and the server sees the `PhoneTlsIdentity` fingerprint.
  - `pinned_client_still_rejects_wrong_server_cert`
  - `server_key_manager_unchanged_for_link_server`: the existing `PhoneTlsServerTest` keeps passing.
  - `steering_false_ack_is_auth_failed_needs_repair`
  - `hello_reject_repair_needed_is_auth_failed_needs_repair`
  - `pre_plan4_pairing_gets_pair_again_not_a_loop`: repeated rejects follow the AUTH_FAILED backoff and are never a tight loop.
  - `no_secure_link_press_shows_computer_not_connected`
  - `v1_attention_is_openclaw_only`
- [ ] **Step 2: Implement.** Delete the tests that only existed for monitor-only or plaintext, and list them in the report.
- [ ] **Step 3:** Plugin suite passes. Commit `Dial agentd over wss only and present the phone certificate`.

### Task 4: Phone-side pairing TTL (U7)

**Files:**
- Modify `P/AgentsConfigStore.kt`:
  - `agentd.last_used_at`
  - `security.pairing_ttl_days`
  - `expireUnused(now): List<SignedOut>`
  - `signedOut(): List<SignedOut>` and `clearSignedOut(name)`, stored as `signed_out.<name> = <ms>`
- Modify `P/AgentdClient.kt`. Touch `agentd.last_used_at` on a secure `hello_ack`, and hourly while secure.
- Modify `P/AgentdLinkServer.kt`.
  - `touchMachineSeen` already runs after `bind()` (205) and on disconnect (258).
  - Add an hourly `touchMachineSeen` for the bound machine while its link is up, so a computer that stays connected never expires.
- Modify `P/AgentsMonitorService.kt`.
  - Run `expireUnused` at start, on every `reconcile`, and hourly. Expired → drop that link.
  - Order: the touch of a live link comes before the sweep in the same tick.
  - `syncSettings()` adds `pairingTtlDays`.
- **Admission check (both phone transports):**
  - `authorizeMachine` (AgentsConfigStore.kt:344) checks the TTL before any trust decision: stale means expire, then `REJECTED_NOT_INVITED`.
  - The outbound connect in AgentdClient checks the slot's TTL before dialling: stale means sign out, no dial.
  - So a stale computer can never renew itself between sweeps. `touch` only runs after admission.
- **One-time migration:** on the first run of this code, marked by the key `security.ttl_migrated`, every pairing with no timestamp gets `now`. That covers the outbound slot with no `agentd.last_used_at`, and machines with no `machine.seen.<id>`. So nothing paired before the upgrade is signed out at once.
- Modify `P/ui/SettingsScreen.kt`. A new `SecurityCard`:
  - the TTL choice
  - the line `"Signed out of <name> — not used for <n> days. Add it again."`, linking to Add a computer
- Modify `P/BoardCards.kt`. The problem row `"Signed out of <name>"` / sub `"pair again: Add a computer"`.
- Test: new `PairingTtlTest`, plus `ui/SettingsScreenTest`, `BoardModelTest`.

**Interfaces:**
- **Produces:**
  - `data class SignedOut(val name: String, val atMs: Long, val unusedDays: Int)`
  - `AgentsConfigStore.pairingTtlDays(): Int`, default 14, choices `[3, 7, 14, 30, 90]`
- **Consumes:** Task 2's `settings_sync.pairingTtlDays`.

- [ ] **Step 1: Write the failing tests:**
  - `outbound_slot_unused_past_ttl_is_signed_out_keeps_host_and_name`: token, fp and `steer` are cleared; host and name stay for the re-pair hint.
  - `inbound_machine_unused_past_ttl_is_forgotten`
  - `connected_computer_never_signs_out`: covers both the outbound wss and an inbound bound link held for 20 days of fake time.
  - `pairings_without_timestamps_migrate_to_now_once`
  - `stale_computer_reconnecting_before_sweep_is_refused`: covers both the inbound `authorizeMachine` and the outbound dial. No touch happens.
  - `future_last_used_is_clamped_on_phone`
  - `ttl_is_synced_in_settings_sync`
  - `signed_out_row_on_board_and_settings`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Sign the phone out of computers it has not used for the TTL`.

### Task 5: Guided pairing on the phone and glasses (U6)

**Files:**
- Modify `P/AddComputerActivity.kt` (NexusUi Views). A guided section at the top, shown when no computer is trusted or when one is signed out or needs repair:
  1. `"1 · On your computer: run rk claude (it offers to pair), or type /rokid:pair in Claude, or run agentd pair."`
  2. A button `"2 · Open the door for two minutes"`. This is the existing `armLinkWindow` plus `reconcile`, with the countdown `DOOR OPEN · m:ss` and Cancel.
  3. The status line:
     - `"Waiting for your computer…"`
     - then `"Paired with <name> ✓"` when `trustedMachines()` gains an entry, or when the outbound slot goes secure
     - or `"Time's up — tap 2 to try again"`

  The existing Wi-Fi, Tailscale and paste-line cards stay below, under `"Other ways"`.
- Modify `P/ui/SettingsScreen.kt`. The `ComputersCard` empty state gets a button `"Add your first computer"` that opens AddComputerActivity in guided mode. `PAIR_HINT` becomes `"Pairing takes two minutes — tap Add your first computer."`
- Modify `P/BoardCards.kt:212` `emptyRow`. Tell apart:
  - monitoring off: `"Set up a provider in the phone app"`
  - no computer, signed out, or needs repair: the row `"Pair a computer"` / sub `"tap to start"`
- New `P/GlassesPairingCard.kt`. Tap on the row:
  - arm the phone's link window
  - show the card `"Pairing · m:ss"` with the body `"On your computer: type /rokid:pair in Claude, or run agentd pair"`
  - the countdown updates once per second
  - it ends with the brief `"Paired with <name> ✓"` or `"Time's up — try again"`
  - BACK cancels the window
- Tests: new `GuidedPairingTest` (a pure state machine `GuidedPairing` with states `IDLE`, `DOOR_OPEN(remainingMs)`, `PAIRED(name)`, `TIMED_OUT`), plus `BoardModelTest` and `GlassesScreenTest`.

**Interfaces:**
- **Consumes:**
  - `armLinkWindow`, `cancelLinkWindow`, `linkWindowRemainingMs`, `trustedMachines()` (existing)
  - Task 3's `needsRepair`
  - Task 4's `signedOut()`
- **Produces:** `class GuidedPairing(clock)`, used by both the phone screen and the glasses card:
  - `start(baselineMachineIds: Set<String>)`, `cancel()`, `tick(now)`
  - `onSecureConnected(machineId: String, name: String, atMs: Long)`
  - `state: StateFlow<State>`
- **Success rule:** `PAIRED(name)` happens only for an attempt-attributable connection:
  - a machineId that is not in the baseline captured at `start`, or
  - a machine that was in `needsRepair` / signed-out state at start, connecting securely with `atMs ≥ startMs`.

  A computer that was already trusted and connected never completes the attempt.
- **Event sources:** `AgentsMonitorService` emits `onSecureConnected` from a secure outbound `hello_ack` (Task 3) and from a secure inbound `bind()`.

- [ ] **Step 1: Write the failing tests:**
  - `guided_pairing_open_then_paired`
  - `guided_pairing_times_out_after_two_minutes`
  - `already_trusted_computer_does_not_complete_attempt`: another computer is trusted and connected at start and reconnects during the window, and the state stays `DOOR_OPEN`.
  - `repairing_computer_completes_on_new_secure_connect`
  - `board_shows_pair_a_computer_when_none_trusted`
  - `board_shows_setup_provider_when_monitoring_off`
  - `glasses_pair_row_arms_window_and_counts_down`
  - `back_on_pairing_card_cancels_window`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Guide pairing on the phone and from the glasses`.

### Task 6: Alert history and silent reminders (U1)

**Files:**
- New `P/AlertHistory.kt`. Pure, in-memory, and lost on a process restart by design.
- Modify `P/AlertDirector.kt` and `P/AlertCoordinator.kt`. They feed the history at these points:
  - first show
  - reminder re-show
  - `onAction` / `onCardConfirm` / `onQuestionConfirm` (the action sent)
  - LATER or a USER close (dismissed)
  - `onAlertClosed(id, reason)`: use the reason, which is ignored today
  - `invalidateSession`
- Modify `P/AlertCoordinator.kt:74`. `REMINDER` gives `show(wake=true, sound=false)`.
- Modify `P/AlertNotices.kt`. When `alert.reason == REMINDER`, the footer is `"Reminder"`, or `"Reminder · +N waiting"`.
- New `P/ui/HistoryScreen.kt`, plus a `HistoryCard` entry on `SettingsScreen`:
  - newest first
  - each row `"<PROVIDER> · <kind> · <session heading>"` with the sub `"<outcome> · <relative time>"`, plus `" · shown N×"` when N > 1
  - a `"Clear history"` action
  - the empty state `"No alerts yet — they'll appear here as your agents ask for things."`
  - controls for `history.keep_after_session` and `history.window_hours`
- Tests: new `AlertHistoryTest`, plus `AlertCoordinatorTest`, `AlertNoticesTest`, `ui/SettingsScreenTest`.

**Interfaces:**
- **Produces:**
  - `enum Outcome { PENDING, ACTED, DISMISSED, EXPIRED, WITHDRAWN }`
  - `data class HistoryEntry(alertId, sessionKey, provider, kind, heading, firstShownAtMs, shownCount, outcome, actionLabel: String?, endedAtMs: Long?)`
  - `AlertHistory(clock)` with:
    - `onShown`
    - `onActionAttempted(id, label)`, recorded only when the frame was actually written (`AgentdWire` result Sent)
    - `onActionRejected(id, error)`
    - `onDismissed`, `onClosed(id, reason: String)`, `onSessionGone(key)`, `prune(now, windowMs, keepAfterSession)`
    - `entries: StateFlow<List<HistoryEntry>>`

    At most 200 entries; the oldest drop first. `HistoryEntry` also carries `lastError: String?`.
- **Outcome rules:**
  - An attempt never finalises an entry. It stays PENDING until agentd's `alert_closed`.
  - A rejected ack keeps the entry PENDING and sets `lastError`, shown as `"Not sent: <error>"`.
  - A brief-only refusal (no secure link, truncated, too long) records nothing.
  - agentd reason `acted` → ACTED, with the last attempted label (`Allowed`, `Denied`, `Answered`, `Replied`), or `Handled` when nothing was attempted from the phone
  - `expired` → EXPIRED, shown as `"Ignored — timed out"`
  - `withdrawn` → WITHDRAWN, shown as `"Handled on laptop"`
  - Done/Error: a dismissal or read is final, DISMISSED or `"Read"`; for approvals and questions a dismissal only bumps the count and the entry stays PENDING
  - session gone while PENDING → WITHDRAWN
  - entries of a closed session are dropped at once unless `keep_after_session`; every entry is dropped after `window_hours`

- [ ] **Step 1: Write the failing tests:**
  - `acted_on_glasses_records_label`
  - `send_without_link_records_nothing`
  - `rejected_answer_stays_pending_with_error`
  - `answered_on_laptop_is_withdrawn`
  - `expired_is_ignored_timed_out`
  - `dismissed_approval_stays_pending_then_reminder_counts`
  - `session_end_marks_pending_withdrawn`
  - `closed_session_entries_dropped_unless_keep`
  - `window_prunes_old_entries`
  - `cap_is_200`
  - `reminder_shows_and_wakes_but_never_sounds`
  - `reminder_footer_says_reminder`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Keep a history of alerts and make reminders silent`.

### Task 7: A sound per alert kind, and one card per question (U3)

**Files:**
- Modify `P/AlertSoundPolicy.kt`. Replace `cue(kind, provider)` with `sound(kind, provider, reason): AlertSound`, where `sealed AlertSound = Speak(text) | Chime | None`:

  | Kind | Sound |
  |---|---|
  | APPROVAL | `Speak("<Name> needs approval")` |
  | QUESTION | `Speak("<Name> has a question")` |
  | ERROR | `Speak("<Name> hit an error")` |
  | DONE | `Chime` |
  | NOTICE | `None` |
  | any kind with reason REMINDER, RETRY, RESUME or UPDATE | `None` |

  The existing `shouldSpeak` gates (DND, quiet, volume, worn) apply to both Speak and Chime.
- New `P/ChimePlayer.kt`.
  - `ChimeTone.pcm(sampleRate = 44_100): ShortArray`: 880 Hz for 70 ms, then 1320 Hz for 110 ms, 15 ms linear fade in and out per note, peak ≤ 0.5 full scale.
  - `ChimeRoute.canPlay(outputs: List<Int>): Boolean`: true only for `AudioDeviceInfo.TYPE_BLUETOOTH_A2DP`, `TYPE_BLUETOOTH_SCO`, `TYPE_BLE_HEADSET`, `TYPE_BLE_SPEAKER`.
  - `ChimeRoute.pick(outputs: List<AudioDeviceInfo>): AudioDeviceInfo?` picks the first BT device of those types.
  - `ChimePlayer.play()` fails closed, so it is never audible on the speaker:
    1. **Pre-check.** On API ≥ 33, `AudioManager.getAudioDevicesForAttributes(attrs)` must be non-empty and contain only BT types. On API < 33, there is no chime (silent).
    2. Build a static `AudioTrack` with `USAGE_ASSISTANCE_SONIFICATION`, call `setPreferredDevice(pick(...))` and `setVolume(0f)`, then `play()` muted.
    3. **Unmute** to the normal volume only once `routedDevice`, read in the `OnRoutingChangedListener` or right after `play()`, is a BT type.
    4. On any routing change to a non-BT device, or a null one, mute, stop and release at once. Log `chime_dropped_route <type>`.
       - Also register for `AudioManager.ACTION_AUDIO_BECOMING_NOISY` while a chime plays. Android sends it before audio falls back to the speaker, and the chime mutes and stops on it.
       - The whole chime is 180 ms. The only residual is a BT drop that lands inside those 180 ms without a noisy broadcast; that is a device-checklist item (R191).
    5. With no BT output it never builds the track. Log `chime_dropped_no_bt_output`.
  - When the chime can't play, Done is display-only.
  - The pure decisions live in `ChimeRoute`: `canStart(devicesForAttributes)`, `mayUnmute(routedType)`, `keepPlaying(routedType)`.
- Modify `P/AlertDirector.kt:314`, `P/AgentsPluginService.kt:433`, `AlertGlasses`. `speakCue(alert)` becomes `playSound(sound: AlertSound)`.
- Modify `P/VoiceQuestionWiring.kt:219` (`questionCard`), the question deck. Each question is its own card, `Q<n>/<N> · <heading>`:
  - rows: the options, then `"Answer box (voice)"` when free text is allowed, then `"Next question ›"` (always enabled), and `"‹ Previous question"` when n > 1
  - after the last question, a `"Review answers"` card: one row per question, `"Q<n> <heading>: <answer or — not answered>"`, where a tap opens that question's card, then `"Send answers"`, enabled only when all are answered
  - BACK goes to the previous card, or closes from Q1
  - one question only: no review card; the existing `"Send answer"` row stays
  - Answers keep the exact wire strings (R124).
- Tests: `AlertSoundPolicyTest`, new `ChimePlayerTest` (pure parts), `QuestionFlowTest`, plus a new `QuestionDeckTest` for the pure deck model `QuestionDeck(flow)` with `index`, `next()`, `previous()`, `jump(n)`, `onReview`, `canSend`.

**Interfaces:**
- **Consumes:** `QuestionFlow` (unchanged).
- **Produces:** `AlertSound`, `ChimePlayer`, `QuestionDeck`.

- [ ] **Step 1: Write the failing tests:**
  - `done_chimes_approval_and_question_speak`
  - `reminder_retry_resume_are_silent`
  - `chime_obeys_dnd_quiet_volume_worn`
  - `chime_tone_shape_and_fades`
  - `chime_dropped_without_bt_output`
  - `chime_route_check_stops_on_non_bt_routed_device`
  - `chime_never_unmutes_unless_routed_bt`: covers routed speaker, null, and BT connected but the attributes route to the speaker.
  - `chime_silent_below_api_33`
  - `deck_next_works_unanswered`
  - `review_lists_unanswered_and_blocks_send`
  - `review_row_jumps_to_question`
  - `back_from_q1_closes`
  - `single_question_has_no_review_card`
  - `withdraw_mid_deck_closes_deck_with_brief`
  - `answers_keep_exact_wire_strings`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Chime for Done, speak for approvals and questions, one card per question`.

### Task 8: Condensed long voice replies, sent in full (U4/U13, supersedes R123's refusal)

**Files:**
- New `P/VoiceCondense.kt`. `condense(text: String, limitWords: Int): Condensed`, where `data class Condensed(display: String, totalWords: Int, shownWords: Int, condensed: Boolean)`. Algorithm:
  - Split on whitespace runs.
  - If `n ≤ limit`, `display` is the text with whitespace collapsed.
  - Otherwise `head = round(limit*0.4)`, `mid = round(limit*0.2)`, `tail = limit − head − mid`. The middle slice starts at `(n − mid) / 2`. `display = head + " … " + middle + " … " + tail`.
  - Each displayed token longer than 40 chars becomes its first 39 chars plus `…`, in the display only.
- Modify `P/VoiceCapture.kt:88-91,146,153`. Delete the `MAX_REVIEW_CHARS` refusal and the `TOO_LONG` copy. `Heard(text)` always keeps the full text.
- Modify `VoiceCard.view`:
  - when `condensed`, the first body row is `"Showing <shown> of <total> words · the full reply is sent"`
  - the condensed display follows in BODY rows
  - if the SDK's card row and char limits (see `docs/PLUGIN_SDK.md` rows and BODY tone) cannot hold `limit = 500` words, add a `"Read all"` row that opens the existing paged output reader on `display`. Every displayed word must be reachable on the glasses.
  - Send, Speak again and Cancel are unchanged.
- Modify `P/QuestionFlow.kt:42`. `setFreeText` keeps any length up to the wire cap `MAX_ANSWER_CHARS = 4000`. Above that it returns false, and the card shows the brief `"Answer too long — answer on laptop"`. The free-text review uses the same condensed view.
- Follow-up send: the existing 16 KiB cap and its brief stay.
- Modify `P/AlertSettings.kt` or `AgentsConfigStore`: `voice.word_limit`, default 250, choices `[100, 150, 250, 500]`, clamped to 50..500. Modify `P/ui/SettingsScreen.kt`: a `"Voice reply length shown"` choice in `AlertsCard`.
- Tests: new `VoiceCondenseTest`, plus `VoiceCaptureTest` and `VoiceReviewTest` (the R123 refusal tests are replaced, and listed in the report), plus `QuestionFlowTest`.

**Interfaces:**
- **Produces:** `VoiceCondense.condense`, `AgentsConfigStore.voiceWordLimit(): Int`.

- [ ] **Step 1: Write the failing tests:**
  - `short_reply_shown_whole`
  - `long_reply_head_middle_tail_with_ellipses`: n = 600, limit = 250 gives head 100, middle 50 from index 275, tail 100; the display holds exactly two ` … `.
  - `sent_text_is_the_full_transcript`
  - `one_giant_token_is_capped_in_display_only`
  - `word_limit_setting_clamped_to_500`
  - `free_text_over_4000_chars_refused_visibly`
  - `heard_card_shows_condensed_header`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Show long voice replies condensed and send them in full`.

### Task 9: Visible duplicate acks (R152 phone copy)

**Files:**
- New `P/LauncherCommandTracker.kt`. This is pure, and correlates commands that today get a fresh UUID per send (`AgentsPluginService.kt:743-756`).
  - `msgIdFor(sessionKey, command, arg, now): String`:
    - reuses the kept msgId of the same (sessionKey, command, arg) while it is younger than `KEPT_ID_MAX_MS = 23 h`. agentd's AppliedIds keep ids for 24 h (daemon.ts:79), so a re-tap after a lost ack is deduped by agentd and there is never a double `/compact`.
    - when a kept id is older than 23 h, the tap does NOT send. It shows the brief `"May already have been sent — tap again to send"` and arms the retry, the same as a duplicate.
    - otherwise it is a fresh UUID
  - `onAck(msgId, result, error, consumed, now): AckOutcome`:
    - `applied` clears the kept id
    - `rejected` with `consumed == false` clears it, since agentd freed it (phone-v2.ts:586)
    - `rejected` with `consumed == true` (e.g. `typed_after_cancel`) KEEPS it. The brief is `"Sent, but may not have finished — check laptop"`.
    - `duplicate` keeps it and arms `retryUntil = now + 30 s` for that key
  - `retryArmed(key, now)`: a tap while armed takes a fresh UUID (the wearer's explicit, informed "send again"). That fresh id becomes the kept id, and the retry disarms.
  - Kept ids are dropped when their session leaves the board.
  - An unknown msgId is ignored.
- **agentd (small change in this task):** the launcher_command `ack` frame carries `consumed: true` when the failure consumed the msgId (`launcher/session-state.ts:524,551`, `phone-v2.ts:586`). Add it to `protocol-v2.ts` and the fixtures. Test: `consumed_launcher_failure_ack_says_consumed`.
- Modify `P/AgentsPluginService.kt:743-756`. Send through the tracker, and route `launcher_command` acks to `tracker.onAck` by msgId.
- Modify `P/ControlMenu.kt:540` `ackNotice`. A `duplicate` outcome gives the brief `"Already sent — check laptop"`. While retry is armed, the row's sub is `"Tap to send again"`.
- Modify `P/AlertCoordinator.kt:194` `onAck`. A `duplicate` ack on `alert_action` or `question_answer` gives the brief `"Already answered"`.
- Test: new `LauncherCommandTrackerTest`, plus `ControlMenuTest` (replace the duplicate-is-null assert at 237) and `AlertCoordinatorTest`.

- [ ] **Step 1: Write the failing tests:**
  - `retap_after_lost_ack_reuses_msg_id`
  - `duplicate_ack_shows_already_sent_and_arms_retry`
  - `tap_within_30s_of_duplicate_uses_fresh_id_then_disarms`
  - `tap_after_30s_reuses_kept_id`
  - `lost_ack_retap_after_10_minutes_reuses_id`
  - `kept_id_older_than_23h_never_resends_without_informed_tap`: covers both a lost ack and a consumed rejection at 25 h.
  - `consumed_rejection_keeps_id_so_retap_is_duplicate`
  - `unconsumed_rejection_frees_id`
  - `applied_ack_clears_kept_id`
  - `service_send_and_ack_path_uses_tracker`: through `AgentsPluginService`'s send seam and a fake wire.
  - `duplicate_alert_ack_shows_already_answered`
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** Suite passes. Commit `Tell the wearer when a command was already sent`.

### Task 10: Docs and the device checklist

**Files:**
- Modify `plugins/agents/README.md`: TLS-only, guided pairing, TTL, history, sounds, the question deck, condensed replies.
- Modify `agentd/README.md`, if Task 1/2 left any gaps.
- Modify `docs/coding-agent/claude/design/2026-11-14-rokid-coder-design.md`:
  - §12.1: TLS-only and mutual on both paths; no monitor-only
  - §6.1: reminders silent, sound per kind
  - point to U1–U14
- Modify `docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md`. Add device items:
  - the chime is heard on the glasses, and not on the speaker when the glasses are off
  - guided pairing over Wi-Fi with `/rokid:pair`
  - the glasses "Pair a computer" row
  - a pre-Plan-4 phone gets "Pair again"
  - a reminder is silent
  - question deck swipes
  - the condensed 300-word reply
- Modify `docs/coding-agent/MORNING.md`: Plan 4 status.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run all suites and paste the tails into the report.
- [ ] **Step 3:** Commit `docs: Plan 4 transport, pairing, alerts and voice`.
