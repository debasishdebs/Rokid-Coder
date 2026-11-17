# Rokid Coder on your computer

The helper that follows your Claude Code and Codex sessions and talks to your phone over pinned TLS. Install it from the installer; the phone app guides you through the same steps.

Download the installer from <https://github.com/debasishdebs/Rokid-Coder/releases/latest>.

## Requirements

- **macOS 13 or later**, Apple silicon or Intel. Pick the `arm64` or `x64` file to match your Mac.
- **Windows 11 22H2 (build 22621) or later with WSL 2** and a distro with glibc 2.35 or newer, such as Ubuntu 22.04 or 24.04. The installer checks WSL for you and says how to fix what is missing.
- Your phone and computer on the same Wi-Fi, or both on Tailscale.
- Claude Code or Codex. You do not need them first: setup offers to install a missing one, and you can skip that step.

Nothing else is needed. The installer carries its own Node runtime, so it does not touch yours.

## Install on macOS

1. Download `rokid-coder-1.0.0-macos-arm64.dmg` (Apple silicon) or `rokid-coder-1.0.0-macos-x64.dmg` (Intel) and open it. The `.pkg` inside is the same installer.
2. The installer is not signed by Apple yet, so macOS stops the first launch. **Right-click the `.pkg` and choose Open, then Open again.** You only do this once.
3. Follow the installer. Before it installs anything it checks your macOS version, that the package matches your Mac's architecture, that no newer Rokid Coder is already installed and that 300 MB is free, and it says how to fix what fails.
4. When it finishes, a Terminal window opens and runs Rokid Coder setup as you. If it did not open (for example after `sudo installer`, or when you were not the logged-in user), double-click **Rokid Coder Setup** on the disk image, or run the `rokid-setup install` command the installer printed. If macOS refuses **Rokid Coder Setup**, right-click it and choose Open, then Open again.
5. Setup walks through the CLI step and pairing, below.

Upgrading from 0.8.0 is the same install. Setup keeps your pairing and retires the old background job.

## Install on Windows

1. Download `rokid-coder-1.0.0-windows-x64.exe` and run it as yourself, not as another account.
2. The installer is not signed yet, so Windows SmartScreen warns. **Click More info, then Run anyway.**
3. Choose the network mode. **Mirrored** (recommended, needs WSL 2.0.9 or later) asks your OK to set `networkingMode=mirrored` in `%UserProfile%\.wslconfig` and restart WSL, which closes every running Linux distro; a backup is kept. **NAT with a port proxy** works with any WSL, but automatic discovery does not, so you pair with the QR code or Tailscale. You can also name the WSL distro, or leave it empty for your default Ubuntu.
4. The installer then checks Windows, WSL 2, your distro, the network profile and the firewall, and shows each result with its fix. Press **Re-check** after fixing one. **Apply firewall rules (admin)** asks an administrator to approve the rules; cancelling the installer takes back what it added.
5. A console window then runs Rokid Coder setup inside your WSL distro: the CLI step and pairing, below.

On Windows the launcher commands `rk claude` and `rk codex` print a hint to use plugin mode (`/rokid:on`) until the launcher is verified on Windows.

## The CLI step (you can skip it)

If Claude Code or Codex is missing, setup offers to install it with that tool's own installer. Say no to skip: setup finishes either way, and `rk claude` or `rk codex` offers the install again later. When a CLI is present, setup also installs the Rokid Coder plugin into it (see [`../plugin/README.md`](../plugin/README.md)).

## Pairing

Pairing is the last step of setup, and it is confirmed on the phone.

1. On the phone, open Rokid Coder and follow the setup to **Finish on your computer**, then tap **Ready to pair** to open the two-minute window.
2. In setup, the computer shows a 6-digit code and asks whether your phone shows the same one. Compare the codes, type `y` on the computer, and tap **Codes match** on the phone too. Nothing pairs until both sides confirm.
3. If the phone cannot find the computer on its own, setup offers [R]etry, [T]ailscale, [Q]R code or [L]ater: the QR code or a pairing line to scan or paste, and Tailscale.

Pair later with `~/.rokid-coder/bin/agentd pair` in a terminal, or `/rokid:pair` inside Claude Code (`rokid:pair` in Codex). Every new pairing needs the same code check on both screens.

## Tailscale (optional)

