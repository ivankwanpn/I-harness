# Task 1 independent spec and code quality review

## Spec compliance verdict

**✅ Spec compliant for the approved R4A A4a MCP slice. No missing, extra, or misunderstood requirement requiring an implementation fix was identified.**

- Review range: BASE `3ed2d6681decfce4230eca4699890e874da13965` to HEAD `e0e6a8d1fd3ea3aeb4eedfa237f6aad7a256cbc3`; product/test HEAD `fd84e6eaab3357bc79ea1d3b4a73f763661c9466`.
- Read the complete approved plan, task brief, implementer report, review checklist, progress ledger, and complete supplied review package. The full diff was read once in two consecutive bounded chunks; a later scan of the package was solely to calculate source line references.
- All named implementation seams have corresponding hunks: core-tools public entry and private metadata owner, MCP bridge, prepared-result composition, original capture, new private presenter, and the stipulated client/bridge/capture/managed integration tests. `client.ts`, native media validation, guest limits and adapters intentionally have no product change.
- **⚠️ Scope qualification:** this verdict is a Task 1 code review, not whole-A4/R4A or release acceptance. Evidence provenance, source stability and copy/seal integrity were independently checked by root as reported in the dispatch; I did not substitute those checks for this code review or independently recompute them.

## Strengths and checked requirements

### Genuine metadata ownership and compatibility

- `packages/core-tools/src/registry/result-finalization.ts:16,55,62,69,73` extends the existing execution WeakMap rather than introducing another authority owner. Presentation declaration returns false for an unregistered exec and rejects a registered exec before dispatch. Outcome declaration preserves the existing row, the getter validates the original prepared identity, and `resultExecution` explicitly returns only outcome/dispatch.
- `packages/core-tools/src/registry/result-finalization.ts:29` resets the execution row when registering a prepared call. `packages/core-tools/test/result-finalization.test.ts:6` checks unregistered/pre-dispatch rejection, declaration after dispatch, preservation across outcome update, absence from serialized execution, counterfeit prepared rejection, and registration reset.
- `packages/mcp-client/src/bridge.ts:38` declares MCP presentation only after the genuine registered outcome declaration succeeds. The existing direct content-only/throw fallback is preserved; it is not confused with genuine execution without retention. `packages/mcp-client/test/bridge.test.ts:26,39` covers the registered full result for success/failure and direct successful compatibility.
- `packages/session-executor/src/lifecycle/result-retention.ts:29` obtains presentation from the actual prepared-call owner and passes it into the original capture. No marker based on tool name, returned ref, payload `isError`, or other data key was added. The synthetic capture path has no presentation change.

### Full owned data versus model presentation

- `packages/output-retention/src/result/capture.ts:15` still lowers and freezes once before the new presenter runs at line 17. The stream and ready program continue to use the original `programValue`; no projection becomes program or artifact data. The new presenter does not mutate that value, inspect encoded binary bodies, or own storage.
- `packages/mcp-client/test/client.test.ts:10` traverses the real connected client over local stdio and compares the full normalized object, including false/true, null/object structured content, arbitrary nested data, and ordered content. The extra raw top-level provider property is explicitly outside the expected result. The unchanged actual normalizer at `packages/mcp-client/src/client.ts:33,259` supports precisely this contract, not raw-wire top-level preservation.
- `packages/mcp-client/test/stdio-stub.ts:44` explicitly separates literal JSON-RPC vectors from the default SDK Server helper. This implements the approved MCP-06 null ruling without relaxing production validation or claiming SDK Server null support.
- `packages/session-executor/test/retained-mcp-result.test.ts:50,72,106` checks fresh-store advancing pages, original codec, exact encoded count, independent SHA-256, and expected bytes built from a fresh literal through native `JSON.stringify`. The fixture has leading audio, later text/resource descriptors, distinct PNG/JPEG, and a 1 MiB structured field. The success/failure × saved/quota matrix compares full returned program data independently of execution outcome and storage state.

