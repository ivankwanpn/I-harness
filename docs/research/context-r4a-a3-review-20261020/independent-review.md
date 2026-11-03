# Original reviewer — final A3 refinement

Reviewed frozen product commit `583bc11fff2905778b0c983f1887a75de61d380c`, including the complete root correction range `0cf2d24f..583bc11f` (27 files, +560/−66) and its interaction with the external A3 range `4730ca83f5f3e97a1ab5a4bf8d8d2b5131987456..583bc11f`. The original external delivery review remains unchanged in `a3-review.md`.

**Scoped specification verdict: Pass for the A3 correction and exercised source/copied-library paths. Scoped quality verdict: Pass; no actionable issue remains from this independent rereview. Whole R4A ready to merge: No.** This is not whole-R4A acceptance, a claim that every affected suite passes, or a full protocol/live-provider qualification.

Root was the sole product writer and executed the runtime controls. This reviewer inspected source, test changes, raw results and manifests, but ran no suites, edited no product/tests/Git state, and spawned no agents. Only this new report was written; prior reports/probes/evidence remain preserved.

## Findings closed and final ownership

| Boundary | Final assessment |
| --- | --- |
| Original A3-F1: full raw archive first, second complete text artifact later | Closed. `output-facts.ts` stages original text retention before one bounded `code/output` F1 envelope. Its committed callback passes the same retention identity to the original runtime item. Shipping observation projection reuses one text ref, or saves a typed ordered index of the original refs/media positions. It does not join and store the complete text again. Known refusal publishes a bounded unavailable descriptor rather than full raw text. |
| Original A3-F2: checkpoint/Stop permanently invalidates issued storage | Closed for the tested original-operation cuts. The factory distinguishes issued initialization before awaiting `beginResult` and uses the actual held source/active capture lifetime. Observer abort no longer invalidates required passive settlement of an issued operation. Actual managed Agent controls cover initialization, finish, index and accepted backlog uncertainty followed by checkpoint cancellation and Stop. |
| New envelope validator existed but actual intake/cold decode skipped it | Closed. Both real validation dispatch guards now include `code/output`. Current envelope intake/decode, conflicting raw-plus-envelope input, predecessor/future rejection and literal legacy content are exercised at actual append/JSONL boundaries. |
| A mount-long-lived hold could remain after output recovery | Closed. An admitted cell's finite output source owns staged output preparation, F1 publication and installation. Its successful close releases only its own hold, leaving the mounted owner usable. There is no generic reset, replacement journal or second execution authority. |
| Index uncertainty precedes registry finalization and lacked a genuine tool hold | Closed. The authentic retained-outcome failure path now holds its already registered original tool source. It does not rely on a finalization handle that does not exist yet. The actual index-only Agent cut verifies optional work remains blocked. |
| Stop terminal could overtake earlier output | Closed. Required terminal metadata joins the original FIFO. The running-guest Stop control preserves `started → code/output → terminated`. |
| Source pre-drain could admit an eagerly captured terminal ahead of unknown storage | Closed. Metadata is strict-validated and immutably captured immediately, but its F1 capture is allocated only at its FIFO position. Thus source pre-drain has no unissued terminal capture to jump the output stage. The test also mutates caller metadata and verifies the original stop error survives recovery. |
| A second accepted same-cell emission could attempt forbidden new source registration under the first output's hold | Closed. Already accepted text and media backlog reuse the original finite per-cell cohort source. Its drain walks ordered records; successful close removes the cohort. Actual Worker-message and managed-source controls verify both accepted output facts survive, with one guest/inner tool and no repeated first-source writes. |
| Escaped ordinary JSON exceeded 64,000 bytes; a valid long image name could force accidental failure | Closed. `observation-output.ts` budgets final serialized ordinary JSON, preserves typed media separately, and avoids duplicating image names in ordinary item metadata. The valid 70KiB name remains in the typed image; the guest completes. NUL/escaping controls bound both source archive and returned ordinary output. |

The final staging preserves one semantic authority: the actual existing cell action registers the required output source, and that source retains the original capture and later F1 fact through uncertainty. A cohort contains only admitted work from that cell; it neither starts executable work nor allocates a replacement producer during a hold. Finite source closure removes its own recovery protection only after original storage/publication/installation succeeds. Required terminal metadata remains immutable while waiting behind those stages.

The new `code/output` envelope is an explicit alternative to historical `content`. The legacy read branch remains available, and raw-plus-envelope conflicts are rejected. Managed-ref extraction, bounded search projection, Gateway projection and the renderer recognize the new representation. The generic verified reader still supplies encoded JSON pages. For multi-text windows, `code-text-index-v1` is explicit representation data identifying original text refs and media positions; it is not a read grant or another copy of the text/media bodies. Normal source/ACL/pin checks remain at the store reader.

## Frozen-source verification

The final maintained source digest is:

`48a8a627ca0bb87d852820c48639f85fdd9dcd91d9d94e497f267d655ee7a192`

The manifest contains **2583 maintained inputs**. This reviewer independently compared the recorded bytes/hashes against the current frozen files:

- Root correction range: **27 paths recorded, 27 identical, zero mismatches**.
- Full A3 product/test range: **35 paths recorded, 35 identical, zero mismatches**.