Tailscale lets your phone reach the computer away from home. Install it on both, sign in with the same account, and no re-pairing is needed. The phone app shows the Tailscale steps under Settings, Connectors.

## Uninstall

- **macOS:** in Terminal, as yourself, run `uninstall.sh` from the disk image. It runs `rokid-setup uninstall` for you: the service, the plugins and your program files go. Add `--system` to also remove the package under `/Library/Application Support/RokidCoder` (it asks for your password with sudo, and refuses while another user still has Rokid Coder set up unless you add `--force`).
- **Windows:** uninstall Rokid Coder from Apps, Installed apps. It asks whether to also delete your pairings and settings (No keeps them for a later install), and may ask whether to keep mirrored networking.

Your pairing state is kept unless you purge it: on macOS add `--purge` to `uninstall.sh` (or run `rokid-setup uninstall --purge`, which needs a typed `purge` or `--yes`).


# Reference: running from source

The installer does the setup below for you. These are the manual steps and the daemon's behavior, for running from a source checkout.

`nexus-agentd` is the Windows PC-side monitor for Nexus Agents mission control. It receives
Claude Code lifecycle hooks on loopback, tails active Claude transcript JSONL files, and
publishes authenticated session snapshots and ordered deltas to the Nexus Agents Android
plugin.

The daemon can hold Claude Code `PreToolUse` hooks while the linked phone asks the wearer
to allow or deny a tool call. It does not auto-approve requests, accept voice commands,
or install itself as a Windows service. The phone link is TLS only (see below).

## Requirements and setup

- Windows 11 or macOS
- Node.js 20 or newer
- A Tailscale connection between the PC and the Android device, or both on the
  same Wi-Fi

```powershell
cd computer
npm install
npm run build
node dist/cli.js run
```

`node-pty` is a native dependency (it backs `rk claude`). `npm install` fetches its
prebuilt binary for Windows and macOS, and the `postinstall` script sets the execute
bit on its macOS `spawn-helper`; other platforms build it with a C++ toolchain.

### Claude Code plugin (replaces `install-hooks`)

Sessions are opt-in. The Rokid-Coder plugin forwards a session's hooks to the daemon, and
the daemon ignores a session until it asks to be attached. From the repository root:

```bash
claude plugin marketplace add .
claude plugin install rokid@rokid-coder
```

(`claude --plugin-dir plugin/claude-code` loads it for one session without installing.)
Then, inside a session, type `/rokid:on` to attach it, `/rokid:status` to check and
`/rokid:off` to detach (typing `/rokid` autocompletes to all three). While attached, the
plugin supports progress, approvals, questions, context and voice follow-ups while waiting;
compact and model change need `rk claude`.

The plugin's `bin/hook-forward.js` is a build output: `npm run build` copies
`dist/hook-forward.js` into `plugin/claude-code/bin` and `plugin/codex/bin` (the
`bundle:plugins` script), and the copies are committed so a plugin installed from git has
them. Rebuild and commit them whenever `src/hook-forward.ts` changes; a test fails when
the committed copy is stale.

On macOS the same four commands run from any shell:

```bash
cd computer
npm install && npm run build
node dist/cli.js install-hooks
node dist/cli.js run
```

`run` is the default command, so `node dist/cli.js` is equivalent. If installed through
`npm link` or as a package, use `agentd` in place of `node dist/cli.js`.

Claude Code hooks post only to `127.0.0.1:8791`; this listener never accepts remote
connections. The phone link on `0.0.0.0:8792` is wss only (TLS 1.2 or later): a client
that opens with anything but a TLS handshake is dropped without a byte in reply. A phone
gets in only with its pinned client certificate, the pairing token and the steering
secret, and every link that gets in may steer; there is no monitor-only link. When agentd
dials the phone instead, that link is TLS too, and agentd never dials plaintext.
Allow inbound TCP 8792 through Windows Firewall:

```powershell
netsh advfirewall firewall add rule name="nexus-agentd" dir=in action=allow protocol=TCP localport=8792
```

macOS needs no equivalent rule while its application firewall is off, which is the
default. With it on, allow incoming connections for `node` the first time macOS
asks, or add it under System Settings > Network > Firewall > Options.

Expose port 8792 only over the user's trusted Tailscale tailnet all the same, not through
router port forwarding or a public interface.

