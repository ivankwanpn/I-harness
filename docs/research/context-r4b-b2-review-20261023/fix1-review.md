# Task2/B2.1 fix round1 — same-reviewer re-review

## Spec Compliance

- ✅ **F1 ADDRESSED — actual immutable birth frames survive ordinary replacement.**
- ✅ **F2 ADDRESSED — each header short-write continuation repeats the current guard.**
- ✅ **F3 ADDRESSED — retained publication artifacts participate in inspection, continuation and ready confirmation.**
- ✅ **Fix-range specification verdict: compliant with the dispatched Important-fix scope and R-B-26/27.** No actionable new breakage was found in this six-file range.
- ⚠️ Original Minor4/5 are explicitly deferred, remain open, and are not claimed fixed. Task3 authority, Task4 consumers/logical intent/action ownership, native gates, the original raw-fork RED and seven reachability rows remain connected/whole-B obligations. This is scoped fix approval, not whole-B or publication approval.

Reviewed BASE `50db21c16cc8a4add4b2ff4bf2d6c7c0d4757c58` → HEAD `9b7f3fa343528cb7e77725273b19ca7aa3fabf87`, one commit, all six files in the complete generated `review-50db21c1..9b7f3fa3.diff`. Binding inputs were the original review, `task-2-fix1-review-brief.md`, `task-2-fix-round1-brief.md`, appended R-B-26/27 and the appended implementation report. Product/version/format and original global constraints remain unchanged.

## Strengths and individual resolutions

### F1 — ADDRESSED

`packages/session-persistence-jsonl/src/backend/fact-journal.ts:12–34` now loads and validates the retained original stage, compares immutable birth/header/journal scope, decodes the actual journal through the existing reader, and requires candidate birth records to equal the actual immutable prefix. It checks the actual seed/completion frame IDs, first positions and counts. Its result is a slice of the **existing physical body**, with the actual completion prefix digest; it does not recreate birth frames from equivalent semantic events.

The retained-stage branch at `packages/session-persistence-jsonl/src/index.ts:234–240` fully validates the candidate, preserves the actual raw header and birth bytes, and encodes only the ordinary suffix against that actual prefix. Missing stage or unavailable phase layout throws before publication. The stage-free/legacy canonical path remains separate at `index.ts:242–249`, preserving its existing behavior.

The maintained tests at `packages/session-persistence-jsonl/test/bootstrap-physical.test.ts:385–439` cover nonempty seed plus initial admission and a later suffix; same-events and changed-suffix replacement; independent byte equality for the raw header/birth prefix; subsequent normal reading and title mutation; cold original seed/completion-key adoption with one initial admission; zero-seed completion preservation; and byte-preserving refusal of changed closure, dropped initial admission and a foreign whole-birth layout. The existing stage-free canonical replacement control also passed without changed assertions. These controls directly address the original regression and the R-B-26 chosen resolution.

### F2 — ADDRESSED

`packages/session-persistence-jsonl/src/backend/bootstrap-header.ts:103` calls `before()` immediately before every `h.write` inside the asynchronous complete-write loop. The existing idempotent header issuing closure repeats ownership/currentness checks, while the ordinary fact journal's original settlement mechanism is untouched. Guard failure leaves the partial file and original operation available for guarded continuation; passive reconciliation remains distinct.

The four maintained stage/target × stale/abort cases at `packages/session-persistence-jsonl/test/bootstrap-physical.test.ts:440–468` call the real native write for 11 bytes, flip staleness/abort before returning its promise, assert exactly one selected write and zero post-flip writes, verify exactly 11 retained bytes, repeat stopped resume without writes/byte changes, and recover under fresh guards. The RED log directly shows 165 stage or 71 target writes instead of one before the fix; the same cases pass afterward. Reordering the failing-count assertion exposed the causal behavior without removing the final header-phase assertion.

### F3 — ADDRESSED

Read state now retains bounded publication bytes and explicit presence, and absence requires no target, stage, publication or foreign operation: `packages/session-persistence-jsonl/src/backend/bootstrap-header.ts:66–88`; the DTO change is at `packages/session-persistence/src/coordinator/bootstrap-types.ts:28`. Thus filename discovery supplies uncertainty, not a manifest.