The final receipts record HEAD `0cf2d24f` because root's correction was then uncommitted. The matching maintained bytes now reside at `583bc11f`; qualification rests on those captured bytes rather than interpreting the earlier HEAD string as final source. Product/test Git state is clean; the separate root planning document remains untracked.

## Runtime and copy evidence

Root executed these controls sequentially. This reviewer read the final critical raw logs and receipts in `.tmp/context-r4a-a3-codex-20261019/runs/`, along with the actual test/fault implementations:

- `a3-real-backlog`: **8 tests passed** on the frozen digest. The real managed Agent/WASM cases exercise initialization/finish/index/backlog unknown results, checkpoint cancellation and human Stop, original output refs and work counts, escaped ordinary output and valid media metadata. The backlog case observes two real Worker output messages reaching the original host listener before the first unknown finish; it does not use a sleep or a replacement guest.
- `a3-copied-controls-b`: **30 tests across 5 files passed** on the frozen digest. They exercise the deployed Gateway-copy libraries, including the actual 1MiB WASM assembly/cold reader, restricted child mount, output ordering/recovery, schema and source controls.
- The final Code Mode suite reports **95 passed / 1 failed**; the final executor scope reports **39 passed / 5 failed**. The remaining failure names match the externally recorded A3 candidate failures: retained-cell eviction timing, legacy shell `contextRef` expectation, and four legacy search/Stop expectations. These suites are **not all green**. This review does not upgrade matching candidate failures into an independently isolated `4730ca83` baseline or prove unchanged failure frequency.
- Earlier source-time-qualified controls report core-session **418 passed**, core-tools **136 passed**, retained-agent **5 passed**, subagent Code Mode **7 passed**, renderer **6 passed**, Gateway cold projection **1 passed**, and six type scopes. Their receipts precede later FIFO/cohort deltas and retain their recorded source digests; they are not silently relabeled exact-final-source reruns.
- Final executor typecheck, fresh Gateway build, fresh CLI build and `verify-dist` exit **0** on the frozen digest. The CLI build retains the existing dynamic-import warnings; its smoke surface does not qualify every dynamic runtime path.

The actual 1MiB test runs the real WASM guest through the assembly, verifies the original bounded F1 representation and cold artifact bytes/digest, and preserves the source admission limits. The restricted-child test uses the real restricted assembly mount and durable store/ACL path. These are stronger than the external delivery's standalone/no-source fixtures, but do not qualify all cross-owner/project-transition cases.

The child/team three-turn close/reopen fixture was changed to wait for genuine committed `turn/end` receipts and join actual owner close before cold reads. It still closes at the exact second-turn receipt callback, retains the third-turn/cold output checks, and preserves the original **15-second global deadline**. Root preserves four failed attempts caused by the old one-second snapshot polling crossing valid in-flight F1 work. Inspection supports this as correcting the fixture's observation boundary rather than removing the cold-state oracle.

Root reports the copy audit verified **845 identical source files**, **280 workspace edges inside the deployed copy**, and **38 AST import rewrites across seven test/helper files**, without modifying copied production modules. The initial copied-QA attempt failed during setup because desktop-gateway ships as a bundled entry rather than a `node_modules` package; that failure is preserved. The Gateway cold projection is separately source-tested. No live Gateway IPC or full CLI code-output protocol claim follows from these library controls.

Root independently verified the external delivery's **31 sealed files and seven receipts**. This reviewer read `external-verification.json`, which reports no issues and explicitly states that the sealed set lacks an isolated baseline comparison and eight other claimed type-scope receipts. Those missing materials are not treated as passing or baseline/regression proof.

## Inspected source scope

Inspected the complete frozen 27-file correction diff and the earlier external A3 diff, including:

- Code Mode original output publication, finite/cohort source lifetime, runtime admission/observation/recovery, immutable terminal metadata and final wire formatting.
- Executor artifact capture, issued-operation tracking, original source assertions, normal and restricted child composition, exact JSON body/index representation and existing verified readers.
- Core-session event union, actual intake/JSONL decode validation, result ref enumeration and bounded search projection.
- Core-tools authentic retained-outcome registration/hold and existing tool-batch source closure; no structural lookalike receives the new hold authority.
- Gateway and renderer legacy/current output projection, plus all changed fixtures and their preserved receipt/order/cold-read assertions.

No further actionable defect was established in the frozen source. No additional runtime probes were requested after the final cohort correction.

## Remaining unaccepted scope

The broad project-switch/original descriptor-binding question remains explicitly unqualified: the current text factory resolves `sourceFor(sessionId)` at emission/capture time; this review does not prove behavior across a confirmed scope transition between cell admission and first emission. No runtime failure through actual Desktop binding/reconciliation was established, so it is not presented as another confirmed defect.

A4–A6, broad cross-owner catalog membership/read grants, complete media/search/export cutover, all crash/ACL/deletion/concurrency cuts, final 100MiB/100-child qualification, full protocol/live-provider/IPC and whole-session recovery remain unaccepted. The scoped pass does not accept full R4A from `91d8fef0`, change the decomposition count/product version, or authorize merge/tag/release. Root owns final user-facing disposition and any subsequent work.
