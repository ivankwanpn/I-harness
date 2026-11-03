# Same-invocation retained batch continuation — scoped acceptance

Accepted and integrated: MAIN7edb3e41 contains donor a6c234c8, and MAINcd169c8d contains test-only qualification f36d8adc. Complete donor scope is e8fc3d1d..f36d8adc:13 files. Root verified every changed Git blob against the reviewed donor and ran targeted integration on the same MAIN containing the accepted index-inventory optimization. Product0.1.13-rc.1 and Session12 remain unchanged; no release/push/tag occurs here.

## Resulting behavior

A genuinely retained tool outcome can now continue in the same live Agent invocation after all original batch records, references, finalization and its actual managed source settle. It keeps the same accepted input and original producer; it does not rerun the tool or fabricate a successful execution. The original failed outer tool metadata and diagnostic error remain. The actual parent/child JSONL fixture reaches both final answers and carries the recovered result into the next real child request.

Eligibility is private and one-use, bound to the exact original error, prepared call, batch, source, invocation and turn. Raw/undefined/later checkpoint errors, unknown effects, policy/Stop, incomplete slots and cleanup errors cannot qualify. The handler is outside the existing handoff cleanup wrapper; it cannot unwrap an aggregate to regain eligibility. The original document's actual readiness, invocation lifetime and already-borrowed reviewer allowance are checked before and after readiness awaits. No public API/event/format/generic settlement-source change or live invocation-wide drain was introduced.

## Review and required gate resolution

The [full review](retained-batch-20261025/task-1-review.md) found no concrete continuation-code defect but blocked acceptance on the original close-boundary gate. Candidate failure `[1,2,2]`, diagnostic `[1,2]`, and the single original-BASE pass remain preserved; one passing baseline never established source independence.

The diagnostic captured actual `running` tool results when the controlled model declared final, before guest store/completion facts. The separate [test qualification](retained-batch-20261025/close-qualification-report.md) establishes completed-work preconditions through real model-visible code_wait. It preserves both ordinary child and teammate, original program, exact second-turn receipt callback, `[1,2,3]`, the15000ms deadline and cold restoration. Its separate genuinely held-running service-owned guest proves termination/no unfinished store/no old continuation after close/reopen. Scope is explicit: that negative is a service-owned guest, not a process-crash simulation or every child topology.

Fresh [qualification review](retained-batch-20261025/close-qualification-review.md) passed. Root reran the complete required six-file session gate under ordinary package settings on frozen f36d8adc:21/21 passed with2882 tracked files byte-stable. The original continuation reviewer then [closed P1](retained-batch-20261025/task-1-gate-review.md), giving scoped spec/quality PASS. Three cross-checkout source hash differences were solely LF/CRLF conversion, verified against exact original Git blobs; this is Git/content identity, not cross-checkout raw-byte equality.

## Evidence

- Donor core focused gate87/87; exact-final named core33/33 and connected session1/1; both package types passed. Original session19/20 failure remains, superseded only for acceptance by the reviewed completion qualification and actual full21/21 gate.
- Actual MAINcd169c8d: named core33/33, session continuation plus close3/3, core-agent and session-executor types exit0. Source stayed unchanged across these checks. [Integration receipt](retained-batch-20261025/integration.json) retains commands, environment, hashes and exits; overlapping counts are not summed.
- [Full implementation report](retained-batch-20261025/task-1-report.md) retains original unknown-after-landed RED, successful same-handle reconciliation, raw physical journals/artifact bytes, exact range/source manifests and all setup/type failures. Root retains the complete raw packet under `.superpowers/sdd/2026-10-25-retained-batch-continuation/` and the separate close-qualification SDD.
- The originally report-named public/generic diff file was missing; the reviewer independently compared those exact files and confirmed no change. This missing original receipt is not silently recreated as historical evidence.

## Remaining limits

Historical Code Mode003's first trigger remains unknown. This work proves and repairs a downstream recoverable control-flow mechanism with deterministic actual-owner tests; it does not invent that missing cause or prove general timing stability/native-platform completion.

Minor deferred qualification finding: optional evidence writes at the close test's lines163/270 can skip later fixture cleanup and eclipse an earlier failure if evidence I/O itself fails. It does not invalidate inspected successful runs. The exact finding remains in the close-task ledger and must be triaged at final whole-branch review; it is not discarded.

Public F1-C fork/strict readers, C2/ID child/instruction integration, complete event delivery/native integration, remaining R6 performance and fixed-version package gates are still required. This scoped acceptance is not whole0.1.13 acceptance.
