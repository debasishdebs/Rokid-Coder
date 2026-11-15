# ADR: The phone and glasses core split

- **Status:** Proposed. Plan 6a T2, Step 1. Nothing else in T2 starts until the Codex review of
  this ADR says READY.
- **Base:** `release/1.0.0` at `548576f4`. Every `file:line` below is at that commit. Paths
  without a module prefix are relative to `vendor/nexus/`.
- **Requirements:** Plan 6a T2 `[FR 4, FR 5, FR 6]`, `[6a-R6]`, `[6a-R7]`, `[6a-R8]`, R12′.

## Context

`:phone-hub` is one Android app whose `BusHubService.kt` (5,724 lines) owns everything: the CXR
link, SPP authentication, the bus, every HUD tier, speech, the glasses install, and also the
plugin runtime, Store, updater, Patcher, photo sync, the files explorer and manual ADB setup.
Its `onCreate` builds the plugin runtime inline with the link: `BusHubService.kt:953`
(`pluginDiscovery = PhonePluginDiscovery(packageManager)`) sits between the TTS setup
(`:872-887`) and the speech setup (`:974-990`), and the binder's `registerPlugin`
(`:515-591`) is the only way anything reaches the bus.

Our product needs the link, the HUD, input, speech and the glasses install, with the Agents
code in-process and none of the plugin runtime (T3's dex and dependency checks). `:glasses-hub`
is the same story on the glasses, minus the plugin runtime.

## Decision summary

1. **`:phone-core`** (Android library) gets the link, SPP, routing, the HUD tiers, input,
   speech (Android recognizer and Android TTS only) and the glasses install, as a plain class
   `HubCore` driven by a Service the shell owns. `:phone-hub` keeps its application id,
   `BusHubService` (same FQN, so `HubTarget.PHONE` still resolves) and every upstream-only
   feature, and reaches the core through one opt-in shell API (`@HubShellApi`) and one hook
   interface (`HubShellHooks`).
2. **The Agents code talks to `GlassesSurface`**, which `HubCore.surface()` implements over the
   existing bus-client `NexusPluginClient`, connected to the core through an in-process
   transport instead of AIDL. The Agents code keeps the SDK's exact semantics (notice
   once-per-question, speech and TTS state machines, preflights) because it is the same SDK
   code, and the hub sees the same `pluginId`-owned traffic it sees today.
3. **The in-process app replaces the plugin lifecycle with a single-app foreground policy**
   (`SingleAppForeground`) in the core. The upstream shell plugs its `PhonePluginRegistry` +
   `ExternalPluginController` in through the same interface.
4. **`:glasses-core`** (Android library) gets all of `glasses-hub`'s code, resources, AIDL,
   assets and manifest components, by pure moves. `glasses-hub` keeps the application id,
   version, signing, launcher icons and a near-empty manifest.
5. **Merge-friendliness is a constraint, not a nicety.** Files move with `git mv` and keep
   their names; `BusHubService.kt` is deleted at its old path so git's rename detection maps it
   onto `HubCore.kt` (see §5).

---

## 1. The SDK interaction inventory

Found by grepping `mobile/agents` for every `com.anezium.rokidbus.client.*` and
`com.anezium.rokidbus.shared.*` import, then every call through them. Only these files touch
the SDK: `AgentsPluginService.kt`, `AlertBand.kt`, `VoiceQuestionWiring.kt`; the rest
(`BoardCards`, `AlertNotices`, `AlertDirector`, `GlassesPairingCard`, `ControlMenu`,
`BoardModel`, `GlassesScreen`, `VoiceCapture`, `AlertSoundPolicy`) only build or read SDK
value types (`NexusCard`, `NexusReader`, `NexusNotice`, `NexusNoticeUpdate`,
`NexusInputEvent`, `NexusSdkResult`, `NexusNoticeCloseReason`, `NexusSpeechStopReason`,
`LinkStateBits`), which `GlassesSurface` reuses unchanged. The phone UI imports `BusTheme` and
`NexusUi` from bus-client; those are Compose/View helpers, not glasses interactions.

Today the hub delivers every callback on the main thread: `BusClient.kt:49,65-79` posts each
binder callback to `Handler(Looper.getMainLooper())`. The in-process transport keeps that
(§3.3), so every callback row below says **main**.

"Calls: any thread, non-blocking" means the call validates, enqueues onto the core's
single-thread local-ingress executor (§3.3) and returns; `SENT` means accepted, exactly as an
AIDL `oneway` call means today (`SurfaceModels.kt:516-523`).

### 1.1 Lifecycle, link and device

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| L1 | `AgentsPluginService.kt:339-361` `onNexusOpen()` (no-arg; `openType` ignored) | `NexusPluginCallbacks.onOpen(openType)` → `NexusPluginService.kt:133` | `SurfaceListener.onOpen(openType: String)`; `state.lifecycle = OPEN` | main | Delivered once per open. A duplicate open (fresh event id) re-presents, as `NexusPluginClient.kt:884-893`. `openType` is `open`, `resume` or `adopted` (L5). |
| L2 | not overridden (Agents holds no audio lease) | `onBackground()` → `NexusPluginService.kt:152` | `SurfaceListener.onBackground()`; `lifecycle = BACKGROUND` | main | Only after a detach with an active audio lease, which the in-process app never holds; kept for completeness. Speech and TTS are released **before** the callback (`NexusPluginClient.kt:899-903`). |
| L3 | `AgentsPluginService.kt:373-395` `onNexusClose()` | `onClose()` → `NexusPluginService.kt:139` | `SurfaceListener.onClose()`; `lifecycle = CLOSED` | main | Once per open. Before it: the active speech run ends `onStopped(CANCELLED)` and every accepted utterance ends `onDone(STOPPED)` (`NexusPluginClient.kt:613-617,666-670`). The surface ids are hidden by the hub. |
| L4 | `AgentsPluginService.kt:363-365` `onNexusLinkState(state)` → `AlertSoundPolicy.kt:80-85` (worn bit) | `onLinkState(Int)` | `SurfaceListener.onStateChanged(state: SurfaceState)`; `SurfaceState.linkState`, `.glassesWorn` | main | Every change. Capability flags (`noticeSupported`, `editableSupported`, `ttsSupported`, `noticeShownAckSupported`) are recomputed in the same snapshot (`NexusPluginClient.kt:749-754`). |
| L5 | `AgentsPluginService.kt:980-983` `attemptAdoption()` after a band tap while closed (`:433`) | `surfaceSession()` + `showCard` while closed → hub adopts (`PhonePluginRegistry.kt:154-161`, `ExternalPluginController.kt:227-244`) | `showCard`/`showReader` while `CLOSED` | call: any; open: main | If the HUD is idle the core adopts: `onOpen("adopted")` follows. If not, `onSurfaceRejected("SURFACE_BUSY")`. |
| L6 | `AgentsPluginService.kt:419` and `:393` `surface?.hide()` | `NexusSurfaceSession.hide()` | `hide(): NexusSdkResult` | call: any | Hides the surface and ends the session: `onClose()` follows once (`closeOnHide = true`, `BusHubService.kt:1461-1465` → `:2879-2893`). Idempotent while closed. |
| L7 | `AgentsPluginService.kt:367-371` `onNexusMessage(GLASSES_DEVICE_INFO)` → `AlertSoundPolicy.kt:87-93` (volume) | `onMessage(path = /glasses/device-info)` | `SurfaceListener.onDeviceInfo(info: GlassesDeviceInfo)`; last value in `deviceInfo` | main | On every CXR device-info report (`BusHubService.kt:639-641` → `:5080-5096`). Never carries the serial number. |
| L8 | `AgentsPluginService.kt:256`, `:456-470` service create/destroy | `NexusPluginService.onCreate/onDestroy` (`:94-115`, `:117-129`) | `attach(listener, notices)` / `detach()` | call: main | `attach` replaces any earlier pair. After `detach` no callback fires; outstanding speech is stopped and TTS closed, as `onDestroy` does today. |
| L9 | implicit: `NexusPluginService.kt:131-137,362-366` promotes the plugin's own foreground notification on open | `promoteNexusSessionForeground()` | none | — | Dropped on purpose: the in-process app runs inside the core's host service, which is already foreground (`connectedDevice|microphone`). T3 owns that service. |

