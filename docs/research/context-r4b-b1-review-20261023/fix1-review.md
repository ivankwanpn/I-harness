# Independent B1 fix round 1 re-review

**Verdict: REQUEST CHANGES.** F1, F3, F5, F6 and F7 are addressed in the scoped range. The original F2 and F4 reproductions are corrected, but each retains a directly related path that fails its governing contract. They are **NOT ADDRESSED in full**. Specification and quality acceptance remain withheld; root owns final acceptance.

Range: `bf4c0aa5b24f3755d8d0e685fd161b57e6133a27..163e0f469fc658ba9ffb0d962f22dc2115b77169`. Current product HEAD: `163e0f469fc658ba9ffb0d962f22dc2115b77169`; tree `7b7cceef4468e78d142925ffc8871bd4026aabe9`. All file/line references below are current HEAD. The only dirty tracked files are root's three documentation files. This is a scoped fix review, not another whole-B/B2/native/decomposition review.

I read the fix brief, implementation report, generated range package, changed product/test/helper/tooling files, relevant unchanged callers and root R-B-16/17. I statically verified all **21** final files against `final-manifest.json`, all **29** recorded log hashes, and the capsule SHA256: **zero mismatches**. I inspected the covering log summaries and isolated-run launcher/receipt. I did not execute product code, suites or predecessor code; mutate product/tests/index/Git; or dispatch agents. This report is my only write for this re-review.

## F1–F7 dispositions

| Finding | Disposition | Assessment of this fix range |
| --- | --- | --- |
| **F1: format 10 writable migration** | **ADDRESSED** | `session-persistence-jsonl/src/index.ts:224` admits 10 through the original migration leaf. `retained-format-ownership.test.ts` now covers nonempty 10 with owned/direct/coordinator barriers, exact original journal/body/header preservation, ordinary metadata continuation, one real admission, close/fresh reopen and unchanged generation/unknown-result observations. Future/downgrade requests retain byte-identity refusal. No semantic readiness certificate is synthesized. |
| **F2: selected text accessor capture** | **NOT ADDRESSED in full** | Input, summary and assistant rendering now use the existing descriptor-aware payload port; the three original benign-returning getter cases refuse with zero reads, consumed text remains unread and ordinary raw rendering is preserved. However, supported prepared input reaches direct text reads in the shared preparation index before rendering. See residual F2 below. |
| **F3: structural scalar descriptors** | **ADDRESSED for the original structural metadata finding** | The same source index preflights source metadata before readiness dispatch or index/boundary scalar reads. Type/seq/action/call/provenance accessors are rejected by descriptor, with zero-counter maintained controls. Payload slots and image body arrays remain opaque, no source-wide clone/stringify was added, and none still exits before work. The separate prepared-text overlap is recorded under F2 rather than double-counted here. |
| **F4: public JSONL publication** | **NOT ADDRESSED in full** | Shared strict seed/readiness validation now protects append and replaceEvents before publication. Original B1/B2/B3 negatives assert byte identity; ordinary ready append/canonical rewrite passes. Direct reservation/birth changes, introduction/removal and protected getters are fenced according to R-B-16, with ordinary title/torn-body positive coverage. The protected comparison is not bound to owned values used by the later merge, leaving a callback/mutation path; see residual F4 below. |
| **F5: memory bootstrap atomicity** | **ADDRESSED** | Own ordinary installation descriptors, pristine/binding/format state and events identity are checked before staging and again immediately after current(). Readonly events/header refuse without bootstrap mutation; callback changes to events/header/binding/writability refuse; the same index owner is retained. Observer evidence is now collected then asserted outside swallowed observer callbacks and proves complete 3-event/2-item state at every notification. This assessment concerns the supported ordinary Session object, not hostile proxy/prototype sandboxing. |
| **F6: exact-ref catalog cardinality** | **ADDRESSED** | The shared codec checks one catalog count per artifact row in full and partial profiles. Actual individually valid two-envelope source controls reject 1/2, retain equal-count deduplication, and independently rehashed full/present-prefix negatives reject the contradiction. Existing result+catalog dual use remains valid; no artifact body resolution is introduced. |
| **F7: portable genuine predecessor** | **ADDRESSED** | The committed capsule, portable manifest/provenance/licenses, strict pre-extraction validation, fresh temporary root and actual Node/tsx old reader remove the maintained `.tmp`/Bun/workstation/Git-history dependency. Missing/corrupt/path/duplicate/count/size controls fail without extracting. The final isolated 9-test control passes with no old evidence or Bun on PATH. The old reader remains genuine format 10 and checks refusal/unchanged bytes/zero fetch/repair/upgrade/provider. Details below. |