When agentd turns a phone away at hello it sends `{type:"hello_reject", v:2, reason}` first,
where `reason` is `repair_needed` (no client certificate, a certificate that is not pinned
while no pairing window is open, or a missing or wrong steering secret) or `bad_token`, and
then closes with 4403. A refused hello changes nothing: no pin is added and no window is
used up. Logs show only a short fingerprint, never the token, the secret or a full
fingerprint.

A phone paired before Plan 4 connected without a client certificate, or over plaintext,
and is now refused with `repair_needed`. Pair it again: run `agentd pair` (or
`agentd phones allow-next`) and link the phone within two minutes, so its certificate is
pinned. A `tls://` prefix on a phone target in older configs is still accepted and changes
nothing: every target is dialled over TLS.

## Pair the plugin

```powershell
node dist/cli.js pair
```

The command prints a one-line JSON pairing payload and a terminal QR code. The Android
plugin can scan the QR code or accept the printed JSON pasted directly.

The payload says where to dial this computer: `host` (the first address, which phones that
predate the list use) and `hosts`, the whole list: the LAN address first and this
computer's Tailscale IPv4 (100.64.0.0/10) last, at most four. Away from home a phone can
only reach the Tailscale one. agentd finds that address by asking the Tailscale CLI
(`tailscale ip -4`), never by interface name (macOS calls it `utunN`); the answer is cached
for 30 seconds, and without Tailscale, or with `tailnetDiscovery` turned off in
`config.json`, the list is the one LAN address, as before. In WSL's NAT mode the list is
the Windows host's addresses (Tailscale's first, as before), with the tailnet address
added if it is missing.

`pair_credentials` carries the same list as `wsHosts` beside `wsHost` and `wsPort`.

Every accepted `wss` link is also sent `{"type":"endpoint","v":2,"hosts":[...],"port":8792}`
right after the snapshot, and again whenever the list changes while the phone is linked
(agentd looks every 15 seconds), so a phone paired before it carried a tailnet address
learns it the next time it connects at home, without pairing again. Phones that do not
know the frame ignore it.

The window stays open for two minutes and trusts the first new phone to connect and
authenticate, on either path (the phone dialling in over `wss`, or agentd dialling the
phone). `agentd phones allow-next` opens the same window without printing the line. From
Claude, `/rokid:pair` does the same, and `rk claude` / `rk codex` offer it at start when no
phone is paired. The phone's own app walks the other side of it (Add a computer).

### Pairings that go unused expire

A phone that has not connected for N days is signed out and has to pair again. The default
is 14 days; the phone sets it (3, 7, 14, 30 or 90) and sends it with its settings (agentd
accepts whole numbers from 1 to 365 and answers `bad_settings` to anything else), and it is
kept in `settings.json` in agentd's state directory. Any accepted connection, over `wss` or dialled, counts as use and
renews the clock, at most once an hour, so a phone that stays connected never expires. An
expired phone cannot renew itself by reconnecting: it is forgotten, refused, and its live
link is closed. agentd checks hourly and at startup. `agentd phones list` shows each phone
as `last used <n> days ago · signs out in <m> days`, and `agentd phones forget <fp>|--all`
removes one or all at once. A last-use time in the future (a clock that moved back) counts
as now. Pins from an older agentd are carried over with the migration time as their first
use, so nothing is signed out the moment you update.

The token, stable machine ID, ports, and machine name live in
`~/.nexus-agentd/config.json`. Treat this file and pairing payload as credentials.
Runtime logs are appended to `~/.nexus-agentd/agentd.log`; at 5 MB the daemon rotates the
file to `agentd.log.old`.

## `rk`: launcher mode

`rk` starts Claude Code or Codex for you. It is installed as a second bin next to `agentd`
(`rk` after `npm link`, or `node dist/rk.js`).

```bash
rk claude [claude args...]     # e.g. rk claude --model haiku
rk codex  [codex args...]
```

Everything after the mode goes to the real CLI unchanged.

### `rk claude`: launcher mode

`rk claude` runs `claude` in a pseudo-terminal it owns, passes your keystrokes and the screen through
untouched, and tells agentd (over `launcher.sock`, in agentd's state directory, mode 0600, same user
only) which session it runs. agentd binds the session only after it finds a session file Claude wrote
for a process below the launcher's own child, so another program cannot claim a session. The session
then appears on the phone and glasses in launcher mode, even before the first prompt.

