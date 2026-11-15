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
(§3.3).

**Threading rules for every row below:**

- **Calls are main-thread-confined** (`@MainThread`; an off-main call throws
  `IllegalStateException("GlassesSurface must be called on the main thread")`), except the
  three cancellation calls `SpeechHandle.stop()`, `stopSpeaking()` and `detach()`. Those may be
  called from any thread: off main they post themselves to the main looper and return at once,
  so every state change of the surface happens on main, in posting order.
- A confined call runs its SDK preflight synchronously on main, so its `NexusSdkResult` is
  meaningful. Its frame then goes to the core's single-thread local-ingress executor (§3.3) and
  the call returns. `SENT` means accepted, exactly as an AIDL `oneway` call means today
  (`SurfaceModels.kt:516-523`).
- **Callbacks always run on main, FIFO, and never re-entrantly.** A callback caused by a call
  (for example `onStopped(CANCELLED)` from `SpeechHandle.stop()`, which the SDK raises
  synchronously at `NexusSpeechSession.kt:86-88`) is posted, and runs after the call returns.
- Every posted callback carries the **listener generation** and the **client epoch**
  (§3.2.1), and is dropped if either has changed by the time it runs.

### 1.1 Lifecycle, link and device

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| L1 | `AgentsPluginService.kt:339-361` `onNexusOpen()` (no-arg; `openType` ignored) | `NexusPluginCallbacks.onOpen(openType)` → `NexusPluginService.kt:133` | `SurfaceListener.onOpen(openType: String)`; `state.lifecycle = OPEN` | main | Delivered once per open. A duplicate open (fresh event id) re-presents, as `NexusPluginClient.kt:884-893`. `openType` is `open`, `resume` or `adopted` (L5). |
| L2 | not overridden (Agents holds no audio lease) | `onBackground()` → `NexusPluginService.kt:152` | `SurfaceListener.onBackground()`; `lifecycle = BACKGROUND` | main | Only after a detach with an active audio lease, which the in-process app never holds; kept for completeness. Speech and TTS are released **before** the callback (`NexusPluginClient.kt:899-903`). |
| L3 | `AgentsPluginService.kt:373-395` `onNexusClose()` | `onClose()` → `NexusPluginService.kt:139` | `SurfaceListener.onClose()`; `lifecycle = CLOSED` | main | Once per open. Before it: the active speech run ends `onStopped(CANCELLED)` and every accepted utterance ends `onDone(STOPPED)` (`NexusPluginClient.kt:613-617,666-670`). The surface ids are hidden by the hub. |
| L4 | `AgentsPluginService.kt:363-365` `onNexusLinkState(state)` → `AlertSoundPolicy.kt:80-85` (worn bit) | `onLinkState(Int)` | `SurfaceListener.onStateChanged(state: SurfaceState)`; `SurfaceState.linkState`, `.glassesWorn` | main | Every change. Capability flags (`noticeSupported`, `editableSupported`, `ttsSupported`, `noticeShownAckSupported`) are recomputed in the same snapshot (`NexusPluginClient.kt:749-754`). |
| L5 | `AgentsPluginService.kt:980-983` `attemptAdoption()` after a band tap while closed (`:433`) | `surfaceSession()` + `showCard` while closed → hub adopts (`PhonePluginRegistry.kt:154-161`, `ExternalPluginController.kt:227-244`) | `showCard`/`showReader` while `CLOSED` | call: main | If the HUD is idle the core adopts: `onOpen("adopted")` follows. If not, `onSurfaceRejected("SURFACE_BUSY")`. |
| L6 | `AgentsPluginService.kt:419` and `:393` `surface?.hide()` | `NexusSurfaceSession.hide()` | `hide(): NexusSdkResult` | call: main | Hides the surface and ends the session: `onClose()` follows once (`closeOnHide = true`, `BusHubService.kt:1461-1465` → `:2879-2893`). Idempotent while closed. |
| L7 | `AgentsPluginService.kt:367-371` `onNexusMessage(GLASSES_DEVICE_INFO)` → `AlertSoundPolicy.kt:87-93` (volume) | `onMessage(path = /glasses/device-info)` | `SurfaceListener.onDeviceInfo(info: GlassesDeviceInfo)`; last value in `deviceInfo` | main | On every CXR device-info report (`BusHubService.kt:639-641` → `:5080-5096`). Never carries the serial number. |
| L8 | `AgentsPluginService.kt:256`, `:456-470` service create/destroy | `NexusPluginService.onCreate/onDestroy` (`:94-115`, `:117-129`) | `attach(listener, notices)` / `detach()` | `attach`: main; `detach`: any thread (posted) | The full contract is §3.2.1: generation invalidation, the initial state delivery, and what `detach` releases (speech, TTS, notice, surface, foreground). |
| L9 | implicit: `NexusPluginService.kt:131-137,362-366` promotes the plugin's own foreground notification on open | `promoteNexusSessionForeground()` | none | — | Dropped on purpose: the in-process app runs inside the core's host service, which is already foreground (`connectedDevice|microphone`). T3 owns that service. |

