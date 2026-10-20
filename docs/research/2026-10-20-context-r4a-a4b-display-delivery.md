# R4A A4b Task2 — retained result display delivery

Date: 2026-10-20. Branch: `codex/v0.1.13-development`. Workspace: `D:/I-harness-main`.

BASE: `43e829a4d08ba54f2264bece3b827bf28be44ed6`.
Product HEAD: `368d18faca15d16204d1d063d7e704fe3ae75a1e` (implementation `698c26a4e2b7e4f05ce1b98fe2c52e27b3666b9d`, then one EOF blank-line cleanup).

Task2 is implemented and handed back for root visual inspection and independent review. This report does not accept the task on the reviewer's behalf or complete R4A. Task1 search acceptance through42bbaebc is preserved.

## Responsibilities before and after

| Owner | Before | Delivered responsibility |
| --- | --- | --- |
| CLI `sessions.ts` | Compact transcript read only legacy `output`, so new results printed empty lines. | Existing tool/result selection reads inline value or stored preview, with trusted outcome, dispatch and retention inside the original200-character summary bound. JSON export remains structural. No artifact body is read. |
| Desktop `project.ts` | Both matched/standalone ordinary and nested result folds discarded envelope. | SDK-union-derived alias and distinct envelope member, carried in the original row. Selecting a retained result clears obsolete legacy output/isError. Group identities/order are preserved. |
| Timeline / ActivityGroup / ToolActivity | Both renderer routes received only legacy raw output. | Both routes carry envelope into the real ToolActivity→RecordedToolOutput chain. `toolState` has the optional final envelope argument; trusted outcome determines received/failed/cancelled/unknown. Dispatch remains separate metadata. |
| Work stages | Legacy raw error/exitCode inference could miss retained failures or misread data. | New envelopes mark an incomplete stage only for trusted `failed`; legacy inference stays in its own branch. Quota refusal cannot rewrite execution. |
| Recorded output | Existing rich command/file/search/web/MCP recognizers and raw disclosure. | Private body helper retains those recognizers and original inline raw disclosure. Narrow `RecordedResultEnvelope` renders inline value, or stored preview/ref/codec/completeness/reason plus descriptor-only dependencies. The existing image implementation moves intact into the leaf and is re-exported at its old import site, avoiding a circular import. Native media remains ordered and renders once. Payload fields called images/error/status remain original data. |
| Code output activity | Retained artifact wording claimed complete source unconditionally and omitted native media. | Uses the same leaf and honest completeness/media presentation; original legacy code/text/image/audio readers remain. |
| Native search factory (READ-09) | Returned its own typed canceled/error/timeout status without declaring outcome; generic registry default recorded succeeded. | Original `createFsSearchTools.execute` declares from its closed SearchResult status through the existing genuine-producer API. Returned values, bytes, limits and search algorithm are preserved. Direct unregistered factory calls remain compatible. |
| Context browser boundary (READ-10) | SDK/context imported the Node-heavy core barrel; even context-state→events/context imported generation/soft-reduction runtime. Actual renderer build failed at managed/capture's node:util import. | Original scalar definitions/validators move to one narrow leaf; Node event dispatcher imports and re-exports the same functions. New public core-session/context exposes the existing browser-safe decoder, consumed by SDK/context. Existing public root names remain compatible. No Node shim, private cross-package renderer import or duplicate validator. |

READ-09 and READ-10 are root-approved necessary expansions discovered by genuine gates. Other producer outcomes, artifact-page APIs, SDK reader methods, bridge routes, version/decomposition changes and release qualification remain outside this unit.

## Verification and exact source timing

Evidence root: `.tmp/context-r4a-a4b-display-20261020-implementation/`.
Each numbered receipt retains command/cwd/times/HEAD, complete stdout/stderr, git status and SHA256 manifests over tracked/untracked package/app/script/config/root inputs. All57 receipts have identical before/after source manifests and nonoverlapping execution times. Failures and setup errors are retained and classified in `failure-dispositions.json` and `setup-errors.md`; they are not relabelled as successful tests.

| Gate | Result | Receipt / source timing |
| --- | --- | --- |
| Actual Desktop new display RED |7 failed before behavior edits: missing inline/media/status/preview/fold behavior |01;04 repeats the valid-fixture baseline after an editing-script parse error |
| Actual CLI command RED | Corrected valid format10 snapshot printed three empty result summaries |03; invalid initial fixture02 preserved |
| Final Desktop result/legacy/timeline/context UI |143 passed /12 files |39; after all semantic product edits. Only trailing blank-line cleanup follows. |
| Sealed retained display |11 passed |55 at product HEAD368d18fa |
| Final CLI |17 passed |40; exact200-character limit, complete structural descriptors and unchanged JSONL bytes |
| Real search-code-mode representation migration |4 passed |18, after READ-09; keeps240matches,262144limit, guest10line2 references, unselected body absent from model messages, canceled/partial, exactly one result, drained work and no glob/RESURRECTED. Original timeouts unchanged. |
| Native search factory and engine suite |51 passed /5 files |21; five genuine factory/registry mappings plus existing engine/bounded/search suites; before READ-10's identical scalar extraction |
| Core context owners |33 passed /4 files |37; request identity, admission observation, recovery and reduction capture |
| SDK context owners |8 passed /3 files |38; actual browser bundle, cold history and existing child authority/measurement controls |
| Gateway cold readers |5 passed |12 source; also in final copied53 |
| Types | All seven affected packages pass |41 core-session,42 SDK,43 Desktop,45 CLI,46 executor,47 fs-search,48 Gateway; after all semantic edits |
| Actual Electron build | Pass:442 main modules,2 preload modules,2047 renderer modules |36 and sealed56. Earlier failures15/20/34 remain preserved. No installed application launch. |
| Sealed actual-component preview | Pass:1602 modules,304.21KB JS,83.51KB CSS |57; actual IH components and CSS |
| Final copied / bundled consumers |30 passed /5 files |53; Gateway cold readers, SDK cold/context/child authority/browser entry and bundled CLI command |
| Original scalar declaration move |15 declarations identical after export-modifier and CRLF/LF normalization; decoder changed only its import |49 / `context-scalar-move.json`; checker44's line-ending setup failure preserved |

