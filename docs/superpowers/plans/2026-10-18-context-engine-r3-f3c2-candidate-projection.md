# ContextEngine R3 F3c2 — Core-Owned Candidate Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One GPT6.1Sol/high implementer, then a fresh task reviewer; no recursive agents. Steps use checkbox (`- [ ]`) syntax.

**Status:** COMPLETE from exact BASE9c4b1274bacb803d4f0de8d1e104289935cfceee throughec3d3da47139e5c39e4122ff07881bfd36582414; fresh full-range spec/quality review approved, no Critical/Important finding. [Verification](../../research/2026-10-18-context-engine-r3-f3c2-verification.md) records the test-placement deviation, source/copy proof and retained limits. Connected replacement production remains pending.

**Goal:** Replace the current prune-price path's fabricated Session with a core-owned noncommitting projection that shares the actual historical validation and rendering pipeline.

**Architecture:** Expose a candidate-tagged projection over a readonly base archive plus a small owned proposed rewrite suffix. The existing structural index provides a noncommitting staged history view, and normal/candidate rendering use the same payload/source/prune owners. The actual current `surfaceTokensAfterPrune` consumer prices those projected messages. No selector, new engine or production replacement writer is activated.

**Tech Stack:** Existing TypeScript/pnpm/Vitest core-session, token-meter and compaction; no dependency or persisted format changes.

**Spec:** Approved `docs/superpowers/specs/2026-10-15-context-engine-{redesign,framework,r1-contracts}.md`; accepted F2/F3b reader/unit contracts; `docs/research/2026-10-16-context-engine-r3-f3-preflight.md` and `docs/research/2026-10-18-context-engine-r3-connected-transaction-rebase.md`.

## Global Constraints

- One product writer; GPT6.1Sol/high implementer/reviewer, no recursive agents. Product0.1.13-rc.1 and original27/43 unchanged.
- No installed profile/account/provider request, release, dependency, audit baseline/allowlist edit, fake consumer or unrelated decomposition. All transports in fixtures are controlled or denied.
- Core-session remains the sole structural grouping, historical replacement and payload projection owner. No filtered/copied synthetic Session, second raw event array, second grouping fold or alternate native renderer.
- A candidate projection is prospective data, not a committed ContextSnapshot, source reference, storage receipt, target-readiness certificate or send/wake authorization. No candidate enters live history, UI, fork or telemetry.
- Preserve raw archive bytes, current validation/index state, consumed-source tombstones, source/provenance/authority, native/block/image order and actual ordinary projection behavior. Existing malformed-history refusal remains strict.
- This task activates no selector, summary source change, positional replacement production, guarded publication port, F4 physical reservation or R2E policy. Existing old-reducer R-history refusal and current success semantics remain explicitly temporary.
- New cohesive functions at most120lines; normal leaves150–400 but short contracts/accessors need no filler. Avoid significant growth of existing large closures; tests/scripts exempt.
- Preserve all prior failed receipts,14 current/18 broader BASE obligations and F1/B2/R6 limits. Streaming archive/cold recovery and paging remain R6 work; this gate makes no cold-memory/performance claim.

### Task 1: Add a noncommitting core projection and connect actual prune pricing

**Files and responsibilities:**

- Create `packages/core-session/src/conversation/archive.ts`: small readonly event-accessor contract and actual-array/base-plus-suffix adapters. These are data accessors, not new storage or a Session-shaped facade.
- Create `packages/core-session/src/conversation/candidate.ts`: strict proposed rewrite input, prospective coordinates/private source metadata, noncommitting staged validation and tagged result.
- Modify `conversation/history/index.ts` and `conversation/validation.ts`: expose a noncommitting staged history view using the same `projectHistory` and existing stage facts, with epoch/consumed-stage checks. Commit behavior and atomicity remain unchanged.
- Modify `conversation/{project,render-items,sources}.ts` and `projection/pruning.ts`: normal and prospective payload/source/prune reading share the accessor-based owner. Keep existing public Session-based entry points as actual wrappers where they have consumers; no duplicate loops for candidate semantics.
- Modify `core-session/src/index.ts`: export only the candidate function and externally consumed result/draft types. Generic accessors/stage internals need no package barrel.
- Modify `packages/compaction/src/engine/prune.ts`: `surfaceTokensAfterPrune` consumes the real candidate function plus existing token-meter `estimateContent`/core `renderConversation`, removing its `{...session,events:[...session.events,marker]}` pricing path. Actual prune planning and publication are unchanged in this gate.
- Tests: new `core-session/test/conversation-candidate.test.ts`; extend existing replacement/staged-validation/projection tests for lifecycle/rollback and `compaction/test/prune.test.ts` plus projection-provenance tests for the real price consumer. Use the existing six-route corpus without weakening any body/native oracle.

