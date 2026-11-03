# R4A explicit result pages — Desktop Task2 acceptance

Root accepts the connected Desktop Task2 range from `7a09dafda11bdc15293bdf93bfdcc5b72a65f827` through `ae5fbf63863c5923885964664a88434ffef0254b` after independent GPT6.1Sol review, one product fix round, source/copy/evidence audits and actual browser interaction with the development previews. This is acceptance of this coherent unit, not whole R4A or release readiness.

Product remains **0.1.13-rc.1**, Session format **10**, and original decomposition progress **27/43**. Broad event-runtime, instruction-context and decomposition work remains paused. No push, merge, tag, release, installed IH launch or live provider/account operation occurred.

## Accepted changes and ownership

- `72e5cfd88635eefa83f440b52fb2a2539ff5f7f4`: original Desktop main/IPC request validates the canonical query before a workspace resolver can start Gateway; the existing sender/known-workspace checks and real capability gate remain. SDK/server re-exports the original parser for this actual main consumer.
- Existing ordinary, grouped, nested, Code Mode and history cards receive a reader bound to their actual workspace/session. The original child pager retains its distinct parent/lineage/revision authority. No reader is persisted in a row.
- Reading is explicit and keeps one current page. Primary output and dependency catalog share the viewer; switching clears it without fetching. Full immutable ref, scope, target, capability loss and component lifetime invalidate pending responses. Catalog JSON is shown as fragments, not followed or interpreted as permission.
- `ae5fbf63863c5923885964664a88434ffef0254b`: returned ordinary payload bytes must match continuation/EOF coverage, except for the original decoder's single omitted UTF-8 BOM. Same-record exec continuation must match one unfinished slice's decoded byte length. The original store/codec/authorization contract was unchanged.
- IH's existing disclosure, OutputBlock, controls, theme and localized labels are reused. Saved EOF remains distinct from complete source capture. Model-tool guidance preserves the full exec cursor, including sliceOffset.

## Independent review and concrete fixes

The [initial review](context-r4a-result-pages-desktop-review-20261021/review.md) identified F1: the renderer could accept a three-byte payload with a much larger next offset or false EOF, or an exec cursor that skipped bytes in the same record. The defect was at the presentation validation boundary; the review did not show the original storage owner producing malformed pages.

The writer reproduced ten malformed cases before changing the validator. The fix preserves genuine text decoder behavior: a page can consume a leading three-byte BOM that does not appear in returned text. Both interior BOMs and a BOM-only artifact are covered using the genuine owner. Exact base64 coverage and same-record exec advancement now reject the demonstrated gaps.

Root read the complete initial and [scoped fix review](context-r4a-result-pages-desktop-review-20261021/fix1-review.md). F1 is addressed; scoped spec and quality verdicts are PASS, with no remaining actionable product finding.

## Qualification and source time

| Evidence | Observed result and boundary |
| --- | --- |
| Initial affected Desktop controls | 127/127 across 9 files; actual Workbench, main/SDK/Gateway, ordinary/grouped/nested/code/history and original child-pager paths |
| Original SDK/CLI, Gateway and codec controls | 2/2, 6/6, 2/2; Desktop and SDK typechecks passed |
| Initial real Electron build |Main/preload/renderer and attachment helper built; existing chokidar unused-import warning retained |
| Copied source runtime |Real IPC registration source→HarnessClient→fresh Gateway→original cold reader; genuine text/JSON and exact exec slice/EOF binary bytes, hidden/forged refusals and no execution notifications |
| F1 final focused controls | 36/36 across new validator 12, UI 23 and actual main/SDK/Gateway 1; Desktop typecheck passed |
| F1 copied validator | Accepts 6 genuine original pages plus 4 cold original-owner BOM pages, rejects malformed coverage and preserves exact exec continuation |
| Final browser candidate |Fresh bundle contains patched validator overlay with unchanged qualified components/dependencies and byte-identical compiled IH CSS |

The [initial delivery](2026-10-21-context-r4a-result-pages-desktop-delivery.md) remains immutable. Initial gates ran before the later delivery-document bytes; root independently confirmed only documentation differed at that handback. F1 changes exactly one product validation leaf, one existing test and one new test; all other initial source bytes remain identical.

