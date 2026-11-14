1. **Fixed** — #1: final-write classification covers legacy sends and connection-bound trust.
2. **Partly** — #2: explicit reasons resolve reminders, but starting a new episode on every RETRY conflicts with reusing evidence after a lost ack. Preserve evidence across retries of the same display.
3. **Fixed** — #3: dismissed approvals and questions can return as reminders.
4. **Fixed** — #4: agentd publishes waiting-count updates; both displays render them.
5. **Partly** — #5: progressive replay is correct; “current occupant first” is still unsupported. `linkUp()` requeues and selects by priority. Correct that promise and test queued higher-priority alerts.
6. **Fixed** — #6: both transports route ordered events; the monitor service owns coordination.
7. **Fixed** — #7: terminal events invalidate cards, drafts and late confirmations.
8. **Fixed** — #8: persisted pins, downgrade refusal and scoped endpoint verification are specified.
9. **Fixed** — #9: the retained Views pairing field explicitly becomes secret input.
10. **Fixed** — #10: Agents has separate ownership and explicit hold-release paths.
11. **Fixed** — #11: bilateral advertisement and intersection are specified; phone-hub deferral remains explicit.
12. **Fixed** — #12: READY replies are enabled; launcher commands have an explicit Plan 3 dependency.
13. **Fixed** — #13: local/wire dispatch, voice confirmation, summary-first output and sandbox display are specified.
14. **Partly** — #14: real-handler fixtures are specified, but line 224 incorrectly expects v2 `ack applied` for every steering fixture. Assert each legacy frame’s actual response/effect and isolate fixtures that consume alerts.
15. **Fixed** — #15: trailing flush, Stop and glasses APK assembly are included.

New Important issues:

- **R42 is unsafe — [Task 3, lines 321–329](~/Desktop/rokid/Rokid-Coder/.superpowers/sdd/plan-2-draft.md:321).** Glasses origin does **not** prove rendering. `NoticeController` schedules expiry before notifying the renderer; `NoticeOverlayRenderer.render()` can return without a service or attached window, yet TIMEOUT still fires. This can falsely acknowledge an unseen approval and suppress delivery retries. **Fix:** exclude TIMEOUT as evidence unless the glasses attest successful attachment for that notice identity; route that evidence through the phone hub. Test renderer failure and expiry without attachment. Morning confirmation cannot establish this invariant.

- **Unseen retries cannot wake the panel — [Task 3, lines 315–316; Task 4, line 385](~/Desktop/rokid/Rokid-Coder/.superpowers/sdd/plan-2-draft.md:315).** RETRY/RESUME use silent shows, and same-ID transmissions use updates without waking. After a failed or throttled initial wake, delivery can remain invisible. **Fix:** separate sound suppression from wake policy; permit a bounded fresh wake for unconfirmed delivery, while retaining evidence for genuine lost-ack retries. Test a failed initial wake followed by recovery.

- **Voice matching reverses negated intent — [Task 7, line 534](~/Desktop/rokid/Rokid-Coder/.superpowers/sdd/plan-2-draft.md:534).** Whole-word matching interprets “don’t allow” and “do not approve” as ALLOW. Confirmation reduces the risk but preserves the incorrect interpretation. **Fix:** accept only complete, normalized allowlisted utterances; reject negated or additional text. Add those cases to tests.

**Verdict: ready after fixes.**