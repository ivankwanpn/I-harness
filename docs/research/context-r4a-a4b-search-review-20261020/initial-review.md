# Task1 independent specification and code-quality review

Review range: `4b0f949c4aa0e44b9061686cdc357dcb39f2218e..d5093c6ab1c7a84d0ca3b665c0499985a3f5217a`, including initial behavior commit `d2b624ed` and model-facing description commit `8f93fc02`. Reviewer: `/root/a4b_search_review_20261020`, GPT6.1Sol. Product writes were frozen. The reviewer wrote only this report and ran no tests, builds, agents, source mutations, or Git/worktree changes.

## Specification verdict

**Needs fixes.** The ordinary tool/code projection, owned derived-cache version change, and READ-07 description follow the assigned Task1 contract. One Important child-result regression prevents acceptance. This regression was mandated by the original READ-02 plan, which incorrectly treated current child aggregate preview fields as historical shadow data. Root identified the real producer mismatch during this review and corrected the current plan through READ-08. The implementation must follow that correction before Task1 can pass.

## Strengths

- `packages/core-session/src/projection/search.ts` uses a small private helper and the existing `stringifyJsonData` owner. Ordinary tool/code inline data preserves payload fields such as `images`, `error`, `ref`, and nested image-shaped data, while separate envelope media, dependencies, and ref descriptors stay outside searchable text. Artifact/unavailable results use stored preview text without an artifact reader or new service.
- `packages/session-query/src/file-backed/schema.ts:4` advances only the derived projection version. The existing database owner checks application ID and future versions before invoking the existing transactional schema owner. There is no new freshness mechanism or Session-format migration.
- The persisted-cache regression retains actual observed revision/fingerprint rows, empties result projection rows under literal version1, and reopens without touching source JSONL. Its assertions distinguish rebuilding from the normal second-search skip. Foreign/future3 controls verify preserved database bytes and sentinel tables, and real SQLite DDL failure checks rollback after an earlier table drop.
- Literal Session8/9 compatibility and rejection of new envelopes in those formats remain separate from current10/future11 controls. The tests assert event identity, sequence, snippet, and unchanged source bytes through actual framed JSONL and the file-backed factory.
- `packages/session-query/src/tools.ts:7` states the inline/preview coverage and missing-hit limitation in the actual model-facing description, while preserving the tool DTO and algorithm. Delivery documentation limits copied-library evidence appropriately.

## Findings

### Critical

None identified within the reviewed Task1 scope.

### Important — current child completion loses searchable text (plan-mandated defect)

**Primary location:** `packages/core-session/src/projection/search.ts:59` (the envelope branch under `subagent/end`). Related regression fixtures: `packages/core-session/test/retained-result-search.test.ts:20` and `packages/session-query/test/filebacked-retained-results.test.ts:25`.

The new branch routes every envelope-bearing child completion through `retainedSearchText`, which reads the envelope preview for artifact/unavailable retention. The actual producer deliberately clears that preview: `packages/subagent/src/task/result.ts:74` explains the single aggregate-preview owner and line76 writes `preview: ''`. `packages/subagent/src/tools/spawn.ts:197` publishes that retained descriptor together with the current `resultText` and `error` fields at lines199–200; its failure/end path does the same at lines249–252. `packages/core-session/src/results/validate.ts:103`–111 explicitly validates these current-format aggregate preview fields and their combined 2048-byte budget.

**Consequence:** retained artifact/unavailable child results produced by the shipping owner now yield empty FTS text even when their bounded `resultText` or `error` contains searchable content. Before this change, the historical selection at least indexed the present result/error preview. The schema2 rebuild can therefore replace existing child preview hits with empty text. Inline child completions also use the wrong representation under the corrected child contract.

The new tests fabricate nonempty envelope previews and label the genuine child preview `LEGACY_SHADOW`, asserting it is excluded. They pass while enforcing the original plan error instead of exercising the real producer boundary. This is a single product defect with a related test-oracle error, rather than a separate unrelated test-quality finding.

**Required correction:** follow root's READ-08: for envelope-bearing `subagent/end`, join both present string `resultText` and `error` fields with a newline, returning empty text when neither exists. Preserve the historical no-envelope fallback. Retain the producer's deliberate empty descriptor preview; do not duplicate preview into it or hydrate result bodies. Establish a genuine RED with an original `TaskResultOwner` instance and the actual settled representation, then exercise framed replay/file-backed search for both bounded fields and absence of descriptor/media/body text. Re-review the same Task1 range plus the corrective commit and its focused evidence.

### Minor

None independently actionable identified within this bounded review.

## Evidence inspected and focused owner checks

The complete supplied 587-line review package was read once in two bounded chunks, along with the Task1 brief, handback, checklist, progress ledger, approved plan, review template, and delivery document contained in the package.

Raw evidence inspected directly:

- `01-core-search-red/raw.txt`: actual 10 behavioral failures/3 passes, including missing tool/code text, envelope/dependency leakage, and the fabricated child oracle. No collection/setup failure was counted as RED.
- `02-filebacked-red/raw.txt`: actual6 failures/13 passes, including the persisted unchanged-source/schema1 miss and schema/rollback discriminators.
- `03-core-search-green/raw.txt` and `04-filebacked-green/raw.txt`:13/13 and19/19 passes for the added projection/file-backed tests.
- `06-session-query-full/raw.txt`:62 tests/7 files pass, including existing query/journal/order/tool/warning owners.
- `17-copy-runtime-wording/raw.txt`:36 tests/5 files pass against copied entries. The copied `artifact-boundary.test.ts` was inspected: an actual1MiB committed artifact contains the body marker, while copied query search finds only the recorded preview and preserves source/artifact bytes.

These passes substantiate their tested cases; they do not cover the real child-producer mismatch above. The handback's assertion of no unresolved Task1 issue is superseded by this finding.

Focused unchanged-owner checks addressed concrete risks only: the existing JSON-data string wrapper for serializer reuse; the database/application-ID/future-version guard and transactional schema reset for rebuild/refusal ownership; and, after root's concrete report, the child settlement, actual spawn event fields, and child preview validator for the shipping representation. One attempted filename lookup for `refresh.ts` found no file; the actual module was identified as `index-refresh.ts`, but its full implementation was not reread because no unresolved refresh-owner concern remained and root requested prompt handback of the confirmed defect.

Root's `task-1-root-verification.json` was read as independent verification evidence:17 sequential stable receipts,2664 final source inputs,923 source/manifest copies,280 internal edges,5 fixtures/16 import rewrites,110 sealed artifacts, and zero verification failures. The reviewer did not repeat source/copy/hash/inventory checks or rerun suites.

## Quality verdict and explicit limits

**Not ready for Task1 acceptance; one Important fix required.** The production change is cohesive and appropriately small. The blocking quality problem is the child fixture's mismatch with the actual producer, reflecting the original plan error. Correcting that consumer branch and replacing the child oracle with real-owner evidence should be kept within this unit.

This is a Task1 review only. Task2 CLI/Desktop presentation, history/export qualification, explicit artifact paging, full-artifact search, Gateway IPC/Electron runtime, live providers/protocols, broader R4A/R4B/C/R5/R6, and release readiness were not reviewed or qualified. Their absence is not a Task1 finding. No independent reviewer runtime execution occurred; runtime conclusions rely on the inspected recorded outputs and root's separately verified provenance. The READ-08 corrective behavior and its real-producer RED/GREEN evidence remain unverified until the writer delivers the scoped fix. Reviewer remains available for that follow-up.
