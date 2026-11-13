# Rokid-Coder: glasses and phone compatibility research (2026-11-14)

Research only. Nothing was built, installed or changed. Method: read the Nexus clone
(`~/Desktop/rokid/rokid-resources/nexus/Rokid-Nexus`, HEAD `15cd98ad`,
glasses-hub 1.8.1, Agents plugin 1.0.0), the Rokid docs and notes, and the PCA and LiveFit docs.
"Nexus" below means that clone; `BUSSPEC` = `Rokid-Nexus/BUSSPEC.md`, `SDK` = `docs/PLUGIN_SDK.md`.

`adb devices` (run once): glasses `<glasses-serial>` (USB) and the phone
(wireless) are both attached, so every UNKNOWN below can be tested without new hardware.
Nexus is not installed on either (`learning/nexus-platform.md`); PCA is. Both use the Rokid link and both claim
touchpad gestures (PCA double-tap, Nexus triple-tap), so test them together before relying on either.

## Summary

| # | Topic | Verdict |
|---|---|---|
| 1 | Wake the display and show an item | PARTIAL |
| 2 | Delivery guarantees | NOT SUPPORTED (we must add an app-level ack) |
| 3 | Sound and haptics | PARTIAL (phone speech over Bluetooth only) |
| 4 | Do-not-disturb | PARTIAL (phone readable; glasses UNKNOWN) |
| 5 | Input and speech | SUPPORTED, except long-press (firmware) |
| 6 | Paged text and lists | SUPPORTED with existing types |
| 7 | Fork, build, deploy | SUPPORTED (build UNKNOWN until tried) |
| 8 | Background survival | PARTIAL |

## 1. Wake-on-event: PARTIAL

Mechanisms that exist:
- **Notice band** (best fit). `NexusNotice(wakeDisplay = true)`, show-only (BUSSPEC "Notice protocol v1",
  SDK "Notice bands"). It is a `TYPE_ACCESSIBILITY_OVERLAY` drawn over whatever is on screen, native apps
  included, and needs no surface open and no plugin foreground. With `interactive` or up to three `actions`
  it claims the confirming tap (and swipes when two or more actions) even over a native app. It answers
  once, via `/notice/action` or `/notice/input`. Allow / Deny / Details can therefore be answered
  straight on the band. `backdrop = true` blacks out everything behind it.
- **Surface (foreground card)**: `showCard` / `showReader`. Surfaces always request a wake
  (BUSSPEC "Display wake policy"). The slot is exclusive (`SURFACE_BUSY` if another plugin holds it).
  Agents already adopts a surface from a dormant state when the band is tapped
  (`plugins/agents/.../AgentsPluginService.kt` `onNexusNoticeInput` / `attemptAdoption`).
- **Wake implementation**: `glasses-hub/.../DisplayWakePolicy.kt`, a 3 s
  `SCREEN_BRIGHT_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP`. Hardware evidence that the lock does light this panel is in
  `contracts/2026-08-10-assistant-wake-hold.contract.md` (`power mode 2` right after `decision=wake`).
- **Longer hold**: `AssistantDisplayEpisode.kt` holds the display for up to 90 s (`DISPLAY_HOLD_CEILING_MS`).
  It is hard-wired to plugin id `assistant` (`NoticeDisplayHoldPolicy.ASSISTANT_PLUGIN_ID`).

Limits (documented):
- A wake is a pulse, never a hold. BUSSPEC: "No plugin can ask the platform to keep the display lit".
  The ROM then dims and sleeps the panel (~5 s timeout; same contract file). A woken band is therefore
  visible for only a few seconds unless the wearer touches the pad.
- Global budget: one wake per 5 s across all plugins, and at most 2 unattended notice wake episodes until a
  quiet 60 s (`DisplayWakePolicy.MAX_UNATTENDED_NOTICE_WAKE_EPISODES`, `NOTICE_EPISODE_RESET_MS`). A reminder
  loop with X below 60 s will be throttled after two.
- A notice is never queued for a down link (`CAPABILITY_NOT_AVAILABLE`); the camera suppresses notices; a band lives
  2-45 s with a 90 s absolute lifetime; one band at a time, last wins; BACK always dismisses.
- Agents today never sets `wakeDisplay` and alerts only on `NEEDS_YOU` and `ERROR`
  (`AttentionDecisionEngine.deservesAttention`). Done is not an alert state. Both are small plugin changes.