| From the glasses | Launcher mode | Plugin mode (`/rokid:on`) |
|---|---|---|
| Progress, Done, approvals, questions, context | yes | yes |
| Voice follow-up | any time, also after the wait limit expired | only while the Stop wait is open |
| Compact | yes | no |
| Model change | yes (it also sets your default model for new sessions) | no |

Limits to know about:

- Replies, compact and model change are typed into Claude's prompt, so they run only when Claude is idle.
  A busy session makes them wait (up to 60 s) and then fail with `busy`.
- When a reply is unavailable the phone's session object carries `followupWhy`: `draft` (text at the laptop
  prompt), `mode_not_allowed` and `bg_off` (a reply while a background subagent runs would be allowed but
  for the permission mode, or but for the phone's switch; see below), `background` (Claude's file says busy
  while a background subagent runs and the evidence below is not there, so agentd types only when Claude's
  own file says idle), `busy` (Claude is working, a question or approval is pending, or a write is
  uncertain) or `not_launcher` (the session is not under `rk claude`), in that order of precedence. It is
  absent whenever the reply is available. A phone that does not know a value shows it as `busy`.
- Replies while a background subagent runs are opt-in. Claude's file stays `busy` for as long as a
  background subagent lives, though the main prompt is free, so the phone's Settings switch `bgReplies`
  (`settings_sync`; absent is off, kept in memory for the connected phone and sent again on every connect)
  lets agentd type on hook evidence instead. All of it is required, and every item is checked again by
  agentd (`write_check`) right before the paste and right before the Enter; any loss cancels the reply as
  `busy` and it is never retyped:
  - Claude's file says `busy` for this session (`idle` takes the ordinary path, `waiting` never types);
  - the main thread's latest `permission_mode` is `auto`, `bypassPermissions`, `acceptEdits`, `dontAsk` or
    `default`. `plan` (its plan-approval dialog would take the keys) and an unknown or missing mode give
    `mode_not_allowed`. Outside `auto` and `bypassPermissions` a dialog may open, so agentd must also know
    that no approval of any origin, a subagent's included, is pending;
  - a main-thread `Stop` with `stop_hook_active` not true, at most 6 hours old, and no main-thread work
    since: a UserPromptSubmit, a main-thread PreToolUse, a PermissionRequest or an Elicitation from any
    agent, a SubagentStop, any Notification whose `notification_type` is not `idle_prompt` or
    `auth_success`, a typed write or a delivered Stop hold all take it away; a hook with an `agent_id` is a
    subagent's and says nothing about the main thread;
  - at least one running subagent; nothing pending, held, in flight or uncertain; no draft at the laptop;
  - the reply is one line of at most 600 characters.

  The launcher then pastes the text with no Enter, and only presses Enter when the screen shows the
  input box visibly empty before the paste and exactly the reply in it after, with no dialog, question or
  running-turn sign, on two looks. Otherwise it sends Ctrl+U and the reply fails `not_sent`, which the phone
  words as "Claude is busy with something else, wait a moment and try again". The reply counts as taken
  when Claude's UserPromptSubmit for it arrives, and is never retyped. The screen model is deliberately
  small: an incomplete or unknown escape sequence, a switch to the alternate screen, a resize, or a
  character of uncertain width on the input line make it unsure, and unsure never presses Enter or
  pastes. After a resize or a sequence it cannot follow, replies stay `not_sent` until the screen is
  erased and drawn whole again (Ctrl+L, or `/clear`). The reply must match word for word: a missing or
  extra space in the box counts as altered text.
- Nothing is typed over a half-written prompt. If you have text in the prompt, a command waits until you
  submit or clear it, and fails with `laptop_draft` after 60 s.
- Compact has up to 180 s to finish. A model change is confirmed with Claude's own dialog; if the result
  cannot be seen, the session is marked uncertain and further commands are refused until you check it.
- A follow-up is one bracketed paste of at most 16 KiB.
- While a glasses command types, your keys are held and replayed once Claude is ready again; Esc or
  Ctrl-C takes over at once. Keys typed while a glasses model change may have Claude's model dialog open
  are dropped instead, so none can answer the dialog. `rk` rings the bell when it drops keys and says
  so again after Claude exits.
