# ContextEngine R3 F3b — Shared Source Unit State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One implementer, then one fresh GPT6.1Sol task reviewer; no recursive agents. Steps use checkbox (`- [ ]`) syntax.

**Status:** Ready for root's final rebase/documentation BASE after reviewed F3a through `c87b0e599e3ba00a7b90e92a8323840694def52a`. No product implementation in this plan is implied. Root's read-only source probes establish the two concrete closure inconsistencies described below.

**Goal:** Make replacement validation, projected unit metadata and context protection agree on complete source units before a production selector/publisher is enabled.

**Architecture:** Derive unit completion from the existing core-session structural grouping and actual outcome facts, once. Feed that data to the existing historical R validator and actual R1C protection reader; expose only an optional data-only physical-unit descriptor on projected items. Keep model messages, raw events and format7 unchanged. A later connected F3 task consumes this foundation for selection/summary/preview/publication.

**Tech Stack:** Existing TypeScript/pnpm/Vitest packages; no dependency or raw format change.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-{framework,r1-contracts}.md`, `.tmp/context-redesign-20261015/r1d-selection-contracts.md`, `docs/research/2026-10-16-context-engine-r3-f3-preflight.md` (F3-UNIT-01), F2 review Minor M1. Detailed root probes: `.tmp/context-redesign-20261015/r3-f3b-unit-boundary-preflight.md`.

## Global Constraints

- One product writer; GPT6.1Sol/high implementer/reviewer, no recursive agents. Product0.1.13-rc.1 and original27/43 unchanged.
- No installed profile/account/provider request, release, dependency, audit baseline/allowlist change, fake consumer or unrelated decomposition.
- Core-session remains the sole grouping/closure/source owner. ContextEngine and readers consume its facts; do not duplicate grouping, invent a second raw history or reconstruct a filtered Session.
- This task adds no selector, summary call, private candidate, publication port, F4 reservation, E budget policy, artifact/delivery or UI action. Existing old-reducer refusal on R histories remains until the connected producer task.
- Preserve model-visible message/native/image order and bytes, strict prefix validation, staged atomicity, consumed-source tombstones, inherited authority, source boundaries and actual receipt ownership.
- New data descriptors are not send authorization or source receipts. Unit closure belongs to protection/eligibility; adding metadata alone must not change semantic request identity or model payload.
- New cohesive functions stay at most120lines; normal leaves150–400 but short DTO/state helpers require no filler. No mega-file expansion; tests/scripts exempt.
- Preserve all failed receipts and known F1/B2/F3a/R6 limits. Exact-BASE failures are not final-qualification exemptions.

### Task 1: Unify physical/inferred unit completion and close the reader gaps

**Files and roles:**

- Create `packages/core-session/src/conversation/unit-state.ts`: pure completion rules and existing awaiting-results helper, shared by historical validation and item completion. No source traversal/rendering/provider access.
- Modify `conversation/{types,exchange,state}.ts`: optional readonly physical-unit DTO; shared exchange completion; actual protection consumption.
- Modify `conversation/history/{group,types,replacements}.ts` and `conversation/render-items.ts`: derive/cache physical unit descriptors from the existing LegacyStep/call metadata, attach only safe DTOs, validate every selected physical unit regardless of item kind.
- Modify `events/replacement.ts`: dense ordinary data-array validation, closing F2-M1 without reading getters/inherited elements.
- Tests: extend core-session `test/{replacement,conversation-projection,conversation-state}.test.ts`, ContextEngine `test/{snapshot,protection,revision}.test.ts`, and persistence `test/replacement-seed.test.ts` where the actual proof/compiler boundary is exercised. Use existing files where their named responsibility applies; do not create test-only product exports.

**Consumes:** accepted F2 historical structural descriptors, LegacyStep membership/lifecycle, callMetadata outcome and received-result facts, exact source/ref/coverage contracts and R1C protection. Accepted F3a pure calculation remains unchanged.

**Produces these narrow contracts:**

```ts
// conversation/types.ts; no separate barrel export without a real consumer.
export type ConversationUnitState = 'open' | 'closed' | 'unresolved';
export interface ConversationUnit {
  readonly source: ConversationSourceRef; // the actual step/start source
  readonly state: ConversationUnitState;
}
// Add to ConversationItem:
// readonly unit?: ConversationUnit;