The initial Electron renderer bundle contains the pre-fix validator. It is initial build qualification, not a rebuilt current Electron application. Final validation is covered by the affected type/focused/copy gates and the fresh browser bundle with the patched validator. No current compiled Electron startup or release artifact is claimed. Final packaged coverage remains A6/R6.

Root independently checked:

- Initial 3,424 source files, 14,645 sealed evidence files, 20 stable sequential recorded gates and 10 qualifying gates.
- 341 copied package manifests, 14,132 copied payloads, 326 actual internal dependency resolutions, 223 compiled Desktop outputs and 1,854 original preview inputs.
- Original native qualification and generated WSL manifest provenance.
- Final 3,425 source files, exact three-file F1 delta, 106 new sealed evidence files, 10 stable sequential fix runs and 5 qualifying runs.
- Both prior seals unchanged; 14,783 sealed files verified across original, visual correction and F1 evidence. The final preview's 1,855 inputs include the patched validator and exclude the old one.

Portable root audit outputs: [initial](context-r4a-result-pages-desktop-review-20261021/root-verification.json) and [F1](context-r4a-result-pages-desktop-review-20261021/root-fix1-verification.json). Both have zero failures. Full raw receipts, candidates, fixtures and manifests remain in the task-owned `.tmp/context-r4a-result-pages-desktop-20261021-{implementation,visual-fix1,fix1}/` directories.

## Actual visual inspection and its limits

Root used Cua with hidden local browser tabs, not an installed IH process. These pages are development harnesses rendering actual copied product components. Their header, language/theme selectors and fixture controls are test-only and are not added as a product page.

The initial v2 preview failed on its first normal page because the fixture counted UTF-16 characters as UTF-8 bytes:7000 characters contained7001 bytes. The product correctly refused it. The [original failure screenshot](context-r4a-result-pages-desktop-review-20261021/visual/preview-v2-first-page-failure.jpg) and sealed evidence were preserved. A separate visual-fix1 uses byte positions, valid UTF-8 boundaries, literal newlines and small pages; it did not weaken the validator.

Root then inspected normal first/next/restart, partial saved EOF, primary/catalog switching without automatic requests, Chinese/dark and English/light labels/layout, delayed session and immutable digest replacement, capability removal/re-enable, and ordered exec raw bytes/optional UTF-8. The final patched candidate additionally passed normal continuation and real Code Mode/history component read actions. No stale data/error reappeared in the manually checked scope transitions.

Representative evidence:

- [Final Code Mode card](context-r4a-result-pages-desktop-review-20261021/visual/final-zh-dark-code-page.jpg).
- [Final history card](context-r4a-result-pages-desktop-review-20261021/visual/final-zh-dark-history-body.jpg).
- [English/light catalog](context-r4a-result-pages-desktop-review-20261021/visual/visual-fix1-en-light-catalog.jpg), from unchanged components/styles before the validator-only fix.
- [Ordered exec bytes](context-r4a-result-pages-desktop-review-20261021/visual/visual-fix1-en-light-exec-bytes.jpg), with invalid UTF-8 bytes left as base64.

All three root preview helpers were deliberately stopped and all created tabs closed. An attempt to run visual-fix1's clean-working-tree audit during the intentional F1 writer WIP failed that verifier precondition; it was not a product test or integrity failure. Root preserved this distinction and did not overwrite old evidence.

## Remaining work and rulings

R4A still needs the original retained-result process-crash, publication/pin/catalog/quota/integrity matrices and A6 scale/packaged qualification before whole-range acceptance. R4B semantic seed, R4C delivery/wake, R5 observation and R6 large-history work remain. No unrelated decomposition item is marked complete by these UI leaves.

Ruling: treat the malformed visual fixture as an evidence defect and preserve it; use a separate corrected candidate rather than weakening product validation. If wrong, the UI might remain unqualified; actual successful final-candidate interaction and independent source review now close that risk.

Ruling: preserve the original decoder's single-BOM omission rather than demanding impossible raw-text equality or changing the storage codec. The page DTO lacks an explicit BOM flag, so presentation validation can only bound this allowance; authenticated storage remains the byte authority.

Ruling: retain initial Electron build qualification with its exact pre-fix source identity, and qualify the final leaf through focused/type/copy/browser gates. This is not a release artifact; a later packaged validation must rebuild the current source.
