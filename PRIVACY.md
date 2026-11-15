# Rokid Coder privacy note

Rokid Coder has no hosted backend or telemetry, runs no servers in the cloud, and collects nothing.

There is no Rokid Coder account, no backend and no usage reporting. The app on your phone, the helper on your computer and the app on your glasses talk only to each other.

## What leaves your devices

Data leaves your devices only through services you already use:

- The Claude/Anthropic and Codex/OpenAI command-line tools you run on your computer.
- Your Android speech engine, which may be online.
- Tailscale, if you choose it.

The 1.0 app has no cloud speech engines and no analytics. On your computer, the agentd helper listens on a loopback port for the hooks of the sessions you attach and on a LAN TLS port for your phone, and it keeps its state in local files; the app keeps its state in its own storage on your phone. TLS protects the application sessions between your phone and your computer. Two things are not TLS: plaintext UDP discovery, which carries no secrets, and the loopback HTTP hooks, which never leave your computer.

In more detail:

- **The command-line tools.** Claude Code and Codex send your prompts and their answers to Anthropic and OpenAI under your own accounts and those companies' terms. Rokid Coder only watches the sessions you attach with `/rokid:on`, and it shows what they ask on your glasses.
- **Speech.** Push-to-talk replies and spoken alert cues use the speech recognition and text-to-speech engines that come with your Android phone. Depending on the engine you have set, the phone's maker or Google may process the audio online. Rokid Coder does not choose a cloud engine for you and does not send audio anywhere itself.
- **Tailscale.** If you install Tailscale, your phone and computer reach each other over your own tailnet. Tailscale's own terms cover that traffic.

## What stays on your devices

- Pairing keys, the pinned certificates of your computers, your settings and the alert history stay on the phone and the computer they belong to. The application sessions between your computer and your phone use pinned, mutually authenticated TLS, and every new pairing is confirmed with a code you compare on the phone.
- Rokid Coder asks the phone for the microphone (push-to-talk), notifications (the one status notification), and a battery exemption (so Android keeps the monitor running).
- Removing the app, or running the computer uninstaller, removes what Rokid Coder stored. The uninstaller keeps your pairing state unless you ask it to purge.

## Questions

Open an issue at https://github.com/debasishdebs/Rokid-Coder/issues.
