# Rokid-Coder Plan 6b: Computer installers (macOS + Windows/WSL2) Implementation Plan (DRAFT: split from Plan 6 rev 2; NOT yet Codex-READY)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the computer side as self-contained bundles and as installers that check first: macOS `.pkg`/`.dmg` and Windows `.exe` into WSL2. Plugin provisioning, upgrade and uninstall are included.

**Depends on:** Plan 6a merged (the new layout, `computer/`, `plugin/`, SAS pairing clients).

**Spec:** `docs/coding-agent/claude/design/2026-11-15-v1-product-design.md`. Later sections override earlier ones. Also read `docs/coding-agent/HANDOFF.md`. The original combined plan and its reviews: `2026-11-15-plan-6-v1.md`, and `docs/coding-agent/codex/reviews/2026-11-15-plan-6-*`.

**Status:** this is a DRAFT. Before execution:
1. Revise it to resolve every item in "Open findings to resolve".
2. Get a Codex sol review until READY (U14).
3. Execute with parallel tasks and one Codex review at the end (U15).

## Global Constraints

**Branch and commits**
- Branch `release/1.0.0`. Within a wave, tasks run in parallel worktrees, and ONLY on the files the ownership table gives them (U15).
- After the last wave: ONE Codex sol review, one fix wave, then a Codex re-check.
- Commits are imperative, with NO Co-Authored-By and no AI attribution. Tasks never push; the controller does.

**Never touch**
- `local.properties`. Never create a private SDK, Gradle home or cache in the tree. On an environment failure, stop and report.
- `~/.claude`, `~/.codex`, or the real `~/.rokid-coder`. Tests use temp state dirs. Never type `/model` into a real `claude`. No adb on the user's devices.
- Never print a token, `steer`, the pairing line, a full fingerprint, or SAS nonces into Claude/Codex session output, or into logs above debug.

**Identity and versions**
- Application ids: `io.github.debasishdebs.rokidcoder` (phone) and `io.github.debasishdebs.rokidcoder.glasses`. Kotlin class namespaces may stay `com.anezium.rokidbus.*`.
- Display names: "Rokid Coder" and "Rokid Coder Glasses".
- Version 1.0.0 everywhere. Android versionCode `10000`.
- The release key is NEW, so this is a fresh install (U16).
- Signing env vars stay `NEXUS_RELEASE_KEYSTORE`, `NEXUS_RELEASE_KEYSTORE_PASSWORD`, `NEXUS_RELEASE_KEY_ALIAS`.

**Runtimes and sources**
- Node 22 LTS, pinned to an exact patch version in `computer/runtime/node-version.txt`. Hooks, the LaunchAgent and the scheduled task call `rokid-node`, never bare `node`.
- CxrGlobal is the sibling `<repoRoot>/../CxrGlobal`, pinned at v0.3.0's SHA. `cxr-service-bridge` is pinned to `1.0-20260522.063600-105`. The upstream base SHA is `15cd98ad`.

**Security (U8, R1′, R12′)**
- Pinned mutual TLS on every computer↔phone link. Every NEW pairing passes the SAS code check, on every path, including the QR/pairing-line fallback `[CR 2]`.
- Nexus `SppAuthProtocol`, authenticated enrollment and frame replay protection are untouched.

**Suites**
The parity gate compares test identities AND outcomes, not just counts `[CR 6]`:
- `cd computer && npm test`
- `./gradlew :mobile:app:testDebugUnitTest :glasses-app:testDebugUnitTest :phone-core:testDebugUnitTest :shared:test :bus-client:testDebugUnitTest :ink-engine:test :glasses-hub:testDebugUnitTest`
- Only the 2 known `GlassesFileStoreTest` failures are allowed. They are recorded by name.


## Open findings to resolve (from `docs/coding-agent/codex/reviews/2026-11-15-plan-6-full-rereview.md`)
- **#9: plugin provisioning.**
  - Bundle the Claude and Codex plugin artifacts.
  - Define idempotent register and remove for each CLI.
  - Run provisioning after initial setup AND after a later T9 CLI install.
  - The existing `install-hooks` (cli.ts:100-108) is not enough.
- **#10: CI runner.** `macos-13` is retired (Dec 2025). Pick a supported Intel runner, set a macOS 13 deployment target, and test the minimum OS separately.
- **#11: the macOS console user.**
  - Separate user resolution from user setup, and test each.
  - Run setup under the intended UID with explicit HOME and environment.
  - Keep a real GUI-session test.
  - Define recovery when there is no eligible console user.