- "CXR-direct" from a plugin is **not possible**: BUSSPEC says exactly one CXR-L session exists, owned by the
  phone hub, and no client links CXR-L directly. A CXR-direct path means changing phone-hub, not the plugin.
  PCA's `PopupOverlay` / `MinimisedIcon` (`TYPE_APPLICATION_OVERLAY`, spec `2026-10-21-battery-wave-a3-glance-model.md`)
  never wake the display, by design, and need PCA's own glasses activity alive. Nexus's accessibility service is the sturdier host.

UNKNOWN (device test): the wake plus first-tap path on a sleeping panel (does the first touch
wake and still reach the band before it expires?), band over a call or navigation scene, and behaviour when not worn.
`/glasses/device-info.wearingStatus` and `LinkStateBits.GLASSES_WORN` exist, so alerts can be skipped when the glasses are off.

**Recommend**: notice with `wakeDisplay = true`, actions Allow / Deny (and More), 12 s TTL, plus a
reminder loop longer than the 60 s episode limit. Fork `NoticeDisplayHoldPolicy` to also hold for `agents`
during an approval (reuse the 90 s ceiling), because 3 s is too short to decide. Tapping the band opens the list card.

## 2. Delivery guarantees: NOT SUPPORTED

Evidence: BUSSPEC "Notice protocol v1" says verbatim that a successful transport return is not an application
acknowledgement and that the contract "adds no generic reliable-delivery layer or durable retry queue". Also
"CXR send success is not an acknowledgement of delivery" ("Authenticated SPP transport v1").
- No acks, no replay, no ordering across CXR (JSON of 3 KB or less) and SPP (larger, binary). The renderer drops any
  message whose `seq` is not newer, and surfaces are idempotent full-state, so the phone can resend.
- Transport: SPP frames are MAC-authenticated with a per-direction counter (a gap kills the session), so SPP itself is ordered. After
  a failed tap send the band shows `Delivery not confirmed` and does not retry.
- Replay after reconnect exists only for pins (held while the glasses sleep), activities (resent on capability
  re-announce) and the latest surface state. **Notices are never replayed.**
- Nothing on the bus maps to PCA's GLASSES_EXIT loss. The glasses hub is an AccessibilityService, not an activity, and
  SPP is a hub-owned socket. The nearest equivalent is "Hi Rokid ended the session": the phone hub now reports the link down
  and does not reconnect (CHANGELOG "Unreleased", `BusHubService.kt:617`). UNKNOWN on device: what a `showNotice` does then.
- agentd to phone leg is better: `nexus-agents/1` has contiguous `session_upsert` seq, a `refresh` on a gap and a fresh
  snapshot after every reconnect (`plugins/agents/README.md`).
- Agents' alert memory is a fingerprint committed when `showNotice` returns `SENT`, which is only a Binder hand-off, not delivery
  (`AttentionDecisionEngine`, `raiseAttention`). That is the PCA "rc=0" mistake at one remove.

**Must add**: (a) keep the session state authoritative on the phone and treat the glasses as a view (already the pattern);
(b) commit an alert as delivered only on a real signal, i.e. `/notice/action`, `/notice/input` or `/notice/closed` with reason `user`,
and otherwise re-raise on the reminder loop; (c) optionally a tiny glasses-to-phone `/notice/shown` ack in the forked
glasses-hub; (d) give every approval a request id and make the answer idempotent in agentd; (e) never alert while `NO_LINK`, surface the link
state on the phone instead; (f) PCA's lesson on throughput after a Bluetooth drop (about half for a while) applies to the SPP too.

## 3. Sound: PARTIAL

- Glasses speaker: hardware exists (`rokid-docs/yodaos/docs/hardware/audio.md`, speaker device, notification-stream
  curves), but Nexus has no `AudioTrack`/`SoundPool`/`MediaPlayer`/vibration code anywhere (grep; `plans/006-video-playback-on-glasses.md`
  records "unproven", and its Phase 0 spike was never run). PCA measured no TTS engine on the glasses
  (`phase0-results.md` "TTS": init=-1). So NOT SUPPORTED as a glasses-side capability. UNKNOWN whether a plain APK may play on the speaker.
- Phone audio over Bluetooth A2DP to the glasses: **works**. PCA user-confirmed phone TTS heard on the glasses, A2DP active device.
  Nexus `tts` capability (`/tts/speak`, BUSSPEC "TTS protocol v1", SDK 3.3): phone engine only, 1024 chars, one utterance slot,
  waits a few seconds for the audio route and then drops with `UNAVAILABLE` rather than speaking from the phone loudspeaker, with `/tts/started`
  and `/tts/done` events. Needs the `tts` grant (Agents requests only `surfaces`).
