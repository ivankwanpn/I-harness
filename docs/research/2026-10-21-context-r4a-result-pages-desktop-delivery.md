# R4A Task 2 — Desktop explicit retained pages

Task 2 implementation is ready for independent review against accepted Task 1 BASE `7a09dafda11bdc15293bdf93bfdcc5b72a65f827` on `codex/v0.1.13-development`. Product remains `0.1.13-rc.1`, Session10 and decomposition27/43. Root owns acceptance and visual inspection after this handback. No push, merge, tag, release or installed application launch occurred.

## Delivered behavior

The original Desktop request channel now accepts `session/result/read` with workspace/session and the original SDK query. A small main leaf consumes Task 1's canonical strict parser, publicly re-exported through Node-only `@i-harness/sdk/server`. Full query validation happens before the known-workspace runtime resolver, which can launch Gateway. The existing global sender check remains authoritative. Main requires the original `session-result-read:["1"]` capability and forwards the original SDK method and unwrapped page DTO.

Workbench constructs stable readers from its existing selected-workspace capability snapshot and the displayed session. The reader passes through normal and grouped Timeline activities, nested tools, Code Mode output and the separate history Timeline. History retains the existing app selection match guard and additionally checks the reader's workspace/session against its displayed selection. The reader is a presentation callback and never enters durable row data or the private legacy output-body spread.

Each retained envelope has one explicit page viewer for either its primary artifact or its dependency catalog. Opening a disclosure does not read a page. First, next and restart requests use `maxBytes:16384`. Only the current page is kept; switching targets resets it without fetching. Catalog fragments remain encoded source material and do not grant or follow references. JSON/text pages remain fragments, bytes remain exact labeled base64, and exec frames preserve channel/frame/offset order, raw bytes and optional verified UTF-8 views. Exec starts without a supplied cursor and accepts the owner's legitimate `{recordOffset:9,sliceOffset:0}` header normalization; continuation preserves the entire `nextCursor`.

Page identity includes workspace/session, selected target and every immutable ref field. Component replacement, capability removal and unmount invalidate pending generations. Late fulfillment and rejection cannot publish into another scope. Returned full ref, codec-specific positions, advancing cursors, page budget, frame shape and verified text are checked before display. Errors are bounded localized feedback. EOF means the end of saved content and does not upgrade partial source completeness.

`RetainedChildBody` and `SubagentPane` retain their original parent/lineage/resultRevision route. The model-facing `context_output_read` description now distinguishes JSON/text `nextOffset` from the entire exec `nextCursor`, including `sliceOffset`; query/schema behavior is unchanged.

## Verification and exact limits

Evidence root: `.tmp/context-r4a-result-pages-desktop-20261021-implementation/`. Every gate captures the real command exit status, stdout/stderr, isolated `IH_CONFIG_DIR` established before subprocess imports, a task-owned empty settings file, and complete before/after tracked plus nonignored untracked physical-file SHA-256 manifests. All recorded gate manifests were stable during their commands. The final documentation addition is separately compared with those source-time manifests; these gates are not claimed to have run on documentation bytes created afterward.

| Gate receipt | Result |
| --- | --- |
| `red-desktop.json` | Expected RED: 18 missing-feature failures, 25 existing checks passed |
| `green-desktop.json` | Initial main/UI GREEN: 43 tests passed |
| `desktop-controls.json` | Expanded actual main/UI/history/child controls: 104 passed |
| `desktop-types.json` | Preserved failure: two new test-fixture inference errors |
| `desktop-types-fixed.json` | Desktop types passed after fixture annotations |
| `sdk-controls.json` | Actual SDK/client and CLI cold read controls: 2 passed |
| `gateway-controls.json` | Original Gateway visibility/source/fence controls: 6 passed |
| `context-controls.json` | Original codec/model compatibility controls: 2 passed |
| `sdk-types.json` | SDK types passed |
| `desktop-build.json` | Real Electron main, preload and renderer plus attachment helper built |
| `runtime-build.json` | Fresh shipping Gateway runtime copy built, 242 base packages |
| `candidate-prepare.json` | Preserved preview setup failure: JSX runtime and raw Tailwind imports |
| `preview-build.json` | Actual-component preview built using the exact real Electron compiled IH CSS |
| `copied-runtime-proof.json` | Preserved fixture setup failure: one original writer input exceeded its 64KiB chunk limit |
| `copied-runtime-proof-v2.json` | Preserved fixture expectation failure: invalid UTF-8 committed under a text codec is unavailable, not a binary text page |
| `copied-runtime-proof-v3.json` | Copied actual IPC registration → SDK client → fresh Gateway → original cold owner proof passed |
| `copied-runtime-proof-v4.json` | Narrow copied fixture refinement: genuine exec continuation reaches saved EOF with exact binary frame bytes and no invented UTF-8 view |
| `desktop-final-controls.json` | Final affected Desktop tests, including original Workbench and SubagentPane: 127 passed across 9 files |

