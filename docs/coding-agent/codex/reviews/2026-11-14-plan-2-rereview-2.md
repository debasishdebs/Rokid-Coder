- **Fixed — #2:** evidence survives retries of the same band; lost shown acknowledgements are resent.
- **Fixed — #5:** reconnect dispatch follows agentd priority, with a higher-priority-first test.
- **Fixed — #14:** legacy fixtures assert actual responses; consuming fixtures are isolated.
- **Fixed — R42:** R47 excludes TIMEOUT as evidence and documents the interim limitation.
- **Fixed — wake:** wake and sound are separate; unconfirmed delivery gets bounded fresh wakes.
- **Fixed — voice:** complete normalized utterances must match the allowlist; negations are tested.
- **New Important — Tasks 3/8:** NEW/REMINDER with an existing band specifies “Update + sound + new episode,” but `Update` carries no sound, Task 8 speaks only on `Show`, and episodes require a new band instance. Specify a fresh `Show` and test reminder sound/evidence reset.
- **R44/R45:** no new Critical/Important found in the added trust rules.

**Verdict: ready after fixes.**