- One launcher holds a session. A second launcher for the same session is refused.
- If agentd is not running or has its launcher socket off, `rk claude` still starts Claude, says so in
  its banner, and attaches by itself if agentd comes up later. Nothing is lost except the glasses.
- When `rk` itself is stopped by a signal (TERM, HUP, INT, QUIT) or hits an unexpected error, it ends
  Claude and every process left in Claude's process group. When Claude exits on its own, including after
  `rk`'s stdin closes (even when `rk` has to hang Claude up 10 s later), background jobs you started
  through Claude stay running, as with plain `claude`.

The banner is printed before Claude draws, so it is never mixed into the TUI. It reads "attaching…"
because the phone confirms the bind afterwards. In Claude, `/rokid:status` shows the session's state and
`/rokid:off` stops sending it to the glasses.

### Pairing from `rk`

If no phone is paired yet, `rk claude` and `rk codex` (when agentd is up) ask `Pair now? [Y/n]` before
they start. **Y** opens agentd's two-minute pairing window and waits for the phone to appear under
Agents > Add a computer (the phone and computer need the same Wi-Fi or Tailscale); Enter skips and closes
the window again. **n**, a non-terminal stdin or a closed window print
`Pair later: run "agentd pair" or type /rokid:pair in Claude (rokid:pair in Codex).`
The prompt only opens the window. The pairing payload and its secrets still come only from `agentd pair`.

### `rk codex`

`rk codex` cannot own a Codex thread, so it runs plain `codex` and prints how to attach before Codex
draws:

```
Rokid-Coder: starting Codex, ready to attach.
  Next step: type rokid:on inside Codex to show this session on the glasses (rokid:off detaches, rokid:status checks).
  rokid:on works only once the Rokid-Coder plugin (plugin/codex) is installed in Codex.
```

Limits:

- It adds no compact or model control of its own; those work after `rokid:on` attaches the thread through
  the plugin, because Codex shares its daemon.
- Codex draws on the terminal's alternate screen, which covers the hint. On a terminal `rk codex` keeps
  the hint up until you press a key or 3 s pass, and prints a one-line reminder after Codex exits. From
  a script or pipe it starts Codex at once.
- `-c`/`--config` and `--dangerously-bypass-hook-trust` are refused (exit 2), because they move Codex off
  the shared daemon. Run plain `codex` for those.
- Without agentd running the hint adds a line telling you to start `agentd run`.

## Codex monitoring

Codex monitoring is disabled by default. Enable it in the existing
`~/.nexus-agentd/config.json`:

```json
"codex": {
  "enabled": true,
  "port": 8390
}
```

The daemon first tries to attach to `codex app-server` on that port. If nothing is
listening, it starts and owns an app-server process. Both paths are fixed to
`127.0.0.1`; the unauthenticated app-server WebSocket is never exposed to the network.
Codex thread snapshots, live status changes, approval requests, and phone-requested
thread starts use the already authenticated phone link. A start request creates a thread
in an existing local project directory and can begin its first turn. Threads started by
other Codex clients keep the same monitoring-only behavior as before.

The authenticated phone can also start Claude Code in an existing local project
directory. The prompt is written to the detached CLI process over stdin; user content is
never placed in its command line. Existing user-wide Claude hooks surface the new session
through the normal monitoring pipeline.

If no phone decision is available, agentd sends no approval response to Codex. The
app-server request remains pending for another subscribed Codex UI to answer and is
replayed when a client resumes the thread.

## Typing a reply from the phone

Off by default. A phone that can already watch a session should not also be able to
type into it without the owner turning that on:

```json
"allowTerminalInput": true
```

With it on, the daemon only reaches a session that is running inside `screen` or
`tmux` — it types into the multiplexer the way a person would (`screen -X stuff` /
`tmux send-keys`) rather than owning the session's process, which is also why a
session `claude --resume` would fork instead of continuing cannot be reached this
way. A session mid-turn refuses the phone's text outright: typing into a turn in
progress would land mid-thought rather than at a prompt.

## Away from home (Tailscale)

Install Tailscale on the PC and phone. At startup and every 60 seconds, the daemon
checks the local tailnet for online Android peers and tries their tailnet addresses
on the phone listener port. If automatic discovery is unavailable, read the phone's
tailnet IP from the Tailscale app and add it as a direct target:

```powershell
agentd link-phone 100.x.y.z
```

