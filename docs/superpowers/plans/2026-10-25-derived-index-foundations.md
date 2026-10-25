# Derived-index foundations Implementation Plan

> Use subagent-driven-development with GPT-6.1 Sol and independent review. Root promotes Task1 under the approved continuous program; the assigned implementer executes it without recursive agents. No later Store/service cutover is authorized by this packet.

**Goal:** Establish native feasibility for the selected OFF disposable-cache policy on the actual Windows Node runtime and Node 22.18.0, and deliver a genuine private fair legacy-use gate. Do not change ContextStore's mode, service scheduling or any query/preparation signature in this task.

**Spec:** [binding resource proof and root decisions](../specs/2026-10-25-derived-index-foundations.md).

**Base:** Root assigns a new isolated branch from frozen HOST `abbc30c416ef12b897917e2ef049b84424a54d28` in `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`. Root chooses the new `codex/` branch name. Task2 remains NEEDS_CONTEXT and unaccepted. No scale run is authorized.

**Binding decisions:** FB01 chooses authoritative cleanup independently of derived readiness. OFF is the only selected candidate policy: if refused or its proof fails, report to root; do not substitute DELETE, disable defensive mode, weaken synchronous settings or add a runtime mode toggle. `temp_store=MEMORY` is permitted only after the fixed-SQL/covering-plan/bounded-memory/no-disk-temp audit below. Original authority, generation invalidation, ordinary grant restoration and Store/service behavior require the later **one connected implementation task**, not a fake Task 1 controller.

## Global constraints

IF01–08 in the spec bind this task. Only the four listed files may change. Preserve original quota/authority/format and protected data. Use package-CWD sequential maxWorkers2/minWorkers1 and exact scale exclusions. Report unsupported or missing proof honestly; do not convert a setup failure into semantic RED or a narrow native probe into whole-version approval.

## Task 1: Native resource feasibility and private gate

### Exact file and evidence map

| Path in assigned HOST checkout | Task 1 responsibility |
| --- | --- |
| Create `packages/context-output/src/legacy/use-gate.ts` | Pure private gate; no files, SQLite, store, owner, quota or service imports. No export from package index. |
| Create `packages/context-output/test/legacy-use-gate.test.ts` | Real gate tests with causal promise barriers. |
| Create `packages/context-output/test/legacy-index-native.test.ts` | Runs bounded actual-native scenarios under both explicit Node executable paths; fails if either required runtime/proof is missing. |
| Create `packages/context-output/test/helpers/derived-index-native-probe.mjs` | Standalone child using actual `node:sqlite` and filesystem APIs; emits JSON observations and errors, never imports a fake lifecycle controller. |
| Read only `packages/context-output/src/store.ts`, `search-index.ts`, `bytes.ts`, `legacy/fork-index.ts`, `legacy/observed-read.ts`, `legacy/fork-transfer.ts` | Inventory fixed SQL, limits, cursor/rollback dependencies and future cutover requirements. Do not edit their runtime behavior. |
| `.superpowers/sdd/2026-10-25-derived-index-foundations/task-1/` | Commands, source manifests, source audit, native receipts, gate RED/GREEN, versions, downloads and report. Root may move this evidence destination before dispatch; record the final absolute path once. |

Keep all native fixtures beneath the task evidence root in per-runtime/per-scenario directories. The protected `packages/desktop-gateway/test/repeated-growth-diagnosis.test.ts` remains unread, unrun and untouched. No store mode change, schema change, public DTO/API/telemetry, service gate adoption, funding work or broad package gate belongs here.

## Gate API and invariants

```ts
export interface LegacyUseLease {
  assertHeld(): void;
  assertExclusive(): void;
}
export interface LegacyUseGate {
  shared<T>(signal: AbortSignal | undefined,
    work: (lease: LegacyUseLease) => Promise<T>): Promise<T>;
  exclusive<T>(signal: AbortSignal | undefined,
    work: (lease: LegacyUseLease) => Promise<T>): Promise<T>;
  assertLease(lease: LegacyUseLease, requirement?: 'exclusive'): void;
}
export function createLegacyUseGate(): LegacyUseGate;
```

The creating gate owns a private `WeakMap<LegacyUseLease, Record>` and matching `AsyncLocalStorage<Record>` scope. `gate.assertLease` verifies this gate's brand, active callback ownership and matching ALS record; an independently valid lease from another gate must fail. Lease methods delegate to that creating gate's assertions; callers cannot use `lease.assertHeld()` as proof that the lease belongs to a different Store's gate. Exclusive assertion additionally checks actual granted mode. The future Store constructor will bind its own gate validator in the connected task.

Maintain FIFO waiters. Grant a leading writer only with zero active readers/writer; grant the contiguous leading reader group together. Readers behind a queued writer cannot pass it. Acquiring this same gate while its callback scope is active rejects before enqueue; there is no shared-to-exclusive upgrade. A valid outer lease may enqueue its original workspace mutation later, but this queue knows nothing about workspace owners/jobs.

