Reviewed read-only. No builds or tests were run.

References use **6b** for [the revised installer plan](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-15-plan-6b-installers.md).

Original full re-review findings:

| Finding | Status | Evidence |
|---|---|---|
| #9 — Plugin provisioning | **RESOLVED** | 6b:159 bundles both plugins; 323–345 defines registration, update and removal, including provisioning after later CLI installation. |
| #10 — macOS Intel runner | **RESOLVED** | 6b:187–196 selects `macos-15-intel`, checks deployment targets and assigns minimum-OS verification separately. The runner label is [supported by GitHub](https://docs.github.com/en/actions/reference/runners/github-hosted-runners). |
| #11 — Intended macOS user | **RESOLVED** | 6b:470–485 separates user resolution, launching and recovery. Lines 534–546 distinguish explicit other-user execution from the console-user GUI check. |
| #12 — Clean-runtime proof | **RESOLVED** | 6b:174–185 defines version/selfcheck producers; 219–230 exercises hooks, daemon and PTY under executable restrictions. Wrappers now use shell builtins (160–162). |
| #13 — Windows user binding | **RESOLVED** | 6b:589–592 separates elevation from user setup; 615–640 persists and reuses SID, distro, Linux user and absolute paths. |
| #14 — Windows networking | **RESOLVED** | 6b:593–613 makes preflight mode-dependent; 648–680 defines firewall scopes, NAT forwarding and persistent endpoint propagation. W3–W5 checks the real network paths. |
| #15 — Upgrade/uninstall | **NOT RESOLVED** | The revised contracts are substantially clearer (351–401, 643–647, 685–698), but transaction ordering and plugin restoration still prevent reliable rollback; fresh findings 1–3 below. |

Round-1 fresh findings:

| Finding | Status | Evidence |
|---|---|---|
| 1 — Preflight blocks fallback/upgrades | **RESOLVED** | 6b:593–613 selects the mode first, defines a NAT minimum and accepts recorded current/consented legacy port owners. |
| 2 — Launcher gate suppresses CLI offer | **RESOLVED** | 6b:251–256 and 681–684 place the gate after executable resolution, installation and provisioning; 740 requires integration coverage. |
| 3 — Independent pairing clients miss NAT endpoint | **RESOLVED** | 6b:665–675 persists the endpoint and makes it authoritative for QR, announcements and credential handover; 736 tests another terminal without inherited environment. |
| 4 — Current daemon never replaced | **RESOLVED** | 6b:377–382 explicitly stops the current installation and verifies replacement identity. Platform replacement procedures appear at 498–499 and 643–644. |
| 5 — Unsafe snapshot/restore inventory | **RESOLVED** | 6b:351–368 separates STATE, PROGRAM and TRANSACTION paths and snapshots after quiescence. Lines 421–423 cover overlap and crash recovery. |
| 6 — Pruning deletes another user’s bundle | **RESOLVED** | 6b:460–466 retains current, previous, journal and pending-handoff references across directory-service users; 525 defines coverage. |
| 7 — Missing Hyper-V `DisplayName` | **RESOLVED** | 6b:652–656 supplies complete rule invocations; 702 requires validation against real cmdlet parameter metadata. |
| 8 — Wrapper/allowlist mismatch | **RESOLVED** | 6b:160–162 removes external `dirname`; 223 provisions `strace`; 226–230 defines compatible executable policies. |
| 9 — Missing archive handoff contract | **RESOLVED** | 6b:164–167 defines tar format, digest, mode/symlink/dotfile preservation and consumer verification. A separate consumer-execution contradiction remains below. |

Fresh findings follow. All are **Important**; no Critical or useful Minor findings were identified.

1. **Windows overwrites rollback inputs before the setup transaction captures them.**

   **Evidence:** 6b:616–626 writes the new `binding.json` before invoking setup, and 631–632 registers the scheduled task **before setup runs**. However, 644 requires stopping the previous installation and exporting its old task XML before re-registration. By then the old binding and task definition have already been replaced. Restoring old XML also cannot restore the old binding read by `start-agentd.ps1` (638).

   **Fix:** Stage the new binding and launcher files separately. Capture the previous binding, task XML and launcher files before any replacement, then perform replacement inside one journaled transaction. Add an integration test spanning the Windows installer and WSL setup, with failure after task replacement, proving the previous bundle starts again.

