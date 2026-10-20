# Task 2 independent spec and code-quality review

Date: 2026-10-20. Reviewer: fresh GPT6.1Sol review seat `/root/a4b_display_review_20261020`.

**Spec verdict: PASS for Task 2 and READ-04/05/06/09/10. Code-quality verdict: acceptable; no actionable Critical, Important, or Minor finding. Ready for root acceptance of this unit.** This verdict does not accept all R4A, the following artifact reader, or release readiness.

## Scope and method

Reviewed BASE `43e829a4d08ba54f2264bece3b827bf28be44ed6` through HEAD `46ba1a4907910f11eb922851105ac3a69b404022`, comprising product `368d18faca15d16204d1d063d7e704fe3ae75a1e`, delivery `a14d95d0f75d8425e796fdd402818db43823652d`, and root's final READ-09/10 plan documentation. Read the complete supplied 1,507-line diff once in bounded, non-overlapping chunks; no replacement checkout or repeated Git diff was used. Read Task 2/global rulings, the brief, writer report, review checklist, progress ledger, and root visual report. Applied the existing code-reviewer template. The writer report was treated as claims and compared with implementation, test changes, and selected raw evidence.

Additional unchanged-source inspection was restricted to named boundary risks: `RawRecordedData.tsx` to check that the retained-body wrapper really discloses the original inline value on demand; `tool-presentation.ts:96` to check that the moved image component's recognizer preserves ordered native media and does not reintroduce inline payload images; the beginning of `events/admission.ts` to check the browser context leaf's remaining scalar dependency. Precise source line searches supplied references without rereading changed files. These checks found no conflicting boundary behavior.

No product edits, agents, Git changes, live data, application launch, test runs, builds, or broad suites were performed by this reviewer. The only write is this report. Root's separately completed hash/map audit and reachability audit were not duplicated.

## Strengths and plan alignment

- **CLI selection and bound remain intact.** `apps/cli/src/sessions.ts:182` adds only the new-envelope branch inside the existing `tool/result` selection. It selects original inline value or stored preview, labels trusted outcome, dispatch, and retention separately, and applies the original 200-character bound to the combined summary. It does not serialize envelope media or hydrate artifacts. The changed command test exercises actual persisted snapshot output and structural JSON, checks complete descriptors and unchanged JSONL bytes, and separately pins the exact 200-character result body.
- **The new representation travels through the actual Desktop chain.** `packages/desktop/src/renderer/session/project.ts:7` derives the alias from the SDK history union. At `project.ts:88`, both matched and standalone ordinary/nested result folds retain a distinct envelope and clear stale legacy output/isError. Both `Timeline.tsx` and `ActivityGroup.tsx` forward that member into `ToolActivity` and `RecordedToolOutput`; grouping ownership/order is untouched. Tests render the real regular and grouped routes, rather than merely asserting prop presence.
- **Trusted execution state stays authoritative.** `tool-presentation.ts:38` branches on the envelope before legacy payload inference and maps succeeded/failed/canceled/unknown to received/failed/cancelled/unknown. `work-stages.ts:41` uses only trusted failed outcome for new rows. Dispatch is displayed independently by `RecordedResultEnvelope.tsx:14`; quota refusal does not become an execution error. Test data deliberately includes ordinary error/status/isError/exitCode fields and failed plus not-dispatched, canceled, unknown, and quota cases.
- **The presentation leaf preserves original data and existing rich rendering.** `RecordedToolOutput.tsx:189` supplies the actual inline value to the existing body recognizers. The private body has unconditional hooks; the public wrapper has no hooks behind its branch. At lines 141/182 it suppresses historical image recognition for the new branch, and at line 184 explicitly retains complete inline raw disclosure. It does not delete image/error-named fields from the original value. `RecordedResultEnvelope.tsx:23` renders the envelope's native media once through the existing ordered recognizer. The moved `RecordedImages` implementation is reused and re-exported at its historical import site without a runtime component cycle.
- **Retention claims are honest.** The new leaf shows artifact ref/codec/completeness, unavailable reason/observed bytes, and dependency descriptors without a reader callback or capability. It labels partial completeness explicitly and does not promise complete source capture. `RecordedCodeActivity` uses the same leaf while retaining its original legacy readers and full event disclosure. The changed code-output expectation now checks actual complete-capture metadata rather than the old unconditional complete-source sentence.
- **READ-09 is narrow and producer-owned.** `packages/fs-search/src/index.ts:57` awaits the genuine search result and declares execution outcome from its closed SearchResult status only: canceled, failed for error/timeout, and succeeded for completed/limited. No generic finalizer, arbitrary payload inference, late-abort guess, or body rewriting is added. The actual factory/registry test covers both tools and direct unregistered execution. The migrated real search tests read complete retained values with byte-count/digest checks, preserving 240 matches, the 262144 limit, ten selected line-2 references, absent unselected model content, exactly one canceled/partial result, drained work, and no follow-on glob/RESURRECTED checks. Original timeouts remain.
- **READ-10 establishes a real browser boundary.** `packages/core-session/src/context.ts:2` exposes the existing decoder through a public subpath; `packages/sdk/src/context.ts:2` is its genuine consumer. `context-state.ts:1` imports the moved scalar validation leaf, while `events/context.ts:1` imports/re-exports the same original declarations for Node dispatch/root compatibility. There is no Node shim, bundler alias, renderer private package import, copied validator, or weakened validation. The browser test bundles the actual SDK entry and compares v1/v2 decoding and invalid/owner cases against the original public reader. Root independently verified the fifteen declaration moves.
- **Cold reads and export remain observational.** SDK and Gateway tests exercise actual cold framed history with complete tool/result, code/result, and code/output descriptors, zero model preparation/assembly (and provider construction in the Gateway), and unchanged JSONL bytes. No production SDK history fallback change or artifact reader API was introduced. These are qualified-composition controls, not universal claims about every custom coordinator.

