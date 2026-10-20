# R4A A4b — Retained result consumers

> **For agentic workers:** Use subagent-driven-development. Codex root coordinates continuous execution; every delegated implementer/reviewer is GPT6.1Sol. One product writer, independent review after each coherent task, no recursive delegation. Task handback is a review boundary, not a request to stop the overall approved redesign.

**Goal:** Make existing search and transcript/timeline consumers correctly observe the accepted ResultEnvelope representation without reading complete artifacts implicitly.

**Status2026-10-20:** Task1 accepted through product42bbaebc/delivery541cd063 after original-reviewer closure of the plan-mandated child-preview defect. [Acceptance](../../research/2026-10-20-context-r4a-a4b-search-acceptance.md) preserves the original failures, corrected oracle and exact final evidence. Continue Task2; the overall plan is not paused.

**Architecture:** F1 remains the result fact authority. Pure readers select the closed envelope or explicit historical branch. Search indexes only the bounded fact representation and rebuilds its existing derived cache when the projection changes. CLI and Desktop retain execution/storage/media distinctions; original history/export readers preserve complete descriptors without creating an execution assembly.

**Tech Stack:** Existing TypeScript, Node24, SQLite FTS5, Vitest, React/Electron renderer, actual JSONL coordinator and SDK/Gateway paths. No new dependency or store.

**Spec:** [remaining A4](2026-10-19-context-engine-r4a-completion-handoff.md), [retained-result contracts](2026-10-18-context-engine-r4a-retained-results.md), [framework](../specs/2026-10-15-context-engine-framework.md), [accepted A4a](../../research/2026-10-20-context-r4a-a4a-mcp-acceptance.md). Start after80d025d0. Previously accepted producer/capture behavior is preserved.

## Global constraints and rulings

- Existing checkout `D:/I-harness-main`, branch `codex/v0.1.13-development`; no branch switch or new worktree. Product0.1.13-rc.1, Session format10 and original decomposition27/43 remain unchanged. No push/merge/tag/release.
- Keep original result/program/artifact bytes, original F1/source/receipt, execution outcome and retention status. Reading never authorizes a tool, model request, auth refresh, child creation, wake or ownership adoption.
- Search is a bounded fact/preview index, not a complete artifact-body index. The original R4A optional partial-coverage search contract does not authorize scanning arbitrary artifact bodies. Ref existence/shape is data, not access authority.
- Ruling READ-01: for a new ordinary/nested/emitted result envelope, searchable text is the original inline value serialized by the existing shared JSON-data function, or the stored preview for artifact/unavailable. Exclude the separate typed `media`, immutable ref metadata and dependency catalogs. Do not strip arbitrary inline data merely because a field is named `images`, `error` or `ref`. Legacy raw-media filtering stays in its explicit historical branch.
- Ruling READ-02 (corrected after genuine producer inspection): `tool/result`, `code/result`, and `code/output` apply READ-01. `subagent/end` follows READ-08 because its own aggregate preview is in different fields. Other control/status events retain their existing indexing policy. Legacy behavior remains separate. No callback-bearing original value or huge artifact is lowered again.
- Ruling READ-03: advance the existing file-backed **derived index schema/projection version1→2**. Its existing application-id validation and transactional rebuild owner are authoritative. Only the owned derived index is rebuilt; Session format, source JSONL, foreign SQLite files and future derived schema remain unchanged/refused. Do not add a second cache freshness owner.
- Ruling READ-04: CLI keeps its existing compact transcript selection and200-character one-line result summary. For new tool results it uses inline data or stored preview and includes trusted execution/retention disposition; it must not stringify the complete envelope/media or imply quota refusal is execution failure. JSON output and structural export retain full events without automatic artifact hydration.
- Ruling READ-05: Desktop keeps `output` as the historical/raw data member and adds a distinct typed envelope member through the actual row/component chain. Execution state comes from the envelope, never payload-shaped `isError` or `error`. Artifact/unavailable previews and separate native images must remain visible. No fake raw output synthesized solely to satisfy an old shape discriminator.
- Ruling READ-06: outcome and dispatch remain separate. New outcome`unknown` gets an explicit muted unknown state; `not-dispatched` is separate metadata and does not erase a failed/canceled outcome. Retention wording says output is saved with its actual completeness, never promises complete source capture for `source-limited`/`producer-incomplete`/`capture-canceled`.
- Ruling READ-07: the actual `session_search` tool description, not only developer documentation, states retained results are searched through stored inline data/previews and that missing hits do not prove absence from complete artifact bodies. Keep the `{hits}` DTO and algorithm unchanged; this is a static coverage clarification.
- Ruling READ-08: actual `TaskResultOwner.settle` deliberately clears the retained descriptor preview; `spawn.ts` publishes its already bounded `resultText` and `error` alongside that descriptor. These are current-format preview fields, not a legacy shadow. For new `subagent/end`, index both present string fields joined by a newline; if neither exists, index empty text. Keep the historical no-envelope fallback unchanged. Do not duplicate preview into the descriptor, hydrate the body or let execution status decide which field is searchable.
- Presentation follows existing IH components, tokens and i18n. Renderer changes must stay browser-safe; do not import a Node runtime owner just for a pure display helper. Explicit artifact-page endpoints/UI are a distinct following reader unit, not silently folded into this one.
- No extra scheduler/store/log/permission owner, no reachability exemptions/reseed/fake consumers. Product modules remain cohesive; tests/scripts are excluded from the decomposition task.
- Sequential offline tests, stable source before/after, preserve genuine REDs and setup failures. Broaden/repeat only for changed sources, relevant failures or concrete unresolved risk.

