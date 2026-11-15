**T7a — Spec verdict: PARTIAL**

- [Important] `package-lock.json:42`, `computer/installer/bundle/build.mjs:106`: all 32 dependency entries lack `integrity` and `resolved`. Node archive verification works, but shipped npm packages lack repository-pinned digests. Regenerate the lock with integrity fields; reject unhashed registry dependencies in CI.
- [Minor] `computer/installer/bundle/exec-allowlist.sb:13`, `.github/workflows/bundles.yml:252`: the entire user wrapper directory is executable under the allowlists. Permit only the four generated wrappers, verify their contents, and test rejection of an extra executable.

**T9 — Spec verdict: PASS under R213**

The official-script → npm → brew order, consent, executable re-resolution, setup invocation, and pre-terminal ordering are implemented. No blocking finding.

**T7p — Spec verdict: FAIL**

- [Important] `computer/src/setup/plugins.ts:89`: recorded Claude help breaks the parser at the wrapped `--values-stdin` description; it discovers only `configure` and `unset`, then rejects plugin support. Parse command rows independently of wrapped descriptions; test against the recorded help.
- [Important] `computer/src/setup/plugins.ts:131`: Codex supports `add`/`remove`, but detection and execution require `install`/`uninstall`. Provisioning becomes manual and removal skips the plugin. Implement separate CLI adapters, replace authored fixtures with recorded contracts, and verify list JSON shapes at the gate.
- [Important] `computer/src/setup/orchestrator.ts:550`: plugin commands receive the original PATH despite resolving CLI interpreters and generating a working daemon PATH. npm-installed CLIs using an otherwise unavailable Node can fail provisioning. Pass the resolved interpreter PATH to every plugin operation, including recovery.
- [Important] `computer/src/setup/orchestrator.ts:346`: recovery closes the journal even when restoration fails; install ignores that failure and continues. `rollback` also replaces the manifest after unsuccessful restoration (`:673`). Preserve retryable recovery state and stop until restoration succeeds.
- [Important] `computer/src/setup/platform/fake.ts:323`, `computer/test/setup-install.test.js:294`: **the reported flake is a readiness race**. Startup publishes the port before the first 10 ms state write, so the test reads a nonexistent file. Write initial state before publishing readiness; replace the fixed sleep with bounded polling for a subsequent write.
- [Important] `computer/src/setup/orchestrator.ts:521`: legacy migration directly rewrites `~/.claude/settings.json`. Although explicitly requested by the plan, this conflicts with your stricter CLI-only boundary. Make that migration a separate user-run step if the boundary is absolute.

**T7b — Spec verdict: PARTIAL**

The root/user split and console-user handling appear compliant; no root-owned home writes or console-user guessing found.

- [Important] `.github/workflows/macos-installer.yml:383`: both legacy jobs copy pins last used in November 2025. Startup expiry removes them before the baseline capture, allowing the preservation check to compare empty sets. Refresh timestamps during staging and assert the expected nonempty trusted fingerprint before and after upgrade.

**T8 — Spec verdict: FAIL**

Unelevated installation, the separate elevated helper, persisted bindings, absolute task paths, and battery settings are present.

- [Critical] `computer/installer/windows/lib/RokidCoder.psm1:120`: the version parser requires three components, while supported distros report `glibc 2.35` or `2.39`. Preflight (`:625`) therefore rejects them. Parse two-component glibc versions and test raw `getconf` output; the minimum-version Pester assertions also need this fix.
- [Important] `computer/installer/windows/lib/RokidCoder.psm1:908`: advertising changes before quiescence, snapshot, or journaling. Failed mirrored→NAT Repair can restore the previous installation with the new NAT endpoint. Move the change inside the transaction and restore its exact previous bytes.
- [Important] `computer/installer/windows/uninstall.ps1:24`: uninstall chooses the newest staged binding, which may belong to a failed Repair in another distro. Resolve the committed binding from the registered task and manifest.
- [Important] `computer/installer/windows/uninstall.ps1:51`, `computer/installer/windows/installer.nsi:303`: cleanup failures still delete bindings, launchers, journal, uninstaller, and registration. Preserve these until removal succeeds so failed distro cleanup or denied elevation remains retryable.
- [Important] `computer/installer/windows/installer.nsi:226`: machine rollback is enabled only after complete helper success and runs only on later installation failure. Partial Apply failure or cancellation after Apply leaves machine changes. Compensate this run’s recorded objects on both paths.
- [Important] `computer/installer/windows/lib/RokidCoder.psm1:402`: firewall validation checks names only; Apply skips matching names. Disabled or incorrectly scoped rules pass, and Repair cannot refresh subnet prefixes. Compare effective filters and reconcile product-owned rules transactionally.

CI remains unverified. Windows has the concrete preflight blocker above; macOS has a false-positive preservation gate. No additional definite bundles first-run failure was established statically. The recorded device gates remain outstanding.

No fixes were applied: this session is read-only. The targeted flaky-test attempt stopped at the environment boundary:

```text
Error: EPERM: operation not permitted, mkdtemp '/var/folders/lw/fy08kz9x5m77drgrcrx539nh0000gn/T/rokid-setup-XXXXXX'
```

VERDICT: NOT READY