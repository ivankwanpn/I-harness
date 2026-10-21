# Focused source-aware review of the R4B design draft

2026-10-21. Reviewed `design-draft.md` against the current named owners and the two prior preflights. Read-only; only this review was written. No product, tests, runtime/provider or Git/index operations. These are decisions to freeze before an executable plan, not an implementation approval.

The selected sole-owner bootstrap, cached-unprepared refusal, exact-payload cold refusal, live-attestation-only native flow and actual-captured-credential fence are coherent. Dedicated semantic records avoid fabricating local successful execution. The remaining blockers are the precise reader/selection contracts around those records; the draft currently promises integration that existing readers cannot supply automatically.

## Required decisions

### 1. Define the boundary resolver separately from current visibility

The draft explicitly chooses **current effective content constrained by an original completed boundary**, which is defensible and prevents resurrection. Freeze that difference in the public fork contract rather than describing it only as preserving existing atSeq meaning. Existing `completedTurnPrefix` chooses the first turn/end whose seq >= atSeq, then includes post-turn records until the next turn/start (`packages/session-persistence/src/fork.ts:53`); its replacement and later-rewind handling is not equivalent to calling the current projector with `throughSeq=boundary`.

Propose distinct pure results:

```ts
resolveSeedBoundary(history, selection):
  | { kind: 'resolved'; boundary: SemanticTurnBoundary }
  | { kind: 'refused'; reason: 'uncompleted' | 'ambiguous-seq' | 'unframed' };
selectCurrentSeed(historyNow, boundary):
  | { kind: 'selected'; groups: readonly SeedGroupSelection[] }
  | { kind: 'refused'; reason: 'straddling-group' | 'consumed-unrepresented' };
```

Specify atSeq at turn/start, between turn/end and next start, beyond the archive, inside a multi-turn seed-group record, and at a currently hidden turn. Never derive the semantic payload from `history(throughSeq)` and thereby discard later consumption: `history/replacements.ts:32` ignores later replacements under throughSeq and `history/visibility.ts:6` ignores later rewind/reset/summary facts. Concrete oracle: T1 consumed by a later summary covering T1+T2; request atSeq in T1. It must refuse straddling representation rather than recover T1's raw body. Also specify a later summary entirely within the chosen extent and a later rewind hiding that summary.

### 2. Freeze the turn algebra, including summaries created *after* import

“Scalar turn counts/ranges” and hidden turns “may contribute” are not a closed contract. Choose whether N counts all original framed turns (including hidden/empty) or visible turns, how an active current turn contributes, how unframed prefix plus framed suffix behaves, and how inherited ordinal ranges compose with new local turns. Preserve actual existing raw fork behavior where claimed; otherwise name the semantic behavior explicitly.

Need a data type such as `SeedTurnDomain { framedCount, completedThrough, unframedPrefix }` plus validated per-item/group extents and a deterministic local-turn offset. Define disjoint ranges versus enclosing intervals, safe integer limits, missing/overlapping/regressing extents, and a source seq→semantic-boundary mapping. A record containing several inherited turns cannot infer “the containing turn” from its one physical seq.

Crucially, future **child-local replacement summaries** must derive their turn extent from covered seed/local items. Current `ContextReplacementRecordV1` has no turn field (`core-session/src/events/replacement.ts:6`); current replacement structure can derive coverage but history facts contain no turn algebra. Storing extents only on initial seed records loses meaning after the first child compaction and again on a grandchild fork. Define the shared history function which propagates extents through every replacement/reset/rewind; it must not traverse retained original parent bodies. Oracle: seed T1–T3, child T4, local summary of T2–T4, then grandchild N=2/N=3 and atSeq on the seed record.

### 3. The in-flight input exception cannot reuse the existing union unchanged

Current `HistoryGrouping.makeItem` attaches the same physical unit to non-summary input items inside a step (`history/group.ts:37`). Reduction closure joins unit.source in addition to all item/evidence/call refs (`context-engine/src/reduction/selection.ts:6`, `:19`). Therefore an input within the open spawn step is already joined to that exchange; “exclude the exchange interval but preserve its independent input component” needs an explicit projection/edge rule.

