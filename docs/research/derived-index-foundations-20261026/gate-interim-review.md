# Private LegacyUseGate — interim component review

**Scoped specification verdict: PASS. Scoped code-quality verdict: PASS, with no actionable findings in the two reviewed files. Whole Task 1 remains unaccepted / NEEDS_CONTEXT.** This is an interim review of the pure gate component only. It grants no native resource-policy acceptance, product adoption, reachability waiver, or permission to begin the connected owner cutover.

## Frozen scope

- Assigned HOST: `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`.
- Assigned branch: `codex/derived-index-foundations-20261025`.
- Assigned range: `abbc30c416ef12b897917e2ef049b84424a54d28..2cd94218c94675665d430402f0661fe3f7e8253f`.
- Reviewed source: `packages/context-output/src/legacy/use-gate.ts` (92 lines) and `packages/context-output/test/legacy-use-gate.test.ts` (163 lines), including only their sections of `review-abbc30c4..2cd94218.diff`.
- Requirements: `task-1-brief.md`, especially “Gate API and invariants”; `D:/I-harness-main/docs/superpowers/specs/2026-10-25-derived-index-foundations.md`, IF05/IF06 and the staged private scope in IF08. The spec was read from the parent workspace because that new spec is absent in the frozen HOST checkout.

No runtime, test, native child, crash probe, or Git command was run during this review. No product source/test file was changed. This report is the sole written artifact. No subagent was started. The protected Gateway diagnosis file was not opened, hashed, executed, or modified.

## Findings

No P0/P1/P2/P3 actionable defect was found in the reviewed gate source or its nine tests. The following source and test locations support the scoped verdict; they are review evidence, not change requests.

| Required property | Source evidence | Test evidence and assessment |
| --- | --- | --- |
| Creating-gate brand and matching active callback ownership | `src/legacy/use-gate.ts:25–33,74–79`: each gate closes over its own `AsyncLocalStorage` and `WeakMap`; assertion requires both an active branded admission and identity with the current ALS record. Lease methods close over the creating gate assertion. Exclusive assertion checks granted mode. | `test/legacy-use-gate.test.ts:112–130,133–144`: valid own lease, forged lease, independently valid foreign lease, shared/exclusive mismatch, outside callback scope, stale lease, and a descendant resumed after callback completion. No caller-supplied lease method is treated as proof of this gate's ownership. |
| FIFO writers and contiguous leading reader groups | `src/legacy/use-gate.ts:38–48,65`: enqueue at tail; inspect only queue head; stop at a writer when readers remain; reserve writer/read admissions before resolving them. A reader behind a queued writer cannot pass it. | `test/legacy-use-gate.test.ts:11–41`: two readers overlap, writer waits for both, later reader stays behind writer; two writers preserve FIFO before the following reader group and tail writer. Held promises and event order establish the ordering. |
| Already-aborted, queued-aborted, and just-granted cancellation | `src/legacy/use-gate.ts:50–65,69–73,80–84`: already-aborted admission rejects; queued cancellation removes and detaches the waiter before pumping; admission listener is detached on grant; the extra microtask handoff rechecks abort before entering work. A just-granted cancellation reaches the same single release path. | `test/legacy-use-gate.test.ts:44–74`: no callback entry, no cancellation blockage, listener removal, and abort attached to the predecessor's public settlement promise; tail work succeeds. The handoff uses the public promises rather than a product test hook. |
| Abort after callback entry retains actual exclusion | `src/legacy/use-gate.ts:74–84`: active state begins immediately before `scope.run`; no post-entry abort listener invalidates/releases it; the callback is awaited before the `finally` releases admission. | `test/legacy-use-gate.test.ts:77–95`: abort occurs after entry; lease and creating-gate assertions remain valid before and after held cleanup; next writer remains absent until cleanup settles. |
| Exact settlement and safe release | `src/legacy/use-gate.ts:79–84`: `return await` with one `finally` preserves values, synchronous throws, promise rejection and `undefined`; there is no truthiness-based error discriminator or user callback in release. Record deactivation and reader/writer release precede pumping the next admission. Acquisition rejection occurs before this release region, so it cannot decrement an ungranted admission. | `test/legacy-use-gate.test.ts:98–109,147–162`: identity of fulfilled object, thrown Error and rejected object; explicit rejection branch for `throw undefined`; subsequent exclusive work succeeds. Mixed readers/writers, queued cancellations and throwing work settle with expected outcomes. |
| Self-reentry, stale scope and listener lifecycle | `src/legacy/use-gate.ts:30–36,43,51,56–63,80–84`: an active same-gate ALS scope rejects before enqueue; stale scope does not resurrect its lease; listeners detach on grant/cancellation; queued entries leave the queue before resolution. WeakMap entries do not strongly retain released leases. | `test/legacy-use-gate.test.ts:112–144,147–162`: both nested acquisition modes reject from both outer modes, original lease stays usable, another gate can operate independently, later independent work succeeds, and all tested abort listeners return to zero. |

