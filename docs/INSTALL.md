# Installing and building Rokid-Coder (for developers)

This is the technical guide. If you only want to use Rokid-Coder, the [README](../README.md) is the short version, and the phone app walks you through setup.

Rokid-Coder has four parts:

| Part | Where | What it is |
|---|---|---|
| Computer helper | `computer/` | Node and TypeScript: `agentd` (the daemon), `rk` (the launcher) and `rokid-setup` |
| Plugins | `plugin/` | The Claude Code and Codex plugins that opt a session in (`/rokid:on`) |
| Phone app | `mobile/app/` | One Android app. It carries the glasses app |
| Glasses app | `glasses/app/` | The glasses app. The phone app installs it |

Upstream Rokid Nexus is vendored at `vendor/nexus` as a git subtree.

## Prerequisites

- Node 22 and npm. CI uses Node 22; `computer/package.json` allows Node 20 or newer. The released installers carry their own pinned Node (`computer/runtime/node-version.txt`).
- JDK 17 and the Android SDK, for the Gradle build. The Gradle wrapper is 9.5.1.
- The CXR library checked out next to this repository at `../CxrGlobal` (Anezium/CxrGlobal v0.3.0). `vendor/CxrGlobal` is a link to it, so the vendored Nexus build finds it too. A worktree needs the directory next to it as well.
- `adb`, to install the APKs from a computer.
- `local.properties` holds your Android SDK path. It is untracked on purpose. Do not commit it.

Check out the repository and use the `release/1.0.0` branch (or the tag you want).

## Build and test from source

```bash
npm ci                              # installs the computer and plugin workspaces
(cd computer && npm test)           # builds, then runs Node's test runner
```

Gradle (run one build at a time):

```bash
./gradlew \
  :shared:testDebugUnitTest :bus-client:testDebugUnitTest :ink-engine:test \
  :phone-core:testDebugUnitTest :phone-hub:testDebugUnitTest \
  :glasses-core:testDebugUnitTest :glasses-hub:testDebugUnitTest \
  :glasses-app:testDebugUnitTest :mobile:app:testDebugUnitTest \
  --continue
```

This is the list `.github/workflows/tests.yml` runs. The upstream modules keep their upstream Gradle names (`:shared`, `:phone-hub`, ...) and live under `vendor/nexus`. CI then judges the results with `scripts/check-test-results.mjs`, which allows two known `GlassesFileStoreTest` failures by name.

To build or test one module, swap its name in:

```bash
./gradlew :mobile:app:testDebugUnitTest :mobile:app:assembleDebug
```