The running daemon picks up direct-target changes on its next 60-second refresh, with no
restart required. It then dials the phone directly whenever LAN broadcast discovery
cannot find it. A phone already linked at home accepts the tailnet dial without
re-pairing because the daemon uses the same machine identity. Set
`"tailnetDiscovery": false` in `config.json` to disable the Tailscale scan without
disabling direct targets or their hot reload.

## Running at logon

`scripts/run-hidden.vbs` starts the daemon with no console window. Register it once
from an elevated prompt in the `agentd` directory:

```powershell
schtasks /create /tn NexusAgentd /tr "wscript.exe //B \"$PWD\scripts\run-hidden.vbs\"" /sc onlogon /f
schtasks /run /tn NexusAgentd
```

Without elevation, dropping a shortcut to the script into `shell:startup` does the
same job. The daemon exits immediately if another instance already holds its port, so
either launcher can fire at any time to make sure one is up.

On macOS, `scripts/install-launchagent.sh` writes and loads a per-user LaunchAgent
that does the same job:

```bash
./scripts/install-launchagent.sh              # install and start
./scripts/install-launchagent.sh --uninstall  # stop and remove
```

It resolves `node` at install time, because a LaunchAgent does not inherit a login
shell's `PATH`, and deliberately sets no `KeepAlive`: a second instance exits 1 on
`EADDRINUSE`, which launchd would otherwise respawn in a tight loop for as long as
the first one holds the port. Its output goes to `~/.nexus-agentd/launchagent.out.log`
and `launchagent.err.log` alongside the daemon's own log.

**macOS privacy gates the daemon in two separate ways, and a LaunchAgent needs
both lifted.** A terminal inherits the consent its own app was granted, which is
why a manual `node dist/cli.js run` can work while the LaunchAgent does not.

*Files.* Documents, Desktop, Downloads and iCloud Drive are gated per
application, and a LaunchAgent has no app to attribute the access to nor any way
to raise the prompt: node blocks on the first read under such a folder, so the
daemon starts and hangs before binding a port, writing nothing to either log.
The install script probes for this and refuses rather than installing something
that would hang. Either grant Full Disk Access to the `node` binary in System
Settings > Privacy & Security > Full Disk Access, or keep agentd somewhere else
such as `~/nexus-agentd`.

*Local network.* Reaching the phone is gated too. Without it the daemon runs and
serves hooks, but every dial fails — the log fills with `discovery_send_failed`
and `phone_link_error`, connections to the phone return `EHOSTUNREACH`, and
approvals fall back to the computer as if no phone were paired. Enable the
interpreter under System Settings > Privacy & Security > Local Network. macOS
usually lists it only after a first attempt has been refused, so install the
agent, let it fail once, then look.

## Hook management (legacy)

`install-hooks` predates the plugin. It writes the forwarder into `~/.claude/settings.json`
for every session on the machine, which the opt-in model no longer wants; prefer the plugin
above. The commands remain for existing setups.

```powershell
node dist/cli.js install-hooks
node dist/cli.js uninstall-hooks
```

Both commands merge `~/.claude/settings.json` without replacing unrelated settings or
hooks. Before changing an existing settings file, they create a timestamped
`settings.json.agentd-backup-*` copy. Reinstalling is idempotent. Malformed JSON aborts
without writing.

The generated hook forwarder always exits successfully. Ordinary lifecycle hooks return
immediately. A `PreToolUse` hook waits for the linked phone for up to 120 seconds; set
`NEXUS_AGENTD_APPROVAL_TIMEOUT_MS` to a positive millisecond value to change that timeout.
If the daemon or phone is unavailable, the hook returns no decision so Claude Code uses
its own local permission prompt.

## Operations and verification

```powershell
node dist/cli.js status
npm test
npm run smoke
```

`status` checks the loopback health endpoint and prints whether the daemon is running plus
its session count. `npm test` uses Node's built-in test runner. `npm run smoke` starts an
isolated daemon, sends `SessionStart` and `UserPromptSubmit` with `curl`, authenticates a
WebSocket client, verifies `hello_ack`, `snapshot`, and ordered `session_upsert` frames,
prints those frames, and shuts the daemon down.

On startup, recent transcripts under `~/.claude/projects/*/*.jsonl` are shown as stale
idle sessions. They are not tailed until a hook references them. Completed sessions remain
available for 30 minutes.