- Haptics and tones: none. `plans/011-notice-surface.md`: sound/haptic on notices is "no" by default. A glasses vibrator is not documented anywhere.

**Recommend**: short spoken cue via `tts` ("Claude needs approval") as the alert sound, or, if a plain beep is wanted, a short
`AudioTrack` tone on the phone (USAGE_MEDIA) that follows the A2DP route; test both. Skip when there is no BT route, matching Nexus's rule.
Glasses-side sound stays a later spike.

## 4. DND: PARTIAL

- Phone: nothing in Nexus reads DND (grep for `InterruptionFilter`, "do not disturb": none; the only phone notification code is channels).
  From Android knowledge, not from the repo: `NotificationManager.getCurrentInterruptionFilter()` needs **no permission**
  (changing it needs notification-policy access), and `ACTION_INTERRUPTION_FILTER_CHANGED` can be listened to. UNKNOWN until tried on the
  Samsung (Android 17, "Modes").
- Glasses: no DND or quiet mode appears in Nexus, CXR-S/L/M docs or yodaos docs. `/glasses/device-info` carries only `sound`
  (volume), `brightness`, `batteryLevel`, `isCharging`, `wearingStatus`, `systemVersion`
  (`GlassesDeviceInfoPayload.kt`, BUSSPEC "External plugin lifecycle v1"). CXR-M can set volume and screen-off timeout but is banned in Nexus.
  So NOT SUPPORTED / UNKNOWN.

**Recommend**: phone-side only. Read the interruption filter before sound and wake; honour it as "visual only" (the design says sound
follows DND). Also treat glasses `sound == 0` and not-worn as "no sound".

## 5. Input and speech: SUPPORTED

- Keys a plugin surface receives (`SurfaceController.FORWARDED_KEYS`): BACK, ENTER, DPAD_CENTER, DPAD L/R/U/D (swipe = L/R, ring = U/D),
  SPACE, MEDIA_PLAY_PAUSE/NEXT/PREVIOUS. In a reader the hub scrolls and the plugin gets only ENTER/DPAD_CENTER and BACK (SDK "Reader surfaces").
  Notices claim confirm (and directions with 2+ actions). Triple-tap belongs to Nexus; **long-press and two-finger belong to firmware**
  (BUSSPEC line 1642; LiveFit: long press is `KEY_PROG1`, system "Hi Rokid"). Every touch starts with KEYCODE 83, and ENTER is classified
  300-500 ms later; double-tap is two ENTERs (Agents guards 600 ms).