## Task 1 — Search projection and owned cache upgrade

**Files**

- Modify `packages/core-session/src/projection/search.ts` (new-envelope selection in original search normalizer; a private helper in the same small file is sufficient).
- Modify `packages/session-query/src/file-backed/schema.ts`; update the now-stale version comment in `database.ts` only if needed.
- Clarify the existing description in `packages/session-query/src/tools.ts` under READ-07; no new tool, response field or test-only description assertion.
- Extend `packages/core-session/test/code-search.test.ts` or add `retained-result-search.test.ts` for discriminating envelope cases.
- Add `packages/session-query/test/filebacked-retained-results.test.ts`; extend existing `filebacked.test.ts`'s fresh schema expectation while retaining literal predecessor/future/foreign controls.
- Update `packages/session-query/src/file-backed/README.md` to explain bounded result coverage and owned projection-version rebuild.

**Interfaces**

Consume existing `ResultEnvelope`, `SessionEventView`, `stringifyJsonData`, `deriveSearchText(event): string`, `createFileBackedSessionQuery(options): SessionQuery`. Do not add a public result-search type or service. Public `INDEX_DB_SCHEMA_VERSION` becomes2; the application ID and existing query DTO stay unchanged. A small private `retainedSearchText(envelope): string` implements READ-01 for the three ordinary/code branches; child completion uses READ-08's actual aggregate preview.

- [x] Read original producer→search→SQLite paths and relevant tests. Establish a real behavior RED before product edits: genuine format10 envelope-only tool/code results currently produce empty FTS text; a preexisting version1 index remains stale on unchanged JSONL.
- [x] Add tests for inline, artifact preview and unavailable; inline data with ordinary `images`/`error`/`ref` fields; typed media excluded; dependency/ref metadata excluded; existing code/output and actual subagent/end aggregate-preview cases; explicit legacy raw behavior. Child coverage must include a genuine producer with empty descriptor preview and both original bounded fields; a fabricated nonempty descriptor cannot substitute for it.
- [x] Use actual framed JSONL and the file-backed query for hit/event seq/snippet assertions. Keep literal9/8 read controls, current10 and future11 rejection. New envelopes in a predecessor format remain rejected.
- [x] Build an actual persisted owned index, close connections, seed the historical empty result projection with literal `PRAGMA user_version=1` while retaining the real source revision/fingerprint, then reopen against unchanged JSONL. Verify expected hits return after the version2 rebuild. A second unchanged query must keep the normal skip path. Preserve exact JSONL bytes before/after.
- [x] Retain foreign application-id and literal future derived-version3 refusals without resetting their tables. Verify derived rebuild is transactional through existing owner tests; do not migrate the legacy persistence database behind `createSessionQuery`.
- [x] Implement explicit envelope branches plus version2 rebuild. Do not alter indexing policy for unrelated status/control events or fetch artifact bodies.
- [x] Run focused RED/GREEN, core-session search/result owners, full session-query suite and affected types. Build a fresh isolated Gateway copy and exercise the actual copied query path with fixed source and QA-import mapping; record exact tested scope. No CLI/renderer qualification claim from this task.
- [x] Commit coherent local changes, update task ledger/report and return to root for independent review. After acceptance root continues Task2.

