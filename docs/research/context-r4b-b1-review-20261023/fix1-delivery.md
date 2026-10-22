# Task1 B1 fix round1 — implementation receipt

Status: seven independent-review findings addressed and committed for the same reviewer's re-review. This is B1 staging; it is **not self-acceptance**, B2/Task2 activation, shipping semantic inheritance or whole-B acceptance. The real fork baseline remains RED.

## Exact source and scope

- Base: `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27` (product `886045296831cb1aea438f4d1a0999dd27efe5d3` plus root rulings).
- Head: `163e0f469fc658ba9ffb0d962f22dc2115b77169`.
- Fix range: `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27..163e0f469fc658ba9ffb0d962f22dc2115b77169`.
- Commit: `fix(core-session): close B1 source and publication boundaries`.
- Tree: `7b7cceef4468e78d142925ffc8871bd4026aabe9`.
- Existing checkout/branch reused: `D:/I-harness-main`, `codex/v0.1.13-development`.
- Commit contains **21 scoped product/test/fixture/tooling files**, 1484 insertions/89 deletions plus the 350731-byte capsule. Root's research decisions, canonical implementation plan and progress docs remain dirty and uncommitted. No other product writer/runtime, agents, live providers/accounts/user sessions, push/merge/tag/release, dependency installation/update, Task2 or decomposition-only work.
- Fresh evidence root: `.tmp/r4b-b1-fix1-20261023/`. `final-manifest.json` records all21 final working-file SHA256s, byte sizes and HEAD Git blob identities,29 retained log hashes, old-report hashes, accepted input identity hashes and capsule hash. Product paths are clean against HEAD after commit. The three root-only documents are the only remaining Git status entries.

Read the fix brief first, then the complete independent review and F4 addendum, original probe receipts and root R-B-16/17. Corrections stay under the existing shape/history/capture/index/JSONL owners. No staging/source capability was added to the public facade.

## Per-finding changes

| Finding | Implemented correction | Maintained behavioral coverage |
| --- | --- | --- |
| F1 — supported10 writable continuation | Add10 to the existing JSONL public upgrade admission; continue through the original header-only `upgradeFactJournal` leaf. No semantic reservation is synthesized. | Extend real predecessor ownership cases from8/9 to8/9/10, including direct upgrade, `ensureWritableFormat`, owned open, metadata fact admission, close/fresh reopen, exact original journal/body/header preservation and unchanged generation/unknown-result observations. Additional actual coordinator metadata upgrade and byte-preserving future/downgrade barriers. |
| F2 — selected text capture | Input, summary and assistant text use the existing renderer `payload`/`readConversationPayload` capture port. Raw rendering keeps its existing ordinary property-read behavior. | Three benign-returning selected text accessors refuse with zero reads; consumed text accessor stays unread; ordinary raw rendering still reads/emits its value. Existing100MiB/envelope/seed/pruned exclusions stay green. |
| F3 — structural metadata descriptors | Package-private `events/conversation-source.ts` checks metadata descriptors before discriminant/seq/readiness/index reads, through `validateSemanticSourceEventShape` in the same owner. It traverses metadata without cloning or stringifying source payloads; text/content/args/output/native slots, inline value/preview and image bodies remain opaque until selected capture. | Actual turn seq/type, step actionId, call identity and nested provenance getters refuse with zero calls; none exits with zero calls; retained source/body/native/media controls remain green. |
| F4 — public publication and birth identity | New narrow strict public `validateSemanticBootstrapHistory` wraps the existing readiness validator, with genuine public JSONL append/replacement consumers before encoding/publication. It does not add legacy cross-event validation or expose staging/source capabilities. JSONL metadata owner checks protected fields by descriptor and strict-data/canonical comparison before merge/serialization. It fences the entire semanticSeed plus R-B-16 birth fields, retains format/journal policy, and does not parse the preserved body for metadata edits. | Exact B1/B2 append and B3 replacement negatives now reject with byte identity; valid ready ordinary append/replacement succeeds. Reservation introduction/removal/digest change, birth field introduction/change/removal and protected slot/nested getters refuse without byte changes/getter calls. Equivalent protected no-op plus title/archive/model/workspace edit preserves the exact torn body. Existing private growing-prefix controls remain green. |
| F5 — atomic memory installation | Preflight ordinary own events/header installation descriptors, pristine/binding/format requirements and events identity before staging; revalidate immediately after `current()` and before the first assignment. Same index owner and post-install observers retained. | Exact readonly-events control now leaves header/events/index untouched; readonly-header also refuses. `current()` changes to events identity/header/binding/writability refuse without bootstrap mutation. Existing bound-empty refusal survives. Observer results are collected and asserted outside swallowed observer exceptions, proving complete3event/2item state on every notification. |
| F6 — catalog cardinality | Shared full/partial codec requires one catalog count per artifact row; distinct uses cannot carry contradictory counts for the same immutable ref. Capture reaches this same invariant and refuses without artifact body reads. | Actual two-result source uses individually valid envelopes: counts1/2 refuse, equal2/2 deduplicate. Independently rehashed malformed full and present-prefix DTOs refuse. Existing result+catalog dual-role fixture remains green. |
| F7 — genuine portable predecessor | Commit a compressed, portable, original-byte graph fixture, strict extractor, Node+existing-tsx runner, provenance/license files and optional sealed-input regeneration tool. Normal tests use only committed fixture/runtime dependencies and fresh temporary roots; no Bun, old evidence, Git history or network input. | Actual old format10 coordinator refuses literal ready/header-only/interrupted11 before repair/upgrade/provider; all input bytes unchanged. Seven strict fixture negatives cover missing/corrupt/file-hash/traversal/duplicate/count/size failures before extraction. Final isolated checkout-like copy with no old evidence/history and empty PATH passes9/9. |

