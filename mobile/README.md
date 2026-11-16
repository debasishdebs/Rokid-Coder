# Rokid Coder on your phone

The phone app is the middle of Rokid Coder: it links your computer to your glasses, shows your settings and plays the alert sounds. It needs Android 11 or later and the Hi Rokid app that came with your glasses.

## Install

1. Download `rokid-coder-1.0.0.apk` from <https://github.com/debasishdebs/Rokid-Coder/releases/latest> on the phone. Android asks you to allow installs from your browser or file manager once; allow it, then open the file.
2. Open Rokid Coder. It starts a guided setup and resumes where you left off if you close it:
   - **Welcome.** Tap Start.
   - **Permissions.** Nearby devices, Microphone, Notifications and Battery, each explained before Android asks. Setup continues if you say no ("Some features are off. You can grant them now or later in Settings.").
   - **Connect your glasses.** Rokid Coder links to your glasses through the Hi Rokid app and asks you to allow that once. Then it checks the glasses app, which is inside this phone app, and installs or updates it on your glasses over the Rokid link, with no computer and no adb. See [`../glasses/README.md`](../glasses/README.md).
   - **Which do you use?** Claude Code, Codex, Both or Neither. It picks the wording of the next screen and the provider of the test alert.
   - **Finish on your computer.** The download link (Copy or Share it), a macOS or Windows switch with that installer's first-run hint, and **Ready to pair**, which opens a two-minute window while you run the installer. Below it, it also offers **Scan the QR code on your computer**. The phone asks for the camera only when you tap it, and only to read that code; if you say no, paste the pairing line instead.
   - **Pairing.** Setup asks "Does your computer show 123 456?" with a code. If the same code is on your computer, tap **Codes match**. Nothing pairs without that confirmation.
   - **Test alert.** You see and hear a test alert on the glasses, then answer "I saw it" or "I didn't see it". "Send again" sends it once more.
   - **Sounds.** Pick what the glasses do for each kind of alert, then Finish. Tapping Speak or Chime plays a preview on this phone.
3. Tailscale is optional, for using Rokid Coder away from home. Settings, Connectors, Tailscale has the two steps.

## If Rokid Nexus is installed

Rokid Coder and the upstream Rokid Nexus app both want the one link to your glasses, and only one can hold it. If Nexus is installed, setup shows: "Rokid Nexus is installed. Open it and tap Stop hub (or force-stop or uninstall it), then tap Retry." Setup goes on once Rokid Coder's own connection to the glasses works. Nexus being installed is a warning, not a block.

## Privacy

Settings, About shows the version and the privacy note, which is [`../PRIVACY.md`](../PRIVACY.md).

## Building

The phone side of Rokid-Coder, built by the root Gradle build.

- `app/`: the one phone app, module `:mobile:app`. It runs the Agents code in-process on
  the phone core (`:phone-core`) through `GlassesSurface`. See `app/README.md`.
  `./gradlew :mobile:app:checkRelease` runs its release manifest, dex and dependency checks.
  Its release build is signed by the `rokid.release-signing` build-logic plugin (`NEXUS_RELEASE_*`, pinned to
  `rokid.releaseSignerSha256`; see `../glasses/README.md`), and an unsigned release fails.
- `caller-test/`: an unrelated app signed with its own test key, module `:mobile:caller-test`.
  Its instrumented test proves it can neither bind nor start any service of the phone app:
  `./gradlew :mobile:app:installDebug :mobile:caller-test:connectedDebugAndroidTest` on an
  emulator (`.github/workflows/emulator.yml`).