## Residual F4 — [P2] Publish the same protected metadata values that were compared

**Current locations:** `packages/session-persistence-jsonl/src/format.ts:20`–`25`; `packages/session-persistence-jsonl/src/index.ts:260`–`265`.

`assertMetadataUpdate` verifies the current descriptor/value of every protected patch field but returns no owned captured value. `updateMeta` then spreads the original caller patch and serializes the merged object. The patch and its protected object values remain mutable and can change during that later spread. The new guard therefore does not guarantee that the value compared against the old reservation is the value actually published.

A concrete ordinary-object path is:

1. Load the valid literal ready target and set `patch.semanticSeed` to a mutable clone of its current reservation. This protected value is an exact equivalent at comparison time.
2. Add an enumerable ordinary `title` getter to the same patch. The getter changes that cloned reservation's `seedDigest` to a different valid 64-character hexadecimal value and returns a normal title string.
3. `assertMetadataUpdate` accepts the equivalent own-data reservation without invoking the title getter. In `{...previous,...patch}`, the semanticSeed reference is copied, then the title getter mutates that referenced object. The merged header now holds the changed seedDigest.
4. `serializeHeader` validates reservation shape, not its relationship to preserved seed records. The new valid-shaped digest therefore passes shape validation and is written over the original header. A later reader detects the header/manifest mismatch.

The new guard also cannot rely on re-enumerating the original patch for scalar protected values: an earlier ordinary getter can change a protected data slot before the spread reaches that slot. The issue is publication of caller-owned values after their check, not a need to parse the body or broaden all metadata policy.

**Evidence level at initial report:** this was a static dataflow finding; the requested actual-backend probe receipt was not yet available. The completed unchanged-source runtime confirmation is now recorded in the evidence addendum below. No proxy or external concurrency is required.

**Contract:** root R-B-16 permits equivalent protected fields only after descriptor-safe comparison and prohibits changing the published reservation/birth identity through ordinary metadata updates. It deliberately preserves ordinary mutable metadata and body/torn-tail behavior. A successful comparison followed by publication of another value does not satisfy that requirement.

**Required correction:** have the existing metadata owner capture/bind the protected values used for comparison and publication, so the later mutable patch merge cannot replace or mutate them. Preserve ordinary metadata behavior and exact body bytes; do not add a whole-body parse, second owner, bootstrap bypass or unrelated metadata restriction. Add the benign title-getter mutation regression, checking both no unauthorized protected change and the supported title-only control, in addition to the existing direct protected-getter tests. A final shape-only recheck is insufficient because the substituted digest is well shaped.

## Residual F2 — [P2] Handle selected prepared-input text before the structural index dereferences it

**Current locations:** `packages/core-session/src/events/conversation-source.ts:29`; downstream existing read sites `packages/core-session/src/conversation/input-preparation.ts:39` and `:45`.

The new metadata preflight intentionally skips every field named `text`, leaving selected payload validation to renderer capture. That works for the simple input/summary/assistant tests. A supported `user/message` carrying `inputPreparation`, however, is processed by `createInputPreparationIndex.advance` before the exporter renders selected recipes. That index directly compares `event.text` to the derived observation text at line 39, or to referenced `admission.text` at line 45. An enumerable text getter returning the correct string is executed there before the descriptor-aware renderer can refuse it.