### 1.2 Cards, readers and card input

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| C1 | `AgentsPluginService.kt:1012` `showCard(card)` | `NexusSurfaceSession.showCard` | `showCard(card: NexusCard): NexusSdkResult` | call: any | Fire-and-forget; superseded by the next show/update; dropped by `hide()` or close. FIFO with every other call. |
| C2 | `AgentsPluginService.kt:1012` `updateCard(card)` | `updateCard` | `updateCard(card: NexusCard): NexusSdkResult` | call: any | As C1. |
| C3 | `AgentsPluginService.kt:993` `showReader(reader)` | `showReader` | `showReader(reader: NexusReader): NexusSdkResult` | call: any | As C1; paged output is the reader's segments (`NexusReader`, limits enforced at `SurfaceModels.kt:182-184`). |
| C4 | `AgentsPluginService.kt:993` `updateReader(reader)` | `updateReader` | `updateReader(reader: NexusReader): NexusSdkResult` | call: any | As C1. |
| C5 | `AgentsPluginService.kt:670-673` `activeSurface.onRejected = …` | `NexusSurfaceSession.onRejected` (`SurfaceModels.kt:516-523`, armed per call by `watchForSurfaceError`) | `SurfaceListener.onSurfaceRejected(code: String)` | main | At most once per rejected call, for any surface call (codes: `SURFACE_BUSY`, `INVALID_SURFACE_ID`, image codes). Agents keeps its own attempt counter, as today. |
| C6 | `AgentsPluginService.kt:397` `onNexusInput(event)` → `GlassesScreen.kt:315` | `onInput(NexusInputEvent)` | `SurfaceListener.onInput(event: NexusInputEvent)` | main | Only while `OPEN` (`NexusPluginClient.kt:917`). |
| C7 | `AgentsPluginService.kt:663-667` `supportsEditableSurface` gate; `:676-681` card with `EditableSurfaceField` | `NexusPluginClient.supportsEditableSurface` (`:118-120`) | `state.editableSupported`; field sent inside `NexusCard.editable` via C1/C2 | call: any | Checked at the moment of the call; can flip with the link. |
| C8 | `AgentsPluginService.kt:693-716` `onNexusSurfaceTextCommitted` | `onSurfaceTextCommitted(surfaceId, text, cancelled)` | `SurfaceListener.onTextCommitted(surfaceId: String, text: String, cancelled: Boolean)` | main | At most once per editable field; `text` is empty when cancelled. A close drops a pending field silently. |

### 1.3 Notices and wake

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| N1 | `AlertBand.kt:19-25`, `:40-44` `client.showNotice(notice)` behind `supportsNoticeSurface` (`:21,48,56`) | `NexusPluginClient.showNotice` (`:177-189`) | `showNotice(notice: NexusNotice): NexusSdkResult`; `state.noticeSupported` | call: any | Works in any lifecycle state (a dormant app may say one thing). Replaces this app's band. |
| N2 | `AlertBand.kt:27-31` `client.updateNotice(update)` | `updateNotice` (`:211-222`) | `updateNotice(update: NexusNoticeUpdate): NexusSdkResult` | call: any | `rearm = false` needs the interaction version from registration (`:213`), which the in-process registration carries. |
| N3 | `AlertBand.kt:33-37` `client.hideNotice()` | `hideNotice` (`:224-238`) | `hideNotice(): NexusSdkResult` | call: any | Followed by `NoticeCallbacks.onClosed(OWNER)`; any input in flight after the hide is dropped (`noticeHidePending`). |
| N4 | `AgentsPluginService.kt:442-444` `onNexusNoticeShown` | `onNoticeShown()` | `NoticeCallbacks.onShown()`; `state.noticeShownAckSupported` | main | At most once per show; a late ack for a replaced band is dropped. |
| N5 | `AgentsPluginService.kt:425-434` `onNexusNoticeInput` | `onNoticeInput(event)` | `NoticeCallbacks.onInput(event: NexusInputEvent)` | main | At most once per question. |
| N6 | `AgentsPluginService.kt:436-439` `onNexusNoticeAction` | `onNoticeAction(id)` | `NoticeCallbacks.onAction(id: String)` | main | At most once per question; never together with N5. |
| N7 | `AgentsPluginService.kt:446-454` `onNexusNoticeClosed` | `onNoticeClosed(reason)` | `NoticeCallbacks.onClosed(reason: NexusNoticeCloseReason)` | main | Exactly once per notice, including the app's own hide. |
| N8 | `AlertNotices.kt:52-60` `wakeDisplay = wake && …`, used by `AlertDirector.kt:332-333` | `NexusNotice.wakeDisplay` | a field of N1 | call: any | No separate call. The contract test asserts the flag reaches the wire payload. |

### 1.4 TTS

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| T1 | `AgentsPluginService.kt:494-502` lazy `nexusTtsSession(...)`, `speak(cue)`, drop on `NOT_REGISTERED` | `NexusTtsSession.speak` (`NexusTtsSession.kt:47-73`) | `speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult` | call: any | One internal `NexusTtsSession`, re-made after a release, so callers never hold a dead session. Errors are the return value (`TTS_RATE_LIMITED`, `CAPABILITY_NOT_AVAILABLE`, `INVALID_PAYLOAD` for a reused id, `NOT_REGISTERED`). |
| T2 | `AgentsPluginService.kt:497` `onTtsStarted` (no-op today) | `NexusTtsCallbacks.onTtsStarted` | `TtsCallbacks.onStarted(utteranceId: String)` | main | Once per accepted utterance. |
| T3 | `AgentsPluginService.kt:498` `onTtsDone` (no-op today) | `onTtsDone(id, reason)` | `TtsCallbacks.onDone(utteranceId: String, reason: NexusTtsDoneReason)` | main | Exactly once per accepted utterance: `COMPLETED`, `STOPPED`, `PREEMPTED`, `CANCELLED`, or `UNAVAILABLE` (the error path). Close/detach ends all with `STOPPED`. |
| T4 | `AgentsPluginService.kt:461` `tts?.close()` | `NexusTtsSession.stop()/close()` | `stopSpeaking(): NexusSdkResult` | call: any | Stops the current utterance; its `onDone(STOPPED)` follows. |

### 1.5 STT

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| S1 | `VoiceQuestionWiring.kt:73-90` `speechSession(callbacks)` then `start("auto")` | `NexusSpeechSession.start` (`NexusSpeechSession.kt:58-79`) | `startSpeech(language: String?, listener: SpeechListener): SpeechHandle`; `SpeechHandle.result` | call: any | One run at a time per surface: a second start while one is pending or active gets `CAPABILITY_NOT_AVAILABLE` and no callbacks. Each run has its own listener, so a late callback can never reach a newer run. |
| S2 | `VoiceQuestionWiring.kt:75` `onSpeechStarted(realtime)` | `onSpeechStarted` | `SpeechListener.onStarted(realtime: Boolean)` | main | Once, when the hub accepts. |
| S3 | `VoiceQuestionWiring.kt:76` `onSpeechState` (ignored) | `onSpeechState` | `SpeechListener.onState(state: NexusSpeechState)` | main | 0..n while active. |
| S4 | `VoiceQuestionWiring.kt:77-79` `onSpeechPartial` | `onSpeechPartial` | `SpeechListener.onPartial(text: String)` | main | 0..n while active. Never logged `[6a-R8]`. |
| S5 | `VoiceQuestionWiring.kt:80` `onSpeechFinal` | `onSpeechFinal` | `SpeechListener.onFinal(text: String)` | main | 0..1 per run. |
| S6 | `VoiceQuestionWiring.kt:81-83` `onSpeechStopped(reason, error)` | `onSpeechStopped` | `SpeechListener.onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?)` | main | Exactly once per accepted or denied run (`DENIED_*` for a refusal after `SENT`; `LINK_LOST`, `NO_SPEECH`, `ERROR` with `error`). |
| S7 | `VoiceQuestionWiring.kt:88` `capture.attach { session.stop() }` | `NexusSpeechSession.stop()` (`:81-90`) | `SpeechHandle.stop()` | call: any | Stops only its own run; a no-op after the run ended. Ends with `onStopped(CANCELLED)`. |

### 1.6 Not used, and therefore not on `GlassesSurface`

Ink, image, timed lines, media, pins, activities, audio leases, snapshots, skills, HTTP proxy,
assistant takeover, the AI button. `GlassesSurface` is private to our app, so a later need adds
a row and a member; nothing here is a public SDK.

---

## 2. The `BusHubService` coupling map

`Core` moves into `:phone-core` (`HubCore.kt` unless said otherwise). `Shell` stays in
`:phone-hub` (`BusHubShellService.kt`, see §5). `Split` names which lines go where. `Hook`
means the core calls a `HubShellHooks` member at that point (§3.5), which is a no-op in our
app.

### 2.1 State and fields

