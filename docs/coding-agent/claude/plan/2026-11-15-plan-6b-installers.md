# Rokid-Coder Plan 6b: Computer installers (macOS + Windows/WSL2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the computer side as self-contained bundles, and as installers that check first and then set up as the right user:
- macOS: a `.pkg` (inside a `.dmg`) for arm64 and for x64
- Windows: an `.exe` that installs agentd into WSL2 (U34, R4)

Plugin provisioning for both CLIs, upgrade from 0.8.0, rollback and uninstall are part of it.

**Architecture:**
- **One bundle per target** (`darwin-arm64`, `darwin-x64`, `linux-x64`): a pinned Node, the built app with its production `node_modules` (node-pty included), the two CLI plugins, and self-locating wrappers. Nothing is compiled or downloaded on the user's machine.
- **One setup program, `rokid-setup`** (TypeScript, run by the bundled Node, always as the target user, never as root). It owns every per-user step: state snapshot and check, retiring old autostart, wrappers, the CLI step, plugin provisioning, autostart, pairing, rollback and uninstall. The OS-specific parts sit behind a small `PlatformHooks` interface with two implementations: `darwin` and `wsl`.
- **The installers only do what needs the OS or privilege**, then hand over to `rokid-setup`:
  - the macOS `.pkg`: the version check, the system-wide payload, and handing setup to the console user
  - the Windows `.exe` (unelevated): the preflight, the per-user WSL binding, the scheduled task and the bundle copy. A separate elevated helper does ONLY the machine-wide firewall and port-proxy changes.

**Tech Stack:** Node 22 LTS + TypeScript (CommonJS, `node:test`), POSIX sh, `pkgbuild`/`productbuild`/`hdiutil`, NSIS 3 (Unicode), Windows PowerShell 5.1 + Pester 5, GitHub Actions (`macos-15`, `macos-15-intel`, `ubuntu-22.04` with `ubuntu:22.04`/`ubuntu:24.04` containers, `windows-latest`).

**Depends on:** Plan 6a merged. That gives us:
- the layout: `computer/` (formerly `agentd/`), `plugin/claude-code`, `plugin/codex`, the root npm workspace, and both marketplace files
- 6a T6's pairing: `agentd pair` shows the SAS code and takes `[y/N]` as a launcher-socket client (`pair_status{attempt,state,code?}` / `pair_confirm{attempt,ok}` over the 0600 socket); pairing line v2 `{v:2,kind,host,port,fp}`; the `pair-ready` announcement
- the trust boundary: a computer-side confirm alone never pairs; the phone confirm is the security step

6b can be built in parallel with 6c. 6c's T10 consumes 6b's workflow artifacts, and 6c's T13 runs the hardware gate.

**Spec:** `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md` (§13 > §12 > §11 > §10 > §8 > §1–7): §3.3, §8.3, §8.9, U32, U34, R4, R5, R10, U37, U38, §13.1, §13.4, §13.5. Also read `docs/coding-agent/HANDOFF.md`.

**Review history:** the combined Plan 6 (`2026-11-15-plan-6-v1.md`) and its reviews in `docs/coding-agent/codex/reviews/2026-11-15-plan-6-*`. This plan resolves the full re-review's (`2026-11-15-plan-6-full-rereview.md`) findings #9–#15, marked `[FR n]`. Findings from this plan's own reviews are marked `[6b-R n]`.

**Status:** **Codex READY** after 5 review rounds (`docs/coding-agent/codex/reviews/2026-11-15-plan-6b-review-{1..5}.md`). Round 5 confirmed `[6b-R21]`–`[6b-R23]`.

## Global Constraints
**Branch and commits**
- Branch `release/1.0.0`. Within a wave, tasks run in parallel worktrees, each touching only its owned paths (U15). After the last wave: ONE Codex sol review, one fix wave, then a Codex re-check.
- Commits are imperative, with NO Co-Authored-By and no AI attribution. Tasks never push; the controller does.

