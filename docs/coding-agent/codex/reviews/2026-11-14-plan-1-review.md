**Verdict: not ready**

References: **P** = `docs/coding-agent/claude/plan/2026-11-14-plan-1-laptop.md`; **N** = Nexus `agentd/`.

1. **P1 — Tasks 1/3/4: Opt-in enforcement is incomplete.** Filtering `list()` and gating `processHook` leaves discovered-session detail access, direct broadcasts, and Codex broadcast adoption available. Detach cleanup is unspecified. **Evidence:** P:147; N/src/daemon.ts:35,53,66; N/src/ws-server.ts:389; N/src/codex/monitor.ts:1036. **Fix:** Gate discovery, publication, detail reads, subscription/adoption, approvals and commands; detach must stop tailing, cancel waits and remove published state. Test these paths through both transports.

2. **P1 — Tasks 2/4: Copied forwarder cannot run independently.** `hook-forward.js` imports `./approval-manager`, which imports `./session-store`; copying only that file produces missing-module errors. **Evidence:** P:162; N/src/hook-forward.ts:3; N/src/approval-manager.ts:2. **Fix:** Bundle a standalone executable or package its dependency closure. Test the actual plugin-installed executable, including the provider header.

3. **P1 — Task 6: Wrong HTTP cancellation event.** `IncomingMessage.close` also occurs after normal request completion; with asynchronous `onHook`, this can immediately abort a valid Stop/question wait. **Evidence:** P:306; N/src/http-server.ts:46,62. **Fix:** Observe premature response/socket closure, checking `response.writableEnded`; separately handle incomplete requests. Integration-test an intact held POST and a killed forwarder.

4. **P1 — Tasks 9/11: Steering classification leaves bypasses.** `alert_action` can approve work but sits outside the steering list; existing `thread_start` also executes prompts and is omitted. **Evidence:** P:52,401–408,491; N/src/phone-link.ts:568; N/src/ws-server.ts:264. **Fix:** Define one exhaustive authorization gate for both transports and protocol versions. Test every executable action over plaintext, including legacy frames.

5. **P1 — Tasks 5/7: Approval-policy interface lacks required identity.** `ApprovalRequest` has no provider/session key, and Codex file approvals become `"File change"`, not `"fileChange"`. **Evidence:** P:257–260; N/src/approval-manager.ts:12; N/src/codex/monitor.ts:208,904. **Fix:** Carry explicit provider, session key and canonical approval kind through both adapters; test real normalized Codex file-change requests.

6. **P1 — Tasks 7/9: Question wire contract cannot represent the relay.** Alerts omit `toolUseId`, structured questions and options, yet answers require that identifier. The blocking Codex question path has no defined correlation/response contract. **Evidence:** P:322,331,396,404; N/src/codex/monitor.ts:845. **Fix:** Define typed question requests and correlated answers for Claude, async Codex messages and blocking Codex RPCs; test each end to end.

7. **P1 — Tasks 5/8/10: Approval and alert lifetimes diverge.** Approvals still time out after 120 seconds while alerts can remain actionable for 30 minutes. WsHub disconnects never notify ApprovalManager. **Evidence:** P:364,456; N/src/approval-manager.ts:5,258; N/src/ws-server.ts:159. **Fix:** Synchronize terminal states per request, expose WsHub connection lifecycle, and reject late answers after timeout, laptop resolution or either transport disconnect.

8. **P1 — Tasks 3/10: Required recovery work is missing.** Resume/context reseeding does not rebuild history; evidence explicitly says resume replays no events. Claude tailing starts at EOF. **Evidence:** P:458; design:392–394; brainstorm/2026-11-14-compat-codex.md:54; N/src/transcript.ts:212. **Fix:** Add paginated history recovery and Claude transcript reconstruction, with reconnect tests containing missed output.

9. **P1 — Tasks 7/9: Controls lack phone-facing interfaces.** `listModels()` has no request/response frame; sandbox display and configured default approval modes have no contract. **Evidence:** P:329,395–428; design:260,436. **Fix:** Add model/effort discovery, read-only sandbox state and default-mode synchronization, with protocol tests.

10. **P2 — Tasks 1/3/6/8/9: Dependency order prevents promised checks.** Task 1 needs Task 9’s fake phone; Task 8 needs its `AlertFrame`; Task 3 adds required config fields without updating config constructors/parser. **Evidence:** P:147,202,309,361; N/src/config.ts:31,132. **Fix:** Introduce shared types, injectable integration harness and config migration before consumers; defer dependent manual checks explicitly.

No files modified; tests were not run.