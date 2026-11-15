Reviewed the current working-tree plan, read-only. No builds or tests were run.

References below use **6b** for [the installer plan](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6b-installers.md), and **6a** for its READY foundation/pairing dependency.

The original findings:

| Finding | Status | Evidence |
|---|---|---|
| #9 — Plugin provisioning | **RESOLVED** | 6b:153 supplies both plugin artifacts; 299–321 defines provisioning/removal. Lines 225–229 and 316–320 connect later CLI installation to provisioning. |
| #10 — Intel macOS runner | **RESOLVED** | 6b:174–184 selects `macos-15-intel`, checks deployment targets, and separates minimum-OS verification. Lines 502–507 define the recorded gate. The selected labels match [GitHub’s runner documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job). |
| #11 — Intended macOS user | **RESOLVED** | 6b:417–432 separates resolution, launching and recovery. Lines 475–487 distinguish explicit other-user execution from the actual console-user GUI test. |
| #12 — Clean-runtime proof | **NOT RESOLVED** | Version, native loading and real PTY checks now have producers (6b:161–172), but the required wrappers invoke `dirname` (154), which both executable allowlists exclude (203–210). |
| #13 — Windows user binding | **RESOLVED** | 6b:522–525 separates user installation from machine elevation. Lines 541–567 persist and reuse the Windows SID, distro, Linux user and absolute executable path. |
| #14 — Windows networking | **NOT RESOLVED** | Endpoints, scopes and recorded gates are specified, but mandatory preflight checks contradict NAT fallback (6b:526–538 versus 585), and CLI endpoint propagation is incomplete (556–588). |
| #15 — Upgrade/uninstall | **NOT RESOLVED** | Contracts now exist (6b:327–360, 596–609), but replacement of an already installed daemon, consistent snapshots and restoration of excluded files remain incomplete. |

Fresh findings follow. All are **Important**; I found no additional Critical issue.

1. **Windows preflight blocks supported fallback and upgrade paths.**  
   **Evidence:** 6b:526 permits installation only after every non-optional check passes. The table requires the mirrored minimum version and mirrored networking (532, 537), while NAT fallback explicitly supports older versions or declined mirrored mode (585). `ports_free` also requires 8791/8792 to be unused (539), although an upgrade normally encounters the installed daemon.  
   **Fix:** Select the network mode before evaluating mode-dependent requirements. Define a separate NAT minimum, and distinguish ports owned by the recorded installation, a retireable legacy installation, and unrelated processes. Test NAT installation and upgrade with the existing daemon running.

2. **The Windows launcher gate suppresses the required missing-CLI offer.**  
   **Evidence:** T8 places its check at the top of `runClaude`/`runCodex` (6b:91) and exits immediately when launcher mode is unverified (593–595). T9’s installation offer occurs later, at missing-executable resolution (230–234). Thus a Windows installation with neither CLI cannot obtain the promised offer through `rk`. This conflicts with design:285.  
   **Fix:** Resolve or offer installation and provision the plugin before applying the launcher restriction. The restriction can then print plugin-mode instructions. Add integration tests for both missing CLIs with verification disabled.

3. **NAT endpoint overrides do not reach independently launched pairing clients.**  
   **Evidence:** Only `start-agentd.ps1` exports `ROKID_ADVERTISE_HOSTS` and `_PORT` (6b:563–567). Setup launches `agentd pair` as another process (344), and users can run it from another terminal. `advertisedEndpoint` falls back to the WSL interface address and configured port when those variables are absent (588; current `agentd/src/pairing.ts:8–20,29–35`).  
   **Fix:** Make the daemon’s advertised endpoint authoritative and expose it to pairing clients through IPC, or persist and load the overrides for every relevant entry point. Cover installer pairing, later terminal pairing, and credential handover using Windows-host:8794 without inherited overrides.

