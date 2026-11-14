# Agents

Agents is the mission-control plugin for coding-agent sessions. It merges the
Claude Code and Codex sessions carried by `nexus-agentd` with OpenClaw
Gateway sessions, keeps the connections in a low-priority foreground service,
holds one visible monitoring notification on the phone, and renders a structured
Nexus card plus alert bands on the glasses.

With protocol v2 the glasses do more than watch. A session that needs you wakes
the display with an approval, question, Done or error band; you can allow or deny,
answer a question, reply by voice, and switch a session's approval mode, all from
the glasses. Every link to a computer is TLS, pinned on both sides; there is no
plaintext and no monitor-only link. See [Protocol v2](#protocol-v2),
[Linking a computer](#linking-a-computer), [Sounds](#sounds-and-the-question-deck)
and [Voice](#voice).

## Quick start

End to end, computer to phone to glasses:

1. **Run the daemon on the computer**, from `agentd/`:

   ```bash
   npm install && npm run build
   node dist/cli.js install-hooks   # merges Claude Code hooks into ~/.claude/settings.json, once
   node dist/cli.js run             # loopback :8791 for hooks, WebSocket :8792 for the phone
   ```

2. **Install the plugin on the phone** (this APK) and approve it in the Nexus
   app; **install a compatible `glasses-hub` build** on the glasses if the
   wearer's own hasn't shipped this yet.

3. **Pair the phone with the computer.** Both sides must agree: the phone
   decides which computers it lets in, and agentd decides which phones it
   trusts. The app walks you through it (see [Guided pairing](#guided-pairing)):
   - On the computer, run `rk claude` or `rk codex` (each offers to pair when
     no phone is paired yet), type `/rokid:pair` in Claude, or run `agentd pair`.
     Each opens agentd's two-minute window for one new phone.
   - On the phone, tap **Add your first computer** in Settings, then **Open the
     door for two minutes**. The screen says "Waiting for your computer…", then
     "Paired with <name> ✓". The phone and computer need the same Wi-Fi or
     Tailscale. On the glasses, the **Pair a computer** row does the same.
   - No automatic discovery (different networks)? Run `agentd pair` and use
     **Add a computer → paste pairing line** on the phone.
   - Every link is TLS, pinned both ways, and always steers (allow, deny,
     answer, reply). There is nothing to turn on, and no monitor-only mode.
     See [Linking a computer](#linking-a-computer).
   - A computer or phone paired before Plan 4 is asked to pair again, once.
   - Away from home: install Tailscale on both ends and sign in with the same
     account. No re-pairing is needed afterward.

4. **Settings the phone needs to actually keep running:**
   - **Let Agents keep running** — the standard Android battery exemption
     prompt, in Settings.
   - If the phone still freezes the process with the screen off (seen on a
     Vivo device): **Open App info → Battery usage → Allow background power
     usage**. That's a ROM-level battery manager Android's own exemption API
     cannot reach, not something the plugin can request directly.
   - **Allow Speech to text and Text to speech** for Agents in the Nexus app,
     under Plugin access. The voice features need both, and the grant is
     asked again after this update (see [Voice](#voice)).
   - `allowTerminalInput: true` in the **computer's**
     `~/.nexus-agentd/config.json` — off by default, needed only for typing a
     reply into a session from the glasses (see below).

5. **On the glasses:** the board shows every watched session. ENTER opens a
   pending permission (Allow/Deny), or opens a session's conversation.
   Pressing ENTER again inside a conversation offers to type a reply — this
   only works for a session actually running inside `screen` or `tmux` on the
   computer, per [Typing a reply into a session](#typing-a-reply-into-a-session)
   below.

## Configuration

The settings screen reads top to bottom: Monitoring (one switch for the
`nexus-agentd` link, which carries Claude Code and Codex, with a status line
that counts the watched sessions) and Computers (every linked machine with
its state). Each computer has its own screen with its anchored projects and
its Forget; the OpenClaw gateway is configured at the bottom of the Add a
computer screen. With no computer yet, the Computers card shows **Add your first
computer** and "Pairing takes two minutes — tap Add your first computer."
Further down are Security (the pairing TTL), Alert history and the alert
choices, including the voice reply length.

| Setting | Default | Choices |
|---|---|---|
| Sign out unused computers (`security.pairing_ttl_days`) | 14 days | 3 / 7 / 14 / 30 / 90 |
| Voice reply length shown (`voice.word_limit`) | 250 words | 100 / 150 / 250 / 500 |
| Keep alerts after the session closes (`history.keep_after_session`) | off | on / off |
| Keep alerts for (`history.window_hours`) | 24 hours | 1 / 4 / 12 / 24 |

The pairing TTL is sent to agentd with the other settings (`settings_sync`);
the other three live only on the phone.

### Projects

A project is a folder on a linked computer, anchored from the computer's
screen: the picker walks the computer's directories over the authenticated
link (`fs_list`/`fs_listing`, directories only, no file names or contents)
and stores the chosen `{name, path}` per machine on the phone. Projects are
the ground the glasses-side flow will offer when starting a session on a
computer.

Tapping a project opens New thread: one prompt and a harness — Claude Code or
Codex — and the daemon starts the session inside the project folder
(`thread_start`/`thread_started`; the prompt travels over the authenticated
link and, for Claude, reaches the CLI only through stdin). The new session
then flows through the ordinary monitoring to the board.

- Adding a computer happens on its own screen, reached from the Computers
  list. It opens on how to get `nexus-agentd` itself, then offers three
  roads as equals: automatic on the home Wi-Fi (a two-minute door with a
  visible countdown and a Cancel button), Tailscale for everywhere else,
  and a pasted pairing line for whoever wants neither.
  The pairing line is the single JSON line `agentd pair` prints; the
  plugin validates `v:1` and `kind:"nexus-agentd"` and stores one
  host/port/token/name slot, plus the `fp` and `steer` values described under
  [Linking a computer](#linking-a-computer). A line without `fp` or `steer` is
  refused: "This pairing line is from an older agentd — run agentd pair again".
  The command is `agentd` (the
  `bin` of the daemon package), not `nexus-agentd`, which is only the
  protocol and service name.
- OpenClaw: enter the Gateway host, port (default `18789`), and token. A host
  may include `ws://` or `wss://`; a plain host uses `ws://`.
- **Agents posts no alert on the phone, with one exception.** See
  [The monitoring notification](#the-monitoring-notification).
- **A sound per alert kind, off by Do Not Disturb or the quiet toggle.** See
  [Sounds and the question deck](#sounds-and-the-question-deck). It stays silent
  while the phone is in Do Not Disturb (or that cannot be read), while the Quiet
  row at the top of the glasses board is on, while the glasses are muted, and
  while they are known to be off the head. The quiet setting is the
  `alerts.quiet` preference.

Settings, auth tokens, the OpenClaw device seed, alert fingerprints, and the
Gateway-issued device token use the plugin's private `nexus_plugin_agents`
`SharedPreferences`. This follows Transit’s existing plain-`SharedPreferences`
pattern; no token or pairing payload is logged.

### Linking a computer

The daemon dials the phone, or the phone dials the daemon. Either way the phone
decides who is allowed in:

- Every computer the phone does not know yet, **the first one included**, must
  arrive while the wearer holds the door open: *Open the door* on the Add a
  computer screen opens a two-minute window, counts it down on screen, and can
  be cancelled at any moment. Outside it a stranger is refused, so no LAN host
  can enrol itself before the wearer's own computer (R121). agentd still has to
  trust the phone too, inside the window opened by `agentd pair` or `agentd
  phones allow-next`.
- A known computer presenting the **wrong token is refused**, and its stored
  token is never overwritten.
- Forgetting a machine is per machine, takes two deliberate taps, and drops
  its live connection on the spot.
- A new link is announced on the glasses, never on the phone.

#### Guided pairing

Pairing is part of the app, not a separate step (U6). When no computer is
trusted, or one is signed out or needs to pair again, Add a computer opens on a
guided section at the top:

1. "1 · On your computer: run rk claude (it offers to pair), or type /rokid:pair
   in Claude, or run agentd pair."
2. A button, "2 · Open the door for two minutes". It shows `DOOR OPEN · m:ss`
   and a Cancel.
3. A status line: "Waiting for your computer…", then "Paired with <name> ✓", or
   "Time's up — tap 2 to try again".

The Wi-Fi, Tailscale and paste-line cards stay below, under "Other ways".

"Paired" appears only for a connection this attempt caused: a computer the phone
did not hold when you started, or one that was signed out or refused and now
connects securely. A computer that was already trusted and reconnects during the
window does not finish it.

The glasses offer the same flow. When monitoring is on and no computer is
trusted, or one is signed out or needs to pair again, the board shows a **Pair a
computer** row ("tap to start"). Tapping it opens the phone's door and shows a
card, "Pairing · m:ss", saying "On your computer: type /rokid:pair in Claude, or
run agentd pair". It ends with "Paired with <name> ✓" or "Time's up — try
again"; BACK cancels and closes the door. With monitoring off, the empty board
says "Set up a provider in the phone app" instead.

`rk claude` and `rk codex` also ask "Pair now? [Y/n]" at every start until a
phone is paired. `/rokid:pair` works in Claude; in Codex it is
`rokid:pair`.

#### Pairing expiry

A pairing that goes unused is signed out, so a lost or forgotten phone does not
stay trusted forever (U7). The default is 14 days, set in Settings under "Sign
out unused computers" (3, 7, 14, 30 or 90 days).

- **It counts use, not age.** Every secure connection renews the clock, and a
  computer that stays connected is never signed out.
- **Both ends apply it.** agentd forgets a phone it has not seen for the TTL,
  on every path, and `agentd phones list` shows "last used <n> days ago ·
  signs out in <m> days". The phone signs itself out of an unused computer the
  same way.
- **An expired pairing cannot renew itself.** A reconnect after the TTL is
  refused, not accepted and refreshed.
- **You are told.** Settings shows "Signed out of <name> — not used for <n>
  days. Add it again.", and the board shows a "Signed out of <name>" row with
  "pair again: Add a computer". A signed-out computer keeps its host and name,
  so the hint is specific. Nothing paired before the upgrade is signed out at
  once: those pairings start their clock at the first run.
- A clock that jumps backwards cannot expire a pairing early or keep it alive
  forever: a last-use time in the future counts as now.

#### TLS pairing (v2)

Steering a session (allow, deny, answer, reply, mode switches) needs a link
the phone can prove is the right computer, and agentd can prove is the right
phone. Both directions are TLS (1.2 or later), pinned both ways:

- **The pairing line carries two extra fields.** `fp` is the SHA-256
  fingerprint of the computer's own certificate, and `steer` is a steering
  secret. The phone pins `fp` before it trusts `wss`, and it sends `steer`
  only in the `wss` hello, after the pin check. agentd never sends `steer` on
  any socket. Treat the pairing line like a password.
- **Outbound, phone to computer (`wss`).** The phone dials with the pin and
  presents its own certificate (the one in the Android keystore) as a client
  certificate. agentd needs that certificate pinned, the token and `steer`. A
  pin mismatch is final and says "Computer's certificate changed — re-pair"; it
  never falls back to plain `ws`. A line with no `fp` or no `steer` is refused,
  not downgraded, and a malformed one is refused too.
- **Pair again.** If agentd turns the phone away at hello (`hello_reject` with
  `repair_needed`, or a `hello_ack` that does not steer), the phone stops
  retrying in a loop and shows "Pair again — this computer no longer trusts this
  phone". Settings reads "Not connected — pair again". This is what a phone
  paired before Plan 4, or after `agentd pair --rotate-steer` or `agentd phones
  forget`, sees.
- **Inbound, computer dials the phone.** The phone advertises `tls:true` in
  its discovery reply and serves TLS with a self-signed certificate held in
  the Android keystore. **The inbound link is mutual TLS**: agentd presents
  its own certificate as a client certificate, and the phone requires one and
  pins it per computer. A later mismatch is refused before the hello is
  answered, with "Computer's certificate changed — re-pair". agentd never dials
  the phone in plaintext.
- **The phone's fingerprint** is shown in Settings as "This phone's
  fingerprint". agentd logs `phone_link_pinned` with the same digits when it
  trusts the phone; compare them.
- **agentd decides which phones it trusts.** `agentd pair` prints the line
  and opens a two-minute window for one new phone, on either path. `agentd
  phones allow-next` opens the same window without printing a line. Outside a
  window a phone whose certificate is not already pinned is refused.
  `agentd phones list` shows the trusted fingerprints and when each signs out,
  and `agentd phones forget <fp>|--all` removes them and closes their links at
  once. Rotate the steering secret with `agentd pair --rotate-steer`; every
  phone must then pair again.
- **Out of scope.** The computer's loopback hook port (127.0.0.1:8791), the
  launcher's unix socket, OpenClaw's own link and the Nexus phone-to-glasses
  link are not part of this and are unchanged. Anything on `ws://` today is
  OpenClaw's.
- **Older daemons.** An agentd that predates the client certificate cannot
  link at all. It fails closed, so update the daemon and the phone together.

### Away from home

The zero-setup link covers the home Wi-Fi. Everywhere else it rides a
[Tailscale](https://tailscale.com) network, and the setup is deliberately
short:

1. Install Tailscale on the phone — the plugin's *Away from home* section
   offers the Play Store button — and on the computer: Windows and macOS from
   <https://tailscale.com/download>, Linux with
   `curl -fsSL https://tailscale.com/install.sh | sh` followed by
   `sudo tailscale up`.
2. Sign in with the same account on both.
3. There is no step three. `nexus-agentd` watches the tailnet, spots the
   phone, and dials it with the identity it already earned at home — no
   re-pairing, no address to type.

`agentd link-phone <host[:port]>` stays available as a manual override, and
pasting the pairing line stays available as the no-Tailscale fallback.

The current OpenClaw protocol requires device identity in addition to the
shared Gateway token. On the first remote connection, approve the new
**Nexus Agents** device in OpenClaw. The plugin persists its identity so this is
normally a one-time step.

## HUD and background behavior

The HUD is a typed `NexusCard` with `NexusCardLine` list rows: a title, an
optional second line saying what the session is doing to you or for you, a tone
carrying its urgency, and a selection flag. No preformatted text surface is used.

DPAD up/down moves the selection, ENTER opens the selected session's
conversation, and BACK leaves the conversation or hides the surface. The
selection is held **by session key, not row index**: the board re-sorts itself
as agents work, so a positional cursor would drift onto a different session
between looking and pressing.

### Answering a held tool call

Claude Code's `PreToolUse` hook blocks while it waits, and Codex's app-server
raises an approval request; `nexus-agentd` offers either wait to the phone. A session with a live request shows what it wants on the
board; ENTER opens the question rather than the transcript, with the command in
the agent's own words and two answers — Allow and Deny. There is no *always
allow*, no third path, and nothing that turns one glance into a standing
permission.

ENTER is ignored for the first 600 ms of that screen: the touchpad's double tap
is two ENTER downs a few dozen milliseconds apart, and the second would
otherwise land on a decision the wearer had only just opened. The same guard
restarts whenever a band appears, is touched or closes, and when the HUD opens
again, so a double tap aimed at a band never lands on the card under it.

An approval band leads with what will run: the command (then the agent's
description), or the file an edit changes. More opens the whole request in a
reader, summary first; a tap there moves on to the Allow and Deny card.
agentd carries a command or path whole up to 4,000 characters. One it had to
cut is marked `truncated`, and then the band, the card and voice offer no
Allow, only Deny ("Command cut — review on laptop").

On a hub that does not echo notice correlations (phone hub without
`noticeInteractionVersion: 1`), a band press can be credited to whichever band
is up when it arrives, so a preempting approval shown in that instant could
receive it. Use a phone hub that advertises it with Agents.

If nobody answers, the daemon's timeout expires and Claude asks on the computer
as it always would. Being away means being asked later, never being decided for.

A session that starts asking for the wearer raises an **interactive notice** —
the band from hub 1.0.46 — rather than fighting for the whole surface. Several
sessions asking at once become one band, and a tap on it opens the board on the
session that rang. The fingerprint that stops an alert repeating is committed
only once the hub has taken the notice, so an alert that could not be delivered
is offered again on the next update instead of being silently marked as sent.
Nothing is queued for glasses that are asleep: the session simply stays at the
top of the board, which is where the wearer will look.

Unlike ordinary dormant Nexus plugins, this product explicitly requires a
monitoring foreground service and alerts while its HUD is closed. The
network owner is therefore a separate, non-exported `AgentsMonitorService`;
the one exported `AgentsPluginService` remains the normal SDK adapter.

### The monitoring notification

Agents posts no alert, status or per-event notification on the phone; alerts
belong on the glasses. The one exception is the monitoring foreground service's
own notification, which is **visible on purpose**: "Agents monitoring · n
sessions", low importance and ongoing, with **Settings** and **Stop** actions.
Some ROMs freeze a foreground service whose notification is never shown (seen
on a Vivo device), and a frozen monitor misses the alerts it exists to
deliver. The notification carries a session count only, never a session
heading, agent text or alert.

- Agents holds `POST_NOTIFICATIONS` for this notification alone. This is a
  documented exception in `plugins/AGENTS.md` section 3.5.
- It exists only while the Monitoring switch is on. **Stop** turns that switch
  off and stops the service; the pairing is kept.
- Turning Monitoring on asks for the permission once. If it is refused,
  Settings says "Notifications off — Android may pause Agents" and does not
  ask again.

### Modes and their limits

Both Claude modes are supported, and each mode's limits are shown rather than
hidden: as a mode tag on the board row, in the session's control menu, in the
phone app, and in the `/rokid:on` and `rk claude` startup text. Claude is
attached with `/rokid:on` (plugin `rokid`; also `/rokid:off` and
`/rokid:status`). Codex uses the plain-text commands `rokid:on|off|status`.
Sessions are opt-in: an unattached session sends nothing.

| | Plugin mode: normal `claude` + `/rokid:on` | Launcher mode: `rk claude` |
|---|---|---|
| Progress, Done, approvals, questions, context | Yes | Yes |
| Voice follow-up | Yes while the session waits (limit *Y*); after that, continue at the laptop | Yes always, also after *Y* expires |
| Approval-mode switch | Yes (agentd auto-answers) | Yes (same mechanism) |
| Compact | No: shown greyed out as "needs rk claude" | Yes |
| Model change | No: shown greyed out as "needs rk claude" | Yes, with a warning that it also changes the default for new sessions |

- `rk claude` starts attached.
- Codex needs no mode split. All capabilities work on normal `codex` sessions
  through the shared daemon, and Codex is opt-in the same way as Claude. A
  Codex session whose capability is false shows "not available", not
  "needs rk claude".
- Codex model and approval-policy changes from the glasses apply on the next
  follow-up, and the HUD shows them as "pending" until then.
- Approve-all (the temporary approval mode) is never silent: the board row is
  tagged while it is on, and a rejected change leaves the menu showing the real
  mode with "Not applied: <error>".

### Voice

Voice goes through the Nexus `stt` and `tts` capabilities. The plugin does not
open the microphone itself and logs no spoken text.

- **Reply by voice.** From a session's menu, "Reply by voice" starts one
  listening session. The result appears on a card to confirm: Send, Speak again
  or Cancel. Nothing is sent until you press Send. What Send sends is always the
  full transcript you confirmed. A long one is shown condensed (see
  [Long replies](#long-replies-shown-condensed)), never refused and never
  silently cut. It works while the session waits and, in launcher mode, at any
  time (see the table above).
- **Question answers.** A question band opens a deck with one card per question;
  see [Sounds and the question deck](#sounds-and-the-question-deck). The answer
  box accepts up to 4,000 characters; a longer answer is refused with "Answer too
  long — answer on laptop". Answers carry the question and option text exactly
  as agentd sent it; a question too large for the glasses to answer exactly
  says "Question too long — answer on laptop" on its band and offers no Answer.
- **Voice approval.** The decision card has a "Say allow or deny" row. Only a
  complete, plain utterance from a fixed list counts (for example allow,
  approve, yes, ok; deny, no, reject). Anything else, including "don't allow",
  says "Say allow or deny" again. A match still asks "Allow?" or "Deny?" and
  needs Confirm.
- **Errors you may see:** "Voice unavailable" (not granted yet), "Mic busy —
  try again" (another plugin holds speech, or the last session is still
  stopping), "Glasses link lost" and "Didn't catch that". A final result that
  comes back empty falls back to the last words heard.
- **The alert sound** is separate: a short line or a chime (see
  [Sounds](#sounds-and-the-question-deck)), silent under Do Not Disturb, the
  Quiet row, a muted glasses volume, or glasses known to be off the head.

#### Long replies shown condensed

A voice reply can be long. Agents never refuses one and never cuts it without
saying so (U4). The Heard card shows a condensed view, and the confirm card's
first line says so: "Showing <shown> of <total> words · the full reply is sent".
The view is the start, the middle and the end, joined by visible ellipses
(`start … middle … end`), so you can see what the reply holds.

- **The limit is in words.** Settings, "Voice reply length shown": 100, 150, 250
  or 500 words (default 250, never more than 500). A reply at or under the limit
  is shown whole.
- **Send sends the full text.** Condensing is display only; what you confirmed is
  what the session receives.
- A single huge "word" (a URL, or text with no spaces) is cut to 40 characters
  with `…` in the display only, so the card stays readable.
- If the glasses card cannot hold the whole condensed view, a "Read all" row
  opens it in the paged output reader.
- The same view is used when you review a long free-text answer to a question.
  The follow-up itself is still capped at 16 KiB.

**Re-approve the grant after updating.** The plugin's manifest now declares the
`stt` and `tts` capabilities (`CAPABILITIES=surfaces,stt,tts`). Nexus resets a
plugin's grant when its capabilities change, so open the Nexus app, go to
**Plugin access** and allow **Agents** for Speech to text and Text to speech.
Until you do, voice features say "Voice unavailable" and the alert sounds stay
silent; the bands and board still work.

### Sounds and the question deck

**A sound per alert kind** (U3). The sound follows what the alert is, and the
same gates apply to all of them: Do Not Disturb, the Quiet row, a muted glasses
volume, and glasses known to be off the head.

| Alert | Sound |
|---|---|
| Approval | Spoken: "<Name> needs approval" |
| Question | Spoken: "<Name> has a question" |
| Error | Spoken: "<Name> hit an error" |
| Done | A short chime, not speech |
| Notice | None |
| **Any reminder or retry** | **None** |

**Reminders are silent** (U1). A waiting alert may be shown again on the display,
repeatedly, but it never makes a sound, because sound distracts when you are
busy. The re-shown band's footer says "Reminder", or "Reminder · +N waiting".

**The chime never plays on the phone speaker.** It plays only when the audio is
routed to a Bluetooth output (the glasses). Agents checks the route before the
chime starts, keeps it muted until Android reports the Bluetooth route, and
stops it at once if the route changes or Android warns the audio is about to
move to the speaker. With no Bluetooth output, on Android older than 13, or when
the route is unsure, the chime is dropped and Done is display-only. The whole
chime is under 0.2 seconds; a Bluetooth drop inside that is a device check, not
something a unit test can prove.

**One card per question** (U3). A question with several items opens a deck:

- Each question is its own card, `Q<n>/<N> · <heading>`. The rows are the
  options, then "Answer box (voice)" when free text is allowed, then "Next
  question ›" (always available, answered or not), and "‹ Previous question"
  from Q2 on.
- After the last question comes a "Review answers" card: one row per question,
  "Q<n> <heading>: <answer or — not answered>". A tap opens that question. "Send
  answers" is enabled only when every question is answered.
- BACK goes to the previous card, and closes the deck from Q1.
- One question only: no review card, and the existing "Send answer" row stays.
- If the session closes the alert while you are on a card, the deck closes with
  the "No longer waiting" brief.

Answers keep the exact wire strings agentd sent (R124).

### Alert history

The phone keeps a list of every alert and how it ended, so you can look back
over it (U1). Open Settings, **Alert history**. It is newest first. Each row is
`<PROVIDER> · <kind> · <session heading>`, with a line below it, `<outcome> ·
<relative time>`, and ` · shown N×` when the alert was shown more than once.

| Outcome shown | Meaning |
|---|---|
| Allowed, Denied, Answered, Replied | You acted from the phone or glasses. "Handled" when it was acted on elsewhere. |
| Waiting | Still pending. A refused answer keeps it here as "Not sent: <error>". |
| Dismissed, Read | You dismissed it (Done and error alerts end here). |
| Ignored — timed out | Nobody answered before it expired. |
| Handled on laptop | The laptop answered it, or the session ended while it waited. |

- An attempt never closes an entry. It ends only when agentd confirms the alert
  closed, so "Allowed" means agentd took it. Dismissing an approval or question
  only counts a re-show; the entry stays Waiting.
- Pressing a control with no secure link records nothing; the glasses say "Not
  sent" / "Computer not connected".
- **How long it is kept.** The history lives in memory, so a restart of the
  Agents process clears it. By default an alert leaves the list when its session
  closes; turn on "Keep after the session closes" to keep it. Either way,
  nothing is kept past "Keep alerts for" (1, 4, 12 or 24 hours, default 24). At
  most 200 entries are held. **Clear history** empties it.
- Empty state: "No alerts yet — they'll appear here as your agents ask for
  things."

### Typing a reply into a session

ENTER inside an open conversation offers to type into that session, using the
same editable field Relay and Assistant use for reply-by-typing. agentd cannot
own an already-running session's process, so it types the way a person would:
`screen -X stuff` or `tmux send-keys` puts the text in the session's own input
buffer, one send for the text and a second for the carriage return. This only
reaches a session actually running inside `screen` or `tmux` on the computer —
a session started plainly in a terminal, or one the daemon spawned itself,
does not offer the field, and neither does a session mid-turn, since typing
into a turn in progress would land mid-thought rather than at a prompt.

## Implemented protocols

### nexus-agentd (`nexus-agents/1`)

Implemented exactly:

- client `hello` and server `hello_ack`;
- authoritative `snapshot`;
- contiguous `session_upsert` and `session_removed`;
- a single `refresh` request on any sequence gap, with deltas ignored until the
  replacement snapshot;
- `ping`/`pong`;
- close `4401` as non-retrying `auth_failed`, and jittered 1/2/4/5-second
  reconnects for other closes and network failures;
- ignored unknown message types;
- the conversation exchange: the plugin sends `detail_open` with a session id
  when the wearer opens a session and `detail_close` when they leave, and the
  daemon answers with one `detail` carrying the recent messages followed by
  `detail_append` for each new one while the view stays open.

Every reconnect resets sequence state, sends a fresh hello immediately, and
waits for a new authoritative snapshot.

### Protocol v2

Protocol v2 is the same connection with more frames, defined in
`agentd/src/protocol-v2.ts` and mirrored byte for byte by the plugin's codec
and the fixtures in `contracts/`.

- **Agent to phone:** `session_upsert` gains the v2 fields (`mode`
  plugin or launcher, `capabilities` for compact, model and follow-up,
  `tempMode`, a heading and the current file). The new frames drive the bands
  on the glasses: `alert` (with a reason such as new, retry or reminder),
  `alert_closed`, `ack`, `followup_closed`, `mode_reset` and `models`.
- **Phone to agent, steering:** `approval_decision`, `session_input`,
  `thread_start`, `alert_action`, `followup`, `question_answer`, `mode_set`,
  `mode_revoke_all`, `codex_settings`, `codex_compact`, `launcher_command`,
  `defaults_set` and `settings_sync`. Every one carries a `msgId` (a UUID, at most 128
  characters) made once per user action and reused if it is resent, so a
  repeat is acknowledged but not run twice. `followup.text` is at most 16 KiB.
- **Phone to agent, monitor:** `alert_shown`, `alert_dismissed`,
  `models_request` and the v1 monitor frames. These are allowed on any link.
- **Steering needs a secure link, and every link is one.** One gate
  (`AgentdWire`) classifies every outgoing frame. There is no plaintext or
  monitor-only link to agentd: the phone dials `wss` only, with its client
  certificate, and a link that is not secure does not exist. If you press
  Allow, Deny or a reply with no secure link, the glasses say "Not sent" /
  "Computer not connected". Allow and Deny are never hidden for link reasons
  (only for a command agentd cut, as above). agentd's refusal at hello is
  `hello_reject` with `repair_needed` or `bad_token`, then a 4403 close.
- **The phone is the configuration owner.** On every secure link it sends
  `settings_sync` (the alert timings, the wait limit *Y* and the pairing TTL),
  which overwrites the computer's copy. Edit these in the Settings screen, not on
  the laptop.
- **Alerts come from the v2 frames.** Once a computer has spoken v2, the older
  v1 approval and status attention for that computer's Claude and Codex
  sessions stays off, even while the link is down, so nothing alerts twice.
  The v1 status alert is for OpenClaw sessions only.

### OpenClaw Gateway v4

The implementation was derived from the source clone at
`C:\Users\saim2\.codex-detached\rokidnexus\agents-p1\openclaw`:

- Protocol version 4 and minimum general-client version 4:
  `packages/gateway-protocol/src/version.ts:2`.
- `connect` parameters (protocol range, client, role/scopes, device, and token
  auth) and `hello-ok`:
  `packages/gateway-protocol/src/schema/frames.ts:33` and
  `packages/gateway-protocol/src/schema/frames.ts:75`.
- `req`, `res`, and `event` frame envelopes:
  `packages/gateway-protocol/src/schema/frames.ts:155`,
  `packages/gateway-protocol/src/schema/frames.ts:163`, and
  `packages/gateway-protocol/src/schema/frames.ts:172`.
- Generic `gateway-client` identity and `backend` mode:
  `packages/gateway-protocol/src/client-info.ts:23` and
  `packages/gateway-protocol/src/client-info.ts:50`.
- Challenge-first Android handshake and connect request:
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt:986`,
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt:1042`,
  and
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/GatewaySession.kt:1242`.
- Canonical signed device-auth payload v3:
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/DeviceAuthPayload.kt:7`.
- Persistent Ed25519 device identity semantics:
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/DeviceIdentityStore.kt:11`
  and
  `apps/android/app/src/main/java/ai/openclaw/app/gateway/DeviceIdentityStore.kt:174`.
- `sessions.list` parameters and server handler:
  `packages/gateway-protocol/src/schema/sessions.ts:285` and
  `src/gateway/server-methods/sessions-read.ts:220`.
- `sessions.subscribe` and its `sessions.changed` subscription:
  `src/gateway/server-methods/sessions-subscriptions.ts:35` and
  `src/gateway/server-methods/session-change-event.ts:51`.
- Session title/activity/run/error/CWD fields:
  `packages/gateway-protocol/src/schema/sessions-row.ts:27`,
  `packages/gateway-protocol/src/schema/sessions-row.ts:43`,
  `packages/gateway-protocol/src/schema/sessions-row.ts:45`,
  `packages/gateway-protocol/src/schema/sessions-row.ts:54`, and
  `packages/gateway-protocol/src/schema/sessions-row.ts:75`.
- Active-run projection returned by `sessions.list`:
  `src/gateway/server-methods/sessions-read.ts:333` and
  `src/gateway/server-methods/sessions-read.ts:364`.
- `exec.approval.requested` request fields and event timestamps:
  `packages/gateway-protocol/src/schema/exec-approvals.ts:235` and
  `src/gateway/server-methods/approval-shared.ts:255`.
- Approval event scope and session-change read scope:
  `src/gateway/server-broadcast.ts:43` and
  `src/gateway/server-broadcast.ts:71`.

Wire traffic sent by this plugin is limited to:

1. the signed `connect` request with token auth;
2. `sessions.list`;
3. `sessions.subscribe`.

It listens for `sessions.changed`, `exec.approval.requested`, and
`exec.approval.resolved`. A session-change event triggers an authoritative
re-list instead of locally guessing a patch. The approval events are observed
only; the plugin never sends an approval resolution, session message, command,
or agent-spawn request.

Mapping is deliberately conservative:

- `hasActiveRun:true` or Gateway status `running` → `working`;
- a live exec-approval request for that session → `needs_you`;
- Gateway status `failed`, `killed`, or `timeout`, or `lastRunError` →
  `error`;
- everything else → `idle`, with Gateway status notes kept as
  `statusDetail`.

The connection requests `operator.read` plus `operator.approvals`; the latter is
required by the Gateway event guard to receive approval-request events. The
implementation contains no approval method or resolution frame.

## Build and test

This folder is a standalone Gradle root that points read-only at the repository
SDK projects, so no root Gradle file needs an Agents entry:

```powershell
cd plugins\agents
$env:GRADLE_USER_HOME = (Join-Path (Get-Location) ".gradle-user")
..\..\gradlew.bat testDebugUnitTest assembleDebug
```

On macOS or Linux, with JDK 17:

```bash
cd plugins/agents
JAVA_HOME=/path/to/jdk17 ../../gradlew testDebugUnitTest assembleDebug
```

The on-glasses checks that no unit test can cover are listed in
`docs/coding-agent/claude/plan/2026-11-14-plan-2-device-checklist.md`.

The module uses the same first-party namespace, `minSdk 30`, SDK project
dependency, signing script, AndroidX Core/coroutines versions, JUnit stack, and
JSON choice as Transit, plus the repository’s existing OkHttp `4.12.0`.

## Phase 1 limits and risks

- OpenClaw approval events are live broadcasts. The permitted Phase 1 method
  subset has no authoritative pending-approval list/replay, so an approval
  already pending before a reconnect may not appear until OpenClaw emits a new
  related event.
- `sessions.list` is capped at 200 rows per refresh. The HUD can show 63 session
  rows because a Nexus card is limited to 64 rows including the header.
- Plain `ws://` is still possible for **OpenClaw's** Gateway (an upstream Nexus
  link, not Rokid-Coder's). It sends credentials over an unencrypted tailnet
  connection. Configure `wss://` when the Gateway has TLS; the plugin does not weaken TLS or
  install a custom trust manager.
- No boot receiver is present. Monitoring starts after configuration, an
  explicit connection test, or a Nexus HUD open, as required for Phase 1.
- Approve/deny and session spawning exist; typed replies to a running session
  exist too, but only when that session happens to be running inside `screen`
  or `tmux` on the computer — agentd types into it the way a person would
  rather than owning the process, and a session outside a multiplexer simply
  does not offer the reply field. Voice follow-ups need the `stt` grant and
  the limits in [Modes and their limits](#modes-and-their-limits).
- **The phone may stop running Agents altogether, not merely throttle it.**
  Measured on a Vivo device: Android froze the process outright
  (`cgroup.freeze=1`, no CPU time accruing) while the service still reported
  `isForeground=true`. A frozen process is worse than a slow one — the kernel
  keeps completing TCP handshakes from its backlog, so `nexus-agentd` saw a
  phone that connected and then never answered `hello`, timed out after 15
  seconds, and redialled forever. That was seen while the notification was
  hidden, which is why it is now visible: a foreground service whose
  notification never appears is not treated as a protected one on every ROM.

  Monitoring therefore asks for a battery exemption on its own screen, and
  because that platform flag is not authoritative everywhere — this same device
  keeps the real decision in its vendor power manager and leaves
  `isIgnoringBatteryOptimizations` false regardless — the screen also watches
  its own heartbeat and reports a freeze it actually observed rather than one
  the flag predicts.

  The setting that actually binds on such a phone lives behind App info rather
  than the platform dialog: on the measured device it is *Battery usage > Allow
  background power usage*, and choosing it stopped the freezing. The vendor's
  own high-power screen cannot be deep-linked — it is guarded by a signature
  permission — so the screen offers App info as the nearest door it is allowed
  to open.

- Doze remains a separate, milder limit on top of that: even unfrozen, a
  screen-off, stationary, unplugged phone may not see a transition until a
  maintenance window. The alert arrives on the glasses, not the phone, so it
  reaches the wearer when the phone next runs the monitor.
- The device identity is signed by a hand-written Ed25519 implementation. Its
  signatures are RFC 8032 conformant but the arithmetic is not constant-time,
  which is acceptable on a private tailnet and must be replaced with a vetted
  library before any public release.
