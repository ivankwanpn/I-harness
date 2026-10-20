# Mixed retention — final accepted-source rebase

2026-10-21. **PASS: no remaining plan/source blocker.** Pin the next unit's BASE to accepted HEAD **`3a196bbf65c0f3f403ff14ef157c1a1c2725088a`**. Reviewed canonical `docs/research/2026-10-21-context-r4a-result-integrity-acceptance.md` and the amended mixed-retention draft, SHA256 **`86d6546899b2712626e5fc5688af3128628954f994a2a96e7f472105cf169eaf`**. Its five preflight amendments remain applicable and satisfied.

Accepted integrity implementation is `740c515399eebe1c4a27e7367b44ef353b212310`; reviewed range ends `c9f41bd974f8940381d0f04748b19acc8647f4f3`. Its root acceptance/audits establish the preceding unit's qualified results; this read-only rebase does not rerun or independently requalify those gates.

## Exact delta and stable original owners

Read-only Git checks returned the full HEAD above. Comparing native-witness accepted `aa2cadaef61bbf6060de8c95b3782cec30628426` to this HEAD across package/app source found exactly the following three product files. Comparing implementation740c5153 to HEAD across the same source found no further product difference. Working-tree comparison of the inspected product owners and original publication preparer helpers to HEAD also returned no differences.

| Product delta | Consequence for the mixed fixture |
| --- | --- |
| `packages/context-output/src/artifact/ownership.ts` | Authorized reads additionally require actual pin.operationId === operation.owner.operationId. Cold lookup passes root/directory/workspace/operation/id to the original recovery leaf instead of reading an unchecked first record. Real original writers already publish the matching operationId; preserve actual pins rather than manufacturing a fixture pin. Public service APIs used by the plan are unchanged. |
| `packages/context-output/src/artifact/recovery.ts` | Cold lookup now reads one bounded rooted operation snapshot, validates original operation/session/call/workspace-derived directory identity and valid phase/metadata. Only committed phase requires exact ref plus embedded and on-disk canonical manifests and correct dimensions. It remains metadata-only, with no body/index scan, pin creation, live publication retry, scope reconstruction or F1/execution claim. |
| `packages/context-output/src/artifact/reader.ts` | Comment-only correction: a bounded interval may intersect two chunks. No read algorithm, quota, lifecycle or fixture API changed. |

The native/settings/TTL/quota/delete owners inspected during preflight are unchanged: context-output `service.ts`, `store.ts`, `workspace.ts`, `config.ts`, artifact `quota.ts`, `pins.ts`, `writer.ts` and publication sequence; settings `context-subsystems.ts`; Desktop `context-runtime.ts`, `project-scope.ts`, `session-artifacts.ts`; executor `lifecycle/result-store.ts` and `task-result-retention.ts`; persistence coordinator lifecycle and task registry. The original `publication-native.mts`/`publication-fixture.mts` preparers are also unchanged. No new fixture/API repair is needed for this accepted delta.

## Selected first-pin state remains legal

The unchanged original publication sequence writes the manifest, then the first pin/access, then the committed operation (`artifact/recovery.ts:12–33`). A calibrated lost acknowledgement after the native **first-pin** rename therefore still leaves the original staged operation, embedded candidate metadata, on-disk manifest and actual conservative document pin; it is not cold committed. Retire it after the real automatic attempt/callback settles, with no parked mutate or second retention retry, as the amended plan requires.

The accepted cold validator's common checks accept that authentic original owner/id/codec/count. Its manifest/ref commitment checks are gated on phase committed (`recovery.ts:65–74`), while valid capturing/staged return recovery-required (`:76`). A staged candidate is not accidentally promoted by the presence of its real manifest or pin. After confirmed document deletion, that document's pin can be released while unchanged staged storage remains conservative; cold metadata lookup does not require a live profile/pin to return recovery-required or recreate either.

Refused remains a distinct truthful state: valid recorded reason/count return refusal before committed-manifest validation (`recovery.ts:59–61`). It may retain earlier ref/manifest metadata after a genuine staged-to-deleted refusal. The canonical acceptance explicitly preserves this authentic case; the new `cold-lookup-integrity.test.ts` contains its original cold-phase control. Do not impose a “refused must have no old metadata” fixture rule or treat a refusal as the chosen staged example.

Committed metadata may remain a valid receipt with missing body/index, while actual pages refuse; this accepted distinction does not relax the mixed plan's physical inventory/read checks. Neither cold committed receipt nor staged preservation certifies task/F1 success or current source permission.

## Ready bounded scope

The saved/native composition remains correct: real canonical location and loader, normalized saved maxDiskBytes >=65536, supplied service/sourceFor, explicit native-runtime retirement despite no-op supplied lease, and freshly confirmed project roots. Legacy full/partial/none, expiry filtering versus actual prune triggers, opened/unopened quota-lowering branches, funded index rebuild success and underfunded preflight preservation remain unchanged. The actual native deletion subscription must stay alive through coordinator acknowledgement and task-document identity must match the actual stateId.

The required mixed-admission concurrency control is still **qualification of a source hypothesis**. Acceptance of cold integrity did not repair or establish a shared legacy/managed admission race. Keep the fixed-budget calibrated native schedule, sampled-peak limitation, protected-file/outcome invariants and root pre-repair checkpoint. Reuse accepted integrity/pin/catalog/publication evidence rather than repeating its matrices.

Root may promote this plan with BASE3a196bbf and dispatch the fresh sole writer. Scope remains mixed legacy/managed physical quota, saved overrides, TTL/scoped/global clear, derived-index lifecycle and only the missing denial/deletion composition. Scale/copied/packaged flows, whole R4A, R4B/C, R5/R6 and publication remain outside it. Product0.1.13-rc.1, Session10 and decomposition27/43 are unchanged.

Only this requested rebase note was written. No tests/runtime/product processes, product/test/evidence changes, Git mutation or new agents were used. No mixed-retention defect is claimed as reproduced by this review.
