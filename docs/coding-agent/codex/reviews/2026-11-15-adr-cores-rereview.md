1. **RESOLVED** — §3.1.1 puts the authoritative enabled gate in core; §3.5.3 explicitly orders shell revocation hooks and core cleanup.
2. **RESOLVED** — §3.2.2 latches cancellation through speech acceptance; §1 serializes cancellation and posts callbacks on main.
3. **RESOLVED** — §3.2.1 specifies release-before-close, generation invalidation, client recreation, initial state delivery and foreground cleanup.
4. **NOT RESOLVED** — ADR lines 903–905 contradict each other: dispatch completion returns an op to `ACQUIRED`, but also releases its slot and runs cleanup; install subsequently reuses that same op for upload (lines 932–938). Distinguish dispatch completion from operation completion, retaining ownership across the query/upload sequence.
5. **RESOLVED** — §6.1 requires both core suites in both workflows and enforces baseline union parity.
6. **RESOLVED** — §3.5 supplies signatures, threading, lock/reentrancy rules and revocation ordering; §7 records the controller’s rulings.

**NEW Critical/Important:** None. The accepted never-answering CXR residual is excluded.

VERDICT: NOT READY