Concrete regression shape, using fixture-owned valid refs/events rather than fabricated execution permission:

```ts
const result = {
  version: 1,
  execution: { outcome: 'failed', dispatch: 'dispatched' },
  preview: 'RETAINED_VISIBLE_MARKER',
  media: [validPngFixture],
  retention: { kind: 'artifact', ref: validFixtureRef },
} satisfies ResultEnvelope;
// Encode this as a real format10 fact after its matching call.
expect(await query.search('RETAINED_VISIBLE_MARKER'))
  .toEqual([expect.objectContaining({ eventType: 'tool/result', seq: resultSeq })]);
expect(await query.search(validFixtureRef.id)).toEqual([]);
expect(await query.search('ONLY_IN_ARTIFACT_BODY')).toEqual([]);
expect(await readFile(sessionFile)).toEqual(originalBytes);
```

For the cache-upgrade discriminator, the real initial query fills `indexed_sessions` with the source's genuine observed revision/fingerprint. Close it; use a direct fixture DB connection to set `indexed_docs.text=''` for the retained result and `user_version=1`, then close and reopen the real query. Do not change or touch the source file to force a rebuild; that would evade the bug. This is a literal old derived schema fixture (DDL is otherwise unchanged), not an old product process claim.

## Task 2 — CLI and Desktop result presentation, history/export qualification

This connected consumer unit starts only after Task1 review. The interfaces below are fixed against current actual components; root verifies that Task1 has not changed them before dispatch.

**Files and actual seams**

- `apps/cli/src/sessions.ts`: `renderTranscript`→`transcriptLine` currently reads only `ev.output`; actual `runSessionsCommand` uses coordinator snapshot. Keep command selection/JSON export and existing display bound.
- `packages/desktop/src/renderer/session/project.ts`: `TimelineRow` and both call-present/standalone result folding branches.
- Both `Timeline.tsx` and `ActivityGroup.tsx`→`ToolActivity.tsx`→`RecordedToolOutput.tsx` actual renderer chains. `activity-groups.ts` retains row objects already and needs no grouping rewrite.
- `tool-presentation.ts` owns `toolState`; `work-stages.ts` has a separate raw failure inference requiring the same trusted-envelope branch.
- New `RecordedResultEnvelope.tsx` owns bounded envelope presentation, reusing existing data/image components; `tool-output.css` only adds the existing muted treatment for unknown if needed.
- `RecordedCodeActivity.tsx` and `RawRecordedData.tsx` provide existing IH rendering conventions; do not invent an unrelated design system.
- Actual tests: `apps/cli/test/sessions.test.ts`, Desktop `project.test.ts`, tool/timeline/recorded-code component tests, SDK `session-context.test.ts`, and Gateway `cold-session.test.ts`.

**Interfaces**

Use a type alias derived from the already imported SDK history union, not a copied result schema or a new renderer runtime dependency on core-session:

```ts
// project.ts, alongside existing WireEvent / ToolResultReference aliases
export type RecordedResultEnvelope =
  NonNullable<Extract<WireEvent, { type: 'tool/result' }>['envelope']>;
// Add to the tool TimelineRow and the actual component props:
envelope?: RecordedResultEnvelope;
```