Preparation validates retained stage/publication prefixes before first mutation, forbids publication for new-target work, and rechecks the exact original empty target before publication: `backend/bootstrap-header.ts:109–132`. Passive reconciliation checks retained publication and returns unknown for the still-unchanged original empty header, allowing separate current guarded continuation rather than treating that expected original header as conflict: `backend/bootstrap-header.ts:144–163`.

Coordinator `publicationStatus` distinguishes valid/unknown/conflict from the captured original stage and actual bytes. The run path marks retained publication as issued uncertainty and checks it before header work or ready adoption; inspection reports unavailable/needsConfirmation with an honest token when binding is missing: `packages/session-persistence/src/coordinator/bootstrap.ts:35–43,112–137,232–239`.

The maintained tests at `packages/session-persistence-jsonl/test/bootstrap-physical.test.ts:469–517` cover the literal 19-byte publication-only negative with no target/stage creation; an actual 13-byte existing-empty publication write cut; stale byte-preserving refusal; fresh warm and copied-store cold original recovery; foreign publication refusal with target/stage/publication bytes unchanged; and conflicting publication after genuine readiness. These exercise both the original false-absence defect and the continuation/ready interfaces affected by its correction.

## Issues

### Critical (Must Fix)

None found in the fix range.

### Important (Should Fix)

None remaining from F1/F2/F3; no new Important finding in the reviewed fixes.

### Minor (Nice to Have)

Original Minor4 (non-enumerable DTO fields) and Minor5 (unasserted expected cleanup stderr) remain recorded in `task-2-review.md`. Root explicitly deferred both from this loop. The expected diagnostic is still visible in `focused-owner-green.log` and `final-jsonl-suite.log`; it was not hidden or represented as pristine output. No new Minor finding is added by this re-review.

## Evidence and review limits

- Read the complete six-file fix diff once, the binding fix briefs/rulings and appended report. Followed the existing same-reviewer template. No product runtime, suite rerun, subagent, Git/index mutation or product/test edit was performed. Only this requested review artifact was written.
- Read actual raw RED outputs: `three-findings-red.log` (seven behavioral failures), `short-write-counts-red.log` (four actual write-count failures), and `retained-publication-red.log` (four publication behavior failures). They contain assertion failures rather than setup/collection/API failures. Read the corresponding focused GREEN output; F1 plus the stage-free control has three passing cases, F2 four, and F3 four at those intermediate sources. Those intermediate runs are not substituted for the final-source evidence.
- Read `.tmp/r4b-b2-fix1-20261023/focused-owner-green.log` and metadata: four files/101 tests pass. Read `final-jsonl-suite.log` and metadata: 19 files/228 tests pass, including all 40 physical bootstrap cases. Read both final persistence/JSONL typecheck metadata records: exit0. Existing expected cleanup stderr remains disclosed.
- Final focused run, both typechecks, full JSONL suite and `commit-binding.txt` carry the same complete 241-file scope hash, `F37D8C3414041C2A994EA4F18BAE06E215E3692EEFC4EE61217E6476AF257683`, with unchanged before/after scope and root-rulings hash. Runtime metadata correctly identifies the then-current BASE HEAD; commit binding subsequently maps those exact contents to `9b7f3fa3`. Root independently audited 241 current source/test files, six fix Git blobs, four final run manifest/exit records and 43 evidence files with zero errors in `task-2-fix1-root-audit.json`. Identity checks are separate from the functional judgments above.
- Core/persistence full suites and reachability were explicitly reused from the original handoff, not rerun or claimed fresh for this fix. No core implementation changed. The persistence changes in this range are exercised by the actual JSONL bootstrap cases and both selected transitive typechecks, consistent with the dispatched scope. No unresolved behavioral doubt required an additional probe.

## Assessment

**Task quality: Approved for this fix range.**

**Reasoning:** All three reproduced Important defects are corrected by cohesive changes at their existing owners, and maintained real-file regressions verify their causal failures, exact byte preservation/refusal and cold receipt behavior. The original two Minor items and deferred connected gates remain explicit; this approval does not imply whole-B completion or release authorization.
