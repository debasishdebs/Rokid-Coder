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
- Status: **ready for the user's final read and approval.**