R-B-16 protection is scoped exactly to public writer publication and fixed semantic birth identity. Mutable metadata continues its existing policy; no new bootstrap owner or general backend redesign was introduced. The strict core wrapper has real shipping JSONL consumers and adds no unused-export row.

## RED/GREEN and actual commands

All commands run from `D:/I-harness-main` unless an isolated receipt declares another CWD. Each command completed before the next product command. Vitest suffix `--maxWorkers=1 --minWorkers=1` applies to focused commands; final suites use `--maxWorkers=2 --minWorkers=1`. Every named log below is inside the fresh evidence root.

| Log(s) | Actual command/scope | Exit and source-timed result |
| --- | --- | --- |
| `01-core-boundaries-red.log` | `pnpm --filter @i-harness/core-session exec vitest run test/semantic-seed-boundaries.test.ts --maxWorkers=1 --minWorkers=1` | **1**,15 failures/3 passes against original product, before core corrections; benign getters/partial install/conflicting counts are actual behavioral REDs, not import errors. |
| `02-core-boundaries-green.log` | Same filter/run with `test/semantic-seed-boundaries.test.ts test/semantic-seed.test.ts test/semantic-seed-payload.test.ts test/semantic-seed-replacement.test.ts`, worker1 | **0**,40/40 after F2/F3/F5/F6; before JSONL corrections. |
| `03-public-writers-red.log` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/retained-format-ownership.test.ts test/semantic-publication.test.ts --maxWorkers=1 --minWorkers=1` | **1**,16 failures/31 passes with original writer/migration code and corrected core. Includes three actual10 barriers and public prepublication failures. |
| `04-public-writers-green.log` | Exact preceding command | **0**,47/47 after F1/F4; later explicit removal/metadata negatives are included in final184 suite. |
| `08-predecessor-red-isolated.log`, matching JSON receipt | `node .tmp/r4b-b1-fix1-20261023/isolate.mjs 08-predecessor-red` invokes actual Node/Vitest maintained predecessor test in a copied checkout | **1**,1 passed/1 failed: current reader works, genuine old qualification fails solely on the absent workstation `.tmp/r4hc-02` source map. This proves F7 provisioning failure, not old-reader behavior. |
| `10-predecessor-capsule.log` | `node scripts/test-fixtures/regenerate-format10-predecessor.mjs .tmp/r4hc-02` | **0**, verifies/generates exact177-file graph plus root license; accepted source is read only. |
| `12-portable-predecessor.log` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/format11-predecessor.test.ts test/format10-fixture.test.ts --maxWorkers=1 --minWorkers=1` | **0**,9/9 under Node+tsx, no Bun. |
| `13-predecessor-green-isolated.log`, matching JSON receipt | `node .tmp/r4b-b1-fix1-20261023/isolate.mjs 13-predecessor-green` | **0**,2/2 maintained reader tests in isolated checkout-like copy. |
| `15-core-type.log` | `pnpm --filter @i-harness/core-session typecheck` | **0**, after correcting a test-only SessionHeader type mismatch. |
| `16-core-suite.log` | `pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1` | **0**,**495/495**,45 files; final core product source. |
| `17-context-suite.log` | `pnpm --filter @i-harness/context-engine exec vitest run --maxWorkers=2 --minWorkers=1` | **0**,**74/74**,8 files; final core/context product source. |
| `18-persistence-suite.log` | `pnpm --filter @i-harness/session-persistence exec vitest run --maxWorkers=2 --minWorkers=1` | **1**,**177 passed/1 failed**. Sole required deferred `semantic-fork-baseline` archive assertion still detects CONSUMED-PROOF-ONLY. |
| `19-jsonl-suite.log` | `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run --maxWorkers=2 --minWorkers=1` | **1**,183 passed/1 failed: established format-fence error wording changed by new helper. Corrected the helper to preserve original format/journal errors; no policy relaxation. |
| `20-format-fence-regressions.log` | JSONL focused run `test/context-format.test.ts test/semantic-publication.test.ts`, worker1 | **0**,33/33 after the narrow error-text correction. |
| `21-jsonl-suite-final.log` | Exact full JSONL suite command above | **0**,**184/184**,18 files on final JSONL product source and fixture. |
| `22-core-session-type-final.log` through `25-session-persistence-jsonl-type-final.log` | `pnpm --filter @i-harness/<package> typecheck`, sequentially for core-session, context-engine, session-persistence, session-persistence-jsonl | All **0**. |
| `26-reachability-final.log` | `node scripts/audit/check-reachability.mjs --gate` | **1**,exactly **one NEW row**, disclosed `@i-harness/core-session#exportConversationSeed`. New strict helper is consumed; no exemptions/fake consumers. |
| `27-observer-check-final.log` | Core focused boundary command from01 | **0**,18/18 after test-only observer assertion strengthening. No product change. |
| `28-predecessor-final-isolated.log`, matching JSON receipt | `node .tmp/r4b-b1-fix1-20261023/isolate.mjs 28-predecessor-final` | **0**,**9/9**, actual reader plus strict fixture tests copied from final source. |
| `29-core-observer-type.log` | `pnpm --filter @i-harness/core-session typecheck` | **0**,covers final test-only observer shape. |
| `31-commit.log` | `git commit -m "fix(core-session): close B1 source and publication boundaries"` | **0**,scoped21-file commit above. |