Queued abort removes the waiter and prevents callback execution. Recheck abort after grant and immediately before entering the callback; release a just-granted lease without invoking work if cancelled at that cut. Once callback execution starts, abort **does not force-release** or invalidate the lease: retain exclusion until the actual callback and cleanup settle. Consumer signal/authority guards remain separate. Remove abort listeners once admission is resolved; release exactly once in finally after actual settlement. Preserve every callback value/rejection exactly, including `throw undefined`; never use truthiness of a captured failure to decide fulfillment.

Gate tests, each using held promises and event order rather than elapsed-time success assertions:

- [ ] Two leading readers overlap; writer waits until both settle; later reader waits behind writer.
- [ ] Two writers are FIFO; a contiguous reader group following them starts only in order.
- [ ] Already-aborted and queued-aborted requests never enter work and do not block later waiters.
- [ ] At the just-granted/before-callback microtask cut, abort prevents entry and releases admission. Use the public promise handoff to create this cut, not a product test hook.
- [ ] Abort after callback entry leaves lease/assertLease valid and next writer blocked until held cleanup actually settles; then next waiter proceeds.
- [ ] Fulfilled value, ordinary throw, rejected promise and `throw undefined` propagate unchanged and release admission. Use an explicit rejection branch assertion for undefined, not a helper that confuses it with no error.
- [ ] Stale lease and a descendant async scope after callback completion reject; shared lease fails exclusive assertion; another gate rejects a currently valid foreign lease.
- [ ] Same-gate nested shared/exclusive acquisition rejects promptly before enqueue; original lease remains usable and later independent work succeeds.
- [ ] No waiter/listener leak after queued cancellation, thrown callback or mixed readers/writers; no signal abort auto-joins or releases an executing callback.

## Native proof stages, run in this order

### 1. Freeze runtimes, sources and fixture scope

