# Rokid-Coder 1.0 — Product Design (Plan 6)

**Status:** draft for the user's review, 2026-11-15. It builds on `2026-11-14-rokid-coder-design.md` and the user decisions U1–U31 in `docs/coding-agent/HANDOFF.md`. **[user]** marks the user's decisions; **[call]** marks my calls, which the user can overrule.

## 1. Intent
Turn the working 0.8.0 into a product that anyone can install and set up without reading docs. 1.0.0 ships as downloadable installers (GitHub Releases) **[user U27]**. The Play Store comes after 1.0, but 1.0 must already be built so that Play can accept it later **[user]**.

## 2. Who and the first ten minutes **[user U26]**
Anyone with Rokid glasses and a computer (macOS or Windows **[user U28]**). They may use Claude Code, Codex, both, or neither.

1. Install the phone app (APK).
2. Open it. A guided setup asks for the phone permissions, one screen each, saying why each is needed: Bluetooth/nearby devices, microphone, notifications, battery optimisation.
3. Connect the glasses. The app installs the glasses app onto the glasses over the Rokid link, so no PC or adb is needed.
4. Computer setup.
   - A checklist asks "Which do you use? Claude Code / Codex / both / neither".
   - The screen then says "Finish on your computer" and shows one download link or command for the user's OS.
5. On the computer, run the installer. It installs `agentd`, `rk` and the Claude/Codex plugins for the tools the user has.
   - With neither tool, `rk claude` / `rk codex` offer to install it, using the vendor's official installer and only after the user confirms **[user]**.
   - It then pairs. The phone has opened its pairing window automatically at step 4 **[call]**.
6. The phone's setup screen gets the "laptop done" signal the moment the encrypted link comes up **[user]**. It continues with the steps left: a test alert on the glasses, and the sound settings.
7. Done. The glasses board shows the user's sessions.

Every screen and every CLI step says what to do next (U5).

## 3. What 1.0 contains (the "done" definition) **[call, from the decisions so far]**
1. **One phone app** **[user U31]**: our shell + Agents code + the embedded Nexus phone-hub core.
   - It exposes no plugin host to other apps.
   - Removed: the plugin store, the self-updater, Patcher, Wireless ADB and every other plugin.
   - Removed: `REQUEST_INSTALL_PACKAGES`, apart from what the glasses install needs (see §6).
   - `usesCleartextTraffic` is off.
2. **The glasses app** (Nexus glasses hub, our build and signer), installed from the phone app.
3. **The computer side, as installers:**
   - macOS `.pkg`
   - Windows `.exe` (plugin mode in 1.0; launcher mode in 1.0 if Windows testing allows, otherwise 1.1 at the latest **[user U28]**)
   - Each one installs `agentd` + `rk`, starts it at login (LaunchAgent / Task Scheduler) and installs the Claude/Codex plugins.
4. **The onboarding flow in §2,** end to end, including the "laptop done" ping.
5. **The repo restructured** **[user U29/U30]** into `computer/`, `plugin/`, `mobile/`, `glasses/`, optional `common/` and `vendor/nexus/`.
   - Each top-level folder has its own README with only its install steps.
   - Upstream Nexus is a git subtree in `vendor/nexus/` with `PATCHES.md`. A weekly upstream-sync Action runs all suites and opens a PR.
6. **Our identity:**
   - Application ids `io.github.debasishdebs.rokidcoder` (phone) and `io.github.debasishdebs.rokidcoder.glasses` **[call]**. They can't keep `com.anezium.*`.
   - Our own release signing key, kept out of the repo and in CI secrets. The phone app pins the glasses-app signer to that key.
7. **Versions 1.0.0 everywhere.** Android versionCode 10000, the same scheme as 0.8.0's 800.
8. **Release CI:** a tag `rokid-coder-v1.0.0` builds the signed APKs, the AAB (kept for Play later), the `.pkg` and the `.exe`, and publishes a GitHub Release. The test suites run on macOS and Windows runners.
9. **Verified on real hardware:** the device checklist passes on the user's glasses + phone, with one macOS and one Windows 11 computer. No open Critical or Important review findings.
10. **A privacy note** in the app and the repo: no data leaves the user's devices; there are no servers and no analytics. Play needs this later anyway.