The reviewed source imports only `node:async_hooks`; it has no Store, SQLite, file, quota, owner or service dependency. The two reviewed diff sections introduce the component and its direct tests. There is no fake lifecycle controller or consumer in them. The supplied four-file range is staged work; this review does not establish actual Store/service/query exclusion or grant safety.

## Receipt validation

The reviewed HOST bytes were independently hashed with PowerShell `Get-FileHash` (read-only) and match the supplied source manifest plus pre/post final replay manifests:

| Reviewed file | SHA256 | Manifest Git blob |
| --- | --- | --- |
| `src/legacy/use-gate.ts` | `5e75e018c455222c53c09f1e83c0c62864952b27f111885e039aaa84b5390bac` | `a53e8b81abc970600a7e0b27a5edbd60af6f01c3` |
| `test/legacy-use-gate.test.ts` | `d25bfba71e5a75f77fa707ef67dcfc88f710c15d45d90cacf80a749703740186` | `85b2984005e15d00281e0def03f55a95e809c0a2` |

Selected existing receipts read beneath `task-1/`:

- `gate-green.txt`: Vitest 3.2.7, one test file, **9/9 gate tests passed**.
- `runs/replay-de6c4f2e-2071-4d9f-8d59-813cf123143d/tests.txt`: again **9/9 gate tests passed**; combined qualification is **11 passed / 1 failed**. The preserved failure is the separately unaccepted native OFF qualification.
- The same replay's `typecheck.txt` records `tsc --noEmit`, and `result.json` records **typecheck exit 0**, tests exit 1.
- `source-manifest.json`, `pre-final-replay-source-hashes.json`, and `post-final-replay-source-hashes.json` bind the gate bytes to that recorded verification; post-replay comparisons for both reviewed files are true.

These are validated stored receipts, not new test execution. The gate-only RED receipt is not being claimed as nine observed assertion failures. This review does not independently establish branch/commit ancestry or audit the two native implementation files.

## Acceptance boundary and remaining evidence limits

`task-1-report.md` remains **NEEDS_CONTEXT**. Its recorded Node 24.15 OFF refusal under default defensive behavior remains the existing native-policy blocker; this interim review neither re-evaluates it nor changes its disposition. Native feasibility, memory/temp/resource limits and native close/crash behavior are outside this review.

The pure gate meets the frozen component requirements on source inspection and the selected passing receipts. Its tests cover gate admission and lease semantics, not connected ownership. Actual Store-bound validation, complete Store/service/query/preparation adoption, generation invalidation, cleanup authority, no use-after-retirement and grant restoration still require the later connected implementation and its full independent review. The root must review the complete native plus owner cutover before any whole-task or integrated acceptance. No product adoption or fake-consumer/reachability exception is granted here.