Final source reuse is explicit: core/context/persistence suite results16–18 precede only the narrowly covered JSONL error-message correction and a test-only observer assertion improvement. JSONL final suite21 and four package typechecks22–25 follow that product correction. Focused27/type29 cover the observer-only test change; isolated28 uses final source. No product changes follow these checks. Intermediate dirty iterations were not represented as immutable Git trees; exact final source and logs are bound by the manifest/commit, and earlier RED/GREEN source timing is stated above rather than falsely attributed to HEAD.

### Setup failures kept separate

- Isolated attempts05/07 failed while provisioning ordinary external dependencies (`chokidar/package.json` unavailable at the root; `koffi/package.json` is not an exported subpath). Attempt06 additionally exposed missing ordinary koffi provision in its current-reader case. Provisioning was corrected to use installed dependency entry points;08 then isolates the intended missing old-map failure with the current-reader case passing. Their scratch copies and available logs remain; none is causal old-reader behavior evidence.
- `09-predecessor-capsule.log`: generator syntax typo, exit1 before generation; corrected10 exits0 and verifies all accepted inputs.
- `11-portable-predecessor.log`: Vite's emulated `import.meta` lacks `.resolve`, exit1; corrected the maintained launcher to `createRequire(...).resolve` plus file URL. Twelve/final21/isolated28 genuinely execute the old reader and pass.
- `14-core-type.log`: test-only `SessionHeader` field mismatch, exit1; corrected supported `parentSession` field,15/22/29 pass.
- A read-only combined Git identity query used unquoted PowerShell `HEAD^{tree}` and failed argument parsing. A standalone quoted query succeeded and supplies the tree identity above. No product state or evidence was changed by that administrative failure.