- **#12: clean-runtime proof.**
  - Add an explicit `agentd --version` command (it doesn't exist today, cli.ts:238-240).
  - Run the bundled hooks, daemon startup and a REAL PTY spawn, with captured executable paths and a controlled environment.
  - A decoy PATH and `CC=false` are not proof.
- **#13: Windows user binding.**
  - Separate privileged machine changes from user setup.
  - Persist the Windows principal, distro, Linux UID and resolved executable path, and reuse them at login.
  - No bare `~` in the scheduled task.
- **#14: Windows networking.**
  - Validate the WSL version needed for mirrored mode, and configure scoped host and Hyper-V firewall rules.
  - For the NAT/portproxy fallback, define the advertised address, proxy refresh when the WSL IP changes, and cleanup.
  - Test both connection directions.
- **#15: upgrade and uninstall.**
  - Migrate both state locations (`~/.nexus-agentd`, `~/.rokid-coder`) and retire old autostart entries (the old LaunchAgent holds the ports).
  - Rollback.
  - On Windows, remove the task, proxy, firewall rules and plugins; keep state unless purged.

## Tasks (carried over from Plan 6 rev 2; revise them per the findings above)

### Task 7a: Computer bundles for macOS arm64/x64 and Linux x64, and the wrappers (R5) `[CR 9]`

**Files:** see the ownership table.

**Interfaces:**
- **Produces:**
  - `computer/installer/bundle/build.mjs --target <darwin-arm64|darwin-x64|linux-x64>`, which writes `dist-bundle/<target>/` containing `node/` (pinned), `app/` (dist plus production node_modules, with node-pty built for that Node ABI and target) and `bin/{rokid-node,agentd,rk}`
  - `bin/rokid-node` resolves its own directory, so the bundle runs from any path
  - hooks call `"$HOME/.rokid-coder/bin/rokid-node"`, quoted (Windows: inside WSL)

- [ ] **Step 1: Write the failing tests:**
  - `bundle_contains_pinned_node_and_matching_node_pty`, which checks the native binary's arch with `file`, and that the ABI equals the pinned Node's `process.versions.modules`
  - `wrappers_and_hooks_work_from_a_path_with_spaces_and_non_ascii`
  - `hooks_never_call_bare_node`
  - CI job `bundles.yml`: build all three targets and run `agentd --version` from each bundle on its native runner (macos-latest arm64, macos-13 x64, ubuntu-latest)
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit `Build self-contained computer bundles with a pinned Node`.

### Task 7b: The macOS installer: check first, then install, then user setup (U37, §13.1) `[CR 8]`

**Files:** see the ownership table.

**Interfaces:**
- **Pre-install check:** the `.pkg`'s Distribution `installation-check` (JavaScript) blocks on macOS < 13 and on missing disk space or write access, with the fix message. These are the only hard prerequisites.
- **The pkg payload** installs the bundle into `/Library/Application Support/RokidCoder/<version>/` (system-wide, read-only).
- **User setup:** the postinstall resolves the console user (`stat -f%Su /dev/console` and their uid) and runs `launchctl asuser <uid> sudo -u <user> …` to open **"Rokid Coder Setup"** in Terminal as that user. Setup, as the user:
  1. Copy or link into `~/.rokid-coder/bin`.
  2. The skippable CLI step: "Install Claude Code? / Codex? / Skip".
  3. Install the plugins for the CLIs present.
  4. Bootstrap the LaunchAgent (`launchctl bootstrap gui/<uid>`).
  5. Start pairing (T6 client: show the code, confirm).
  6. The post-install reachability check, with the Tailscale and QR fallbacks.
  7. If Tailscale is missing on the computer, print the optional install link (U38) `[CR 11]`.
- **Uninstall:** `uninstall.sh` removes the app, runtime, LaunchAgent and plugins. State is kept unless `--purge` is given.
- **Artifacts:** `rokid-coder-1.0.0-macos-arm64.pkg` / `-x64.pkg`, each in a `.dmg`.

- [ ] **Step 1: Write the failing tests:**
  - `installation_check_blocks_old_macos_with_fix`
  - `preflight_cli_step_is_skippable`
  - `setup_runs_as_console_user_not_root`
  - `uninstall_keeps_state_unless_purge`
  - `upgrade_from_0_8_0_layout_keeps_pairings`
  - CI job `macos-installer.yml` `[CR 10]`: build the pkg, then run `sudo installer -pkg … -target /` for a test user whose home has spaces and non-ASCII characters. A clean machine can't be faked on a hosted runner, so the job proves independence:
    - **A fake `node` on PATH:** a decoy `node` that exits 99 is first on PATH, and the install must never call it.
    - **No compiler:** `CC=false CXX=false` and no `node-gyp` in the logs, so any native compile fails the job.
    - **Bundled tools only:** a static check that postinstall and setup call only bundled binaries or `/usr/bin` and `/bin` built-ins.

    T13 installs on the user's Mac for real. Setup runs non-interactively through `ROKID_SETUP_ANSWERS`, and `agentd --version` plus `launchctl print gui/<uid>/…` are asserted.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit `Ship the computer side as a macOS package that checks first and sets up as the user`.

### Task 8: The Windows installer into WSL2 (R4, U33, U34, U37) `[CR 9, CR 10]`

**Files:** see the ownership table.

**Interfaces:**
- **Consumes:** T7a's `linux-x64` bundle. `[CR rev2-d]`
- **Windows setup**, run inside WSL as the user through `wsl -d <distro> -- bash -lc …`:
  1. Place the bundle at `~/.rokid-coder/` in the WSL home.
  2. The skippable CLI step, inside WSL.
  3. Install the plugins for the CLIs present in WSL.
  4. Autostart is the Windows scheduled task below, NOT a LaunchAgent.
  5. Pairing (T6 client).
  6. The reachability check, with the Tailscale and QR fallbacks.
  7. The optional Tailscale link.
- **Produces:**
  - **The installer:** `rokid-coder-1.0.0-windows-x64.exe` (NSIS).
  - **Preflight ids:** `windows_version` (11 22H2+), `wsl2_present`, `wsl_distro` (Ubuntu by default), `wsl_mirrored_networking` (sets `networkingMode=mirrored` and runs `wsl --shutdown` after consent), `firewall_8792`.
  - **Autostart:** the scheduled task `RokidCoder agentd` runs `wsl -d <distro> -- ~/.rokid-coder/bin/agentd run` at logon.
  - **Fallback:** a local `netsh interface portproxy` for 8792 plus a firewall rule, only if mirrored mode fails. Never router forwarding.
  - **The Windows launcher gate (U33)** `[CR 9]`: a flag `ROKID_RK_WINDOWS_VERIFIED` is set by the Windows session's result. When it isn't set, `rk claude` / `rk codex` inside WSL-on-Windows prints `"Launcher mode isn't verified on Windows yet — use plugin mode: type /rokid:on in Claude"` and exits 0.
  - **Tailscale:** `tailnet-discovery` calls `tailscale.exe` via interop, falling back to `tailscale`.
- **CI** `[CR 10]`:
  - Hosted Windows runners can't run WSL2 (no nested virtualisation). CI runs the Pester and node tests with a mocked `wsl.exe` and `netsh`, plus the NSIS build. It never silently skips.
  - The real WSL2 install, mirrored networking and plugin-mode smoke are a MANDATORY gate in Step 3, on the user's laptop, with recorded results. T10 does not publish without them.

- [ ] **Step 1: Write the failing tests:**
  - Pester: `preflight_reports_each_windows_requirement_with_fix`, `mirrored_networking_change_needs_consent`, `scheduled_task_runs_agentd_in_wsl`, `portproxy_fallback_is_local_only`
  - node: `tailnet_discovery_uses_tailscale_exe_via_interop`, `rk_on_windows_without_verified_flag_prints_plugin_mode_hint`
- [ ] **Step 2:** Implement.
- [ ] **Step 3: The Windows session.** On the user's Windows 11 laptop: install, a plugin-mode smoke, the `rk` safety suite. Record whether `ROKID_RK_WINDOWS_VERIFIED` may be set.
- [ ] **Step 4:** Commit `Install Rokid-Coder into WSL2 from a Windows installer that checks first`.

### Task 9: `rk` offers to install a missing Claude Code or Codex (§2)

**Files:** see the ownership table. It edits only one hook point in `rk.ts`, after T6.

**Interfaces:** `offerCliInstall(tool: "claude" | "codex"): Promise<"installed" | "skipped" | "failed">`. It shows the vendor's official command and runs it only after `[y/N]` = y. Verify each vendor's current official install command against their docs at implementation time, and pin it in `cli-install.ts` with the docs URL.

- [ ] **Step 1: Write the failing tests:**
  - `neither_cli_install_offers_official_installer_and_never_runs_unconfirmed`
  - `non_tty_never_prompts_prints_command`
  - `install_failure_prints_command_to_run_manually`

  Use fakes only.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Commit `Offer to install Claude Code or Codex when rk cannot find it`.