The copied proof uses byte-identical copied Desktop IPC/main sources and actual HarnessClient/Gateway source adapters under Node/tsx. It proves canonical parser function identity, sender/preflight/known-workspace ordering, genuine original committed refs, text/JSON page advancement, exec header/slice continuation, hidden pinned caller and forged-ref refusal, and no changes to original fixture files. It observes only `initialize` and `session/result/read` RPCs and zero execution event notifications. The copied renderer validator accepts the genuine text/JSON/exec pages. The v4 final exec page reaches saved EOF and asserts exact `/wAA` binary bytes without an invented UTF-8 view. The synthetic binary DTO is separately exercised in UI controls/preview; invalid binary bytes labeled as text are correctly unavailable in the original runtime. v3's abbreviated terminal success sentence included “binary” before advancing to the final binary frame; its outputs remain preserved. The v4 script and `runtime-pages-v4.json`/`runtime-proof-v4.json` are the final runtime qualification.

Compiled Electron main is build-qualified; it was not started as a live Electron process. No installed IH application/window, live provider, account or user session was used. The build retains an upstream unused `Stats` import warning from chokidar. Other-platform optional native packages are explicitly absent from this Windows copy. These are implementation controls, not release readiness, 100MiB/fan-in/crash coverage, full indexing or child transcript permission.

## Development-only visual inspection

Root starts, inspects and stops this loopback helper after handback:

```powershell
Set-Location D:/I-harness-main
node .tmp/context-r4a-result-pages-desktop-20261021-implementation/serve-preview.mjs
```

Entry URL: `http://127.0.0.1:4387/`. The server is left stopped. This is a development fixture harness using copied actual IH Timeline, activity/envelope/page and history components, plus the exact compiled IH stylesheet from the qualified Electron build. It is not a product page.

`preview.tsx` is the exact fixture entry. `build-preview.mjs` is its successful build command implementation (`node .tmp/context-r4a-result-pages-desktop-20261021-implementation/build-preview.mjs`, refusing an existing immutable output). `preview-dist-v2/` is the built candidate. The failed original preparation script and fixture entry are retained separately. Locale controls select 繁體中文/English and theme controls select dark/light. Fixture controls cover normal/grouped/nested/Code Mode/history/binary/exec/unavailable, read-capability removal, a delayed response, session changes and immutable digest changes. Open a normal disclosure and request its first page, advance/restart and select primary/catalog. While a delayed request is pending, switch target/session/digest or remove capability and check that old data and feedback do not appear.

## Evidence audit contract

Run `node .tmp/context-r4a-result-pages-desktop-20261021-implementation/audit.mjs` for a compact read-only integrity summary. `seal.json` records evidence-file hashes. `final-source-manifest.json` is the complete final tracked/nonignored untracked source identity; `source-time-comparison.json` identifies documentation-only differences from qualified gates. `task-2-report.md` in the active plan workspace records the exact local commit and handback.

Receipt schema is `{label,command,started,ended,exitCode,stable,IH_CONFIG_DIR,settings,files}`. Each `<label>-before.json`/`-after.json` is an array of `{path,sha256}`. `runtime-package-map.json` is an array of `{name,version,source,target,manifestSha256}`; `runtime-file-map.json` is an array of `{target,source,sha256,sourceSha256,transform}`. Runtime package/source copies are byte-identical except the explicitly recorded WSL worker manifest generation. `runtime-fixture-refs-v4.json`, `runtime-fixture-before-v4.json`, `runtime-fixture-after-v4.json`, `runtime-pages-v4.json` and `runtime-proof-v4.json` describe the final genuine fixtures and read outputs; unsuffixed files preserve v3. Failed and earlier fixture directories remain intact.

`preview-inputs-v2.json` records every bundled input's path/hash and CSS handling. `preview-assets-v2.json` records output hashes and the exact compiled IH CSS source/hash. `preview-metafile-v2.json` is the esbuild graph. CSS imports in the JS-only harness build are omitted because the complete real Electron stylesheet is supplied byte-identically as `ih.css`. `desktop-build/` and `desktop-build-map.json` preserve the actual Electron outputs. Harness scripts and fixture transformations are included in the evidence seal. No Task 1 sealed copy or evidence was changed.