Freeze `partitionSeedObservationComponents(...)` before interval closure: exactly which input/admission/raw-derived-context/image refs qualify, which physical-unit edge is retained only as **omitted-work observation**, and why no tool/result/dispatch edge can enter that exception. Keep the existing interval-union algorithm, with an explicitly typed input edge set; do not quietly create a divergent second union or mark the parent open unit closed. Observation relationships back to omitted work must not re-enter local `.sources`/`.provenance.evidence`/`.unit.source` and rejoin/protect the imported input forever. Oracle: independent user+derived context inside spawn step, parallel tool with partial result+image, and a second input actually dependent on that tool result.

### 4. Specify truthful imported exchange state and the local address grammar

The existing public `ConversationItem.exchange.acceptance` only allows `explicit | legacy-inferred` (`conversation/types.ts:51`), and `exchangeCompletion` derives state from physical step plus call/result receipt membership (`unit-state.ts:29`). Root has now selected **`inherited-observation`**, which closes the classification decision: preserve original explicit/legacy acceptance only as source observation, never a child local acceptance. Still freeze metadata sufficient to validate completed source calls/results without inventing raw dispatch. Define a separate complete imported-container state versus the original parent's physical state; an input-observation related to an omitted open unit must not claim that unit is closed.

The seed codec must fix local part names for item, shared group, each call, result and media companion, as well as their matching message ordinals and result outcomes. `ConversationAddress.part` is limited to64 UTF-8 bytes (`events/replacement.ts:49`). Keep original origin refs in a separate observation DTO, not addressable `ConversationSourceRef` values used by local coverage. Define dense/closed shape checks, whole-group role/call/result/media closure, and validation of claimed completion. The structural `HistoryFact` must copy these descriptors only; `HistoryRecipe` needs an explicit seed-item locator, not retained message/native/result arrays (`history/facts.ts:6`, `history/types.ts:3`).

Shared local group address does enforce partial replacement refusal through `touches` (`history/replacements.ts:21`, `:64`). However freeze that the address participates in **both** item sources and exact coverage and that seed grouping enters this same historical validator. Whole-record reset/summary/rewind visibility must hide all its items coherently; item and group source identities cannot depend on incidental payload-object order.

### 5. Root's selected narrow pruning boundary is sound; qualify its negative behavior

Current pruning is keyed by raw `callId` (`projection/pruning.ts:31`); `reduction/prune.ts:10` requires a unique projected call ID, then a local addressable result ref. `render-items.ts:20` applies substitutes only through raw `tool/result` recipes. Adding seed messages without a rule makes them unprunable, while blindly applying callId substitutions can affect an unrelated inherited/local call with the same ID.

Root has selected the narrower correct B contract: **v1 callId-only pruning does not target or rewrite seed-group tool messages**. `pruneProposal` explicitly skips inherited-observation exchanges; seeded rendering never consults global v1 callId substitutes. Whole-group summary/replacement/reset remains supported and the actual complete request is remeasured. This satisfies the framework's F04 obligation (framework table row F04 and §6): it requires truthful changed/hard-fit/target-ready progress and bounded fallback/blocking, not per-result micropruning for every new representation. An addressed prune-v2 is a possible later optimization, not a B correctness prerequisite.

Freeze these negatives and positive closure controls:

- A seed result and local raw result share callId. A local v1 prune may affect only the raw result; seed bytes/messages/media and dependency descriptors remain exact. Conversely a seed-only matching callId must never produce a seed prune proposal. Current global uniqueness counting may conservatively skip the raw collision too; choose/document whether that is retained or scoped to eligible local calls, without weakening existing ambiguity safeguards.
- A supplied v1 prune naming only seed content is either rejected by a specified producer/validation boundary or remains an honestly ineffective legacy marker. It must never report successful reduction, acquire a fresh soft-reduction opportunity or bypass repeated-work protection. `reductionProgress` already requires changed inputFingerprint plus strictly fewer input tokens (`context-engine/reduction/proposal.ts:10`), and `run.ts:77` prevents no-progress publication; assert this using the **actual seeded payload renderer**, not event-count/semanticRevision changes.
- A failed/skipped prune falls through to an eligible whole-group replacement, remeasures the complete request and reports ready/reduced-over-target/blocked truthfully. If a group is protected/inseparable or summary allowance is exhausted, bounded blocking is correct; never count the skipped prune as progress.
- Replace all items of one seed group, then hide/rewind the emitted summary and fork again. Shared source/group coverage must keep the original seed content consumed; partial-group replacement must refuse. Whole-record reset and future replacement coverage remain supported independently of v1 pruning.

