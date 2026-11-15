Reviewed read-only. No builds or tests were run; no files were changed.

References use **6b** for [the installer plan](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6b-installers.md).

**Original findings #9–#15**

| Finding | Status | Evidence |
|---|---|---|
| #9 — Plugin provisioning | **RESOLVED** | 6b:159 bundles both plugins; 329–357 defines provisioning, restoration and removal. Lines 249–253 connect later CLI installation to provisioning. |
| #10 — Intel macOS runner | **RESOLVED** | 6b:190–200 selects `macos-15-intel`, which [GitHub lists as supported](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). Lines 601–606 separately gate minimum-OS compatibility. |
| #11 — Intended macOS user | **RESOLVED** | 6b:495–510 separates resolution, launch and recovery. Lines 559–571 distinguish explicit other-user setup from the console-user GUI check. |
| #12 — Clean-runtime proof | **RESOLVED** | 6b:177–188 defines version/selfcheck producers; 222–234 exercises hooks, daemon and a real PTY under executable restrictions. |
| #13 — Windows user binding | **RESOLVED** | 6b:621–624 separates privilege scopes; 647–679 persists and reuses the intended Windows principal, distro, Linux user and absolute paths. |
| #14 — Windows networking | **RESOLVED** | 6b:625–646 makes preflight mode-dependent; 694–726 defines scoped rules, NAT forwarding and persisted endpoint propagation. W3–W5 checks the actual paths. |
| #15 — Upgrade/uninstall | **NOT RESOLVED** | The transaction is defined at 382–422, but same-version Repair bypasses its preservation rules, and Windows legacy retirement does not stop the existing daemon. See findings 1 and 3 below. |

**Round-3 fresh findings**

| Finding | Status | Evidence |
|---|---|---|
| R16 — Darwin restoration bootstraps prematurely | **RESOLVED** | 6b:517 explicitly restores only the plist. Lines 405–406 assign the single start to recovery step 6; 546 tests the complete sequence. |
| R17 — Invalid Task Scheduler XML values | **RESOLVED** | 6b:670 specifies `InteractiveToken` and `LeastPrivilege`. Lines 767–770 require real hosted-Windows registration, export and recreation. |
| R18 — Linux paths passed to Windows executables | **RESOLVED** | 6b:316 stores both path forms; 681–686 uses Windows paths for registration and restoration. Line 791 requires rejecting Linux-format `/XML` arguments. |
| R19 — System uninstall misses homes outside `/Users` | **RESOLVED** | 6b:530 reuses directory-service enumeration and all reference classes. Line 549 covers an external home and a pending handoff. |
| R20 — Daemon PATH omits CLI interpreter directories | **RESOLVED** | 6b:326–328 includes interpreter directories and verifies CLIs under the generated environment. Line 432 covers separate CLI/Node directories and refresh. |

**Fresh full review**

No Critical findings. Three **Important** findings remain:

1. **Same-version Windows Repair overwrites rollback inputs before journaling.**

   **Evidence:** 6b:648–651 protects previous files through versioned paths, but 663 explicitly stages Repair into the **same `<v>`**. Consequently, its existing binding, launcher and `task.xml` can be overwritten before setup starts at 667. The previous task is exported only later at 686; restoring it at 690 therefore references files that Repair already replaced. Network-mode Repair is a required path at 812–817.

   **Fix:** Stage each Repair under a unique installation generation, or capture and journal existing files before replacing them. Reuse the existing verified bundle rather than extracting over it while running. Add a same-version Repair failure test with changed binding/network mode, asserting restoration of the original binding, launcher, task and running installation.

2. **The scheduled task retains the default “stop on battery” behavior.**

   **Evidence:** 6b:672 sets `DisallowStartIfOnBatteries=false` but omits `StopIfGoingOnBatteries`, whose [schema default is `true`](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-stopifgoingonbatteries-settingstype-element). Unplugging the laptop can therefore terminate the long-running launcher defined at 674–679. The plan defines no automatic restart for that transition.

   **Fix:** Set `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`. Assert the effective exported value in the real registration test, and extend W2 to verify daemon availability after switching from AC to battery.

3. **Windows legacy retirement deletes the task without quiescing its detached daemon.**

   **Evidence:** 6b:645 permits a running legacy Windows `node.exe` after retirement consent. However, 693 specifies only exporting and deleting `NexusAgentd`. The existing [run-hidden.vbs:8](~/Desktop/rokid/Rokid-Coder/agentd/scripts/run-hidden.vbs:8) starts Node asynchronously; [deleting a scheduled task does not interrupt its running program](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-delete). The `/proc` termination procedure at 683 targets Linux bundle processes and cannot stop this Windows process. Thus step 3’s quiescence requirement at 389 is unmet.

   **Fix:** Record the authenticated legacy Windows process identity and stop that exact daemon with consent, then verify the host ports are free before proceeding. Alternatively, require the user to stop it and block until verified. Preserve its restart information for rollback, and add coverage with a detached Windows legacy daemon still listening.

The ownership table has no direct same-wave file collision. The plan preserves 6a’s SAS trust boundary, and the recorded Windows laptop gate remains appropriate. The remaining defects concern Repair transaction integrity and Windows process lifecycle.

VERDICT: NOT READY