## 4. Non-goals for 1.0
- Submitting to the Play Store, and its listing assets. The build is kept Play-compatible.
- Third-party plugins, and the Nexus store.
- Linux computers, and remote VMs (design §7 "later").
- Any server or account system.

## 5. Anti-goals
- A setup that needs the docs, adb or a terminal on the phone.
- Any unencrypted link, or any app other than ours able to drive the glasses through our app (U8, U31).
- A fork that can't take upstream Nexus fixes any more.

## 6. Constraints and known risks
- **Building the phone hub needs `Anezium/CxrGlobal` (v0.3.0)** next to the repo, as upstream CI does. It is public on GitHub. The glasses hub needs `com.rokid.cxr:cxr-service-bridge` from maven.rokid.com (a snapshot artifact).
- **Installing the glasses app** from the phone is Nexus's existing CXR push. For Play later, the glasses APK should ship inside the phone app, not be downloaded **[call]**.
- **Unsigned installers trigger warnings:** macOS Gatekeeper and Windows SmartScreen. Avoiding them needs an Apple Developer ID (notarisation) and a Windows code-signing certificate. See the open questions.
- **"Rokid" is a trademark.** For GitHub 1.0 the display name stays "Rokid Coder" **[call]**. Before Play, decide on a name such as "Coder for Rokid Glasses".
- **Anthropic terms:** we drive the user's own Claude Code CLI and never sign users in ourselves. Re-check before the Play listing (design §7).
- **Windows** is tested on the user's Windows 11 laptop and on GitHub Windows runners; there is no Windows machine on the build Mac.

## 7. Left to the builder
- The installer tooling: pkgbuild/productbuild; NSIS or WiX for Windows; whether Node is bundled or required.
- The exact layout of the onboarding screens, within the Material3 light theme (U2).
- How the excluded Nexus modules are cut at build level.
- Upstream-sync Action details.
- Slicing into plan tasks: parallel where files don't overlap (U15), one Codex review and one fix wave at the end.

## 8. Settled after the builder check
1. **How the computer pairs (step 5)** **[call]**:
   - **Primary, same Wi-Fi:** the phone opens its pairing window (built in Plans 3–4), `agentd` finds the phone by UDP discovery (8793) and dials it, and each side pins the other inside its own window. No code is typed and no secret is shown.
   - **Second, Tailscale:** the same flow across a tailnet.
   - **Fallback:** the installer's last screen shows a QR or pairing line, which the phone scans or pastes.
   - 1.0 assumes same Wi-Fi or Tailscale.
2. **Windows in 1.0** **[call, from U28]**:
   - Plugin mode on Windows is a 1.0 gate: `agentd`, the plugins, the `.exe`, autostart.
   - `rk` launcher mode on Windows is a 1.0 stretch and is required in 1.1.
   - The cutoff: if the Windows `rk` safety tests aren't green on the user's laptop when everything else is ready, 1.0 ships without it and the CLI says so on Windows.
3. **Node** **[call]**: the installers bundle their own Node runtime, so no Node is needed on the machine.
   - Architectures: macOS arm64 + x64 (two `.pkg`s, or one universal); Windows x64. Windows arm64 comes later.
   - node-pty prebuilds are produced for each architecture.