4. **Upgrade never explicitly replaces the current product daemon.**  
   **Evidence:** The orchestrator handles legacy autostart and then calls `installAutostart` (6b:338–342). macOS installation only specifies `bootstrap` (440–445), which does not replace an already loaded label. Windows uses `/Run` with `IgnoreNew` (561, 569), allowing the existing process to remain. `/health` proves availability, not that the new bundle is running; current `agentd/src/cli.ts:24–31,50–53` has no version identity.  
   **Fix:** Add an explicit current-install upgrade transaction: record the previous service, stop it, wait for exit, install/reload the replacement, and verify its bundle/version or executable identity. Rollback must stop the replacement before restoring and restarting the previous service. Test a second installer release, separately from legacy 0.8.0 migration.

5. **Snapshot and restore semantics cannot safely preserve the installation transaction.**  
   **Evidence:** Snapshot occurs before the old daemon is stopped (6b:337–338), so concurrent state writes can produce an inconsistent copy. Snapshot excludes program files and backups, while `restore` replaces both complete state locations (328–330). With the default state directory, that replacement removes excluded wrappers, plugin copies, manifest and transaction metadata.  
   **Fix:** Define a quiesced snapshot boundary and an explicit state-file restoration inventory. Preserve installer metadata and excluded program paths during restoration, and keep the journal/snapshot accessible throughout recovery. Test rollback with the default overlapping directory layout and concurrent daemon activity.

6. **macOS pruning can delete another user’s active or rollback bundle.**  
   **Evidence:** Root `postinstall` keeps the new version and only one version most recently referenced by any user manifest (6b:411–414). Multiple users may reference different versions; manifests also contain previous-version rollback references (290). Pruning happens before the new user setup commits.  
   **Fix:** Retain every version referenced by any user’s current or previous installation, plus pending transactions. Prune only unreferenced versions after a safe commit boundary. Add a multi-user test covering different active versions and a pending upgrade.

7. **The specified Hyper-V firewall command lacks a required argument.**  
   **Evidence:** The exact `New-NetFirewallHyperVRule` invocation at 6b:579 supplies `-Name` but omits mandatory `-DisplayName`. The elevated operation can prompt or fail instead of completing. Microsoft explicitly documents `DisplayName` as required. [Cmdlet documentation](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallhypervrule?view=windowsserver2025-ps)  
   **Fix:** Provide complete commands for both rules, including `DisplayName`, and validate their parameter binding against the supported Windows environment. Ensure Pester mocks preserve mandatory-parameter validation rather than accepting arbitrary arguments.

8. **The clean-runtime executable allowlists reject the planned wrappers.**  
   **Evidence:** Bundle wrappers execute external `dirname` (6b:154), but Linux permits only bundle paths and three shells (206); macOS similarly excludes `/usr/bin/dirname` (208–209). The required checks therefore fail even with correctly bundled Node and node-pty. The clean Ubuntu image also needs an explicit provision for `strace` before line 205 can run.  
   **Fix:** Remove external `dirname` through shell parameter expansion, or explicitly allow the necessary system utilities while continuing to prohibit external runtimes and compilers. Specify installation of tracing tools separately from the forbidden runtime/toolchain set. Verify the actual wrapper commands under the resulting policy.

9. **The bundle artifact handoff lacks an archive contract that preserves executable files and hidden manifests.**  
   **Evidence:** T7a produces a directory (6b:146) and uploads `bundle-<target>` (211); downstream workflows consume it (454, 613). Windows expects a `.tgz` (554), but no producer or archive format is defined. Ordinary artifact-directory uploads lose executable permissions and exclude hidden files by default, affecting Node, wrappers, `spawn-helper`, and both marketplace directories. [GitHub artifact documentation](https://github.com/actions/upload-artifact#permission-loss)  
   **Fix:** Make T7a produce a defined tar archive and digest for every target, preserving modes, symlinks and hidden files. Require downstream workflows to extract it and run layout/selfcheck validation on the downloaded artifact before packaging.

The wave ownership table has no direct same-wave file conflict: T9 and T8’s `rk.ts` changes are correctly separated. The SAS trust boundary is also preserved explicitly at 6b:22–23, 58–59 and 350–351. The recorded Windows laptop gate is appropriate and accepted; hosted WSL2 execution is not required.

VERDICT: NOT READY