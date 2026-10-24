# F0 fix round 2 — scoped connected owner handback

Spec review: **Approved for staged F0 owner scope**. Quality review: **Approved for staged F0 owner scope**.

No remaining actionable findings in this reviewed correction or its examined interactions with the connected owner range. The fix-round-1 P2 is closed. The original three findings remain closed by the preceding correction and its retained controls.

Reviewed frozen NATIVE HEAD `4d999d251823b964398348165de94ea7d432080e`, branch `codex/fork-binding-observation-20261024`, checkout `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`. This handback reviews incremental `187eea5545f5ab462e210e168e2db6cb9af1deb9..4d999d251823b964398348165de94ea7d432080e` in the context of the previously reviewed full owner range `ca81bdd2ec944105b9fd62534a932336e587179e..4d999d251823b964398348165de94ea7d432080e`. Only the private observation helper and its existing test file change in this round, 65 additions / 7 deletions.

The correction report, latest on-disk ledger, complete incremental diff, relevant original bootstrap support/capture flow, new tests, selected raw RED/GREEN/final receipts and source/preservation manifests were read. Unchanged owner files were not mechanically re-reviewed without a new concern. Original root rulings F0-01 through F0-06 and F0-R1-04 remain binding. This was read-only review: no runtime, tests, builds, Git mutations, product changes or subagents. The only write is this report. All earlier review reports are preserved; the four protected retirement directories were not opened or changed.

## Remaining P2 disposition

The previous unfenced fallback at `binding-observation.ts:65/71` has been removed. The current helpers at lines 65–78 have explicit `BootstrapOutcome` return types. A failure capturing the complete request/invocation/optional resume payload or target-preparation guards returns the closed `{ kind: 'refused', reason: 'manifest-invalid' }` outcome directly. There is no generic cast, raw caller forwarding, second inspection, callback into the original owner, pending mutation admission or issuance after that error.

This closes both one-shot descriptor and one-shot `has` inspection cases for bootstrap and resume. It also avoids waiting on the observation that the malformed call originated alongside: refusal is terminal before mutation admission. The original observation remains current because no mutation or issue occurs; after it retires normally, ordinary metadata mutation still progresses.

Successful capture continues to pass only captured invocation/request/payload and captured preparation port to `bootstrapMutation`, then through the same existing managed/bootstrap owner. Its pending admission, exact captured-target callback exception, original-flight sharing, unknown recovery and pre-await payload binding are unchanged. The correction does not introduce a second success path or bootstrap owner.

## Refusal compatibility and ordering

The new `bootstrapSupported` check uses the same predicate as `createBootstrapOwner.supported`: enabled locking plus `prepareBootstrapHeader`, `reconcileBootstrapHeader`, `readBootstrapState`, `confirmBootstrapFrames`, `appendOwnedBatch` and `reconcileOwnedBatch`. It occurs before request/guard capture in both bootstrap and resume helpers. An unsupported backend therefore returns the existing `not-issued/unsupported` outcome without inspecting caller guards. This synchronous capability check grants no ownership or bootstrap authority.

For supported backends, malformed/accessor requests, invocations and optional resume payloads retain the existing `refused/manifest-invalid` classification without executing the accessor values. The new regression case verifies all three forms. The successful-capture path retains F0-R1-04's complete capture before admission waits. Target-preparation presence/absence and function references remain captured, while Stop, source guards and dependency access continue forwarding with their original receiver. The prior 49 observation controls and all 58 unchanged physical bootstrap controls run in this round's final affected gates.

A source search of the helper confirms that no `return run(rawCaller...)` error fallback remains. The only bootstrap/resume owner invocation paths follow successful capture and `bootstrapMutation` admission. The wider ownership claims, document lease/currentness, deletion and dependency-ordered close behavior are unchanged from the previous connected review.

## Evidence reviewed

The seven new controls were run against the reviewed parent before the correction. Raw `terminal-capture-red` records six failures, one already-passing malformed/accessor case, and the prior 49 tests skipped. For all four descriptor/has bootstrap/resume cases, stdout records two inspections, actual JSONL backend counts `[3, 1, 1, 1, 1]`, and changed header bytes. Those counts cover read state, prepare header, reconcile header, append owned batch and confirm frames. The RED therefore reaches actual original-owner disk/journal work rather than merely asserting a mocked callback.

`terminal-capture-green` records seven passing new controls. All four primary cases record one inspection, backend counts `[0, 0, 0, 0, 0]`, and unchanged header bytes. Tests also check the terminal manifest-invalid outcome, continued observation currentness, bounded no-wait behavior, unchanged ancestor lineage, normal observation completion and subsequent metadata mutation. Unsupported bootstrap/resume assert zero guard inspection.

The final source-bound affected receipts record:

- `handoff-owner`: **90 passed**, including all **56 observation controls**, ownership 18, managed 14 and strict document 2; exit 0.
- `handoff-jsonl`: **70 passed**, including all **58 physical bootstrap controls**, strict observed reader 6 and owned deletion 6; exit 0.
- `handoff-types-1` and `handoff-types-2`: both package-CWD `exec tsc --noEmit` exits 0.

Exact command receipts specify executable, argv, package CWD, timestamps and process outcome. Vitest gates retain the required `--maxWorkers=2 --minWorkers=1` and run sequentially. The independent typechecks run in parallel. The initial TS2339 error in the spy-counter test collection is preserved in `final-types-1`; the final explicit counter type changes instrumentation inference, not assertions or product behavior.

I independently hashed all eleven current physical owner files and compared them with this round's `committed-source/manifest.json`: **11 checked, zero mismatches**, at HEAD `4d999d25...`. Final-gate comparison records no physical source mismatch. The committed manifest distinguishes physical hashes from canonical LF Git hashes, preserving the prior honest CRLF qualification. The previous-preservation receipt reports all 295 original entries and all 392 fix-round-1 entries unchanged, no extra files in either old subtree, and unchanged prior reports/manifests. Root remains responsible for the independent complete evidence audit and final integration binding; this review does not claim independent test execution or a dependency/runtime attestation.

Full packages were **not** rerun at this HEAD. The round's claim is limited to the affected 90/70 controls and two typechecks. Fix-round-1's 244-pass-plus-original-F1-RED persistence receipt and 264-pass JSONL receipt remain historical evidence for `187eea55`, not newly asserted full-package results for `4d999d25`. The original F1 `CONSUMED-PROOF-ONLY` failure remains visible and unchanged; this approval does not convert it into green or waive it.

## Approval boundary

This is staged F0 owner approval over the connected range after the reviewed corrections. It does not claim shipping fork completion. Actual F1 `acquireCliForkTransfer` production consumption, stdio request handling, nonempty result catalog/member transfer, ordinary cold target read, original-invocation adoption and final vertical-range reachability remain mandatory later work. Source payload authority continues to require the real ManagedDocument witness; observation metadata/keys are not replay permission. Native evidence remains Windows only, with no added kernel-fault or Linux execution claim.

No further F0 correction is requested by this review. Root may proceed with its independent evidence audit and integration decision within that staged boundary.