4. **Migration** **[user, U16]**: fresh install only. The new app id and key mean no in-place upgrade from 0.8.0, and none is needed.
5. **The glasses APK** **[call]** is built first and bundled inside the phone app. The phone pushes it over CXR. The builder confirms the exact permission the CXR push needs and keeps only that; everything else that installs packages is removed.
6. **Build inputs** **[call]**:
   - `Anezium/CxrGlobal` is fetched in CI, pinned to a git SHA (v0.3.0's).
   - The `cxr-service-bridge` snapshot is pinned to its exact timestamped version and mirrored into a repo-local Maven folder, if its licence allows; otherwise only the version is pinned.
7. **The hardware gate:** the user runs it. The builder rewrites the device checklist for the merged single app before 1.0.
8. **Where the work lands** **[call]**: on `release/1.0.0`.
   - The restructure is the first task: one rename commit, then the `vendor/nexus` subtree added from the `upstream` remote (Anezium/Rokid-Nexus `main`), not from our `main`.
9. **The macOS artifact** **[call]**: a `.pkg` (it installs the LaunchAgent), delivered inside a `.dmg` for download.

## 9. User answers after the builder check (2026-11-15)
- **U32: ship unsigned installers for 1.0.**
  - The download page and the phone's "Finish on your computer" screen show the one-time step: "right-click → Open" on macOS, "More info → Run anyway" on Windows.
  - Signing (an Apple Developer ID, and Azure Trusted Signing or a certificate for Windows) comes before a wider launch.
- **U33: the Windows split in 8.2 is accepted.**
- **U34: WSL is a prerequisite on Windows.**
  - What this means for the build is decided in the Windows session on the user's laptop. Questions to settle there:
    - Does `agentd` run inside WSL beside the Claude Code and Codex CLIs, or on the Windows host?
    - How do hooks reach it? WSL2 localhost forwarding, or "mirrored" networking.
    - How does the phone's discovery (UDP 8793) and TLS dial-in reach a WSL2 instance? Mirrored networking, or a port proxy.
    - What does the `.exe` install?
  - Preference **[call]**: run `agentd` where the CLIs run (inside WSL), with WSL mirrored networking, so the hooks and the launcher socket stay local. The `.exe` then checks for WSL and sets this up.
- Status: Codex READY (§10, §11). The user has confirmed every open point (§12: U35–U39). **Approved for planning.**

## 10. Revisions after the Codex design review (`docs/coding-agent/codex/reviews/2026-11-15-v1-design-review.md`)
These override §§3, 5, 6 and 8 where they differ. All are **[call]** unless marked otherwise.

**R1 (Critical #1): pairing proves the peer with a matching code.** Automatic discovery stays, but no pin grants anything until the user confirms the code on both screens.
- The code is 6 digits, the same idea as Bluetooth pairing: `SAS = first 6 decimal digits of SHA-256(phoneCertFp ‖ agentdCertFp ‖ windowNonce)`.
- Both devices compute and show it: the phone screen, and the installer/CLI.
- The user confirms "Codes match" on the phone and presses Enter on the computer. Only then are the pins committed and steering granted.
- **Mismatch or cancel:** both pins are discarded and the window closes.
- **Expiry:** the window lasts 2 minutes, as today.
- **Competing peers:** if a second candidate appears during the window, the attempt is aborted with "More than one device answered — try again". The first-to-answer is never trusted.
- **Fallback:** the QR/pairing line, scanned or pasted, carries both fingerprints, so it needs no code.
- Existing users who pair from the CLI keep `agentd pair`. Its fingerprint check becomes this same code.

**R2 (#2): one app, with a private in-process adapter instead of the plugin bus.**
- The Agents code stops extending `NexusPluginService`. A new internal interface (`GlassesSurface`: cards, notices, input, TTS/STT, wake, lifecycle) is implemented directly on the hub core, in the same process.
- There is no AIDL, no external discovery, no plugin grant, and no other app can bind.
- The existing `AgentsPluginService` behaviour is kept by putting it behind that interface. Its tests then run against a fake `GlassesSurface`.

**R3 (#3): removal by product variant, proved by inspection.**
- `phone-hub` is split into a library (the core: the CXR link, speech, rendering) and the upstream app shell. Our `mobile/` app depends only on the library.
- The store, updater, Patcher entry, plugin discovery and `BusHubService` export stay in the upstream shell and are absent from our APK.
- Release gates:
  - A CI check on the merged release manifest: no exported services except our own, no `REQUEST_INSTALL_PACKAGES` unless R8 proves it is needed, no `<queries>` for the plugin action.
  - A test where an unrelated app tries to bind or start our services and is refused.

**R4 (#4, #5): the Windows architecture, settled for planning.**
- **Where agentd runs:** inside WSL2 (Ubuntu, the default distro), beside the Claude Code and Codex CLIs, which on Windows run in WSL (U34). So agentd and `rk` are the Linux build there: Unix sockets, node-pty on Linux, the same code as macOS.
- **Supported setup:** Windows 11 22H2+, WSL 2 with **mirrored networking**. The `.exe` checks both. If mirrored mode is off, it offers to turn it on (`.wslconfig` `networkingMode=mirrored`, then `wsl --shutdown`), after the user confirms.
- **Connection directions** (the same on every OS):

  | Link | Direction | Protocol and port |
  |---|---|---|
  | Discovery | agentd → LAN | UDP broadcast, 8793 |
  | PhoneLink | agentd → phone | TLS dial-out, phone's port 8792 |
  | wss | phone → agentd | TLS, agentd's 8792 |
  | Hooks | CLI → agentd | loopback HTTP, 8791 |

  - Mirrored mode lets the broadcast and the inbound 8792 reach WSL.
  - Windows Firewall needs one inbound rule for TCP 8792, which the `.exe` adds.
  - **Fallback when broadcast is blocked:** the QR/pairing line carries the phone's address, or Tailscale is used.
- **Tailscale:** the host's Tailscale is used, through mirrored networking. `tailnet-discovery` calls `tailscale.exe` through WSL interop, falling back to `tailscale` in WSL.
- **State** lives in the WSL home (`~/.rokid-coder`). **Login start:** a Windows Task Scheduler entry runs `wsl -d <distro> -- agentd run` at logon.
- **What the `.exe` installs:** it checks WSL, installs the Linux agentd bundle into the distro, sets the networking, firewall rule and scheduled task, then runs plugin install and pairing inside WSL.
- **The older named-pipe/ConPTY items** in HANDOFF's Windows work list are superseded. They come back only if native Windows CLIs (outside WSL) are ever supported.
- Everything above is verified first thing in the Windows session. If mirrored mode fails on the user's laptop, the fallback design is a port proxy plus a firewall rule, decided there.

**R5 (#6): a runtime wrapper.**
- The installers ship a pinned Node (22 LTS) and install stable wrappers: `~/.rokid-coder/bin/agentd`, `rk`, and `rokid-node`.
- The hook commands in `plugins/*/hooks/hooks.json`, the LaunchAgent and the scheduled task call `rokid-node`, never bare `node`.
- node-pty prebuilds are matched to that Node ABI for each architecture.
- Gate: install on clean machines (no Node, no build tools), including a home path with spaces and non-ASCII characters.

**R6 (#7): a preservation map, and a parity gate before any feature work.**
- **Task 1 is the restructure alone.** It records the exact upstream SHA (the merge base with `upstream/main`, today `15cd98ad`) and adds `vendor/nexus` as a subtree of it.
- It re-applies our changes to the vendored hub modules as the numbered patches listed in `PATCHES.md`.
- It moves our code into `computer/`, `plugin/`, `mobile/` and `glasses/`, and fixes every relative path: the CxrGlobal path becomes `vendor/../CxrGlobal`, plus the Gradle includes and the CI paths.
- **Parity gate:** every suite passes with the same counts as `release/0.8.0`, and the APKs build, before Task 2 starts.

**R7 (#8): a bundled glasses APK, with verification kept.**
- The phone app ships `glasses.apk` plus `glasses.json` (package, versionCode, SHA-256, signer SHA-256) as assets.
- Before every push it runs the existing verification (package, version, digest, signer), then calls CXR.
- **States:**
  - Not installed: install.
  - Older version on the glasses: offer an update.
  - Same version: nothing to do.
  - Newer version on the glasses: leave it, with a warning.
  - A failed push is retried with a visible error.
- Application ids change. Kotlin class namespaces may stay (`com.anezium.rokidbus.*`). Every hard-coded package or component name (e.g. `BusHubService.kt:150,3978,4020`) is moved to one constants file.

**R8 (#9): Play is a separate decision.**
- 1.0 does not claim to be Play-compatible.
- The plan finds out whether the CXR install path needs `REQUEST_INSTALL_PACKAGES` on the phone. If it doesn't, the permission is removed. If it does, that is recorded as the Play blocker to solve before submission.

**R9 (#10): one foreground service in the merged app.**
- `connectedDevice` while the glasses are linked. `microphone` is added only while push-to-talk is active, started from a user action on the glasses (allowed as a foreground start).
- The `specialUse` agents service is folded in.
- **Boot:** the boot receiver starts only the `connectedDevice` service, never the microphone.
- **Denied permissions:** the matching feature is shown as off, with a "Grant" pointer.
- **User Stop:** a notification action stops everything until the app is opened again.
- **Battery:** the battery-exemption request stays, behind an explained setting.

**R10 (#11): "done" includes behaviour, not just packaging.** 1.0 is gated on the device checklist, rewritten for the single app. On real hardware, with Claude Code AND Codex, on macOS AND Windows (WSL), it must pass:
- attaching a session
- approvals and questions
- same-session replies
- alerts on the glasses within about 5 s
- DND and quiet
- disconnect and reconnect
- pairing expiry and revocation
- the launcher typing-safety rules
- installer upgrade (0.8.0 → 1.0 on the computer side) and uninstall
- onboarding recovery (killing the app halfway through, the computer offline, a code mismatch)

The full behaviour contract from the 2026-11-14 design §3 and §12 carries forward unchanged.

**R11 (#12): the privacy note tells the truth.**
- **Rokid-Coder runs no servers and collects nothing.**
- **Data leaves your devices only through the services you already use:**
  - the Claude/Anthropic and Codex/OpenAI CLIs
  - your Android speech engine, which may be online
  - Tailscale, if you choose it
- Nexus's bring-your-own-key cloud speech engines (`SpeechSettingsActivity.kt:271-279`) are excluded from the 1.0 app.

**R12 (#13): the transport anti-goal is scoped.**
- Pinned mutual TLS applies to all computer ↔ phone application traffic, on both paths.
- These exceptions stay:
  - loopback HTTP hooks (U9)
  - plaintext UDP discovery, which carries no secrets
- The phone ↔ glasses link is Rokid's CXR/Bluetooth link: it is paired and encrypted at the Bluetooth level, and we add nothing to it in 1.0.

## 11. Amendments after the Codex re-review (`2026-11-15-v1-design-rereview.md`)
**R1′ (replaces R1's code formula): commit-then-reveal comparison.** This is the same structure as Bluetooth numeric comparison and ZRTP SAS (RFC 6189 §4.4.1.1). It runs inside the already-established TLS session, whose two cert fingerprints are fixed by the handshake.
1. The computer picks a 256-bit nonce `Nc` and sends `C = SHA-256("rokid-sas-v1" ‖ Nc ‖ agentdFp ‖ phoneFp)`.
2. Only after receiving C does the phone send its own 256-bit nonce `Np`.
3. The computer reveals `Nc`. The phone checks it against C and aborts on mismatch.
4. Both compute `SAS = decimal(first 20 bits of SHA-256("rokid-sas-v1" ‖ Nc ‖ Np ‖ agentdFp ‖ phoneFp)) mod 10^6`, shown as 6 digits. The user confirms on both sides.

Rules:
- One attempt per pairing window. A second commitment or nonce in the same window aborts the attempt. There is no retry inside a window.
- The pins are committed only after both confirmations. Steering is granted only after that.
- An intermediary must commit before it sees `Np`, so it gets one 1-in-10^6 guess per user-visible attempt and can't search offline.
- The QR/pairing-line fallback binds both fingerprints directly, so it needs no code.
- The protocol and its tests are reviewed by Codex as their own task.

**R6′ (adds to R6): build ownership.**
- **One Gradle build at the repo root.** `settings.gradle.kts` includes:
  - `:vendor:nexus:shared`, `:vendor:nexus:bus-client`, `:vendor:nexus:ink-engine`
  - `:vendor:nexus:phone-core`, the library split out of upstream `phone-hub`
  - `:vendor:nexus:glasses-hub`
  - `:mobile:app` and `:glasses:app`
- The upstream `phone-hub` app shell stays in `vendor/nexus` but is not included in our build.
- `plugins/agents`' separate Gradle root is retired; its code moves into `:mobile:app`.
- **The computer side** is one npm workspace: `computer/` (agentd + rk), plus `plugin/claude-code` and `plugin/codex`, whose `bin/` copies come from `computer/` at build time, as today.
- **CxrGlobal stays a sibling checkout of the repo root**, `<repoRoot>/../CxrGlobal`, pinned at v0.3.0's SHA. `settings.gradle.kts` sets `cxrGlobalDirectory = rootDir.parentFile.resolve("CxrGlobal")` explicitly, so the move into `vendor/` doesn't change it.

**R9′ (replaces R9's microphone line): the microphone works only where Android allows it.**
- The merged foreground service declares `connectedDevice|microphone`. It starts with the microphone type only while the app is in the foreground: after onboarding, whenever the user opens the app, and on tapping the notification.
- Once it was started that way, the "while in use" access persists while the service runs, so later push-to-talk from the glasses works.
- **After a reboot** the boot receiver starts `connectedDevice` only. Voice shows as "Open Rokid Coder once to turn on voice", on the glasses and in the notification, until the user opens the app.
- **Failure handling:** upstream's existing promotion and failure handling (`BusHubService.kt:4893-4945`) is kept as is. A failed promotion shows that same pointer, never a silent failure.

**R12′ (adds to R12): hub link protection is kept.**
- On top of Bluetooth encryption, the phone ↔ glasses link keeps Nexus's application-level `SppAuthProtocol`, authenticated enrollment and frame replay protection, all unchanged (`BusHubService.kt:3865`, `AuthenticatedSppServer.kt:120`).
- They are listed in `PATCHES.md` as "must not be touched" areas.

## 12. User answers on the revised design (2026-11-15)
- **U35: commit-then-reveal code pairing (R1′) approved** ("love it").
- **U36: the private internal interface (R2) is confirmed.**
  - The upstream "Nexus Store" (the in-app downloader and installer for third-party glasses plugins, from Anezium's registry) is not in our app.
- **U37: a prerequisite check is added to both installers.** It runs before anything is installed:
  - **macOS:** the OS version, and Claude Code and/or Codex present (offering the official install).
  - **Windows:** Windows 11 22H2+, WSL2 plus a distro, mirrored networking (offering to enable it), the TCP 8792 firewall rule, and Claude Code/Codex inside WSL (offering to install).
  - **Both:** the phone reachable on the same Wi-Fi.
  - Each failure shows a one-line fix (a command or link), then re-checks. Install continues only when everything passes, or when the user skips an item marked optional.
- **Tailscale** (an encrypted mesh VPN for reaching your devices from other networks): kept **optional, never a prerequisite** **[call, pending the user's confirmation]**. Onboarding offers it only if Wi-Fi pairing fails, or behind a "use it away from home" link.
- **U38: Tailscale is an optional "connector", configured from the phone app.**
  - Settings → Connectors → Tailscale shows "Not installed", "Installed, not signed in" or "Connected". Detection uses the `com.tailscale.ipn` package query the manifest already has.
  - Guided steps: "Get Tailscale" (its Play Store page), then "Sign in with the same account on your computer".
  - It is offered only when Wi-Fi pairing fails, or behind a "Use it away from home" link.
  - The computer installer's prerequisite check lists Tailscale as optional, with an install link.
  - Not built: embedding Tailscale (tsnet/libtailscale/Headscale), our own relay, port forwarding. These are post-1.0 decisions.
- **U39: Nexus is not a connector (user confirmed).**
  - It is the embedded core: the glasses link, rendering and speech, behind the private `GlassesSurface` interface.
  - Making it optional or external would bring back the two-app friction and the open plugin host (U31).
  - **Coexistence:** onboarding detects an installed upstream Rokid Nexus app (`com.anezium.rokidbus.phone`). Both can't hold the glasses link, so the app says "Rokid Nexus is installed — close or uninstall it so Rokid Coder can connect to your glasses".
