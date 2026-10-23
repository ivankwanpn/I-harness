# Task 3 / IC-C independent spec and quality review

Reviewed range: `807d2cc082632544034aa13bbd8a75d2b952fcf0..97cdda489394cbac61300e4d744db79579174bc2`.

Frozen checkout: `C:/Users/inkik/.codex/worktrees/context-current/I-harness-main`.

## Verdict

**Spec: pass for this IC-C C3/C4R packet. Quality: pass, with the evidence qualifications below.** I found no Critical or Important defect requiring a product change in this range. This is approval of the 15-file scoped change, including the explicitly authorized existing `reduction/source.ts` currentness extension. It is not approval of the whole version, IC-B, native/child callers, R6, real-provider recall, or a release.

I read the task-3 brief, review brief, promoted C3/C4R plan, implementation report, full changed range and its surrounding source/publication contracts. I inspected the tests and retained raw receipts rather than accepting reported totals alone. I performed only read-only source/Git/evidence inspection; no runtime test suite or typecheck was rerun, no source/Git state was changed, and no recursive agent was used. This review document is the sole review write.

## Findings

- Critical: none found.
- Important: none found.
- Minor actionable product findings: none found.

The evidence limitations below qualify the verdict; they are not claims of additional product failures.

## Spec assessment

### C3 selection and publication

`context-engine/src/reduction/run.ts:41-45` retains ordinary eligible-run selection and consults retained-tail selection only after no untried ordinary run remains and the prepared baseline has `capacityFit === 'no'`. The same tried set and `ReductionAttempts` object remain in the existing transaction driver. `selection.ts:34-49` selects complete, unprotected retained exchange groups; open/unknown groups and protected source refs remain excluded by `reductionGroups`. No flag, archive-size estimate, retention-threshold change, or alternative reducer authorizes this escape.

The existing measured-progress, current-view remeasurement and publication path still owns acceptance. The tests exercise auto/manual/recovery entry reasons, no-op ordinary trials before the useful tail, soft-cap preservation, and protected/open tail exclusions. A summary response alone does not publish a rewrite. The real 24-tool Gateway path demonstrates the useful hard-pressure tail case under the original 100k policy.

### C4R exact source and coverage

`compaction/src/summary/source.ts:24-66` supplies the shared portable segment encoder used by full portable mode and recorded pages. It enumerates visible reasoning, assistant text, canonical arguments and user/tool content in the existing semantic order; it retains source/group/item/message/field/part/call identities. Plain empty text has a marker. Unpaired UTF-16 surrogates are refused explicitly rather than silently replaced by UTF-8 encoding. Existing opaque-only and native-order gates remain exercised by the unchanged affected suite.

`summary/pages.ts:20-68` keeps an attempt-local cursor and immutable source digest. Text cuts use valid UTF-8 boundaries; media descriptors remain indivisible. Data messages are neutral user content, and the manifest explicitly distinguishes fragments from executable calls or standalone complete results. The group coverage remains original coverage, with item provenance/exchange context for the page. The ledger recomputes the candidate from the cursor and accepted byte count and compares page digest, end cursor and manifest before advancement; missing, duplicated, reordered or modified ranges cannot authorize group completion. Only completion of the entire selected piece adds its original group IDs to the return value.

`summary/generate.ts:22-95` preserves fitting full-source requests and existing subdivision between separable groups. It enters paging only after full-source reduction/confirmed overflow for an indivisible group. It does not fetch artifact bodies, fabricate retrieval refs, replay tools, or introduce another model loop. The final accepted rolling checkpoint is returned directly; there is no extra merge call. Observed-input coverage and checkpoint accuracy remain distinct properties.

### Prepared fit and finite budgets

Every page is passed through the existing `prepareSummary` path, with exact checkpoint/directive/system/tools/media overhead. Pages require known, hard-fitting final prepared capacity before transport. The initial 65,536-byte text ceiling is only a candidate-construction limit. Shrinking uses measured dimensions/pressure, proposes a strictly smaller source range and re-prepares it.

The physical allowance is the minimum of eight, source max calls and summary limit. Physical calls, malformed retries and confirmed overflow share `source.attempts.count`. Local sizing is limited to two corrections and is stored on the shared `ReductionAttempts`, so stale source rebuilds do not refill it. Page malformed correction is shared across pages. Failed transmitted attempts preserve usage accounting. The existing original generation/deadline bindings remain in use.

Source/Stop checks surround asynchronous preparation, transport completion and observation callbacks and precede ledger advancement. Provider-backed page output requires the existing accepted physical-piece observation; custom neutral clients are expressly local-test evidence. Partial successful pages cannot return partial whole-group coverage. The eight-call exhaustion, malformed/overflow, stale/Stop, unavailable capacity, indivisible image and unknown-publication controls cover the relevant failure paths.

### Currentness extension

`context-engine/src/reduction/source.ts:9-28` compares typed current-floor identity and semantic digest, pending input/delegation evidence, non-item-owned protection refs, admitted protected inputs, and authoritative unresolved call/effect facts in addition to the existing owner/branch/epoch/surface and selected-group checks. Same-text new current sources invalidate the capture. The change deliberately avoids whole semantic/protection-revision equality, preserving ordinary compatible retained suffixes and the existing final full-request remeasurement.