Extend the existing browser-safe `toolState` signature with the optional last argument. Existing raw callers remain source-compatible:

```ts
toolState(name: string, output: unknown, resultReceived?: true,
  isError?: true, dispatched?: true, envelope?: RecordedResultEnvelope): ToolState;
// If envelope exists: succeeded→received, failed→failed,
// canceled→cancelled, unknown→unknown. Dispatch is separate display metadata.
```

`work-stages.hasErrors` uses `envelope.execution.outcome === 'failed'` when present; only legacy rows use raw error/status/exitCode inference. Do not infer failure from storage refusal or arbitrary inline field names.

The narrow envelope component has props `{ envelope: RecordedResultEnvelope; onPreview?(preview: {src:string; name:string}):void; renderInline?(value: unknown): ReactNode }`. It shows original inline value through the existing tool-body renderer, or stored preview plus honest retention/ref/codec/completeness metadata and separate native media. `CapturedValueBlock`, `RecordedImages` and `useToolText()(zh,en)` provide the current IH style. The existing RecordedToolOutput logic becomes a private body helper if necessary; do not recursively call the public wrapper or put hooks behind conditional branches. Native media renders once: keep complete inline value for disclosure, suppress the old helper's image rendering for new envelopes, then display only the envelope's already validated media. Legacy rows keep their old image recognizers.

The public history DTO and Session format remain unchanged. No artifact reading callback, new bridge route or execution capability is introduced by this component.

- [ ] Reproduce missing CLI result summaries and Desktop loss of inline/preview/error/media through actual public render/fold paths, covering tool/result and code/result with and without prior call rows.
- [ ] Carry closed envelope through renderer, rendering inline value or preview plus honest retention details/media. Use trusted outcome for failed/canceled/unknown/not-dispatched, without reclassifying ordinary payload keys.
- [ ] Migrate old search-code-mode representation assertions using actual retained full-value read, preserving240matches, guest-selected10references, cancellation/partial, drained native work and zero follow-on effects. Preview assertions cannot replace the original complete-value/Stop oracle.
- [ ] Add snapshot/history/export controls proving full descriptors survive and reads do not instantiate a model/child or mutate source. Existing custom-coordinator compatibility fallback is not silently redefined.
- [ ] Run affected types, real renderer/component gates, CLI command gate, fresh copied entry controls and an actual renderer build. Preserve unresolved older build failures with exact comparison; do not label them passed.
- [ ] Hand back coherent commit(s), exact evidence/source/copy mapping and limits for independent review. Root then proceeds to the separate authorized artifact-page reader and remaining A4/A5/A6 work.

Representative existing-component regression (populate the literal through the existing valid-event fixture):

```tsx
const rows = projectTimeline([call, {
  type: 'tool/result', callId: call.callId, name: call.name,
  envelope: succeededWithInlineErrorNamedData,
}]);
render(<ToolActivity {...toolRowProps(rows[0])} expanded />);
expect(screen.getByText('已收到結果')).toBeTruthy();
expect(screen.queryByText('執行失敗')).toBeNull();
expect(screen.getByText(/payload error is ordinary data/)).toBeTruthy();
// Exercise the same data through the real grouped ActivityGroup route,
// and failed/not-dispatched, unknown, quota-refused and supported media cases.
```

`toolRowProps` above denotes selecting the actual tool-row properties in the fixture, not a new product API. Test rendered status, preview/value, storage wording and media rather than asserting only that a new prop exists.

## Delivery / continuation

Each task has its own BASE/HEAD, meaningful failures, successful scopes and review verdict. Record artifacts under fresh `.tmp/context-r4a-a4b-*` directories, never overwrite A3/A4a evidence. Current unit completion does not complete whole R4A, six-route/live-provider qualification, R4B/C/R5/R6 or release readiness. User explicitly requested continuous work: root advances to the next approved unit after resolving concrete findings, without a permission prompt at every checkpoint.