Preserve already-pruned source text and its retention/dependency observations without reconstructing removed middle bytes. Freeze whether call IDs are retained or remapped and update provider-native bindings consistently if remapped; never rewrite correct raw remapper semantics. Do not claim seed per-result micropruning in the plan/completion record.

### 6. Result dependency and protection metadata must be typed, not inferred from LLM text

Draft's “items and LLM message bundles” needs a closed `SeedResult`/`SeedCall` descriptor carrying outcome, exact ResultEnvelope retention/catalog identities, media associations and original retrieval provenance. LLM tool text + isError cannot recover R4A retained/unavailable/catalog/member semantics. Validate both rendered preview/media and the dependency manifest against the same original result cells; nested forks must preserve that descriptor after parent raw source is absent. Host pin confirmation must address catalog membership under the actual source authorization, not manufacture original result ownership.

Define how session-scope inherited input is protected, and which omitted-work observations are audit-only versus projected protection. Existing `readConversationState` derives pending inputs/delegations from raw local operational facts and protects item scope/session/unit/effects (`conversation/state.ts:21`, `:62`). Dedicated seed groups should create **no local pendingInputIds/unsettledDelegationIds**, but must expose complete local coverage and any deliberately retained session-scope protection. No imported call may become an unknown local effect merely because it is historical observation. Add literal snapshot/state/reduction controls, not only render equality.

### 7. Close the native preparation result and cross-package contracts

The live-only choice removes unnecessary persisted identity data. Still freeze actual contract placement and factories: core-session owns data-only seed/message descriptors; llm-seam owns prepared transfer-plan/result and final-confirm contract types; core-agent's existing execution owner mints live source attestation; provider-runtime supplies binding provenance; executor/subagent composition passes capabilities. Provider-runtime must not runtime-import core-agent to inspect an opaque proof. Host composition can inject a narrow proof verifier through llm-seam contracts; no public arbitrary proof registrar.

The current prepared APIs throw on final native rejection and do not expose per-unit transfer dispositions (`prepared/payload.ts:35`, `prepared/types.ts:12`). Trusted wrappers rebuild a fixed prepared object, so an extra ad hoc property is dropped (`prepared/wrappers.ts:65`). Freeze a real result union such as `prepared | portable-required(nonempty unit IDs) | blocked`, a closed transfer-plan digest tied to actual final message indexes/payload identity, and wrapper/withOutputCap propagation. Separate recoverable native downgrade from unrelated invalid schema/media/tool grouping. State that every retry removes at least one candidate and shares one deadline, including final-auth rebuild; no fallback may mutate committed seed bytes or measured request bytes. Source/target bindings may be resolved for actual execution, but source inspection and the preparation downgrade loop do not resolve auth/count/models.

Actual source/target Stop checks and actual captured credential compatibility are sufficient; do not revive the account-lock/token-lease redesign. Cold native bytes cannot reconstruct live proof, while portable/media observations remain usable.

### 8. Freeze cached reentry and unsupported generic consumers explicitly

Keep the selected bootstrap behavior, but write its concrete signatures before dispatch rather than importing the entire earlier proposal by reference. In particular, `already-ready` with a later live suffix is **receipt adoption**, never rerun initial input; existing live alias must stay exact. Source freshness checks after artifact/resolver awaits must distinguish before-header not-issued from after-header blocked, retaining original bytes/token.

List only real consumer adapters and their operation-token propagation. A framework label “team/SDK/Gateway” is not an API: freeze the actual entry signature and who owns its stable invocation token, dependency port and optional live native attestation. A generic backend or custom ModelClient without the required owned capability must return unsupported/portable/opaque-blocked, not silently obtain authority from shape-compatible objects. No new graph exemption or placeholder consumer is needed.

## Suggested disposition

Proceed to executable planning only after the remaining items above have closed DTOs and literal counterexample fixtures; item8 needs the concrete real-entry call table. Classification and the narrow no-seed-microprune boundary are now selected and need qualification, not a broader redesign. The design direction does not need another architecture survey or decomposition batch. The most consequential unresolved choices are semantic boundary/turn algebra, the explicit input-exception edge rule, and exact seed structural/result/native interface definitions.