// conversation/unit-state.ts; internal real consumers only.
export interface UnitLifecycle {
  readonly ended: boolean;
  readonly failed: boolean;
  readonly suppressed: boolean;
}
export function physicalUnitState(
  step: UnitLifecycle, calls: readonly ConversationCall[],
): ConversationUnitState;
export function awaitingItemResults(item: {
  readonly calls: readonly ConversationCall[];
  readonly receivedResults: ReadonlySet<string>;
}): boolean;
export function exchangeCompletion(item: {
  readonly step?: UnitLifecycle;
  readonly calls: readonly ConversationCall[];
  readonly receivedResults: ReadonlySet<string>;
}): ConversationUnitState;
```

The lifecycle/outcome rules are explicit: failed, or suppressed-and-ended, is unresolved; otherwise an unfinished step is open. A closed physical step is unresolved if any of its actual calls has a missing result or pending/unknown outcome; ordinary resolved success/error/not-dispatched outcomes are not themselves an unknown effect. Exchange completion additionally requires that its looked-up result references were actually consumed by that bundle. A stepless inferred exchange can be closed from the existing complete bundle facts; absence of step is not by itself failure. Failed/unaccepted fragments remain ineligible. Do not infer dispatch from result text or turn/end from a later event.

Physical metadata is optional: inferred stepless exchanges keep their existing exchange identity/state and have no invented step/start source. Summary/input outside a physical step has no physical-unit descriptor. Members of the same actual physical step receive equal descriptor values/source identity, not separately inferred grouping.

- [ ] **Step 1: Bind exact BASE and capture the existing owners.**

Record root-provided BASE and clean product/index status. Inspect actual `history/group.ts:makeItem`, `legacy.ts:inferLegacy/close/callMetadata`, `exchange.ts:finishItem`, `history/replacements.ts:validateHistoricalReplacement`, `state.ts:protectedItems` and `events/replacement.ts`. Current input descriptors privately retain LegacyStep membership, but public inputs have no exchange/closure state; current R validation checks closure only in its exchange branch. The current semantic digest explicitly selects fields and excludes exchange.state; preserve that distinction for unit metadata.

- [ ] **Step 2: Write the two literal closure RED cases.**

First fixture has an ordinary readable prefix with an open physical step, followed by an invalid replacement:

```ts
const prefix = [
  { type: 'turn/start', seq: 0 },
  { type: 'step/start', seq: 1 },
  { type: 'user/message', seq: 2, text: 'H' },
  { type: 'turn/end', seq: 3 },
];
const r = {
  type: 'compaction/replacement', version: 1, seq: 4,
  replacementId: 'open-step-input', text: 'S',
  coverage: [{ item: { kind: 'input', at: { seq: 2, part: 'message' } },
    sources: [{ seq: 2, part: 'message' }] }],
  insertBefore: { kind: 'input', at: { seq: 2, part: 'message' } },
};
```

Root verified current exact input sources/evidence are only2/message; adding a guessed step source merely gives coverage-mismatch and is not the intended RED. Ordinary prefix still renders H. R4 must now reject with `SESSION_CONTEXT_REPLACEMENT_FORMAT`/`incomplete-unit`, both full and staged. Appending a later step/end after R4 cannot retroactively bless it. A valid ordered variant `turn/start0,step/start1,input2,step/end3,turn/end4,R5` succeeds with the same input coverage and required lifecycle dependency proof.

Second fixture is a complete stepless inferred exchange: `user0(H),assistant1(E),user2(tail),R3`. R3 covers exchange1/message with sources1/message and inserts there. Current projection reports E closed, but the R validator rejects solely because item.step is absent. Require literal result `[H,S,tail]`, with existing provenance retained. Also cover a complete stepless call/result bundle and its incomplete/input-interrupted variants using explicit literal source coordinates from the established R1A contract; missing/unknown/not-consumed results must continue to reject. No source may be dropped to make the positive fixture pass.

Run focused `pnpm exec vitest run test/replacement.test.ts --maxWorkers=2 --minWorkers=1` in core-session, preserving actual missing-behavior failures before edits.

- [ ] **Step 3: Write scalar-array and protection RED controls.**

F2-M1: make `coverage.sources` length2 with own entry0 and a hole at1. It must reject with the existing scalar code/reason and safe seq, never a TypeError. Also cover sparse coverage, a missing own slot filled by an inherited property, and an indexed accessor whose getter must not run. Valid dense arrays retain their order and exact coverage behavior. Full/staged failures must leave history/count/dependencies/tombstones unchanged; a valid subsequent R still commits once. No raw source/body appears in the error.

For the open input-only fixture above, ContextEngine capture must still succeed as a read, expose input.unit source1/step with state open, and protect that input/unit source. Closing the step before any R makes unit state closed and permits the intended replacement after the turn is closed. The same text-only before/after closure retains semanticRevision and exact rendered messages; protectionRevision changes. An unrelated budget/usage/diagnostic append changes neither semantic/protection identity and never triggers prepare/auth/model calls.

- [ ] **Step 4: Implement the shared data-only completion owner.**

Move the existing awaitingItemResults helper into unit-state.ts and update its actual imports; no compatibility re-export without a real consumer. `finishItem` and historical replacement checks use the shared exchangeCompletion instead of separate closure expressions. Allow an honestly closed stepless inferred exchange; preserve explicit acceptance/fence/native/unknown-effect requirements.

HistoryGrouping computes a descriptor for each actual LegacyStep from its existing grouped lifecycle/callMetadata, caching it per step for that projection/prefix. Do not scan the raw archive again for each input member, render payloads to discover state, or construct another event map. Store the internal descriptor under a distinct name such as unitInfo; the existing private `unit:LegacyStep` remains membership/dependency evidence. Attach only the frozen `{source,state}` DTO as public item.unit. As with existing source recipes, remap its source through the actual renderer's source factory with the same owner/eventIndex/part; do not expose an ownerless private-history source ID. Assert two owner IDs retain their distinct source namespaces. Never spread the private members/calls/acceptance object into the public DTO or raw event.

The historical validator requires each selected physical unit to be closed and addressable, regardless of whether the selected item is input or exchange. Retain complete same-unit/shared-source coverage, pending admission/current input/session protection, exact source comparison, prefix dependency and staged rollback checks. Per-bundle incomplete/unknown checks still apply even when the physical unit is closed. Do not change LegacyStep's existing boundary inference to make a future turn/end close an earlier R.

- [ ] **Step 5: Connect real protection and dense-array validation.**

`readConversationState` protects items whose physical unit is not closed or whose unit source is unsafe, alongside its existing current-input/session-scope/exchange/effect protection. For protected members include their actual unit source ID in protection sourceIds, so the shared whole unit cannot be partially selected. Preserve pending admissions/promotions/delegations and inherited seed boundaries. This is a pure read of existing facts, not execution or delivery authority.

Leave `semanticContextRevision`'s explicit model/source mapping free of the new unit closure DTO. `captureData` retains/freeze-captures it as metadata; actual protection membership/source IDs drive protectionRevision. Assert lifecycle-only changes cannot alter rendered input or its semantic digest. No provider option or native sidecar is copied/rebucketed because of unit metadata.

At replacement shape validation, require ordinary dense data arrays before iteration/map. Validate own enumerable indexed data descriptors for every position, reject holes/inherited/accessor slots and unexpected own names/symbols; do not invoke a supplied iterator/getter to validate it. Reuse one small helper for coverage and sources. Existing plain record data-descriptor checks, seq/part limits, exact source order and duplicate checks remain. Use the existing shape/unsafe-address reason vocabulary; no new raw error/body field or format revision.

- [ ] **Step 6: Verify real reader/seed and protocol consumers.**

Add a complete physical input+exchange shared-unit test and an input associated with failed/unaccepted/unknown-effect work. It must remain protected/ineligible until the existing facts establish a complete eligible unit; do not reinterpret an unknown effect as no dispatch. Known tool error results in an otherwise successfully closed accepted unit remain usable. Exercise full/prefix/staged readers and a dependency-complete remapped seed; lifecycle closure proof omitted from a selected seed must still refuse before child creation.

Run sequentially with maxWorkers2/minWorkers1: core-session full; ContextEngine full; persistence replacement-seed/seed-semantics/fork/rewind-event; subagent fork-isolation/managed-child; SDK session-context; Gateway session-management-fence/cold-state-inspection/cold-session. Reuse unchanged evidence where the new metadata/state code is not consumed, explicitly identifying the source delta; do not repeat whole unrelated suites.

Run the existing quarantined six-route corpus once at final source: root `pnpm exec vitest run --config e2e/vitest.config.ts e2e/context-corpus.e2e.ts --maxWorkers=2 --minWorkers=1`. All protocol/body/native/roundtrip assertions remain. Test fixtures must deny unmatched physical transport. No live provider check.

Typecheck actual core-session/context-engine/core-agent/session-persistence/subagent/sdk/desktop-gateway packages sequentially (`pnpm --filter @i-harness/<name> typecheck`), CLI's existing typecheck from apps/cli, then root E2E types and `pnpm verify:reachability` without reseed. No new unused barrel/API or dependency edge is accepted as a workaround.

Build fresh distinct Gateway/CLI copies with the existing builder/verifier commands. Extend the existing zero-call copied reader smoke with the open-input-unit negative R and closed-unit/stepless positives through actual copied readers/import/fork. Verify raw source immutability, typed refusal, child-owned receipt, unchanged message order and current source/copy hashes. Do not reinstall the app, use user data or redo the unrelated F1 transport suite.

- [ ] **Step 7: Commit and report this source boundary.**

Keep extraction and behavior commits coherent where possible. Explicitly stage task code/tests only; root owns plans/progress/research. Report BASE/HEAD, literal RED/GREEN, each actual consumer, descriptor/protection versus semantic identity, sparse-array getter/rollback behavior, exact commands/output/source hashes, copied execution and remaining qualifications. No selector/publisher or whole-F3 completion claim. Root dispatches the fresh whole-task reviewer; do not spawn one.

## Root contract decisions and next boundary

This gate resolves the post-F2 input-unit closure inconsistency, restores the R1D honest stepless-complete case and closes F2-M1. It is an actual reader/protection improvement with current consumers, not dormant selector scaffolding. Stricter protection can retain an ambiguous old unit longer; that is an explicit consequence of lacking closure/outcome proof, never authority to execute it or silently summarize it anyway.

Connected F3 then uses these same unit/protection facts for finite whole-span selection and exact source rendering, the accepted F3a request/calculation functions for private final-request assessment, and F1 optional action capture for publication. Its summary text eligibility, bounded suffix remeasurement, final-request target and source/Stop issuance rules remain required by the tracked preflight. No new engine factory or publication path is activated by this task alone.
