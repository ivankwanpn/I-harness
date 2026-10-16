# R1B durable acceptance verification

Implementation `4d09ed4fae34db85d607a4ec467e0770a9924922`, based on `037b858f68fd5b5a3b3a508b9f909f1fbf6b24d3`, passed fresh independent spec and quality review on 2026-10-16. There were no Critical or Important findings. This is a focused implementation gate, not whole-program or release qualification.

## Delivered

- Session format3 distinguishes a legacy prefix from explicitly accepted exchanges. A complete model end and an awaited acceptance flush precede tool preparation/approval/dispatch. Failed or partial responses remain audit observations.
- Physical retry attempts retain their logical action identity. Later tool, Stop or persistence failures cannot revoke an already accepted response or license replay of its tools.
- One metadata validation algorithm checks complete history and incremental suffixes. The live append owner commits metadata before observers; the persistence owner reconciles uncertain writes against durable history before retrying retained batches.
- Root, plugin, delegated and inherited input provenance reaches actual application boundaries. Inherited parent messages cannot gain child-local request authority.
- One batch seed transformer preserves acceptance, images, source references and fencing across both session and child forks. Fenced recovery appends truthful error/unknown facts without shifting accepted references.

## Recorded verification

All package suites ran sequentially with maxWorkers2/minWorkers1. Recorded logs include exact commands and exit0 receipts.

| Suite | Passed |
| --- | ---: |
| core-session, full suite | 200 |
| core-agent, acceptance/finalization/retry/tool/input consumers | 90 |
| session-persistence, format/recovery/fork/write-behind | 72 |
| session-persistence-jsonl, context/jsonl/metadata | 29 |
| session-executor, input/steering/schedule/hooks | 25 |
| subagent, child/resume/fork/native-role/tools | 156 |
| desktop-gateway, input/idempotence | 7 |
| CLI, input tiers/run end | 9 |
| agent-team, completion/sequence/lifecycle/mailbox | 46 |
| Six-route controlled request corpus | 57 |
| **Total** | **691** |

Nine affected package typechecks and e2e typecheck exited0. Reachability final findings exactly equal the previous408-row array, digest `6af28bcbcb72706b3184f9b55025616f2e5c0358393538dce578312eb566eab4`. The independent reviewer checked the actual before/raw/final arrays (408→407→408): the one exact owner-map addition correctly keeps an internal coordinator use from masquerading as an external consumer. No baseline reseed or allowlist change. Audit self-tests82/82; staged and committed diff checks exit0.

Meaningful RED controls preceded acceptance, no-end, source, format, uncertainty, seed and structural-reference fixes. Operation counts prove metadata suffix processing and reference lookups; they do not prove bounded JSONL disk I/O. The new validation and seed owners are135 and131 lines respectively. Existing large CLI/assembly/service owners remain tracked separately.

## Evidence limits

Minor M1: the fresh pre-edit JSONL context baseline requested by the plan was not recorded. Final29-test JSONL results establish current behavior without supplying that historical comparison. The reviewer requested no retrospective rerun or product fix. Expected fixture diagnostics, inert audit warning, Windows newline notices and intermediate failing runs are preserved. Final tested source differs only by a disclosed coordinator indentation cleanup.

No live provider, installed profile, credential, package release or remote operation formed part of this implementation. The >100MiB corpus remains an in-memory JSONL-equivalent/request-projection control, not a cold disk recovery benchmark. No historical old-reader execution or native/account certification is inferred.

R1C snapshot/protection, R1D selection with the R3 publication foundation, R2 policy, broader R3–R6, R5 failed-call-ID reuse and CX1 disk I/O remain outstanding. The earlier full verify:all FAILED/incomplete result remains unchanged. Original decomposition remains27/43; no S/CX completion is credited here.

Subsequent R1C baseline at910da9a9 recorded17passed/5failed in the additional owned-budget/context-update/context-usage suites. These were outside the selected R1B gate and concern readable historical budget snapshots after accepted output/inherited binding/update. They are retained as pre-edit failures for R1C to resolve; the691 result above must not be interpreted as all repository tests passing.

Detailed local evidence is retained under `.superpowers/sdd/2026-10-15-context-engine-r1-acceptance/`: task-1-report.md, task-1-review.md, gate logs/exit receipts, RED controls, changed-path/AST-size evidence, and exact audit arrays. The [execution plan](../superpowers/plans/2026-10-15-context-engine-r1-acceptance.md) fixes the tested scope.