- STT: capability `stt` (manifest `CAPABILITIES`, `RECEIVE_PREFIXES` add `/stt`; user grants it in the Nexus app). SDK 3.2
  `nexusSpeechSession(callbacks).start(language)`; callbacks `onSpeechStarted / onSpeechState / onSpeechPartial / onSpeechFinal /
  onSpeechStopped`. Utterance mode only; engine is the user's (phone recognizer by default); one global session (`DENIED_BUSY` if another
  holds the mic). Transcripts never reach the glasses or logs, so the plugin must draw them itself. Raw PCM is `microphone` (16 kHz mono PCM16).
  PCA lesson: a final result can be null, so fall back to the last partial (not checked in Nexus's code).
- Assist button: `onNexusGlassesAiButton(active)` gives press and release edges to any approved plugin with no grant. Taking the button over
  (`assistant` grant, `requestNexusAssistantTakeover`) is global, one assistant at a time, and the hub yields to Hi Rokid native scenes.
- **AIUI exclusivity gotcha**: when "Hi Rokid" wakes, the system assistant keeps the microphone (CXR-L audio is digital silence) and answers
  itself (LiveFit `REVIEW-BRIEF.md` item 3, `2026-10-05-livefit-v1-design.md`). The jsai/AIUI scene is exclusive and fullscreen and is closed by a CXR-L
  CustomView (`docs/AIUI_RUNTIME.md`). Without takeover a button press still opens the native assistant.

**Recommend**: tap-to-talk on our own surface (ENTER starts `nexusSpeechSession`, show partials by updating the card, ENTER confirms,
BACK cancels). Do not depend on the assist button or wake word; add button takeover only as an optional extra.

## 6. Paged text and lists: SUPPORTED (no new card type)

- Selectable list: `NexusCard.richLines` (SDK "Surface list rows"), up to 64 rows, `text` and `sub` 240 chars, tone ALERT/NORMAL/DIM/BODY,
  `selected` rail drawn by the hub. Selection is plugin-driven: handle swipe in `onNexusInput`, re-render (Agents `moveSelection`, decision card).
  Row text is capped, so "expand to read the full text" = ENTER opens a reader.
- Long scrollable text: `NexusReader` (up to 240 segments, 4096 chars each, 40k total), renderer-owned scroll, `anchor` TOP or BOTTOM. No per-segment
  focus and no options inside a reader.
- Paged text: only the notice (8 measured lines per page, 1024 chars, swipe turns pages) and it is **paged or answerable, never both**
  (BUSSPEC "One question, one answer"; `notice-band-states.md` state 5). A one-action notice may both page and answer.
- Answer box: `editable` card field (bonded or phone keyboard), or the STT flow in item 5.

**Recommend**: summary on a notice (one page), board and option lists as `richLines` cards, full output as a reader (scrolled, not paged).
A real "paged output" with selection would need a fork change in `SurfaceController`.

## 7. Modify and deploy glasses-hub: SUPPORTED

- Licence Apache-2.0; module `:glasses-hub` (`applicationId com.anezium.rokidbus.glasses`, versionName 1.8.1, minSdk 31, targetSdk 32);
  `./gradlew :glasses-hub:testDebugUnitTest :glasses-hub:assembleDebug` (`AGENTS.md`; Java 17 toolchain, `local.properties` is the
  machine's and must not be edited). Phone: `:phone-hub:assembleDebug`. Plugins build with `-PskipCxrGlobal=true`; hubs do not. Not run here.
  UNKNOWN whether `com.example.cxrglobal:lib:0.3.0` resolves (no sibling `../CxrGlobal` checkout; needs `mavenLocal`/JitPack).
- Deploy paths: (a) the phone's onboarding pushes the glasses APK over CXR after checking digest, package, `versionCode = major*10000+minor*100+patch`, and a
  pinned signer. A fork must pass `-PglassesApkSignerSha256=<our cert>` to the phone build (`docs/GLASSES_APK_VERIFICATION.md`). (b) `adb -s <glasses-serial> install -r`
  over USB (as in the PCA runbook), then enable the accessibility service on the glasses. Changing signer breaks `-r` upgrades (uninstall first).
- Update trap: `NexusUpdateChecker.RELEASES_URL` is hard-coded to `Anezium/Rokid-Nexus`. Repoint or disable it in the fork, or the phone will offer
  upstream APKs over ours.
- Version coupling: **yes**. Agents needs the notice tier (hub 1.0.46+; today notice v5 and `noticeInteractionVersion` 1, exact-match gated on both hubs, otherwise
  `CAPABILITY_NOT_AVAILABLE`), and the reader needs hub 1.4.3+ for `TOP`. Any new wire field or ack must ship in both phone-hub and glasses-hub together; the Agents plugin
  itself is a separate APK that only checks `client.supportsNoticeSurface` at runtime. Keep fork changes additive and upstream-clean (the design's rule).

## 8. Background survival: PARTIAL

- Known and documented (`plugins/agents/README.md` "Phase 1 limits"): on a Vivo device Android froze the process (`cgroup.freeze=1`) while the service said
  `isForeground=true`; agentd saw a phone that connected and never answered `hello` (15 s timeout, redial forever). Cause given: no visible
  notification (Agents holds no `POST_NOTIFICATIONS`, channel `IMPORTANCE_MIN`).
- What Nexus does: separate `AgentsMonitorService` (`specialUse` foreground, `START_STICKY`), a battery-exemption prompt, `AgentsFreezeWatch` (heartbeat gap above 3x the interval means
  suspended, because `isIgnoringBatteryOptimizations` is unreliable there), and a pointer to App info, Battery usage, "Allow background power usage". No boot receiver. Doze can still delay transitions.
- Not solved: nothing queues an alert while frozen; the board is the fallback.

**Recommend**: make the foreground notification visible (needs `POST_NOTIFICATIONS`; the design wants phone notifications anyway), keep the freeze watch and surface its result in settings,
have agentd retry with an answer timeout, and test on the Samsung (not a Vivo). Exemption steps for Vivo remain a user instruction.

## Open device tests (priority order)

1. Notice with `wakeDisplay` on a sleeping panel: visible time, first-tap behaviour, band over native app and over a call.
2. Phone TTS and a short tone to the glasses over A2DP, and the `getCurrentInterruptionFilter` read on the Samsung.
3. `stt` session started from a surface tap: null final, latency, `DENIED_BUSY` with PCA running.
4. Behaviour of `showNotice` when Hi Rokid closes the session or the glasses are off.
5. Build of `:glasses-hub` and `:phone-hub` from the clone, and an adb sideload of a fork glasses APK.
