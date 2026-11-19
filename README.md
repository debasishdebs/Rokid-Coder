# Rokid-Coder

Rokid-Coder puts your Claude Code and Codex sessions on your Rokid glasses. When your agent needs a yes or no, has a question, or finishes a job, you see it on the glasses and answer from there. You do not have to go back to your computer.

## What you need

- Rokid glasses with a display, and the Hi Rokid app that came with them.
- An Android phone (Android 11 or later).
- A Mac (macOS 13 or later) or a Windows 11 PC (22H2 or later, with WSL 2, which the installer checks for you).
- Claude Code and/or Codex on that computer. If you do not have one yet, the computer setup offers to install it, and you can skip that.
- Your phone and computer on the same Wi-Fi, or both on Tailscale.

## How it works

- The glasses show what your agent is doing.
- You answer approvals, questions and follow-ups from the glasses, by touch or by voice.
- The phone is the bridge between the glasses and the computer.
- A small helper on the computer talks to Claude Code or Codex.

## Install in 4 steps

1. **Download.** Open the [Releases page](https://github.com/debasishdebs/Rokid-Coder/releases) and download two files: the phone app (`rokid-coder-<version>.apk`) and the installer for your computer (a `.dmg` for a Mac, an `.exe` for Windows). Pick `arm64` for a Mac with Apple silicon and `x64` for an Intel Mac.
2. **Install the phone app.** Open the file on your phone. Android asks you once to allow installs from your browser or file manager. Then open Rokid Coder and follow its setup: it asks for a few permissions, links to your glasses through the Hi Rokid app, and installs the glasses app on your glasses for you. When it is done, open Rokid Coder on the glasses and switch it on in the accessibility list. It sets itself up, which takes one to two minutes.
3. **Install the computer helper.** Run the installer you downloaded. It is not signed yet, so your computer warns you the first time.
   - Mac: right-click the `.pkg` inside the disk image, choose Open, then Open again.
   - Windows: click More info, then Run anyway.

   Setup then runs in a window. It also adds the Rokid plugin to each of Claude Code and Codex that it finds.
4. **Pair.** In the phone app, go to Finish on your computer and tap Ready to pair. At the end of the computer setup, the computer shows a 6-digit code, and the phone app asks whether your computer shows the same one. If the codes match, type `y` on the computer and tap Codes match on the phone. Nothing pairs until you confirm on both.

To put a session on the glasses, type `/rokid:on` inside Claude Code (`rokid:on` inside Codex). You can also start Claude Code with `rk claude` instead of `claude`. On Windows, use `/rokid:on` for now.

## What you can do from the glasses

- See progress, and see when your agent is done.
- Allow or deny a permission request.
- Answer your agent's questions. Each question gets its own card.
- Reply by voice to a session that is waiting for you.
- Change a session's approval mode.
- If you started the session with `rk claude`, also compact it, change its model, and send a voice follow-up at any time.
- Choose what the glasses do for each kind of alert: speak, or chime.

## If something goes wrong

- **The glasses link is lost** (the phone says "Glasses not connected"). Check that the glasses are on and connected in Hi Rokid. Then open the phone app, go to Settings, then Glasses app. It shows the state of the glasses app and lets you reinstall it.
- **A reply does not go through.** If you see "Claude is busy with something else, wait a moment and try again", Claude was busy. Wait a moment and try again.
- **The phone cannot find the computer.** Make sure both are on the same Wi-Fi. If they still do not connect, use Scan the QR code on your computer in the phone app.
- **You are away from home.** Install Tailscale on the phone and on the computer, and sign in to the same account on both. The phone app has the steps under Settings, then Connectors, then Tailscale. You do not need to pair again.
- **It stops working when the phone screen is off.** Allow the battery permission when the phone app asks (Android otherwise may pause it).
- **The phone app says Rokid Nexus is installed.** Only one app can hold the link to your glasses. Open Rokid Nexus, tap Stop hub, then tap Retry.
- **The glasses setup stalls.** The setup card on the glasses offers a retry and shows a short code you can quote when you ask for help.

More fixes for developers are in [docs/INSTALL.md](docs/INSTALL.md).

## Your data

Rokid-Coder has no cloud server and no account, and it collects nothing. Your phone and your computer talk to each other directly, over a link that checks each side's certificate. Your agent's own tools, your phone's speech engine and Tailscale (if you use it) work under their own terms. The details are in [PRIVACY.md](PRIVACY.md).

## Status

Rokid-Coder is a release candidate for version 1.0, not a final release. Windows support is new and is still being tested. The installers are not signed yet, which is why your computer warns you. Rokid-Coder is not affiliated with Rokid, Anthropic or OpenAI. It is built on the open-source [Rokid Nexus](https://github.com/Anezium/Rokid-Nexus) by Anezium.

## For developers

Building from source, installing with adb, running the tests, CI and the upstream sync are in [docs/INSTALL.md](docs/INSTALL.md). Each part has its own guide: [computer](computer/README.md), [plugins](plugin/README.md), [phone](mobile/README.md) and [glasses](glasses/README.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
