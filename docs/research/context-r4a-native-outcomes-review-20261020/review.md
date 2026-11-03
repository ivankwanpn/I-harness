# Native producer outcomes — independent spec and quality review

## Scope and verdict

**PASS for the scoped native producer outcome implementation. No actionable Critical, Important, or Minor finding identified.** Root retains acceptance and has separately completed its source/copy/evidence audit as described below. This verdict does not accept the three unresolved original subagent status assertions, later R4A work, or release readiness.

Reviewed the complete supplied `review-72a04b02..5a2c60f3.diff` once in four bounded chunks, the current complete native plan including its approved working-tree NAT-13 amendment, task brief, implementation report, delivery, review brief, and this workspace's progress ledger. Review range: BASE `72a04b02b123ba2371cd78ac21029fe020b4de0e` through handoff HEAD `5a2c60f3951bc78decfdde74e7612eccc7bc3b94`; product/test commit `3cf3bc12c4eea5518f0d7753c0dbb9b1e007cb0b`. The future explicit-pages plan was excluded.

Applied the `requesting-code-review/code-reviewer.md` review template. The review was read-only except for this file: no test/build execution, product/test/Git changes, live profile access, other SDD inspection, or recursive delegation.

## Strengths

- The native disposition follows the approved process-tree contract. `packages/sandbox/src/execution-lease.ts` records the original admitted reason before invoking the termination hook and reads `nativeTermination` plus the sticky successful `terminatedReason`. Frozen snapshots do not call cancellation or cleanup. Pending admission, failed termination after recovery, first successful retry, and late tree-empty cancellation have direct behavioral controls.
- `packages/exec/src/capture/completion.ts` classifies only after the existing root/tree/I/O/cancellation barriers and failure checks. Confirmed tree termination has the approved priority; supported `none` uses the original finite integer root exit without observation error. Missing observation, pending/failed termination, null exit and uncertain exit remain unknown. Null normalization stays a separate program-value operation. No new path converts incomplete settlement into a ready result.
- POSIX, WSL and Windows Psec explicitly forward the method through their existing handle whitelists. Inspection of the surrounding Windows implementation confirms that its `session.release()` then `lease.release()` order remains intact. The snapshot adds no alternate native termination or release owner.
- The existing retained-output WeakMap now carries reader and outcome in the same row. Both registrations preserve the other field, and retention-failure rewrapping transfers the complete row, including an outcome-only streaming identity. JSON, copied object fields and symbols cannot mint this host identity. Shell declares from the original result before its existing projection.
- The existing registry row distinguishes initial unknown from explicitly declared unknown without changing the serialized execution shape. Outcome and MCP presentation updates preserve one another in both tested orders. Ordinary third-party returns retain the normal success default even when their arbitrary payload resembles a failure.
- The shell branches declare their own known refusals and native outcomes. Startup/promotion keep their handoff semantics, and actual registered job observation/control calls keep success while returning failed/canceled job data. Only `code_exec` maps the original runtime observation; wait/status/control and guest-caught nested failure retain their own call semantics.
- NAT-13 changes the original terminal owner only. The callback is invoked before the conditional await and completion fallback, so a synchronous callback must return before that fallback commits. A returned Promise remains awaited without an `instanceof Promise` restriction. The unchanged retained-cell eviction assertion, held acknowledgement admission control, ordinary rejection and FACT recovery controls directly address the timing distinction. Existing managed mount code remains asynchronous and retains its original F1/store receipt callbacks and cleanup.
- New normal/nested managed tests exercise the actual assembly, producer registry, retained envelope and model projection. They assert full original native values, original call/source pairing, failed/unknown envelopes and successful outer guest completion. Existing controls also exercise exact native frame bytes/digests, output recovery, store Stop, and no guest fulfilment/replay after a held failed hook.

## Issues

### Critical — must fix

None identified in the reviewed unit.

### Important — should fix

None identified in the reviewed unit.

### Minor — nice to have

None raised. Style preferences and already disclosed qualification boundaries are not product findings.

## Evidence inspected

In addition to every changed product/test file in the supplied diff, inspected concrete surrounding owners: complete lease/capture completion and job observation; capture output settlement; registry dispatch/finalization and retained recovery; Code Mode registration, retirement, cell state and observation projection; shell foreground/selected/retention; Windows native handle release. Inspected the original managed frame, retained code, held-hook Stop, managed output-boundary and managed-store Stop test controls where their assertions substantiate compatibility.

Read these actual saved raw logs under `.tmp/context-r4a-native-outcomes-20261020-implementation/`:

| Raw evidence | Observation from the saved output |
| --- | --- |
| `registry-red.log`, `registry-owners.log` | Declared unknown originally becomes succeeded; final registry/retained/contract selection passes 15/15. |
| `code-red.log`, `code-final-owners.log` | Actual registered failed and terminated launches originally report succeeded; final Code Mode owner selection passes 69/69. |
| `nat13-red.log`, `nat13-green.log` | The unchanged eviction case fails with `Active cell limit exceeded`; the three async controls already pass in RED. The focused GREEN passes all four selected cases. Skipped cases in this filtered run are explicit; the final full 69-test selection supplies the broader gate. |
| `nat13-managed-final.log` | 27/27 across genuine normal/nested native assembly, retained MCP/code output, managed output boundaries and durable store/forks. |
| `managed-owners.log` | Earlier 21/21 selection additionally includes exact retained native frames, automatic background settlement and held-hook Stop. These are saved runs at their recorded times, not one combined final 48-test gate. |
| `exec-owners.log`, `exec-final-controls.log`, `lease-final.log` | Earlier affected Exec selection 70/70; final native controls 18/18; final lease 27/27. The 70-test run contains the earlier 17-test native selection and must not be relabeled as a later all-Exec rerun. |
| `retention-transfer-withdrawal.log`, `retention-transfer-restored.log` | Withdrawing transfer produces four outcome failures, including streaming null; restoration passes 6/6. This is a regression discriminator, not a historical baseline RED. |
| `shell-owners.log`, `windows-native.log` | Shell selection 53/53 and separate real unrestricted Windows helper smoke 1/1. |
| `observations-corrected.log`, `subagent-owners.log` | Actual registered job factory observation/control control passes. Broader subagent selection remains 67 passed / 3 failed with concrete original status assertions. |
| `posix-owners.log`, `wsl-owners.log`, `psec-owner.log` | POSIX 9 passed / 2 skipped; WSL 19 passed / 6 skipped; Psec fake protocol 25/25. |
| `gateway-final-probe.log` | Saved copied-runtime resolution paths point into candidate packages; selected shell/bash/pwsh root0/7/null, code_exec failure/code_wait success, synchronous terminal eviction and real Windows pwsh smoke report pass. |

The implementation report/delivery additionally report ten affected typechecks and four final typechecks. This review does not independently rerun them or duplicate root's manifest, import-map, generated-asset and seal audit.

Root subsequently supplied `root-verification.json`, which this reviewer read: it records the same BASE/product/handoff identities, 2,579 final source files, 245 selected source copies, 13 selected entries, 9 native/generated assets, 78 complete copied internal packages, 1,142 closure files, 322 dependency edges, one fixture import edit, and an empty failures array. Root reports rehashing 17,772 sealed files/reports and checking 56 source-stable, nonoverlapping receipts; the selected and entire internal closure checks found byte-identical originals, with the separately reproduced generated WSL manifest accounted for, and runtime dependency edges resolving inside the candidate. These are **root-owned verification results**, not reviewer re-execution. They qualify precise candidate/copy provenance while retaining the early RED fixture and platform limits.

## Qualification limits and recommendations

The early RED source manifests omit newly added untracked tests. The raw logs demonstrate the executed behavioral assertions, but do not establish a complete baseline test-tree manifest. The delivery explicitly discloses this limitation. Setup-only failures described in the delivery and the earlier duplicate-ID copied fixture failure are not counted here as product RED evidence. Root's complete final candidate/copy identities are a separate acceptance proof; this review of the saved probe output is not a substitute for that audit.

Live coverage is unrestricted Windows helper/PowerShell smoke only. Controlled native boundaries and fake protocol tests substantiate the classification and lifecycle logic. Forwarding, types and skipped tests do not qualify live POSIX/Linux, WSL or confined Psec execution. The copied probe qualifies selected registered producers and the original terminal owner, not the complete IPC/installer surface.

The saved subagent failures are specifically: `publishes complete followup lifecycle patches and clears previous output at start` (`seen[0]` absent at `packages/subagent/test/tools.test.ts:282`), `background:false blocks until the task settles and returns the summary` (running versus waiting at line 1085), and `job_output still reads subagent jobs (unchanged path)` (running versus completed at line 1213). They remain unresolved assertions. No subagent production owner changes in this diff establish a repair, and this review does not independently prove their complete historical causality. Keep root's separately scoped owner-boundary qualification explicit; do not waive these assertions or claim all-R4A completion.

No additional runtime discriminator is required for a finding from this review. Root can record its acceptance and continue the separately approved residual/future work without broadening this unit's claims.

## Assessment

**Ready to integrate this scoped unit? Yes, subject to root's final acceptance.** The implementation matches the approved native outcome semantics and preserves the existing original completion, retention, observation and control owners. The direct behavioral controls, saved final gates and separately recorded root provenance audit support this scope; unresolved subagent status work, unexercised platforms and wider release qualification remain explicit limitations.