**Interfaces:**

```ts
// conversation/archive.ts — internal, actual consumers only
export interface ConversationEventArchive {
  readonly length: number;
  get(index: number): import('../managed/types.ts').SessionEventView;
}
export function eventArchive(
  events: readonly import('../managed/types.ts').SessionEventView[],
): ConversationEventArchive;
export function extendedEventArchive(
  base: ConversationEventArchive,
  suffix: readonly import('../managed/types.ts').SessionEventView[],
): ConversationEventArchive;

// Existing ConversationValidationIndex.stage result adds a noncommitting view:
// { commit(): void; history(): ReturnType<typeof projectHistory> }
// Its private HistoryIndex stage exposes the same history() name; the public
// validation stage owns epoch/consumption checks before delegating to it.

// conversation/candidate.ts
type RewriteEvent = Extract<import('../events/types.ts').SessionEvent,
  { type: 'compaction/replacement' | 'compaction/prune' | 'compaction/reset' }>;
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> & { readonly seq?: never } : never;
export type ConversationRewriteDraft = WithoutSeq<RewriteEvent>;
export interface ConversationCandidate {
  readonly kind: 'candidate';
  readonly candidateId: string;
  readonly sourceEventCount: number;
  readonly projectedEventCount: number;
  readonly projection: import('./types.ts').ConversationProjection;
}
export function projectConversationCandidate(
  source: import('../managed/types.ts').SessionView,
  rewrites: readonly ConversationRewriteDraft[],
  options: {
    candidateId: string;
    ownerSessionId?: string;
    capturePayload?: import('./payload.ts').ConversationPayloadCapture;
  },
): ConversationCandidate;
```

`candidateId` is a nonempty bounded string (at most256code units), a local correlation label, never permission or a durable replacementId. The current pure price caller may use the stable label `prune-price`; future transactions supply their own identity. No random/global counter is needed during this read.

Candidate rewrites are nonempty ordinary dense data, from the closed three-event family, with no supplied seq. Use existing strict-data/capture helpers before copying to avoid invoking getters/toJSON on the proposal. Assign prospective seq by the same base event-count/position convention used by actual fact allocation, solely for shared validation/rendering. Invalid source history/proposed references must fail through the existing safe validation error where applicable; input-family/explicit-seq mistakes may use a fixed TypeError without echoing raw data.

The returned envelope/projection/items are frozen at the same structural level as normal projection. Retained payload behavior follows the existing optional capturePayload contract; do not silently change legacy nonplain value support or claim new deep ownership without capture. Future snapshot preparation supplies its existing strict capture callback. This function itself never mutates source or installs a stage.

- [x] **Step 1: Bind exact BASE and capture normal owners.**

Record supplied BASE/clean product state and read only the named ownership paths. Existing `createConversationValidationIndex(...).stage(...)` validates without mutation but exposes only commit; its `HistoryIndex.stage` already has private staged facts. Existing render-items obtains payloads, sources and prune substitutions from the Session. Add a read view of the same staged facts, not a parallel implementation of replacement/rewind/grouping.

Capture a baseline of core-session and compaction's actual prune/provenance scopes before editing. Use sequential commands from Step7; reuse accepted unrelated C1 evidence explicitly, not a whole-suite rerun merely to establish a new label.

- [x] **Step 2: Write independent literal projection/lifecycle RED controls.**

Use the accepted replacement fixtures with safe exact source coordinates, including the honest stepless positive and physical closed/open cases. A basic literal is:

