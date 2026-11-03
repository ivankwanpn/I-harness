# Task1 fix1 scoped independent re-review

**Verdict: accepted within Task1 scope.** The original Important finding, “current child completion loses searchable text (plan-mandated defect),” is **ADDRESSED**. No new actionable breakage was identified in the fix. The original review's Needs fixes verdict is resolved by this correction; this conclusion does not qualify Task2 or broader R4A/release work.

Reviewer: `/root/a4b_search_review_20261020`, GPT6.1Sol. Fix range: `f653b8c1997d3760a8bc2619ed2fa4745ba7d00e..541cd06335db0195b44d76b77de86c1337ca046a`; product fix `42bbaebce6ec0b14ef410511b869cfd4f4043d2c`. The BASE follows the previously reviewed range with root's READ-08 documentation correction. The complete supplied fix package was inspected in bounded chunks; a truncated first tool output was recovered only for the missing initial portion. No Git inspection, tests, builds, agents, product writes, or worktree changes were performed. This report is the reviewer's sole write.

## Disposition of the original finding

| Required correction | Disposition | Review evidence |
| --- | --- | --- |
| Select the actual current child aggregate preview | **ADDRESSED** | The `subagent/end` branch in `packages/core-session/src/projection/search.ts` now filters present strings from `[ev.resultText, ev.error]` and joins them with a newline. It reads neither descriptor preview nor inline child body. Selection does not depend on execution outcome or retention kind. This matches amended READ-08. |
| Preserve absent/empty fields and historical behavior | **ADDRESSED** | No present strings yields empty text. Present empty strings remain in the join. Core tests cover both fields, each field alone, neither field, an empty result, and both empty. The no-envelope `ev.resultText ?? ev.error ?? ""` fallback is unchanged, with a regression assertion retaining first-present behavior. |
| Leave producer/storage authority intact | **ADDRESSED** | The fix package changes only the canonical consumer branch, tests, README, and delivery documentation. TaskResultOwner, capture/store/publication owners, ordinary result helper, derived schema2, and public DTOs are unchanged. No descriptor-preview duplication, body hydration, additional capture, or new service was introduced. |
| Replace the false child oracle with genuine producer evidence | **ADDRESSED** | New `packages/subagent/test/retained-task-search.test.ts` exercises actual TaskRegistry settlement through TaskResultOwner and real capture/store, then records the original settled descriptor and fields through managed F1 and searches via the real file-backed query. It verifies actual `preview:''`, both bounded canonical markers, disposition, and artifact/quota state before search. Four completed/error × artifact/quota cases fail behaviorally on the pre-fix source and pass after the consumer correction. |
| Preserve full original body and revision/refusal checks | **ADDRESSED** | Before explicit reads, the new producer test asserts one capture and zero artifact reads, no body-only/ref FTS hit, and unchanged source bytes/stat. Artifact cases reconstruct the complete original two-field JSON through bounded revision-bound pages and assert exact equality; stale revision is refused. Quota cases refuse body access. The owner/cold controls retain their complete-value and authority assertions. |
| Correct synthetic FTS/cache fixtures and documentation | **ADDRESSED** | Core fixtures separate ordinary envelope selection from child aggregate previews. File-backed fixtures use empty child descriptor preview, independently assert both child markers at seq6, and keep ordinary envelope hits at seq2/4/5. The persisted literal-schema1 test still retains real source revision/fingerprint and unchanged-source skip checks. README explains the child distinction. The original delivery adds a dated correction identifying its false three-case child RED oracle, preserving historical counts and all original evidence. |

## Fix quality and new breakage

The implementation is a small consumer correction aligned with the actual owner contract. The string filter excludes absent fields without dropping empty strings, and the unchanged historical branch preserves existing compatibility. The corrected test oracle deliberately separates bounded current child fields from descriptor content, so the previous mistake would fail directly.

No Critical, Important, or Minor actionable issue was identified in the fix package. No additional runtime discriminator or source-owner expansion was necessary. Previously inspected unchanged owners were not reopened.

## Evidence inspected

Read the fix brief, fix handback, amended READ-02/08, complete fix diff including the new delivery/correction, and root's fix verification report. Direct raw inspection covered:

- `01-child-producer-red/raw.txt`: four real producer cases fail at the FTS hit assertion, returning no canonical result marker. Collection succeeds and prerequisite settled-representation checks occur before the failing assertion.
- `04-child-producer-green/raw.txt`: all four producer cases pass with the full-body and refusal assertions present in the inspected test.
- `05-core-search-results/raw.txt`:37 tests/4 files pass, including18 corrected retained-result search tests.
- `06-session-query-full/raw.txt`:62 tests/7 files pass for actual query/cache/compatibility and existing query owners.
- `07-retained-child-owners/raw.txt`:15 tests/4 files pass, including original complete-body, cold-publication, and negative controls.
- `13-copy-runtime/raw.txt`:37 tests/5 files pass against final copied entries, including actual child-producer4 and cold-publication2 cases.

Root independently verified13 sequential stable receipts,2665 final source inputs,923 copied source/manifests,280 internal edges,5 fixtures/21 mapped edits,77 sealed artifacts, and zero mismatches. The reviewer relied on `task-1-fix1-root-verification.json` for provenance rather than repeating source/hash/copy/inventory checks. The three affected type-check passes are recorded in that verification and the handback; the reviewer did not execute them.

## Out-of-scope observations and limits

The genuine producer test reaches TaskRegistry→TaskResultOwner→actual capture/store→managed F1→file-backed FTS. Its F1 event is assembled from original settled fields using the existing delivery slot; it does not execute the complete spawn/model route. The new delivery report states that boundary accurately, so no wider runtime claim is inferred.

No out-of-scope observation requires action for this fix. Task2 CLI/Desktop presentation and history/export qualification, explicit artifact paging, Gateway IPC/Electron runtime, live providers/protocols, full-artifact search, broader R4A and release readiness remain outside this re-review. The original17 receipts and evidence remain historical artifacts with an explicit child-oracle correction. No reviewer suite was run.

**Task1 review gate may proceed.** There are no unresolved findings from this reviewer within the original Task1 scope plus fix1; root retains integration and continuation ownership.
