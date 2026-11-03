# R1C immutable request snapshot verification

The combined R1C delivery is based on `910da9a9bb1862fe4ef68d3c5afbb905ee5a8963` and ends at `dcaff3517dd64c8d2b6f2f4908405f7e3cb4797b`. It contains initial implementation37beba43, historical-read latch06079a1e and scoped review correctionsdcaff351. Product remains0.1.13-rc.1; this is a focused gate, not release qualification.

## Actual behavior

- New context-engine snapshot capture owns supported JSON/native/image data. Core-session remains the only conversation fold. Actual main/child preparation uses that captured request surface, with fresh identity comparisons after awaits and before transport.
- Archive cursor, semantic input, protection, branch, rewrite lineage and request surface identities have separate meanings. Pending input or uncertain tool effects can invalidate a candidate without changing its text. Current input/images stay protected without protecting every completed exchange in a long turn.
- Captured request metadata attributes actual usage. Measured input identity remains fixed after output; post-response observation is separate. Historical live/cold measurements remain readable with unavailable admission when stale. A read cannot regain fit just because a prior surface value is restored.
- Cold reads use pure context/metadata ports and never initialize models, authentication or preparation. Deep supported data uses shared stack-based traversals in actual request consumers; unsupported non-JSON embeddings still fail before prepare.

## Independent review and correction

The fresh task review found two Important issues after the initial533-scenario focused gate. Both were reproduced, fixed and passed scoped re-review:

1. A structurally closed exchange could acquire contradictory dispatch evidence and an unknown outcome without changing freshness identity. Pending/unknown reported effects now contribute to protection identity even when the group is closed. Explicit and legacy controls invalidate the actual candidate comparator; ordinary settled closed successes remain eligible.
2. A deep snapshot could pass capture but fail later in actual neutral request fingerprinting or recursive prefix telemetry. Shared serialization/copy primitives now reach the exercised model call and finalization paths. Ordinary v1 numeric-key/undefined/Unicode bytes and the distinct lexical canonical mode have independent literal oracles.

The final reviewer found no new Critical/Important direct regression. It did not rerun suites or duplicate the broad review. Deep neutral requests at2000/6000 levels exercise args/schema/results, telemetry, reads and follow-up. A controlled actual Anthropic prepared/cap-derived HTTP path at6000 levels also completes; it is stubbed transport, not live provider acceptance. The packaged Gateway independently reaches the two corrected behaviors.

## Recorded final evidence

The affected fix scopes cover **746 distinct passing scenarios**; this overlaps the earlier533 and must not be added to it.

| Scope | Passing |
| --- | ---: |
| core-session including encoding follow-up | 213 |
| context-engine | 33 |
| token-meter | 41 |
| llm-seam | 108 |
| core-agent selected request/lifecycle scopes | 123 |
| session-executor cold/inherited | 17 |
| SDK / Gateway selected observations | 4 / 1 |
| subagent selected consumers | 71 |
| Anthropic adapter | 78 |
| Six-route controlled corpus | 57 |

Ten package typechecks and e2e typecheck exited0. Reachability remains exactly408 rows with digest `6af28bcbcb72706b3184f9b55025616f2e5c0358393538dce578312eb566eab4`; audit self-tests82/82, no baseline/allowlist/owner-map changes. The manifest graph has82 packages, all application-reachable, with zero cycles.

Fresh phase-owned artifacts `.tmp/context-r1c-fix1-gateway` and `.tmp/context-r1c-fix1-cli` passed build and import/smoke checks. Gateway uses its own copied runtime; CLI verifies SDK initialize and confinement smoke. Earlier artifacts were preserved. New responsibility modules are small; the service context reader was extracted, but its entire S20 lifecycle decomposition is still outstanding.

## Limits retained

The actual pre-edit baselines were agent17passed/5failed and executor8passed/5failed around retained historical readings. All failures, RED controls, invalid intermediate fixtures and successful successors remain recorded. No later pass is mislabeled as a green baseline. R1B's missing separate pre-edit JSONL baseline remains disclosed.

Existing CLI warnings about36 dynamic TypeScript imports, optional platform dependencies, fixture diagnostics, inert audit warning and newline notices remain. A blocked cleanup/rebuild attempt was safely replaced with new output directories; no permission request or deletion workaround was needed.

Neutral and one Anthropic depth control do not certify arbitrary depth, other native/binary routes, every provider serializer, deep JSONL persistence or the separate summary path. Those named boundaries remain integrated R2–R6 qualification work. The >100MiB corpus still measures an in-memory JSONL-equivalent projection, not cold disk recovery. No live provider/account/installed application operation occurred.

The earlier whole `verify:all` FAILED/incomplete result is unchanged. R1D with durable publication, R2 policy, R3 transactions/attempts, R4 artifacts/delivery and R5/R6 remain outstanding. Original decomposition completion remains27/43; this report does not count partial S20/CX work as complete.

Local evidence is retained under `.superpowers/sdd/2026-10-16-context-engine-r1-snapshot/`: original and fix reports, original/scoped review, exact command/exit receipts, RED controls, size/graph/audit arrays and isolated package logs. See the [execution plan](../superpowers/plans/2026-10-16-context-engine-r1-snapshot.md) for scope.
