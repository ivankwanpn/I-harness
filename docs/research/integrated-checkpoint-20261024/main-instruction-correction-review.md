# IC-B fix round1 — same-reviewer scoped correction review

## Spec Compliance

**✅ Approved. I1 and M1 are addressed. The additional headless I1b is confirmed by its preserved causal RED and addressed by the correction. No new Critical or Important defect was found in this incremental range.**

- Original full-range review remains `task-1-review.md`, covering BASE `754681367a230bd106382ab1fb4a381c333b4aa0` through `829c369bd330ef41d1fea54b10bef18a022f7464`.
- This correction review covers only `829c369bd330ef41d1fea54b10bef18a022f7464..3e5c8c413b8d10280cac6eded3663ec3b80eb3c9`, the three-file incremental patch supplied in `fix-round-1-review.diff`.
- Read the incremental diff once in bounded output, root's promoted ICB-08, the report's Fix round1 append, raw receipts001–018, their source manifests, and the preserved004/007 setup dispositions. Did not reread the original 62-file patch, run Git, rerun tests/builds/runtime, change product files, start a background process, or dispatch agents.

## Previous findings

### I1 — addressed

`packages/session-executor/src/assembly.ts:1193` now enters the original mount guard before acquiring the environment and constructing its dependent manager at lines1196–1198. The original Code Mode configuration evaluation at line1177 occurs before that new acquisition, so its failure cannot leave an internally created saved-policy environment initializing after rejection.

`assembly.ts:1055`–1060 declares the eventual handles and registers a deferred in-memory instructions getter. This preserves the original instructions → skills → subagents section order without an early publication or a second publisher. Actual main admission receives the initialized manager after successful construction; its logical reconcile, publication, and target selection algorithms are not changed.

For later failures inside the mount guard, `assembly.ts:1752` joins original disposal. Line1753 now preserves both the exact construction error and a real cleanup failure in `AggregateError`, with the construction error as cause. Disposal's optional manager/environment joins at lines1806–1808 are appropriate for partial initialization. The existing supplied-environment ownership check remains, so borrowed environments are not closed by the assembly.

The new controls in `packages/session-executor/test/main-instruction-construction.test.ts:66`, `:92`, and `:111` check the actual early callback, later owned/borrowed distinction, original fault identity, real captured watch-lease close failure, and release retry on the same owner. The watcher/environment wrappers call through to the real original resources. Receipt001 preserves the original created1/ready/close0 behavior; receipt002 additionally preserves the previously swallowed cleanup error. Final receipt013 executes these corrected assertions successfully.

### M1 — addressed

`packages/session-executor/src/assembly.ts:1051`–1053 now correctly describes main logical admission reconciling instructions and publishing the full component after step hooks/claims. It explicitly records stable section order and that construction does not publish. The obsolete pre-step-publisher description is removed.

### I1b — confirmed and addressed; prior review assumption corrected

The original review's statement that the headless outer handle was sufficient for recovery was incorrect. Receipt005 proves that the old mount catch returned exit1 while its already created saved-policy environment subsequently reached ready with close0. A local handle was present, but the separate run try/finally containing cleanup was never reached. Receipt004 was a different earlier getter failure before acquisition and is correctly retained as setup evidence, not substituted for this causal result.

The correction fixes that actual control flow:

- `apps/cli/src/run.ts:459` defines one cleanup closure over the original `initialInput`, `assembly`, and internally owned instruction environment. Both the mount catch at line805 and the normal run-finally at line1058 invoke it.
- The mount catch fences its owned environment at line792, creates and awaits the original initial-input close Promise at lines798–801, and removes the original signal handlers in the same finally. Passing that already attempted Promise into cleanup avoids an automatic second close attempt during the same failure handling.
- A failed initial-input close blocks a new run-end admission but is still included in cleanup's failure collection. If assembly disposal is fulfilled, line465 attempts safe owned-environment cleanup despite that independent input failure. If assembly disposal rejects, the parent environment close is withheld. Supplied borrowed environments never enter `ownedInstructions` and are not closed here.
- A real `appendRunEnd` failure is captured at line802 and preserved with the original mount fault at line804. The environment cleanup is then attempted before that error is propagated. No second run-end append is introduced.
- Cleanup failure at line807 uses the existing `HeadlessCleanupError`. Its retry closure calls only the same cleanup handles followed by the existing coordinator close. It does not rerun mount, input admission, model/action execution, run-end append, or environment construction.

Tests at `main-instruction-construction.test.ts:135`, `:163`, `:195`, and `:225` directly exercise owned/borrowed headless failure, an actual original lease close fault and same-handle retry, input-close failure with safe environment cleanup, and a real JSONL run-end frame proven absent. They check zero model calls and retained fault identities; retry controls also check the single original environment/lease/getter and unchanged events or admission/action counts. The call-through barrier at test line30 waits on the genuinely awaited `acquireAssemblyResultStore` operation and returns its original store. Receipt007's invalid async wrapper around a synchronous registration remains an explicitly failed setup probe;008 corrects that probe without replacing the product store owner.

## Strengths of the correction

- The correction moves new ownership into the existing assembly guard and shares the existing headless cleanup closure. It does not create another lifecycle manager, recovery registry, publisher, or alternate result-store owner.
- It distinguishes original construction failure, journal saving failure, and cleanup failure while retaining the original error objects. The headless retry capability retains its real resources rather than reconstructing work.
- Tests cause failure at meaningful production boundaries and assert resource identity, ownership, readiness/closure, and absence of replay. The probes do not claim that zero model requests qualify the successful transport path; successful entries are separately exercised by014.
- Borrowed exclusion is tested on both standalone and headless paths, and the existing service outer-owner close remains covered at test line248.

## New issues introduced by the fix