### Bounded presentation and existing native media

- `packages/output-retention/src/result/mcp-presentation.ts:9,12` limits text to 2,048 escaped bytes and URI/name/type fields to 1,024 through the existing limiter before concatenation. Each description therefore has bounded temporary size; data/blob bodies are never stringified for this preview.
- `packages/output-retention/src/result/mcp-presentation.ts:31` recognizes content only after the explicit trusted option. It labels original block positions and provides text, audio/image type, resource URI/text, resource-link fields, and a structured-content-presence note. It neither infers execution outcome nor advertises native-media validity.
- `packages/output-retention/src/result/mcp-presentation.ts:36` reserves suffix space, stops traversal when the remaining budget is exhausted, and reports the remaining block count. Its final `boundedPreview` keeps the escaped total at 8,192 bytes. Unvisited blocks conservatively force artifact representation, preventing undiscovered non-text content from escaping through the small-inline path.
- `packages/output-retention/src/result/capture.ts:18,32,51,56,69,70` forces artifact representation for marked non-text content, skips encoded-prefix preview only when the explicit presenter succeeds, uses the same neutral preview for artifact/unavailable outcomes, and preserves existing inline handling when eligible. Existing separate native image extraction and validation remain the media authority.
- `packages/output-retention/test/mcp-presentation.test.ts:13,32,50,54,60,70` covers small marked non-text blocks, invalid/unsupported media, unknown types, escaping/NUL/surrogate fields, exact per-field limits, omission counts, full program data, empty/text/transformed inline values, ordinary lookalikes, and ordinary image extraction.
- `packages/session-executor/test/retained-mcp-result.test.ts:72` checks relative PNG/JPEG native-image order and ordinary escaped envelope size at most 64,000 bytes with typed media excluded from that ordinary budget. Its real model projection contains later useful text and omits the leading encoded audio. No adapter or companion-image-layout change exists in the diff.

### Original settlement and Code Mode behavior

- `packages/session-executor/test/retained-mcp-result.test.ts:134` invokes real Code Mode WASM: the guest sees the full structured sentinel, explicit false and ordered content types. The separate larger result is refused at the existing guest transfer boundary after the host's full artifact is available for cold read. No guest cap change is present.
- `packages/session-executor/test/retained-mcp-result.test.ts:163` intercepts finish uncertainty around the real service sink rather than replacing finalization with a fake result. The real managed document close retries its original source; the test asserts one MCP body, one getter, one hook, one scope, and one result fact in memory and backend after recovery.
- `packages/session-executor/test/retained-mcp-result.test.ts:207,219` checks a genuine ordinary tool with misleading payload keys and a trusted execute transform that removes normalized content. Both retain the original ordinary/generic behavior and full program value.

## Findings

### Critical — must fix

None identified in the reviewed range.

### Important — should fix before accepting this slice

None identified in the reviewed range.

### Minor — introduced by this slice

None identified in the reviewed range. I have not converted speculative broader coverage or unchanged implementation choices into findings.

### Observed inherited diagnostics

- `.tmp/context-r4a-a4a-mcp-20261020-implementation/22-output-retention-final-neutral/raw.txt:7` and following lines contain repeated spill-GC ENOENT warnings from existing `spill-guard.test.ts` cases. This output is not pristine, despite the passing suite. The delivery explicitly preserves it at `docs/research/2026-10-20-context-r4a-a4a-mcp-delivery.md:60`; no changed spill-GC implementation or demonstrated new regression makes it an A4a fix requirement.
- The existing reachability six-export failure is explicitly retained at `docs/research/2026-10-20-context-r4a-a4a-mcp-delivery.md:58`. No exemption, baseline reset, or fake consumer appears in this diff. Existing unrelated A3 failures remain outside this review absent a demonstrated regression.

## Focused checks outside the diff

These were the named cross-boundary risks checked; no broader owner crawl was performed.

