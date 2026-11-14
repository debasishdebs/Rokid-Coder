VERDICT: NOT READY

Line references below are to the [revised plan](~/Desktop/rokid/Rokid-Coder/docs/coding-agent/claude/plan/2026-11-14-plan-4-feedback.md).

| # | Status | Plan evidence |
|---|---|---|
| 1 | Resolved | L110–111, 128, 135: authenticate fully before pin/window mutation. |
| 2 | Resolved | L112–114, 130: shared pins, peer identity, live revocation. |
| 3 | Resolved | L156–170: mandatory TTL-aware agentd admission before renewal. |
| 4 | Resolved | L188–192, 214–216: KeyManager API, client aliases, pinned-client injection. |
| 5 | Resolved | L115–117, 124–129: explicit TLS settings, DER hashing, missing-cert tests. |
| 6 | Resolved | L233–241, 257–259: inbound renewal, sweep ordering, timestamp migration. |
| 7 | Resolved | L47–48: PhoneLink explicitly retains mutual certificates plus token. |
| 8 | Resolved | L295–309: baseline identities and attempt-attributable secure connection. |
| 9 | Not resolved | L397–400 explicitly permits speaker playback before routing correction. |
| 10 | Resolved | L344–364: attempts stay pending; closure confirms success; rejection is recorded. |
| 11 | Not resolved | L467–485 adds correlation, but discards IDs for potentially consumed commands. |

- **[Important] Remaining #9: speaker silence is still unenforced.** L398 checks routing only after `play()`; L400 declares brief speaker leakage “accepted,” without a binding user decision accepting that exception. Android documents that preferred routing need not match actual playback routing ([AudioTrack reference](https://developer.android.com/reference/android/media/AudioTrack)). **Fix:** specify a playback path that fails closed without exclusive Bluetooth routing, or generate the chime on the glasses. Verify connected-but-unselected Bluetooth and route loss.

- **[Important] Revised #11: consumed commands can execute twice.** L472 clears the ID on every rejected ack; L469–470 also silently replaces an unacked ID after two minutes. Yet [session-state.ts:524](~/Desktop/rokid/Rokid-Coder/agentd/src/launcher/session-state.ts:524) returns consumed failures after typing, including `typed_after_cancel` at L551, and [phone-v2.ts:586](~/Desktop/rokid/Rokid-Coder/agentd/src/phone-v2.ts:586) deliberately retains their IDs. A subsequent fresh ID bypasses deduplication. **Fix:** preserve IDs for uncertain/consumed outcomes until a distinct, informed “send again” action; add actual send/ack tests for consumed rejection and lost-ack retry after two minutes.

- **[Important] Phone-side TTL still permits renewal after expiry.** L233–239 renews on secure connection but checks expiry only at startup, reconcile, and hourly. [AgentsConfigStore.kt:344](~/Desktop/rokid/Rokid-Coder/plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/AgentsConfigStore.kt:344) authorizes without checking age; inbound bind then touches usage at [AgentdLinkServer.kt:205](~/Desktop/rokid/Rokid-Coder/plugins/agents/src/main/java/com/anezium/rokidbus/plugin/agents/AgentdLinkServer.kt:205). A stale computer reconnecting between sweeps can revive itself. **Fix:** require TTL validation before admission or renewal on both phone transports; test expiry followed by reconnect without a sweep.