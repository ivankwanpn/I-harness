# Task2 fix round1 — F1 byte coverage

Frozen fix commit: `ae5fbf63863c5923885964664a88434ffef0254b` (`fix(desktop): verify retained page byte coverage`). Fix BASE: `72e5cfd88635eefa83f440b52fb2a2539ff5f7f4`. Branch remains `codex/v0.1.13-development`, product0.1.13-rc.1, Session10 and decomposition27/43. Git status was clean after commit. No push/merge/tag/release. One writer; no recursive agents. Root owns the same reviewer's scoped re-review and final visual acceptance.

Finding addressed: F1 P2 from `task-2-review.md`, “Reject payloads whose byte coverage disagrees with the returned continuation.” I read the complete review and original probe/logs, then checked the ordinary and exec owners. Original `readArtifactPage` derives positions from consumed encoded bytes but its fresh TextDecoder can omit one leading three-byte UTF-8 BOM on every invocation; the frame owner derives same-record slice progression from consumed raw bytes. Original owners and parser were left unchanged. Reviewer inputs/probes/logs are snapshotted under fresh evidence `review-input/`; original review evidence remains untouched.

Product changes are confined to `packages/desktop/src/renderer/session/result-page-view.ts`. Raw base64 data must cover exactly the declared ordinary-page span through nextOffset or saved EOF. Text must cover that span exactly, with only the explicit additional3-byte allowance for one leading BOM omitted by the original decoder. A same-record exec continuation requires exactly one unfinished frame slice and its decoded raw-byte length must equal the sliceOffset advancement. Existing header normalization, full immutable ref checks and optional verified UTF-8 checks remain.

Tests in `packages/desktop/test/result-pages.test.tsx` now use coherent positions: first14-byte fragment → second15-byte fragment →29-byte saved EOF; the catalog prefix has its actual12-byte retained length; the raw binary fixture has3 retained bytes. Other partial page helper positions derive from encoded payload length rather than unrelated constants. The actual UI malformed-response control now checks short/skipping/empty payloads produce bounded unavailable feedback and no Next action. The new `result-page-view.test.ts` has directly actionable malformed-coverage controls plus genuine owner/BOM/exec positives.

Fresh evidence directory: `.tmp/context-r4a-result-pages-desktop-20261021-fix1/`.

Verification, all sequential with real command exit codes, task-owned empty settings, gate-level IH_CONFIG_DIR before process startup, and complete stable tracked/nonignored-untracked physical-source manifests:

- `red-coverage.json`: expected RED,10 malformed cases failed against BASE; exact binary and genuine original-owner/BOM/exec positives passed.
- `green-coverage.json`:36/36 focused validator/UI/main-runtime controls passed.
- `desktop-types.json`: affected Desktop typecheck passed.
- `focused-final.json`: final36/36 passed across new validator12, existing actual result-page UI23 and actual main/SDK/Gateway integration1.
- `copied-proof.json`: fresh byte-identical copied patched validator accepts all6 genuine original v4 text/JSON/exec pages and4 genuine cold original-owner BOM pages after closing/reopening that owner. It rejects5 malformed coverage cases, accepts exact same-record advancement, and verifies original fixture files unchanged. BOM cases include offsets0/3/6 in BOM+abc+BOM+def and a BOM-only artifact. `copied-proof-results.json` records the actual outputs/omission counts; `owner-fixture-map.json` preserves source fixture identities.
- `fixture-validation-v2.json`: corrected preview's3 normal/6 catalog pages, EOF/restart, literal newlines, exact UTF-8 byte positions and lossless reconstruction pass the freshly copied patched validator. Binary and both exec fixture pages also pass. Detailed cases are `preview-fixture-cases.json`.
- `preview-build.json`: final actual-component preview build passes with the fresh patched validator overlay. All other product/dependency inputs and compiled IH CSS are reused byte-identically from qualified original evidence. The metadata asserts the old validator is absent and the new copied validator is present.
- `staged-whitespace.json` and `fix-commit.json`: staged check and actual commit exited0 with stable physical source manifests.

No full Electron build or broad suite was repeated: only the renderer validation leaf and tests changed; no style, dependency, main/preload, SDK, original owner or codec changed. The prior Electron outputs remain the initial build qualification, with the pre-fix validator in that old renderer bundle. The new preview explicitly bundles the fixed validator and is not claimed to be a rebuilt Electron application. `initial-source-delta.json` proves all other initial source bytes unchanged; the only differences are the validator, corrected UI tests and new focused test file. Final focused/type/copy/preview gates match the final product/test physical bytes exactly.

One fix-evidence setup failure is preserved in `setup-receipts.md` and `audit.failed-setup.mjs`: the first fixture validation helper and its gate shared the filename fixture-validation.json, so the successful gate receipt replaced the helper's detail file. Its original stdout/receipt/manifests are retained. Distinct output `preview-fixture-cases.json` and a fresh fixture-validation-v2 gate resolved the bookkeeping collision; product/fixture runtime was unaffected. No original sealed artifact was changed.

Final fresh development-only preview (stopped) uses the patched copied validator and the corrected small UTF-8 fixtures:

```powershell
Set-Location D:/I-harness-main
node .tmp/context-r4a-result-pages-desktop-20261021-fix1/serve-preview.mjs
```

URL: `http://127.0.0.1:4389/`. Entry `preview.tsx`; fixture helper `fixtures.ts`; copied validator `copy/result-page-view.ts`; build implementation `build-preview.mjs`; immutable output `preview-dist/`. Build/serve do not start installed IH or a visible application window. Chinese/English, light/dark, normal/grouped/nested/Code Mode/history/binary/exec/unavailable and pending scope/ref/capability controls remain. Root reports prior visual-fix1 interactions passed, but this patched final candidate still requires root's smoke and remaining history/Code route inspection.

Audit command: `node .tmp/context-r4a-result-pages-desktop-20261021-fix1/audit.mjs` (read-only without --seal). Original implementation14645-file seal and visual-fix1 32-file seal are reverified unchanged. `original-provenance.json` records the overlay source/copy/hash, prior seals and exact CSS; `preview-inputs.json`, `preview-assets.json`, `preview-metafile.json` record the build graph/output. `final-source-manifest.json`, `initial-source-delta.json` and new `seal.json` bind final physical source and fresh evidence. The audit's initial-source delta intentionally qualifies the one changed validator and its tests instead of claiming old gates ran on patched bytes.

Self-review: F1's four original bad cases now reject, genuine original owner pages and BOM omission remain accepted, original authority/codec/parser/child routes are unchanged. The3-byte text allowance is specifically the original decoder omission, not a generic gap tolerance; storage still authenticates original bytes. Product writes are frozen at the fix commit above for scoped re-review. Prior delivery and seals remain immutable.