### Critical

None found.

### Important

None found.

### Minor

None requiring a correction in this scope. The raw fault controls intentionally emit `[settings] watch cleanup failed`; temporary-profile bootstrap also emits plugin-registry default-rebuild diagnostics. These messages remain visible in009/013/014 and are not silently represented as pristine output. The final receipts contain no recurrence of007's unhandled rejection.

## Evidence checked

The recorded executions were inspected, not rerun:

| Receipt | Reviewed disposition |
|---|---|
|001/002|Actual standalone leak and swallowed-cleanup REDs, numeric exit1; real original owner drained by probe finally.|
|003|Standalone correction4/4, exit0.|
|004|Earlier top-level options getter setup failure, exit1; explicitly not I1b proof.|
|005|Actual headless post-acquisition leak RED, exit1, environment ready/close0/model0.|
|006|Initial combined standalone/headless correction5/5, exit0.|
|007|Failed async-on-sync probe, numeric exit1 with one unhandled rejection; not GREEN despite provisional filename.|
|008|Corrected call-through await,7/7, exit0.|
|009|Full focused construction/error matrix10/10, exit0.|
|010|Existing selected initialization/import/close controls4/4,45 deliberately skipped, exit0.|
|011/012|Fixture getter typing failure exit2 followed by corrected executor types exit0.|
|013|Final construction plus original host/publication close controls,3 files/12 tests, exit0.|
|014|Actual successful run/SDK/ACP/explicit-headless entry, typed-current and EOF controls,3 files/8 tests, exit0.|
|015|CLI types exit0.|
|016|Actual CLI build owner exit0; esbuild0 warnings, existing90 dynamic imports/36 dynamic `.ts` warning retained.|
|017|Actual Gateway copy owner exit0,242 packages; unavailable foreign-platform optional packages explicitly skipped.|
|018|Selected source/copy/donor/reuse binding with explicit `allCheckoutBytesIdentical:false`.|

Read-only SHA-256 checks of the final three changed files match the final012–017 manifests and018:

- `apps/cli/src/run.ts`: `88db1248cc8a58df98a239a0a8eacd27ac47a5d35bf4241ad9418be025692166`.
- `packages/session-executor/src/assembly.ts`: `648c9f267abce9c41feb69c1acdd057affc9cbca1cc261b44406adfebd189398`.
- `packages/session-executor/test/main-instruction-construction.test.ts`: `6263a259f89323863e28a41a7a63c92872f36bf8db08d21e34cd71efdecbcf85`.
- Actual copied Gateway assembly at `.tmp/icb-gateway-20261024-fix1/node_modules/@i-harness/session-executor/src/assembly.ts` matches the writer assembly hash.
- Actual new CLI bundle at `.tmp/icb-cli-20261024-fix1/ih.mjs` matches018's new hash `c89117356fb0d1afbbf8c3fa30709968a0eb3877163ff53875f3cfc3064bb731`.

No assertion is made that this bundle or the changed assembly/run sources equal the earlier064 bytes. The incremental diff changes construction/cleanup placement and leaves the original request/manager/runtime/target modules and target test untouched. For064's successful SessionService path, the service still supplies the original environment, the manager is initialized before use, and section ordering is preserved; constant off Code Mode avoids the new failure branches. That supports the explicitly authorized **selected behavioral reuse**, while014 separately qualifies the changed headless successful entry. It does not turn064 into performance, whole-platform, or new failure-path evidence.

## Focused cross-owner reads and limits

The only additional source inspection beyond the three-file patch was for named control-flow questions:

1. Read the pertinent unmodified `run.ts` error/normal-finally context and `HeadlessCleanupError` body because the diff's catch/finally hunks alone do not show reachability and the retry capability's exact operation set.
2. Read `apps/cli/src/initial-input.ts` to distinguish its actual original admission/open operation from later close. The retry closure calls close on the retained input and does not call `openCliInput` again.
3. Read `packages/telemetry/src/telemetry.ts` after checking the index export to verify whether the existing emit/close calls before cleanup could independently bypass it. `createTelemetry` isolates sink exceptions and its close is a no-op; no additional bypass was found in that actual implementation.
4. Read only matching lines from the evidence binding script to locate the actual copied Gateway assembly; the script was not executed. The initial guessed copy path was absent; the recorded `node_modules/@i-harness/...` path was then checked successfully.

## Cannot verify / unchanged acceptance boundaries

- This scoped review did not rerun gates or independently reconstruct Git history. It uses the root-supplied exact incremental range, checks its source control flow, reads recorded executions, and binds final changed/copy/bundle bytes as above. Root retains final Git/donor/full-tree audit responsibility.
- The original reachability exit1/404 rows/18 seed-relative new rows, legacy retirement/staged export work,36 dynamic `.ts` warning, F1/R6 result-store release-retry gap, R6 durable/performance qualification, and ID/IE/IF/IG/platform/release limits remain unresolved. Test instrumentation of the original result-store await does not qualify or fix that store's own retry gap.
- SDK/ACP teardown source was not changed or generalized. Its successful entry/EOF receipt014 is relevant regression evidence, not blanket qualification of every teardown failure on those hosts.
- Product0.1.13-rc.1, Session12, adapter precedence, provider budgets, original request/reduction ownership, and completed-effect replay boundaries are unchanged by this correction.

## Assessment

**I1: Addressed. M1: Addressed. I1b: Confirmed and addressed.**

**SpecCompliance: Approved. Task quality: Approved for the scoped correction.** The correction closes the identified ownership/reachability defects and retains same-owner error/retry behavior without broadening the implementation. Combined with the prior full-range review, no outstanding code-review blocker remains from this reviewer for this connected IC-B packet; the explicitly open release obligations above remain open.
