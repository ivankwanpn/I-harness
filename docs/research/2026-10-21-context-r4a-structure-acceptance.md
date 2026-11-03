# R4A cohesive task and legacy-result owners — root acceptance

2026-10-21. **Accepted for this bounded structural unit after the review repair.** Full accepted range is `bad38c2dc8b5663eaaeb2ef283ecd2b8de7b9994..ae56ce0996e4cc5f9738c798d200b89ee5032f0e`. Initial code freeze186dd0e2 and its deliveryf9b0dcd7 were rejected for one P2; repair code is `f7086d8acbf6febb5724688408d597beabae1d03`. The [original review](context-r4a-structure-review-20261021/review.md) and [same-reviewer fix recheck](context-r4a-structure-review-20261021/fix1-review.md) remain separate. No actionable review finding remains in the repaired range.

This accepts cohesive responsibility extraction, preserved behavior after repair, and the complete S25 responsibility/lifetime map. **Normal reachability still fails with six inherited public exports**, so whole R4A/A6 and final decomposition credit remain open. Product0.1.13-rc.1, Session10 and original27/43 counter stay unchanged. No push, merge, tag or release.

## Final responsibilities

TaskRecords now owns one records/identity/child-index set and task/anonymous counters. The registry retains cross-owner orchestration, subscriptions and original restore order. Existing result capture, settlement, F1 proof, notification rows and persistence chain stay in their original owners. Actual record identity, capacity-before-adoption, late-duplicate partial restore, duplicate-key index replacement, strict shallow call-time versus legacy execution-time snapshots and terminal callback behavior are preserved. Task claim is not a new R4C receiver-delivery claim.

ContextOutputService keeps one configuration/state/jobs/lazy store/mutation/transition/managed-owner lifetime. Stateless legacy capture and query leaves contain their original algorithms. Public async validation/preparation and caller/query snapshots remain before original run admission. Capture configuration and workspace identity are read at their original expressions and await boundaries. No new store, queue, ACL, retry policy, deep clone or implicit producer recovery was introduced.

The [responsibility map](context-r4a-structure-responsibilities-20261021.md) traces original CX2/S25 paths, current modules/interfaces, sole state, lifecycle/release order and actual consumers/gates. Its scalar capture-port notation is historical and is superseded by the live getter in the [fix delivery](2026-10-21-context-r4a-structure-fix1-delivery.md). Existing earlier S25 moves are not falsely credited as new code here.

Root's independent TypeScript AST census confirms47 scoped maintained product files with no function>=250lines or>=18000characters:

| Responsibility | Before function lines | Accepted function lines |
| --- | ---: | ---: |
| Task registry composition |270|201|
| Context Output service composition |255|176|
| New TaskRecords largest method |—|29|
| New capture algorithm |—|35|
| New search algorithm |—|52|

The201/176 composition facades remain within the facade target and keep necessary shared lifetime/orchestration together. Catalog121, artifact ownership172 and job registry145 have concrete reviewed cohesion exceptions. Catalog work/maps scale with stored sessions and owners and can read owner/legacy/event snapshots; its whole query is not constant-memory/work. Only existing retained-preview/header bounds are claimed.

## P2 discovered and repaired before acceptance

Initial extraction passed options.workspaceId as a scalar before awaiting a producer. BASE read that mutable property twice during later reference construction. A fresh public-entry control held the first producer in an unopened service, changed the same options object from before to after, then resumed. BASE emitted an after reference into the after store and reopened successfully. The initial candidate emitted a before reference into the after store; live read worked, but cold reopen failed with `Invalid context artifact identity`.

The independent reviewer recorded BASE0/candidate1 with identical control/oracles, producer1 and jobs0. Its separate positive used another fresh service, so it did not warm the target store. Root read the full native reports/receipts and approved only the narrow repair: pass `() => options.workspaceId` and invoke it separately at the two original expressions. Options stay mutable and store identity policy is unchanged.

New public tests preserve genuine RED1pass/2fail, identical original-BASE3pass and repaired3pass. They verify the constructor calibration, zero capture workspace reads before producer release, one lazy-store read afterward followed by two distinct reference reads, exact persisted reference/directory, live/cold literal bytes, producer once and joined cleanup. Root and the same reviewer inspected the unchanged test hash and native traces. This also corrects the earlier evidence limitation: body-token equality alone did not establish the argument's evaluation timing.

## Qualification and independent audit