### 1.2 Cards, readers and card input

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| C1 | `AgentsPluginService.kt:1012` `showCard(card)` | `NexusSurfaceSession.showCard` | `showCard(card: NexusCard): NexusSdkResult` | call: main | Fire-and-forget; superseded by the next show/update; dropped by `hide()` or close. FIFO with every other call. |
| C2 | `AgentsPluginService.kt:1012` `updateCard(card)` | `updateCard` | `updateCard(card: NexusCard): NexusSdkResult` | call: main | As C1. |
| C3 | `AgentsPluginService.kt:993` `showReader(reader)` | `showReader` | `showReader(reader: NexusReader): NexusSdkResult` | call: main | As C1; paged output is the reader's segments (`NexusReader`, limits enforced at `SurfaceModels.kt:182-184`). |
| C4 | `AgentsPluginService.kt:993` `updateReader(reader)` | `updateReader` | `updateReader(reader: NexusReader): NexusSdkResult` | call: main | As C1. |
| C5 | `AgentsPluginService.kt:670-673` `activeSurface.onRejected = …` | `NexusSurfaceSession.onRejected` (`SurfaceModels.kt:516-523`, armed per call by `watchForSurfaceError`) | `SurfaceListener.onSurfaceRejected(code: String)` | main | At most once per rejected call, for any surface call (codes: `SURFACE_BUSY`, `INVALID_SURFACE_ID`, image codes). Agents keeps its own attempt counter, as today. |
| C6 | `AgentsPluginService.kt:397` `onNexusInput(event)` → `GlassesScreen.kt:315` | `onInput(NexusInputEvent)` | `SurfaceListener.onInput(event: NexusInputEvent)` | main | Only while `OPEN` (`NexusPluginClient.kt:917`). |
| C7 | `AgentsPluginService.kt:663-667` `supportsEditableSurface` gate; `:676-681` card with `EditableSurfaceField` | `NexusPluginClient.supportsEditableSurface` (`:118-120`) | `state.editableSupported`; field sent inside `NexusCard.editable` via C1/C2 | call: main | Checked at the moment of the call; can flip with the link. |
| C8 | `AgentsPluginService.kt:693-716` `onNexusSurfaceTextCommitted` | `onSurfaceTextCommitted(surfaceId, text, cancelled)` | `SurfaceListener.onTextCommitted(surfaceId: String, text: String, cancelled: Boolean)` | main | At most once per editable field; `text` is empty when cancelled. A close drops a pending field silently. |

### 1.3 Notices and wake

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| N1 | `AlertBand.kt:19-25`, `:40-44` `client.showNotice(notice)` behind `supportsNoticeSurface` (`:21,48,56`) | `NexusPluginClient.showNotice` (`:177-189`) | `showNotice(notice: NexusNotice): NexusSdkResult`; `state.noticeSupported` | call: main | Works in any lifecycle state (a dormant app may say one thing). Replaces this app's band. |
| N2 | `AlertBand.kt:27-31` `client.updateNotice(update)` | `updateNotice` (`:211-222`) | `updateNotice(update: NexusNoticeUpdate): NexusSdkResult` | call: main | `rearm = false` needs the interaction version from registration (`:213`), which the in-process registration carries. |
| N3 | `AlertBand.kt:33-37` `client.hideNotice()` | `hideNotice` (`:224-238`) | `hideNotice(): NexusSdkResult` | call: main | Followed by `NoticeCallbacks.onClosed(OWNER)`; any input in flight after the hide is dropped (`noticeHidePending`). |
| N4 | `AgentsPluginService.kt:442-444` `onNexusNoticeShown` | `onNoticeShown()` | `NoticeCallbacks.onShown()`; `state.noticeShownAckSupported` | main | At most once per show; a late ack for a replaced band is dropped. |
| N5 | `AgentsPluginService.kt:425-434` `onNexusNoticeInput` | `onNoticeInput(event)` | `NoticeCallbacks.onInput(event: NexusInputEvent)` | main | At most once per question. |
| N6 | `AgentsPluginService.kt:436-439` `onNexusNoticeAction` | `onNoticeAction(id)` | `NoticeCallbacks.onAction(id: String)` | main | At most once per question; never together with N5. |
| N7 | `AgentsPluginService.kt:446-454` `onNexusNoticeClosed` | `onNoticeClosed(reason)` | `NoticeCallbacks.onClosed(reason: NexusNoticeCloseReason)` | main | Exactly once per notice, including the app's own hide. |
| N8 | `AlertNotices.kt:52-60` `wakeDisplay = wake && …`, used by `AlertDirector.kt:332-333` | `NexusNotice.wakeDisplay` | a field of N1 | call: main | No separate call. The contract test asserts the flag reaches the wire payload. |

### 1.4 TTS

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| T1 | `AgentsPluginService.kt:494-502` lazy `nexusTtsSession(...)`, `speak(cue)`, drop on `NOT_REGISTERED` | `NexusTtsSession.speak` (`NexusTtsSession.kt:47-73`) | `speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult` | call: main | One internal `NexusTtsSession`, re-made after a release, so callers never hold a dead session. Errors are the return value (`TTS_RATE_LIMITED`, `CAPABILITY_NOT_AVAILABLE`, `INVALID_PAYLOAD` for a reused id, `NOT_REGISTERED`). |
| T2 | `AgentsPluginService.kt:497` `onTtsStarted` (no-op today) | `NexusTtsCallbacks.onTtsStarted` | `TtsCallbacks.onStarted(utteranceId: String)` | main | Once per accepted utterance. |
| T3 | `AgentsPluginService.kt:498` `onTtsDone` (no-op today) | `onTtsDone(id, reason)` | `TtsCallbacks.onDone(utteranceId: String, reason: NexusTtsDoneReason)` | main | Exactly once per accepted utterance: `COMPLETED`, `STOPPED`, `PREEMPTED`, `CANCELLED`, or `UNAVAILABLE` (the error path). Close/detach ends all with `STOPPED`. |
| T4 | `AgentsPluginService.kt:461` `tts?.close()` | `NexusTtsSession.stop()/close()` | `stopSpeaking()` | any thread (posted) | Stops the current utterance; its `onDone(STOPPED)` is posted. A no-op with nothing speaking. |

### 1.5 STT