```ts
const source = createSession();
append(source, { type: 'user/message', text: 'H' });
append(source, { type: 'assistant/message', text: 'E' });
append(source, { type: 'user/message', text: 'tail' });
const rewrite = {
  type: 'compaction/replacement', version: 1, replacementId: 'candidate-one', text: 'S',
  coverage: [{ item: { kind: 'exchange', at: { seq: 1, part: 'message' } },
    sources: [{ seq: 1, part: 'message' }] }],
  insertBefore: { kind: 'exchange', at: { seq: 1, part: 'message' } },
} as const;
// Independent expected values, not generated by another selector/helper.
const before = toJSONL(source);
const candidate = projectConversationCandidate(source, [rewrite], { candidateId: 'c1', ownerSessionId: 'owner' });
expect(renderConversation(candidate.projection).map(m => m.content)).toEqual(['H', 'S', 'tail']);
expect(toJSONL(source)).toBe(before);
expect(deriveMessages(source).map(m => m.content)).toEqual(['H', 'E', 'tail']);
expect(candidate).toMatchObject({ kind: 'candidate', sourceEventCount: 3, projectedEventCount: 4 });
```

Then append the same draft through the ordinary core append path in a separate fixture copy and compare its model messages with the candidate; JSONL/cold projection must agree too. This is data-projection equivalence, not a durable receipt test. New candidate/stage contract controls fail before those APIs exist; record that honestly. The current prune price already has passing numerical behavior, so its migration is tested by before/after equivalence, not an invented numeric RED or a test that merely greps implementation text. Independent literal source/message/price assertions must exercise the new contract and real consumer after implementation.

- [x] **Step 3: Provide a noncommitting stage view and shared archive access.**

Expose `history()` on HistoryIndex's stage as a read-only preview of its base plus staged structural facts by calling existing `projectHistory`; reuse its index/visibility/replacement owner. In ConversationValidationIndex's staged result, expose `history()` with a check that rejects after consumption or when its captured revision is stale, using the same lifecycle check as commit. Calling the view must not merge any new facts/counts/dependencies/consumed sources. A successful commit still installs once; invalid/stale stages leave the existing index untouched. Capture the base count at stage creation so later state installation cannot change the preview's extent.

Adapt the normal payload/source/prune helpers to `ConversationEventArchive` with length/get, using ordinary array wrappers at their actual Session-based entry points. Extended access delegates indexes below the base count to the original archive and the remaining indexes to the small owned suffix. Bounds are explicit; no spreading/filtering/copying the raw base array and no hidden synchronous filesystem read. Retain existing iteration order, cached per-result payload materialization and owner-aware source namespaces. The only model payload renderer remains renderConversationItems/renderConversation.

Do not use the legacy seed-import fact family as a shortcut to create candidate changes, and do not grant a fact producer capability. The stage is derived validation state only. Leave managed Session publication/install and source receipt ownership untouched.

- [x] **Step 4: Implement the tagged private candidate entry.**

Validate/capture the closed proposal, construct prospective suffix coordinates and run the normal structural stage against source.formatVersion. A format6 source cannot preview a replacement requiring7; do not mutate its header. A source that is readable but ineligible for a replacement still receives the same historical refusal as a real append. Prune/reset projection does not establish their authorization/eligibility; the future producer must enforce those separately.

Render using the shared staged history plus extended event accessor and the same owner/capture options. Retained real item/source IDs and provenance remain unchanged. Newly proposed records must produce candidate-scoped source IDs (a distinct string coordinate such as `candidate:<id>:<index>`, not a real seq coordinate), `addressable:false`, and no ordinary committed item ref. They may retain internal prospective indexes for rendering, but no public source seq claims issuance. A candidate summary still has summary/derived provenance and exact original coverage data.

The candidate projection's archiveEventCount remains the actual base count; prospective count is explicitly projectedEventCount on its tagged envelope. No ordinary ContextSnapshot/ContextCoordinates or FactReceipt is fabricated. Do not pass this result to live UI/history/fork/observation APIs, and do not make ordinary projectConversation accept a candidate as a Session. The future request builder can render its private projection without granting it publication authority.

An empty proposal is rejected rather than silently acting as an alternate normal projector. Invalid candidate ids, accessors/sparse proposals, supplied seq, wrong family, forward/missing/noncontiguous/incomplete/shared-unit coverage must not alter source/index or call any observer/model/tool/storage operation.

- [x] **Step 5: Replace the actual current prune-price consumer.**