The repository already maintains a real supported source construction in `packages/core-session/test/generation-history.test.ts:37`–`49`: create a nondurable owner/action, admit a human-host input, capture the action and preparation start/result, then use the actual input-start API to publish raw and derived prepared messages atomically. On that valid source, replacing the promoted raw or derived user-message text with a benign getter leaves its linkage/value comparisons satisfied while executing the getter in the source index. Renderer capture can still refuse later; refusal after a getter call does not satisfy the zero-read selected-source contract.

**Evidence level at initial report:** this was a static path through the new preflight's omission and the existing genuine preparation consumer; the requested actual-source probe receipt was not yet available. The completed unchanged-source runtime confirmation is now recorded in the evidence addendum below. The current maintained selected-text tests have no inputPreparation linkage, so their green result does not exercise these earlier reads.

**Contract and root authority:** F2 requires selected accessors to reject before reads. R-B-10 simultaneously preserves structural input/preparation checks and excludes discarded payloads, and explicitly requires root adjudication if a necessary structural check needs a hidden body. I do not authorize removal of the existing public preparation equality check or a whole-source payload preflight. Root should settle the selected-source handling of that overlap before a contrary implementation; the normal public full validator must remain strict.

**Required correction/qualification:** ensure selected prepared input is descriptor safe before this earlier consumer reads text, under the same source/history owner. If preserving the structural check also requires reading discarded prepared text, return that concrete conflict to root under R-B-10 rather than silently reading hidden payloads or dropping the check. Add actual prepared raw/derived getter counters and retain existing simple/consumed text and public full-validation controls. This remains F2, not a new unrelated preparation redesign.

## F7 provenance and portability assessment

I checked the fixture implementation rather than accepting only a local pass. The manifest identifies old product `678af03dd54659e22dd5f941112c06ec9917e812`, exactly **177 original graph files / 10 packages**, plus original root license, **178 entries** total. The capsule is 350731 bytes; decoded bound/value is 1162602 bytes; total original file bytes are 860662. Independent static Get-FileHash matches:

`4774a20adf544d4773c57f06cba724a8cfa032c1541b6300727463ed4e5d6e41`.

The optional generator verifies the pinned accepted inventory/map identity and each selected source file's size/hash against both inventories, rejects links/duplicates/missing data, and copies original bytes. Git is used only in that optional provenance regeneration to obtain the original root license; it is not used by normal qualification. The committed README and manifest make that distinction explicit. Third-party chokidar/readdirp licenses remain among the original graph entries.

The ordinary test helper has bounded gzip decoding and per-entry/base64/size/hash checks; validates relative package paths, parent segments, duplicate paths, root containment and required package manifests; validates every entry before creating the output directory; and refuses an existing destination. The maintained test uses fresh OS temporary roots and normal `process.execPath` plus the already declared tsx loader. The old runner verifies old CURRENT_FORMAT_VERSION===10, keeps allowed package entrypoints and @i-harness resolutions within the extracted graph, rejects unexpected product/provider imports, stubs fetch, counts repair/upgrade/provider and checks unchanged ready/header-only/interrupted fixture bytes. It does not simulate predecessor behavior with the current validator or skip absent fixtures.

The isolated launcher copies current scoped packages/fixtures and ordinary root configuration, provides existing declared external runtime dependencies, clears PATH/NODE_PATH and invokes Node/Vitest directly. Its final receipt reports no prior evidence and no Bun. It is a checkout-like local dependency-provisioned control, not a new dependency installation or a separate platform certification. No old source/history runtime dependency remains in the maintained test. The original local old-graph qualification remains preserved historical evidence.

## Reviewed verification and exact source timing