| Lines | Member(s) | Goes to |
|---|---|---|
| `178-219` | `Registration`, `AuthorizedSender`, `AudioLease`, `SpeechBusSession` | Core. `AuthorizedSender` becomes a public top-level `@HubShellApi` class (the shell's admission hook returns it). |
| `221-230` | `executor`, `speechBusExecutor`, audio/pin/ink/activity/assistant handlers and ticks | Core |
| `231-241` | `updateCheckHandler`, `updateCheckLoopStopped`, `updateCheckTick` | Shell (updater) |
| `242-244` | `registrations`, `assistSession`, `cxrClosedByServer` | Core |
| `245-248` | snapshot capture scope/job | Shell (camera snapshot is a plugin capability) |
| `249-299` | `hudRouteSink`, notice/pin/activity/surface/ink routers | Core (rendering) |
| `300` | `debugImageSeq` | Shell (debug probe) |
| `301-308` | image rate limiter, TTS gate and dispatcher, journal, `sppLoopStarted`, audio lease arbitrator, speech-bus lock | Core |
| `309-311` | glasses-app operation/state/release locks | `glassesAppOperationLock` Core (one CXR app-callback slot); state and release locks Shell |
| `312-342` | SPP loop, enabled flags, SPP locks/deadlines/nonces/provisioning/backoff/key status, `sppCxrIdentity`, `sppPairing`, socket, `sppSession`, `cxrLink` | Core. `hubEnabled` and `startupBlockedByBluetoothPermission` stay in the Shell (start policy). R12′-adjacent: moved verbatim. |
| `343-375` | plugin registry, discovery (**`:953`**), grant store, takeover store, reconciler, registry client, developer mode, external controller, camera readiness/companion, skills, guardian, media sync, core remote bridge, files, YouTube/Reddit, manual pairing, phone-assisted pairing, transit exporter | Shell |
| `376-380` | speech settings/manager, microphone foreground flags | Core |
| `381-383` | `cxrConnected`, `glassBtConnected`, `glassesWorn` | Core |
| `384-386` | `glassesAppInstallState`, operation sequence/id | Install state Shell; sequence and active id Core |
| `387` | `lastAnnouncedPhoneCapabilities` | Core |
| `388-390` | battery reporter/badge, `lastNotifiedStatus` | Shell |
| `391-399` | remote image/pin/notice/activity/extras/ink/editable versions, `remoteMaxImageBytes`, `remoteGlassesVersionName` | Core (`remoteGlassesVersionName` feeds `installedVersion()`, §3.6) |
| `400-414` | remote glasses setup state, latest release, update state, release check | Shell |
| `415` | `lastTransportLinkState` | Core |
| `416-450` | receiver flags, developer packages, `ActivePhoneAssistedPairing`, package and Wi-Fi receivers | Shell |

### 2.2 Binder, callbacks and lifecycle

| Lines | Member | Goes to |
|---|---|---|
| `451-513` | `IBusService.Stub`: `apiVersion`, `register`, `unregister`, `send`, `sendBinary`, `linkState`, `capabilities`, `approvedCapabilities` | Core, as `@HubShellApi fun busBinder(): IBusService.Stub`. Our app never exposes it. |
| `515-591` | `registerPlugin` body: package/uid check, discovery, grant state, external/camera/skills `onRegistered` | Split. Core keeps the call shape and `addRegistration` + `notifyPluginRegistration`; the admission (`516-561`) and the `onRegistered` fan-out (`575-583`) become **Hook** `admitPlugin` and `onPluginRegistered`. With no hook (our app), every external `registerPlugin` is refused `DENIED`. |
| `594-660` | `ICXRLinkCbk`: connected, disconnected by server, BT, device info, wearing, scenes | Core (**CXR link**) |
| `662-700`, `703-761` | AI-assist start/stop; `takeOverAssistGesture`, `signalWarmPress` | Split. Scene tracking and `notifyGlassesAiButton` Core; the takeover decision (`assistantTakeoverStore`, `approvedAssistantPrincipal`, `externalPluginController.open`) is **Hook** `onAssistGesture`. No hook → the gesture stays with Rokid, as with takeover paused (`:672-681`). |
| `762-793` | `clearGlassesSessionState`, `sendNativeAssistantExitBurst` | Core (`sendNativeAssistantExitBurst` is `@HubShellApi`) |
| `794-832` | `IAudioStreamCbk`, `ICustomCmdCbk` | Core |
| `834-1089` | `onCreate` | Split, line by line: `836` Shell; `838-871` Shell (YouTube, Reddit, core remote bridge, files); `872-887` Core (TTS); `888-894` Shell (manual pairing); `900-949` Shell (persisted setup state); `950-973` Shell (developer mode, client supervisor, **`953` discovery**, grants, registry, reconciler, guardian, camera readiness, transit); `974-990` Core (speech, built from the registry, §3.7); `991-1052` Shell (external runtimes, camera, skills, registry); `1053-1073` Shell (media sync, receivers, battery); `1074-1083` Split: permission gate and `startForegroundWithType` Shell, `startCxrIfTokenAvailable` Core; `1084` Core (`connectSpp`); `1085-1087` Shell. |
| `1091-1177` | `onBind`, `onStartCommand`, `finishUnacceptedStart` | Shell. Commands call the core (`SET_TOKEN` → `startWithToken`, install/query/open/setup → §2.5). |
| `1179-1218` | `enableHub`, `stopHub` | Split: prefs, foreground, `stopSelf` Shell; the radio release (`1195-1209`) is `HubCore.stop()`. |
| `1220-1273` | `onDestroy` | Split: Shell closes its controllers, then calls `HubCore.stop()`. |

### 2.3 Routing

| Lines | Member | Goes to |
|---|---|---|
| `1275-1276` | `deliverQueued` | Core, `@HubShellApi` (called by `PhoneClientSupervisor`) |
| `1278-1506` | `routeLocal` | Core. Hooks at: `1314-1321` skills lease → **Hook** `leaseRestriction`; `1386-1389` `onPluginActivity` → `HubForegroundPolicy.onSurfaceTraffic`; `1429-1448` `allowExternalSurface` → `HubForegroundPolicy.allowSurface`; `1469-1488` transit ack → **Hook** `onLocal`; `1499-1501` `PhoneClientSupervisor.enqueue` → **Hook** `enqueueUndelivered`. Gains an overload taking an already-resolved `AuthorizedSender` for the in-process client (§3.3). |
| `1508-1644` | `routeRemote` | Core. The SPP-reserved and skills guards (`1509-1514`) stay first. Then **Hook** `onRemote` for the shell families: files (`1515-1523`), remote-input/native-app results (`1542-1558`), setup note (`1559-1573`), phone-assisted pairing offer (`1574-1578`), manual self-arm (`1579`), media sync (`1580-1583`), camera (`1584-1589`). These path families are disjoint from the core's, so one early hook changes no outcome. `HUB_CAPABILITIES` (`1528-1541`) stays Core and calls **Hook** `onGlassesCapabilities` for media-sync and repair-config re-push. `1594` `pluginRegistry.handleRemote` → `HubForegroundPolicy.handleRemote`. `1638` `PhoneClientSupervisor.enqueue` → **Hook** `enqueueUndelivered`. |
| `1646-1825` | journal helpers | Core |
| `1826-1878` | `handleHubPath` | Split. Core: `AUDIO_LEASE_*`, STT session start/stop. Shell via **Hook** `onLocal`/`onRemote`: `HTTP_REQUEST`, `CAMERA_SNAPSHOT_REQUEST`, `MEDIA_SYNC_*`, `WIRELESS_ADB_REQUEST`, `ASSISTANT_TAKEOVER_REQUEST`, `SKILLS_*`. |
| `1880-2169` | skills, wireless ADB, assistant takeover, camera snapshot | Shell |
| `2170-2248` | glasses control requests | Split. Core: the trusted-local path check (`2170-2183`, `1287-1297`), the repair/accessibility/keyboard pass-through (`2186-2200`) and brightness/volume over CXR (`2218-2240`). Shell: `GLASSES_SELFARM_MANUAL` (`2201-2215`), through **Hook** `onLocal` before the core's handler, because it validates `GlassesManualControlAction` (`GlassesManualPairingEngine.kt:27`, manual ADB). With no hook the core answers that path `TRUSTED_LOCAL_ONLY`. |
| `2249-2332` | `deliverLocal`, `registrationMatches`, `protectedPathAllowed` | Core (`deliverLocal` also `@HubShellApi`) |
| `2333-2389` | media sync | Shell |
| `2390-2505` | local TTS, TTS events, phone TTS started/done | Core (**speech**) |
| `2506-2540` | `resolveSender` | Core. `pluginGrantStore.stateFor` (`2522`) → **Hook** `grantFor`, so the `when` over `PluginGrantState` is unchanged. The in-process principal never reaches it (§3.3). |
| `2541-2626` | `deliverError`, `notifyPluginRegistration`, registration removal | Core. Removal fan-out → **Hook** `onRegistrationRemoved`. |
| `2627-2653` | `revokePrincipal`, `authorizationChanged` | Core, `@HubShellApi` |
| `2654-2788`, `2854-2866` | package/Wi-Fi receivers, plugin reconcile, sideload notifications, principals, guardian targets, transit migration | Shell |
| `2789-2853` | `deliverExternalLifecycle`, `deliverExternalBinary` | Core, `@HubShellApi` (as `deliverToPrincipal`, `deliverBinaryToPrincipal`); the core uses the first for device info |
| `2867-2901` | `hideExternalSurfaces`, `onExternalSurfaceReleased`, `pluginHoldsActiveAudioLease` | Core; `onPluginSelfHid`/`onAudioLeaseEnded` → `HubForegroundPolicy` |
| `2902-3193` | speech bus sessions | Core (**speech**) |
| `3194-3533` | `pinLinkUp`, audio leases, internal audio, frame forwarding | Core |
| `3534-3589` | `sendRemote`, `sendBuiltInPluginEnvelope`, `sendCxr` | Core (`sendRemote`, `sendBuiltInPluginEnvelope` are `@HubShellApi`) |
| `3590-3608` | `sendNativePointer` | Shell, over `@HubShellApi cxrLinkOrNull()` |
| `3609-3662` | SPP key offer/provisioning/status, `writeSpp` | Core, verbatim (R12′) |
| `3663-3748` | `fetchAndStream` (HTTP proxy) | Shell |
| `3749-3824` | `pluginRegistrationResult`, `addRegistration` | Core |
| `3825-3925` | `connectSpp`, `readSppLoop`, `pickBondedDevice` | Core, verbatim (**SPP auth**, R12′) |
| `3926-3962` | `startCxrIfTokenAvailable`, `startCxr` | Core (**CXR link**) |

### 2.4 Status, capabilities, misc

| Lines | Member | Goes to |
|---|---|---|
| `4770-4778` | `decodeCxrPayload` | Core |
| `4779-4892` | update checks, update notifications | Shell (updater) |
| `4893-4967` | `startForegroundWithType`, microphone foreground | Split. The Shell's `HubForegroundHost.promote(microphone)` holds `4893-4947`; the core's speech calls it where `4948-4960` did. |
| `4968-5017` | status notification | Shell, fed by `HubForegroundHost.onLinkStateChanged`. `statusText` stays on the shell class (reflected on by `SppPairingStatusTest`; it reads `sppKeyStatus` through `@HubShellApi sppKeyStatus()`). |
| `5018-5044` | `linkState`, `isGlassesBonded`, `isCxrUp`, `notifyGlassesAiButton` | Core |
| `5045-5079` | `approvedAssistantPrincipal` | Shell |
| `5080-5097` | `notifyGlassesDeviceInfo` | Core |
| `5098-5184` | `notifyLinkState` | Core. The fan-out to YouTube/Reddit, core remote bridge, files, guardian, camera, media sync (`5100-5170`) → **Hook** `onLinkState`; `5173-5177` launcher sync (and `2722` after a package change) → `HubForegroundPolicy.syncLauncherList`. |
| `5185-5215` | `announcePhoneCapabilities`, `errorEnvelope` | Core |
| `5216-5290` | `capabilities`, camera capabilities | Core; `PhoneAssistedSetupCapabilityPolicy` and camera bits (`5217-5218`, `5270-5290`) → **Hook** `extraCapabilities` |
| `5291-5371` | `updateRemoteCapabilities` | Core for surface versions and `versionName`; the setup-state half (`updateRemoteGlassesAppState`) is Shell through **Hook** `onGlassesCapabilities` |
| `5372-5424` | image validation | Core |
| `5425-5476` | debug image | Shell |
| `5477-5506` | `closeSocket`, `isDebuggableBuild`, `prefs`, `log`, `sleepQuietly` | Core (the shell keeps its own `log`) |
| `5507-5724` | companion object | Shell. Every static keeps its name and delegates to `activeInstance?.core`, so no activity changes. |

### 2.5 The glasses install

| Lines | Member | Goes to |
|---|---|---|
| `3963-4010` | `startGlassesSetupOnLens` | Split: CXR `appStart` → `@HubShellApi suspend fun openOnGlasses(activityClassName): Boolean` (Core); `NexusPhoneState` handoff and `SetupJournal` Shell |
| `4011-4033` | `openGlassesAppOnLens` | Same `openOnGlasses` (Core) |
| `4034-4079` | `queryGlassesApp`, `requestGlassesAppQuery` | Split: CXR `appIsInstalled` → `@HubShellApi suspend fun queryGlassesAppInstalled(): Boolean?` (Core); install-state transitions Shell |
| `4080-4127` | `installGlassesApp` | Shell (its state machine), calling the core installer |
| `4128-4382` | repair-config push, manual self-arm, phone-assisted setup | Shell (**manual ADB**) |
| `4383-4387` | `isPhoneWifiEnabled` | Core (installer precondition); the Shell keeps a copy for camera capabilities |
| `4388-4487` | `downloadAndInstallGlassesApp` | Split: `4389-4412` release resolution and download Shell (**GitHub-release**); `4413-4425` verification and `4436-4486` CXR push are `GlassesAppInstaller.install` (Core) |
| `4488-4595` | `resolveLatestGlassesAppRelease`, remote setup state, release refresh, update state | Shell |
| `4596-4617` | `uploadYoutubeApk` | Core, as `@HubShellApi fun uploadThirdPartyApk(apk: File, callback: (Boolean) -> Unit): Boolean`, verbatim: it shares the one CXR app-callback slot with the installer, so it must live beside it. Patcher's own APK checks stay in the Shell. |
| `4618-4659` | operation sequence | Core |
| `4660-4769` | install-state transitions and broadcast | Shell |

### 2.6 Manual ADB setup stays in the shell `[6a-R7]`

`:kadb-compat` (`phone-hub/build.gradle.kts:60`), `selfarm/adb/*.java` (5 files),
`GlassesManualArmRunner.kt`, `GlassesManualArmCommand.kt`, `GlassesManualPairingEngine.kt`,
`GlassesManualPairingBackend.kt`, `GlassesManualSetupActivity.kt`, `ManualSetupAvailability.kt`,
`ManualEndpointInput.kt`, `PhoneAssistedSetupPolicy.kt`, and the manual-pairing code in
`BusHubService.kt` (`370-374`, `888-894`, `1133-1151`, `4139-4382`) stay in `:phone-hub`.
`:phone-core` has no dependency on `:kadb-compat`, so neither does anything built on it. The
product installs the glasses app over CXR only, through `GlassesAppInstaller`.

### 2.7 Every other `:phone-hub` file

**Moves to `:phone-core`** (same package `com.anezium.rokidbus.phone`, `git mv`):
`ApksigGlassesApkInspector`, `CxrLAuth`, `GlassesApkVerificationPolicy`, `GlassesAssistSession`,
`GlassesBondedDeviceSelector`, `GlassesControlLevelPolicy`, `GlassesDeviceInfoPayload`,
`ImageSurfaceRateLimiter`, `NativeSceneTakeover`, `NoticeEnvelopePolicy`, `NoticeReplyPolicy`,
`PhoneActivityPresentationSettings`, `PhoneActivityRouter`, `PhoneActivityState`,
`PhoneHudPositionStore`, `PhoneHudRouteSink`, `PhoneInkCapabilityPolicy`, `PhoneInkRouter`,
`PhoneInkSurfaceCoordinator`, `PhoneLinkState`, `PhoneNoticeRouter`, `PhoneNoticeState`,
`PhonePinRouter`, `PhonePinState`, `PhoneSpeakerRouteProbe`, `PhoneSppPairing` (R12′),
`PhoneSppPairingStorage` (R12′), `PhoneSurfaceRouter`, `PhoneTtsEngine`, `PhoneTtsPlayback`,
`PhoneTtsRequestGate`, `PhoneTtsSettingsStore`, `PluginBusJournal`,
`PluginRoutePolicy`, `ProtectedPathAccessPolicy`, `SerialExecutor`, `SigningCertificateDigest`,
`SingleAudioLeaseArbitrator`, `SppCxrIdentity`, `SppReconnectBackoff`, `SttWireProtocol`; and in
`speech/`: `AndroidSttSession`, `SpeechEngineConfig`, `SpeechPatience`, `SpeechSessionManager`,
`SpeechSettingsStore`, `SttSession`, `SttSessionFactories`, `TranscriptionLanguageConfig`,
`VoiceActivityDetector`.

**Extracted into new core files** (the declarations move verbatim; the source file keeps the
rest):

| New core file | Taken from |
|---|---|
| `PluginPrincipal.kt` | `PhonePluginDiscovery.kt:18-37` (`PluginSkillsState`, `PhonePluginPrincipal`); `PluginGrantStore.kt:8-12` (`PluginGrantKey`), `:24-29` (`PluginGrantState`, also read by `ProtectedPathAccessPolicy.kt:19,34`) and `:31-35` (`grantKey()`) |
| `ArtifactPackage.kt` | `PluginInstaller.kt:67-80` (`ArtifactArchiveInfo`, `ArtifactPackageInspector`); `PluginInstaller.kt:326` `sha256Matches` → top-level `internal fun sha256Matches(file, expected)`, with `PluginInstaller.sha256Matches` delegating |
| `NexusSemVersion.kt` | `NexusUpdateChecker.kt:15-` (`NexusSemVersion` and its `parse`) |
| `speech/SpeechSttSessionFactory.kt` | `CloudSttSessionFactory.kt`: `SpeechSttSessionFactory`, `SttTimeoutHandle`, `SttTimeoutScheduler`, `ExecutorSttTimeoutScheduler`, `PostCommitTimeoutSttSession` (shared by both factories). `SpeechSttSessionFactory` becomes public. |

These are value types and interfaces, not runtime. `phone_core_has_no_plugin_runtime_or_cloud_speech_types`
(§6) bans runtime classes by name, not these.

**Stays in `:phone-hub`:** everything else — every Activity and View; `AndroidExternalPluginRuntime`,
`AndroidSkillLeaseRuntime`, `AssistantTakeoverStore`, `CameraCompanionController`,
`CameraConsumerReadiness`, `CxrSnapshotCapture`, `SnapshotJpegEncoder`, `DeveloperModeStore`,
`ExternalPluginController`, `GlassesAppInstallState`, `GlassesAppUpdateState`,
`GlassesControlsVisibilityStore`, `GlassesFiles*`, `GlassesRepair*`, `GuidedSetupPreflight`,
`HttpProxyPolicy`, `HubCommandIntents`, `HubStartupReceiver`, `NativeAppsPhoneContract`,
`NativeSetupTarget`, `NexusPhoneState`, `NexusReleaseAssetResolver`, `NexusSelfUpdater`,
`NexusUpdateChecker`, `NexusUpdateManager`, `PatcherHandoff`, `PhoneBattery*`,
`PhoneClientSupervisor`, `PhoneCoreRemoteBridge`, `PhoneHomeRenderDispatcher`,
`PhoneHubCameraCapabilityPolicy`, `PhonePluginDiscovery`, `PhonePluginRegistry`,
`PhonePointerChannel`, `PhoneTtsUiApi` (a UI facade over the shell's statics), `PluginCatalog`, `PluginGlyphReader`, `PluginGrant*`,
`PluginGuardian*`, `PluginInstaller`, `PluginPostInstallCoordinator`,
`PluginSideloadNotificationPolicy`, `PluginUpdateChecker`, `PluginWakePolicy`, `Reddit*`,
`Registry*`, `ReleaseNotesMarkdown`, `RemoteInputPhoneContract`, `RemoteKeyboardPrompt`,
`RemoteTrackpadPublisher`, `RokidNativePointerProtocol`, `ServiceInfoCompat`, `SetupJournal`,
`SetupProgressUiPolicy`, `SkillGrantStore`, `SkillsCoordinator`, `Store*`,
`TransitLegacyStateExporter`, `UpdateNotificationPolicy`, `Youtube*`, `mediasync/*`,
`selfarm/adb/*`, the manual-setup files of §2.6, and in `speech/`: `CloudSttSessionFactory`
(minus the extraction), `CompletedAudioSpeechToText`, `RealtimeSpeechToText`, `SpeechCredits`,
`HubSecretStore`.

**Edits inside moved files** (the only ones besides §3):

- `PhoneActivityPresentationSettings.kt:8`, `PhoneHudPositionStore.kt:9`,
  `PhoneTtsSettingsStore.kt:8` read the prefs name from `NexusPhoneState.PREFS` (`NexusPhoneState.kt:10`,
  a shell file). The core gets `HubPrefs.kt` with `const val PREFS = "rokidbus_phone"`; those three
  use it, and `NexusPhoneState.PREFS` becomes `= HubPrefs.PREFS`. Same file, same keys.
- `speech/AndroidSttSession.kt:1043-1050` `HubAndroidSttForegroundController` calls the shell's
  statics (`BusHubService.kt:5621-5633`). It is replaced by an `AndroidSttForegroundController`
  passed into `AndroidSttSessionFactory` by `HubCore`, which does the bookkeeping of
  `BusHubService.kt:4948-4960` and calls `HubForegroundHost.promote(microphone = true)`.
- `GlassesApkVerificationPolicy.kt` loses `NexusReleaseAsset` and `PluginInstaller` (§3.6).
- `speech/SpeechSessionManager.kt` and `speech/SpeechSettingsStore.kt` lose `HubSecretStore` (§3.7).

**Visibility.** A moved `internal` declaration stays `internal` unless the shell's compile needs
it; then it becomes `public` and nothing else changes. Each widening is listed in the commit's
PATCHES row. Shell-only entry points on `HubCore` carry `@HubShellApi` (§3.5).

---

## 3. The `:phone-core` API

All of it is in package `com.anezium.rokidbus.phone` (class FQNs stay `com.anezium.rokidbus.*`);
the module's Android namespace is `com.anezium.rokidbus.phone.core`.

### 3.1 `HubCore`

```kotlin
class HubCore(context: Context, config: HubCoreConfig) {
    /** Opens CXR (if a token is saved) and the SPP loop. Idempotent; callable again after stop(). */
    fun start()

    /**
     * Releases every radio resource, lease and session: what stopHub() released
     * (BusHubService.kt:1195-1209), plus closing the in-process app (onClose) and the
     * executors. Idempotent. A later start() rebuilds the executors.
     */
    fun stop()

    /** The in-process app's surface. One instance per core. Throws if config.inProcessApp is null. */
    fun surface(): GlassesSurface

    val glassesInstaller: GlassesAppInstaller
    val speech: SpeechEngineRegistry
}

data class HubCoreConfig(
    val foreground: HubForegroundHost,
    /** Our app: the one in-process app. The upstream shell: null. */
    val inProcessApp: InProcessApp? = null,
    /** The upstream shell's plugin runtime and extras. Our app: the default. */
    val hooks: HubShellHooks = HubShellHooks.None,
    val journal: PluginBusJournal = PluginBusJournal(),
    /** Never receives a token, steer, fingerprint, SAS nonce, payload text or device serial [6a-R8]. */
    val log: (String) -> Unit = {},
) {
    init {
        require(inProcessApp == null || hooks.foreground() == null) {
            "An in-process app and a plugin-runtime foreground policy are exclusive"
        }
    }
}

data class InProcessApp(
    val pluginId: String,
    val displayName: String,
    val iconKey: String?,
    val capabilities: Set<PluginCapability>,
    val receivePrefixes: List<String>,
)

/** The shell's Service. Called on the main thread. */
interface HubForegroundHost {
    /** Re-promotes the host service, adding the microphone type when asked. Returns the failure, or null. */
    fun promote(microphone: Boolean): Throwable?

    /** The link changed; the shell redraws its status notification. */
    fun onLinkStateChanged(linkState: Int)
}
```

Our app (T3) passes `InProcessApp("agents", "Agents", "terminal", setOf(SURFACES, STT, TTS),
listOf("/plugin/agents", "/system/plugin", "/stt", "/tts/started", "/tts/done"))`, the values
of `mobile/agents/src/main/AndroidManifest.xml:89-112` today.

`HubCore` keeps the CXR token where `BusHubService` did (prefs `rokidbus_phone`, key
`cxrl_token`), so an upgraded upstream install keeps its link. The CXR session still names the
glasses package by the moved constant `GLASSES_HUB_PACKAGE` (`BusHubService.kt:150`); T12
replaces it with the injected identity.

**Test seam (internal).** `internal constructor(context, config, cxr: CxrTransport)`, where
`CxrTransport` mirrors, signature for signature, the `CXRLink` members the core calls today
(`configCXRSession`, `setCXRLinkCbk`, `setCXRCustomCmdCbk`, `connect`, `disconnect`,
`sendCustomCmd`, the audio-stream calls, `setBrightness`, `setVolume`, `appStart`,
`appIsInstalled`, `appUploadAndInstall`). Production wraps a real `CXRLink`
(`CxrLinkTransport`); tests pass `FakeCxrTransport`, which records commands and drives the
`ICXRLinkCbk`/`ICustomCmdCbk`/`IGlassAppCbk` callbacks. Call sites change only their receiver.
`@HubShellApi fun cxrLinkOrNull(): CXRLink?` hands the real link to the shell's snapshot and
native-pointer code.

### 3.2 `GlassesSurface` and its types

```kotlin
interface GlassesSurface {
    val state: SurfaceState
    val deviceInfo: GlassesDeviceInfo?

    fun attach(listener: SurfaceListener, notices: NoticeCallbacks)
    fun detach()

    fun showCard(card: NexusCard): NexusSdkResult          // C1, L5
    fun updateCard(card: NexusCard): NexusSdkResult        // C2
    fun showReader(reader: NexusReader): NexusSdkResult    // C3, L5
    fun updateReader(reader: NexusReader): NexusSdkResult  // C4
    fun hide(): NexusSdkResult                             // L6

    fun showNotice(notice: NexusNotice): NexusSdkResult        // N1, N8
    fun updateNotice(update: NexusNoticeUpdate): NexusSdkResult // N2
    fun hideNotice(): NexusSdkResult                            // N3

    fun speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult // T1
    fun stopSpeaking(): NexusSdkResult                                                     // T4

    fun startSpeech(language: String?, listener: SpeechListener): SpeechHandle // S1
}

interface SurfaceListener {
    fun onOpen(openType: String)                                                    // L1
    fun onBackground() {}                                                           // L2
    fun onClose()                                                                   // L3
    fun onStateChanged(state: SurfaceState) {}                                      // L4
    fun onDeviceInfo(info: GlassesDeviceInfo) {}                                    // L7
    fun onSurfaceRejected(code: String) {}                                          // C5
    fun onInput(event: NexusInputEvent)                                             // C6
    fun onTextCommitted(surfaceId: String, text: String, cancelled: Boolean) {}     // C8
}

interface NoticeCallbacks {
    fun onShown() {}                                  // N4
    fun onInput(event: NexusInputEvent) {}            // N5
    fun onAction(id: String) {}                       // N6
    fun onClosed(reason: NexusNoticeCloseReason) {}   // N7
}

interface TtsCallbacks {
    fun onStarted(utteranceId: String) {}                          // T2
    fun onDone(utteranceId: String, reason: NexusTtsDoneReason) {} // T3
}

interface SpeechListener {
    fun onStarted(realtime: Boolean)                                        // S2
    fun onState(state: NexusSpeechState) {}                                 // S3
    fun onPartial(text: String)                                             // S4
    fun onFinal(text: String)                                               // S5
    fun onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?)  // S6
}

interface SpeechHandle {
    val result: NexusSdkResult // S1: SENT, NOT_REGISTERED, CAPABILITY_NOT_GRANTED, CAPABILITY_NOT_AVAILABLE
    fun stop()                 // S7
}

data class SurfaceState(
    val lifecycle: Lifecycle,
    val linkState: Int,
    val noticeSupported: Boolean,
    val noticeShownAckSupported: Boolean,
    val editableSupported: Boolean,
    val ttsSupported: Boolean,
) {
    enum class Lifecycle { CLOSED, OPEN, BACKGROUND }

    val glassesWorn: Boolean get() = linkState and LinkStateBits.GLASSES_WORN != 0
}

/** From /glasses/device-info (GlassesDeviceInfoPayload.kt:7-19); -1 becomes null. No serial number. */
data class GlassesDeviceInfo(
    val deviceName: String,
    val batteryLevel: Int?,
    val volume: Int?,
    val brightness: Int?,
    val systemVersion: String,
    val isCharging: Boolean,
    val wearingStatus: String,
)
```

The card, reader, notice and result types are bus-client's own (`SurfaceModels.kt`), so T3
moves `BoardCards`, `AlertNotices` and the rest without touching them. `:phone-core` exposes
bus-client with `api(project(":bus-client"))`.

### 3.3 How `GlassesSurface` reaches the core

`InProcessGlassesSurface` (core, internal) holds one `NexusPluginClient` built over
`InProcessPluginTransport` (core, internal), and adapts the client's callbacks onto the
`GlassesSurface` types. The SDK code that implements notices, speech, TTS and the preflights is
reused as-is.

`NexusPluginClient`'s constructor is `internal` to bus-client (`NexusPluginClient.kt:41`), and
its payload serialisers are too (`SurfaceModels.kt:112,187,254,…`). **Decision:** one bus-client
patch, its own commit and PATCHES row, adds the factory and nothing else:

```kotlin
// NexusPluginClient.Companion
fun createWithTransport(
    pluginId: String,
    callbacks: NexusPluginCallbacks,
    transport: NexusPluginTransport,
): NexusPluginClient = NexusPluginClient(pluginId = pluginId, callbacks = callbacks, transport = transport)
```

`NexusPluginTransport` is already public (`NexusPluginTransport.kt:5-28`). The fallback, if the
controller refuses a bus-client edit in T2, is in Open point 1.

`InProcessPluginTransport`:

- `connect(listener)`: registers one `Registration` (`clientId = pluginId`, prefixes from
  `InProcessApp.receivePrefixes`, `uid = Process.myUid()`, `callback` = a local
  `IBusCallback.Stub`, `principal` = the in-process principal below, `grantedCapabilities =
  InProcessApp.capabilities`), then posts `onRegistrationState(APPROVED)` and the
  `PLUGIN_REGISTRATION` message (`notifyPluginRegistration`, `BusHubService.kt:2554-2572`), so
  `noticeInteractionVersion` and the grants are set as they are for an AIDL plugin.
- The local stub's `onMessage`/`onBinaryMessage`/`onLinkState`/`onGlassesAiButton` decode
  exactly as `BusClient` does and **post to the main looper**. A local Binder's
  `linkToDeath` never fires, so the in-process registration is removed only by `close()`.
- `send`/`sendBinary`: enqueue `routeLocal(envelope, sender)` on the core's **local-ingress
  executor**, one thread, FIFO, so the caller never blocks on a Bluetooth write and calls keep
  their order, as oneway calls to one binder do today. Returns `true` once enqueued.
- `capabilities()` → `HubCore.capabilities()`; `approvedCapabilities()` →
  `serialize(InProcessApp.capabilities)`.

**The in-process principal** is a `PhonePluginPrincipal(packageName = context.packageName,
serviceComponent = ComponentName(context.packageName, "<in-process>"), uid = Process.myUid(),
signingDigestSha256 = "in-process", descriptor = PluginDescriptor(id, displayName, apiVersion =
BusConstants.API_VERSION, requestedCapabilities = capabilities, receivePrefixes, settingsActivity
= null, launchable = true, iconKey))`. Its sender is always
`AuthorizedSender(PluginRouteCaller.Plugin(pluginId, capabilities), replyBinder, principal)`,
never `Internal`: the same-UID shortcut in `resolveSender` (`BusHubService.kt:2507`) would skip
capability checks and owner injection, so the in-process overload of `routeLocal` takes the
sender directly. `deliverLocal`'s `excludeUid` (`:1498`) becomes "exclude this sender's
binder" for that path, so the app never hears its own frames and other same-UID clients still
do.

### 3.4 The single-app foreground policy

```kotlin
@HubShellApi
interface HubForegroundPolicy {
    /** LAUNCHER_OPEN, SURFACE_INPUT, SURFACE_TEXT_COMMITTED and any subscription paths. */
    fun handleRemote(envelope: BusEnvelope): Boolean
    fun allowSurface(principal: PhonePluginPrincipal, path: String): Boolean
    fun onSurfaceTraffic(pluginId: String)
    fun onSelfHid(pluginId: String, detach: Boolean, hasActiveAudioLease: Boolean)
    fun onAudioLeaseEnded(pluginId: String, reason: String)
    fun activeId(): String?
    fun syncLauncherList()
    fun closeAll(reason: String)
}
```

The core uses `hooks.foreground()` when the shell gives one, else `SingleAppForeground(app)`:

- `syncLauncherList`: sends `LAUNCHER_LIST` with the one entry (`id`, `displayName`, `iconKey`)
  on the same link-up edge the registry used (`BusHubService.kt:5173-5177`).
- `LAUNCHER_OPEN` for the app's id: `active = true`, delivers `PLUGIN_OPEN{type:"open"}`.
  Any other id: not handled.
- `allowSurface`: true while active. While inactive, a show adopts (active, then
  `PLUGIN_OPEN{type:"adopted"}`), mirroring `ExternalPluginController.kt:227-244`; an update
  while inactive is refused (`SURFACE_BUSY`).
- `SURFACE_INPUT` / `SURFACE_TEXT_COMMITTED` owned by the app while active: delivered as
  `PLUGIN_INPUT` / `SURFACE_TEXT_COMMITTED` with `pluginId`, as `ExternalPluginController.kt:159-197`.
- `onSelfHid`: `active = false`, delivers `PLUGIN_CLOSE{type:"self_hidden"}`. With a detach and
  an audio lease it delivers `PLUGIN_CLOSE{type:"background"}` instead.
- `closeAll`: from `stop()`, delivers `PLUGIN_CLOSE` once.
- No open-ack watchdog: there is no binder to rebind.

The upstream shell's implementation wraps `PhonePluginRegistry` and `ExternalPluginController`
and keeps their exact behaviour.

### 3.5 Shell-only API

```kotlin
@RequiresOptIn("Only the upstream Nexus shell may use this", RequiresOptIn.Level.ERROR)
@Retention(AnnotationRetention.BINARY)
annotation class HubShellApi

@HubShellApi
interface HubShellHooks {
    fun admitPlugin(packageName: String, pluginId: String, uid: Int): PluginAdmission =
        PluginAdmission.Rejected(PluginRegistrationResult.DENIED, "NO_PLUGIN_RUNTIME")
    fun onPluginRegistered(principal: PhonePluginPrincipal) {}
    fun grantFor(principal: PhonePluginPrincipal): PluginGrantState = PluginGrantState.Denied
    fun onRegistrationRemoved(principal: PhonePluginPrincipal?, reason: String) {}
    fun foreground(): HubForegroundPolicy? = null
    fun onRemote(envelope: BusEnvelope): Boolean = false
    fun onLocal(envelope: BusEnvelope, sender: AuthorizedSender): Boolean = false
    fun leaseRestriction(principal: PhonePluginPrincipal, path: String): String? = null
    fun enqueueUndelivered(envelope: BusEnvelope, excludeUid: Int?): Boolean = false
    fun extraCapabilities(base: Int): Int = base
    fun onLinkState(state: Int, previous: Int) {}
    fun onGlassesCapabilities(payload: JSONObject) {}
    fun onAssistGesture(session: Int, press: Int): Boolean = false

    companion object { val None: HubShellHooks = object : HubShellHooks {} }
}

@HubShellApi
sealed interface PluginAdmission {
    data class Approved(val principal: PhonePluginPrincipal, val capabilities: Set<PluginCapability>) : PluginAdmission
    data class Rejected(val result: Int, val reason: String) : PluginAdmission
}
```

`@HubShellApi` members on `HubCore` (each named in §2): `busBinder`, `sendRemote`,
`sendBuiltInPluginEnvelope`, `deliverLocal`, `deliverQueued`, `deliverError`,
`deliverToPrincipal`, `deliverBinaryToPrincipal`, `hideExternalSurfaces`, `revokePrincipal`,
`authorizationChanged`, `linkState`, `capabilities`, `isCxrUp`, `cxrLinkOrNull`,
`startWithToken`, `sppKeyStatus`, `acquireInternalAudio`, `releaseInternalAudio`,
`sendNativeAssistantExitBurst`, `openOnGlasses`, `queryGlassesAppInstalled`,
`uploadThirdPartyApk`, and the speech-dictation test entry points the settings UI uses today
(`BusHubService.kt:5599-5633`). Our app never opts in, so it cannot reach the plugin bus.

### 3.6 `GlassesAppInstaller` `[FR 5]`

```kotlin
interface GlassesAppInstaller {
    suspend fun install(apk: File, expected: GlassesApkMetadata, onProgress: (Int) -> Unit): InstallResult
    suspend fun installedVersion(): Long?
    fun cancel()
}

data class GlassesApkMetadata(
    val packageName: String,
    val versionCode: Long,
    val sha256: String,
    /** One or more comma-separated 64-hex certificate digests, as phone-hub/build.gradle.kts:8-12 allows. */
    val signerSha256: String,
)

sealed interface InstallResult {
    data object Installed : InstallResult
    data object AlreadyCurrent : InstallResult
    data object NewerOnGlasses : InstallResult
    data object Cancelled : InstallResult
    data class Failed(val reason: String) : InstallResult
}
```

`CxrGlassesAppInstaller` (core, internal) runs `install` in this order. Each `Failed.reason` is
a fixed string, never a path, digest or exception message.

1. `onProgress(0)`. `expected.packageName` must equal the CXR session's package, else
   `Failed("Glasses APK package does not match this hub.")`.
2. Copy `apk` into a core-private file (`noBackupFilesDir/glasses-install/<uuid>.apk`). Every
   later step reads only the copy, so the file cannot change between verifying and pushing.
3. **Verify the copy, on every call:** `GlassesApkVerificationPolicy.verify(copy, expected,
   ApksigGlassesApkInspector())` — SHA-256 equals `expected.sha256`; apksig verifies; package
   equals `expected.packageName`; exactly one signer, and its digest is in
   `expected.signerSha256`; `versionCode == expected.versionCode`. A rejection is
   `Failed(<the policy's fixed reason>)`. `onProgress(25)`.
4. `installedVersion()`: equal → `AlreadyCurrent`; greater → `NewerOnGlasses`.
5. Wi-Fi on (`isPhoneWifiEnabled`) and CXR up, else the two fixed messages of
   `BusHubService.kt:4101-4117`.
6. Take the CXR app-callback slot (`beginGlassesAppOperation`), else
   `Failed("Another glasses operation is in progress.")`.
7. If `cancel()` was called or the coroutine was cancelled: `Cancelled`. **No push happens.**
8. `onProgress(50)`; `appUploadAndInstall(copy)`. From here CXR cannot be stopped; `cancel()` is
   ignored and the result is what CXR reports.
9. Success → `onProgress(100)`, `Installed`. Refused → `Failed("The glasses did not install the
   app.")`. Link lost first → `Failed("Connection to the glasses was lost.")`.
10. Always: delete the copy, release the slot.

Progress is coarse (0, 25, 50, 100) because `CXRLink.appUploadAndInstall` reports only the
final result (`CxrGlobal/lib/.../CXRLink.kt:406-429`).

`installedVersion()`: `null` when CXR is down or `appIsInstalled` says no; otherwise the
glasses' announced `versionName` (`HUB_CAPABILITIES`, `BusHubService.kt:399`) as a version code,
`major * 10000 + minor * 100 + patch` (the convention of
`GlassesApkVerificationPolicy.kt:64-71`, which moves to `GlassesVersionCode.fromVersionName`);
`null` if it has not announced on this link. CXR has no version query (`IGlassAppCbk` carries
only booleans). See Open point 3.

`GlassesApkVerificationPolicy` changes shape: `verify(apk: File, expected: GlassesApkMetadata,
inspector: ArtifactPackageInspector)` and `verdict(archive, expected)`. The upstream shell
builds the metadata from the release (`GlassesVersionCode.fromSemVersion(release.version)`,
`release.sha256`, `BuildConfig.GLASSES_APK_SIGNER_SHA256`), refuses a release with no valid
digest with today's message, and maps `InstallResult` onto its `GlassesAppInstallEvent`s. The
GitHub-release resolution and download stay in the shell and call `install(file, …)`.

### 3.7 `SpeechEngineRegistry` `[FR 6]`

```kotlin
class SpeechEngineRegistry internal constructor(context: Context) {
    /** Before HubCore.start() only; a later call throws IllegalStateException. */
    fun register(
        engine: SpeechEngine,
        factory: SpeechSttSessionFactory,
        readiness: () -> SpeechReadiness,
    )

    fun engines(): List<SpeechEngine>
    fun isRegistered(engine: SpeechEngine): Boolean
}
```

- The core registers only `SpeechEngine.ANDROID_RECOGNIZER` with `AndroidSttSessionFactory`
  and readiness `READY`, and ships only Android TTS (`PhoneTtsEngine`) beside the glasses TTS
  route.
- `SpeechSessionManager`'s public constructor changes from `(context, settings, secrets,
  internalAudio)` to `(context, settings, registry, internalAudio)`. The routing factory it built
  (`SpeechSessionManager.kt:106-109`) becomes `RoutingSttSessionFactory(registry)`, which picks
  the registered factory for the engine. `secrets` (`:88,100,105,119`) leaves the class.
- `SpeechSettingsStore.readiness(secrets)` (`SpeechSettingsStore.kt:71-81`) becomes
  `readiness(registry)`: no engine or an unregistered one → `NO_ENGINE`; the Android
  recognizer without the microphone permission → `MISSING_MIC_PERMISSION`; otherwise the
  registered readiness.
- **The upstream shell**, before `start()`, registers every other `SpeechEngine` with
  `CloudSttSessionFactory(HubSecretStore(context))` and readiness = today's key and region
  checks (`SpeechSettingsStore.kt:76-79`, moved to the shell as
  `CloudSpeechReadiness`). Its cloud settings UI stays where it is
  (`SpeechSettingsActivity.kt:271-279`).
- **Our app never registers anything**, so its APK has no `CloudStt*`, realtime or
  completed-audio class, and no `HubSecretStore`.

### 3.8 Module files

`phone-core/build.gradle.kts`:

```kotlin
plugins { id("com.android.library") }

android {
    namespace = "com.anezium.rokidbus.phone.core"
    compileSdk = 36
    defaultConfig { minSdk = 30 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    api(project(":shared"))
    api(project(":bus-client"))
    implementation(project(":ink-engine"))
    implementation("com.example.cxrglobal:lib:0.3.0")
    implementation("com.android.tools.build:apksig:9.2.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
```

`phone-core/src/main/AndroidManifest.xml` carries only what the moved code needs, copied from
`phone-hub/src/main/AndroidManifest.xml`: `BLUETOOTH`, `BLUETOOTH_ADMIN`, `BLUETOOTH_CONNECT`,
`RECORD_AUDIO`, `ACCESS_WIFI_STATE`, and the `<queries>` for `com.rokid.sprite.global.aiapp`,
`…externalapp.AUTHORIZATION`, `…externalapp.MEDIA_STREAM_SERVICE` and `TTS_SERVICE`. No
component: the host Service belongs to each shell. The foreground-service permissions and type
stay on the shell's `<service>`.

`phone-hub/build.gradle.kts` adds `implementation(project(":phone-core"))` and keeps everything
else, including `:kadb-compat`, okhttp and the `GLASSES_APK_SIGNER_SHA256` field.
`androidx.exifinterface` stays with the snapshot code in the shell.

---

## 4. The `:glasses-core` split `[FR 4]`

`glasses-hub` has no plugin runtime to extract, so the split is a move:

| What | From | To |
|---|---|---|
| All Kotlin (176 files) | `glasses-hub/src/main/java/com/anezium/rokidbus/glasses/**` (incl. `input/`, `session/`) | `glasses-core/src/main/java/…` (same packages) |
| AIDL | `glasses-hub/src/main/aidl/com/rokid/os/sprite/tts/ITtsServer.aidl`, `ITtsListener.aidl` | `glasses-core/src/main/aidl/…` |
| Assets | `rokid-nexus-a11y-watchdog.sh`, `rokid-nexus-cmd-bridge.sh` | `glasses-core/src/main/assets/` |
| Resources | `res/values/*`, `res/values-v31/*`, `res/xml/*` | `glasses-core/src/main/res/` |
| Manifest | `glasses-hub/src/main/AndroidManifest.xml`: `<permission>`, every `<uses-permission>`, `<uses-feature>`, `<queries>`, and every `<activity>`, `<service>`, `<receiver>` (`MainActivity`, `SetupEntryActivity`, `SurfaceActivity`, `CameraActivity`, `RokidBusAccessibilityService`, `NexusRemoteInputMethodService`, `BusHubService`, `BootReceiver`, `CameraOverlayVisibilityReceiver`, `SelfArmWirelessBootstrapReceiver`, `OpenLauncherReceiver`, `SetLauncherBackendReceiver`) | `glasses-core/src/main/AndroidManifest.xml` (moved; the `<application>` keeps only its children) |
| Tests (126 files) and `src/test/bridge/` | `glasses-hub/src/test/**` | `glasses-core/src/test/**` |

**`glasses-hub` keeps:** `build.gradle.kts` (application id `com.anezium.rokidbus.glasses`,
`versionCode`/`versionName`, `targetSdk = 32`, the lint rule, signing), the launcher mipmaps
(`res/mipmap-*`), and a new shell manifest at `glasses-hub/src/shell/AndroidManifest.xml`
(`<application>` with `allowBackup`, icon, round icon, label, `supportsRtl`, theme) wired by
`android.sourceSets["main"].manifest.srcFile("src/shell/AndroidManifest.xml")`. The old
manifest path is deleted, so its upstream edits follow the rename into the core (§5). Its
namespace becomes `com.anezium.rokidbus.glasses.shell`; the core keeps
`com.anezium.rokidbus.glasses`, so every `R` reference compiles unchanged.

**Code changes in the core:** one. `GlassesHub.kt:745` `BuildConfig.VERSION_NAME` (a library
has no version) becomes the host package's `PackageInfo.versionName`, which is the same value in
the upstream shell. `buildConfig` is then off in the core.

**Build:** `glasses-core/build.gradle.kts` is a `com.android.library` (namespace above,
`minSdk = 31`, `aidl = true`) carrying today's dependencies (`:shared`, `:bus-client`,
`:ink-engine`, flexbox, lottie, `cxr-service-bridge:1.0-20260522.063600-105`, dadb,
`:kadb-compat`, coroutines) and test dependencies; `glasses-hub` depends on
`implementation(project(":glasses-core"))` only. The glasses' own ADB self-arm (dadb and
`:kadb-compat` in `AdbKeyStore`, `WirelessAdbShell`, `SelfArmLocalAdbBootstrapper`) is the
glasses arming themselves and moves with the core; `[6a-R7]` is about the phone, and T3's
dependency check is on `:mobile:app`.

**Identity:** untouched here. The manifest's `com.anezium.rokidbus.glasses.permission.START_SELFARM_WIRELESS`
and the package literals in `SelfArmConstants.kt`, `GlassesHub.kt` and
`AccessibilityWindowRoots.kt` move as they are; T12 makes them `${applicationId}` and
`GlassesCoreConfig.identity`. T12's `:glasses-app` becomes the second thin shell, and the
product glasses tests are `:glasses-core`'s plus `:glasses-app`'s.

---

## 5. Commits, upstream merges and PATCHES.md

**Rename tracking.** `scripts/upstream-sync.sh` merges upstream into `vendor/nexus`, and git
maps an upstream edit onto a moved file only if the old path is gone on our side and the new
file is still ≥ 50 % similar. So:

- Every moved file is a `git mv` with its name kept.
- `phone-hub/…/BusHubService.kt` is **deleted**; the shell class keeps the FQN
  `com.anezium.rokidbus.phone.BusHubService` in a new file `BusHubShellService.kt`. The old
  file's rename target is `phone-core/…/HubCore.kt`, which keeps most of its lines in their
  original order (the core members of §2 are cut out of the file, not rewritten). The
  implementer checks `git diff -M --stat 548576f4 -- vendor/nexus` shows
  `BusHubService.kt => HubCore.kt`; if it doesn't, the split is redone with fewer rewrites.
- The glasses manifest moves; the shell's is new at a new path (§4).

An upstream edit to shell-only code in `BusHubService.kt` will then conflict inside `HubCore.kt`
and be ported to `BusHubShellService.kt` by hand; that is the accepted cost.

**Commits** (each with a PATCHES row; files column exact, as the sync script matches on it):

1. `Add an in-process transport factory to the plugin client` —
   `bus-client/src/main/java/com/anezium/rokidbus/client/plugin/NexusPluginClient.kt`. Not
   must-not-touch.
2. `Split the Nexus phone hub into a reusable core` — `phone-core/`, `phone-hub/`. **Must-not-touch:
   yes**: it renames `PhoneSppPairing.kt` and `PhoneSppPairingStorage.kt` (byte-identical) and
   moves the SPP connect/auth/read code (`BusHubService.kt:3609-3662,3825-3925`) verbatim.
3. `Split the Nexus glasses hub into a reusable core` — `glasses-core/`, `glasses-hub/`.
   **Must-not-touch: yes**: it renames `AuthenticatedSppServer.kt` (byte-identical).
4. `Split the Nexus phone and glasses hubs into reusable cores` — the plan's closing commit:
   `settings.gradle.kts` (`include(":phone-core")`, `include(":glasses-core")` for the
   standalone build `[6a-R6]`), the PATCHES rows, and the must-not-touch list's paths updated to
   `phone-core/…/PhoneSppPairing*.kt` and `glasses-core/…/AuthenticatedSppServer.kt`.

The rows marked `yes` link the controller's security review of the moved SPP code; the review
checks that `git diff -M100%` shows those three files as pure renames and that the moved
functions are textually unchanged.

---

## 6. Tests

**Moved tests keep their identity.** A test follows its class: a `:phone-hub` test whose
subject moves goes to `:phone-core` (same FQN, `git mv`), all `:glasses-hub` tests go to
`:glasses-core`, and the test resources go with them (`phone-hub/src/test/resources/glasses-apk/`
with `ApksigGlassesApkInspectorTest`). The parity check compares `class#method → outcome` over
the union `:phone-core` ∪ `:phone-hub` (and `:glasses-core` ∪ `:glasses-hub`) against T1's
baseline, so every identity is still there and still passes (Open point 2). Bodies change only
where the subject's shape changed:

- `SppIngressTest` (reflects `binder`, `registrations`, `routeRemote` on `BusHubService`) stays
  in `:phone-hub`, still builds the service with Robolectric, and reflects on its `core`. (In
  `:phone-core`, Robolectric's package would be the namespace `com.anezium.rokidbus.phone.core`,
  not the app id; Service-built tests therefore stay in the shell.)
- `HubCommandSecurityTest` (reflects `startupBlockedByBluetoothPermission`, `hubEnabled`,
  `sppLoopStarted`, `coreRemoteBridge`, `speechMicrophoneForegroundRequested`) stays in
  `:phone-hub`; the fields that moved are read through the shell's `core`.
- `SppPairingStatusTest` stays (it tests `statusText`) and reads `sppKeyStatus` through the core.
- `GlassesApkVerificationPolicyTest` moves and calls `verify(…, GlassesApkMetadata(…), …)`.
- `SpeechSessionManagerTest`, `RoutingSttSessionFactoryTest`, `SttSessionBehaviorTest`,
  `SpeechSettingsStoreTest` move and build a registry; `HubSecretStoreTest`,
  `RealtimeSpeechToTextTest`, `AzureSpeechValidationTest` stay with the cloud code.
- `phone-hub/src/test/bridge/files_answer_loss.init.gradle:11,15` points at `glasses-core/src/…`.

**New tests (Step 2):**

- `upstream_shells_build_and_pass_on_the_cores`: `:phone-hub` and `:glasses-hub` assemble and
  pass with application ids `com.anezium.rokidbus.phone` / `com.anezium.rokidbus.glasses`
  unchanged, `HubTarget.PHONE` and `HubTarget.GLASSES` resolving, and the union parity above.
- `phone_core_has_no_plugin_runtime_or_cloud_speech_types`: `:phone-core`'s
  `releaseRuntimeClasspath` has no `:kadb-compat` and no okhttp, and its classes include none of `PhonePluginDiscovery`, `PhonePluginRegistry`,
  `ExternalPlugin*`, `PluginGrantStore`, `PluginGuardian*`, `SkillsCoordinator`, `Store*`,
  `Registry*`, `NexusSelfUpdater`, `NexusUpdate*`, `PluginInstaller`, `Patcher*`, `Youtube*`,
  `Reddit*`, `GlassesManual*`, `CloudStt*`, `*RealtimeSpeechToText*`, `*CompletedAudio*`,
  `HubSecretStore`, `SpeechCredits`.
- `glasses_surface_contract_tests`: one test per row of §1 (L1–L8, C1–C8, N1–N8, T1–T4,
  S1–S7), against a real `HubCore` with `FakeCxrTransport` and an `InProcessApp`. Each asserts
  the wire frame the fake records (or the frame it injects), the callback, its thread, and the
  row's cancellation rule.
- `installer_verifies_before_every_push_and_reports_each_result`: a fixture APK signed by a
  test key; one case per `InstallResult`, plus a file changed after one successful install that
  must be re-verified and refused; the fake records zero `appUploadAndInstall` calls on every
  refusal.
- `installer_cancel_stops_push`: `cancel()` and coroutine cancellation before step 8 give
  `Cancelled` and no upload; after step 8 the CXR result wins.

Green in both the root build and the standalone `vendor/nexus` build `[6a-R6]`.

---

## 7. Open points

1. **The bus-client factory is outside T2's owned paths** (the ownership table lists only the
   hubs and cores). It is the smallest way to reuse the SDK's semantics in-process. If it is
   refused, the fallback is `NexusPluginClient.create(context, pluginId, callbacks,
   HubTarget(context.packageName, <host service FQN>))` against a non-exported in-app service
   whose `onBind` returns `busBinder()`, with the admission hook approving only the in-process
   principal. That needs no bus-client edit but adds a bindable service and an `ACTION_HUB`
   intent filter to our app, which T3's manifest check must then allow by name.
2. **"Identities unchanged" read as the shell ∪ core union.** The product suite list needs
   `:phone-core:testDebugUnitTest` and `:glasses-core:testDebugUnitTest`, and the workflows
   (T1-owned) need the same two tasks; T2 does not edit them.
3. **`installedVersion()` has no authoritative source.** CXR reports only installed or not, so
   the version comes from the glasses' own `versionName` announcement and the
   `major*10000+minor*100+patch` convention. Our glasses app (T12) must follow that
   convention, or announce a `versionCode` (a `:shared` contract change, not T2's), before Plan
   6b relies on `AlreadyCurrent`/`NewerOnGlasses`.
4. **`HubCore.kt` similarity.** If cutting the shell code out drops it below 50 %, upstream
   edits to `BusHubService.kt` stop following it. The sync script could pass
   `-X find-renames=40%` (T1-owned).
5. **R12′.** The SPP files move byte-identically and the SPP code moves verbatim, but they do
   change path, so commits 2 and 3 are `yes` rows that need the security review before merge.
