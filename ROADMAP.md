# Rokid Coder: Roadmap

One row for every release. There are no dates: releases are ordered by the problem each one solves, and nothing is marked done until it has run on real hardware. What each release changed is in its [release notes](https://github.com/debasishdebs/Rokid-Coder/releases).

Every release has one headline feature. Patch releases (1.0.x, and so on) carry fixes only. GitHub cannot colour text, so the status is a symbol:

| Symbol | Meaning |
|---|---|
| ✅ | Done: built, tagged and checked |
| ⚪ | In progress (the grey rows) |
| ❌ | Not done yet / to be decided |

Last updated: 2026-11-20.

---

## Rokid Coder releases

### Done, and the 1.0 line

| | Version | Theme | What is in it |
|---|---|---|---|
| ✅ | **0.8.0** | The first complete build (pre-release) | Claude Code and Codex sessions on the glasses: progress, approvals, questions, follow-up replies; `rk claude` and `rk codex` launchers and the `/rokid` plugins; pinned, mutually authenticated TLS between phone and computer; alert history, per-kind sounds. |
| ⚪ | **1.0.0** | Publish | **Release candidates rc.1 to rc.15 are built and tagged; rc.16 is in review.** One phone app (the Nexus core is embedded; it installs the glasses app over the Rokid link and the glasses set themselves up); macOS installer and Windows 11 installer (WSL 2); pairing confirmed by a 6-digit code on both sides; Tailscale as the away-from-home connector; light phone UI; voice replies typed into the session after a screen check (empty box twice, exact text twice, never over a dialog or your own text); the glasses link re-made on a voice tap; resume hint when `rk claude` exits; a public README, install guide and this roadmap. **Still open before the final tag:** the device checklist on real hardware, Windows checks W1 to W9, macOS 13 checks M1 to M3, and a Codex review of the safety-relevant commits. Not yet published. |
| ❌ | 1.0.1 | Hardware-checklist fixes | Whatever the device checklist finds. |
| ❌ | 1.0.2 | Windows and macOS 13 fixes | Findings from W1 to W9 and M1 to M3. |

### Toward 2.0

| | Version | Theme | What is in it |
|---|---|---|---|
| ❌ | 1.1.0 | Link guard | Leave the glasses link alone while Rokid's own apps use it, and say "link busy" instead of failing. (Known issue KI-1.) |
| ❌ | 1.2.0 | Screen-reading self-check | Check the launcher against your installed Claude Code after every Claude update, and say clearly if replies are off because the screen is no longer read. (Known issue KI-2.) |
| ❌ | 1.3.0 | Stop | Stop a running turn from the glasses. |
| ❌ | 1.4.0 | Confirm before sending | See what was heard, then send, redo or cancel. |
| ❌ | 1.5.0 | The launcher on Windows | `rk claude` and `rk codex` inside WSL. |
| ❌ | 1.6.0 | Phone notifications | Allow or deny from the phone when the glasses are off. |
| ❌ | 1.7.0 | Usage | Context, tokens and rate limits on the board. |
| ❌ | 1.8.0 | Signed installers | No first-launch warning; build provenance for every file. |
| ❌ | 1.9.0 | Linux | A native install for Linux computers. |
| ❌ | 1.10.0 | Report a problem | A redacted diagnostics bundle you attach to an issue. |
| ❌ | 1.11.0 | Update check | Opt in to hear about new versions. |
| ❌ | 1.12.0 | Rokid Nexus 2.x, step 1 | Shared code and SDK additions; one protocol capability bit moves. |
| ❌ | 1.13.0 | Rokid Nexus 2.x, step 2 | Place the new upstream glasses and phone files into the core and shell split. |
| ❌ | 1.14.0 | Rokid Nexus 2.x, step 3 | Port the upstream phone hub into our hub core. |
| ❌ | 1.15.0 | Rokid Nexus 2.x, step 4 | The upstream glasses launcher. |
| ❌ | 1.16.0 | History | Page back through a session and hear it read. |
| ❌ | 1.17.0 | Many alerts | Swipe through the alerts waiting behind the current one. |
| ❌ | 1.18.0 | Queued instructions | Say it while the agent is busy; it is sent when it is free. |
| ❌ | 1.19.0 | Slash commands | Your own commands, from the glasses. |
| ❌ | 1.20.0 | A careful yes | A second gesture before approving a risky command. |
| ❌ | 1.21.0 | Real sessions from the phone | Claude Code started from the phone gets approvals and follow-ups. |
| ❌ | 1.22.0 | Take it back at the desk | `rk attach` continues a phone-started session in your terminal. |
| ❌ | 1.23.0 | Start Claude from the glasses | Dictate the first prompt. |
| ❌ | 1.24.0 | Show it | Photos, files and text from the phone into a session. |
| ❌ | 1.25.0 | Chinese and Japanese | Phone and glasses text. |
| ❌ | 1.26.0 | Voice language | Choose the speech language. |
| ❌ | 1.27.0 | Accessibility | Every card read aloud, high contrast, large text. |
| ❌ | 1.28.0 | Battery | Measured, then reduced. |
| ❌ | 1.29.0 | One adapter for every agent | The layer that makes adding an agent one module. |
| ❌ | 1.30.0 | Gemini CLI | Sessions from Gemini CLI on the glasses. |
| ❌ | 1.31.0 | OpenCode | Sessions from OpenCode on the glasses. |
| ❌ | 1.32.0 | Transport list per pairing | A pairing can list several ways to reach a computer. |
| ❌ | 1.33.0 | Your own relay | A self-hostable relay that carries only encrypted traffic, next to Tailscale. |
| ❌ | **2.0.0** | **Protocol v3** | Phone and computer agree on what each supports, and pairings work over any path. Everyone re-pairs once. |

### Toward 3.0: many computers, many accounts

| | Version | Theme | What is in it |
|---|---|---|---|
| ❌ | 2.1.0 | Play Store | A store listing under a name Rokid's trademark allows. |
| ❌ | 2.2.0 | Which computer | Every row and alert names its computer. |
| ❌ | 2.3.0 | All connected | Every paired computer stays connected at once. |
| ❌ | 2.4.0 | Profiles | Personal, Office or your own, each with a colour and a glyph. |
| ❌ | 2.5.0 | Account label | Which Claude account a computer uses, from its non-secret profile name, or your own label. |
| ❌ | 2.6.0 | The board by profile | Grouped, with a needs-you count for each profile. |
| ❌ | 2.7.0 | Office privacy | Approvals for a work profile show no command text on the glasses. |
| ❌ | 2.8.0 | Focus | Only one profile alerts. |
| ❌ | 2.9.0 | Alert rules per profile | Sounds, quiet hours and work hours. |
| ❌ | 2.10.0 | Profile defaults | Which approval modes and voice replies a profile allows. |
| ❌ | 2.11.0 | Profile network | Which paths a profile may use. |
| ❌ | 2.12.0 | Forget a profile | Everything it holds goes at once. |
| ❌ | 2.13.0 | Many sessions | Paging, mute, and finished sessions tidied away. |
| ❌ | 2.14.0 | Several Claude accounts on one computer | |
| ❌ | 2.15.0 | Several Codex accounts on one computer | |
| ❌ | 2.16.0 | Find by voice | Jump to a session by saying its name. |
| ❌ | 2.17.0 | Computer-side policy engine | The computer enforces a profile's rules. |
| ❌ | **3.0.0** | **Profile-bound trust** | The pairing carries the profile's rules, and the computer enforces them before anything leaves it. Everyone re-pairs once. |

---

## Rokid Nexus: the upstream plan we build on

Rokid Coder embeds [Rokid Nexus](https://github.com/Anezium/Rokid-Nexus) (by Anezium, Apache-2.0) as its glasses and phone core. Rokid Coder 1.0 carries Nexus **1.8.1**. Upstream has since released 2.x; we bring it in step by step (Rokid Coder 1.12.0 to 1.15.0) and keep every change we make inside it in `vendor/nexus/PATCHES.md`. Upstream's own roadmap is in [`vendor/nexus/ROADMAP.md`](vendor/nexus/ROADMAP.md).

| | Nexus version | What is in it (from upstream's release notes) | Taken into Rokid Coder |
|---|---|---|---|
| ✅ | 1.8.1 (and the 1.x line before it) | A separate speech language for the phone (1.8.1); the glasses file explorer with Wi-Fi transfers (1.8.0); Re-pair glasses without a computer (1.7.1). | In 1.0.0 |
| ❌ | 1.8.2 to 2.1 | The 2.x platform: a new glasses launcher with an activity stack, notification history, replies from the glasses (dictate or type), favourites; "Hi Rokid ended the session" detection; guard for Rokid's own native scenes; download retries. | 1.12.0 to 1.15.0 |
| ❌ | 2.2.0 | Sound in earbuds, home app shortcuts, Ink page extensions. | 1.12.0 to 1.15.0 |
| ❌ | 2.3.0 | A larger-text setting for launcher pages. | 1.12.0 to 1.15.0 |
| ❌ | 2.4.0 | Compose draft preserved, dictation persistence, a LINE plugin. | 1.12.0 to 1.15.0 |
| ❌ | 2.5.0 | Phone-assisted Wi-Fi recovery; auto-repair at boot. | 1.12.0 to 1.15.0 |
| ❌ | 2.6.0 | Section captions for page lists; pinned contacts in messaging. | 1.12.0 to 1.15.0 |
| ❌ | SDK 0.27.0 | Plugin SDK: composer tools, image pages, row icons, favourites, row sections, route geometry (we carry SDK 0.23). | 1.12.0 |

Nexus's separate plugins (Relay, Navigation, Media Deck, Meta Messages, LINE Messages, Assistant) are not part of Rokid Coder.

---

## Known limitations in 1.0

- **The glasses link is shared.** Only one app at a time can hold the phone's link to the glasses. When you tap to reply by voice and the link is gone, Rokid Coder takes it back. If another app was using it at that moment, for example while glasses media syncs to the phone or a file transfer runs, that operation can be interrupted. Fix planned in 1.1.0.
- **Replies depend on reading Claude's screen.** Claude Code has no interface that says what is in its prompt box, so the launcher reads the terminal screen before it types. A Claude Code update that changes the screen can stop replies until Rokid Coder is updated. When the launcher is unsure, it refuses and types nothing. A self-check is planned in 1.2.0.
- **The glasses app restarts itself.** A Nexus watchdog keeps its accessibility service on, so stopping the app does not last. It is by design. Turn off "Monitor sessions" on the phone to release the link.
- **Using it next to another glasses app is untested.** Two apps that both use the glasses can compete for the link, the screen and the glasses' Wi-Fi. They worked together in a first real session, but there is no coexistence test yet.
- **Several computers can be paired, but the phone follows at most two at a time:** one that the phone dials (the computer paired last), and one that dials the phone. A second computer that dials in replaces the first. Fixed in 2.3.0.
- **Plugin mode does less than launcher mode.** With `/rokid:on`, voice replies work only while the session waits, and compact and model change need `rk claude`.
- **On Windows,** `rk claude` and `rk codex` print a hint to use plugin mode until the launcher has been checked there. Automatic discovery needs WSL mirrored networking; otherwise pair with the QR code or Tailscale.
- **The installers are not signed yet,** so macOS and Windows warn on the first launch. Fixed in 1.8.0.
- **A Claude Code session started from the phone** runs once, with no approvals or follow-ups. Fixed in 1.21.0.
- **Away from home** needs Tailscale on the phone and the computer.
- **Android only** for the phone. The phone app needs Android 11 or later.

## Deferred

- **iOS.** It waits on a Rokid glasses SDK for iOS that we can build on.
- **More than one phone per computer.** It needs one answer to win across phones.
- **The glasses camera.** It waits on a camera interface a third-party glasses app can use.
- **Sharing the glasses between independent apps.** A small, open way for two apps to hand the link and screen to each other. Not yet designed; it needs a one-day coexistence test first.

## Not on the roadmap

- **A Rokid Coder account, a hosted backend, or telemetry.** The phone, the computer and the glasses talk only to each other and to the services you already use.
- **Reading your sign-in tokens.** Rokid Coder never reads or stores the credentials of Claude Code, Codex or any other tool.
- **A plugin host on the phone.** No other app can draw on your glasses through Rokid Coder.
