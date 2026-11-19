<!-- Draft for the 1.0.0 publish. Before publishing, tick "Shipped" against the 1.0 device checklist: anything that has not run on real hardware moves to "Awaiting the hardware check". -->

# Rokid Coder: Roadmap

There are no dates. Items are ordered by the problem they solve. Nothing is listed as shipped until it has run on real hardware. What each release changed is in its [release notes](https://github.com/debasishdebs/Rokid-Coder/releases).

Every release has one headline feature. Patch releases carry fixes only. Each release says which side to update: the phone app (it updates the glasses app over the Rokid link), the computer helper, or both together.

---

## Shipped

### The 1.0 release candidates, on a Mac, an Android phone and Rokid glasses

- **Setup from the phone.** The phone app installs the glasses app over the Rokid link, with no computer and no adb. The glasses then set themselves up.
- **Pairing you confirm.** Every new pairing between the phone and a computer shows a 6-digit code on both screens, and nothing pairs until both sides confirm. After that, the phone and the computer talk only over pinned, mutually authenticated TLS.
- **Your existing Claude Code session on the glasses.** A session started with `rk claude` appears on the glasses with its progress.

### Awaiting the hardware check

These are in the 1.0 release candidates but have not yet run reliably on real hardware:

- replying by voice: a spoken reply is typed into the session when Claude is idle, after the launcher checks Claude's screen and never over text you left at the laptop (it has worked on a real session, and is being fixed for layouts with a panel of background agents)
- the Windows installer (inside WSL 2)
- macOS 13
- replies while background subagents run
- the automatic glasses-link repair
- Codex sessions on the glasses

---

## Known limitations

Rokid Coder 1.0 ships with these limits. Each one is on the roadmap below.

- **The glasses link is shared.** Only one app at a time can hold the phone's link to the glasses. When you tap to reply by voice and the link is gone, Rokid Coder takes it back. If another app was using it at that moment, for example while glasses media syncs to the phone or a file transfer runs, that operation can be interrupted.
- **Replies depend on reading Claude's screen.** Claude Code has no interface that says what is in its prompt box, so the launcher reads the terminal screen before it types. A Claude Code update that changes the screen can stop replies until Rokid Coder is updated. When the launcher is unsure, it refuses and types nothing.
- **Several computers can be paired, but the phone follows at most two at a time:**
  - one that the phone dials (the computer paired last)
  - one that dials the phone

  A second computer that dials in replaces the first.
- **Plugin mode does less than launcher mode.** With `/rokid:on`, voice replies work only while the session waits, and compact and model change need `rk claude`.
- **On Windows,** `rk claude` and `rk codex` print a hint to use plugin mode until the launcher has been checked there. Automatic discovery needs WSL mirrored networking; otherwise pair with the QR code or Tailscale.
- **The installers are not signed yet,** so macOS and Windows warn on the first launch.
- **A Claude Code session started from the phone** runs once, with no approvals or follow-ups.
- **Away from home** needs Tailscale on the phone and the computer.
- **Android only** for the phone. The phone app needs Android 11 or later.

---

## Next

Planned, in this order. Each line is one release. This is an order of problems to solve, not a promise of dates.

### Toward 2.0

| Release | What it solves |
|---|---|
| 1.1.0 | **Link guard.** Leave the glasses link alone while Rokid's own apps use it, and say "link busy" instead of failing. |
| 1.2.0 | **Screen-reading self-check.** Check the launcher against your installed Claude Code after every Claude update, and turn replies off clearly if it no longer reads the screen. |
| 1.3.0 | **Stop.** Stop a running turn from the glasses. |
| 1.4.0 | **Confirm before sending.** See what was heard, then send, redo or cancel. |
| 1.5.0 | **The launcher on Windows.** `rk claude` and `rk codex` inside WSL. |
| 1.6.0 | **Phone notifications.** Allow or deny from the phone when the glasses are off. |
| 1.7.0 | **Usage.** Context, tokens and rate limits on the board. |
| 1.8.0 | **Signed installers.** No first-launch warning; build provenance for every file. |
| 1.9.0 | **Linux.** A native install for Linux computers. |
| 1.10.0 | **Report a problem.** A redacted diagnostics bundle you attach to an issue. |
| 1.11.0 | **Update check.** Opt in to hear about new versions. |
| 1.12.0 – 1.15.0 | **Rokid Nexus 2.x.** The upstream glasses platform, brought in step by step. |
| 1.16.0 | **History.** Page back through a session and hear it read. |
| 1.17.0 | **Many alerts.** Swipe through the alerts waiting behind the current one. |
| 1.18.0 | **Queued instructions.** Say it while the agent is busy; it is sent when it is free. |
| 1.19.0 | **Slash commands.** Your own commands, from the glasses. |
| 1.20.0 | **A careful yes.** A second gesture before approving a risky command. |
| 1.21.0 | **Real sessions from the phone.** Claude Code started from the phone gets approvals and follow-ups. |
| 1.22.0 | **Take it back at the desk.** `rk attach` continues a phone-started session in your terminal. |
| 1.23.0 | **Start Claude from the glasses.** Dictate the first prompt. |
| 1.24.0 | **Show it.** Photos, files and text from the phone into a session. |
| 1.25.0 | **Chinese and Japanese.** |
| 1.26.0 | **Voice language.** |
| 1.27.0 | **Accessibility.** Every card read aloud, high contrast, large text. |
| 1.28.0 | **Battery.** Measured, then reduced. |
| 1.29.0 – 1.31.0 | **More agents.** One adapter for every agent, then Gemini CLI, then OpenCode. |
| 1.32.0 – 1.33.0 | **Your own relay.** A self-hostable relay that carries only encrypted traffic, next to Tailscale. |
| **2.0.0** | **Protocol v3.** Phone and computer agree on what each supports, and pairings work over any path. Everyone re-pairs once. |

### Toward 3.0: many computers, many accounts

| Release | What it solves |
|---|---|
| 2.1.0 | **Play Store.** |
| 2.2.0 | **Which computer.** Every row and alert names its computer. |
| 2.3.0 | **All connected.** Every paired computer stays connected at once. |
| 2.4.0 | **Profiles.** Personal, Office or your own, each with a colour and a glyph. |
| 2.5.0 | **Account label.** Which Claude account a computer uses, from its non-secret profile name, or your own label. |
| 2.6.0 | **The board by profile.** Grouped, with a needs-you count for each profile. |
| 2.7.0 | **Office privacy.** Approvals for a work profile show no command text on the glasses. |
| 2.8.0 | **Focus.** Only one profile alerts. |
| 2.9.0 | **Alert rules per profile.** Sounds, quiet hours and work hours. |
| 2.10.0 | **Profile defaults.** Which approval modes and voice replies a profile allows. |
| 2.11.0 | **Profile network.** Which paths a profile may use. |
| 2.12.0 | **Forget a profile.** Everything it holds goes at once. |
| 2.13.0 | **Many sessions.** Paging, mute, and finished sessions tidied away. |
| 2.14.0 – 2.15.0 | **Several accounts on one computer**, for Claude Code and then Codex. |
| 2.16.0 | **Find by voice.** |
| **3.0.0** | **Profile-bound trust.** The pairing carries the profile's rules, and the computer enforces them before anything leaves it. Everyone re-pairs once. |

---

## Deferred

- **iOS.** It waits on a Rokid glasses SDK for iOS that we can build on.
- **More than one phone per computer.** It needs one answer to win across phones.
- **The glasses camera.** It waits on a camera interface a third-party glasses app can use.

## Not on the roadmap

- **A Rokid Coder account, a hosted backend, or telemetry.** The phone, the computer and the glasses talk only to each other and to the services you already use.
- **Reading your sign-in tokens.** Rokid Coder never reads or stores the credentials of Claude Code, Codex or any other tool.
- **A plugin host on the phone.** No other app can draw on your glasses through Rokid Coder.