## Evidence assessed

I inspected the relevant raw outputs, not only the delivery summary:

- Desktop receipt 01 records seven genuine missing display/media/status failures. CLI receipt 03 records the valid format-10 snapshot returning three empty result summaries. Invalid/setup/intermediate assertion attempts remain separately classified in `failure-dispositions.json`.
- Receipt 10 fails both Stop variants at the final succeeded-versus-canceled assertion, after the original full-value, drain, and no-follow-on checks. Receipt 18 reports all four real search tests passing; receipt 21 reports 51 fs-search tests passing across five files, including the five producer-status mappings.
- Actual renderer receipt 15 fails at `core-session/src/managed/capture.ts:2`, because `types` from `node:util` is unavailable in the browser external module. Receipt 20 reproduces that exact failure using the BASE Desktop source overlay. This is preserved baseline/failure evidence, not a blanket exemption. Receipt 34 independently fails the actual SDK/context browser bundle on four Node builtin imports. Final receipt 56 builds the actual Electron main/preload/renderer successfully, with 442/2/2047 modules. Those are distinct build gates.
- Receipt 38 reports eight SDK context/history/authority/browser tests passing. Receipt 39 reports 143 Desktop tests in twelve files passing, including legacy rich-output, project/group/stage, timeline disclosure/code-action, context, and new retained-display scopes. Receipt 40 reports seventeen CLI tests passing. Receipt 53 reports thirty final copied/bundled CLI, SDK, and Gateway tests passing. Receipt 55 seals eleven retained-display tests at the final product HEAD.

Root independently verified 57 sequential source-stable receipts, 2,671 sources, 1,003 source/manifest copies, 280 internal copy edges, six fixtures/36 literal rewrites, 352 artifacts, 137 CLI inputs, 22 preview inputs, seven Electron output copies, and fifteen unchanged scalar declarations with zero mismatches. This report relies on that root audit for provenance and does not claim to have recomputed it. Root's separate reachability receipt has exit 1 for the same six inherited unused exports and no new row; it is not described as a passing whole-repository audit.

Root's actual-component dark Chinese/English preview inspection and corrected screenshot/AX manifest are separate visual evidence. Its report records working raw disclosure, honest source-limited/quota/unknown labels, native media once in order, and no observed overflow/overlap at 1265×712. I read the visual report; I did not independently operate the preview or inspect installed IH.

## Actionable findings

### Critical

None identified in the reviewed scope.

### Important

None identified in the reviewed scope.

### Minor

None identified in the reviewed scope. No stylistic churn is requested for this frozen unit.

## Assessment and limits

**Ready for root acceptance: yes.** The implementation meets the fixed Task 2 consumer contracts and the two explicit root scope rulings. Source changes are cohesive, retain legacy behavior at explicit branches, and have behavior-level failure/repair evidence plus actual renderer and copied-consumer gates.

This is code/spec review using the preserved test/build evidence and root provenance/visual audits; it is not a new execution of those gates. Static preview/build evidence does not qualify an installed app, IPC integration, native full-size image behavior, light theme, or a responsive viewport matrix. Cold fixtures do not qualify live providers or all custom coordinator compositions. Further native shell/code-exec outcome declarations remain the separately planned producer unit; observing a failed background job does not imply that an otherwise successful query should be reclassified as failed. The explicit artifact-page API, wider R4A/R4B/C/R5/R6, owned-version qualification, and release readiness remain outside this acceptance.

No concrete unresolved risk required a new runtime discriminator. Reviewer remains available for scoped follow-up if root identifies a specific conflicting behavior.
