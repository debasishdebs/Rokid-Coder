Evidence refers to [6a plan lines](docs/coding-agent/claude/plan/2026-11-15-plan-6a-foundation-pairing.md).

- Prior #1 — **NOT RESOLVED:** Rotation is covered, but lost-commit recovery requires provisional credentials that timeout/restart explicitly discards (214–220).
- Prior #2 — **RESOLVED:** Computer confirmation is explicitly outside the security boundary; phone confirmation and glasses/runtime wiring are assigned and tested (56, 256–264).
- Prior #3 — **RESOLVED:** Each shell injects its own identity pair, with exact target-package/component tests (297–303).
- Prior #7 — **RESOLVED:** T2 owns standalone core registration; T2 and T12 require both builds (55, 160, 314).

- Fresh #1 — **RESOLVED:** Same-user socket access is acknowledged, and direct socket confirmation without phone confirmation must fail (258–264).
- Fresh #2 — **RESOLVED:** Shared code defines an injected identity type rather than one compiled application pair (297–303).
- Fresh #3 — **RESOLVED:** Unified pairing records cover both transports, live revocation, TTL activity, and steer rotation (226–239).
- Fresh #4 — **NOT RESOLVED:** Agentd becomes durable before phone commit; timeout/crash can erase the phone’s recovery state while leaving agentd trusted. Recovery admission and durable attempt lookup remain unspecified (210–220); current `PinStore` stores no attempt/commit state (`agentd/src/tls.ts:276`).
- Fresh #5 — **RESOLVED:** Existing service/screen integration paths are owned, and the published confirmation API carries attempt IDs (56, 256).
- Fresh #6 — **RESOLVED:** Standalone settings ownership and root/standalone verification gates are explicit (55, 160, 314).
- Fresh #7 — **RESOLVED:** Manual ADB stays in the upstream shell; product checks cover the dependency graph and actual kadb classes (137, 184).
- Fresh #8 — **RESOLVED:** Logging prohibition now explicitly includes debug, malformed-frame, and exception paths (34, 280).

**NEW Critical/Important:** None identified against the repository.

Review only; no builds or tests run.

VERDICT: NOT READY