The following results were run by the designated implementation/runtime owner and were read here from `.tmp/r4b-b1-fix1-20261023/`; they are not reviewer execution. I verified the recorded 29 log hashes against the manifest and read the relevant summaries. Setup failures and actual behavioral REDs remain classified separately in the implementation report.

| Evidence | Result and timing |
| --- | --- |
| `01-core-boundaries-red.log` → `02-core-boundaries-green.log` | Original product gives 15 failures/3 passes; core corrections give 40/40 across the focused source/reader controls. Meaningful benign-getter/partial-install/count regressions, not absent imports. |
| `03-public-writers-red.log` → `04-public-writers-green.log` | With corrected core but original writers: 16 failures/31 passes; writer/migration correction: 47/47. The later metadata removal controls are included in final JSONL suite. |
| `16-core-suite.log` | **495/495**, 45 files; final core product source, before the later narrow JSONL wording fix and observer-test-only strengthening. |
| `17-context-suite.log` | **74/74**, 8 files; same timing. |
| `18-persistence-suite.log` | **177 passed / 1 failed**, sole intentionally deferred real semantic fork archive baseline. No all-suite-green claim. |
| `19-jsonl-suite.log` → `20-format-fence-regressions.log` → `21-jsonl-suite-final.log` | First full run: 183 pass/1 established error-wording failure; narrow wording correction covered by focused 33/33, then **184/184**, 18 files, on final JSONL product source. No policy weakening was used to hide the format error. |
| `22-core-session-type-final.log` through `25-session-persistence-jsonl-type-final.log` | Four sequential package typechecks pass after final JSONL product correction, per command receipt/report. |
| `27-observer-check-final.log`, `29-core-observer-type.log` | **18/18** and core typecheck cover the final observer-test-only improvement; no product change. |
| `28-predecessor-final-isolated.log` and matching JSON receipt | Final source actual old-reader + strict-fixture tests: **9/9** in the isolated checkout-like copy. |
| `26-reachability-final.log` | Exactly one disclosed new staged export, `exportConversationSeed`; the new strict helper has real writer consumers. No fake consumer/exemption added. |

I independently checked all 21 current scoped file SHA256s against the final manifest and all 29 listed log SHA256s: no mismatches. Current product HEAD remains `163e0f46`, product paths are clean and only the three root-owned docs are dirty. The manifest/report distinguish intermediate dirty iterations from final committed source; I do not relabel earlier suite results as postdating the narrow wording/test changes.

## Remaining scope and next action

The core changes remain under the existing source/history/capture/codec/index owner. Public readiness uses a narrow strict shared wrapper with actual append/replacement consumers, without exposing staging/source capabilities. The original observer bug in the test was correctly strengthened rather than trusting assertions swallowed by observer handling. The fixture replaces a workstation dependency with retained genuine bytes and explicit provenance. These are substantive corrections; the two residual paths above prevent full closure of F2/F4.

Root supplied the separately recorded runtime results after the initial review; the addendum below incorporates them. Root owns the narrow R-B-10 selected prepared-text versus structural-only handling and the final owned metadata consistency ruling. Correct those same-contract gaps, add their focused regression controls and supply a scoped follow-up for review; the other five addressed findings do not require a whole-review restart.

No B2/native/provider/dependency-transfer/connected-volume acceptance, release, whole-repository verification or decomposition work is requested or claimed. Product remains staging 0.1.13-rc.1, real fork baseline RED and one staged reachability row remain visible. Root owns acceptance.

## Follow-up execution evidence addendum — unchanged fix-round-1 source

**Disposition unchanged:** F2 and F4 remain NOT ADDRESSED in full, both P2; F1/F3/F5/F6/F7 remain addressed. This addendum supplies the requested execution evidence and does not restart the review or reopen those five closures.