## Capsule and preservation identities

- Genuine pinned product: `678af03dd54659e22dd5f941112c06ec9917e812`, old `CURRENT_FORMAT_VERSION===10` verified by the actual executed old reader.
- Capsule SHA256: `4774a20adf544d4773c57f06cba724a8cfa032c1541b6300727463ed4e5d6e41`.
- Compressed350731 bytes; decoded1162602 bytes; original file bytes860662;177 graph files/10 packages plus original root LICENSE =178 entries. Both original third-party LICENSE files are among the177 unchanged graph entries.
- Accepted inventory SHA256 remains `9fe1227241c1400b82b2dcac6bf4d224e55ed06f212e4568752fa663fef494ba`; map remains `5a3f719a417e0aa279e4a09941a064cc83df247555848e7975ec4cef55d263b7`; seal remains `80b58ae2e74ec03004ab7233e663f3e634f37bbdd007f1ee365173b8c5a99d2b`. Regeneration checked selected files against both inventory and map without rehashing unrelated500MiB evidence.
- Original probe report hashes remain `ddcb8eb4673250640c3c207b10489201ae78faa4ca9830d98534e20a47618a57` and `73894891c6f10ad1766cff7fa861ea9ea3460e97639b3d00a1fb5f466724edff` respectively. Prior scratch roots/logs are unchanged.
- Isolated28 copies only current scoped packages, root package/tsconfig and existing declared external runtime dependencies. It has no `.git`, historical checkout or prior `.tmp` evidence. Child PATH and NODE_PATH are empty (Bun unavailable). Existing installed dependency locations are explicit in the receipt; no install/update/network step occurred. Native koffi is provisioned only as the existing declared Windows ownership dependency for the current reader control.

## Committed files

Core product: `src/conversation/bootstrap-validation.ts`, `render-items.ts`, `seed-codec.ts`, `validation.ts`; `src/events/conversation-source.ts`, `conversation.ts`; `src/index.ts`; `src/managed/memory-bootstrap.ts`. Core regression: `test/semantic-seed-boundaries.test.ts`.

JSONL product: `src/format.ts`, `src/index.ts`. Tests: `test/retained-format-ownership.test.ts`, `semantic-publication.test.ts`, `format11-predecessor.test.ts`, `format10-fixture.test.ts`; helper `test/helpers/format10-predecessor.ts`; fixture `test/fixtures/format10-predecessor/{LICENSE,README.md,graph.json.gz,manifest.json}`. Optional tooling: `scripts/test-fixtures/regenerate-format10-predecessor.mjs`.

## Limits and next gate

Self-review checked scoped ownership, getter-before-read ordering, source payload exclusions, memory installation/observer ordering, strict-public/private-staging separation, catalog consistency and genuine fixture identities. No new unresolved contract gap is known in this fix scope. Independent specification/quality acceptance remains withheld until the same reviewer assesses this exact fix range. Product version stays0.1.13-rc.1. Real semantic fork consumers, dependency transfer/ACL/native/provider behavior, connected100MiB fork-volume qualification and B2/B3 work remain later gates. No whole-repository verify:all was run; the disclosed fork RED and single staged reachability row remain visible.