Keep the existing `surfaceTokensAfterPrune(session, records)` signature and all normal price behavior, including empty records returning the ordinary active-message estimate. Its nonempty path becomes:

```ts
const candidate = projectConversationCandidate(session, [
  { type: 'compaction/prune', version: 1, pruned: records },
], { candidateId: 'prune-price' });
return estimateContent(renderConversation(candidate.projection));
```

Use existing token-meter message pricing, not a second estimator. Do not call activeTokens with a fabricated Session or reimplement the renderer inside compaction. This real current caller is the reason the new API is delivered now; no dummy SDK/CLI consumer. Actual selection/prune records/publication/cap/summary rules remain unchanged, with their known later obligations preserved.

- [x] **Step 6: Complete literal source, native and rollback tests.**

Cover replacement, prune, explicit reset and combined proposed prune+replacement through the same shared projection. Include nested existing replacement, retained suffix, native reasoning/continuation order, parallel call/result groups and tool-image companions; compare candidate message bytes/shape to an actual separately appended/cold projection. Verify original raw bodies and real source IDs are unchanged, candidate summary refs are nonaddressable/absent and no new input or permission provenance appears.

Cover staged view before commit, after another stage commits, and after its own commit; duplicate preview reads do not install/count twice. Failed proposed R leaves replacementDependencies/eventCount/tombstones unchanged and a later valid actual stage still commits. Include input-only open physical unit rejection and complete stepless acceptance using the exact accepted F3b fixtures. Future closure cannot bless an invalid earlier replacement. Preserve old-format refusal.

For the real prune-price consumer, assert an independently literal price and equality with the eventual normal projected messages, including non-ASCII/JSON-escaping/tool-image cases. Instrument normal append observers and injected capture callbacks to show no append/dispatch and no duplicate per-result payload materialization. Preserve legacy payload/capture behavior; any discovered incompatibility is a task issue, not silently relabelled unsupported.

- [x] **Step 7: Qualify and commit the source boundary.**

Run sequentially with maxWorkers2/minWorkers1: full core-session, full compaction, ContextEngine snapshot/protection/revision tests, persistence replacement-seed/seed-semantics/fork/rewind-event, SDK session-context and Gateway cold-session/cold-state-inspection. Reuse unrelated C1 protocol acceptance/14BASE receipts with explicit source delta; do not assert those failures repaired.

Run the existing six-route corpus once at final source, preserving native/body/roundtrip oracles and denied unmatched transports. Typecheck actual core-session/token-meter/compaction/context-engine/core-agent/session-persistence/subagent/sdk/desktop-gateway packages, CLI from apps/cli and root E2E. Reachability must pass without reseeding or fake exports/consumers. No external dependency changes.

Build fresh Gateway/CLI copies with existing builder/verifier commands and distinct `context-r3-f3c2-...-20261018a` outputs. In copied code exercise the real prune-price path and core candidate entry, literal replacement/prune native equivalence and invalid-open refusal, plus ordinary SDK/Gateway history/context reads proving no candidate publication and zero model/tool/transport calls. CLI initialize/read verification may reuse the prior zero-call copied-reader harness rather than invent a command. Source/copy hashes and actual executed paths must be explicit; no installed app/profile is touched.

Record BASE/final HEAD, RED/GREEN and actual commands/output, three-way normal/candidate/cold equivalence, no append/receipt/permission claims, source/copy hashes and all retained limitations in the SDD report. Hash logs after close; preserve failed receipts. Explicitly stage task product/tests only; root owns docs/progress. Root dispatches a fresh full-range reviewer after delivery.

## Root preflight ruling

Deliver the core-owned private projection as a separate gate because it has an actual existing prune-price consumer that currently fabricates a Session. This improves a live path and independently establishes normal/prospective equivalence before adding asynchronous publication. It is not dormant selector scaffolding. Cost is one additional review boundary; benefit is preventing a duplicate hypothetical-history implementation inside the larger transaction.

The connected producer still must replace prefix/global-summary/filtered-summary selection, integrate finite typed source groups, use exact final-request assessment, enforce full-view freshness at issuance and connect auto/manual/recovery/main/child paths together. Existing prune-first publication, raw-tail reset and legacy success semantics are neither fixed nor certified by this projection-only gate. Original27/43 and all later R3/F4/E/R4/R5/R6 obligations remain.