2. **Plugin rollback restores source names without restoring the overwritten plugin contents.**

   **Evidence:** 6b:324 atomically replaces the stable `~/.rokid-coder/plugins/` directory on upgrade. That directory is PROGRAM-class and excluded from state snapshots (355–358). Step 7’s undo only re-points previous sources or removes registration (381), while `previous.pluginSources` is populated when the marketplace source differs (335). Between installer releases, that source remains the same path, whose contents have already changed.

   **Fix:** Journal the previous plugin directory and vendor registration/version before replacement. Rollback must restore the directory contents and reconcile the vendor’s installed/cached plugin version. Test rollback between two installer releases with distinguishable hook payloads and manifests, asserting both registration and actual executable content.

3. **Rollback restarts the previous daemon before restoring its wrappers and environment.**

   **Evidence:** Step 8’s undo explicitly restores state and invokes step 3’s restart (6b:382). Reverse-order undo restores wrappers/environment only afterward, at step 5 (379, 387). The macOS LaunchAgent executes the stable user wrapper (495), so this early restart can execute the replacement bundle against restored old state. Step 3’s undo is subsequently encountered again.

   **Fix:** Define one recovery sequence: stop the replacement; restore state, program files, plugins and service records; then restart the previous service exactly once. Add an ordering test that checks which executable actually starts and proves no replacement process runs after old state is restored.

4. **The archive contract requires hosted Windows to execute a Linux binary.**

   **Evidence:** 6b:167 requires **every consumer**, explicitly including T8, to execute the extracted bundle’s `bin/agentd selfcheck --require-bundle` before packaging. T8 consumes `linux-x64` on `windows-2025` (628, 699–706), while 706 correctly states that hosted runners cannot run WSL2. The required Linux execution therefore has no supported execution environment in that job.

   **Fix:** Separate static consumer validation from target-runtime validation. Windows should verify digest, archive metadata and layout without executing Linux binaries; a Linux prerequisite job should run selfcheck against the exact archive consumed by packaging. Keep actual WSL execution in the accepted recorded laptop gate.

5. **Initial CLI installation happens after the daemon PATH is generated.**

   **Evidence:** 6b:322 derives the daemon PATH from resolved CLI directories. The install flow writes `env` at step 5, installs absent CLIs at step 6, then starts the daemon at step 8 (379–382). No intervening step explicitly re-resolves newly installed CLIs and regenerates `env`. Existing daemon spawning depends on PATH (`agentd/src/claude-spawn.ts:14–39,57–66`), so a CLI installed into `~/.local/bin` can remain unavailable to the daemon.

   **Fix:** Resolve CLIs and write the final daemon environment after the CLI step and before autostart. Also make the macOS `refreshDaemonEnv` implementation explicitly rewrite `env` before its currently specified `kickstart` (6b:500). Test a fresh installation whose fake vendor installer creates a CLI outside the original PATH.

6. **The real legacy-upgrade CI check has an impossible rollback expectation.**

   **Evidence:** 6b:549–555 successfully upgrades 0.8.0 and commits the new installation. It then reruns setup with failure injection and expects the **legacy** agent to return (556). Under the orchestrator contract, that second run discovers the newly committed installer release as its previous installation (370–383), so rollback should restore that release. Additionally, the legacy script needs external Node (`agentd/scripts/install-launchagent.sh:23–25`), conflicting with the preceding toolchain-removal scenario unless these cases are isolated.

   **Fix:** Use separate clean scenarios for successful legacy upgrade and failed legacy upgrade, each beginning with a running 0.8.0 installation. Keep its runtime available for the rollback case, and isolate the clean-runtime installation check in another job or restored environment.

The same-wave ownership table has no direct file conflict; T9 and T8’s `rk.ts` edits are separated by waves. The SAS trust boundary remains explicit at 6b:22–23 and 58–59. The recorded Windows laptop gate is appropriate and does not need replacement with hosted WSL2 execution.

VERDICT: NOT READY