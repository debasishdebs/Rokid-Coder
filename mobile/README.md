# Rokid Coder on your phone

The phone app is the middle of Rokid Coder: it links your computer to your glasses, shows your settings and plays the alert sounds. It needs Android 11 or later and the Hi Rokid app that came with your glasses.

## Install

1. Download `rokid-coder-1.0.0.apk` from <https://github.com/debasishdebs/Rokid-Coder/releases/latest> on the phone. Android asks you to allow installs from your browser or file manager once; allow it, then open the file.
2. Open Rokid Coder. It starts a guided setup and resumes where you left off if you close it:
   - **Permissions.** Each one is explained, and setup continues if you say no (it then shows where to change your mind).
   - **Glasses app.** The glasses app is inside this phone app. Setup checks it and installs it on your glasses over the Rokid link, with no computer and no adb. See [`../glasses/README.md`](../glasses/README.md).
   - **Computer.** Setup asks which of Claude Code and Codex you use, then shows the download link and the install steps for macOS or Windows, then waits for the computer.
   - **Pairing.** Setup asks "Does your computer show …?" with a code. If the same code is on your computer, tap Codes match. Nothing pairs without that confirmation.
   - **Test alert and sounds.** You see and hear a test alert on the glasses, and pick a sound for each alert type.
3. Tailscale is optional, for using Rokid Coder away from home. Settings, Connectors, Tailscale has the two steps.

## If Rokid Nexus is installed

Rokid Coder and the upstream Rokid Nexus app both want the one link to your glasses, and only one can hold it. If Nexus is installed, setup shows: "Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry." Setup goes on once Rokid Coder's own connection to the glasses works. Nexus being installed is a warning, not a block.

## Privacy

Settings, About shows the version and the privacy note, which is [`../PRIVACY.md`](../PRIVACY.md).

<!-- RECHECK-6C: the file name `rokid-coder-1.0.0.apk` and the onboarding step names follow the release asset list and T5. Confirm against the final release assets. -->

## Building

The phone side of Rokid-Coder, built by the root Gradle build.

- `app/`: the one phone app, module `:mobile:app`. It runs the Agents code in-process on
  the phone core (`:phone-core`) through `GlassesSurface`. See `app/README.md`.
  `./gradlew :mobile:app:checkRelease` runs its release manifest, dex and dependency checks.
- `caller-test/`: an unrelated app signed with its own test key, module `:mobile:caller-test`.
  Its instrumented test proves it can neither bind nor start any service of the phone app:
  `./gradlew :mobile:app:installDebug :mobile:caller-test:connectedDebugAndroidTest` on an
  emulator (`.github/workflows/emulator.yml`).