**Never touch**
- `local.properties` and the build environment. Never create a private SDK, Gradle home or cache in the tree. On an environment failure, stop and report.
- `~/.claude`, `~/.codex`, or the real `~/.rokid-coder` / `~/.nexus-agentd`. Every test runs with a temp `HOME` and temp state dirs. Never type `/model` into a real `claude`. No adb on the user's devices.
- Tests never run the real `claude` or `codex` CLIs, nor any vendor installer. They use recorded fakes (`computer/test/fixtures/plugin-cli/**`, `computer/test/fixtures/fake-cli/**`).
- Real installs happen only on disposable hosted CI runners, inside throwaway containers, and in the recorded gates (the user's Windows 11 laptop; a macOS 13 VM). Never on the build Mac's own user account.
- Never write a token, `steer`, the pairing line's fingerprint in full, SAS nonces or `pair_credentials` contents to setup output, installer logs or any log level `[6a-R8]`. State snapshots copy secrets file-to-file and never read them into a log line.

**Identity and versions**
- Versions come from `computer/package.json` (6c's T10 sets 1.0.0); nothing in 6b hard-codes a version. Artifact names are derived from it: `rokid-coder-<v>-macos-arm64.pkg|.dmg`, `rokid-coder-<v>-macos-x64.pkg|.dmg`, `rokid-coder-<v>-windows-x64.exe`.
- The macOS package id is `io.github.debasishdebs.rokidcoder.computer`, and the LaunchAgent label is `io.github.debasishdebs.rokidcoder.agentd`.
- The Windows scheduled task is `\RokidCoder\agentd`. The firewall group is `Rokid Coder`.
- Legacy names, retired on upgrade: the LaunchAgent `com.anezium.nexus-agentd` (`agentd/scripts/install-launchagent.sh:10`) and the Windows task `NexusAgentd` (`agentd/scripts/run-hidden.vbs:5`).

**Runtimes**
- Node 22 LTS, pinned to an exact patch in `computer/runtime/node-version.txt`, with the official `SHASUMS256.txt` digests for each target and for the headers tarball in `computer/runtime/node-checksums.txt`.
- Hooks, the LaunchAgent and the scheduled task call `rokid-node` or the `agentd` wrapper, never bare `node` (R5).
- macOS: the minimum is 13.0. Every Mach-O in the bundle has `minos ≤ 13.0`. Bundle building never rewrites a Mach-O (no strip, no `install_name_tool`), so the ad-hoc or vendor signatures stay valid on Apple silicon.
- Linux (WSL only, §4): the floor is glibc 2.35 (Ubuntu 22.04). Ubuntu 22.04 and 24.04 are tested.

**Security (U8, U9, R1′, 6a)**
- Pinned mutual TLS on every computer↔phone link is unchanged. Every new pairing passes 6a's SAS check.
- Setup's pairing step is 6a's `agentd pair`, inheriting the terminal. Setup never sends `pair_confirm` itself, and a non-interactive answers file cannot confirm a pairing.
- Firewall changes are scoped (port, protocol, profile, remote addresses, the WSL VM creator id). Never `DefaultInboundAction Allow`, and never router forwarding (§13.4).

**Suites**
- `cd computer && npm test` (it now includes the setup, wrapper, version and selfcheck tests)
- `cd computer && npm run test:installers` (the macOS shell-script tests through `node:test`, with fake system commands)
- Pester: `computer/installer/windows/test/*.Tests.ps1`
- The CI jobs `bundles.yml`, `macos-installer.yml` and `windows-installer.yml`
- 6b changes no Android code. At the end, the controller runs 6a's frozen product suite list once, as a regression check.

## Layout on the user's machine
These definitions are used by every task.

| What | macOS | Windows (inside the WSL distro unless stated) |
|---|---|---|
| **Bundle (program, read-only)** | `/Library/Application Support/RokidCoder/<v>/` (root-owned). The previous version's dir is kept for rollback; older ones are pruned. | `~/.local/share/rokid-coder/<v>/` (user-owned), with the previous version kept |
| **User program files** | `~/.rokid-coder/bin/{rokid-node,agentd,rk,rokid-setup}` (one-line wrappers that exec the absolute versioned bundle path); `~/.rokid-coder/env` (0600: the daemon's PATH); `~/.rokid-coder/install.json` (0600: the install manifest) | the same paths in the WSL home. Plus, on Windows, `%LOCALAPPDATA%\Programs\RokidCoder\` (the NSIS install and uninstaller) with per-generation `<gen>\start-agentd.ps1` and `<gen>\task.xml`, and `%LOCALAPPDATA%\RokidCoder\binding-<gen>.json` `[6b-R10, 6b-R21]`. The committed generation's files and those of its `previous` are kept, like the bundles. |
| **State (kept unless `--purge`)** | `~/.nexus-agentd/**` (config: token, machineId, ports), and `<rokidCoder.stateDir>/**` (default `~/.rokid-coder`: tls, pins, steer, settings, attached), minus the user program files above. `~/.rokid-coder/backups/` (0700) holds the last state snapshot. | the same, in the WSL home |
| **Machine-wide records** | `/Library/Application Support/RokidCoder/installed-version`, `handoff/<uid>.json` | `%ProgramData%\RokidCoder\machine-state.json` (the firewall rules and proxy entry this product created) |
| **PATH** | a marked block `# >>> rokid-coder >>>` … `# <<< rokid-coder <<<` in `~/.zprofile` (and `~/.bash_profile` when the login shell is bash) | a marked block in `~/.profile` |

`rokidCoder.stateDir` is read from the existing config, so a custom state dir set in 0.8.0 is honoured (`agentd/src/config.ts:125-129`).

## Waves and file ownership
A task edits only its paths. A later wave may edit an earlier wave's paths.

| Wave | Task | Owns |
|---|---|---|
| 1 | **T7a** bundles, wrappers, `--version`, `selfcheck`, hook commands | `computer/runtime/**`; `computer/installer/bundle/**`; `computer/installer/wrappers/**`; `computer/src/{version,selfcheck,wrappers}.ts`; `computer/src/cli.ts` (the `--version`/`version` and `selfcheck` dispatch, and the `pair` exit status if 6a left it undefined); `computer/src/http-server.ts` (only the `/health` identity fields) `[6b-R4]`; `computer/package.json` (`scripts` only); `plugin/claude-code/hooks/hooks.json`; `plugin/codex/hooks/hooks.json`; `computer/test/{bundle,version,selfcheck,wrappers,hooks-runtime}*.test.js`; `.github/workflows/bundles.yml` |
| 1 | **T9** `rk` offers to install a missing CLI | `computer/src/launcher/cli-install.ts`; in `computer/src/rk.ts`, the executable resolution of `runClaude` and `runCodex`, which T9 moves to the first statement of each (from `rk.ts:258-261` and `rk.ts:598-601`) `[6b-R2]`; `computer/test/{cli-install,rk-cli-install}.test.js`; `computer/test/fixtures/fake-cli/**` |
| 2 | **T7p** `rokid-setup`: plugins, state, migration, rollback, uninstall core | `computer/src/setup/**`, except `computer/src/setup/platform/{darwin,wsl}.ts`; `computer/test/setup-*.test.js`; `computer/test/fixtures/plugin-cli/**`; `computer/test/fixtures/state-0.8.0/**` |
| 3 | **T7b** macOS installer | `computer/installer/macos/**`; `computer/src/setup/platform/darwin.ts`; `computer/test/setup-platform-darwin.test.js`; `.github/workflows/macos-installer.yml`; `docs/coding-agent/releases/1.0.0-macos-gate.md` |
| 3 | **T8** Windows installer into WSL2 | `computer/installer/windows/**`; `computer/src/setup/platform/wsl.ts`; `computer/src/advertise.ts`, and the advertised host/port call sites in `computer/src/pairing.ts` and `computer/src/pairing/**` (the pairing line, `pair-ready` and `pair_credentials{wsHost,wsPort}`; only those lines) `[6b-R3]`; the `advertise set|show` subcommand dispatch in `computer/src/setup/main.ts` (a wave-3 edit to a wave-2 file); `computer/src/tailnet-discovery.ts`; `computer/src/launcher/windows-gate.ts`, plus one call in `computer/src/rk.ts` in `runClaude`/`runCodex`, placed directly AFTER T9's resolution block `[6b-R2]`; `computer/test/{setup-platform-wsl,advertise,tailnet-discovery,windows-gate}.test.js`; `.github/workflows/windows-installer.yml`; `docs/coding-agent/releases/1.0.0-windows-gate.md` |

- T9 and T8 both touch `rk.ts`, but in different waves and at different lines.
- T7a creates the bundle's `bin/rokid-setup` wrapper in wave 1. The file it points to, `app/dist/setup/main.js`, arrives with T7p in wave 2. T7a's tests use a stub setup entry.
- **Interfaces 6c consumes:**
  - Each workflow also runs `on: workflow_call`, and uploads artifacts named `bundle-<target>` (T7a's archive and its `.sha256`), `macos-pkg-<arch>` (the pkg and dmg) and `windows-exe`.
  - 6c's T10 `release.yml` calls these workflows. It publishes only when they and both recorded gates (T7b Step 5, T8 Step 5) pass.

## Review Focus
1. **Upgrading a Mac that runs 0.8.0** (a repo checkout, the LaunchAgent `com.anezium.nexus-agentd` holding 8791/8792, the repo marketplace, a paired phone).
   - Expected, in this order:
     1. Setup asks for consent, then retires the old LaunchAgent. The daemon is now quiesced.
     2. It snapshots the STATE paths of both locations, and checks them non-destructively with the new code.
     3. It re-points the `rokid-coder` marketplace to the bundle.
     4. It starts the new agent and proves its identity through `/health`.

     The phone stays paired. An upgrade between two installer releases follows the same transaction, stopping the running product daemon first.
   - A failure injected after the new agent starts restores the old LaunchAgent, the state and the old marketplace source.
   - Tests: T7p `upgrade_from_0_8_0_keeps_pairings_and_retires_old_agent`, `failure_after_autostart_rolls_back_everything`; T7b CI `real_0_8_0_upgrade_on_runner`.
2. **Who setup runs as on macOS.** Expected:
   - A GUI install hands setup to the eligible console user, in Terminal, with HOME/USER/SHELL taken from the directory service.
   - `sudo installer` (where `COMMAND_LINE_INSTALL` is set) never guesses: it installs the payload, then prints and logs the `rokid-setup` command.
   - With no eligible user (loginwindow, root, uid < 501, no home), the install still completes and leaves a pending marker plus the dmg's `Rokid Coder Setup.command`.
   - Tests: T7b `resolve_console_user_*`, `cli_install_defers_setup`, `setup_as_special_char_user_runs_under_that_uid`, `gui_session_setup_reaches_first_prompt_as_console_user`.
3. **Windows elevation under another account** (over-the-shoulder UAC). Expected:
   - The `.exe` runs unelevated as the session user, and that user's own distro and Linux user are bound.
   - Only `machine.ps1`, elevated, changes firewall and proxy settings, and it touches no profile.
   - The scheduled task uses the persisted SID, distro, Linux user and absolute agentd path, with no `~`.
   - Tests: T8 `elevated_helper_changes_only_machine_scope`, `binding_persisted_and_reused_by_task`, `task_xml_has_no_tilde_and_absolute_paths`, `refuses_when_process_user_is_not_session_user`.
4. **Mirrored networking unavailable on Windows** (WSL too old, the user declines, or verification shows NAT). Expected:
   - The NAT fallback uses one port-proxy entry, `0.0.0.0:8794 → 127.0.0.1:8792`, through WSL localhost forwarding, so a changed WSL IP needs no refresh. A host firewall rule is scoped to 8794.
   - agentd advertises the Windows host's LAN/tailnet IPv4 and port 8794, from the persisted `advertise.json`, in the QR, in `pair-ready` and in `pair_credentials`. That holds for every pairing client, including one started from another terminal.
   - Setup says automatic discovery is unavailable in this mode and offers the QR or Tailscale.
   - Uninstall removes only the recorded entry and rules.
   - Tests: T8 `nat_fallback_proxy_targets_localhost_forwarding`, `nat_mode_install_on_wsl_below_mirrored_min`, `pair_credentials_carry_advertised_endpoint`, `pair_from_another_terminal_uses_persisted_endpoint`, `uninstall_removes_only_recorded_proxy_and_rules`; gate items W4–W5.
5. **"Self-contained" proven, not asserted.** Expected:
   - **Linux:** the bundle runs in clean `ubuntu:22.04`/`24.04` containers with no Node and no compiler, under `strace -f -e execve`.
   - **macOS:** CI moves every Node binary and the Xcode/CLT toolchains aside before installing, then runs hooks, the daemon and a real PTY under a deny-by-default `sandbox-exec` exec allowlist.
   - **Both:** `agentd selfcheck` reports `execPath` and every loaded native object, and all of them must be inside the bundle.
   - Tests: T7a `bundle_runs_in_clean_container`, `selfcheck_spawns_real_pty_and_all_natives_inside_bundle`, `hooks_daemon_and_pty_under_exec_allowlist`; T7b `install_with_toolchains_removed`.

---

### Task 7a: Computer bundles, wrappers, `agentd --version`, `agentd selfcheck` (R5) `[FR 10, FR 12]`

**Files:** see the ownership table.
- Create:
  - `computer/runtime/node-version.txt` and `computer/runtime/node-checksums.txt`
  - `computer/installer/bundle/{build,verify-bundle}.mjs`
  - `computer/installer/bundle/bundle-layout.json` (the expected file list) and `exec-allowlist.sb`
  - `computer/installer/wrappers/{rokid-node,agentd,rk,rokid-setup}.sh` (the bundle `bin/` templates)
  - `computer/installer/wrappers/install-dev.sh` (developer wrappers over a repo build)
  - `computer/src/{version,selfcheck,wrappers}.ts`
  - the tests
  - `.github/workflows/bundles.yml`
- Modify:
  - `computer/src/cli.ts`
  - `computer/package.json` (`scripts.bundle`, `scripts.test:installers`)
  - both `hooks.json` files

**Interfaces:**
- **`build.mjs --target <darwin-arm64|darwin-x64|linux-x64> --out dist-bundle/`** writes `dist-bundle/<target>/`:
  - `node/`: the official Node archive for the pin, with its digest checked against `node-checksums.txt`. A mismatch aborts.
  - `app/`: `dist/` plus production `node_modules`, installed with the pinned Node's own npm (`--omit=dev --ignore-scripts`) from the lockfile 6a T1 left in place. Then exactly one native step runs:
    - darwin: keep node-pty's N-API prebuild for the target, and `chmod 0755` its `spawn-helper` (the 0.8.0 postinstall bug, `agentd/scripts/postinstall.js:2-6`)
    - linux-x64: `node-gyp rebuild` for node-pty, against the checksum-verified headers tarball (`--nodedir`), on `ubuntu-22.04`

    No other package's install scripts run.
  - `plugins/`: `.claude-plugin/marketplace.json` (name `rokid-coder`, plugin `rokid`, source `./claude-code`); `.agents/plugins/marketplace.json` (name `rokid-coder`, source path `./codex`); and `claude-code/` and `codex/`, copied from `plugin/` with the built `bin/hook-forward.js` `[FR 9]`
  - `bin/{rokid-node,agentd,rk,rokid-setup}`: POSIX sh using only shell builtins, so they exec nothing but the bundled node `[6b-R8]`.
    - Each finds its own directory: `case $0 in */*) d=${0%/*};; *) d=.;; esac; d=$(CDPATH= cd -- "$d" && pwd -P)`. There is no `dirname` or `readlink`.
    - It then execs `"$d/../node/bin/node"` on `../app/dist/{cli,rk,setup/main}.js`, so the bundle runs from any path.
  - `bundle.json`: `{version, target, node, nodePtyMode:"napi-prebuild"|"source-built", builtFrom:<git sha>}`
- **The archive contract** `[6b-R9]`:
  - `build.mjs --archive` also writes `dist-bundle/rokid-coder-bundle-<v>-<target>.tar.gz`, as a pax-format tar from inside `<target>/`. It preserves modes, symlinks and dotfiles (`.claude-plugin/`, `.agents/`).
  - Beside it is `<name>.sha256`. The archive and its digest are the ONLY form that leaves T7a's job. `upload-artifact` loses modes and hidden files, so the directory itself is never uploaded.
  - **Validation, split by what a runner can execute** `[6b-R15]`:
    - **Runtime validation** happens only on a native runner, in `bundles.yml`, against the EXACT archive that is uploaded: extract, `verify-bundle.mjs`, `selfcheck --require-bundle`, and the controlled run below. Only after that passes does the job write `<name>.validated.json` (`{sha256, target, runner, checks}`) into the artifact.
    - **Every consumer** (T7b, T8, 6c's T10) checks the digest, and checks that it equals `validated.json`'s `sha256`. It then runs `verify-bundle.mjs --static` on the extracted copy, or, on Windows, against the tar listing: the layout manifest, the mode bits from the tar headers, both marketplace files.
    - macOS consumers also re-run `selfcheck` (they are native). The Windows job never executes the Linux bundle; it runs for real only in the WSL gate.
- **`/health` identity** `[6b-R4]`: `http-server.ts` adds `agentdVersion` (from `package.json`), `execPath` (realpath of `process.execPath`) and `bundleRoot|null` to the existing `/health` body (`agentd/src/http-server.ts:32-37`). It is loopback-only and carries no secrets. Setup uses it to prove that the NEW bundle is the one running.
- **`wrappers.ts`:**
  - `renderUserWrapper(name, bundleDir): string`. It produces a two-line sh script that execs the single-quoted absolute bundle path (with `'` escaped). The `agentd` wrapper first sources `"$HOME/.rokid-coder/env"` when it exists.
  - `installUserWrappers(home, bundleDir)` writes them atomically (temp file + rename, mode 0755).
  - T7p uses both.
- **Hook commands** (`[FR 12]`, R5): every command in both `hooks.json` files becomes `"$HOME/.rokid-coder/bin/rokid-node" "${CLAUDE_PLUGIN_ROOT}/bin/hook-forward.js"` (Codex: `${PLUGIN_ROOT}`), keeping today's env prefixes and timeouts. Developers without the installer run `computer/installer/wrappers/install-dev.sh`. It writes the same wrappers, pointing at the repo build and the absolute `node` it resolved at that moment.
- **`agentd --version` (also `-v` and `version`)** `[FR 12]`:
  - It prints `agentd <v> node <process.version> <platform>-<arch>`.
  - `--json` prints `{agentd, node, platform, arch, execPath, bundleRoot|null}`. `bundleRoot` is the realpath two levels above `execPath` when a `bundle.json` sits there.
  - It is dispatched before any state access (today the unknown-command branch catches it, `cli.ts:238-240`), so it creates no files and works with a corrupt config.
- **`agentd selfcheck [--json] [--require-bundle]`** `[FR 12]`:
  1. loads node-pty, and spawns a REAL PTY: `/bin/sh -c 'printf rokid-pty-ok'`, with a 5 s timeout
  2. collects `process.execPath` (realpath) and every loaded native object from `process.report.getReport().sharedObjects` that ends in `.node`, plus `spawn-helper` on darwin
  3. checks `process.version` against `node-version.txt` (when bundled)

  - `--require-bundle` fails if any collected path is outside `bundleRoot`.
  - JSON output: `{ok, node, execPath, bundleRoot, pty:{output, exitCode}, natives:[…], outside:[…]}`. The exit status is 0 only when `ok`.
  - It touches no state dir.
- **`agentd pair` exit status:** setup (T7p) reads it as 0 = paired (PINNED and credentials committed), anything else = not paired. If 6a's CLI doesn't already return that, T7a makes it do so.
- **`bundles.yml`** `[FR 10]`:

  | Target | Build runner | Test runner(s) |
  |---|---|---|
  | `darwin-arm64` | `macos-15` | `macos-15` |
  | `darwin-x64` | `macos-15-intel` (GitHub's supported Intel image; `macos-13` was retired in Dec 2025) | `macos-15-intel` |
  | `linux-x64` | `ubuntu-22.04` | `ubuntu:22.04` and `ubuntu:24.04` containers |

  - `MACOSX_DEPLOYMENT_TARGET=13.0` is set for every macOS build step.
  - The minimum OS is proven separately: a static `minos` check here, and T7b's recorded macOS 13 VM run.
  - When GitHub retires `macos-15-intel` (announced for Aug 2027), the x64 build moves to cross-building on arm64 and testing under Rosetta. That isn't needed for 1.0.

- [ ] **Step 1: Write the failing tests** (`computer/test/`; the CI-only ones are marked):
  - `version_command_prints_versions_and_touches_no_state`: a temp HOME, then no files created; it works with a corrupt `config.json`; `--json` keys match.
  - `selfcheck_spawns_real_pty_and_all_natives_inside_bundle`: run on the built bundle with `--require-bundle`. It asserts `pty.output == "rokid-pty-ok"`, `outside == []`, and that `natives` includes node-pty's `pty.node`.
  - `selfcheck_fails_when_a_native_loads_from_outside` (a fixture bundle whose node-pty resolves to the repo's `node_modules`).
  - `bundle_layout_matches_manifest` (against `bundle-layout.json`). Its checks:
    - no dev dependencies, no `typescript`
    - `spawn-helper` has mode 0755
    - plugin manifests equal the sources
    - the marketplace sources resolve inside `plugins/`
  - `every_macho_minos_at_most_13_0` (darwin): it parses `otool -l` for `LC_BUILD_VERSION` and `LC_VERSION_MIN_MACOSX`. `codesign --verify` passes on each Mach-O.
  - `linux_bundle_glibc_floor_is_2_35`: the highest `GLIBC_` version required by `objdump -T` across `node` and `pty.node` is ≤ 2.35.
  - `wrappers_and_hooks_work_from_a_path_with_spaces_and_non_ascii`: the bundle is copied to `…/Rokid Tëst/b ü/`, and HOME is `…/Hömé dir/`. Then:
    - user wrappers rendered with `renderUserWrapper`
    - every hook command from the BUNDLED `hooks.json` run via `/bin/sh -c`
  - `hooks_never_call_bare_node`: every command starts with the quoted `rokid-node` path, and no `node ` token appears elsewhere.
  - `bundled_hooks_reach_daemon_with_controlled_env`: start the bundled `agentd run` with a temp state dir and non-default ports. Then pipe a `UserPromptSubmit` payload with prompt `rokid:on` through each bundled hook command, under `env -i HOME=<temp> PATH=/usr/bin:/bin LANG=C.UTF-8 NEXUS_AGENTD_HTTP_PORT=<port>`. The forwarder's reply contains `Attached to Rokid-Coder`.
  - `node_download_digest_mismatch_aborts_build`
  - `bundle_wrappers_use_only_builtins` (a static check: no command but `cd`, `pwd`, `exec`, `.`, `case` and the bundled node)
  - `health_reports_version_and_exec_path`
  - `archive_round_trip_preserves_modes_and_dotfiles` (archive, extract, then `verify-bundle.mjs`)
  - **The controlled run, used by both CI checks below:**
    - The daemon config has `tailnetDiscovery:false` and `codex.enabled:false`, so the daemon has no reason to exec any external tool.
    - The four checks are: `agentd --version --json`, `agentd selfcheck --require-bundle`, daemon startup + `/health` (whose `execPath` must be the bundled node), and the hook test above.
  - **CI `bundle_runs_in_clean_container`** (linux-x64): `docker run --rm` on `ubuntu:22.04` and on `ubuntu:24.04`, with the extracted archive mounted read-only.
    1. First `apt-get install -y --no-install-recommends strace`. The tracer is the only package added; it is not a runtime or a toolchain.
    2. Then assert that `command -v node nodejs npm cc gcc g++ make python3` all fail.
    3. Then run the four checks under `strace -f -e trace=execve -o exec.log`.
    4. Every successful `execve` path in `exec.log` must be inside the bundle, or in `{/bin/sh, /usr/bin/sh, /bin/dash}` (the hook runner).
  - **CI `hooks_daemon_and_pty_under_exec_allowlist`** (darwin, both runners):
    - Run the four checks under `sandbox-exec` with a profile that denies `process-exec` by default.
    - It allows only `(subpath "<bundle>")`, `/bin/sh`, `/bin/bash`, `/bin/zsh` (the macOS `/bin/sh` re-execs one of them) and `/usr/bin/env`. The wrappers need nothing else (`bundle_wrappers_use_only_builtins`).
    - A forced test calls `/usr/bin/cc` or a Homebrew `node` and must fail with EPERM, which proves the profile bites.
    - The profile file is committed as `computer/installer/bundle/exec-allowlist.sb`.
- [ ] **Step 2:** Implement: `build.mjs`, `verify-bundle.mjs`, the wrappers, `version.ts`, `selfcheck.ts`, the `cli.ts` dispatch, the `/health` fields, the hook commands, and `bundles.yml` (build, archive, test the EXTRACTED archive, and upload `bundle-<target>`; plus `workflow_call`).
- [ ] **Step 3:** Green: `cd computer && npm test`, and `bundles.yml` on all three targets. Commit `Build self-contained computer bundles with a pinned Node and prove they need nothing else`.

### Task 9: `rk` offers to install a missing Claude Code or Codex (§2) `[FR 9]`

**Files:** see the ownership table.

**Interfaces:**
- **`offerCliInstall(tool: "claude" | "codex", io: CliInstallIo): Promise<"installed" | "skipped" | "failed" | "manual">`**
  - It prints the vendor's official install command, and runs it only after `[y/N]` = `y`.
  - With a non-TTY stdin, it never prompts: it prints the command and returns `"skipped"`.
- **The commands live in `cli-install.ts` as a table**, `{tool, platform, command, docsUrl, requires}`. At implementation time, check each one against the vendor docs page named in the row, and record the date.
  - **Claude Code:** Anthropic's native installer script (a `curl … | bash` form) on macOS and Linux/WSL.
  - **Codex:** OpenAI's documented method. If that method needs npm or Homebrew and neither is on PATH, the result is `"manual"`, with the docs URL. The bundled `rokid-node` is NEVER used to run `npm -g`, so the user's CLI never depends on our runtime.
- **After `"installed"`:**
  1. re-resolve the CLI with the T7p resolver order: PATH, then the known install dirs `~/.local/bin`, `~/.npm-global/bin`, `/opt/homebrew/bin`, `/usr/local/bin`
  2. run `"<process.execPath>" "<dist>/setup/main.js" cli-installed --tool <tool> --json` (T7p's contract)

  That provisions the plugin and refreshes the daemon's PATH `[FR 9]`. A non-zero exit prints `Plugin setup failed — run: rokid-setup plugins sync`. `rk` itself never fails because of it.
- **The `rk.ts` hook** `[6b-R2]`: T9 moves the executable resolution to the FIRST statement of `runClaude` (today `rk.ts:258-261`, after the banner and `saveTerminal()`) and of `runCodex` (`rk.ts:598-601`). That way the offer happens before anything else, in a cooked terminal.
  - When the resolve returns nothing, it calls `offerCliInstall`.
  - On `"installed"`, it resolves once more and continues with that absolute path.
  - Otherwise it prints today's message and exits 127.

  T8's Windows launcher gate goes directly after this block, so a Windows user with neither CLI still gets the offer, and the plugin provisioning, before the plugin-mode hint.

- [ ] **Step 1: Write the failing tests** (fakes only: a fake vendor install script that drops a fake `claude` into a temp `~/.local/bin`, and a fake setup entry that records its argv):
  - `neither_cli_install_offers_official_installer_and_never_runs_unconfirmed` (`n`, Enter and EOF all mean no run)
  - `non_tty_never_prompts_prints_command`
  - `install_failure_prints_command_to_run_manually`
  - `codex_without_npm_or_brew_is_manual_with_docs_url`
  - `never_uses_bundled_node_for_npm`
  - `installed_cli_triggers_cli_installed_setup_contract` (exact argv)
  - `cli_installed_failure_does_not_fail_rk`
  - `rk_claude_continues_after_install_with_resolved_path`
  - `resolution_runs_before_banner_pairing_and_raw_mode` (for both `rk claude` and `rk codex`)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Green. Commit `Offer to install Claude Code or Codex when rk cannot find it`.

### Task 7p: `rokid-setup`: plugin provisioning, state, migration, rollback and uninstall `[FR 9, FR 15]`

**Files:** see the ownership table.
- Create:
  - `computer/src/setup/{main,orchestrator,answers,manifest,resolve-cli,plugins,state,legacy,uninstall,pair-step,profile-path}.ts`
  - `computer/src/setup/platform/{index,fake}.ts`
  - the tests and fixtures

**Interfaces:**
- **CLI (`app/dist/setup/main.js`, the bundle's `bin/rokid-setup`):**

  | Command | What it does |
  |---|---|
  | `install --platform darwin\|wsl --bundle <dir> [--answers <file>] [--binding <file> --task-xml <file>]` | the full user setup, below. The two wsl-only files are T8's staged, versioned binding and task definition, recorded in `install.json`. |
  | `plugins sync [--tool claude\|codex] [--json]` | the idempotent provisioning, below |
  | `plugins remove [--tool …]`, `plugins status --json` | removal and status |
  | `cli-installed --tool <t> --json` | plugin sync for that tool, then `PlatformHooks.refreshDaemonEnv()` (T9 calls this) |
  | `rollback` | restores the previous install recorded in `install.json`, while it exists |
  | `uninstall [--purge] [--yes]` | the per-user removal |

  It refuses to run as uid 0, saying `Run Rokid Coder setup as yourself, not as root`.
- **`PlatformHooks`** (implemented by T7b's `darwin.ts` and T8's `wsl.ts`; `fake.ts` serves tests):
  ```ts
  interface PlatformHooks {
    name: "darwin" | "wsl";
    legacyAutostart(): Promise<LegacyAutostart | undefined>; // found, not yet changed
    retireLegacyAutostart(found: LegacyAutostart): Promise<RetiredRecord>; // reversible
    restoreLegacyAutostart(record: RetiredRecord): Promise<void>;
    portOwners(ports: number[]): Promise<Array<{ port: number; pid: number; exe: string; owner: "current" | "legacy" | "other" }>>;
    stopCurrent(m: InstallManifest): Promise<void>;   // stop the recorded product daemon and its autostart job; resolves only after the process has exited and 8791/8792 are free
    installAutostart(m: InstallManifest): Promise<"running" | "pending_next_login">; // REPLACES a loaded job of the same name
    refreshDaemonEnv(m: InstallManifest): Promise<void>;          // rewrite ~/.rokid-coder/env, then restart agentd
    removeAutostart(m: InstallManifest): Promise<void>;
    tailscalePresent(): Promise<boolean>;
  }
  ```
  `owner` is `current` when the process's executable realpath is the recorded bundle's node, `legacy` when it matches a found legacy install (e.g. the 0.8.0 plist's `ProgramArguments`), and `other` otherwise.
- **`install.json` (manifest v1, 0600):**
  - `{schema:1, version, platform, bundleDir, installedAt`
  - `clis:{claude?:{path,version}, codex?:{path,version}}`
  - `plugins:{claude?:PluginRecord, codex?:PluginRecord}`
  - `autostart:{kind:"launchd"|"wsl-task", label}`
  - `binding?` (WSL: T8's `binding-<gen>.json` contents, plus the binding and `task.xml` paths, each stored TWICE as `{win, linux}`. `win` is what `user-setup.ps1` wrote, and `linux` is its `wslpath -u` `[6b-R18]`.)
  - `previous?:{version, bundleDir, manifest?, retiredLegacy?, pluginSources?, snapshot}}`

  It is written last, as the commit point of an install or upgrade.
- **The CLI resolver (`resolve-cli.ts`):**
  1. `$SHELL -lc 'command -v <tool>'`, with sentinel-delimited output, so rc-file noise is ignored
  2. `$SHELL -lic …`
  3. the known dirs in T9's order

  It records the absolute path and `<tool> --version` output (the fakes in tests).
  - **Interpreters** `[6b-R20]`: if the resolved file is a script whose shebang is `#!/usr/bin/env <x>` (for example npm's Codex launcher, `#!/usr/bin/env node`) or an absolute `#!<path>`, the resolver also resolves `<x>` with the same login-shell order and records its directory. This is the user's own Node for their CLI, never `rokid-node`.
  - **The daemon PATH** in `~/.rokid-coder/env` is `/usr/bin:/bin:/usr/sbin:/sbin` plus the CLI dirs plus the interpreter dirs, quoted. That keeps the existing LaunchAgent script's behaviour of including both `node`'s and `claude`'s dirs (`install-launchagent.sh:33-41`).
  - **Verified under that exact env:** `env -i HOME=<home> PATH=<generated> <cli> --version` must succeed. Setup runs it at step 7 and in every `refreshDaemonEnv`. A failure doesn't fail the install, because the CLIs are optional. The summary says `agentd won't be able to start <cli> at login: <reason>`, with the fix.
- **Plugin provisioning (`plugins.ts`)** `[FR 9]`:
  - **Source:** `<bundleDir>/plugins/`, the versioned, read-only bundle itself. Nothing is copied `[6b-R11]`.
    - Each version's plugins therefore stay at their own path for as long as that bundle is kept, and it is kept while it is `previous`.
    - An upgrade re-points the `rokid-coder` marketplace from the old bundle's path to the new one (sync step 2), and records the old path, plus the plugin version the CLI reported, in the journal and in `previous.pluginSources`.
  - **Driver:** one per CLI, `PluginDriver { status(); addMarketplace(dir); removeMarketplace(); installPlugin(); updatePlugin(); removePlugin() }`. Each method runs the vendor CLI's own plugin commands with `execFile` (absolute CLI path, argv array, no shell). Setup NEVER edits `~/.claude/**` or `~/.codex/**` files directly. The one exception is the legacy-hooks removal below, which goes through the existing `uninstallHooks()` with its backup.
    - **Claude:** `claude plugin marketplace add <dir>`, `claude plugin install rokid@rokid-coder`, plus the matching `list`/`update`/`uninstall`/`marketplace remove` (as in `agentd/README.md:36-37`).
    - **Codex:** `codex plugin marketplace add <dir>` (Plan 1, T-codex spike), plus the matching install, list and remove verbs.
  - **Step 0 spike (implementation time):**
    - Record `claude plugin --help` and `codex plugin --help` (and their subcommands) and one sample output of each list or status command. The fixtures go in `computer/test/fixtures/plugin-cli/<tool>-<version>/`.
    - Pin each verb in the driver from them.
    - If a CLI has NO non-interactive plugin-install verb, its driver registers the marketplace and returns `manual_step_required`, with the exact in-CLI step (e.g. "In Codex, open /plugins and install Rokid-Coder"). The setup summary shows it.
    - This spike only runs `--help` and list commands, in a temp HOME. It never installs into the real user config.
  - **`sync(tool)`, the idempotent algorithm:**
    1. Read `status()`.
    2. If the marketplace `rokid-coder` is missing, add it. If it exists with another source (e.g. 0.8.0's repo checkout), record the old source in `previous.pluginSources`, remove it, and add ours.
    3. If the plugin is missing, install it. If it's at another version, update it (or uninstall and reinstall, if the CLI has no update).
    4. Re-read `status()`. The result is `ok`, `manual_step_required` or `failed(reason)`.

    Running it twice is a no-op the second time.
  - **When it runs:**
    - setup's plugin step, for each CLI present after the CLI step
    - `cli-installed` (T9's later install)
    - every upgrade (the plugin moves to the new version)
    - `plugins sync` by hand
  - **Restore:** `restore(tool, record)` puts the recorded registration back `[6b-R11]`:
    1. re-point the marketplace to `record.source`
    2. install or update until `status()` reports `record.pluginVersion`. If the CLI has no update, uninstall and reinstall, which also refreshes the vendor's installed copy (for example Claude's plugin cache).
    3. verify by reading the plugin version and the `bin/hook-forward.js` digest that the CLI reports or that its installed copy holds
  - **Removal:** `remove(tool)` uninstalls the plugin, then removes the marketplace, but only if its source is under one of our bundle roots. It runs before the bundle is deleted.
- **Legacy (`legacy.ts`)** `[FR 15]`. It finds everything 0.8.0 left behind:
  - (a) the old autostart, via `PlatformHooks.legacyAutostart()`
  - (b) Claude hooks written by 0.8.0's `install-hooks` into `~/.claude/settings.json` (`settings.ts` `containsForwarder`). They would double-forward next to the plugin, so with consent they are removed via the existing `uninstallHooks()`, which writes a backup.
  - (c) a repo-sourced `rokid-coder` marketplace, which (b) of the sync above re-points
  - (d) a manually started agentd holding 8791/8792 (`owner:"other"` from `portOwners`). Setup never kills it. It prints `Stop the agentd running in another terminal (pid N), then press Enter` and checks again.
- **The path inventory (`state.ts`)** `[6b-R5]`. Every path under the two locations is in exactly one class:
  - **STATE:**
    - in `~/.nexus-agentd/`: everything except `*.log`
    - in `<rokidCoder.stateDir>/`: everything except the PROGRAM and TRANSACTION paths below, `logs/` and `*.sock`
  - **PROGRAM:** `bin/`, `env` and `install.json` under `~/.rokid-coder/`
  - **TRANSACTION:** `setup-journal.json` and `backups/` under `~/.rokid-coder/`

  Snapshot and restore handle only STATE paths. Restore never touches PROGRAM or TRANSACTION paths, even when `rokidCoder.stateDir` is the default `~/.rokid-coder` and the classes share one directory.
- **State operations (`state.ts`)** `[FR 15]`:
  - `snapshot()` copies the STATE paths into `~/.rokid-coder/backups/<UTC ts>-<fromVersion>/`, recording each relative path in `inventory.json`.
    - It runs only once the daemon is QUIESCED (orchestrator step 3), so no process writes state while it is copied.
    - The snapshot dir is 0700 and its files 0600.
    - Older snapshots are pruned only after the commit point, so the last good one is always kept.
  - `check(snapshotDir)` runs the NEW code's loaders against a temp COPY of the snapshot, with `rokidCoder.stateDir` re-pointed into the copy: `ensureConfig`, the PinStore load including 6a's v4 entry migration, `ensureAgentCert`, and the steer read. It is non-destructive by construction. It returns `{ok, pins, machineId}` and never prints values.
  - `restore(snapshotDir)`, for each STATE-class path:
    1. A path in the inventory is replaced from the snapshot.
    2. A STATE-class path that is NOT in the inventory (created by the new version) is moved aside into `backups/<ts>-discarded/`.
    3. Each replacement is a rename-swap, and the replaced copy is kept until all of them succeed.
  - In-place rule: the new agentd uses the SAME two locations as 0.8.0 (`config.ts:15-21`), so a successful upgrade moves nothing. "Migration" means: quiesce, snapshot, check, retire the old autostart, re-point the plugins, then run the new code.
- **The `install` flow (`orchestrator.ts`):** every step is recorded in `~/.rokid-coder/setup-journal.json` (TRANSACTION class: it survives any restore) before it acts, so a rollback, or a re-run after a crash, undoes exactly what ran. The flow covers three cases with the same steps: a fresh install, an upgrade from 0.8.0, and an upgrade from an earlier installer release (`install.json` present) `[6b-R4]`.

  | # | Step | Journal record (what recovery needs) |
  |---|---|---|
  | 0 | preconditions: not root; HOME writable; disk ≥ 300 MB | — |
  | 1 | discover: the current install (`install.json`), legacy (a)–(c), and `portOwners(8791, 8792)`. An `other` owner blocks, as in (d). | — |
  | 2 | consent per item: retire the legacy autostart; remove the `install-hooks` entries | — |
  | 3 | **quiesce**: `stopCurrent(previous)` if there is a current install; `retireLegacyAutostart` if consented. Then wait until no process owns 8791/8792. | which service was stopped, and the retired legacy record |
  | 4 | if state exists: `snapshot()` + `check()` | the snapshot dir |
  | 5 | wrappers (`installUserWrappers` to the NEW bundle), the PATH block (`profile-path.ts`), the `install-hooks` removal | copies of the previous wrappers, the previous PATH block, the settings backup path |
  | 6 | the CLI step (§13.1): for each absent CLI, `offerCliInstall`. Skippable; install completes with neither. | — (a vendor install is never undone) |
  | 7 | **resolve the CLIs again** (`resolve-cli.ts`, so a CLI that step 6 just installed into `~/.local/bin` is found), and only now write `~/.rokid-coder/env` with the final daemon PATH `[6b-R13]` | the previous `env` |
  | 8 | `plugins.sync` for each CLI now present | each CLI's previous registration: source path and plugin version (`[6b-R11]`) |
  | 9 | `installAutostart(new)`. It replaces a loaded job of the same name. Then **verify identity**: within 20 s, `/health` must report `agentdVersion` = the new version and `execPath` inside the new `bundleDir`. A `pending_next_login` result skips the wait and says so. | the previous autostart definition (macOS plist copy; Windows task XML) |
  | 10 | write `install.json`, with `previous` = the old manifest or the legacy record (the commit point); close the journal; prune the older snapshot | — |
  | 11 | pairing: `pair-step.ts` runs `<bundle>/bin/agentd pair` with the terminal inherited (6a: the code, `[y/N]`, `pair-ready`). Exit 0 means paired. Otherwise it offers `[R]etry`, `[T]ailscale` (the U38 link/steps), `[Q]R` (re-runs `agentd pair`, which prints the v2 line with no secrets) and `[L]ater` (prints `agentd pair`). This doubles as the post-install reachability check (§13.1). It is after the commit point. If the phone was already paired (an upgrade), the step is skipped. | — |
  | 12 | if `!tailscalePresent()`: print the optional Tailscale link (U38) | — |

  - **Recovery**, for a failure in steps 3–9 and for a re-run that finds an open journal, is ONE fixed sequence, not a per-step reverse walk `[6b-R12]`. Each action runs only if the journal shows the matching step ran:
    1. stop the replacement (`stopCurrent(new)`), and wait until 8791/8792 are free
    2. `restore(snapshot)`
    3. restore the program files: the previous wrappers (or remove them), PATH block and `env`, and the settings backup
    4. `plugins.restore` each recorded registration
    5. restore the service records: the previous autostart definition, written but NOT started, or the legacy plist/task via `restoreLegacyAutostart` without starting it
    6. start the previous service exactly once: `installAutostart(previous)`, or bootstrap/run the legacy one. Verify its identity through `/health` (for legacy 0.8.0, the `/health` `ok` and the legacy plist's executable owning the ports).
    7. close the journal, and print `Rolled back to <previous version or "your 0.8.0 setup">`

    Nothing is started before step 6, so the replacement bundle never runs against restored state.
  - `ROKID_SETUP_FAIL_AT=<step>` injects a failure, for tests and gates. It is honoured only when `ROKID_SETUP_TEST=1`.
- **Answers (`answers.ts`):**
  - The keys: `{cli:{claude:"install"|"skip", codex:"install"|"skip"}, legacy:{retireAutostart:bool, removeInstallHooks:bool}, pairing:"skip", purge?:bool}`.
  - `pairing` accepts ONLY `"skip"`. There is no key that confirms a pairing (6a trust boundary).
  - Unknown keys are rejected.
- **Uninstall (`uninstall.ts`)** `[FR 15]`:
  1. `stopCurrent`, then `removeAutostart`
  2. `plugins.remove` for each recorded CLI
  3. remove the wrappers, the PATH block, `env` and `install.json`
  4. remove the WSL bundle dirs (wsl). On macOS, T7b removes the system dir.
  5. State is KEPT, and the setup prints where it is.
  - `--purge` also deletes both state locations and `backups/`. It needs typed `purge` confirmation, or `--yes`.
- **`rollback`:** restores `previous` (the bundle dir, wrappers, plugin sources, autostart, the legacy autostart if it was retired, and the state snapshot). It refuses when `previous` is missing or its bundle dir is gone.

- [ ] **Step 1: Write the failing tests** (`node:test`, temp HOME, `platform/fake.ts`, recorded plugin-CLI fakes, `fixtures/state-0.8.0/`: a real 0.8.0 `config.json`, tls dir, v3 `phone-pins.json`, steer and `settings.json` with `install-hooks` entries):
  - `plugins_sync_installs_both_and_is_idempotent` (the second run issues no mutating command)
  - `plugins_sync_repoints_foreign_marketplace_and_records_old_source`
  - `plugins_sync_manual_step_when_cli_has_no_install_verb`
  - `plugins_remove_only_removes_our_marketplace`
  - `setup_never_edits_cli_config_files_directly` (a file watcher on the temp `~/.claude`/`~/.codex`, with the fake CLIs; only `uninstallHooks` may touch `settings.json`, after consent)
  - `cli_installed_syncs_that_tool_and_refreshes_daemon_env`
  - `resolver_finds_cli_outside_login_path_and_records_absolute_path`
  - `npm_cli_with_separate_node_dir_gets_both_dirs_and_is_verified_under_generated_env` `[6b-R20]`: a fake `codex` in `~/.npm-global/bin` with `#!/usr/bin/env node`, and a fake `node` under `~/.nvm/versions/node/v22/bin`. It covers the initial install and `refreshDaemonEnv`, and the summary warning when verification fails.
  - `snapshot_excludes_program_and_transaction_paths_and_is_0700`
  - `state_check_is_non_destructive` (byte-compares the originals afterwards)
  - `state_check_failure_stops_before_any_change`
  - `upgrade_from_0_8_0_keeps_pairings_and_retires_old_agent` (after the upgrade, the new PinStore lists the same fp as durable, and token/machineId are unchanged)
  - `custom_state_dir_from_0_8_0_config_is_honoured`
  - `failure_after_autostart_rolls_back_everything` (`ROKID_SETUP_FAIL_AT=9`): the legacy autostart is restored, the state is byte-identical to the snapshot, the old marketplace source is back, and the wrappers are gone
  - `failure_at_each_step_undoes_only_what_ran` (a table over steps 3–9)
  - `upgrade_from_previous_installer_release_replaces_running_daemon` `[6b-R4]`: two fixture bundles, `1.0.0-test.1` then `1.0.0-test.2`, with the first one's daemon running. After setup, `/health` reports test.2 and its `execPath`, and the test.1 process has exited.
  - `identity_check_fails_when_old_daemon_still_answers` (a fake `stopCurrent` that leaves test.1 up): the result is a rollback, never a false success
  - `rollback_stops_replacement_before_restarting_previous`, checked by the order of the fake's calls
  - `snapshot_taken_only_after_quiesce` (the fake daemon writes state until it is stopped, and the snapshot equals the post-stop files)
  - `restore_with_default_overlapping_layout_keeps_program_and_transaction_paths`: `stateDir` = `~/.rokid-coder`; after the restore, `bin/`, `env`, `install.json`, `setup-journal.json` and `backups/` are unchanged, and files the new version created are moved into `-discarded/`
  - `rerun_after_crash_completes_open_journal_undo`
  - `recovery_restarts_previous_once_after_all_restores` `[6b-R12]`: the fakes record which executable each start uses. Exactly one start happens, of the PREVIOUS bundle, after the state, wrappers, env, plugins and service records are restored, and no replacement process is alive after `restore(snapshot)`.
  - `plugin_rollback_between_releases_restores_registration_and_content` `[6b-R11]`: test.1 and test.2 bundles whose `hook-forward.js` and plugin versions differ. After a failed upgrade, the fake CLI's installed copy holds test.1's digest and version, and the marketplace points at test.1's `plugins/`.
  - `fresh_install_cli_installed_outside_path_reaches_daemon_env` `[6b-R13]`: the fake vendor installer drops `claude` into `~/.local/bin`, which is not on the original PATH. The `env` file and the daemon's `PATH` contain that dir.
  - `manual_agentd_on_ports_is_never_killed`
  - `install_completes_with_neither_cli`
  - `answers_cannot_confirm_pairing_and_unknown_keys_rejected`
  - `pair_step_maps_exit_status_and_offers_fallbacks`
  - `uninstall_keeps_state_unless_purge`
  - `uninstall_purge_requires_confirmation`
  - `rollback_restores_previous_install`
  - `refuses_to_run_as_root`
  - `setup_output_never_contains_secrets` (it greps all captured output and the journal for the fixture's token, steer and full fp)
- [ ] **Step 2:** Implement. Then do the Step 0 spike for the plugin verbs, and commit the fixtures with their recorded CLI versions.
- [ ] **Step 3:** Green. Commit `Add rokid-setup for plugin provisioning, upgrade with rollback, and uninstall`.

### Task 7b: The macOS installer: check first, install, then set up as the console user (U37, §13.1) `[FR 10, FR 11, FR 12, FR 15]`

**Files:** see the ownership table.
- Create in `computer/installer/macos/`:
  - `build-pkg.sh`, `Distribution.xml`, `scripts/postinstall`
  - `lib/resolve-user.sh`, `lib/launch-setup.sh`
  - `Rokid Coder Setup.command`, `uninstall.sh`
  - `test/*.test.js` (run by `npm run test:installers`)
- Create: `computer/src/setup/platform/darwin.ts`, `.github/workflows/macos-installer.yml` and `docs/coding-agent/releases/1.0.0-macos-gate.md`.

**Interfaces:**
- **The pre-install check (U37, §13.1),** in `Distribution.xml`:
  - `<allowed-os-versions><os-version min="13.0"/>`
  - an `installation-check` script that blocks, with a one-line fix:
    - macOS < 13: "Rokid Coder needs macOS 13 or later — update in System Settings > General > Software Update"
    - the wrong architecture: "This is the Intel package — download the Apple silicon one" (via `system.sysctl('hw.optional.arm64')`)
    - a newer version already installed (from `installed-version`): "A newer Rokid Coder is installed"
  - a `volume-check` that needs `my.target.availableKilobytes` ≥ 300 MB
  - `enable_localSystem` only

  These are the only hard prerequisites. CLIs, Tailscale and reachability are setup steps.
- **The payload:** `/Library/Application Support/RokidCoder/<v>/` (T7a's `darwin-<arch>` bundle, plus `Rokid Coder Setup.command` and `uninstall.sh`), root-owned and read-only.
- **`postinstall` (root):**
  1. write `installed-version`
  2. prune `[6b-R6]`: delete a version dir only when NOTHING references it. A dir is kept when it is any of these:
     - `<v>`
     - any user's `install.json` `bundleDir` or `previous.bundleDir`
     - the `bundleDir` in any open `setup-journal.json`
     - the `bundleDir` in any `handoff/<uid>.json` whose user hasn't committed yet

     It enumerates users with `dscl . -list /Users NFSHomeDirectory`, not by globbing `/Users`. Pruning runs here, before the new setup, so it can only remove versions that were already unreferenced. A version freed by this run's upgrades is removed by the NEXT package install.
  3. hand off setup, as below

  It always exits 0 once the payload is in place, because a setup problem must not fail the package.
- **User resolution, separated from user setup** `[FR 11]`:
  - **`lib/resolve-user.sh`** is pure resolution. It prints `user uid home shell` or a reason code. The system commands are injectable (`SCUTIL`, `DSCL`, `STAT`) for tests.
    1. If `COMMAND_LINE_INSTALL` is set: `deferred_cli_install`. A `sudo installer` run never guesses whose machine it is.
    2. Otherwise, the console user from `scutil` `show State:/Users/ConsoleUser` (Name, UID), cross-checked with `stat -f%Su /dev/console`.
    3. Eligible means: not `root`/`loginwindow`/`_mbsetupuser`; uid ≥ 501; `dscl . -read /Users/<u> NFSHomeDirectory UserShell` gives an existing home. Otherwise: `no_eligible_user`.
  - **`lib/launch-setup.sh <uid> <user> <home> <shell>`** is pure setup launching:
    1. It writes `handoff/<uid>.json` `{uid, version, bundleDir}`.
    2. It runs `launchctl asuser <uid> sudo -u <user> -H env -i HOME=<home> USER=<user> LOGNAME=<user> SHELL=<shell> PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=<user's confstr DARWIN_USER_TEMP_DIR> /usr/bin/open -a Terminal "<bundleDir>/Rokid Coder Setup.command"`.
  - **`Rokid Coder Setup.command`** runs as whoever opens it:
    1. It refuses uid 0.
    2. It re-derives HOME and SHELL from `dscl` for `id -un`, rather than trusting the inherited environment.
    3. It checks the handoff uid, if one is present. On a mismatch it says so and continues as the current user. It never switches user.
    4. It runs `"<bundleDir>/bin/rokid-setup" install --platform darwin --bundle "<bundleDir>"`.
  - **Recovery, for `deferred_cli_install` or `no_eligible_user`:**
    - postinstall writes `/Library/Application Support/RokidCoder/pending-setup`, and logs `Rokid Coder is installed. To finish, open "Rokid Coder Setup" from the disk image, or run: "/Library/Application Support/RokidCoder/<v>/bin/rokid-setup" install --platform darwin --bundle "…/<v>"` to stdout and `/var/log/install.log`.
    - The `.dmg` carries the same `Rokid Coder Setup.command`, plus a README line with the U32 "right-click → Open" step.
- **`darwin.ts` (`PlatformHooks`):**
  - **`legacyAutostart`:** finds `~/Library/LaunchAgents/com.anezium.nexus-agentd.plist` and its `launchctl print gui/<uid>/com.anezium.nexus-agentd` state.
  - **`retireLegacyAutostart`:**
    1. `launchctl bootout`, then wait until `print` fails (the loop at `install-launchagent.sh:157-162`)
    2. move the plist into the snapshot dir
    3. check with `lsof -nP -iTCP:8791,8792 -sTCP:LISTEN` that the ports are free
  - **`restoreLegacyAutostart`:** moves the plist back ONLY. It never bootstraps. The single start belongs to T7p recovery step 6, which runs `launchctl bootstrap gui/<uid> <legacy plist>` once `[6b-R16]`.
  - **`installAutostart`:**
    - It writes `~/Library/LaunchAgents/io.github.debasishdebs.rokidcoder.agentd.plist`:
      - `ProgramArguments` = [`<home>/.rokid-coder/bin/agentd`, `run`]
      - no KeepAlive, matching today's reason (`install-launchagent.sh:134-136`)
      - logs in `~/.rokid-coder/logs/`
    - If `launchctl print gui/<uid>` succeeds: when the label is already loaded, it runs `bootout`, waits until `print` fails, then `bootstrap`s the new plist, and returns `running` `[6b-R4]`. A bare `bootstrap` would not replace a loaded label. Otherwise it returns `pending_next_login`.
  - **`stopCurrent`:** `bootout gui/<uid>/io.github.debasishdebs.rokidcoder.agentd`, waits until `print` fails AND `lsof` shows nothing on 8791/8792, and keeps the plist file so the undo can bootstrap it again.
  - **`refreshDaemonEnv`:** re-resolve the CLIs, rewrite `~/.rokid-coder/env`, then `launchctl kickstart -k gui/<uid>/<label>` `[6b-R13]`.
  - **`portOwners`:** via `lsof`.
  - The bundle sits outside the TCC-protected folders, so 0.8.0's TCC probe (`install-launchagent.sh:53-118`) is not needed. Setup prints the Local Network hint from `install-launchagent.sh:166-172` when the reachability step fails.
- **`uninstall.sh [--purge] [--system]`:**
  - As the user: `rokid-setup uninstall [--purge]`.
  - `--system` (re-execs under `sudo`): it removes `/Library/Application Support/RokidCoder` and runs `pkgutil --forget io.github.debasishdebs.rokidcoder.computer`. It refuses, unless `--force`, while ANY version dir is referenced by another user, by the same reference check postinstall pruning uses: users enumerated with `dscl . -list /Users NFSHomeDirectory`, so homes outside `/Users` count; current and previous `bundleDir`s; open journals; pending handoffs `[6b-R19]`. The refusal names those users.
- **Artifacts:** `rokid-coder-<v>-macos-<arch>.pkg`, each inside `rokid-coder-<v>-macos-<arch>.dmg` (`hdiutil create -format UDZO`), with `Rokid Coder Setup.command` and `uninstall.sh` beside the pkg.
- **`macos-installer.yml`:**
  - A matrix of `macos-15` (arm64) and `macos-15-intel` (x64).
  - It consumes `bundle-darwin-<arch>`. Following T7a's archive contract, it checks the digest, extracts, and runs `verify-bundle.mjs` + `selfcheck` before `pkgbuild`.
  - It uploads `macos-pkg-<arch>`.
  - `build-pkg.sh --version-suffix <s>` builds test versions (`1.0.0-test.1`, `-test.2`) for the upgrade test. Release builds never pass it.
  - Hosted macOS runners auto-log-in the `runner` user, so a real GUI session (a `gui/<uid>` domain and a console user) exists for the GUI test.

- [ ] **Step 1: Write the failing tests.**
  - **Unit** (`test/*.test.js`, fake `scutil`/`dscl`/`stat`/`launchctl`/`sudo`/`open`/`lsof` that record their argv):
    - `installation_check_blocks_old_macos_with_fix`, `installation_check_blocks_wrong_arch`, `installation_check_blocks_downgrade` (the JS evaluated in node with a stubbed `system`)
    - `resolve_console_user_eligible`, `resolve_console_user_rejects_root_loginwindow_mbsetupuser`, `resolve_console_user_rejects_uid_below_501_and_missing_home`, `cli_install_defers_setup`
    - `launch_setup_uses_asuser_sudo_and_explicit_env` (exact argv)
    - `postinstall_exits_0_and_writes_pending_marker_without_eligible_user`
    - `setup_command_refuses_root_and_rederives_home`
    - `darwin_retire_waits_for_bootout_and_frees_ports`, `darwin_restore_legacy_restores_plist_without_starting`, `legacy_rollback_bootstraps_exactly_once` (over the complete recovery, the fake `launchctl` sees one `bootstrap` of the legacy label)
    - `darwin_install_autostart_pending_without_gui_domain`
    - `launchagent_plist_quotes_paths_with_spaces_and_non_ascii`
    - `uninstall_system_refuses_while_other_users_installed`, including a user whose home is `/Volumes/Data/homes/u2` (outside `/Users`) and one with only a pending handoff
    - `prune_keeps_every_referenced_version_across_users` (user A on test.1 with previous test.0, user B on test.2, user C with an open journal for test.1, and a pending handoff; only an unreferenced test.-1 is deleted)
    - `darwin_install_autostart_replaces_loaded_label` (the call order is bootout, wait, bootstrap)
  - **CI** (`macos-installer.yml`). Each JOB below runs on its own fresh runner, so no scenario inherits another's machine state `[6b-R14]`:
    1. **Job `clean-runtime`, `install_with_toolchains_removed`** `[FR 12]`. Before installing:
       - `sudo mv` every `node`, `npm`, `npx` and `node-gyp` found under `/usr/local`, `/opt/homebrew`, `/Users/runner/hostedtoolcache` and `/Library/Frameworks`
       - also `sudo mv` `/Applications/Xcode*.app` and `/Library/Developer/CommandLineTools`
       - assert that `command -v node` fails and that `/usr/bin/cc --version` and `/usr/bin/python3 --version` fail (the CLT shims have nothing behind them)

       Then `sudo installer -pkg … -target /`, which is a command-line install, so setup is deferred.
    2. **In the same `clean-runtime` job, with the toolchains still removed: `setup_as_special_char_user_runs_under_that_uid`** `[FR 11]`:
       - `sysadminctl -addUser rokidtest -home "/Users/Rokid Tëst"`, then `createhomedir`
       - run `launch-setup.sh`'s environment construction, but with `rokid-setup install --answers ci-answers.json` instead of `open -a Terminal`: `launchctl asuser <uid> sudo -u rokidtest -H env -i …`
       - assert:
         - every created file is owned by that uid and sits under that HOME
         - the wrappers work, and `agentd --version` from that user shows the bundle `execPath`
         - the plugins were provisioned through the fake CLIs
         - autostart is `pending_next_login`, since that user has no GUI session
         - `agentd selfcheck --require-bundle` passes as that user
    3. **Job `gui-session`, `gui_session_setup_reaches_first_prompt_as_console_user`** `[FR 11]`:
       - run the real `postinstall` handoff with `COMMAND_LINE_INSTALL` unset (invoked directly as root, with installer-like args). The real `scutil` must resolve `runner`.
       - assert that a Terminal process and a `rokid-setup` process run with runner's uid; that `~/.rokid-coder/logs/setup.log` shows `awaiting: cli_step`; then kill it
       - then, as runner, run setup non-interactively, and assert `launchctl print gui/<uid>/io.github.debasishdebs.rokidcoder.agentd` and `agentd status` → `running: yes`
    4. **In the `clean-runtime` job, `hooks_daemon_and_pty_after_install`:** T7a's exec-allowlist check, run against the INSTALLED path with the toolchains still removed.
    5. **Job `legacy-upgrade`, `real_0_8_0_upgrade_on_runner`** `[FR 15]`. The toolchains stay in place here, because 0.8.0 runs on the system node (`install-launchagent.sh:23-25`); job 1 proves the clean runtime.
       - check out tag `rokid-coder-v0.8.0`, build its agentd, and run its `install-launchagent.sh` as runner, so the old agent really holds 8791/8792; seed `fixtures/state-0.8.0` as runner's state
       - install the pkg and run setup as runner
       - assert:
         - `com.anezium.nexus-agentd` is gone
         - `lsof` shows the ports held by the bundled node
         - the token, machineId and pin fp are unchanged (compared without printing them)
    6. **Job `legacy-upgrade-fails`, `failed_0_8_0_upgrade_restores_legacy_on_runner`** `[6b-R14]`:
       - the same fresh 0.8.0 start as job 5
       - then install the pkg and run setup with `ROKID_SETUP_TEST=1 ROKID_SETUP_FAIL_AT=9`
       - assert:
         - `com.anezium.nexus-agentd` is loaded again, and its node holds the ports
         - the state is byte-identical to the pre-setup copy
         - the marketplace points at the 0.8.0 checkout again
         - no `io.github.debasishdebs.rokidcoder.agentd` job is left
    7. **Job `release-upgrade`, `upgrade_between_installer_releases_on_runner`** `[6b-R4]`:
       - install the test.1 pkg and run setup as runner, then install test.2 and run setup again
       - assert:
         - `/health` reports test.2 with its `execPath`
         - no test.1 process is left
         - the label is loaded once
         - test.1's dir is still present (it is `previous`)
       - then `rokid-setup rollback`, and assert test.1 is running again, with its own plugin content (`[6b-R11]`)
       - then, in the same job, a failed upgrade to test.2 (`ROKID_SETUP_FAIL_AT=9`): test.1 is running and its plugin is restored
    8. **In the `release-upgrade` job, `uninstall_keeps_state_then_purge`:** `uninstall.sh` leaves the state; `--purge --yes` removes it; `--system` removes the payload and the receipt.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Green: unit tests and `macos-installer.yml` on both architectures. Commit `Ship the computer side as a macOS package that checks first and sets up as the user`.
- [ ] **Step 4:** Implementation done. The recorded gate follows.
- [ ] **Step 5: The recorded macOS gate (minimum OS)** `[FR 10]`. Results go in `docs/coding-agent/releases/1.0.0-macos-gate.md`, with a date, the macOS build and pass/fail for each item:
  - **M1:** In a macOS 13.x VM (tart or UTM, on the build Mac), install the arm64 pkg through the GUI. The setup Terminal opens as the logged-in user. Then `agentd selfcheck --require-bundle`, and `launchctl print gui/<uid>/…` shows it running.
  - **M2:** In the same VM, run the x64 bundle's `agentd selfcheck --require-bundle` under `arch -x86_64` (Rosetta).
  - **M3:** the refusal screen. Install a test build made with `build-pkg.sh --min-os 99.0` (test-only), and check that Installer shows the update message and installs nothing. The version logic itself is covered by `installation_check_blocks_old_macos_with_fix`.

  6c's T13 then runs the real-Mac install, upgrade from 0.8.0 and uninstall in the device checklist. 6c's T10 does not publish without M1–M3 recorded as passing.

### Task 8: The Windows installer into WSL2 (R4, U33, U34, U37) `[FR 13, FR 14, FR 15]`

**Files:** see the ownership table.
- Create in `computer/installer/windows/`:
  - `installer.nsi`, `lib/RokidCoder.psm1`
  - `preflight.ps1`, `user-setup.ps1`, `machine.ps1`, `start-agentd.ps1`, `uninstall.ps1`
  - `wsl-requirements.json`
  - `gate/netprobe.mjs`
  - `test/*.Tests.ps1`
- Create: `computer/src/setup/platform/wsl.ts`, `computer/src/advertise.ts`, `computer/src/launcher/windows-gate.ts`, the node tests, `.github/workflows/windows-installer.yml` and `docs/coding-agent/releases/1.0.0-windows-gate.md`.
- Modify: `computer/src/tailnet-discovery.ts`; the advertised-endpoint call sites in `pairing.ts` and `pairing/**`; one call in `rk.ts`.

**Interfaces:**
- **Privilege split** `[FR 13]`:
  - **`installer.nsi`** runs `RequestExecutionLevel user` (unelevated). It installs per-user into `%LOCALAPPDATA%\Programs\RokidCoder\`, with an HKCU Uninstall entry, and does every per-user step.
  - **`machine.ps1 -Apply|-Revert -Mode mirrored|nat -StatePath <file>`** is launched with `Start-Process -Verb RunAs -Wait`. It is the ONLY elevated code. It changes only machine scope: the host firewall rules, the Hyper-V firewall rules and the port-proxy entry. It records each object it created (name, rule ids, proxy tuple) in `%ProgramData%\RokidCoder\machine-state.json`. It reads and writes no user profile, registry hive or WSL distro, so elevating as another admin account (over-the-shoulder UAC) can't bind the wrong user.
  - **Session check:** if the installer's process user SID differs from the owner of the interactive session (`explorer.exe`'s token in this session), it refuses: "Run the installer from your own Windows account, not as another user".
- **Preflight (U37, §13.1)** (`preflight.ps1 -Json -Mode <mode>`). Each item is `{id, ok, detail, fix, optional}`. The NSIS page shows each item with its fix and a Re-check button. Install continues only when every non-optional item that applies to the chosen mode passes.
  - **The network mode is chosen FIRST** `[6b-R1]`, from `wsl_version` and the user's answer:
    - `mirrored` when the version is ≥ `mirroredMin` and the user consents to the `.wslconfig` change
    - otherwise `nat`, which is also the result when mirrored verification later shows NAT

    The installer then evaluates only the items for that mode. Switching mode re-runs preflight.

  | id | Mode | What it checks |
  |---|---|---|
  | `windows_version` | both | build ≥ 22621 (11 22H2) |
  | `wsl_installed` | both | `%ProgramFiles%\WSL\wsl.exe` (the Store/MSI WSL) or the inbox `%SystemRoot%\System32\wsl.exe` exists. Otherwise, fix: `wsl --install` |
  | `wsl_version` | mirrored | `ProductVersion` of `%ProgramFiles%\WSL\wsl.exe` ≥ `wsl-requirements.json` `mirroredMin` (2.0.9: mirrored networking plus the Hyper-V firewall). Fallback: parse `wsl.exe --version` with `WSL_UTF8=1`. The inbox WSL fails this with fix `wsl --update`, or choose NAT. The value is re-verified against the Microsoft networking docs URL recorded in that file at implementation time. |
  | `wsl_version` | nat | `natMin`: any WSL that runs a version-2 distro with `localhostForwarding` (the inbox WSL on Windows 11 qualifies). |
  | `wsl_distro` | both | from THIS user's `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{guid}`: `DistributionName`, `Version` = 2 and `DefaultDistribution`. It is never parsed from localized `wsl -l` output. Default: the default distro, if it's Ubuntu; else a choice. |
  | `distro_glibc` | both | ≥ 2.35 (`getconf GNU_LIBC_VERSION` in the distro) |
  | `distro_user` | both | the default Linux user is not root. Fix: the `adduser` steps. |
  | `network_profile` | both | the active network is Private or Domain. Fix: Settings > Network > Private |
  | `wsl_mirrored_networking` | mirrored | the effective mode is mirrored (see below). Fix: the consented change. |
  | `wsl_localhost_forwarding` | nat | `localhostForwarding` is not false in `.wslconfig`. Fix: the consented change. |
  | `firewall_rules` | both | that mode's rule set (below) is present and matching. Fix: the elevated `machine.ps1 -Apply -Mode <mode>`. |
  | `ports` | both | the listeners on 8791/8792 (and 8794 in nat) on the host (`Get-NetTCPConnection -State Listen` + the owning process) and in WSL. Each owner is classed: **current** (our recorded install: the `binding-<gen>.json` named in `install.json` plus the bundled node's realpath in WSL) passes, because the upgrade stops it; **legacy** (the `NexusAgentd` task, or a Windows `node.exe` running `…\dist\cli.js run`) passes once its retire is consented; **other** blocks, with its pid and image name. |
  | `disk_space` | both | ≥ 300 MB on `%LOCALAPPDATA%`'s volume and in the distro's `$HOME` |
- **Binding** `[FR 13]`:
  - **Staging, not replacing** `[6b-R10]`. After preflight, `user-setup.ps1` writes only NEW, versioned files, and never overwrites the previous version's:
    - `%LOCALAPPDATA%\RokidCoder\binding-<gen>.json`
    - `%LOCALAPPDATA%\Programs\RokidCoder\<gen>\start-agentd.ps1`
    - `%LOCALAPPDATA%\Programs\RokidCoder\<gen>\task.xml`, the definition below, with this version's launcher and binding paths baked in

    The binding:

    ```
    {windowsSid, windowsUser, distroName, distroGuid, linuxUser, linuxUid, linuxHome,
     bundleDir, agentdPath:"<linuxHome>/.rokid-coder/bin/agentd", wslExe:"%SystemRoot%\\System32\\wsl.exe",
     networkMode:"mirrored"|"nat", advertisePort:8792|8794}
    ```

    `linuxUser` and `linuxUid` come from `wsl.exe -d <distro> --exec /usr/bin/id -un` and `-u`, and `linuxHome` from `getent passwd`.
  - Every WSL call uses `wsl.exe -d <distroName> -u <linuxUser> --exec <absolute path> <args…>`. That means no shell, no `~`, and arguments passed as separate argv, never interpolated into a `bash -c` string. The binding is copied into the WSL manifest (`install.json.binding`).
  - **Generations** `[6b-R21]`: every installer run (a fresh install, an upgrade or a Repair) stages under a NEW generation id, `<gen>` = `<v>-<UTC yyyymmddHHMMSS>`. So `binding-<gen>.json`, `<gen>\start-agentd.ps1` and `<gen>\task.xml` never overwrite an existing file, including on a same-version Repair.
    - The bundle stays per version: when `<linuxHome>/.local/share/rokid-coder/<v>/` already exists and its `bundle.json` digest matches, Repair reuses it rather than extracting over a running install.
    - Older generations are pruned only after the commit point, keeping the committed one and its `previous`.
  - Repair re-resolves the binding. Logon never re-resolves it.
- **The bundle into WSL:**
  1. The `.exe` carries T7a's `rokid-coder-bundle-<v>-linux-x64.tar.gz` and its `.sha256`, unmodified. `windows-installer.yml` checks the digest before `makensis`. Linux modes survive because the archive is unpacked only inside the distro.
  2. It extracts the tarball to `%TEMP%`, then, inside the distro, `sha256sum` checks it and `tar -xzf` unpacks it into `<linuxHome>/.local/share/rokid-coder/<v>/`. Paths go through `wslpath -u`, as an argv value.
  3. Then it runs `<bundleDir>/bin/rokid-setup install --platform wsl --bundle <bundleDir> --binding <wslpath of binding-<gen>.json> --task-xml <wslpath of <gen>\task.xml>` in a new console window, interactively: the CLI step and the pairing happen there.
- **The scheduled task** `\RokidCoder\agentd` `[FR 13]`:
  - It is registered ONLY inside T7p's journaled transaction (step 9, `wsl.ts installAutostart`), never by `user-setup.ps1`. So nothing that the rollback needs has been replaced before the journal records it. `task.xml` holds:
    - written in the Task Scheduler XML schema's own values, not the PowerShell names `[6b-R17]`: `<Principal><UserId>{windowsSid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`
    - `<Triggers><LogonTrigger><UserId>{windowsSid}</UserId></LogonTrigger></Triggers>`
    - `<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>`
    - saved as UTF-16LE with a BOM and `encoding="UTF-16"`, as `schtasks /XML` expects
    - action: `%SystemRoot%\System32\conhost.exe --headless %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\Programs\RokidCoder\<gen>\start-agentd.ps1" -Binding "%LOCALAPPDATA%\RokidCoder\binding-<gen>.json"`, with every path expanded to an absolute, quoted value at staging time
    - If gate W1 shows that Task Scheduler refuses an AtLogOn task created by a standard user, the fallback is an HKCU `Run` value `RokidCoder` with the same command line. `autostart.kind` is then `run-key`, and the same staging, journal and restore rules apply. Which one ships is decided by W1.
  - **`start-agentd.ps1`:**
    1. It reads the binding file named by `-Binding`, which is its own version's.
    2. In nat mode it computes the advertised hosts: the IPv4 of `Get-NetIPConfiguration` interfaces with a default gateway, plus the Tailscale IPv4 if `tailscale.exe` is present. It writes them with `rokid-setup advertise set`, as described under Networking.
    3. It runs `wsl.exe -d <distroName> -u <linuxUser> --exec <agentdPath> run`.
  - **`wsl.ts`:**
    - **The path rule** `[6b-R18]`: every path handed to a Windows executable through interop is a Windows path, either the manifest's `win` field or `wslpath -w <linux path>`. It is never a `/mnt/...` or `/home/...` path, because interop passes argv through untranslated.
    - `installAutostart(m)`: `schtasks.exe /Create /TN \RokidCoder\agentd /XML <m.taskXml.win> /F` via interop (this replaces the registered definition), then `/Run`, then `/health`
    - `stopCurrent`: `schtasks.exe /End /TN \RokidCoder\agentd`, then SIGTERM to the PIDs whose `/proc/<pid>/exe` realpath is the recorded bundle's node AND whose cmdline is `…/app/dist/cli.js run`. It waits up to 10 s for those PIDs to exit and for 8791/8792 to be free, and then SIGKILLs the same PIDs only. With `MultipleInstancesPolicy IgnoreNew`, a following `/Run` would otherwise leave the old process serving `[6b-R4]`.
    - Upgrade order, inside T7p's flow:
      1. step 3: `stopCurrent(previous)`
      2. step 9's journal record: `schtasks.exe /Query /TN \RokidCoder\agentd /XML` → `%LOCALAPPDATA%\RokidCoder\journal\task-previous.xml` (Windows side, UTF-16LE + BOM; written through its `wslpath -u` path, and re-created with its `win` path), taken BEFORE `/Create`
      3. `installAutostart(new)`
      4. the identity check

      Recovery (T7p's fixed sequence) re-creates the task from `task-previous.xml`, whose action still names the previous version's own, untouched `start-agentd.ps1` and `binding-<prev>.json`. It starts that task once, in recovery step 6.
    - `refreshDaemonEnv`: rewrite `env`, then `stopCurrent`, then `/Run`
    - `removeAutostart`: `schtasks.exe /Delete /TN \RokidCoder\agentd /F`
    - `legacyAutostart`: `schtasks.exe /Query /TN NexusAgentd /XML`, plus the legacy daemon's identity, via interop PowerShell (`Get-NetTCPConnection -State Listen -LocalPort 8791,8792` → `OwningProcess`, then `Get-CimInstance Win32_Process`): `{pid, executablePath, commandLine, creationDate}`. Only a `node.exe` whose command line runs `…\dist\cli.js run` counts as legacy.
    - `retireLegacyAutostart` `[6b-R23]`:
      1. export the task XML into the journal (Windows side, UTF-16LE), and delete the task. Deleting a task does not stop the program it launched, since `run-hidden.vbs` starts node detached (`run-hidden.vbs:8`).
      2. so it then stops the EXACT recorded process: it re-reads that pid's `ExecutablePath`, `CommandLine` and `CreationDate`, and calls `Stop-Process -Id` only if all three still match. The process is the same user's, so no elevation is needed.
      3. it waits until 8791/8792 are free on the host, then lets step 3 continue. If the process won't stop, or the identity no longer matches, setup blocks with `Stop the old agentd (pid N), then press Enter`.
    - `restoreLegacyAutostart` re-creates `NexusAgentd` from the exported XML without starting it. Recovery step 6 starts it once with `schtasks.exe /Run /TN NexusAgentd`, then checks that a legacy `node.exe` owns the ports.
- **Networking** `[FR 14]` (R4, §13.4):
  - **Mirrored (preferred):**
    - With consent, `user-setup.ps1` sets `[wsl2] networkingMode=mirrored` in `%UserProfile%\.wslconfig`. It preserves every other key and writes a backup, `.wslconfig.rokid-backup`. Then `wsl --shutdown`, after warning that it closes every running distro.
    - It verifies the EFFECTIVE mode in the distro: `wslinfo --networking-mode` = `mirrored`. If `wslinfo` is missing, the check is that the distro's non-loopback IPv4 set equals the host's. Mirrored mode can silently fall back to NAT, so this is checked rather than assumed.
    - `machine.ps1 -Apply -Mode mirrored` creates these, every one complete, with the mandatory `-Name` AND `-DisplayName` `[6b-R7]`:
      - `New-NetFirewallHyperVRule -Name RokidCoder-wss -DisplayName "Rokid Coder (WSL) wss" -Direction Inbound -Action Allow -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol TCP -LocalPorts 8792 -RemoteAddresses <scope> -Profiles Private,Domain`
      - `New-NetFirewallHyperVRule -Name RokidCoder-discovery -DisplayName "Rokid Coder (WSL) discovery replies" -Direction Inbound -Action Allow -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -Protocol UDP -RemotePorts 8793 -RemoteAddresses <scope> -Profiles Private,Domain`
      - `New-NetFirewallRule -Name RokidCoder-wss-host -DisplayName "Rokid Coder wss" -Group "Rokid Coder" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8792 -RemoteAddress LocalSubnet,100.64.0.0/10 -Profile Private,Domain`
      - `New-NetFirewallRule -Name RokidCoder-discovery-host -DisplayName "Rokid Coder discovery replies" -Group "Rokid Coder" -Direction Inbound -Action Allow -Protocol UDP -RemotePort 8793 -RemoteAddress LocalSubnet,100.64.0.0/10 -Profile Private,Domain`

      `<scope>` is `LocalSubnet,100.64.0.0/10` if the Hyper-V cmdlet accepts the `LocalSubnet` keyword. If it doesn't, it is the concrete prefixes of the host's Private/Domain interfaces plus `100.64.0.0/10`, recomputed by every Repair. Which applies is fixed at implementation by the metadata test and gate W3.

      Gate W3 records whether both layers are needed. Any layer it shows to be unneeded is dropped in the fix wave.
    - Outbound (the discovery broadcast to 8793, the PhoneLink dial to the phone's 8792) needs no rule.
  - **The NAT fallback** (§13.4). It is used when `wsl_version` is below the minimum, when the user declines mirrored mode, or when verification shows NAT:
    - **Inbound:** `machine.ps1 -Apply -Mode nat` adds ONE `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=8794 connectaddress=127.0.0.1 connectport=8792`. It reaches agentd through WSL's localhost forwarding (wslrelay), so it never depends on the WSL VM's IP, and a changed WSL IP needs no proxy refresh. Preflight requires `localhostForwarding` not to be false in `.wslconfig`. If it is false, the same consented `.wslconfig` edit sets it.
    - A host firewall rule allows TCP 8794 inbound: `New-NetFirewallRule -Name RokidCoder-proxy -DisplayName "Rokid Coder proxy" -Group "Rokid Coder" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8794 -RemoteAddress LocalSubnet,100.64.0.0/10 -Profile Private,Domain`.
    - **The advertised address** `[6b-R3]` is one persisted record, `<rokidCoder.stateDir>/advertise.json` (0600): `{mode:"nat", hosts:[…], port:8794, updatedAt}`. Every process reads it, so a pairing client started from any terminal sees the same endpoint as the daemon.
      - **Writers:**
        - `user-setup.ps1`, at install and Repair, through `wsl.exe … --exec <bundle>/bin/rokid-setup advertise set --hosts … --port 8794`
        - `start-agentd.ps1`, at every logon, the same way, before it starts agentd
        - `advertise.ts`'s own refresh: in nat mode, `agentd pair` and the daemon (every 5 min) re-read the Windows host's IPv4s through interop (`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -Command <fixed script>`, argv only) and rewrite the file when they change
      - In mirrored mode the file is absent. `advertisedEndpoint(config)` then returns today's `bestHostGuess()` and `config.wsPort`, unchanged on macOS.
      - **Readers:** `advertisedEndpoint(config) → {hosts[], port}` is the ONLY source for:
        - the QR/pairing line (6a v2)
        - the `pair-ready` announcement
        - `pair_credentials{wsHost, wsPort}` in 6a's credential handover, so the phone stores Windows-host:8794 and reconnects there
      - The env-variable route is dropped, so `start-agentd.ps1` exports nothing.
      - **Limit, said by setup in nat mode:** when the Windows host's IP changes, the stored address goes stale until the next refresh. A phone that can't reach the old address shows 6a's normal "pair again" state, and Tailscale (a stable address) is suggested.
    - **Outbound:** PhoneLink dials out through NAT and works once the phone's address is known. The UDP broadcast doesn't leave the NAT, so automatic discovery is unavailable. Setup's pairing step says: "Automatic discovery doesn't work in this network mode — scan the QR code on your phone, or use Tailscale".
- **Tailscale:**
  - `tailnet-discovery.ts` adds `tailscale.exe` via interop when running in WSL (`WSL_DISTRO_NAME` set, or `/proc/sys/fs/binfmt_misc/WSLInterop` present).
  - The candidates are `tailscale.exe`, then `/mnt/c/Program Files/Tailscale/tailscale.exe`, then the existing `tailscale` and `/usr/bin/tailscale` (`tailnet-discovery.ts:64-74`).
- **The Windows launcher gate (U33):**
  - `windows-gate.ts` exports `WINDOWS_LAUNCHER_VERIFIED = false`, a source constant flipped only by a commit after the gate passes. `ROKID_RK_WINDOWS_VERIFIED=1` overrides it for the gate session.
  - It is called directly AFTER T9's resolution block `[6b-R2]`, so a missing CLI is offered for install, and provisioned through `cli-installed`, before the gate applies.
  - When running in WSL and not verified, `rk claude` prints `"Launcher mode isn't verified on Windows yet — use plugin mode: type /rokid:on in Claude"`, and `rk codex` prints `"… type rokid:on in Codex"`. Both exit 0.
- **Upgrade, rollback, uninstall** `[FR 15]`:
  - **Upgrade:** the same `.exe`.
    - Preflight runs again.
    - The new bundle goes into `<v>/` beside the previous one.
    - `rokid-setup install` (T7p's snapshot, check, legacy `NexusAgentd` retire, plugin re-point, wrappers to `<v>`, health) runs, and the task is re-registered with the same name and a new binding.
  - **Rollback:**
    - On an NSIS failure after `machine.ps1 -Apply` ran in THIS run, `machine.ps1 -Revert` removes exactly the objects recorded by this run.
    - On a setup failure, T7p's rollback runs, and the previous task XML (exported before re-registering) is restored.
  - **Uninstall** (the Apps & Features entry, `uninstall.ps1 [-Purge]`):
    1. `rokid-setup uninstall [--purge]` in the distro: it stops agentd, removes the plugins, wrappers, PATH block and bundle dirs, and keeps state unless purge.
    2. `Unregister-ScheduledTask \RokidCoder\agentd`.
    3. The elevated `machine.ps1 -Revert -All` removes every rule and the proxy entry listed in `machine-state.json`, and nothing it didn't create.
    4. `.wslconfig`: if `networkingMode` still equals the value we set, it asks "Keep mirrored networking? [Y/n]". On n, it restores the backed-up value. It never touches other keys.
    5. Remove `%LOCALAPPDATA%\Programs\RokidCoder` and every `binding-*.json`.
- **`windows-installer.yml`** (`windows-2025`, pinned so the NetSecurity module carries the Hyper-V firewall cmdlets):
  - It installs Pester 5 and a pinned NSIS 3.
  - It runs the Pester suite, with `wsl.exe`, `schtasks.exe`, `netsh`, `New-NetFirewall*Rule`, `Register-ScheduledTask` and the registry mocked.
  - Pester's `Mock` of an existing cmdlet keeps that cmdlet's parameter metadata. In addition, `machine_commands_bind_against_real_cmdlet_metadata` checks every planned invocation against `(Get-Command <cmdlet>).Parameters`: all mandatory parameters supplied, no unknown ones, `ValidateSet` values accepted. A missing `-DisplayName` fails CI `[6b-R7]`.
  - It builds the `.exe` from `bundle-linux-x64`.
  - It fails if Pester reports any Skipped or NotRun test, or fewer tests than the count recorded in `test/expected-count.txt`. It never silently skips.
  - It uploads `windows-exe`.
  - Hosted runners can't run WSL2, so the real WSL work is the recorded gate in Step 5.

- [ ] **Step 1: Write the failing tests.**
  - **Pester:**
    - `preflight_reports_each_windows_requirement_with_fix` (every id)
    - `wsl_version_read_from_file_version_not_localized_output`, `inbox_wsl_fails_with_update_fix`
    - `distro_read_from_hkcu_lxss_and_wsl1_rejected`
    - `public_network_profile_flagged`
    - `mirrored_networking_change_needs_consent_and_preserves_other_keys`
    - `effective_mode_verified_after_shutdown_and_nat_detected`
    - `refuses_when_process_user_is_not_session_user`
    - `elevated_helper_changes_only_machine_scope` (the mocks assert no HKCU, profile or `wsl.exe` calls)
    - `firewall_rules_are_scoped` (port, protocol, profile, addresses, VMCreatorId)
    - `binding_persisted_and_reused_by_task`
    - `task_xml_has_no_tilde_and_absolute_paths` (with a non-ASCII Windows user name and a Linux home containing a space)
    - `task_xml_registers_for_real_on_hosted_runner` `[6b-R17]`. It needs no WSL:
      1. stage `task.xml` for the runner's own SID, with a harmless action (`cmd.exe /c exit 0`), under the test name `\RokidCoder-CI\xmltest`
      2. register it with the real `schtasks.exe /Create /XML`, export it back with `/Query /XML`, and compare the `Principal`, `Triggers` and `Settings`. The effective `DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` must both be `false` `[6b-R22]`.
      3. re-create the task from the exported file (the recovery path), then delete it
    - `wsl_calls_use_exec_with_argv_not_shell_strings`
    - `nat_fallback_proxy_targets_localhost_forwarding`, `localhost_forwarding_false_is_fixed_with_consent`
    - `start_agentd_writes_advertise_only_in_nat_mode`
    - `ports_classifies_current_legacy_and_other_owners` (the current install passes, legacy passes after consent, other blocks)
    - `legacy_windows_daemon_stopped_by_exact_identity_and_ports_verified` `[6b-R23]`: a detached legacy `node.exe` still listens after its task is deleted. It is stopped only when pid, path, command line and creation time all match. A reused pid with a different identity is never killed.
    - `same_version_repair_failure_restores_original_binding_launcher_and_task` `[6b-R21]`: Repair of the same `<v>`, switching mirrored to nat, with `ROKID_SETUP_FAIL_AT=9`. The original generation's binding, launcher and task XML are byte-identical, and that installation is running again.
    - `nat_mode_install_on_wsl_below_mirrored_min` and `declined_mirrored_selects_nat_and_skips_mirrored_items` `[6b-R1]`
    - `upgrade_with_running_daemon_passes_preflight`
    - `machine_commands_bind_against_real_cmdlet_metadata` `[6b-R7]`
    - `upgrade_reregisters_task_and_restores_exported_xml_on_failure`
    - `user_setup_stages_versioned_files_and_never_registers_or_overwrites` `[6b-R10]`
    - `failed_install_reverts_only_this_runs_machine_changes`
    - `uninstall_removes_task_proxy_firewall_and_plugins_keeps_state`, `uninstall_removes_only_recorded_proxy_and_rules`, `uninstall_asks_before_reverting_mirrored_mode`
  - **node:**
    - `wsl_install_autostart_runs_task_via_interop`, `wsl_stop_matches_exe_and_cmdline_only`
    - `wsl_legacy_task_exported_then_restored`
    - `advertised_endpoint_is_windows_host_in_nat_mode`, `advertised_endpoint_defaults_unchanged_elsewhere`
    - `qr_and_pair_ready_use_advertised_endpoint`
    - `pair_from_another_terminal_uses_persisted_endpoint` (no inherited env) `[6b-R3]`
    - `pair_credentials_carry_advertised_endpoint` (the 6a handover gives `wsHost` = the Windows host and `wsPort` = 8794)
    - `nat_refresh_rewrites_advertise_when_host_ips_change` (a fake interop `powershell.exe`)
    - `wsl_stop_current_waits_for_exit_and_free_ports`
    - `interop_fake_rejects_linux_paths_for_windows_executables` `[6b-R18]`: the fake `schtasks.exe` fails on any `/XML` argument starting with `/`. Install, upgrade and recovery all pass against it.
    - `wsl_failed_upgrade_restarts_previous_bundle_from_its_own_task_and_binding` `[6b-R10]`: an end-to-end test across `user-setup.ps1`'s staging output and `rokid-setup install` with a fake interop `schtasks.exe` and `ROKID_SETUP_FAIL_AT=9`. The re-created task's XML equals `task-previous.xml`, and its launcher/binding paths are the previous version's files, unchanged byte for byte.
    - `windows_gate_runs_after_cli_install_offer` `[6b-R2]`: with the launcher unverified and neither CLI present, `rk claude` and `rk codex` both offer the install first, then run `cli-installed`, then print the plugin-mode hint
    - `tailnet_discovery_uses_tailscale_exe_via_interop`
    - `rk_on_windows_without_verified_flag_prints_plugin_mode_hint`, `rk_on_macos_unaffected_by_windows_gate`
- [ ] **Step 2:** Implement, including `gate/netprobe.mjs`. It runs with the bundled node and has these modes:
  - `listen-tls --port`: prints the fp of the cert it was given
  - `dial-tls --host --port`: prints the peer fp
  - `listen-udp --port`
  - `send-udp --broadcast --port`

  It carries no secrets.
- [ ] **Step 3:** Green: Pester, node tests and `windows-installer.yml`. Commit `Install Rokid-Coder into WSL2 from a Windows installer that checks first`.
- [ ] **Step 4:** Implementation done. The recorded gate follows.
- [ ] **Step 5: The recorded Windows gate** `[FR 13, FR 14, FR 15]`. It runs on the user's Windows 11 laptop in the Windows session (HANDOFF), with the Mac on the same Wi-Fi as a LAN peer. Results go in `docs/coding-agent/releases/1.0.0-windows-gate.md`, with a date, the build, the WSL version and pass/fail for each item:
  - **W1:** A fresh install as a standard user, with the UAC prompt answered by an admin account. Then `binding-<gen>.json` names the session user's SID, distro and Linux user.
  - **W2:** Reboot and log on. agentd is up with no visible window (`agentd status` in WSL). Unplug the charger: agentd is still up 2 minutes later `[6b-R22]`. If `conhost --headless` shows a window, the fallback is recorded and fixed in the fix wave.
  - **W3: mirrored, both directions.**
    - Inbound: from the Mac, `netprobe dial-tls --host <win LAN IP> --port 8792` prints agentd's fp, which equals `agentd` in WSL.
    - Outbound: the Mac runs `listen-tls --port 8792` and `listen-udp --port 8793`, and WSL runs `dial-tls` to it and `send-udp --broadcast`; both arrive.
    - Repeat once with the Hyper-V rules removed and once with the host rules removed, and record which layer is needed.
  - **W4: NAT, both directions.** Set `networkingMode=nat` and run Repair. Then:
    - inbound: the Mac's `dial-tls` to `<win LAN IP>:8794` works
    - outbound: WSL's `dial-tls` to the Mac works
    - the QR shows the Windows host IP and 8794
    - restart WSL (a new WSL IP), and inbound still works with no change
  - **W5:** A phone pairs by QR in NAT mode, then mirrored mode is restored and discovery pairing works.
  - **W6:** Plugin-mode smoke in WSL for Claude Code AND Codex: `/rokid:on` (Claude) and `rokid:on` (Codex) attach, and an approval reaches the phone.
  - **W7:** (a) Upgrade over the previous build, keeping the pairing. (b) Reinstall the previous build, then upgrade with `ROKID_SETUP_TEST=1 ROKID_SETUP_FAIL_AT=9`: the previous build is running again, from its own task XML and binding, with the pairing kept.
  - **W8:** Uninstall: the task, proxy, firewall rules and plugins are gone and the state is kept. Then purge removes the state.
  - **W9:** The `rk` safety suite with `ROKID_RK_WINDOWS_VERIFIED=1`. It records whether `WINDOWS_LAUNCHER_VERIFIED` may be flipped (U33).

  6c's T10 does not publish without W1–W8 passing. W9 only decides the launcher hint.

## Self-review against the findings
| Finding | Where it is resolved |
|---|---|
| **FR 9: plugin provisioning** | T7a bundles both plugins and their marketplaces. T7p `plugins.ts` does the idempotent sync and removal per CLI, through the vendor CLIs, with the spike-pinned verbs and a defined manual fallback. It runs at setup, on `cli-installed` (T9's later install), on upgrade and on uninstall. |
| **FR 10: CI runner** | `macos-15-intel` replaces `macos-13`. `MACOSX_DEPLOYMENT_TARGET=13.0` plus the `minos ≤ 13.0` check, and the macOS 13 VM gate M1–M2 for the minimum OS. |
| **FR 11: console user** | `resolve-user.sh` (resolution) is separate from `launch-setup.sh` and `Rokid Coder Setup.command` (setup). There are unit tests for each, a real other-uid setup, a real GUI-session test, and the recovery for `deferred_cli_install`/`no_eligible_user`. |
| **FR 12: clean runtime** | `agentd --version` and `selfcheck`. Hooks, daemon and a real PTY run in clean containers under `strace`, and on macOS with the toolchains removed and a `sandbox-exec` allowlist. The loaded natives are checked to be inside the bundle. |
| **FR 13: Windows user binding** | The unelevated installer, with a machine-scope-only elevated helper and the session-user check. The per-generation `binding-<gen>.json` (SID, distro, Linux user/uid, absolute paths) is staged and then reused by the task, with `--exec` and no `~`. |
| **FR 14: Windows networking** | The WSL version from the file version, the effective-mode verification, scoped host and Hyper-V rules, the NAT proxy via localhost forwarding (no refresh on a WSL IP change), the advertised endpoint, cleanup of recorded objects only, and gate W3–W5 in both directions. |
| **FR 15: upgrade and uninstall** | T7p's quiesce-then-snapshot over an explicit STATE/PROGRAM/TRANSACTION inventory, the non-destructive check, the replace-and-verify-identity upgrade transaction (also between installer releases), the journaled rollback and the `rollback` command. Multi-user-safe pruning on macOS. The old autostart is retired on both OSes. The real 0.8.0 upgrade runs on CI. Windows uninstall removes the task, proxy, firewall and plugins and keeps state unless purged. |