1. **Risk: field truncation could stringify an entire huge source string before limiting.** Checked the complete unchanged `packages/output-retention/src/result/preview.ts:1` helper. Its binary search limits slice length to the cap before `JSON.stringify`, and avoids cutting a trailing high surrogate. The new field calls use this helper before joining descriptions.
2. **Risk: the new force-artifact/preview branches could disturb ordinary inline disposition or unknown/refused settlement.** The supplied capture hunks omit the middle of `settle`, so I read `packages/output-retention/src/result/capture.ts:41` through the end to resolve that hunk gap. The original sink/write reconciliation, 60,000-byte inline decision, refusal branches, finish retry and cached ready result remain intact. Presentation only changes the necessary force-artifact and preview decisions.
3. **Risk: descriptive image blocks could bypass native validation or reorder supported images.** Checked unchanged `packages/output-retention/src/result/media.ts:5`. It still extracts original content-order images and calls the original `validateImages`, with the original all-or-nothing refusal behavior; the presenter does not replace it.
4. **Risk: metadata could survive re-registration or a counterfeit PreparedCall.** The identity/register bodies were outside the supplied changed hunk, so I checked `packages/core-tools/src/registry/result-finalization.ts:29` through `:41`. Registration resets the row and prepared assertion checks original exec/call/tool/name/session/callId and held source.
5. **Risk: local null vectors could bypass the actual production normalizer or overclaim raw top-level retention.** Checked `packages/mcp-client/src/client.ts:27` through `:37` and the focused `callTool` implementation at `:259` through `:269`. It uses its actual SDK request with `RawCallToolResultSchema` and selectively returns only normalized fields, preserving false/null and nested content. No production client change was needed.

## Evidence inspected and checks run

- No runtime test, broad suite, git command, live provider/account/session, branch/worktree operation, or source/evidence mutation was performed for this review. The only write is this designated report.
- Inspected preserved raw output for the actual managed behavioral RED (receipt 01), capture RED (02), quota-wording RED (21), core-tools full (08), MCP full (12), final output-retention (22), final connected executor (23), and final copied runtime (26). The RED output contains the claimed behavioral failures rather than only missing imports; the final connected and copied output contains the expected tests.
- Observed raw summaries: core-tools 137/15 files; MCP 107/16 files; final output-retention 53/7 files; connected executor 16/2 files; final copied runtime 22/2 files. These are existing run observations, not freshly rerun results. Broad raw-output reads were followed by small summary/line scans where long failure strings caused tool-output truncation; I did not regenerate evidence.
- Four typechecks and the copy/build/source/receipt/seal checks are source-time-qualified in the delivery at `docs/research/2026-10-20-context-r4a-a4a-mcp-delivery.md:42` through `:74`. Root independently verified receipts, copied sources/edges/fixtures, and sealed artifacts; this review relies on that separate provenance qualification rather than repeating it.
- No unresolved code-reading doubt required requesting an additional runtime discriminator from root.

## Assessment and explicit unverified scope

**Task quality: Approved for independent root acceptance of the A4a MCP slice.** The changes are cohesive and narrow: one existing metadata owner, one small private presenter, and minimal wiring into the original retention path. The tests exercise real managed source/store/model and WASM consumers, with independent full-byte oracles and meaningful refusal/recovery controls.

**⚠️ Not verified or accepted here:** remaining A4 readers/search/export/version/authority work, A5/A6, R4B/R4C/R5/R6, whole-workspace/session validation, 100 MiB/100-child matrices, full six native protocol routes, live providers, Gateway IPC, Electron/renderer, packaged CLI, and release qualification. The copied runtime evidence is copied-library qualification with adapted QA fixture imports, not those delivery surfaces. MCP-06 is local literal-wire normalization coverage and does not prove SDK Server null support. Original content interleave is retained as owned/program/artifact data; no native model-block interleave or native audio/resource support is claimed.
