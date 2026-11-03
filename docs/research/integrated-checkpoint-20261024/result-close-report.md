# Task 1 — result-store original close ownership

Status: implementation committed and handed off for fresh full-range review. Writer has stopped source writes and runtime work. This prerequisite does not complete F1, R6, integration, or the release.

- Checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`
- Branch: `codex/result-store-close-20261024`
- BASE: `03356998dc337ebc3d53bf63af73dce48498080d`
- HEAD: `fb049821a0a2f02d8368a754532fab03d678f4ad`
- Full review range: `03356998dc337ebc3d53bf63af73dce48498080d..fb049821a0a2f02d8368a754532fab03d678f4ad`
- Commit: `fix: retain original result store cleanup ownership`
- Changed: 8 files, 520 insertions, 25 deletions. Commit exit 0; staged diff check exit 0.
- Post-commit status: only the pre-existing protected untracked `.task3-evidence/`. It was never read, edited, staged, deleted, or run.
- Version `0.1.13-rc.1` and format `12` unchanged. No assembly.ts, instruction/runtime owner files, managed-producers test, source authorization rules, lineage/project/revision checks, or release metadata changed.

## Implemented behavior and ownership

`packages/session-executor/src/lifecycle/result-store.ts` retains the original entry through retirement. The final logical registration/count is removed once, and retirement fences new registration synchronously. Repeated release on the owning lease joins the same attempt; failure retains the original service and cleanup closure, and explicit retry retires that owner. Successful retirement alone removes the cache entry and permits a replacement. New acquisition can wait for an already running retirement; failed idle retirement explicitly refuses acquisition without performing cleanup.

`packages/context-output/src/service.ts` retains a separate rejecting close flight instead of joining the caught transition tail. Failed close preserves the permanent admission fence and retries the same artifacts/store on the next explicit close. Successful deletion unsubscription and artifact cleanup are retained across later failures, including SQLite close failure. The native body/leaves handles remain the original handles throughout; native handle cleanup itself was retryable, so no writer/ownership helper widening was needed.

RC-01, approved by root: configure plus cleanup failure throws `AggregateError([configureCause, cleanupCause], ..., { cause: configureCause })` with internal `retryCleanup` bound to that exact lease release closure. The closure is not serialized. Single configure failure behavior and borrowed-owner no-op release remain intact.

RC-02, approved by root after investigation: permanent admission fencing also covers the interval while close waits behind a previously admitted transition. New result/dependency/transfer registration, begin, managed reads, active transfer confirmation, and grants are fenced at the service forwarding boundary. Already-issued sink methods, original result-owner confirmation, dependency membership settlement, passive transfer reconciliation, and artifact reconciliation retain their original owner checks. Close itself never calls finish, publication, or confirmation to create new work. A held real SQLite budget transition proves new calls after close are denied while original membership settlement and passive confirmation remain usable before artifact shutdown starts.

RC-03, approved contingent on causal RED and then confirmed: `packages/session-executor/src/service/result-reader.ts` previously dropped the last lease after caught release failure, leaving no consumer able to retry the new fenced store. It now retains failed original release closures in its own lifecycle, includes them in its close-size guard, refuses ordinary fresh page admission while cleanup is held, and retries once per retained owner on an explicit lifecycle join. Concurrent joins share that owner's retry flight. The internal acquisition dual-failure recovery closure is retained as well when supplied by the acquire path.

The narrowly widened `packages/session-executor/src/service.ts` aggregates reader join failure during global close and still attempts independent cleanup, including the instruction environment. Session close preserves its failed-close admission fence and the retryable reader cleanup. An independently written cleanup marker proves global close continues cleanup despite reader retirement failure. No second result-store registry, wire API, grants, polling, or replacement service was introduced.

## Changed manifest

Exact Git blob IDs and working-file SHA-256 values are in `evidence/task-1/final-changed-source.json`; final file copies are in `evidence/task-1/final-source/`.

| File | Purpose |
| --- | --- |
| `packages/context-output/src/service.ts` | Close flight, completed substeps, synchronous admission fence |
| `packages/session-executor/src/lifecycle/result-store.ts` | Original retirement owner, shared failure/retry, admission refusal, dual-failure recovery |
| `packages/session-executor/src/service/result-reader.ts` | Retain and explicitly retry failed cold-reader cleanup |
| `packages/session-executor/src/service.ts` | Preserve reader cleanup failures in actual global/session teardown |
| `packages/context-output/test/close-fixture.ts` | Test-only capture of original native writer handles through real writes |
| `packages/context-output/test/close-ownership.test.ts` | 11 native-close, SQLite-close, admission/retained-operation controls |
| `packages/session-executor/test/result-store-close.test.ts` | 5 real-owner, reservation, dual-failure, borrowed and shipping assembly controls |
| `packages/session-executor/test/result-reader-close.test.ts` | 3 actual cold-reader teardown, retained owner and concurrent join controls |

`evidence/task-1/full-range.patch`, `full-range-log.txt`, `handoff.json`, and `handoff-status.txt` bind the complete delivery. `phase-1/` preserves the accepted two-owner implementation and direct tests before RC-03 consumer widening.

## Verification

Every Vitest run used the package directory as CWD and `--maxWorkers=2 --minWorkers=1`. Runs were sequential in this checkout. Each named run has immutable raw `<name>-output.txt`, `<name>-receipt.json` with actual process exit, and `<name>-source.sha256` covering the two packages' tracked/new files against the recorded HEAD. Later receipts also include explicit isolated fixture environment paths. No live provider or user-session operation ran; model routes use the existing controlled fixture transport without issuing requests in the new teardown controls.

Final gates:

| Receipt | Command/scope | Result |
| --- | --- | --- |
| `context-final` | context-output: `pnpm exec vitest run --maxWorkers=2 --minWorkers=1` | Exit 0; 22 files, 180 tests passed |
| `executor-consumer-final` | session-executor: result-store-close, result-reader-close, result-store-read, result-reader-lifetime, result-reader, service-result-retention, retained-result-host, retained-result-flow, mixed-retention-quota, service, managed-lifecycle, main-instruction-publication, retention-grants | Exit 0; 13 files, 92 tests passed |
| `context-final-types` | context-output: `pnpm typecheck` | Exit 0 |
| `final-executor-types` | session-executor: `pnpm typecheck` | Exit 0 |

The executor final gate preceded the final context test's additional positive retained-membership/passive-confirmation assertions; executor production and its test files did not change afterward. The complete context suite and its typecheck then passed on the final context test source. All final source hashes are bound by the manifests and committed blobs.

Causal controls and retained setup/failure receipts:

| Receipt | Actual outcome |
| --- | --- |
| `red-context-close` | Exit 1: actual body/leaves cleanup failure was swallowed for concurrent close; the SQLite test's finally exposed EBUSY and masked its assertion |
| `red-context-close-cleanup` | Exit 1: test-only finally corrected; all 3 intended causal failures visible, including skipped SQLite retry |
| `red-result-close` | Exit 1: concurrent release falsely succeeded; dual-failure fixture finally exposed EBUSY |
| `red-result-close-cleanup` | Exit 1: finally corrected; concurrent release falsely succeeded and original configure error was lost rather than aggregated; 2 controls passed |
| `green-context-close` / `green-result-close` / `green-shipping-close` | Exit 0: 3 / 4 / 5 direct tests passed respectively |
| `executor-affected` | Exit 1: 32 tests passed; mixed-native/quota refused collection because shell-isolated IH_CONFIG_DIR was missing. Preserved, then setup corrected |
| `red-admission-fence` | Exit 1: 8 new-admission controls failed while earlier real configure transition held; one dependency input was initially invalid |
| `red-admission-valid-dependency` | Exit 1: valid genuine dependency entry confirms the missing admission fence, rather than validation wording |
| `green-admission-fence` | Exit 0: 11 controls passed |
| `context-all` | Exit 0: 22 files, 180 tests passed before RC-03 |
| `executor-final` | Exit 1: 8 files/36 tests passed; mixed-native assertion at line 58 expected /unauthorized/ but received existing `Result source session archived` |
| `baseline-mixed-native` | Exit 1: exact same mixed-native failure reproduced with both original product owners restored to BASE, without any concurrent runtime. Always restored phase-1 source afterward |
| `phase-1-context-types` / `phase-1-executor-types` | Exit 0 / 0 |
| `red-reader-cleanup` | Exit 1: both actual cold-read global/session close paths falsely resolved after native final-release failure, proving RC-03 |
| `green-reader-cleanup` / `green-reader-concurrent` | Exit 0: 2 / 3 actual cold-reader controls passed, including exact native fault preservation and overlapping global/session retry flight |
| `final-context-types` / `final-executor-types` | Exit 0 / 0 |

The mixed-native failure is unchanged historical behavior, not claimed green. It occurs in the existing source-archival error expectation before that suite's remaining controls. Neither its expectation nor source policy was edited. The baseline replay was performed only while no other gate was active and before root's later request to avoid further swaps; no further BASE swaps occurred.

Two read-only PowerShell exploration commands had parser errors (brace-style path grouping, and piping directly from a foreach statement). They started no test/native process and changed no source. The corrected searches/inventory completed. Git add emitted only normal LF-to-CRLF working-copy notices; staged diff check passed.

Runtime fixture trees for the full context gates, mixed controls, and baseline reproduction were preserved as ZIP files in the evidence directory. `fixture-archives.json` records each archive path, SHA-256 and archive exit 0; `runtime-inventory-summary.json` records original temp roots and file totals. Raw failure output and source manifests were never overwritten. Initial pre-isolation receipts lack an environment field; the missing IH_CONFIG_DIR is established by the actual collection refusal, and subsequent corrected receipts record all IH_* environment values.

## Handoff limits

- Fresh full BASE..HEAD review is still required and belongs to root; no recursive agents were spawned.
- Whole session-executor suite was not run. The bounded expanded consumer/lifecycle gate, direct causal controls, complete context-output suite and both typechecks were run.
- The unchanged mixed-native expectation failure remains visible and baseline-classified. Its later assertions were not reached; mixed-quota's four controls passed.
- Combined integration, build/copy, final consumer validation and any later F1 work belong to root. No build/copy, push, merge, tag, release, provider access or credential operation was performed.
- Worktree and branch are preserved. Source writes/runtime work stop at this handoff for independent review.