| # | Agents site today | SDK today | `GlassesSurface` member | Threading | Cancellation / ordering |
|---|---|---|---|---|---|
| S1 | `VoiceQuestionWiring.kt:73-90` `speechSession(callbacks)` then `start("auto")` | `NexusSpeechSession.start` (`NexusSpeechSession.kt:58-79`) | `startSpeech(language: String?, listener: SpeechListener): SpeechHandle`; `SpeechHandle.result` | call: main | One run at a time per surface: a second start while one is pending, active or latched-stopping gets `CAPABILITY_NOT_AVAILABLE` and no callbacks. Each run has its own listener and run id, so a late callback can never reach a newer run (§3.2.2). |
| S2 | `VoiceQuestionWiring.kt:75` `onSpeechStarted(realtime)` | `onSpeechStarted` | `SpeechListener.onStarted(realtime: Boolean)` | main | Once, when the hub accepts. |
| S3 | `VoiceQuestionWiring.kt:76` `onSpeechState` (ignored) | `onSpeechState` | `SpeechListener.onState(state: NexusSpeechState)` | main | 0..n while active. |
| S4 | `VoiceQuestionWiring.kt:77-79` `onSpeechPartial` | `onSpeechPartial` | `SpeechListener.onPartial(text: String)` | main | 0..n while active. Never logged `[6a-R8]`. |
| S5 | `VoiceQuestionWiring.kt:80` `onSpeechFinal` | `onSpeechFinal` | `SpeechListener.onFinal(text: String)` | main | 0..1 per run. |
| S6 | `VoiceQuestionWiring.kt:81-83` `onSpeechStopped(reason, error)` | `onSpeechStopped` | `SpeechListener.onStopped(reason: NexusSpeechStopReason, error: NexusSpeechError?)` | main | Exactly once per accepted or denied run (`DENIED_*` for a refusal after `SENT`; `LINK_LOST`, `NO_SPEECH`, `ERROR` with `error`). |
| S7 | `VoiceQuestionWiring.kt:88` `capture.attach { session.stop() }` | `NexusSpeechSession.stop()` (`:81-90`) | `SpeechHandle.stop()` | any thread (posted) | Latched through acceptance (§3.2.2): it stops only its own run, even while the start is still pending, and the run ends with exactly one `onStopped(CANCELLED, null)`. A no-op after the run ended. |

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
| `312-342` | SPP loop, enabled flags, SPP locks/deadlines/nonces/provisioning/backoff/key status, `sppCxrIdentity`, `sppPairing`, socket, `sppSession`, `cxrLink` | Core, including **`hubEnabled` (`313`) and `sppLoopStop` (`312`), with their names**: the verbatim SPP code reads them at `337`, `3610`, `3621`, `3830`, `3853`, `3872`, so the core owns the authoritative gate and those lines stay textually identical. `start()` sets `hubEnabled = true`, `stop()` sets it `false`, `close()` sets `sppLoopStop = true` (§3.1.1). The shell keeps `startupBlockedByBluetoothPermission` and the persisted `PREF_ENABLED`, and reads the gate as `core.isEnabled` where it read `hubEnabled` (`1166`, `5010`). |
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
| `1179-1218` | `enableHub`, `stopHub` | Split. `enableHub`: shell writes `PREF_ENABLED`, restarts its bridge, promotes, then calls `core.start()` (which sets the gate, `1181`). `stopHub`: shell writes `PREF_ENABLED = false`, then `core.stop()` (gate off first, then the release of `1195-1209`), then demotes and `stopSelf` (`1211-1217`). |
| `1220-1273` | `onDestroy` | Split. Shell closes its controllers (`1221-1227` minus the core's), then `core.close()`, which does `1228-1233` and the rest of the core teardown (§3.1.1). |

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
| `2541-2626` | `deliverError`, `notifyPluginRegistration`, registration removal | Core. In `removeRegistration` (`2580-2625`) the core part runs first and in today's order (journal, `unlinkToDeath`, audio and speech release, activity clear `2595-2599`); the shell part — skills `onRegistrationRemoved` (`2600-2604`) and external/camera `onBinderDied` (`2611-2620`) — becomes **Hook** `onRegistrationRemoved(principal, reason, ownerStillConnected)`, called last, with the same reason filters applied by the shell. |
| `2627-2653` | `revokePrincipal`, `authorizationChanged` | Split into a fixed sequence (§3.5.3). `revokePrincipal`: **Hook** `onPrincipalRevoking(key)` (camera and external `onRevoked`, `2628-2629`) → core clears pin/notice/activity for the owner (`2630-2632`) → core removes each matching registration with reason `authorizationChanged` (`2633-2635`, which fires `onRegistrationRemoved`). `authorizationChanged`: `revokePrincipal` → **Hook** `onAuthorizationChanged(key)` (skill-grant revoke and coordinator, camera readiness, media-sync consent, `2639-2649`) → core `notifyLinkState()` (`2650`), so plugins see the new capabilities only after every revocation side effect. |
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
| `4968-5017` | status notification | Shell, fed by `HubForegroundHost.onLinkStateChanged`. `statusText` stays on the shell class (reflected on by `SppPairingStatusTest`). It reads `core.sppKeyState()` and `core.cxrClosedByServer` (§3.5.2). `PhoneSppPairing.KeyStatus` is `internal` to a must-not-touch file, so the core maps it to a public `SppKeyState` in `HubCore.kt` rather than widening it. |
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
class HubCore(context: Context, config: HubCoreConfig) : AutoCloseable {
    /** Main thread. Enables the hub: see §3.1.1. Idempotent; callable again after stop(). */
    @MainThread fun start()

    /** Main thread. Disables the hub and releases the radios: see §3.1.1. Idempotent. */
    @MainThread fun stop()

    /** Main thread. Terminal: stop(), then end the SPP loop and the executors. Idempotent. */
    @MainThread override fun close()

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

#### 3.1.1 The enabled gate and the core lifecycle

The core owns the one authoritative gate, `@Volatile private var hubEnabled`, initially
`false`, under its upstream name, so the SPP code that reads it (`BusHubService.kt:337,3610,
3621,3830,3853,3872`) moves without a textual change. The shell's lifecycle drives it and only
reads it back (`@HubShellApi val isEnabled: Boolean`).

| Call | Effect, in order | Upstream origin |
|---|---|---|
| `start()` | `check(!closed)`; `hubEnabled = true`; create the in-process client if there is an app (§3.2.1); `startCxrIfTokenAvailable()`; `connectSpp()` (starts the loop once per core; an idle loop picks the gate up within its 750 ms wait, `3830-3833`) | `1074-1084`, `1179-1189` |
| `stop()` | `hubEnabled = false` **first**, so a handshake in flight aborts at `3853`/`3872` and no key is offered (`3610`, `3621`); then the surface's release-before-close and client close (§3.2.1: speech `CANCELLED`, TTS `STOPPED`, `onClose`); then `foreground.closeAll("hub_stopped")`, which hides the app's surface and band without delivering to the closed client; then `1195-1209` verbatim (speech cancel, audio lease, activities, snapshot hook, CXR disconnect, flags, socket, `notifyLinkState`) | `1192-1210` |
| `close()` | `stop()`; `sppLoopStop = true`; `1224-1233` and the remaining core-owned teardown of `1220-1273` (handler callbacks, SPP executors, speech manager, executors); `closed = true` | `1220-1273` |

`close()` is the one member beyond the brief's list: a Service's `onDestroy` needs a terminal
call that `stop()` cannot be, because the upstream shell calls `stop()` (`stopHub`) while
bound plugins keep the same core and binder alive and may `start()` again.

**Threading of the shell entry points:** `start`, `stop`, `close` are main-thread (the Service
lifecycle); every other `@HubShellApi` member states its thread in §3.5.2.

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

    @MainThread fun attach(listener: SurfaceListener, notices: NoticeCallbacks) // L8, §3.2.1
    @AnyThread fun detach()                                                     // L8, §3.2.1

    @MainThread fun showCard(card: NexusCard): NexusSdkResult          // C1, L5
    @MainThread fun updateCard(card: NexusCard): NexusSdkResult        // C2
    @MainThread fun showReader(reader: NexusReader): NexusSdkResult    // C3, L5
    @MainThread fun updateReader(reader: NexusReader): NexusSdkResult  // C4
    @MainThread fun hide(): NexusSdkResult                             // L6

    @MainThread fun showNotice(notice: NexusNotice): NexusSdkResult         // N1, N8
    @MainThread fun updateNotice(update: NexusNoticeUpdate): NexusSdkResult // N2
    @MainThread fun hideNotice(): NexusSdkResult                            // N3

    @MainThread fun speak(text: String, utteranceId: String, callbacks: TtsCallbacks): NexusSdkResult // T1
    @AnyThread fun stopSpeaking()                                                                     // T4

    @MainThread fun startSpeech(language: String?, listener: SpeechListener): SpeechHandle // S1, §3.2.2
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
    @AnyThread fun stop()      // S7, §3.2.2
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
bus-client with `api(project(":bus-client"))`. `@MainThread`/`@AnyThread` are
`androidx.annotation`; the confinement is also checked at runtime (§1).

#### 3.2.1 Attach, detach and the core restart

Two counters, both read and written on main only:

- **Listener generation** `g`: incremented by every `attach` and `detach`.
- **Client epoch** `e`: incremented each time `HubCore.start()` creates a new
  `NexusPluginClient` (a closed client cannot reconnect, `NexusPluginClient.kt:1001-1029`).

Every SDK callback the adapter receives is turned into a posted task stamped `(g, e)` at post
time. The task runs only if both still match, so no callback outlives a listener replacement,
a detach or a restart, including callbacks already queued.

| Event (main thread) | Contract |
|---|---|
| `HubCore.start()` | `e++`; a new client and transport registration (§3.3). An attached listener stays attached and gets `onStateChanged(state)` once the registration is approved. Confined calls before that return `NOT_REGISTERED`. |
| `attach(l, n)` | If attached, an implicit `detach()` first. Then `g++`, store the pair, post `onStateChanged(state)` and, if known, `onDeviceInfo(deviceInfo)`. `onOpen` is never synthesised: an attach sees the current `state.lifecycle`, which is `CLOSED` after any detach. |
| an open while detached | The adapter answers with `hide()` at once, so the hub never holds an open that nobody draws; `lifecycle` stays `CLOSED`. |
| `detach()` | `g++` first, so nothing queued reaches the old pair. **Release, in this order:** end every speech run silently (the §3.2.2 stop, with its terminal callback dropped by `g`); stop TTS (`NexusTtsSession.close()`, `onDone(STOPPED)` dropped); `hideNotice()` if this app's band is up; `hide()` if `OPEN`, which makes the hub close the foreground (`onSelfHid` → `PLUGIN_CLOSE`, dropped by `g`). The registration stays, so a later `attach` needs no reconnect. While detached, confined calls return `NOT_REGISTERED` and send nothing. |
| `HubCore.stop()` | **Release before close:** (1) every speech run ends with `onStopped(CANCELLED, null)` and every accepted utterance with `onDone(STOPPED)`, both posted under the current `(g, e)`, so the listener sees these reasons and never the `ERROR`/`UNAVAILABLE` of `NexusPluginClient.close()` (`:1007-1014`); (2) if `OPEN`, post `onClose()` and set `CLOSED`; (3) `client.close()` and unregister the transport. Anything `close()` raises afterwards finds no run left. (4) Only then does the core's foreground policy close (§3.1.1), hiding the app's surface and band on the glasses without delivering to the closed client. |

#### 3.2.2 Speech runs

Each `startSpeech` creates one run with its own `NexusSpeechSession` (as Agents does today,
`VoiceQuestionWiring.kt:73`) and its own listener. A run is in one state at a time, changed on
main only:

| State | Event | Next state and what the listener gets |
|---|---|---|
| — | `startSpeech` → SDK `start()` ≠ `SENT` | `ENDED`. `SpeechHandle.result` carries the refusal; **no callback ever**. |
| — | `startSpeech` → `SENT` | `REQUESTED`. |
| `REQUESTED` | SDK `onSpeechStarted` | `ACCEPTED`; post `onStarted(realtime)`. |
| `REQUESTED` | SDK `onSpeechStopped(DENIED_*/…)` | `ENDED`; post `onStopped(reason, error)`. |
| `REQUESTED` | `stop()` | `STOP_LATCHED`; post `onStopped(CANCELLED, null)` — the listener's last callback. No frame yet: the SDK cannot stop a pending start (`NexusSpeechSession.kt:82-83`). |
| `STOP_LATCHED` | SDK `onSpeechStarted` | Call the SDK `stop()` at once, which sends the stop frame (`:84-88`); the SDK's own `CANCELLED` is swallowed. `ENDED`. This is what `VoiceCapture.kt:49-52` does by hand today. |
| `STOP_LATCHED` | SDK `onSpeechStopped(any)` | `ENDED`; swallowed. |
| `ACCEPTED` | SDK partial/state/final | post `onPartial`/`onState`/`onFinal`. |
| `ACCEPTED` | `stop()` | SDK `stop()` sends the frame and finishes synchronously with `CANCELLED`; the adapter **posts** that `onStopped(CANCELLED, null)` (never re-entrant). `ENDED`. |
| `ACCEPTED` | SDK `onSpeechStopped(reason, error)` | `ENDED`; post it. |
| `ENDED` | anything | Dropped. `stop()` is a no-op. |

- `stop()` from another thread posts the same transition to main; it takes effect in posting
  order relative to SDK callbacks already queued, and the listener still sees exactly one
  terminal callback.
- While a run is `REQUESTED`, `ACCEPTED` or `STOP_LATCHED`, a new `startSpeech` returns
  `CAPABILITY_NOT_AVAILABLE` with no callbacks (the SDK allows one speech session per client).
  A latched run with no acceptance ever ends when the client closes or the link drops, through
  the SDK's own termination (`NexusPluginClient.kt:613-617`), swallowed.

#### 3.2.3 Utterances

One internal `NexusTtsSession`, created on the first `speak` and re-created after a release.
Each accepted `speak` records `utteranceId → callbacks`; `onStarted`/`onDone` are posted to that
entry, and `onDone` removes it. `stopSpeaking()` (any thread, posted) calls the SDK `stop()`;
the `onDone(STOPPED)` it causes is posted. A reused `utteranceId` is `INVALID_PAYLOAD`, as in the
SDK (`NexusTtsSession.kt:57`).

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

`NexusPluginTransport` is already public (`NexusPluginTransport.kt:5-28`). The controller ruled
this patch allowed and preferred over an in-app `ACTION_HUB` service (R203, §7).

`InProcessPluginTransport`:

- `connect(listener)`: registers one `Registration` (`clientId = pluginId`, prefixes from
  `InProcessApp.receivePrefixes`, `uid = Process.myUid()`, `callback` = a local
  `IBusCallback.Stub`, `principal` = the in-process principal below, `grantedCapabilities =
  InProcessApp.capabilities`), then posts `onRegistrationState(APPROVED)` and the
  `PLUGIN_REGISTRATION` message (`notifyPluginRegistration`, `BusHubService.kt:2554-2572`), so
  `noticeInteractionVersion` and the grants are set as they are for an AIDL plugin.
- The local stub's `onMessage`/`onBinaryMessage`/`onLinkState`/`onGlassesAiButton` decode
  exactly as `BusClient` does and **post to the main looper**. A local Binder's
  `linkToDeath` never fires, so the in-process registration is removed only when
  `HubCore.stop()` closes the client (§3.2.1); `start()` registers a new one.
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
- `closeAll`: from `stop()`, after the client is closed: marks inactive and hides the app's
  surface and notice on the glasses; delivers nothing (the surface already gave `onClose`).
- No open-ack watchdog: there is no binder to rebind.

The upstream shell's implementation wraps `PhonePluginRegistry` and `ExternalPluginController`
and keeps their exact behaviour.

### 3.5 Shell-only API

Every cross-module entry point the upstream shell uses, with its thread. "Reader thread" is
the thread that delivered the frame from the glasses (the CXR custom-command callback thread or
the SPP read loop), as today.

#### 3.5.1 Opt-in and hooks

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
    fun onRegistrationRemoved(principal: PhonePluginPrincipal?, reason: String, ownerStillConnected: Boolean) {}
    fun onPrincipalRevoking(key: PluginGrantKey) {}
    fun onAuthorizationChanged(key: PluginGrantKey) {}
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

@HubShellApi
data class AuthorizedSender(
    val caller: PluginRouteCaller,
    val replyBinder: IBinder?,
    val principal: PhonePluginPrincipal? = null,
)
```

| Hook | Called on | When, and in what order |
|---|---|---|
| `admitPlugin` | the binder thread of `registerPlugin` | Synchronously, before any core state changes. Replaces `BusHubService.kt:516-561`. |
| `onPluginRegistered` | the same binder thread | After `addRegistration` and `notifyPluginRegistration` (`563-569`), so the plugin holds its registration message before the shell's controllers hear of it, as at `568-583` today. |
| `grantFor` | the routed call's thread (binder thread, local-ingress executor, reader thread) | Inside `resolveSender` (`2522`). Pure read; must not block. Never asked for the in-process principal. |
| `onRegistrationRemoved` | the removing thread (binder death, a failed delivery, or main for a revocation) | Last step of `removeRegistration`, after the core's journal, unlink, audio and speech release and activity clear (`2581-2599`). |
| `onPrincipalRevoking` | main | First step of `revokePrincipal` (§3.5.3). |
| `onAuthorizationChanged` | main | After `revokePrincipal` returns, before `notifyLinkState` (§3.5.3). |
| `foreground` | the `HubCore` constructor's thread | Once. |
| `onRemote` | reader thread, inline | First in `routeRemote`, after the SPP-reserved and skills guards (`1509-1514`). Must return quickly; slow work goes to the shell's own executor, as `1576` does today. |
| `onLocal` | `routeLocal`'s thread | After every policy check, before the core's hub paths (`1490`). |
| `leaseRestriction` | `routeLocal`'s thread | Where `1314-1321` ran. |
| `enqueueUndelivered` | `routeLocal`'s or `routeRemote`'s thread | Last resort, where `1499-1501` and `1638` ran. |
| `extraCapabilities` | any thread | Inside `capabilities()`. Pure. |
| `onLinkState` | the thread that changed the link (CXR callback, SPP loop, or main from `stop()`) | First in `notifyLinkState`, after the core's own flags are updated and before the core's ink clear, the registrations' `onLinkState`, the launcher sync and `HubForegroundHost.onLinkStateChanged`. |
| `onGlassesCapabilities` | reader thread | After the core has applied the surface versions and `versionName` (`5291-5371`). |
| `onAssistGesture` | CXR callback thread | Inside `onGlassAiAssistStart` after the scene checks (`662-699`); `true` means the shell took the press. |

`HubForegroundPolicy` (§3.4) is called on: `handleRemote` reader thread; `allowSurface`,
`onSurfaceTraffic`, `onSelfHid` the `routeLocal` thread; `onAudioLeaseEnded` the audio-lease
thread; `syncLauncherList` the link-state thread; `closeAll` main; `activeId` any. These are the
threads `PhonePluginRegistry` and `ExternalPluginController` are called on today, so the shell's
wrapper needs no new synchronisation.

**Lock rule.** The core never calls a hook or a foreground-policy method while holding one of
its own locks (`sppLock`, `speechBusLock`, `glassesAppOperationLock`, the audio-lease
arbitrator, the speech-bus session lock). A hook may call any `@HubShellApi` member except
`start`, `stop` and `close`, including re-entering routing (`sendRemote`, `deliverLocal`), as
shell code does today.

#### 3.5.2 `@HubShellApi` members on `HubCore`

```kotlin
// state, any thread
@HubShellApi val isEnabled: Boolean
@HubShellApi val cxrClosedByServer: Boolean
@HubShellApi fun sppKeyState(): SppKeyState?            // UNAVAILABLE, RECOVERING, RECOVERED; null when OK
@HubShellApi fun linkState(): Int
@HubShellApi fun capabilities(): Int
@HubShellApi fun isCxrUp(): Boolean
@HubShellApi fun cxrLinkOrNull(): CXRLink?
@HubShellApi fun isPrincipalRegistered(principal: PhonePluginPrincipal): Boolean     // BusHubService.kt:2786

// lifecycle and identity, main thread
@HubShellApi fun startWithToken(token: String)          // persists cxrl_token, then start(); 1116-1123
@HubShellApi fun busBinder(): IBusService.Stub          // the same instance for the core's lifetime

// routing, any worker thread (sendRemote may block on an SPP write, as today)
@HubShellApi fun sendRemote(envelope: BusEnvelope): String?
@HubShellApi fun sendBuiltInPluginEnvelope(envelope: BusEnvelope): String?
@HubShellApi fun deliverLocal(envelope: BusEnvelope, excludeUid: Int? = null, targetBinder: IBinder? = null): Boolean
@HubShellApi fun deliverQueued(envelope: BusEnvelope): Boolean
@HubShellApi fun deliverError(targetBinder: IBinder?, id: String, code: String)
@HubShellApi fun deliverToPrincipal(principal: PhonePluginPrincipal, path: String, id: String, payload: JSONObject): Boolean
@HubShellApi fun deliverBinaryToPrincipal(principal: PhonePluginPrincipal, path: String, id: String, payload: JSONObject, data: ByteArray): Boolean
@HubShellApi fun hideExternalSurfaces(pluginId: String)
@HubShellApi fun announcePhoneCapabilities()

// grants, main thread (§3.5.3)
@HubShellApi fun revokePrincipal(key: PluginGrantKey)
@HubShellApi fun authorizationChanged(key: PluginGrantKey)

// audio and assistant, any thread
@HubShellApi fun acquireInternalAudio(tag: String, consumer: InternalAudioConsumer): InternalAudioAcquireResult
@HubShellApi fun releaseInternalAudio(tag: String)
@HubShellApi fun revokeBackgroundAudioLease(pluginId: String, reason: String): Boolean
@HubShellApi fun sendNativeAssistantExitBurst(gestureId: String, session: Int)

// the glasses app, through the one CXR app slot (§3.6.1)
@HubShellApi suspend fun openOnGlasses(activityClassName: String): Boolean
@HubShellApi suspend fun queryGlassesAppInstalled(): Boolean?
@HubShellApi fun uploadThirdPartyApk(apk: File, callback: (Boolean) -> Unit): Boolean

// settings UI, main thread
@HubShellApi val phoneTts: PhoneTtsPort
@HubShellApi fun startSpeechDictationTest(listener: SpeechUtteranceListener): SpeechStartResult
@HubShellApi fun cancelSpeechDictationTest()
@HubShellApi fun isSpeechDictationTestActive(): Boolean

@HubShellApi
interface PhoneTtsPort {                                   // BusHubService.kt:5547-5564
    val isReady: Boolean
    fun availableVoices(locale: Locale?): List<PhoneTtsVoiceOption>
    fun speakSample(text: String, locale: Locale): Boolean
}

enum class SppKeyState { UNAVAILABLE, RECOVERING, RECOVERED }
```

The shell's companion statics (`5507-5724`) keep their names and delegate to these through
`activeInstance?.core`. Our app never opts in, so it cannot reach the plugin bus.

#### 3.5.3 Revocation, in order

`revokePrincipal(key)`, main:

1. `hooks.onPrincipalRevoking(key)` — the shell's camera and external `onRevoked` (`2628-2629`).
2. Core: pin, notice and activity `clearForRevokedOwner(key.pluginId, "authorizationChanged")`
   (`2630-2632`).
3. Core: `removeRegistration(r, "authorizationChanged")` for each matching registration
   (`2633-2635`); each ends with `onRegistrationRemoved(principal, "authorizationChanged", …)`.

`authorizationChanged(key)`, main: `revokePrincipal(key)`; then
`hooks.onAuthorizationChanged(key)` — skill-grant revoke and coordinator, camera readiness,
media-sync consent (`2637-2649`, same order); then the core's `notifyLinkState()` (`2650`), so
capability changes reach plugins only after every revocation side effect has run.

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

#### 3.6.1 The CXR app slot

`CXRLink` keeps one app callback: every app call overwrites `glassAppCbk`
(`CxrGlobal/lib/.../CXRLink.kt:408,433,447,466,481`). A second call before the first answers
would hand the first's result to the second. Today two ad-hoc guards keep that apart
(`beginGlassesAppOperation`, `BusHubService.kt:4618-4622`, and `youtubeUploadId`,
`4596-4617`, which "holds the slot even after the UI timeout until the actual callback or
disconnection"). The core replaces both with one arbiter, `GlassesAppSlot` (internal), used by
**every** CXR app call: `install`, `installedVersion`, `openOnGlasses`,
`queryGlassesAppInstalled` and `uploadThirdPartyApk`.

```kotlin
internal class GlassesAppSlot(private val cxr: () -> CxrTransport?) {
    enum class Kind { INSTALL, QUERY, LAUNCH, THIRD_PARTY_UPLOAD }

    /** FIFO; cancellable only while waiting. */
    suspend fun acquire(kind: Kind): Op
    /** Non-suspending; null while the slot is held (uploadThirdPartyApk, as 4599-4600). */
    fun tryAcquire(kind: Kind): Op?

    inner class Op {
        val id: Long
        /** Pre-dispatch only: give the slot back. A no-op once dispatched or done. */
        fun release()
        /** Runs at completion, on whichever thread completes the op. */
        fun onComplete(action: () -> Unit)
    }

    /**
     * Marks [op] DISPATCHED under the slot lock, then makes one CXR app call with a fresh
     * IGlassAppCbk bound to (op.id, dispatch number). Returns the answer, or LINK_LOST.
     * Cancelling the awaiting coroutine detaches the waiter only; the dispatch stays owned
     * by the slot until it completes.
     */
    suspend fun <T> dispatch(op: Op, call: (IGlassAppCbk) -> Unit, answer: (AppAnswer) -> T): DispatchResult<T>
}
```

| Rule | Contract |
|---|---|
| States | An op is `ACQUIRED` → (`DISPATCHED` → `ACQUIRED`)* → `DONE`. It may make several CXR calls in sequence (install queries, then uploads); each has its own callback object and dispatch number. |
| Before a dispatch | The owner may abort (cancellation, `cancel()`, an exception, a failed precondition): `release()` in `finally` is correct here, and the slot is free at once. |
| After a dispatch | **Ownership is non-cancellable.** The slot is released, and the op's `onComplete` actions (delete the APK copy) run, only on: (a) the first answer on this dispatch's callback; (b) link loss — `onCXRLConnected(false)` and `onGlassBtConnected(false)` call `slot.failDispatched()` where `failActiveGlassesAppOperation` ran (`606`, `632`); (c) `HubCore.stop()`/`close()`. A CXR call that throws synchronously completes the dispatch as failed at once (today's `runCatching` paths). |
| Stale callbacks | A callback whose `(op.id, dispatch number)` is not the current dispatch is dropped. A callback after (b) or (c) is dropped. |
| Waiter cancellation | `suspendCancellableCoroutine`; `invokeOnCancellation` does nothing to the op. After a dispatch completes, the op checks the waiter and `cancel()` before its next step, and aborts there (release + cleanup). |
| Third-party upload | `uploadThirdPartyApk`: `tryAcquire`, one dispatch, `callback(success)` exactly once from the CXR thread on an answer; on link loss the slot is freed without a callback, as `5102` does today. |
| Locks | The slot lock is never held while calling CXR, a callback, `onProgress` or a hook. |

#### 3.6.2 `install`

`CxrGlassesAppInstaller` (core, internal). Callable from any coroutine context; the copy,
SHA-256 and apksig run on `Dispatchers.IO`. **`onProgress` is called inline in the caller's
coroutine context**, so it is never called after `install` returns: 0, 25 and 50 before the
upload dispatch, 100 just before returning `Installed`, and nothing on any other result. Each
`Failed.reason` is a fixed string, never a path, digest or exception message.

1. `onProgress(0)`. `expected.packageName` must equal the CXR session's package, else
   `Failed("Glasses APK package does not match this hub.")`.
2. `op = slot.acquire(INSTALL)` (waits FIFO). From here every exit before the upload dispatch
   runs `finally { copy?.delete(); op.release() }`.
3. Copy `apk` into a core-private file (`noBackupFilesDir/glasses-install/<uuid>.apk`). Every
   later step reads only the copy, so the file cannot change between verifying and pushing. An
   I/O failure is `Failed("Could not read the glasses APK.")`.
4. **Verify the copy, on every call:** `GlassesApkVerificationPolicy.verify(copy, expected,
   ApksigGlassesApkInspector())` — SHA-256 equals `expected.sha256`; apksig verifies; package
   equals `expected.packageName`; exactly one signer, and its digest is in
   `expected.signerSha256`; `versionCode == expected.versionCode`. A rejection is
   `Failed(<the policy's fixed reason>)`; an inspector exception is the policy's "could not be
   verified" reason. `onProgress(25)`.
5. The installed version, through a QUERY dispatch on this same op (as `installedVersion()`
   below): equal → `AlreadyCurrent`; greater → `NewerOnGlasses`.
6. Wi-Fi on (`isPhoneWifiEnabled`) and CXR up, else the two fixed messages of
   `BusHubService.kt:4101-4117`.
7. If `cancel()` was called or the waiter is cancelled: `Cancelled` (for `cancel()`) or
   `CancellationException` (for coroutine cancellation). **No upload is dispatched.**
8. `onProgress(50)`; `op.onComplete { copy.delete() }`; dispatch `appUploadAndInstall(copy)`.
   From here `cancel()` is ignored, coroutine cancellation detaches only the waiter, and the
   copy and the slot belong to the slot (§3.6.1).
9. The answer: success → `onProgress(100)`, `Installed`. Refused → `Failed("The glasses did
   not install the app.")`. Link lost → `Failed("Connection to the glasses was lost.")`. The
   op is then `DONE`.

`cancel()` (any thread) flags the current INSTALL op; it is a no-op without one, and after
step 8.

Progress is coarse because `CXRLink.appUploadAndInstall` reports only the final result
(`CxrGlobal/lib/.../CXRLink.kt:406-429`).

`installedVersion()` (any coroutine context): `slot.acquire(QUERY)`, one `appIsInstalled` dispatch. `null` when CXR is down or `appIsInstalled` says no; otherwise the
glasses' announced `versionName` (`HUB_CAPABILITIES`, `BusHubService.kt:399`) as a version code,
`major * 10000 + minor * 100 + patch` (the convention of
`GlassesApkVerificationPolicy.kt:64-71`, which moves to `GlassesVersionCode.fromVersionName`);
`null` if it has not announced on this link. CXR has no version query (`IGlassAppCbk` carries
only booleans). This is the controller's ruling R205 (§7).

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
   standalone build `[6a-R6]`), the PATCHES rows, the must-not-touch list's paths updated to
   `phone-core/…/PhoneSppPairing*.kt` and `glasses-core/…/AuthenticatedSppServer.kt`, and the
   CI changes of §6.1 (`.github/workflows/tests.yml`, `.github/workflows/upstream-validation.yml`,
   `.github/suite-baselines/`), which the controller allowed T2 to make.

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
baseline, so every identity is still there and still passes; CI enforces it (§6.1). Bodies change only
where the subject's shape changed:

- `SppIngressTest` (reflects `binder`, `registrations`, `routeRemote` on `BusHubService`) stays
  in `:phone-hub`, still builds the service with Robolectric, and reflects on its `core`. (In
  `:phone-core`, Robolectric's package would be the namespace `com.anezium.rokidbus.phone.core`,
  not the app id; Service-built tests therefore stay in the shell.)
- `HubCommandSecurityTest` (reflects `startupBlockedByBluetoothPermission`, `hubEnabled`,
  `sppLoopStarted`, `coreRemoteBridge`, `speechMicrophoneForegroundRequested`) stays in
  `:phone-hub`; the fields that moved are read through the shell's `core`.
- `SppPairingStatusTest` stays (it tests `statusText`) and sets the state through the core's
  `sppKeyStatus` field, which `sppKeyState()` maps.
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
  `Cancelled` / `CancellationException` and no upload; after step 8 the CXR result wins.

**Contract tests for the revised rules** (all in `:phone-core`, against `HubCore` with
`FakeCxrTransport`; each name is a test method):

| Contract | Tests |
|---|---|
| Enabled gate (§3.1.1) | `stop_turns_the_gate_off_before_releasing_the_radios` (a handshake in flight at `3853` aborts; no key offer after `stop`); `start_after_stop_reenables_the_same_spp_loop`; `close_ends_the_spp_loop_and_is_terminal`; `shell_reads_the_gate_and_never_writes_it` (`:phone-hub`) |
| Revocation order (§3.5.3) | `revoke_runs_shell_hook_then_core_clears_then_removes_registrations`; `authorization_changed_notifies_link_state_after_shell_side_effects`; `registration_removed_hook_runs_last_with_owner_still_connected` |
| Hook threads and locks (§3.5.1) | `hooks_run_on_their_documented_threads`; `hooks_run_without_core_locks_and_may_reenter_routing` (a hook that calls `sendRemote`/`deliverLocal` from inside `onRemote`, `onLinkState` and `onRegistrationRemoved` completes) |
| Surface threading (§1) | `confined_call_off_main_throws`; `callbacks_are_posted_never_reentrant`; `cancellation_calls_from_a_background_thread_run_on_main_in_order` |
| Speech runs (§3.2.2) | `stop_before_acceptance_latches_and_stops_on_accept` (one `onStopped(CANCELLED)`, no `onStarted`, a stop frame right after the accept); `stop_before_acceptance_then_denial_is_swallowed`; `stop_from_background_thread_is_serialized_on_main`; `stop_after_end_is_a_noop`; `second_start_while_latched_is_not_available`; `late_callback_of_an_old_run_never_reaches_a_new_run` |
| Attach, detach, restart (§3.2.1) | `attach_posts_initial_state_and_device_info`; `detach_drops_already_queued_callbacks`; `detach_ends_speech_tts_notice_and_surface`; `open_while_detached_is_hidden_at_once`; `stop_reports_cancelled_and_stopped_never_error`; `restart_recreates_the_client_and_keeps_the_listener`; `old_epoch_callbacks_are_dropped_after_restart` |
| CXR app slot (§3.6.1) | `coroutine_cancel_after_dispatch_keeps_slot_and_copy_until_answer`; `link_loss_after_dispatch_releases_slot_and_deletes_copy`; `stale_callback_of_a_released_dispatch_is_dropped`; `query_launch_and_third_party_upload_share_the_slot_fifo`; `third_party_upload_busy_returns_false`; `exception_before_dispatch_releases_slot_and_deletes_copy`; `progress_is_inline_monotonic_and_never_after_return` |

### 6.1 CI

T2 changes both workflows (controller ruling on Finding 5):

- `.github/workflows/tests.yml:70-81` adds `:phone-core:testDebugUnitTest` and
  `:glasses-core:testDebugUnitTest` to "Run the product unit tests".
- `.github/workflows/upstream-validation.yml:56-66` adds the same two tasks to the standalone
  `vendor/nexus` run, which finds them through the `include`s of commit 4.
- **Union parity**, a new step after the tests in both workflows: an inline script collects the
  JUnit XML of `phone-hub`, `phone-core`, `glasses-hub` and `glasses-core`
  (`build/test-results/testDebugUnitTest/*.xml`), maps it to `group|class#method|outcome` with
  `group` = `phone` for phone-hub ∪ phone-core and `glasses` for glasses-hub ∪ glasses-core, and
  compares it with `.github/suite-baselines/hubs.txt`, recorded from the pre-split run at
  `548576f4`. It fails if a baseline identity is missing or changed outcome, or if a new
  identity does not pass. Only the 2 recorded `GlassesFileStoreTest` failures may differ, by
  name.
- **SPP files unchanged**, a step in both workflows: `git hash-object` of
  `vendor/nexus/phone-core/…/PhoneSppPairing.kt`, `…/PhoneSppPairingStorage.kt` and
  `vendor/nexus/glasses-core/…/AuthenticatedSppServer.kt` must equal the blob ids of the
  upstream files at `15cd98ad`, recorded beside the baseline (R204).

Green in both the root build and the standalone `vendor/nexus` build `[6a-R6]`.

---

## 7. Rulings and remaining open points

The controller settled the earlier alternatives:

- **R203.** The public `NexusPluginClient.createWithTransport` factory in `:bus-client` is
  allowed, as a recorded PATCHES.md patch (commit 1, §5), and preferred over an in-app
  `ACTION_HUB` service. The fallback is withdrawn.
- **R204.** `HubCore.kt` stays at least 50 % similar to `BusHubService.kt`, so rename
  tracking holds (§5); the implementer checks `git diff -M --stat` before each commit. The SPP
  files move byte-identically, enforced in CI (§6.1), and commits 2 and 3 are `yes` rows with
  the security review linked.
- **R205.** `installedVersion()` uses the `versionName` convention, `major * 10000 + minor *
  100 + patch` (§3.6). T12 makes `:glasses-app` follow it.
- **Finding 5.** T2 updates `tests.yml` and `upstream-validation.yml` to run both core suites
  with the union-parity check (§6.1).

Still open:

1. **A CXR call that never answers holds the slot** until the link drops or the core stops,
   as upstream does today for the YouTube upload (§3.6.1). No timeout is added in T2.
2. **`close()` is one member beyond the brief's `HubCore` list** (§3.1.1), because a Service's
   `onDestroy` needs a terminal call that the restartable `stop()` cannot be.
