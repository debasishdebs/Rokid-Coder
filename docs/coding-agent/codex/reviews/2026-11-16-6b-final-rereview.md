| Finding | Result | Evidence |
|---|---|---|
| Dependency digests | ADDRESSED | `computer/installer/bundle/build.mjs:98`; lockfile gate rejects unhashed packages. |
| Wrapper allowlist | ADDRESSED | `computer/installer/bundle/exec-allowlist.sb:15`; exact wrappers, content checks and extra-executable probe. |
| Wrapped Claude help | ADDRESSED | `computer/src/setup/plugins.ts:104`; deeper-indented descriptions skipped. |
| Codex adapter/contracts | NOT ADDRESSED | Verbs fixed at `computer/src/setup/plugins.ts:44`, but argument forms and list JSON remain unverified: `computer/test/fixtures/plugin-cli/codex-0.169.0/meta.json:7`. |
| Plugin interpreter PATH | ADDRESSED | `computer/src/setup/orchestrator.ts:562`, `:577`, `:294`; resolved PATH reaches provisioning and recovery. |
| Failed recovery/rollback state | ADDRESSED | `computer/src/setup/orchestrator.ts:366`, `:443`, `:699`; failure preserves retry state and blocks installation. |
| Readiness race | ADDRESSED | `computer/src/setup/platform/fake.ts:320`; initial write precedes readiness. Bounded polling: `computer/test/setup-install.test.js:293`. |
| Legacy hooks—R217 | ADDRESSED | `computer/src/setup/legacy.ts:100`, `:110`, `:117`; explicit default-No prompt and revalidation. Backup/atomic rename: `computer/src/settings.ts:121`. |
| Expired macOS fixture pins | ADDRESSED | `.github/workflows/macos-installer.yml:385`, `:394`, `:485`; refresh and nonempty identity assertions. |
| Two-component glibc | ADDRESSED | `computer/installer/windows/lib/RokidCoder.psm1:128`, `:218`; dedicated parser. |
| Advertise transaction | ADDRESSED | `computer/src/setup/orchestrator.ts:537`, `:270`; previous bytes journaled before mutation and restored. |
| Newest staged uninstall binding | ADDRESSED | `computer/installer/windows/lib/RokidCoder.psm1:1092`; selection requires manifest confirmation. |
| Failed uninstall remains retryable | NOT ADDRESSED | `computer/src/setup/uninstall.ts:53` still swallows plugin-removal failures, then deletes wrappers, manifest and bundles at `:59`–`:68` and returns success. |
| Partial Apply/cancellation compensation | ADDRESSED | `computer/installer/windows/lib/RokidCoder.psm1:669`; cancellation hook: `computer/installer/windows/installer.nsi:125`. |
| Effective firewall validation | NOT ADDRESSED | `computer/installer/windows/lib/RokidCoder.psm1:484`, `:504`; Hyper-V `Profiles` is omitted from comparison despite being specified at `:377`. |

NEW Important:

- `computer/installer/windows/lib/RokidCoder.psm1:586`: firewall deletion errors are suppressed and netsh deletion exit codes ignored (`:591`). Revert then erases ownership records (`:697`), allowing unsuccessful cleanup to report success and lose retry state.
- `computer/installer/windows/lib/RokidCoder.psm1:1079`, `:1115`: an unreadable manifest becomes “no committed install.” `computer/installer/windows/uninstall.ps1:37` then skips distro cleanup and proceeds to remove Windows recovery artifacts, even when the registered distro still exists.

Known wording leftover remains at current `computer/installer/windows/installer.nsi:292`: “what it changed was put back” can falsely describe incomplete undo.

Verification: lockfile check passed; static NSIS tests passed 2/2. Runtime tests stopped at the environment boundary:

```text
Error: EPERM: operation not permitted, mkdtemp '/var/folders/lw/fy08kz9x5m77drgrcrx539nh0000gn/T/rokid-glibc-XXXXXX'
```

TypeScript checking could not start: compiler module missing. CI/device gates remain unverified.

VERDICT: NOT READY