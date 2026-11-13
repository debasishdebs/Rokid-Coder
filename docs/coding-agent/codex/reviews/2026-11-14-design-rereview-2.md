**Verdict: ready for planning**

| Still-open item from previous pass | Status | Reason |
|---|---|---|
| #1 — Secure approval escalation | Resolved | §§12.1/12.6 combine pinned TLS, explicit consent, revocation, and temporary approval state held in agentd. |
| #3 — Reconnect deduplication | Resolved | §12.3 defines phone-generated message UUIDs, persisted applied IDs, and acknowledgement without re-execution for duplicates. |
| #4 — Exact session attachment | Resolved | §§11a/12.4 select hook-based registration using exact session/thread IDs, avoid sandboxed network access and cwd matching, and persist attachment. |
| #7 — Alert starvation and arbitration | Resolved | §12.2 specifies age promotion, dwell/preemption, configurable thresholds, and burst handling through a waiting count plus swipe access. |
| New P1 — Codex approve-all survives helper restart | Resolved | §12.6 forbids sending glasses approval mode as native `approvalPolicy`; agentd answers individual requests, so restarting it removes temporary escalation. §12.1 adds reset notifications. |

No new P0/P1 issues that would change the implementation plan were found.