Reviewed read-only. No builds or tests were run, and no files were changed.

References use **6b** for [the installer plan](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6b-installers.md).

**Original findings #9–#15**

| Finding | Status | Evidence |
|---|---|---|
| #9 — Plugin provisioning | **RESOLVED** | 6b:159 bundles both plugins; 326–354 defines provisioning, restoration and removal. Lines 249–253 connect later CLI installation to provisioning. |
| #10 — Intel macOS runner | **RESOLVED** | 6b:190–200 selects supported runners and separates deployment-target validation from the minimum-OS gate at 597–602. `macos-15-intel` is listed by [GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). |
| #11 — Intended macOS user | **RESOLVED** | 6b:491–506 separates resolution, launching and recovery. Lines 555–567 distinguish explicit other-user setup from the console-user GUI check. |
| #12 — Clean-runtime proof | **RESOLVED** | 6b:177–188 defines version/selfcheck producers; 222–234 exercises hooks, daemon and a real PTY under executable restrictions. |
| #13 — Windows user binding | **RESOLVED** | 6b:617–620 separates machine elevation from user setup; 643–674 persists and reuses the intended principal, distro and Linux user. Task-registration defects remain below. |
| #14 — Windows networking | **RESOLVED** | 6b:621–642 makes preflight mode-dependent; 688–720 defines scoped rules, NAT forwarding, persistent advertised endpoints and Tailscale discovery. W3–W5 validates the real paths. |
| #15 — Upgrade/uninstall | **NOT RESOLVED** | The transaction is substantially specified at 379–419, but macOS legacy recovery still contradicts it, and system uninstall can remove another user’s bundles. See fresh findings 1 and 4. |

**Round-2 fresh findings**

| Finding | Status | Evidence |
|---|---|---|
| 1 / R10 — Windows overwrites rollback inputs | **RESOLVED** | 6b:644–647 stages versioned files; 665–684 registers the task inside the transaction and preserves previous task inputs. Line 781 requires integration coverage. |
| 2 / R11 — Plugin content restoration | **RESOLVED** | 6b:327–329 uses immutable versioned sources; 350–353 restores registration, version and installed content. Line 443 checks distinguishable hook payloads. |
| 3 / R12 — Single recovery sequence | **NOT RESOLVED** | 6b:397–406 defines the correct sequence, but `darwin.ts` still bootstraps during restoration at 513, contradicting the separate start at 403. |
| 4 / R15 — Hosted Windows executes Linux archive | **RESOLVED** | 6b:167–170 separates exact-archive runtime validation from static consumer validation. Windows explicitly does not execute the Linux bundle. |
| 5 / R13 — Environment generated before CLI installation | **RESOLVED** | 6b:389–390 re-resolves CLIs and writes `env` after installation; 521 explicitly rewrites it before restarting. Line 444 covers installation outside the original PATH. |
| 6 / R14 — Impossible legacy rollback CI scenario | **RESOLVED** | 6b:548–583 isolates clean-runtime, successful legacy-upgrade and failed legacy-upgrade jobs. Both legacy scenarios retain the old runtime. |

**Fresh full review**

All findings below are **Important**. No Critical findings were identified.

1. **macOS legacy recovery starts the service twice.**

   **Evidence:** 6b:402 requires `restoreLegacyAutostart` to restore records without starting anything; 403 then starts the legacy service exactly once. However, the concrete Darwin hook at 513 restores the plist **and runs `bootstrap`**, reinforced by the test at 542. Following both contracts makes the second bootstrap target an already loaded label, potentially failing recovery before the journal closes.

   **Fix:** Make `restoreLegacyAutostart` restore only the plist. Assign bootstrap exclusively to recovery step 6, and update the Darwin test to verify exactly one bootstrap across the complete legacy rollback.

2. **The scheduled-task XML specifies invalid principal values.**

   **Evidence:** 6b:665–666 says `task.xml` holds `LogonType Interactive` and `RunLevel Limited`. Those are PowerShell-facing names, whereas Task Scheduler XML requires `InteractiveToken` and `LeastPrivilege`. The planned `/Create /XML` at 676 therefore cannot register XML containing the specified values. See Microsoft’s [logon-type schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-simpletype) and [run-level schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-runleveltype-simpletype).

   **Fix:** Specify the XML values explicitly. Add schema validation or an actual harmless task-registration check on the hosted Windows runner; mocking `schtasks.exe` does not validate its XML input. This requires no WSL2 execution.

3. **The task XML path crosses into Windows without conversion back to Windows syntax.**

   **Evidence:** 6b:663 passes `--task-xml` as a `wslpath` result, and 316 records that path in the manifest. Line 676 then passes the manifest’s task path directly to Windows `schtasks.exe /XML`. Windows tools invoked through WSL receive arguments unmodified and require Windows-format paths; `/mnt/c/.../task.xml` is not automatically translated. [Microsoft’s WSL interoperability documentation](https://learn.microsoft.com/en-us/windows/wsl/filesystems) describes this boundary.

   **Fix:** Define distinct Linux and Windows path fields, or require `wslpath -w` immediately before `/XML`. Apply the same rule to restoring `task-previous.xml`. Make the interop fake reject Linux-format `/XML` arguments.

4. **macOS system uninstall can delete bundles still used by users with homes outside `/Users`.**

   **Evidence:** 6b:526 authorizes deleting the entire system payload after checking only `/Users/*/.rokid-coder/install.json`. The plan already recognizes this enumeration problem for pruning and requires directory-service home discovery at 487. A user whose home is elsewhere is invisible to uninstall’s guard, so another user’s ordinary `--system` uninstall can remove their active and rollback bundles.

   **Fix:** Reuse the directory-service enumeration and reference checks from pruning, including current/previous manifests and pending transactions/handoffs. Add an uninstall test with another user’s home outside `/Users`, requiring refusal without `--force`.

5. **The generated daemon PATH can find an npm-installed CLI but omit its Node interpreter.**

   **Evidence:** 6b:325 constructs PATH from system directories plus resolved **CLI** directories. It does not retain the separately resolved user Node directory. A valid installation with Codex in `~/.npm-global/bin` and Node under an nvm directory therefore passes interactive CLI resolution but fails after autostart. Codex’s [npm launcher](https://raw.githubusercontent.com/openai/codex/main/codex-cli/bin/codex.js) uses `#!/usr/bin/env node`; the daemon invokes Codex by executable name in [monitor.ts](~/Desktop/rokid/Rokid-Coder/agentd/src/codex/monitor.ts:238). The old LaunchAgent explicitly included Node’s directory at [install-launchagent.sh:34](~/Desktop/rokid/Rokid-Coder/agentd/scripts/install-launchagent.sh:34).

   **Fix:** Preserve the resolved user runtime directory for supported script-based CLIs, and verify the CLI under the exact generated daemon environment before committing setup. Add a fixture with CLI and Node in different directories, covering initial installation and `refreshDaemonEnv`.

The same-wave ownership assignments have no direct collision; T9 and T8 edit `rk.ts` in separate waves. The plan preserves 6a’s SAS trust boundary and explicitly prevents answers files from confirming pairing. The recorded Windows laptop gate remains appropriate; hosted WSL2 execution is not required. The open issues concern concrete platform contracts and missing validation at those boundaries.

VERDICT: NOT READY