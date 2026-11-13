**Verdict: not ready**

| Original finding # | Status | Reason |
|---|---|---|
| 1 | Partially resolved | §12.1 adds pinned TLS and consent, but Codex policy persistence undermines the promised restart reset; see new issue below. |
| 2 | Resolved | §12.2 requires correlated glasses-side shown acknowledgements and retries through expiry, including Done/error. |
| 3 | Partially resolved | Recovery and local fallback are specified, but a “client id” alone does not define per-message deduplication or its persistence across restart. |
| 4 | Partially resolved | §12.4 requires exact IDs and persistent attachment, but neither tool’s opt-in command path is proven; §11a still suggests cwd matching. |
| 5 | Resolved | §12.5 tracks the continuation cap and refuses prompts when plugin mode cannot deliver them. |
| 6 | Resolved | §12.6 specifies idle `turn/start`, retained pending settings, confirmation events, and separate sandbox handling. |
| 7 | Partially resolved | Immutable targets and a queue are specified, but strict priorities permit starvation; no dwell/preemption rule reconciles simultaneous alerts with five-second delivery. |
| 8 | Resolved | §12.5 releases waits on local submission/cancellation, cancels voice drafts, and serializes launcher commands. |
| 9 | Resolved | §5.1 selects `PermissionRequest` emulation in both modes and explains its relationship to native permissions. |
| 10 | Resolved | §5.2 corrects the version and rollout facts and requires context initialization from rollouts. |
| 11 | Resolved | §5a correctly distinguishes cold-budget wakes from hot-budget entitlement limits. |
| 12 | Resolved | §§3/6.2 choose phone DND plus manual quiet, with display-only fallback when unreadable. |

**NEW — P1 · §§12.1, 12.6: Codex escalation cannot reliably reset on helper restart.**

**Problem:** §12.1 promises approve-all resets when agentd restarts, while §12.6 applies approval-policy changes directly to Codex through `turn/start`. Resetting helper state leaves the running Codex thread’s permissive policy effective.

**Evidence:** `brainstorm/2026-11-14-compat-codex.md`, §6, confirms overrides persist into later turns, no standalone settings setter exists, and resume overrides on running threads were ignored.

**Fix:** Separate temporary remote escalation from persistent native policy. Implement restart-revocable escalation by answering individual approval requests in agentd while retaining an asking native policy, or explicitly redesign the reset guarantee around Codex’s supported settings boundary. The plan must choose the mechanism before promising restart revocation.