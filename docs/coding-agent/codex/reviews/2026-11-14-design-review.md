**Verdict: not ready**

References: **D** = design document; **C/X/G** = `brainstorm/2026-11-14-compat-{claude,codex,glasses-phone}.md`; **N** = Nexus checkout. Evidence below is local.

1. **P1 — §7: approve-all lacks transport protection.** LAN restriction and a visible badge do not prevent token theft or command injection. Nexus sends the bearer token over plaintext (`N/agentd/src/phone-link.ts:406–424`). **Fix:** require authenticated encryption or enforced Tailscale-only transport before enabling remote approvals; define explicit per-session escalation consent and reset/revocation rules.

2. **P1 — §5a: closure is not delivery acknowledgement.** D:167 commits on any `/notice/closed`, but Nexus emits that event for replacement, including from the phone before glasses receipt (`N/phone-hub/src/main/java/com/anezium/rokidbus/phone/PhoneNoticeRouter.kt:65–74`). **Fix:** distinguish rendered, user-acknowledged, answered, and expired states; add correlated shown acknowledgements and bounded retries, including Done/error alerts.

3. **P1 — §§5–6: reconnect recovery is unspecified.** Nexus cancels pending approvals on phone disconnect (`N/agentd/src/approval-manager.ts:293–296`); Codex subscriptions replay neither history nor token usage (X:54,91–98). **Fix:** specify resubscription, history reconciliation, request invalidation/local fallback, timeout alignment with *Y*, and idempotent reply delivery. Never imply a disconnected pending approval remains actionable.

4. **P1 — §11a: attachment identity remains a correctness blocker.** Matching Codex threads by cwd (D:314) is ambiguous with concurrent sessions in one repository. Claude’s current-session registration is also unspecified. **Fix:** require an exact session/thread identifier, prove the opt-in command path, and define attach/detach persistence across restart/resume. Gate hooks, subscriptions, output forwarding, and auto-approval on attachment.

5. **P1 — §§5.1,11a: continuation guarantee exceeds evidence.** The eight-consecutive-Stop-continuation cap is mentioned only in the table; plugin voice follow-up is otherwise promised throughout *Y*. Tool-free conversations exhaust it (C:48–50,85–86). **Fix:** track continuation availability and expose a deterministic laptop/launcher fallback before accepting an undeliverable prompt.

6. **P1 — §§5.2,11: pending Codex settings have no application contract.** The main follow-up description uses `codex queue`, whereas overrides require `turn/start`; active-turn steering ignores relevant settings (X:60–65,105–113). **Fix:** choose idle `turn/start` as the settings-bearing path; retain pending values through queue fallback/active turns and confirm application via `thread/settings/updated`. Define sandbox-policy interaction separately from approval policy.

7. **P1 — §§2,6: simultaneous alerts can erase each other.** Two sessions are the normal case, but Nexus has one notice slot, with replacement (G:52–53). **Fix:** specify a per-session/request alert queue, arbitration, starvation prevention, and immutable reply targets. Define how simultaneous approval/question/Done events satisfy the five-second target.

8. **P1 — §5.1: laptop takeover can stall behind glasses.** Submitted laptop prompts queue behind the waiting Stop hook; SIGTERM cancels that wait (C:93–104). **Fix:** release on local `UserPromptSubmit`, invalidate voice drafts/replies on cancellation, and specify launcher command serialization around busy/waiting states.

9. **P2 — §§5a,5.1,11a: approval contracts contradict.** D:194 retains held `PreToolUse` approvals despite D:198/320 selecting `PermissionRequest`; launcher mode promises real switching while §11 describes hook-based answering. **Fix:** state one authoritative mechanism per mode and define how native mode and helper policy reconcile.

10. **P2 — §5.2: stale Codex facts.** D:210 says CLI 0.163; D:219 says only `exec` writes rollouts. X:3,93–97 explicitly supersedes both. **Fix:** correct the baseline and require rollout-based context initialization.

11. **P2 — §5a: wake-budget claim misreads Nexus.** D:162–163 describes a blanket two-per-minute limit; cold-budget wakes bypass that entitlement counter (`N/glasses-hub/.../DisplayWakePolicy.kt:92–124`). **Fix:** correct the claim before designing reminder throttling.

12. **P2 — §§3,6: glasses DND promise is unsupported.** G:116–119 finds no readable glasses DND. **Fix:** explicitly choose phone DND plus a manual quiet override for v1, including behavior when DND state is unavailable.