The57-source manifest has2,671 inputs and SHA256 `bf31c5358225fabb9a4a94096a91f4bb91b921bf6a92b028c5be193da07c0156`. Full suites were not rerun solely for an EOF blank-line deletion: sealed display11 and actual renderer/preview builds were rerun at the final product HEAD. The final copy includes all semantic changes; its product inputs are unchanged by that Desktop-only blank-line deletion.

## Genuine defects and setup failures

- Original search representation failures07 are preserved. Full retained-value tests use the actual inline value or bounded ContextOutput readResult pages, verify encoded byte count and SHA256, and never substitute preview. Two successful full240match traces in08 exposed the Stop outcome defect. Corrected fixture10 reaches the final outcome assertion only after all original canceled/partial/drain/no-follow-on checks pass; both fail succeeded versus canceled. READ-09 fixes the original native search factory, not generic finalization or display inference. Factory RED17 independently fails canceled/error/timeout mappings, with completed/limited controls already passing despite an ordinary error-named field.
- Actual renderer15 and exactBASE Desktop source overlay20 fail at `packages/core-session/src/managed/capture.ts:2`: node:util `types` is not exported by Vite's browser external module. The graph records ContextUsage→SDK/context→core-session barrel→Node capture. Overlay20 loads all nine changed Desktop modules directly from BASE in memory, without switching or modifying checkout; it is a source replay, not an old installed process. The standalone actual SDK browser bundle34 also fails four Node imports. READ-10 makes both real builds pass.
- SDK broader context gate35 exposed two old child-context `.output` assertions. Both now inspect complete inline retention values, retaining exact authority/error/component measurements and adding trusted outcome checks. No owner behavior was changed for those tests.
- Setup-only failures02,09,13,19,32,44 and intermediate text-query/wording assertions05/06 are individually described in failure-dispositions.json. Two editing-script parse errors were transcribed from the tool transcript into setup-errors.md; the failed scripts performed no writes at their parse sites.

## Source, copy and artifact map

- Final Gateway build50: `.tmp/context-r4a-a4b-display-20261020-implementation/gateway-copy-final/`,242 shipped packages. `copied-qa-final-before.json` records1,003 exact workspace source/manifest copies,280 dependency edges that resolve inside the copy,6 QA fixture sources and36 import/actual-browser-entry literal rewrites. The original SDK history fallback is unchanged.
- Final CLI bundle51: `cli-consumer-final.mjs` plus source map. `cli-bundle-final-inputs.json` records137 raw source inputs and the bundler metafile. Copied CLI tests import this bundle while fixture persistence imports resolve to the final copy.
- Actual Electron build56 outputs were copied byte-for-byte into `actual-electron-build/`; `actual-electron-build-map.json` records all7 source/output copies. This is a renderer/main/preload build, not installer or release qualification. No attachment-helper build is claimed.
- Controlled preview57: `preview-dist-sealed/`; `preview-bundle-sealed-inputs.json` records22 actual Desktop source inputs with original-byte and transformed-code hashes. The CSS and preview are task-local. Full product event bridge execution is covered by component/history fixtures, not by a running installed application.
- `seal.json` validates all57 receipt manifests, final current sources, final copied source/QA maps, bundled CLI inputs, preview inputs and the7 built-output copies. `inventory.json` hashes352 evidence artifacts, digest `a9c42e5a49046e5c3119dbdcc1b1539fdcaf95b0d971da2f7ef78a7406b88abc`. Large initial/final third-party runtime trees are excluded from that inventory; their workspace-owned source/manifest copies and internal dependency resolution are independently validated by the map. This is not a checksum claim for every third-party vendor byte.

## Root visual inspection

Launch from any directory using the repository Node24 runtime:

```powershell
& 'C:/Program Files/nodejs/node.exe' 'D:/I-harness-main/.tmp/context-r4a-a4b-display-20261020-implementation/serve-preview-sealed.mjs'
```

Open `http://127.0.0.1:47832`. The loopback server serves static task files only. It has not been started by this writer. Preview source is `preview/main.tsx`; build command is `node .tmp/context-r4a-a4b-display-20261020-implementation/build-sealed-preview.mjs` from repository root. Examples show successful inline error-named data, failed/source-limited artifact, successful quota-unavailable retention, unknown/not-dispatched and two ordered native media items. Chinese/English controls use the actual UI store and existing text hooks. Root visual acceptance remains pending.

## Scope and handback

All fixtures were offline and isolated. No live user profile, provider/account request, auth refresh, child adoption, checkout change, reset/clean, push, merge, publishing, installed-IH change, version change or decomposition-count edit occurred. No artifact paging or new SDK reader method was added. The next authorized reader unit and further producer outcome audit remain root-owned continuation.

`residual-processes-final.json` is an empty array: no task-labelled Node/Vitest/server process remains. Product writes stop at this handback. Root owns independent review and visual acceptance, then continuous execution of the approved next unit.