The ten new currentness cases and actual human/rules mutation cases are consistent with the authorized scope. Actual paging mutation controls terminate after the original three stale rebuilds/four attempts with originals retained and no replacement. The existing ownership-order cases preserve accepted/legacy suffix compatibility.

## Independent evidence assessment

I parsed the retained Vitest JSON reports. They record 246/246 compaction, 90/90 context-engine, 3/3 qualified Gateway and 13/13 retained-source boundary cases passing, with zero failures. These are retained prior execution results, not tests run by this reviewer.

I checked every one of the 15 current working-file SHA256 values and HEAD Git blob IDs against `commit-binding.json`; all matched. HEAD is the stated `97cdda489394cbac61300e4d744db79579174bc2`. The before/after source file arrays and dependency-resolution arrays agree. The recorded resolutions point into the frozen worktree. Working status has only the retained untracked `.task3-evidence/` directory.

I decompressed all final Gateway raw wire files and independently checked each stored request's SHA256 and UTF-8 body length against the receiver metadata. All matched. Both 24 cases have eight physical summary sends, nine preparations (one rejected full source plus eight pages), one replacement, 50 covered text segments and 407,568 source bytes. The full candidate receipt records 454,987 body bytes and 412,183 projected-heuristic input. The final admitted pages use 4,096 output caps; there are no local page-sizing corrections in these two runs.

I also reconstructed both 24-case raw page streams against the actual retained `tool/call` arguments and `tool/result` inline values, using only JSON/Buffer/hash operations and no product projection helpers. All ordered segment contents, segment hashes, contiguous offsets and total byte counts matched. This independently corroborates the 403,200 result-content bytes plus JSON framing, call arguments and visible assistant/reasoning text.

The middle-fact raw stream has three new facts on each page. Its incoming checkpoints contain 0, 3, 6, 9, 12, 15, 18 and 21 previously observed facts respectively; each preserves the prior facts. The committed replacement and the initial and cold final answers each contain all 24 exact facts. Inspection of `context-summary-growth.test.ts:90-163` confirms that the accumulated expected-source/coverage ledger is used for assertions and gating only. Summary replies extract facts and completed-work markers from the current received body, which includes the supplied previous checkpoint. Replies do not draw facts from `expectedTexts`, `observedSegments` or an expected-fact accumulator.

The retained initial BASE refusal and first development failure are present. The BASE initial 24 case reports the actual prompt-too-long refusal with 24 reads/results and no replacement; later manual/follow-up requests in that diagnostic are separate from the initial failure. The first paging run retains its historical blanket-margin assertion failure. The qualified fixture's summary 5%/main 10% margin matches the existing policy; this range does not change the product margin/window/cap policy.

The final 60-read receipt records 60 unique original reads, 20 replacements/summary calls and a successful cold follow-up with all 60 completed reads visible. The exact-BASE comparison receipt also records 20 replacements and successful cold continuation. The report correctly avoids claiming that the older historical count of 29 was preserved.

The unknown-publication test verifies original transaction issuance/reconciliation once and preserves original tool results/call count. It does not turn receipt uncertainty into new tool work or prematurely publish partial group coverage.

## Evidence qualifications and remaining boundaries

1. The three package typechecks are supported by reported successful tool transcript exits, **not retained `final-types-*.log` files**. The writer explained that empty `Tee-Object` output produced no files. Root supplied the original transcript references: compaction chunk `1c4574` exit 0, context-engine chunk `8faa78` exit 0, and Gateway initial chunk `274bb5` / session `61771`, completed chunk `d93db0` exit 0. I did not independently execute those checks or inspect those absent logs. The report should retain this precise distinction; no logs should be recreated as though contemporaneous.
2. Before/after raw source receipts bracket the final Gateway run and bind the subsequently committed file bytes. They are useful reproducibility evidence, not an independent process attestation for every earlier unit-suite run, historical comparison or every unchanged transitive dependency. The BASE60 retained replacement script/file list and receipt support its stated comparison but are not a new reviewer-run BASE experiment.
3. The receiver's token usage is explicitly synthetic and shares IH's pricing heuristic. Independent wire bytes/ranges/hashes establish receipt fidelity; they do not establish independent tokenization, live-provider capacity accuracy or natural-model recall. The controlled 24-fact propagation establishes the stated fixture property only.
4. The 100MiB controls establish the existing selected-projection/artifact boundary. They do not establish streaming or bounded memory for arbitrarily large inline captures. A source requiring more than the existing eight successful calls must still block honestly.
5. The real Gateway case is text-only. Media identity/indivisibility and native-order/opaque behavior are covered by focused/unchanged package controls and static inspection, not by a newly run real-provider multimodal Gateway scenario.
6. Current-floor/rule/human guards are reviewed here as the authorized existing reduction owner extension. Actual instruction admission integration, native/child caller qualification and the whole release remain separately owned gates.

No additional runtime probe was justified by an unresolved concrete product risk during this review. The reviewed range can proceed to root's scoped integration decision with these qualifications preserved.