- [ ] Record actual executable path, SHA256, `process.version`, platform/arch, `process.versions.sqlite`, `SELECT sqlite_version()`, `SELECT sqlite_source_id()`, `PRAGMA compile_options`, page size, journal/synchronous/temp-store readbacks. Record exact package/test source hashes and clean BASE before execution.
- [ ] Find Node 22.18.0 without changing installed tools. If unavailable, download the architecture-matching portable executable or archive from [official Node 22.18.0 distribution](https://nodejs.org/dist/v22.18.0/) into `task-1/runtime/node-v22.18.0/`; verify the downloaded artifact against the matching entry in official `SHASUMS256.txt` from that same distribution before executing it. Retain URL, checksum file, local SHA256, match and version. No installer, global PATH change or user-profile write. Do not execute an unverified download.
- [ ] Resolve exact official source revisions for both runtimes, including Node's `src/node_sqlite.cc` and bundled SQLite implementation/build options. Use only official `nodejs.org`, `github.com/nodejs/node` exact release tags and `sqlite.org` source/docs; hash downloaded sources. Do not infer active-runtime behavior from the latest Node documentation or a different SQLite release.

Node 22.18 [documents DatabaseSync.close as close_v2 and lacks StatementSync.close](https://nodejs.org/download/release/v22.18.0/docs/api/sqlite.html#databaseclose). That is context, not native disposal proof. OFF's [documented undefined rollback/corruption behavior](https://sqlite.org/pragma.html#pragma_journal_mode) is an expected cache failure mode, never authoritative storage recovery.

### 2. Fixed SQL, covering plans and memory/temp audit before enabling MEMORY

- [ ] Extract an exact SQL/operation inventory from the named source files, including schema/autoindexes, refs/owners/chunks, legacy counts/distinct/first/ordinal/page lookups, FTS MATCH pagination, short-query and incomplete-ref scans, mutations and transaction catches. Label current VACUUM and cross-await `.iterate()` as **future removals**, not safe retained operations. No product SQL is changed in Task 1.
- [ ] On both actual runtimes, load the unchanged schema into native disposable fixtures and capture EXPLAIN QUERY PLAN plus relevant EXPLAIN opcodes for every retained SELECT and the proposed bounded keyset hint SELECT (`binding,ref_id,ordinal>? ORDER BY ordinal LIMIT 64`). Cover nonempty/repeated refs/multiple bindings and actual trigram text. Audit `COUNT(DISTINCT ref_id)`, MIN/ORDER BY and FTS paths specifically for sort/ephemeral membership structures and index use.
- [ ] Map each query's native scratch to exact source/plan. Existing search page/ref/output limits do not by themselves bound COUNT DISTINCT or internal sorting. Require ordered/covering streaming for graph-size-sensitive membership/count queries; if a supported runtime introduces an unbounded temporary membership tree, record failure and return to root rather than adding a schema/index/query change here. A small passing timing/RSS sample is not a bounded-memory proof.
- [ ] Identify every SQLite disk-temp creation route reachable by the fixed future-retained SQL and native FTS implementation. Only after source/plan audit permits it, set `temp_store=MEMORY` in the **test-only disposable native candidate** and read back the value/compile behavior. No ATTACH, WAL, VACUUM, backup, serialize, second index/database, or temp-file directory redirection is permitted in the candidate proof.
- [ ] Keep a source/plan argument for absence of reachable disk temp plus native file observations. Directory snapshots after synchronous statements cannot detect transient temp files; do not call those snapshots peak-I/O proof. If available native tracing is used, record its exact tool/source/version and permissions; do not install a driver or modify global tracing policy. If a necessary absence/space bound cannot be established, report that limit rather than invent an interceptor result.

### 3. Native OFF/resource feasibility, not product lifecycle tests

- [ ] Set `journal_mode=OFF` on a fresh disposable candidate outside a transaction and verify actual readback equals `off`; record synchronous/defensive behavior without changing either to force acceptance. If OFF is refused/ignored, stop its feasibility claim and report to root. No fallback mode.
- [ ] Exercise real unchanged schema/FTS construction, refs/owner/chunk inserts, legacy hint staging and bounded queries with a small explicit main-page ceiling; record before/after page_count, max_page_count, actual main size and files. Grow real inputs until native SQLITE_FULL; keep its original error/code, partial-file state and evidence. Close/discard the actual candidate after failure. Do not issue ROLLBACK or query it as a recovered ready index.
- [ ] Use enough **bounded** input to exercise a source-identified native cache-spill path; document why the chosen amount reaches it. Do not change cache/synchronous policies to manufacture a pass. Establish the structural main-page ceiling argument against the exact source; distinguish it from observed boundary sizes. Audit zero managed journal/WAL and no reachable disk temp. A single final physicalBytes result is insufficient.
- [ ] Exercise a real constraint error partway through a derived mutation and a process exit while a derived transaction is open. Observe retained files/errors; the parent may discard them only after child exit/native close. These tests establish that failed/crashed cache files cannot be trusted; they do not claim Store generation invalidation, canonical restoration or grant safety.
- [ ] Native close matrix: hold a prepared StatementSync; suspend `.iterate()` after one row; compare explicit iterator.return, exhaustion, and a close attempt with a paused cursor. Capture stale statement/iterator operations, DB state, same-path unlink/reopen and actual native errors. Include an executing SQL callback close attempt where supported. Keep statement/cursor outcomes descriptive per runtime; do not assume close_v2/isOpen=false alone proves final native handles gone.
- [ ] Separately prove the proposed safe application discipline: end/exhaust every native cursor, settle every issued native SQL operation, close the exact DB successfully, then unlink/reopen at the same path. No GC-dependent disposal is an accepted mechanism. A consumed/failed close can demonstrate a limitation, not a successful retirement receipt.

### 4. Implement and verify the pure gate

- [ ] Write the real gate tests above, run them RED, implement only `use-gate.ts`, then run GREEN. Keep source diffs and exact rejection values; no SQLite lifecycle facade/controller belongs in gate tests.
- [ ] Run both named test files sequentially from HOST `packages/context-output`:

```text
pnpm exec vitest run test/legacy-use-gate.test.ts test/legacy-index-native.test.ts --exclude test/legacy-fork-scale.test.ts -t '^(?!.*10001)' --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

The native test file spawns the actual active executable and verified floor executable by absolute path; record every child argv and exit. Native probe `.mjs` requires no global loader/package changes. Provide runtime paths through task-scoped test environment only. Use fresh isolated values for `IH_CONFIG_DIR`, `IH_STRUCTURE_EVIDENCE_ROOT`, `IH_RESULT_INTEGRITY_EVIDENCE_ROOT`, `IH_LEGACY_FORK_EVIDENCE_ROOT`, `IH_MIXED_RETENTION_EVIDENCE_ROOT` and `IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT`. Do not run the unchanged RED full-budget performance test, 1001/10001 scales or broad package/Gateway gates in Task 1.

## Acceptance, limits and handoff

Task 1 can claim only: exact native mode/resource feasibility within its audited fixed SQL and supported runtimes; a validated pure gate with actual cancellation/lease semantics; and documented native disposal constraints. It cannot claim authoritative cleanup success, full-generation invalidation, no use-after-retirement in product, original ordinary-grant restoration, policy/source preservation, Task2 GREEN, or complete version usability. Those require the actual connected Store + service/query/preparation implementation and later qualification tests. Never substitute a test controller for those owners.

- [ ] Save `runtime-manifest.json`, `official-source-audit.md`, `sql-plan-audit.json`, per-runtime/scenario raw native receipts, gate RED/GREEN outputs, commands/source hashes and `task-1-report.md` under the evidence root. Report every refusal/unsupported feature/uncertain close/temp-memory proof gap; keep original errors instead of replacing them with a generic quota conclusion.
- [ ] Self-review exact BASE..HEAD: only the four named source/test helper files plus evidence/docs changed; gate has no product adoption; no Store/service/query mode/signature changes; no protected file access; no package/global/profile modification. Root reviews the complete range before promotion or integration. Do not begin the connected task automatically.

Root authorizes only this foundation task. Commit verified connected source/tests and preserve native resources/evidence outside Git; stop at the task boundary for independent review. Do not start Store/service implementation.
