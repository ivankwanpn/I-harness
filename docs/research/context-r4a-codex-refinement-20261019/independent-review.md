# Original reviewer — bounded Codex refinement

Reviewed the complete product/test range `e8b2781f607c63421b4089a66ea230aa9799ff21..3ba0d782fea3eb3389790e16f47f1f9b9cab0208` (commits `97ff39e8` and `3ba0d782`). This continues the original independent review seat. Root is the sole product writer under the user's updated workflow. This reviewer made no product/test/Git changes, ran no tests or broad suites, and spawned no agents. This new report preserves the original reports/probes/evidence.

**Scoped specification verdict: Pass for the bounded refinement. Scoped quality verdict: Pass; no actionable new regression found in this diff.** The two previously reproduced P2 boundaries are addressed, and the additional original-capture lifetime and private-reader correction fit the existing owners.

**Whole R4A ready to merge: No.** This verdict does not accept the original full R4A range from `91d8fef0`, A3–A6, different-owner catalog authorization, or the remaining release/qualification work. Root owns final acceptance and disposition.

## Closure and implementation assessment

| Boundary | Assessment |
| --- | --- |
| Fix1 R1: automatic completion/close mutates finalized startup producer registrations | Closed. `jobs/records.ts` now delegates automatic completion and close to `createJobRetention.record/drain`; the leaf's `settle()` invokes the passive owner hook, with an original `capture.frames.settle()` compatibility fallback. Neither path calls `observe` as a substitute. The real background test holds EOF behind an explicit release file and checks the genuine finalized startup producer remains without registrations. |
| Fix1 R2: foreground observer rejection escapes as an unhandled promise | Closed. `currentObservation()` immediately owns/catches the observer promise and returns a typed recovery disposition. Foreground observation is awaited by the actual run path. The resulting `retentionFailure` stays separate from original stdout/stderr/exit/timedOut. Original capture failures still propagate as their native error rather than being replaced by an observer failure. |
| Original uncertain storage/capture lifetime | The new pending set retains the original capture until a known terminal storage disposition. Foreground captures are included, rather than only background registry entries. `drain()` retries the same handle and reports unresolved capture identities; failed close does not authorize another process or recapture. Known refusal is terminal; unknown remains retriable. |
| Query-specific failure versus original stored state | `observe()` starts authentic current registration synchronously and owns its result separately from passive storage settlement. A failed observer/grant does not replace a known `job.retained` or downgrade that job's original storage disposition. Native execution state remains in the original registry/capture. |
| Private retained-output reader after adding metadata | Closed by `3ba0d782`. `jobs/observation.ts` returns the original result when no metadata is added. When it creates an observation value with `retentionFailure`, it rebinds the exact original trusted reader from the existing private registry. It does not synthesize read permission from a path/ref-shaped payload. The focused reader assertions verify the original stdout/stderr read remains available. |
| Public port compatibility | The new passive hook is optional for older adapters. Omission selects the original capture's existing settle operation, preserving passive behavior without invoking a current observer. No second execution/store authority was introduced. |

The 67-line `jobs/retention.ts` leaf is a focused lifetime/observation responsibility delegated by the original job registry. It does not allocate execution IDs, open another store, manufacture source identities, or replace the capture's settlement state. The capture still coalesces concurrent storage settlement and caches only its known terminal result. The local pending set tracks required original work rather than a new execution intent.

Foreground success and failure handling were inspected in both ordinary and promotable run branches. Native completion wins the existing promotion race; successful foreground observation is joined before the public result resolves, while a promoted startup receipt continues to return without awaiting eventual native EOF/storage. The error path preserves the original capture exception. Stop/cancel/root/tree/I/O behavior remains owned by the existing capture and supervisor. The refinement does not add timers, polling or producer replay.

## Evidence inspected and its exact limits

This reviewer read the refinement brief, root plan, prior `fix1-review.md`, the complete nine-file diff, every changed test, and relevant original capture/producer/reader contracts. Root executed all controls sequentially; this reviewer inspected the following raw results/receipts in `.tmp/context-r4a-codex-refinement-20261019/runs/`:

- `exec-after-reader-fix`: **257 tests across 20 files passed**, with stable maintained-source digest `767b27b6756106fc2d8b3dfdef339c5c6521d7ea9547ac5ceaa7394481e1d291` before/after, 2576 maintained inputs, exit 0 and empty stderr. The receipt records HEAD `97ff39e8` because the subsequent reader correction was then uncommitted; its maintained source includes the reader correction later committed as `3ba0d782`. This reviewer independently compared all nine changed product/test file hashes from that manifest with the current clean product source: **9 recorded, 9 identical**. Source-time qualification comes from the captured bytes, not the older HEAD string alone.
- `all-review-probes`: **6 tests across 5 original probe files passed**, including the original three probes and both fix1 P2 reproductions. This run precedes the later reader-rebind-only correction. It qualifies that earlier source; it is not silently relabeled an exact-final-source rerun.
- `executor-retained-controls`: **30 tests passed** on stable source before the reader-rebind-only correction. Its earlier source digest and timing remain explicit. Final exec reader tests and executor typecheck address the later delta; the 30-test execution itself remains source-time limited.
- `real-store-lost-receipt`: the actual on-disk ContextOutput fixture passed. It receives literal 1MiB stdout plus stderr marker through a controlled transport, loses the first genuinely committed finish receipt, and obtains the same original ref through the same scope/operation/sink. Assertions require one launch/open, unchanged write count, actual cold encoded-body digest and independently expected decoded stdout bytes/marker. This is actual storage recovery evidence, unlike the older controlled ref-return fixture.
- `foreground-close-recovery`: the foreground/recovery controls passed, including unknown storage causing close rejection and later same-handle recovery allowing close, with one launch/observation. The raw run contains five tests across foreground-retention/store-recovery.

The earlier RED reader control and the corrected GREEN are deliberately preserved by root. The intermediate recovery-test failure exposed an old assumption that passive completion invoked an observer; its replacement assertion now requires passive success before injecting an observer failure. Inspection of both the test delta and source supports that correction; it is not a softened storage-success oracle.

This reviewer also read `types-after-reader-fix.json`: executor typecheck exits 0 with the same stable `767b27b6...` maintained-source digest after reader rebinding. The root brief reports earlier exec/Gateway typechecks and unchanged six inherited reachability entries; those earlier results are attributed to root. Root is building fresh copies separately; this report does not substitute source tests for packaged behavior or claim independent completion of the build/evidence audit.

The real-store 1MiB control uses a **controlled transport**, not a real OS process producing 1MiB. Its scope does not include F1 crash repair, catalog membership authorization across owners, arbitrary artifact corruption, all cancellation/abandonment/consumer-cap cuts, or whole-session cold recovery. The actual OS-process background test remains the small binary/Unicode byte fixture with explicit EOF gating. Those controls establish different properties.

Preliminary `root-runs/refine-*` receipts captured only then-tracked files while the foreground fixture was untracked. Root preserves that fixture separately and does not claim those preliminary receipts fully enumerate every source input. The newer runner includes maintained tracked and untracked product/test inputs plus relevant probe/config hashes. This report retains that distinction.

## Inspected paths

Changed product files:

- `packages/exec/src/capture/frames.ts`
- `packages/exec/src/index.ts`
- `packages/exec/src/jobs/{observation,records,retention}.ts`

Changed tests:

- `packages/exec/test/{background-recovery,foreground-retention,retention-store-recovery}.test.ts`
- `packages/session-executor/test/retained-background-exec.test.ts`

Actual related owners/callers inspected:

- Exec capture `{contracts,output,completion,retention}.ts`, job `{contracts,views}.ts`, private `retained-output.ts`, transport launch and supervision ownership/disposal.
- Executor `lifecycle/{exec-result-retention,result-sources,result-dependencies,result-retention}.ts`, assembly disposal and native context-output reader consumption.
- Core-tools authentic producer/dependency/finalization owner; actual output-retention frame capture and ContextOutput sink/recovery contracts.
- Shell foreground/selected/retention wrappers to verify how the existing private reader is forwarded and how native versus tool-wrapper result shapes relate. The new observation wrapper preserves the native producer reader; this does not certify completion of the preexisting broader shell/consumer representation cutover.

## Remaining unaccepted scope

No additional code finding is raised from hypothetical malformed custom-port objects. No new runtime probe was requested because source inspection and supplied discriminating controls did not establish a further concrete defect in this bounded change.

Broader different-owner catalog membership/read grants, all remaining crash/Stop/ACL/deletion concurrency matrices, Code Mode emitted-output cutover, remaining consumers, final-source 100MiB/fan-in qualification and packaged real-entry flows remain the existing unaccepted R4A obligations. Nothing in this scoped pass updates the original decomposition count, product version, merge/tag/release status or whole-phase acceptance.