Initial final connected verification passed210 tests/30 current files, comprising194 existing and16 characterization tests, with five type scopes. The same25 adapted fixture tests passed against extracted entries and both byte-exact original registry/service entries. Old durable-child fixtures were adapted to existing coordinator lock/generation ownership; Desktop tests inspect valid successful envelopes and exact complete inline read/Code observations. Original setup/old-format failures remain preserved, and assertions were not replaced with preview substring checks.

After the P2 repair,87 tests/11 affected legacy/service/mixed/integrity files pass, comprising84 prior affected tests and3 new tests; four relevant type scopes pass, including executor's `.mts` configuration. The126 unchanged task/S25 tests reuse their original source-scoped qualification. **No fresh213-test combined run is claimed.** Token equivalence is supplementary to actual public timing/cold-read controls. Seven original result/outbox/persistence/settlement/publication/artifact/job owners remain unchanged.

Root independently audited:

- Initial writer evidence:1432 regular files/33,625,065bytes and24 links; repair evidence:748 files/14,253,339bytes and12 links; independent review control:80 files/953,256bytes and8 links. Exact closures, every recorded size/hash and link identity match without link traversal.
- All164 original encoded artifacts from writer/fix proof bundles,2676 current final source inputs, and38 sequential source-stable writer gate receipts. The only original-source drift is the two declared repair files; their old hashes match immutable reviewer candidate copies.
- Exact210/30,25/25 original/extracted, RED1/2failure, BASE3, fixed3 and affected87/11 collections/native exits plus affected type exits. No competing runtime or blanket suite rerun was needed for this read-only audit.
- Both replayed original entry buffers match the original pre-edit gate's raw-byte hashes; their text matches Git BASE under only its newline convention. Replay is original-entry plus unchanged shared closure, not a full BASE checkout. All seven unchanged owners also match BASE text.
- Twelve saved timing observations, including two original failing and six successful held-producer observations, their actual remaining literal files, unchanged producer/job counts, and five joined mixed-fixture cleanup records. Ordinary process resources are not a universal zero-handle guarantee.
- Independent47file AST census and current size/cohesion constraints.

The original fresh reviewer audited source/callers/tests, S25 mapping and evidence and reproduced the P2. The same reviewer then rechecked the exact repair and reports bounded PASS/P2 closed. Both reports and root audit scripts/results are preserved in [review evidence](context-r4a-structure-review-20261021/README.md).

## Remaining normal graph and scope

Normal reachability retains exit1,399 rows and six findings: ExecFrameRecord, JsonStreamOptions, validResultEnvelope, ExecFrameCaptureOptions, ResultCaptureOptions and createOutputSpillGuard. Output is byte-identical under current versus original-entry replay; new unreferenced leaves remain visible to that lexical comparison, so it is not described as a clean BASE checkout. Actual public imports, unchanged contracts/manifests/lock and affected runtime DAG checks pass. No exemption, reseed, fake consumer or incidental API removal occurred.

The next bounded unit must legitimately narrow unused private exports and retire the inactive registry spill/option path while preserving real shell/native fallback and historical decoding. Final A6 large-data/copied/bundled qualification follows that source stabilization. Original43file credit, whole R4A/A6, R4B semantic seed, R4C durable delivery, R5/R6 and release remain separate; this structural acceptance does not erase them.

## Frozen identities

| Evidence | SHA256 |
| --- | --- |
| Initial writer seal | `6965b347e3eb85580c49097c3dc51c414553236f87f5b65aa6a1a7b14fc24705` |
| Independent reviewer control seal | `027f582f3881152e861cefb27cffc15e7d3a94c799efe36292debb988b06d8d2` |
| Repair seal | `a1a638494fd7568ecb674f1fa8a15b3d8dfc7eea831806cd1428bc107353027c` |
| Repair source inventory | `43e2bc1a8480f5d13c54361382f6aaa7acd62ef6663fdb2aca9de8a52b74b798` |
| Repair handback | `38c51296a9c73ca2948dc3312dfa05734add68dee0598f50e8f209537659108c` |
| Same-reviewer fix report | `d87ad51c2b19da1d6fcf194f14cd7fdc835d9a3d7b4f23527182d436358805de` |

The writer seals cover their recorded evidence/source inventories. External delivery/report/handback identities are recorded separately; do not claim the earlier outer seal already included later external documents. Original failed reports/evidence remain immutable. Encoded portable originals preserve bytes across checkout newline conversion; full raw artifact trees remain in sealed local roots. Copied root audit scripts describe the historical accepted range, not permission to execute old writer runners.