I read `task-1-fix-round1-metadata-probe.md`, both actual probe scripts, their command receipts and `source-comparison.json`. The separate sole runtime owner executed the two controls sequentially on exact unchanged HEAD `163e0f469fc658ba9ffb0d962f22dc2115b77169`, with **zero setup failures**. Its receipt covers **132 source/fixture files, 0 changed**, clean product paths and the same three root-owned dirty documents. The fix implementation report SHA256 remains `bbbf97fff67c2298e11a5c2351766cf0e79bdac63110b6ceae217792ebac1c69`. I performed static reads and this report update only; no product execution or mutation by this reviewer.

Evidence root: `.tmp/r4b-b1-fix1-metadata-probe-20261023/`.

| Actual command | Exit | Preserved evidence |
| --- | ---: | --- |
| `pnpm exec tsx .tmp/r4b-b1-fix1-metadata-probe-20261023/probe.ts` | 0 | `01-command.json`, `01-probe.log`, `results.json`, computed/ordinary-title before/after JSONL pairs. |
| `pnpm exec tsx .tmp/r4b-b1-fix1-metadata-probe-20261023/prepared-input.ts` | 0 | `02-command.json`, `02-prepared-input.log`, `results-prepared-input.json`. |

Exit 0 means that the requested control executed and recorded the outcome, not that the product contract passed. A read-only discovery miss for an old test filename is explicitly distinguished from the genuine supported setup used by the controls.

### F4 runtime confirmation

The computed-title case starts from a genuinely readable/projectable version 11 literal ready target (**3 events / 2 items**). The patch holds an own-data clone of the equivalent current reservation plus the requested enumerable title getter. The getter executes **once**, changes only one valid hex digit of the checked reservation's seedDigest and returns `computed title`.

`backend.updateMeta` **resolves successfully**, returns the mutated reservation, and publishes different header bytes (**2898 → 2898 bytes**, content changed). Only `semanticSeed` and `title` change; the event body remains byte-identical. Subsequent actual backend read **rejects `TypeError: Invalid semantic seed`** and changes no bytes. Before-file SHA256: `91e654b795054e41f87475410d49cc5350bc243150682d3a2665076394754322`; after: `e68e322b2629c9122886138115f525b8ed1941eb49f46e8307adf4e946497d29`.

The separate ordinary string-title positive uses the same equivalent cloned reservation, executes no getter, changes title only, preserves the body and succeeds on subsequent read with version 11 / 3 events / original seed digest. This confirms the residual protected-value ownership gap without conflating it with unsupported setup or ordinary title editing.

### F2 runtime confirmation

The prepared-input control uses the actual nondurable owner, input admission, captured generation/preparation start/result and atomic input-start APIs from the maintained generation-history setup. All **five** fact outcomes are genuinely `memory-committed` with nondurable disposition; the final start group is `[4,5,6,7,8]`. Both independent unmodified source controls export `kind:'seed'` and emit raw `/raw` plus the actual generated prepared context.

| Selected own enumerable getter | Original benign return value | Final export | Calls before result |
| --- | --- | --- | ---: |
| Promoted raw `user/message.text`, seq **6** | `/raw` | Refused `invalid-seed` | **2** |
| Derived prepared `user/message.text`, seq **7** | Original generated context | Refused `invalid-seed` | **1** |

Counters are captured immediately after export, before source logging. The eventual refusal therefore does not satisfy zero-read rejection. In addition to the preparation-index reads at `conversation/input-preparation.ts:39/:45`, the raw variant reaches the provenance consistency comparison in `conversation/sources.ts:58`; that shared source path must participate in the root-selected narrow correction. No successful getter-derived export or fabricated preparation linkage is claimed.

Root is defining the selected-source prepared-text/structural-only distinction and final owned metadata snapshot consistency for fix round 2. This addendum adds the now-confirmed evidence only; it does not invent those contract rulings or authorize unrelated changes. No fixes, maintained regression changes, suites, B2 activation or broader acceptance are included.