On a machine with little memory (the project's own Mac has 8 GB), cap Gradle:

```bash
./gradlew <tasks> -Dorg.gradle.jvmargs=-Xmx2g -Pkotlin.daemon.jvmargs=-Xmx1g --max-workers=2
```

`-PskipCxrGlobal=true` is only for modules that do not link the CXR library, such as the upstream plugins, built from `vendor/nexus`: `cd vendor/nexus && ./gradlew :plugin-relay:testDebugUnitTest -PskipCxrGlobal=true`. The hubs do link it, so building `:phone-hub` or `:glasses-hub` with that flag fails with `Could not find com.example.cxrglobal:lib`.

Other checks CI runs:

```bash
node --test "scripts/test/*.test.mjs" "scripts/test/*.test.js"   # the repo scripts
node scripts/check-docs-secrets.mjs                              # no fingerprints, tokens or pairing lines in docs
./gradlew -p build-logic test                                    # the build plugins
(cd computer && npm run check:lockfile)                          # the lockfile is fully hashed
(cd computer && npm run test:installers)                         # the installer tests
```

## The computer helper

### From the release installers

Download the installer for your computer from the [Releases page](https://github.com/debasishdebs/Rokid-Coder/releases). Requirements, the unsigned-installer warnings, pairing and uninstalling are in [`computer/README.md`](../computer/README.md).

- **macOS 13 or later:** `rokid-coder-<version>-macos-arm64.dmg` (Apple silicon) or `-macos-x64.dmg` (Intel). Open it, right-click the `.pkg` and choose Open. Setup then runs in Terminal.
- **Windows 11 22H2 or later with WSL 2:** `rokid-coder-<version>-windows-x64.exe`. It checks Windows, WSL and the firewall, then runs setup inside your WSL distro.

The installer writes `rk`, `agentd`, `rokid-setup` and `rokid-node` to `~/.rokid-coder/bin/`. `rokid-setup` has these commands:

```
rokid-setup plugins sync [--tool claude|codex]
rokid-setup plugins status --json
rokid-setup plugins remove [--tool claude|codex]
rokid-setup rollback            # back to the previous install
rokid-setup migrate-hooks
rokid-setup uninstall [--purge] [--yes]
```

### From source

```bash
npm ci
(cd computer && npm run build)
computer/installer/wrappers/install-dev.sh   # writes ~/.rokid-coder/bin/{rokid-node,agentd,rk,rokid-setup} over this checkout
~/.rokid-coder/bin/agentd run                # or: node computer/dist/cli.js run
```

`install-dev.sh` points the wrappers at your build and at the `node` on your PATH. Run it again after you move the repository or switch Node. `agentd` listens on `127.0.0.1:8791` for session hooks and on `0.0.0.0:8792` (TLS only) for the phone. Allow inbound TCP 8792 in a firewall that is on; see [`computer/README.md`](../computer/README.md) for the firewall commands and the full daemon reference.

To build a self-contained bundle yourself (what the installers carry):

```bash
(cd computer && npm run bundle -- --target darwin-arm64 --out dist-bundle --archive)
```

Targets are `darwin-arm64`, `darwin-x64` and `linux-x64`, and the build must run on a host of that target. The macOS `.pkg` and the Windows `.exe` are built by `.github/workflows/macos-installer.yml` and `windows-installer.yml`.

## The plugins

The installer sets the plugins up for every CLI it finds. From a source checkout:

```bash
claude plugin marketplace add .
claude plugin install rokid@rokid-coder
```

`claude --plugin-dir plugin/claude-code` loads the plugin for one session without installing it. For Codex, register the marketplace the same way (`codex plugin marketplace add <repository root>`), then open `/plugins` inside Codex and install Rokid-Coder. Codex has no non-interactive install step. See [`plugin/README.md`](../plugin/README.md).

In a session, `/rokid:on` attaches it, `/rokid:off` detaches it, `/rokid:status` shows its state and `/rokid:pair` opens the two-minute pairing window (in Codex: `rokid:on`, `rokid:off`, `rokid:status`, `rokid:pair`).

`plugin/*/bin/hook-forward.js` is a build output. `npm run build` in `computer/` regenerates both copies. Commit them; the computer tests fail when a copy is stale.

## Launching a session with `rk`

```bash
rk claude [claude args...]
rk codex  [codex args...]
```

`rk claude` runs Claude Code in a pseudo-terminal it owns. That is what allows compact, model change and voice follow-ups at any time. `rk codex` runs plain `codex` and tells you to type `rokid:on` inside it. On Windows both print a hint to use plugin mode until the launcher is verified there. The limits and the safety rules for typing a reply are in [`computer/README.md`](../computer/README.md).

## The phone and glasses apps

Build them with Gradle (debug builds need no signing key):

```bash
./gradlew :mobile:app:assembleDebug :glasses-app:assembleDebug
```

The phone app bundles the glasses app and installs it on the glasses over the Rokid link, so for normal use you install only the phone app.

A release build is signed by the `rokid.release-signing` build plugin. It needs `NEXUS_RELEASE_KEYSTORE`, `NEXUS_RELEASE_KEYSTORE_PASSWORD` and `NEXUS_RELEASE_KEY_ALIAS` (all three or none), and fails unless the key's certificate SHA-256 equals `rokid.releaseSignerSha256` in `gradle.properties`. `./gradlew :mobile:app:checkRelease` runs the release manifest, dex and dependency checks. See [`glasses/README.md`](../glasses/README.md).

### Installing the APKs with adb

The application ids are `io.github.debasishdebs.rokidcoder` (phone) and `io.github.debasishdebs.rokidcoder.glasses` (glasses). The phone needs Android 11 or later and the Hi Rokid app.

```bash
adb install rokid-coder-<version>.apk              # the phone, over USB or wireless debugging
adb install rokid-coder-glasses-<version>.apk      # the glasses, only if the phone's install fails
```

The second line is the fallback the phone app itself offers when the glasses refuse its push. Run it with the glasses connected to adb. Setup then continues by itself once the glasses app is on the glasses and running.

Android's wireless debugging uses two different ports, and mixing them up is the usual mistake:

```bash
adb pair <host>:<pairingPort> <six-digit code>     # the port and code shown in the "Pair device with pairing code" dialog
adb connect <host>:<connectPort>                   # the port shown on the main Wireless Debugging screen
```

`adb pair` is done once per computer. `adb connect` is what you repeat. The two ports are not the same, and the pairing code lasts a short time. (This is the sequence upstream's `vendor/nexus/BUSSPEC.md` describes for the glasses.)

First run on the glasses: open **Rokid Coder** and switch it on in the Settings accessibility list. It then sets itself up (Wireless Debugging, a pairing with itself, one permission), which takes one to two minutes. With a computer that has adb you can skip that:

```bash
adb shell pm grant io.github.debasishdebs.rokidcoder.glasses android.permission.WRITE_SECURE_SETTINGS
```

If the upstream Rokid Nexus app is installed, only one app can hold the link to the glasses. Tap Stop hub in Nexus (or force-stop or uninstall it) before Rokid Coder connects.

## Pairing

Pairing is confirmed by a 6-digit code on both screens. Nothing pairs until both sides confirm.

1. On the phone, follow setup to **Finish on your computer** and tap **Ready to pair**. This opens a two-minute window.
2. On the computer, run setup (it ends with pairing), or run `~/.rokid-coder/bin/agentd pair`, `agentd phones allow-next`, `/rokid:pair` in Claude Code, or answer `Pair now? [Y/n]` when you start `rk claude` or `rk codex`.
3. Compare the code. Type `y` on the computer and tap **Codes match** on the phone.

If the phone cannot find the computer, `agentd pair` prints a one-line pairing payload and a QR code. Scan the QR code, or paste the line into the phone. Treat that line as a credential and never paste it into a chat or an issue. A pairing that goes unused signs out after 14 days by default (the phone sets 3, 7, 14, 30 or 90).

Useful commands: `agentd status`, `agentd phones list`, `agentd phones forget <fingerprint>|--all`, `agentd link-phone <host[:port]>`.

## Away from home (Tailscale)

Install Tailscale on the phone and the computer and sign in with the same account. No re-pairing is needed. agentd asks the Tailscale CLI (`tailscale ip -4`) for the computer's tailnet address, includes it in the pairing payload, and, every 60 seconds, looks for the phone on the tailnet and dials it. If automatic discovery is not available, read the phone's tailnet IP in the Tailscale app and run `agentd link-phone 100.x.y.z`. `"tailnetDiscovery": false` in `config.json` turns the scan off. The phone app shows the same steps under Settings, Connectors, Tailscale.

On Windows with WSL in NAT mode, automatic discovery does not work: pair with the QR code or use Tailscale.

## Where things live

| What | Where |
|---|---|
| Daemon log | `~/.nexus-agentd/agentd.log` (rotated to `agentd.log.old` at 5 MB) |
| Daemon config: token, machine id, ports, `codex` and `tailnetDiscovery` | `~/.nexus-agentd/config.json` (a credential: keep it private) |
| Installed programs, `install.json`, setup journal | `~/.rokid-coder/` |
| Pinned certificates (`tls/`), `settings.json`, `launcher.sock` | `~/.rokid-coder/` |
| Claude Code's own session files, which agentd reads | `~/.claude/sessions/<pid>.json` |
| macOS installed bundle | `/Library/Application Support/RokidCoder/<version>` |
| Windows installed bundle (inside WSL) | `~/.local/share/rokid-coder/<version>` |

`NEXUS_AGENTD_STATE_DIR` moves the daemon's directory. Never put your pairing line, token or a full certificate fingerprint in a log or a bug report. To reset pairing completely, stop agentd and delete the `tls/` folder; agentd gets a new certificate and trusts no phone until you pair again.

## CI overview

| Workflow | What it does |
|---|---|
| `tests.yml` | Every product suite: the scripts, the computer daemon on Linux and macOS, the Android unit tests, the emulator and the Windows host tests. Pushes and pull requests to `release/**` run the Linux jobs; release tags and a manual `full` run add the rest |
| `bundles.yml` | Builds the computer bundles (darwin-arm64, darwin-x64, linux-x64) and tests them |
| `macos-installer.yml`, `windows-installer.yml` | Build and install-test the macOS `.pkg` and the Windows `.exe` |
| `emulator.yml` | Release checks, an unrelated app that must not reach our services, and the phone service on an emulator |
| `release.yml` | An rc tag (`rokid-coder-v<version>-rc.<n>`) builds every release file, install-tests each, and makes a draft prerelease. A final tag fails |
| `publish-release.yml` | A manual run that promotes a tested rc once `scripts/release-gate.mjs` passes |
| `upstream-sync.yml` | Weekly (Mondays): merges upstream Nexus into `vendor/nexus`, runs every suite and reports |
| `upstream-validation.yml` | Builds `vendor/nexus` on its own and runs upstream's full list |

## Vendoring and upstream sync

`vendor/nexus` is upstream [Anezium/Rokid-Nexus](https://github.com/Anezium/Rokid-Nexus), a squashed git subtree. The rules:

- Every change we make inside `vendor/nexus` is its own commit with a row in `vendor/nexus/PATCHES.md` (SHA, files, purpose, and whether it touches a must-not-touch area, which needs its own security review). Keep the Files column exact: the sync script matches conflicts against it.
- Upstream's own rules for its modules are in `vendor/nexus/AGENTS.md` and `vendor/nexus/plugins/AGENTS.md`.
- Update from upstream with `scripts/upstream-sync.sh [--remote <name or url>] [--ref <ref>]` (default `upstream main`). It runs `git subtree pull --squash`. Exit 0: merged cleanly or nothing new, and every suite must then pass on the result. Exit 2: the merge conflicts; it is aborted and the conflicted files and the `PATCHES.md` rows that touch them are printed. Exit 3: refused because the tree is dirty or a merge, rebase, cherry-pick or revert is in progress. Exit 1: anything else, such as a fetch failure.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Could not find com.example.cxrglobal:lib` | The hub build ran with `-PskipCxrGlobal=true`, or `../CxrGlobal` is missing. Check out CxrGlobal next to the repo and drop the flag |
| Gradle cannot find the Android SDK | `local.properties` is missing in this checkout (a fresh worktree has none). Add your SDK path there. Do not commit it |
| Gradle runs out of memory | Use the capped flags above and run one build at a time |
| A release build fails at once | The `NEXUS_RELEASE_*` variables are not all set, or the key does not match `rokid.releaseSignerSha256`. Use a debug build for development |
| Computer tests say a plugin `hook-forward.js` is stale | Run `npm run build` in `computer/` and commit the regenerated copies |
| `agentd` says it is not running when you pair | Start it with `agentd run`, then run `agentd pair` again |
| The phone cannot find the computer | Different networks, or WSL in NAT mode. Use the QR code or the pairing line, or Tailscale |
| The phone is refused with `repair_needed` | It has no pinned certificate. Pair it again |
| A glasses reply fails with `busy` or `not_sent` | Replies are typed into Claude's prompt and run only when Claude is idle. Try again; the phone words it as "Claude is busy with something else, wait a moment and try again" |
| The daemon runs but never reaches the phone on macOS (`EHOSTUNREACH`, `phone_link_error` in the log) | macOS Local Network privacy. Allow the interpreter under System Settings, Privacy and Security, Local Network |
| `adb connect` is refused after `adb pair` worked | You used the pairing port. Connect to the port on the main Wireless Debugging screen |
| Setup on the glasses stalls with a code such as `PAIR-STALL` or `TMO` | Retry from the setup card, or skip it with the `adb shell pm grant` command above |
| Setup says Rokid Nexus is installed | Open Nexus and tap Stop hub (or force-stop or uninstall it), then tap Retry in Rokid Coder |
| Nothing shows in the log | The log is `~/.nexus-agentd/agentd.log`. A hang before any log line on macOS under Documents, Desktop, Downloads or iCloud Drive is the privacy gate described in `computer/README.md` |
